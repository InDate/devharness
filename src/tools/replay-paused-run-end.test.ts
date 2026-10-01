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
  const { replay } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay };
}

async function pausedRun(replay: any): Promise<string> {
  const started: any = await replay.handler({ action: 'run', sequenceId: 'seq-pause', connection: 'test-debug-session', stepTo: 1 });
  const runId = started._meta.replay.runId as string;
  await vi.waitFor(() => expect(runRegistry.get(runId)?.status).toBe('paused'));
  return runId;
}

beforeEach(() => runRegistry.clear());

describe('a paused background run', () => {
  it('reads as completed after finish', async () => {
    const { replay } = makeReplay();
    const runId = await pausedRun(replay);

    await replay.handler({ action: 'finish' });

    expect(runRegistry.get(runId)).toMatchObject({ status: 'completed', endedAt: expect.any(Number) });
  });

  it('reads as completed after stepping off its last step', async () => {
    const { replay } = makeReplay();
    const runId = await pausedRun(replay);

    await replay.handler({ action: 'step', stepCount: 5 });

    expect(runRegistry.get(runId)?.status).toBe('completed');
  });

  it('reads as cancelled after a cancel that names no run', async () => {
    const { replay } = makeReplay();
    const runId = await pausedRun(replay);

    await replay.handler({ action: 'cancel' });

    expect(runRegistry.get(runId)?.status).toBe('cancelled');
  });
});
