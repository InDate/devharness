/**
 * Wait Tool - a first-class wait primitive for sequences (bug-016)
 *
 * Four mutually exclusive forms:
 *   wait({ selector })      - until an element matching the selector exists
 *   wait({ selectorGone })  - until NO element matches the selector
 *   wait({ expression })    - until a synchronous JS expression is truthy
 *   wait({ ms })            - fixed sleep (last resort)
 *
 * All condition forms poll from the MCP side: the predicate is a SYNCHRONOUS
 * expression re-evaluated over CDP on an interval. This is deliberate - it is
 * NOT an in-page waitForFunction/waitForSelector:
 *
 * - It survives a navigation mid-wait. Each poll runs in whatever execution
 *   context the page currently has; if the context is destroyed between
 *   polls (navigation), the failed poll is swallowed and the next one runs
 *   in the new document. This is exactly the "step after navigate races the
 *   new page" case that motivated the tool.
 * - It does not depend on the page's event loop making progress or on any
 *   in-page promise ever resolving, so it still behaves sanely when the page
 *   is busy - and it fails fast instead of burning the timeout when the
 *   debugger is paused (nothing can change while the event loop is stopped).
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse, createSuccessResponse } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { isExtendedSelector, parseExtendedSelector } from '../utils/selector-resolver.js';
import { abortableSleep, isAbortError, throwIfAborted } from '../utils/abort.js';

const waitSchema = z.object({
  selector: z.string().optional().describe('Wait until an element matching this CSS selector exists. Supports extended selectors: :has-text("text") partial match, :text("text") exact match. Survives navigations that happen mid-wait.'),
  selectorGone: z.string().optional().describe('Wait until NO element matches this CSS selector (spinner removed, modal closed). Same selector syntax as selector.'),
  expression: z.string().optional().describe('Wait until this SYNCHRONOUS JavaScript expression evaluates truthy, e.g. "window.__probeResult !== \'PENDING\'". Re-evaluated from the MCP side on an interval - do not use await/promises; kick async work off in a prior step, store its result in a global, and wait on the global here.'),
  ms: z.number().int().positive().max(300000).optional().describe('Fixed sleep in milliseconds. Last resort - prefer selector/expression, which return as soon as the condition holds and fail loudly on timeout instead of silently waiting too little (or too long).'),
  timeoutMs: z.number().int().positive().max(300000).optional().describe('Give up after this many ms (default: 15000). On timeout the step fails (isError) - in a sequence that stops the run, same as any other failed step.'),
  pollIntervalMs: z.number().int().min(25).max(5000).optional().describe('Interval between condition checks in ms (default: 100)'),
  connectionReason: z.string().optional().describe('Connection reference (required for selector/selectorGone/expression; not used for ms). In a sequence the run-level connection is injected automatically, like every other step.'),
}).strict();

type WaitArgs = z.infer<typeof waitSchema>;

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 100;


/**
 * Build a self-contained synchronous in-page expression that evaluates to
 * true when an element matching `selector` exists. Extended selectors
 * (:has-text etc.) are compiled to an inline text-match - no element marking,
 * so nothing is lost when the document is replaced between polls.
 */
export function buildPresencePredicate(selector: string): string | { error: string } {
  if (!isExtendedSelector(selector)) {
    return `!!document.querySelector(${JSON.stringify(selector)})`;
  }

  const parsed = parseExtendedSelector(selector);
  if ('error' in parsed) {
    return { error: parsed.error };
  }
  const { baseSelector, textMatch, scopeSelector, descendantSelector } = parsed;
  if (!textMatch) {
    return `!!document.querySelector(${JSON.stringify(baseSelector)})`;
  }

  // Matching semantics identical to resolveSelector(): textContent,
  // aria-label and title; case-insensitive partial for has-text, exact for
  // text/text-is; and the text tested against the compound it was written on,
  // descending from there when the selector continues past it.
  const descendant = descendantSelector ?? '';
  return `(() => {
    const els = document.querySelectorAll(${JSON.stringify(descendant ? (scopeSelector ?? baseSelector) : baseSelector)});
    const matchText = ${JSON.stringify(textMatch.value)};
    const partial = ${JSON.stringify(textMatch.type === 'has-text')};
    const descendant = ${JSON.stringify(descendant)};
    for (const el of els) {
      const tc = (el.textContent || '').trim();
      const al = el.getAttribute('aria-label') || '';
      const ti = el.getAttribute('title') || '';
      const hit = partial
        ? [tc, al, ti].filter(Boolean).join(' ').toLowerCase().includes(matchText.toLowerCase())
        : (tc === matchText || al === matchText || ti === matchText);
      if (!hit) continue;
      if (!descendant) return true;
      if (el.querySelector(descendant)) return true;
    }
    return false;
  })()`;
}

