import { describe, it, expect, vi } from 'vitest';
import { createBreakpointTools } from './breakpoint-tools.js';

/**
 * A logpoint CDP moved to line 12 when line 10 was asked for, whose
 * expressions fail there, and whose search for a nearby line throws.
 */
function movedLogpointWithFailedSearch() {
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    setBreakpoint: vi.fn(async () => ({ breakpointId: 'bp-1', location: { scriptId: '1', lineNumber: 11, columnNumber: 0 } })),
    validateLogpointAtActualLocation: vi.fn(async () => ({
      allValid: false,
      results: [{ expression: 'order.total', valid: false }],
      availableVariables: [],
    })),
    removeBreakpoint: vi.fn(async () => undefined),
    getSourceCode: vi.fn(async () => ({ code: 'const x = 1;', totalLines: 20 })),
    findBestLogpointLocation: vi.fn(async () => { throw new Error('search timed out'); }),
  };
  const { breakpoint } = createBreakpointTools({} as any, undefined, async () => ({ cdpManager }) as any);
  return breakpoint;
}

describe('a logpoint whose expressions fail where CDP placed it', () => {
  it('suggests the line before, with its reason, when the search for a better line fails', async () => {
    const breakpoint = movedLogpointWithFailedSearch();

    const result: any = await breakpoint.handler({
      action: 'setLogpoint', connectionReason: 'shop-web-app', url: 'http://shop.test/app.js', lineNumber: 10, logMessage: 'total {order.total}',
    } as any);

    const text = result.content[0].text as string;
    expect(result.isError).toBe(true);
    expect(text).toContain('- Line 11 - Try the line before where variables might be in scope');
    expect(text).not.toContain('undefined');
  });
});
