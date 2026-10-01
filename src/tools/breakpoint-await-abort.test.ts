// @vitest-environment node
/**
 * `breakpoint({ action: 'await' })` cancellation (#110).
 *
 * This was a CORRECTNESS bug, not just missing coverage: the handler already
 * observed the abort signal, but resolved a SUCCESS-shaped response (no
 * isError), so a cancelled `breakpoint.await` step was recorded
 * `success: true` - a cancelled step reported as passed. It must now fail like
 * every other aborted step, and it must still clean up a breakpoint it created
 * on the way out.
 */
import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { createBreakpointTools } from './breakpoint-tools.js';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { isAbortError } from '../utils/abort.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { ToolError } from '../tool-error.js';

function makeCdpManager(overrides: Record<string, any> = {}) {
  return {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => false,
    isScriptLoaded: () => true,
    getPausedInfo: () => ({ paused: false }),
    getScriptUrl: () => 'app.js',
    getCallStack: () => null,
    // Never pauses: the only way out is the abort (or the timeout).
    waitForPause: vi.fn(() => new Promise<void>(() => {})),
    setBreakpoint: vi.fn(async () => ({
      breakpointId: 'bp-1',
      location: { lineNumber: 41, columnNumber: 2 },
    })),
    removeBreakpoint: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeBreakpoint(cdpManager: any) {
  const { breakpoint } = createBreakpointTools(
    { mapToGenerated: async () => null } as any,
    undefined,
    async () => ({ cdpManager }) as any
  );
  return breakpoint;
}

describe('breakpoint.await cancellation', () => {
  it('THROWS abort-shaped instead of resolving a success-shaped response', async () => {
    const cdpManager = makeCdpManager();
    const breakpoint = makeBreakpoint(cdpManager);
    const controller = new AbortController();

    const settled = breakpoint.handler({ action: 'await', connection: 'app', timeout: 120_000 } as any, controller.signal)
      .then((value: any) => ({ ok: true as const, value }), (err: any) => ({ ok: false as const, err }));

    // Let the handler register its listeners, then cancel.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const outcome = await settled;
    // The bug: this used to be { ok: true, value: <no isError> }.
    expect(outcome.ok).toBe(false);
    expect(isAbortError((outcome as any).err)).toBe(true);
  });

  it('removes a breakpoint it created before throwing', async () => {
    const cdpManager = makeCdpManager();
    const breakpoint = makeBreakpoint(cdpManager);
    const controller = new AbortController();

    const settled = breakpoint.handler(
      { action: 'await', connection: 'app', url: 'app.js', lineNumber: 42, timeout: 120_000 } as any,
      controller.signal
    ).then((value: any) => ({ ok: true as const, value }), (err: any) => ({ ok: false as const, err }));

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect(cdpManager.setBreakpoint).toHaveBeenCalledTimes(1);
    // A one-shot await breakpoint left behind would pause the target the next
    // time that line runs, long after the user cancelled.
    expect(cdpManager.removeBreakpoint).toHaveBeenCalledWith('bp-1');
  });

  it('refuses to start waiting at all when the signal has already aborted', async () => {
    const cdpManager = makeCdpManager();
    const breakpoint = makeBreakpoint(cdpManager);
    const controller = new AbortController();
    controller.abort();

    await expect(
      breakpoint.handler({ action: 'await', connection: 'app', url: 'app.js', lineNumber: 42 } as any, controller.signal)
    ).rejects.toSatisfy((err: any) => isAbortError(err));

    // No breakpoint set, nothing waited on.
    expect(cdpManager.setBreakpoint).not.toHaveBeenCalled();
    expect(cdpManager.waitForPause).not.toHaveBeenCalled();
  });

  it('detaches its abort listener so a long-lived run signal does not accumulate them', async () => {
    const cdpManager = makeCdpManager({
      // Resolve immediately: a normal "breakpoint hit" exit path.
      waitForPause: vi.fn(async () => undefined),
      getPausedInfo: () => ({ paused: true, callStack: [] }),
    });
    const breakpoint = makeBreakpoint(cdpManager);
    const controller = new AbortController();

    for (let i = 0; i < 5; i++) {
      await breakpoint.handler({ action: 'await', connection: 'app', timeout: 1000 } as any, controller.signal);
    }

    expect(getEventListeners(controller.signal as any, 'abort')).toHaveLength(0);
  });

  it('a cancelled await step is recorded as a FAILED step, not a passing one', async () => {
    const cdpManager = makeCdpManager();
    const breakpoint = makeBreakpoint(cdpManager);
    const controller = new AbortController();

    const executeToolCall: ExecuteToolCall = async (tool, params, signal) => {
      if (tool !== 'breakpoint') return { content: [{ type: 'text', text: 'ok' }] };
      const result: any = await breakpoint.handler(params as any, signal);
      // A ToolError, as index.ts raises: a plain Error drops the `response`
      // that failure classifiers read `_errorId` from.
      if (result?.isError) throw new ToolError(result);
      return result;
    };

    const commands: RecordedCommand[] = [
      { tool: 'breakpoint', params: { action: 'await', connection: 'app', timeout: 120_000 }, timestamp: Date.now() } as any,
    ];
    const sequence = { id: 'seq-1', name: 'await-cancel', commands } as unknown as CommandSequence;

    const ctx = { executeToolCall, logPrefix: 'test' } as unknown as ExecutionContext;

    setTimeout(() => controller.abort(), 50);
    const run = await executeSteps({
      sequence,
      startStep: 0,
      ctx,
      totalTimeout: 300_000,
      abortSignal: controller.signal,
    });

    expect(run.results[0].success).toBe(false);
    expect(run.results[0].error).toBe('Replay aborted by user');
  });
});
