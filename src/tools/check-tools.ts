/**
 * Check Tool - read an element, a value, the URL, storage, or time, and answer
 * held or failed.
 *
 * Called directly it answers and does not fail: a failed check is a reading,
 * not an error. In a sequence the step says what each answer does - `holds`
 * and `fails` - which the replay executor carries out: carry on, stop the run,
 * or run another sequence and resume.
 */

import { guardElement } from './check-element.js';
import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { responseWithOnce } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import type { ExecuteToolCall } from '../types.js';
import { CHECK_OPERATORS, ELEMENT_CONDITIONS, SOCKET_CONDITIONS, assertAsCheck, formOf, runCheck, waitAsCheck, type CheckSpec } from './check-engine.js';

/** What a sequence step does on one answer. */
export const checkOutcomeSchema = z.union([
  z.enum(['continue', 'stop']),
  z.object({
    run: z.string().describe('Name of the sequence to run'),
    resumeAt: z.number().int().optional().describe('0-based step of this sequence to resume at once it has run, forward only'),
  }).strict(),
]);
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;

export const checkSchema = z.object({
  expect: z.record(z.any()).optional().describe('selector: the element meant, as a fingerprint; another element is refused with a repair'),
  selector: z.string().optional().describe('An element to check, with `condition`. Supports :has-text("x")'),
  condition: z.enum([...ELEMENT_CONDITIONS, ...SOCKET_CONDITIONS]).optional().describe('selector: present | visible | hittable (nothing covers its centre) | absent | text | attribute | count | enabled. cookie/localStorage/indexedDB: present (default) or absent. socket: open (default) or closed'),
  attribute: z.string().optional().describe("condition 'attribute': which attribute to read"),
  value: z.any().optional().describe('A value to check, typically a {{var:name.path}} template, with `operator` and `right`'),
  operator: z.enum(CHECK_OPERATORS).optional().describe('How the value, or the element\'s text/attribute/count, is compared with `right`. For `url`: equals (default), contains or matches'),
  right: z.any().optional().describe('What it is compared with. Not used for exists/notExists'),
  expression: z.string().optional().describe('A synchronous JavaScript predicate, read in the page or a Node target'),
  url: z.string().optional().describe("The page's URL, compared by `operator`"),
  cookie: z.string().optional().describe('A cookie name'),
  localStorage: z.string().optional().describe('A localStorage key'),
  indexedDB: z.string().optional().describe('DB/STORE/KEY for one record, or DB/STORE for any record in the store'),
  traffic: z.object({
    urlIncludes: z.string().optional().describe("Substring of the request's URL, or of the socket's URL for a frame"),
    method: z.string().optional().describe('A request: only this method'),
    direction: z.enum(['sent', 'received']).optional().describe('A frame: only this way'),
    textIncludes: z.string().optional().describe('A frame: what its payload carries. A lone "key":value pair compares that top-level JSON field; anything else is a substring'),
  }).strict().optional().describe('Traffic crossing the proxy: a request by urlIncludes + method, a frame by urlIncludes + direction + textIncludes. Needs a browser launched with proxy: true'),
  stepsBack: z.number().int().min(0).optional().describe('traffic: count from the start of the call this many back (default 1, the call before the check; 0, the check itself)'),
  count: z.number().int().min(0).optional().describe('traffic: how many crossings, compared by operator (default gte)'),
  socket: z.string().optional().describe("A socket whose URL carries this, with condition open (default) or closed. Needs proxy: true"),
  connectionOpen: z.string().optional().describe('A connection of this session by name, with condition present (default: open) or absent'),
  afterMs: z.number().int().min(0).max(600000).optional().describe('Read nothing until this much time has passed; alone, a timer'),
  withinMs: z.number().int().min(0).max(600000).optional().describe('Read again until it holds, for at most this long after afterMs. 0 or omitted reads once'),
  pollMs: z.number().int().min(25).max(5000).optional().describe('Time between reads (default 100)'),
  message: z.string().optional().describe('What a failure means, reported in its place'),
  holds: checkOutcomeSchema.optional().describe('Sequence step, on hold: continue (default), stop, or { run, resumeAt }'),
  fails: checkOutcomeSchema.optional().describe('Sequence step, on failure: stop (default), continue, or { run, resumeAt }'),
  connection: z.string().optional().describe('Which browser it reads'),
}).strict();

export type CheckArgs = z.infer<typeof checkSchema>;

