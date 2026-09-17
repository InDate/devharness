/**
 * Tests for the wrapped-action failure response.
 *
 * The property worth pinning: an action that never ran does not come back as
 * ELEMENT_NOT_FOUND. A paused page and a thrown action both leave
 * executeWithPauseDetection's `result` absent, and reporting that as a missing
 * element names the selector - the one thing that was not at fault - which
 * sends the reader to rewrite a selector that already matches.
 */

import { describe, it, expect } from 'vitest';
import { actionFailureResponse, executeWithPauseDetection } from './debugger-aware-wrapper.js';

const textOf = (response: any): string => response.content[0].text;

describe('actionFailureResponse', () => {
  it('carries the wrapper error through for an action that threw', () => {
    const response = actionFailureResponse(
      { success: false, error: 'click failed: Target closed', pausedAtBreakpoint: false },
      'click',
      '.session-row:has-text("8d76da6e")'
    );
    expect(response).toBeDefined();
    expect(response._errorId).toBe('ACTION_FAILED');
    expect(textOf(response)).toContain('Target closed');
    expect(textOf(response)).not.toContain('Element not found');
  });

  it('names the pause for an action issued against a held page', () => {
    const response = actionFailureResponse(
      { success: false, pausedAtBreakpoint: true, error: undefined },
      'click',
      'button.save'
    );
    expect(response._errorId).toBe('ACTION_FAILED');
    expect(textOf(response)).toContain('paused at a breakpoint');
  });

  it('still names the selector, so the report says which call it was', () => {
    const response = actionFailureResponse(
      { success: false, error: 'hover failed: detached frame' },
      'hover',
      '#row-7'
    );
    expect(textOf(response)).toContain('#row-7');
    expect(textOf(response)).toContain('hover');
  });

  it('stands aside when the action ran, whatever it returned', () => {
    expect(actionFailureResponse(
      { success: true, result: { error: 'Element not found: [data-cdp-selector-match="x"]' } },
      'click',
      '.missing'
    )).toBeUndefined();
    expect(actionFailureResponse(
      { success: true, result: { found: false } },
      'querySelector',
      '.missing'
    )).toBeUndefined();
  });

  it('stands aside for an empty array, which is a result and not a failure', () => {
    expect(actionFailureResponse({ success: true, result: [] }, 'hitTest', '.none')).toBeUndefined();
  });
});

/** Enough of CDPManager for the wrapper: a pause flag and a pause wait. */
function cdpStub(options: { paused?: boolean; pauseAfterMs?: number }): any {
  return {
    isPaused: () => !!options.paused,
    getPausedInfo: () => ({ location: undefined, callStack: [] }),
    waitForPause: (timeoutMs: number) => new Promise<void>((resolve, reject) => {
      if (options.pauseAfterMs !== undefined && options.pauseAfterMs <= timeoutMs) {
        setTimeout(resolve, options.pauseAfterMs);
        return;
      }
      setTimeout(() => reject(new Error('Timeout waiting for pause')), timeoutMs);
    }),
  };
}

describe('executeWithPauseDetection', () => {
  it('lets an action outlast the pause-detection timeout and still return its result', async () => {
    const result = await executeWithPauseDetection(
      cdpStub({}),
      () => new Promise(resolve => setTimeout(() => resolve({ clicked: true }), 60)),
      'click',
      20
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ clicked: true });
  });

  it('reports a pause that arrives while the action is in flight', async () => {
    const result = await executeWithPauseDetection(
      cdpStub({ pauseAfterMs: 10 }),
      () => new Promise(resolve => setTimeout(() => resolve({ clicked: true }), 200)),
      'click',
      100
    );
    expect(result.pausedAtBreakpoint).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it('refuses an action against a page that is already paused', async () => {
    const result = await executeWithPauseDetection(
      cdpStub({ paused: true }),
      async () => ({ clicked: true }),
      'click',
      50
    );
    expect(result.success).toBe(false);
    expect(result.pausedAtBreakpoint).toBe(true);
    expect(result.error).toContain('paused at a breakpoint');
  });

  it('carries an action\'s own throw through as the error', async () => {
    const result = await executeWithPauseDetection(
      cdpStub({}),
      async () => { throw new Error('Target closed'); },
      'click',
      50
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Target closed');
    expect(result.result).toBeUndefined();
  });
});
