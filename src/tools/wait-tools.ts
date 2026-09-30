/**
 * Wait Tool - a first-class wait primitive for sequences (bug-016), and a
 * face of the check engine: each form is a check with a time limit.
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
import { WAIT_TIMEOUT_MS, presenceExpression, runCheck, waitAsCheck } from './check-engine.js';

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


/** The in-page predicate a selector wait reads, for its tests. */
export function buildPresencePredicate(selector: string): string | { error: string } {
  return presenceExpression(selector);
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
      // abortSignal: in a sequence this is the RUN's signal. On abort the
      // engine THROWS an abort-shaped error (never returns an isError
      // response); the executor classifies it.
      async (args: WaitArgs, abortSignal?: AbortSignal) => {
        const { selector, selectorGone, expression, ms, connectionReason } = args;
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
        if (form !== 'ms' && !connectionReason) {
          return createErrorResponse('WAIT_INVALID_ARGS', {
            message: `wait({ ${form} }) requires a connectionReason (the name connection launch or attach gave it).`,
          });
        }

        const reading = await runCheck(waitAsCheck(args), {
          connectionReason, resolveConnection: resolveConnectionFromReason, abortSignal,
        });
        const meta: ToolResponseMeta = {
          tool: 'wait', action: form, timestamp: Date.now(),
          wait: {
            form,
            condition: selector ?? selectorGone ?? expression ?? `${ms}ms`,
            satisfied: reading.outcome === 'held',
            elapsedMs: reading.elapsedMs,
            polls: reading.polls,
          },
        };
        const conditionLabel =
          form === 'selector' ? `element "${selector}" to appear`
          : form === 'selectorGone' ? `element "${selectorGone}" to disappear`
          : `expression to be truthy: ${expression}`;

        if (reading.outcome === 'held') {
          const response = form === 'ms'
            ? createSuccessResponse('WAIT_SLEEP_COMPLETE', { ms: ms! })
            : createSuccessResponse('WAIT_CONDITION_MET', { condition: conditionLabel, elapsedMs: reading.elapsedMs, polls: reading.polls });
          return { ...response, _meta: meta };
        }
        if (reading.outcome === 'failed') {
          return {
            ...createErrorResponse('WAIT_TIMEOUT', {
              condition: conditionLabel,
              timeoutMs: args.timeoutMs ?? WAIT_TIMEOUT_MS,
              polls: reading.polls,
              lastError: reading.lastError ? `\n**Last evaluation error:** ${reading.lastError}` : '',
            }),
            _meta: meta,
          };
        }
        switch (reading.errorKind) {
          case 'paused':
            return { ...createErrorResponse('WAIT_DEBUGGER_PAUSED', { condition: conditionLabel, connectionReason }), _meta: meta };
          case 'no-connection':
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: `No connection found for reference "${connectionReason}". Start one with connection({ action: 'launch' }), or see the names in use with connection({ action: 'list' }).`,
            });
          case 'not-connected':
            return createErrorResponse('DEBUGGER_NOT_CONNECTED');
          case 'node':
            return createErrorResponse('NODEJS_NOT_SUPPORTED', { feature: `wait.${form}` });
          default:
            return { ...createErrorResponse('WAIT_INVALID_ARGS', { message: reading.detail ?? 'the wait could not be read' }), _meta: meta };
        }
      }
    ),
  };
}