/** The engine's spec out of a check's arguments. */
export function checkSpecOf(args: CheckArgs): CheckSpec {
  const { holds: _holds, fails: _fails, message: _message, connection: _connection, value, ...rest } = args;
  return { ...rest, ...('value' in args ? { value, hasValue: true } : {}) };
}

/** A check's step parameters out of the engine's spec: `hasValue` is the engine's, not the file's. */
function paramsOf(spec: CheckSpec): Record<string, unknown> {
  const { hasValue, value, ...rest } = spec;
  return { ...rest, ...(hasValue ? { value } : {}) };
}

/**
 * A call to one of the check's faces as the `check` step it is written as.
 * `assert` stops the run on failure and `wait` does on timeout, which is what
 * a check does by default, so neither needs a `fails`. Anything else returns
 * unchanged.
 */
export function asCheckStep<C extends { tool: string; params: Record<string, any> }>(command: C): C {
  const { message, connection, saveAs: _unused, ...args } = command.params ?? {};
  const kept = { ...(message ? { message } : {}), ...(connection ? { connection } : {}) };
  if (command.tool === 'wait') return { ...command, tool: 'check', params: { ...paramsOf(waitAsCheck(args)), ...kept } };
  if (command.tool === 'assert') return { ...command, tool: 'check', params: { ...paramsOf(assertAsCheck(args as any)), ...kept } };
  return command;
}

/** Subjects a check names; more than one is a check that means two things. */
function subjectsOf(args: CheckArgs): string[] {
  return (['selector', 'value', 'expression', 'url', 'cookie', 'localStorage', 'indexedDB', 'traffic', 'socket', 'connectionOpen'] as const)
    .filter(key => key in args && (key === 'value' || args[key] !== undefined));
}

export function createCheckTools(
  resolveConnectionByName: (connection: string) => Promise<any>,
  executeToolCall: ExecuteToolCall,
) {
  return {
    check: createTool(
      'Check one thing, answering held or failed: an element (selector + condition), a value ({{var:...}} + operator + right), a JS expression, the URL, a cookie, a localStorage key, an IndexedDB record, proxy traffic (traffic + count), a socket, a connection being open (connectionOpen), or time alone (afterMs). withinMs reads again until it holds. As a sequence step, holds/fails pick continue, stop or running another sequence.',
      checkSchema,
      async (args: CheckArgs, abortSignal?: AbortSignal) => {
        const subjects = subjectsOf(args);
        if (subjects.length > 1) {
          return {
            content: [{ type: 'text', text: `## Error\n\nA check reads one thing, and this names ${subjects.join(' + ')}. Split it into one check each.` }],
            isError: true,
          };
        }
        const spec = checkSpecOf(args);
        const reading = await runCheck(spec, {
          connection: args.connection,
          resolveConnection: resolveConnectionByName,
          executeToolCall,
          abortSignal,
        });
        const meta: ToolResponseMeta = {
          tool: 'check', action: formOf(spec), timestamp: Date.now(),
          check: {
            outcome: reading.outcome, form: reading.form, subject: reading.subject,
            ...(reading.found !== undefined ? { found: reading.found } : {}),
            ...(reading.detail ? { detail: reading.detail } : {}),
            ...(reading.lastError ? { lastError: reading.lastError } : {}),
            elapsedMs: reading.elapsedMs, polls: reading.polls,
          },
        };
        // A held element read is compared with the element it was recorded on.
        if (reading.outcome === 'held' && reading.form === 'element') {
          const guarded = await guardElement(args, resolveConnectionByName);
          if (guarded.refused) return guarded.refused;
          if (guarded.fingerprint) meta.element = { fingerprint: guarded.fingerprint };
        }
        if (reading.outcome === 'error') {
          return {
            content: [{ type: 'text', text: `## Error\n\nThe check \`${reading.subject}\` could not be read: ${reading.detail ?? 'unknown'}` }],
            isError: true,
            _meta: meta,
          };
        }
        const took = reading.polls > 1 ? ` after ${reading.polls} reads over ${reading.elapsedMs}ms` : '';
        const text = reading.outcome === 'held'
          ? `**Check held:** \`${reading.subject}\`${took}${reading.found ? ` - found ${reading.found}` : ''}`
          : `**Check failed:** \`${reading.subject}\`${took}\n\n${args.message ? `${args.message}\n\n` : ''}`
            + `${reading.lastError ? `The last read failed: ${reading.lastError}. ` : reading.detail ? `${reading.detail}. ` : ''}`
            + `**Found:** ${reading.found ?? 'nothing'}`;
        return responseWithOnce({ content: [{ type: 'text', text }], _meta: meta }, 'CHECK_REPLY');
      }
    ),
  };
}
