// @vitest-environment node
// (node, not happy-dom: events.getEventListeners only accepts Node's own
// EventTarget, and this suite asserts listener hygiene on a real AbortSignal)
/**
 * issues({action:'workOn'}) registers an abort listener that closes the work
 * tab if the call is cancelled. As a sequence step the signal is the RUN's
 * long-lived signal (#110), so the listener must be DETACHED when the handler
 * settles - otherwise every issues step leaks one listener, and cancelling
 * the run minutes later would close tabs belonging to long-finished steps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { __resetForTests, addIssue } from '../issue-tracker.js';
import { createIssuesTools } from './issues-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

vi.mock('../interaction-recorder.js', () => ({
  showTestReadyOverlay: vi.fn(),
  showVerificationOverlay: vi.fn(),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-issues-abort-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('workOn abort-listener hygiene', () => {
  it('detaches its abort listener from the signal once the handler settles', async () => {
    const executeToolCall = vi.fn(productionShaped(async (..._args: any[]) => ({ content: [{ type: 'text', text: '' }] })));
    const { issues } = createIssuesTools(executeToolCall);

    const controller = new AbortController();

    // Simulate many issues steps sharing one long-lived run signal.
    for (let i = 0; i < 5; i++) {
      const issue = await addIssue({ type: 'bug', title: `Bug ${i}` });
      const res = await issues.handler({ action: 'workOn', id: issue.id } as any, controller.signal);
      expect(res.isError).toBeUndefined();
    }

    expect(getEventListeners(controller.signal as any, 'abort')).toHaveLength(0);

    // A later cancel of the run must NOT close tabs of finished steps.
    controller.abort();
    await new Promise(r => setTimeout(r, 20));
    expect(executeToolCall.mock.calls.filter(c => c[0] === 'connection' && c[1]?.action === 'close')).toHaveLength(0);
  });

  it('still closes the tab when aborted while the handler is in flight', async () => {
    let releaseReplay: (() => void) | undefined;
    const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') {
        await new Promise<void>(resolve => { releaseReplay = resolve; });
      }
      return { content: [{ type: 'text', text: '' }] };
    }));
    const { issues } = createIssuesTools(executeToolCall);

    // A sequence-backed issue drives the blocking replay path.
    const issue = await addIssue({ type: 'bug', title: 'Slow one', sequenceFile: 'slow.json' });
    const controller = new AbortController();

    const pending = issues.handler({ action: 'workOn', id: issue.id } as any, controller.signal);
    // Wait until workOn is blocked inside the replay run, then cancel.
    const start = Date.now();
    while (!releaseReplay) {
      if (Date.now() - start > 2000) throw new Error('workOn never reached replay run');
      await new Promise(r => setTimeout(r, 5));
    }
    controller.abort();
    await new Promise(r => setTimeout(r, 20));
    expect(executeToolCall.mock.calls.some(c => c[0] === 'connection' && c[1]?.action === 'close')).toBe(true);

    releaseReplay!();
    await pending;
    expect(getEventListeners(controller.signal as any, 'abort')).toHaveLength(0);
  });
});