/** Errors that mean the selector itself is bad - retrying cannot help. */
function isSelectorSyntaxError(message: string): boolean {
  return /is not a valid selector|Failed to execute 'querySelector/i.test(message);
}

export function createWaitTools(
  resolveConnectionFromReason: (connectionReason: string) => Promise<{
    connection: { port: number };
    cdpManager: any;
    puppeteerManager: any;
  } | null>
) {
  return {
    wait: createTool(
      'Wait as a sequence step - the primitive for "the previous step kicked off async work". Exactly one of: selector (element appears), selectorGone (element disappears), expression (synchronous JS predicate polls truthy), ms (fixed sleep, last resort). Condition forms poll from the MCP side, so they survive navigations mid-wait and never depend on in-page timers or promises; on timeout the step fails cleanly instead of hanging.',
      waitSchema,
      // abortSignal: in a sequence this is the RUN's signal - a long wait is
      // the most cancellable thing a run does, so `replay cancel` must
      // interrupt it mid-poll instead of letting it run out its own
      // timeoutMs. On abort the handler THROWS an abort-shaped error (never
      // returns an isError response); the executor classifies it.
      async (args: WaitArgs, abortSignal?: AbortSignal) => {
        const { selector, selectorGone, expression, ms, connectionReason } = args;
        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

        const forms = [
          selector !== undefined ? 'selector' : null,
          selectorGone !== undefined ? 'selectorGone' : null,
          expression !== undefined ? 'expression' : null,
          ms !== undefined ? 'ms' : null,
        ].filter(Boolean) as string[];

        if (forms.length !== 1) {
          return createErrorResponse('WAIT_INVALID_ARGS', {
            message: forms.length === 0
              ? 'Provide exactly one of: selector, selectorGone, expression, ms.'
              : `Provide exactly one of: selector, selectorGone, expression, ms - got ${forms.join(' + ')}.`,
          });
        }
        const form = forms[0] as 'selector' | 'selectorGone' | 'expression' | 'ms';

        const buildMeta = (satisfied: boolean, elapsedMs: number, polls: number): ToolResponseMeta => ({
          tool: 'wait',
          action: form,
          timestamp: Date.now(),
          wait: {
            form,
            condition: selector ?? selectorGone ?? expression ?? `${ms}ms`,
            satisfied,
            elapsedMs,
            polls,
          },
        });

        // ---- wait({ ms }): plain sleep, no browser involved -----------------
        if (form === 'ms') {
          const start = Date.now();
          await abortableSleep(ms!, abortSignal);
          const response = createSuccessResponse('WAIT_SLEEP_COMPLETE', { ms: ms! });
          return { ...response, _meta: buildMeta(true, Date.now() - start, 0) };
        }

        // ---- condition forms: resolve connection, then poll -----------------
        if (!connectionReason) {
          return createErrorResponse('WAIT_INVALID_ARGS', {
            message: `wait({ ${form} }) requires a connectionReason (the reference from launchChrome/connectDebugger).`,
          });
        }

        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: `No connection found for reference "${connectionReason}". Use launchChrome first, or listConnections to see active references.`,
          });
        }
        const cdpManager = resolved.cdpManager;
        if (!cdpManager?.isConnected?.()) {
          return createErrorResponse('DEBUGGER_NOT_CONNECTED');
        }

        // Selector forms are DOM-only; expression waits are equally valid
        // against a Node target (wait for a global to flip in a Node app).
        if (form !== 'expression' && cdpManager.getRuntimeType?.() === 'node') {
          return createErrorResponse('NODEJS_NOT_SUPPORTED', { feature: `wait.${form}` });
        }

        let predicate: string;
        if (form === 'expression') {
          // Trailing newline protects against a `//` comment swallowing the parenthesis.
          predicate = `!!(${expression}\n)`;
        } else {
          const built = buildPresencePredicate((selector ?? selectorGone)!);
          if (typeof built !== 'string') {
            return createErrorResponse('WAIT_INVALID_ARGS', {
              message: `Invalid selector "${selector ?? selectorGone}": ${built.error}`,
            });
          }
          predicate = form === 'selectorGone' ? `!(${built})` : built;
        }

        const conditionLabel =
          form === 'selector' ? `element "${selector}" to appear`
          : form === 'selectorGone' ? `element "${selectorGone}" to disappear`
          : `expression to be truthy: ${expression}`;

        const start = Date.now();
        let polls = 0;
        let lastError: string | undefined;

        while (true) {
          // Cancelled (e.g. `replay cancel` aborting the run) - stop polling
          // NOW, not at this wait's own timeoutMs.
          throwIfAborted(abortSignal);

          // A paused debugger stops the event loop: the DOM cannot change and
          // no predicate can flip. Burn no time - fail fast with the reason.
          if (cdpManager.isPaused?.()) {
            return {
              ...createErrorResponse('WAIT_DEBUGGER_PAUSED', {
                condition: conditionLabel,
                connectionReason,
              }),
              _meta: buildMeta(false, Date.now() - start, polls),
            };
          }

          polls++;
          try {
            const detailed = await cdpManager.evaluateExpressionDetailed(
              predicate,
              undefined,
              false,  // expandObjects - predicate result is a boolean
              1,
              { awaitPromise: false, captureRaw: true }
            );
            if (detailed.rawCaptured ? detailed.rawValue === true : detailed.formatted === 'true') {
              const elapsedMs = Date.now() - start;
              const response = createSuccessResponse('WAIT_CONDITION_MET', {
                condition: conditionLabel,
                elapsedMs,
                polls,
              });
              return { ...response, _meta: buildMeta(true, elapsedMs, polls) };
            }
            lastError = undefined; // predicate evaluated cleanly, just false
          } catch (err: any) {
            // An abort is a cancellation, not an evaluation error - rethrow
            // it or the loop below would swallow the user's cancel and keep
            // polling until this wait's own timeoutMs.
            if (isAbortError(err)) throw err;
            // Evaluation errors are expected mid-wait (execution context
            // destroyed by a navigation; a global that does not exist yet).
            // Swallow and keep polling - but keep the last one for the
            // timeout message, and fail fast when the selector itself is
            // syntactically invalid (no amount of polling fixes that).
            lastError = err?.message || String(err);
            if (form !== 'expression' && lastError && isSelectorSyntaxError(lastError)) {
              return {
                ...createErrorResponse('WAIT_INVALID_ARGS', {
                  message: `Invalid selector "${selector ?? selectorGone}": ${lastError}`,
                }),
                _meta: buildMeta(false, Date.now() - start, polls),
              };
            }
          }

          const elapsed = Date.now() - start;
          if (elapsed + pollIntervalMs > timeoutMs) {
            return {
              ...createErrorResponse('WAIT_TIMEOUT', {
                condition: conditionLabel,
                timeoutMs,
                polls,
                lastError: lastError ? `\n**Last evaluation error:** ${lastError}` : '',
              }),
              _meta: buildMeta(false, elapsed, polls),
            };
          }
          await abortableSleep(pollIntervalMs, abortSignal);
        }
      }
    ),
  };
}
