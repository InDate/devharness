// @vitest-environment node
/**
 * A reply that suggests the next call names the connection the reply came
 * from. A suggestion without it reaches the active connection, which with two
 * browsers open is not necessarily the one that answered.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkBreakpointPause } from './tool-response.js';
import { getErrorMessage } from './messages.js';
import { EvaluateExpressionPendingPromiseError } from './cdp-manager.js';
import { ConnectionManager } from './connection-manager.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';
import { createExecutionTools } from './tools/execution-tools.js';
import { createInspectionTools } from './tools/inspection-tools.js';

const text = (response: any) => response.content.map((c: any) => c.text).join('\n');

/** Every `tool({ action: '...' ... })` call the text suggests for these actions. */
const calls = (body: string, actions: string[]) =>
  [...body.matchAll(/`?(\w+)\(\{ action: '(\w+)'[^`]*?\}\)/g)]
    .filter(m => actions.includes(m[2]))
    .map(m => m[0]);

function pausedCdp(url = 'app.js', lineNumber = 41) {
  return {
    getRuntimeType: () => 'node',
    isConnected: () => true,
    disconnect: async () => {},
    isPaused: () => true,
    getPausedInfo: () => ({
      paused: true,
      location: { url, lineNumber },
      callStack: [{ callFrameId: 'frame-1', functionName: 'f', location: { scriptId: '1', lineNumber, columnNumber: 0 } }],
    }),
    getScriptUrl: () => url,
    getCallStack: () => [],
    watchPause: () => () => {},
    waitForPause: vi.fn(async () => undefined),
    setBreakpoint: vi.fn(async () => ({ breakpointId: 'bp-1', location: { lineNumber, columnNumber: 0 } })),
    removeBreakpoint: vi.fn(async () => undefined),
    isScriptLoaded: () => true,
    evaluateExpression: vi.fn(async () => undefined),
    clearLogpointLimitExceeded: vi.fn(),
    evaluateExpressionDetailed: vi.fn(async () => { throw new EvaluateExpressionPendingPromiseError('p'); }),
  } as any;
}

describe('hints name the connection the reply came from', () => {
  it('the pause guard names the paused connection in every suggested call', () => {
    const connectionManager = new ConnectionManager();
    connectionManager.createConnection(pausedCdp(), undefined, undefined, undefined, 'localhost', 9229, 'device-b');

    const result: any = checkBreakpointPause(connectionManager.getAllConnections(), 'navigate');

    expect(result.blocked).toBe(true);
    const suggested = calls(text(result.response), ['resume', 'acknowledge', 'getCallStack', 'getVariables']);
    expect(suggested.length).toBe(4);
    for (const call of suggested) expect(call).toContain("connectionReason: 'device-b'");
    expect(result.block.resolve).toContain("connectionReason: 'device-b'");
  });

  it('breakpoint await names the connection in its next steps', async () => {
    const named = pausedCdp();
    const { breakpoint } = createBreakpointTools(
      pausedCdp('other.js'), { mapToGenerated: async () => null } as any, undefined,
      async (reason) => (reason === 'device-b' ? { cdpManager: named } as any : null)
    );

    const result: any = await breakpoint.handler({ action: 'await', connectionReason: 'device-b', timeout: 1000 } as any);

    const suggested = calls(text(result), ['getVariables', 'evaluateExpression', 'stepOver', 'resume']);
    expect(suggested.length).toBe(4);
    for (const call of suggested) expect(call).toContain("connectionReason: 'device-b'");
  });

  it('resetCounter names the connection in its next step', async () => {
    const named = pausedCdp();
    const tracker = new LogpointExecutionTracker();
    tracker.registerLogpoint(named, 'bp-1', 'app.js', 42, 'hit', 5);
    const { breakpoint } = createBreakpointTools(
      pausedCdp('other.js'), { mapToGenerated: async () => null } as any, tracker,
      async (reason) => (reason === 'device-b' ? { cdpManager: named } as any : null)
    );

    const result: any = await breakpoint.handler({ action: 'resetCounter', connectionReason: 'device-b', breakpointId: 'bp-1' } as any);

    const suggested = calls(text(result), ['resume']);
    expect(suggested.length).toBe(1);
    expect(suggested[0]).toContain("connectionReason: 'device-b'");
  });

  it('acknowledge names each paused connection in its resume', async () => {
    const connectionManager = new ConnectionManager();
    connectionManager.createConnection(pausedCdp('a.js'), undefined, undefined, undefined, 'localhost', 9229, 'device-a');
    connectionManager.createConnection(pausedCdp('b.js'), undefined, undefined, undefined, 'localhost', 9230, 'device-b');
    const { execution } = createExecutionTools(pausedCdp(), async () => null, connectionManager);

    const result: any = await execution.handler({ action: 'acknowledge' } as any);

    const suggested = calls(text(result), ['resume']);
    expect(suggested.map(call => call.match(/connectionReason: '([\w-]+)'/)?.[1]).sort()).toEqual(['device-a', 'device-b']);
  });

  it('a pending promise while paused names the connection in its resume', async () => {
    const named = pausedCdp();
    const { inspect } = createInspectionTools(
      pausedCdp('other.js'), {} as any,
      async (reason) => (reason === 'device-b' ? { cdpManager: named } as any : null)
    );

    const result: any = await inspect.handler({ action: 'evaluateExpression', expression: 'p', connectionReason: 'device-b' } as any);

    const suggested = calls(text(result), ['resume']);
    expect(suggested.length).toBe(1);
    expect(suggested[0]).toContain("connectionReason: 'device-b'");
  });

  it('a wait on a paused page names the connection in its suggestions', () => {
    const body = getErrorMessage('WAIT_DEBUGGER_PAUSED', { condition: '#x', connectionReason: 'device-b' });

    const suggested = calls(body, ['resume', 'getCallStack']);
    expect(suggested.length).toBe(2);
    for (const call of suggested) expect(call).toContain("connectionReason: 'device-b'");
  });
});
