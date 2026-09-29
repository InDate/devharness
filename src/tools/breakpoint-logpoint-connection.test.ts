// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { CDPManager } from '../cdp-manager.js';
import { createBreakpointTools } from './breakpoint-tools.js';

function connectedManager(breakpointId: string): CDPManager {
  const manager = new CDPManager();
  (manager as any).client = {
    Debugger: {
      setBreakpointByUrl: vi.fn(async () => ({
        breakpointId,
        locations: [{ scriptId: '1', lineNumber: 41, columnNumber: 0 }],
      })),
    },
    Runtime: { evaluate: vi.fn(async () => ({ result: { type: 'undefined' } })) },
  };
  (manager as any).state.connected = true;
  return manager;
}

describe('breakpoint setLogpoint on a named connection', () => {
  it('stores the logpoint on the named connection alone', async () => {
    const active = connectedManager('bp-active');
    const named = connectedManager('bp-named');
    const { breakpoint } = createBreakpointTools(
      active,
      { mapToGenerated: async () => null } as any,
      undefined,
      async (reason) => (reason === 'second' ? { cdpManager: named } as any : null)
    );

    const result: any = await breakpoint.handler({
      action: 'setLogpoint',
      connectionReason: 'second',
      url: 'app.js',
      lineNumber: 42,
      logMessage: 'hit',
    } as any);

    expect(result.isError).toBeUndefined();
    expect(named.getBreakpoints().map(bp => [bp.breakpointId, bp.isLogpoint])).toEqual([['bp-named', true]]);
    expect(active.getBreakpoints()).toEqual([]);
    expect(active.getBreakpointCounts().logpoints).toBe(0);
  });
});
