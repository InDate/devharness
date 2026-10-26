/**
 * A hold a run's step takes belongs to that run: the step's handler runs
 * `unlisted`, as `executeToolCall` runs it, and the hold still names the run.
 * The run's later steps work on that hold, and the run ends it as it finishes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { attachLayer, hold, holdReading, release, type HoldOwner } from '../hold.js';
import { callOwner, unlisted } from '../call-origin.js';
import { forgetCursor, standPausedRun } from '../proxy/registry.js';

const CONNECTION = 'step-hold-page';

const sequence: CommandSequence = {
  id: 'seq-step-hold', name: 'step-hold-seq', createdAt: 1,
  commands: [
    { tool: 'hold', params: { action: 'hold', layers: ['code'] } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
  ],
};

let detach: (() => void) | undefined;

function makeReplay() {
  let active: any = null;
  const ownersAtStep2: HoldOwner[][] = [];
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
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: any) => {
    if (tool === 'connection' && params.action === 'status') {
      return { content: [{ type: 'text', text: '' }], _meta: { debugger: { paused: false } } };
    }
    // The handler runs as `executeToolCall` runs a recorded call's handler.
    if (tool === 'hold') await unlisted(() => hold(CONNECTION, { owner: callOwner(), layers: params.layers }));
    if (tool === 'dom') ownersAtStep2.push(holdReading(CONNECTION).held.flatMap(layer => layer.owners));
    return { content: [{ type: 'text', text: '' }] };
  }));
  detach = attachLayer(CONNECTION, 'code', { engage: async () => {}, disengage: async () => {} });
  const { replay, run } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, run, ownersAtStep2 };
}

beforeEach(() => { runRegistry.clear(); });
afterEach(async () => {
  await release(CONNECTION, { by: { kind: 'resume' } }).catch(() => {});
  detach?.(); detach = undefined;
  await standPausedRun(undefined);
  forgetCursor();
});

describe('a hold a run\'s step takes', () => {
  it('names the run, and stands for the run\'s next step', async () => {
    const { replay, run, ownersAtStep2 } = makeReplay();

    await run.handler({ action: 'sequence', sequenceId: 'seq-step-hold', connection: CONNECTION, wait: true });

    expect(ownersAtStep2).toEqual([[expect.objectContaining({ kind: 'run-step', step: 0 })]]);
  });

  it('ends with the run that took it', async () => {
    const { replay, run } = makeReplay();

    await run.handler({ action: 'sequence', sequenceId: 'seq-step-hold', connection: CONNECTION, wait: true });

    expect(holdReading(CONNECTION).held).toEqual([]);
  });

  it('outlives a pause of the run, and ends when the run is cancelled', async () => {
    const { replay, run } = makeReplay();

    await run.handler({ action: 'sequence', sequenceId: 'seq-step-hold', connection: CONNECTION, stepTo: 1, hold: [], wait: true });
    expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', owners: [expect.objectContaining({ kind: 'run-step' })] })]);

    await run.handler({ action: 'cancel' });
    expect(holdReading(CONNECTION).held).toEqual([]);
  });

  it('leaves an agent\'s hold standing when the run ends', async () => {
    const { replay, run } = makeReplay();
    await hold(CONNECTION, { owner: { kind: 'agent' }, layers: ['code'] });

    await run.handler({ action: 'sequence', sequenceId: 'seq-step-hold', connection: CONNECTION, wait: true });

    expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', owners: [{ kind: 'agent' }] })]);
  });
});
