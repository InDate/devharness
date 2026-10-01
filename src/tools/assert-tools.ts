/**
 * Assert Tool - inline assertions as a sequence step, and a face of the check
 * engine: a check whose failure is an error. Compares a (typically
 * {{var:...}}-templated) left value against right using operator, or reads an
 * element until it holds. On failure, returns isError:true, which the
 * executor's abort-on-failure path treats as a hard stop.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { getErrorMessage, getFormattedResponse, responseWithOnce } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { CHECK_OPERATORS, ELEMENT_CONDITIONS, assertAsCheck, runCheck } from './check-engine.js';

const assertSchema = z.object({
  left: z.any().optional().describe('Value form: the value to check, typically a {{var:name.path}} template'),
  operator: z.enum(CHECK_OPERATORS).optional().describe('Comparison; value form, and the text/attribute/count conditions'),
  right: z.any().optional().describe('What it is compared with; unused by exists/notExists'),
  message: z.string().optional().describe('Custom failure message'),

  // DOM form: assert about the page instead of a captured value.
  selector: z.string().optional().describe('DOM form: CSS selector, polled until the condition holds. Supports :has-text("x")'),
  condition: z.enum(ELEMENT_CONDITIONS)
    .optional()
    .describe('present | visible (non-zero box) | hittable (nothing covers its centre) | absent | text | attribute | count (these three with operator/right) | enabled'),
  attribute: z.string().optional().describe("condition 'attribute': which attribute to read"),
  timeoutMs: z.number().optional().describe('DOM form: polling limit ms (default 5000)'),
  connection: z.string().optional().describe('DOM form: which browser; a run supplies its own'),
}).strict();

type AssertArgs = z.infer<typeof assertSchema>;

export function createAssertTools(
  resolveConnectionByName?: (connection: string) => Promise<any>
) {
  return {
    assert: createTool(
      'Assert a condition as a sequence step; a false one fails the step and stops the run. Value form: left + operator + right, typically {{var:...}} values a prior step captured. DOM form: selector + condition, polled until it holds.',
      assertSchema,
      async (args: AssertArgs, abortSignal?: AbortSignal) => {
        const dom = !!(args.selector && args.condition);
        if (!dom && !args.operator) {
          return {
            content: [{ type: 'text', text: '## Error\n\nMissing `operator`\n\n**Suggestion:** the value form needs `left` + `operator`; the DOM form needs `selector` + `condition`.' }],
            isError: true,
          };
        }
        if (dom && !args.connection) {
          return {
            content: [{ type: 'text', text: `## Error\n\nNo browser connection for a DOM assertion\n\n**Suggestion:** \`selector\` asserts about a page, so this needs a connection. In a sequence the run's connection is injected automatically; called directly, pass \`connection\`.` }],
            isError: true,
          };
        }
        const reading = await runCheck(assertAsCheck(args), {
          connection: args.connection, resolveConnection: resolveConnectionByName, abortSignal,
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
          return responseWithOnce({
            content: [{
              type: 'text',
              text: getFormattedResponse('ASSERT_SUCCESS', { left: JSON.stringify(left), operator: operator!, right: JSON.stringify(right) }),
            }],
            _meta: assertMeta,
          }, 'ASSERT_REPLY');
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
              ? 'No Chrome browser available. Start one with `connection` action `launch`.'
              : reading.detail ?? 'the assertion could not be read'}` }],
            isError: true,
          };
        }
        if (passed) {
          return responseWithOnce({ content: [{ type: 'text', text: `Assertion passed: ${said}` }], _meta: assertMeta }, 'ASSERT_REPLY');
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
