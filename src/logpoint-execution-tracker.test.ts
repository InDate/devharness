// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { CDPManager } from './cdp-manager.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';

function connectedManager(): CDPManager {
  const manager = new CDPManager();
  (manager as any).client = {
    Debugger: {
      setBreakpointByUrl: vi.fn(async () => ({
        breakpointId: '2:41:0:app.js',
        locations: [{ scriptId: '1', lineNumber: 41, columnNumber: 0 }],
      })),
    },
    Runtime: { evaluate: vi.fn(async () => ({ result: { type: 'undefined' } })) },
  };
  (manager as any).state.connected = true;
  vi.spyOn(manager, 'handleLogpointLimitExceeded').mockResolvedValue();
  return manager;
}

const hit = (n: number) => ({
  id: String(n), type: 'log', args: [], timestamp: n,
  text: `[Logpoint] app.js:42:auto: hit ${n}`,
});

async function logpointOnSecond(maxExecutions: number) {
  const active = connectedManager();
  const named = connectedManager();
  const tracker = new LogpointExecutionTracker();
  const { breakpoint } = createBreakpointTools(
    { mapToGenerated: async () => null } as any,
    tracker,
    async (reason) => (reason === 'second' ? { cdpManager: named } as any : null)
  );
  await breakpoint.handler({
    action: 'setLogpoint', connection: 'second',
    url: 'app.js', lineNumber: 42, logMessage: 'hit', maxExecutions,
  } as any);
  return { active, named, tracker };
}

describe('a logpoint on a named connection', () => {
  it('reaching its limit records the limit on that connection, not the active one', async () => {
    const { active, named, tracker } = await logpointOnSecond(1);

    tracker.handleConsoleMessage(hit(1), named);

    expect(named.handleLogpointLimitExceeded).toHaveBeenCalledTimes(1);
    expect(active.handleLogpointLimitExceeded).not.toHaveBeenCalled();
  });

  it('counts only messages from its own connection', async () => {
    const { active, named, tracker } = await logpointOnSecond(2);

    tracker.handleConsoleMessage(hit(1), active);
    tracker.handleConsoleMessage(hit(2), named);
    expect(named.handleLogpointLimitExceeded).not.toHaveBeenCalled();

    tracker.handleConsoleMessage(hit(3), named);
    expect(named.handleLogpointLimitExceeded).toHaveBeenCalledTimes(1);
    expect(active.handleLogpointLimitExceeded).not.toHaveBeenCalled();
  });
});
