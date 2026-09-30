import { describe, it, expect, vi } from 'vitest';
import { createBreakpointTools } from './breakpoint-tools.js';
import { createInspectionTools } from './inspection-tools.js';
import { createSourceTools } from './source-tools.js';

const resolveNothing = async () => null;

describe('a call that acts on a connection without naming one', () => {
  it('is refused by breakpoint and inspect for every action', () => {
    const { breakpoint } = createBreakpointTools({} as any, undefined, resolveNothing);
    const { inspect } = createInspectionTools({} as any, resolveNothing);

    for (const action of ['set', 'list', 'remove', 'setLogpoint', 'await']) {
      expect(breakpoint.zodSchema.safeParse({ action }).success, `breakpoint ${action}`).toBe(false);
    }
    for (const action of ['getCallStack', 'evaluateExpression', 'searchCode', 'listTargets']) {
      expect(inspect.zodSchema.safeParse({ action }).success, `inspect ${action}`).toBe(false);
    }
  });

  it('is refused by source get, and source loadMaps needs none', async () => {
    const sourceMapHandler = { registerSourceMapsFromDirectory: vi.fn(async () => 2) } as any;
    const { source } = createSourceTools(sourceMapHandler, resolveNothing);

    const get: any = await source.handler({ action: 'get', url: 'app.js' } as any);
    const loadMaps: any = await source.handler({ action: 'loadMaps', directory: 'dist' } as any);

    expect(get.isError).toBe(true);
    expect(get.content[0].text).toContain('connectionReason');
    expect(loadMaps.isError).toBeFalsy();
    expect(sourceMapHandler.registerSourceMapsFromDirectory).toHaveBeenCalledWith('dist');
  });
});
