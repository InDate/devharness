/**
 * A background run paused at `stepTo` stays in the run registry as paused.
 * Every way out of the pause ends the run, so each has to leave the record in
 * the state the run ended in: `finish` and stepping off the end as completed,
 * `cancel` with or without a runId as cancelled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const sequence: CommandSequence = {
  id: 'seq-pause', name: 'pause-seq', createdAt: 1,
  commands: [
    { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
  ],
};

function makeReplay() {
  let active: any = null;
  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => null),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn((state: any) => { active = state; }),
    getActiveSequence: vi.fn(() => active),
    updateActiveSequenceStep: vi.fn((step: number) => { if (active) active.currentStep = step; }),
    getCommandsSincePause: vi.fn(() => []),
  } as any;
  const executeToolCall = vi.fn(productionShaped(async () => ({ content: [{ type: 'text', text: '' }] })));
  const { replay, run } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, run };
}

async function pausedRun(run: any): Promise<string> {
  const started: any = await run.handler({ action: 'sequence', sequenceId: 'seq-pause', connection: 'test-debug-session', stepTo: 1 });
  const runId = started._meta.replay.runId as string;
  await vi.waitFor(() => expect(runRegistry.get(runId)?.status).toBe('paused'));
  return runId;
}

beforeEach(() => runRegistry.clear());

describe('a paused background run', () => {
  it('reads as completed after finish', async () => {
    const { replay, run } = makeReplay();
    const runId = await pausedRun(run);

    await run.handler({ action: 'finish' });

    expect(runRegistry.get(runId)).toMatchObject({ status: 'completed', endedAt: expect.any(Number) });
  });

  it('reads as completed after stepping off its last step', async () => {
    const { replay, run } = makeReplay();
    const runId = await pausedRun(run);

    await run.handler({ action: 'step', stepCount: 5 });

    expect(runRegistry.get(runId)?.status).toBe('completed');
  });

  it('reads as cancelled after a cancel that names no run', async () => {
    const { replay, run } = makeReplay();
    const runId = await pausedRun(run);

    await run.handler({ action: 'cancel' });

    expect(runRegistry.get(runId)?.status).toBe('cancelled');
  });
});

describe('a reply that leaves the run paused', () => {
  it('names the step that runs next, in its text and in _meta', async () => {
    const { run } = makeReplay();

    const paused: any = await run.handler({ action: 'sequence', sequenceId: 'seq-pause', connection: 'test-debug-session', stepTo: 1, wait: true });
    const status: any = await run.handler({ action: 'status' });

    expect(paused.content[0].text).toContain('step 2 of 2 runs next');
    expect(paused._meta.replay).toMatchObject({ paused: true, nextStep: 2, totalSteps: 2 });
    expect(status.content[0].text).toContain('step 2 of 2 runs next');
    expect(status._meta.replay).toMatchObject({ paused: true, nextStep: 2, totalSteps: 2 });
    await run.handler({ action: 'cancel' });
  });
});

describe('a run started while another stands paused', () => {
  it('is refused, naming the paused run and the calls that end it, and leaves that run to finish', async () => {
    const { run } = makeReplay();
    const runId = await pausedRun(run);

    const second: any = await run.handler({ action: 'sequence', sequenceId: 'seq-pause', connection: 'test-debug-session', wait: true });

    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('pause-seq is paused at step 2 of 2');
    expect(second.content[0].text).toContain(`run({ action: 'cancel', runId: '${runId}' })`);
    expect(runRegistry.get(runId)?.status).toBe('paused');

    await run.handler({ action: 'finish' });
    expect(runRegistry.get(runId)?.status).toBe('completed');
  });

  it('starts once the paused run is cancelled', async () => {
    const { run } = makeReplay();
    await pausedRun(run);
    await run.handler({ action: 'cancel' });

    const next: any = await run.handler({ action: 'sequence', sequenceId: 'seq-pause', connection: 'test-debug-session', wait: true });

    expect(next.isError).toBeFalsy();
    expect(next._meta.replay).toMatchObject({ success: true });
  });
});
