// @vitest-environment node
/**
 * A logpoint pauses the page on its own line at the hit that reaches its limit,
 * and logs without pausing on every hit before it. Its line carries the
 * message and a JSON string of each expression's value.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CDPManager } from '../cdp-manager.js';
import { createBreakpointTools } from './breakpoint-tools.js';
import { logpointLine } from '../write-watch.js';

async function logpointCondition(logMessage: string, maxExecutions: number): Promise<string> {
  const manager = new CDPManager();
  const setBreakpointByUrl = vi.fn(async () => ({
    breakpointId: 'bp-limit',
    locations: [{ scriptId: '1', lineNumber: 41, columnNumber: 0 }],
  }));
  (manager as any).client = {
    Debugger: { setBreakpointByUrl },
    Runtime: { evaluate: vi.fn(async () => ({ result: { type: 'undefined' } })) },
  };
  (manager as any).state.connected = true;
  const { breakpoint } = createBreakpointTools(
    { mapToGenerated: async () => null } as any,
    undefined,
    async () => ({ cdpManager: manager }) as any,
  );
  await breakpoint.handler({
    action: 'setLogpoint', connection: 'page', url: 'http://localhost:3101/client.js', lineNumber: 42, logMessage, maxExecutions,
  } as any);
  return (setBreakpointByUrl.mock.calls[0] as any)[0].condition;
}

/** The condition as the page evaluates it on a hit, with `count` in scope. */
function hit(condition: string, count: number): unknown {
  return new Function('count', `return (\n${condition}\n);`)(count);
}

afterEach(() => {
  delete (globalThis as any).__llmCdpLogpointCounters;
  vi.restoreAllMocks();
});

describe('a logpoint reaching its limit', () => {
  it('logs without pausing below the limit and pauses on the hit that reaches it', async () => {
    const condition = await logpointCondition('press {count}', 2);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(hit(condition, 1)).toBeFalsy();
    expect(hit(condition, 2)).toBe(true);
    expect(hit(condition, 3)).toBeFalsy();

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]).toEqual(['[Logpoint] http://localhost:3101/client.js:42:auto:', 'press 1', '{"count":1}']);
  });

  it('reads its console call as a row keyed by path and line, valued by its expressions', async () => {
    const condition = await logpointCondition('press {count}', 5);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    hit(condition, 7);

    const line = logpointLine(log.mock.calls[0].map(value => ({ value })));

    expect(line).toEqual({ key: '/client.js:42', value: '{"count":7}' });
  });
});

describe('a console call read as a logpoint row', () => {
  it('drops the query a dev server adds on rebuild from the key', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:5173/src/NoteText.tsx?t=1791166684888:89:auto:' }, { value: 'press' }, { value: '{"path":null}' }]))
      .toEqual({ key: '/src/NoteText.tsx:89', value: '{"path":null}' });
  });

  it('takes the message as the value where the line carries no values', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:3101/client.js:180:auto:' }, { value: 'calc pressed' }]))
      .toEqual({ key: '/client.js:180', value: 'calc pressed' });
  });

  it('reads any other console call as no row', () => {
    expect(logpointLine([{ value: 'Fetching pricing configuration from server...' }])).toBeUndefined();
    expect(logpointLine([{ value: { type: 'object' } }])).toBeUndefined();
  });
});
