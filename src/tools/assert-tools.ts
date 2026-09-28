/**
 * Assert Tool - inline assertions as a sequence step, and a face of the check
 * engine: a check whose failure is an error. Compares a (typically
 * {{var:...}}-templated) left value against right using operator, or reads an
 * element until it holds. On failure, returns isError:true, which the
 * executor's abort-on-failure path treats as a hard stop.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { getErrorMessage, getFormattedResponse } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { CHECK_OPERATORS, ELEMENT_CONDITIONS, assertAsCheck, runCheck } from './check-engine.js';

const assertSchema = z.object({
  left: z.any().optional().describe('Value to check (typically a {{var:name.path}} template, resolved before this tool runs). Omit when asserting on `selector`'),
  operator: z.enum(CHECK_OPERATORS).optional().describe('Comparison operator. Required for the value form, and for the selector conditions that compare something (text/attribute/count)'),
  right: z.any().optional().describe('Value to compare against. Not used for exists/notExists.'),
  message: z.string().optional().describe('Custom failure message'),

  // DOM form: assert about the page instead of a captured value.
  selector: z.string().optional().describe('CSS selector to assert about, polled until it holds or the deadline passes. Supports :has-text("x"). Use this instead of hand-rolling a wait loop in inspect({evaluateExpression})'),
  condition: z.enum(ELEMENT_CONDITIONS)
    .optional()
    .describe('What to require of `selector`: present (in the DOM) | visible (rendered, non-zero box) | hittable (elementFromPoint at its centre lands inside it - nothing covering it, which is what "a user can click this" actually means) | absent | text (its textContent, with operator/right) | attribute (`attribute` name, with operator/right) | count (how many match, with operator/right) | enabled (not disabled)'),
  attribute: z.string().optional().describe("condition 'attribute': which attribute to read"),
  timeoutMs: z.number().optional().describe('How long to keep polling the selector before failing (default 5000). Kept below the evaluation timeout so a failure reports what it actually found rather than dying as "did not respond"'),
  connectionReason: z.string().optional().describe('Which browser to look at. Injected from the run for sequence steps; ignored by the value form'),
}).strict();

type AssertArgs = z.infer<typeof assertSchema>;

export function createAssertTools(
  resolveConnectionFromReason?: (connectionReason: string) => Promise<any>
) {
  return {
    assert: createTool(
      'Assert a condition as a sequence step. Fails the sequence (isError, executor stops) if the condition is false. Two forms: a VALUE check against {{var:name.path}} templates captured by a prior request({saveAs}) or inspect({saveAs}) step; or a DOM check via `selector` + `condition`, which polls the page until it holds and reports what it actually found - use that instead of hand-writing a wait loop inside inspect({evaluateExpression}), which invites acting on the page from the same step.',
      assertSchema,
      async (args: AssertArgs, abortSignal?: AbortSignal) => {
        const dom = !!(args.selector && args.condition);
        if (!dom && !args.operator) {
          return {
            content: [{ type: 'text', text: '## Error\n\nMissing `operator`\n\n**Suggestion:** the value form needs `left` + `operator`; the DOM form needs `selector` + `condition`.' }],
            isError: true,
          };
        }
        if (dom && !args.connectionReason) {
          return {
            content: [{ type: 'text', text: `## Error\n\nNo browser connection for a DOM assertion\n\n**Suggestion:** \`selector\` asserts about a page, so this needs a connection. In a sequence the run's connection is injected automatically; called directly, pass \`connectionReason\`.` }],
            isError: true,
          };
        }
        const reading = await runCheck(assertAsCheck(args), {
          connectionReason: args.connectionReason, resolveConnection: resolveConnectionFromReason, abortSignal,
        });
        const passed = reading.outcome === 'held';

        if (!dom) {
          const { left, operator, right, message } = args;
          const assertMeta: ToolResponseMeta = {
            tool: 'assert', action: operator, timestamp: Date.now(),
            assert: { left, operator: operator!, right, passed },
          };
          if (!passed) {
            return {
              content: [{
                type: 'text',
                text: getErrorMessage('ASSERT_FAILED', {
                  message: message || reading.detail || `expected ${JSON.stringify(left)} ${operator} ${JSON.stringify(right)}`,
                  left: JSON.stringify(left), operator: operator!, right: JSON.stringify(right),
                }),
              }],
              isError: true,
              _meta: assertMeta,
            };
          }
          return {
            content: [{
              type: 'text',
              text: getFormattedResponse('ASSERT_SUCCESS', { left: JSON.stringify(left), operator: operator!, right: JSON.stringify(right) }),
            }],
            _meta: assertMeta,
          };
        }

        const { selector, condition, operator, right, message } = args;
        const comparing = condition === 'text' || condition === 'attribute' || condition === 'count';
        const said = `\`${selector}\` ${condition}${comparing ? ` ${operator} ${JSON.stringify(right)}` : ''}`;
        const assertMeta: ToolResponseMeta = {
          tool: 'assert', action: `${condition}`, timestamp: Date.now(),
          assert: { left: selector, operator: condition!, right, passed },
        };
        if (reading.outcome === 'error') {
          return {
            content: [{ type: 'text', text: `## Error\n\n${reading.errorKind === 'no-connection'
              ? 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              : reading.detail ?? 'the assertion could not be read'}` }],
            isError: true,
          };
        }
        if (passed) {
          return { content: [{ type: 'text', text: `Assertion passed: ${said}` }], _meta: assertMeta };
        }
        const why = reading.lastError ? `The last read failed: ${reading.lastError}. ` : reading.detail ? `${reading.detail}. ` : '';
        return {
          content: [{
            type: 'text',
            text: `## Assertion failed\n\n${message || `${said.replace(` ${condition}`, ` was not ${condition}`)} within ${args.timeoutMs ?? 5000}ms`}\n\n${why}**Found:** ${reading.found ?? 'matched 0'}`,
          }],
          isError: true,
          _meta: assertMeta,
        };
      }
    ),
  };
}
