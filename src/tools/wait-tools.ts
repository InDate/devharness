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
  selector: z.string().optional().describe('Until an element matches this CSS selector; :has-text("x") partial, :text("x") exact'),
  selectorGone: z.string().optional().describe('Until NO element matches this selector (spinner removed, modal closed)'),
  expression: z.string().optional().describe('Until this SYNCHRONOUS JavaScript expression is truthy; no await'),
  ms: z.number().int().positive().max(300000).optional().describe('Fixed sleep ms, a last resort'),
  timeoutMs: z.number().int().positive().max(300000).optional().describe('Give up after this many ms (default 15000); the step then fails'),
  pollIntervalMs: z.number().int().min(25).max(5000).optional().describe('Interval between condition checks in ms (default: 100)'),
  connectionReason: z.string().optional().describe('selector/selectorGone/expression: the connection; a run supplies its own'),
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
      'Wait as a sequence step for async work a previous step started. Exactly one of: selector (appears), selectorGone (disappears), expression (synchronous JS turns truthy), ms (fixed sleep). Polls from outside the page, so it survives navigation.',
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
              message: `No connection is named "${connectionReason}". Start one with connection({ action: 'launch' }), or see the names in use with connection({ action: 'list' }).`,
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
