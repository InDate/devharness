/**
 * A step cut short by its caller - the bench's pause, a cancelled call - is a
 * pause, not an end: the session stays open at the last step that finished,
 * the sequence's teardown does not run in the middle of it, and the next step
 * carries on from the step that was cut short rather than from the first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { forgetCursor, standPausedRun } from '../proxy/registry.js';

const CONNECTION = 'step-abort-page';

const sequence: CommandSequence = {
  id: 'seq-abort', name: 'abort-seq', createdAt: 1,
  commands: [
    { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#c' } },
  ],
  teardown: [{ tool: 'dom', params: { action: 'querySelector', selector: '#teardown' } }],
};

function makeReplay(cutShort: { at?: string; controller?: AbortController }) {
  let active: any = null;
  const ran: string[] = [];
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
    if (tool === 'dom') {
      ran.push(params.selector);
      if (params.selector === cutShort.at) {
        cutShort.at = undefined;
        cutShort.controller?.abort();
        throw new Error('aborted');
      }
    }
    return { content: [{ type: 'text', text: '' }] };
  }));
  const { replay } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, recorder, ran };
}

beforeEach(() => runRegistry.clear());
afterEach(async () => { await standPausedRun(undefined); forgetCursor(); });

describe('a step cut short by its caller', () => {
  it('leaves the session at the last step that finished and runs no teardown', async () => {
    const cutShort: { at?: string; controller?: AbortController } = { at: '#b', controller: new AbortController() };
    const { replay, recorder, ran } = makeReplay(cutShort);

    await replay.handler({ action: 'run', sequenceId: 'seq-abort', connection: CONNECTION, wait: true, stepTo: 1 });
    await replay.handler({ action: 'step' }, cutShort.controller!.signal);

    expect(ran).toEqual(['#a', '#b']);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 1 });
  });

  it('carries on from the step that was cut short, not from the first', async () => {
    const cutShort: { at?: string; controller?: AbortController } = { at: '#b', controller: new AbortController() };
    const { replay, ran } = makeReplay(cutShort);

    await replay.handler({ action: 'run', sequenceId: 'seq-abort', connection: CONNECTION, wait: true, stepTo: 1 });
    await replay.handler({ action: 'step' }, cutShort.controller!.signal);
    await replay.handler({ action: 'finish' });

    expect(ran).toEqual(['#a', '#b', '#b', '#c', '#teardown']);
  });
});

describe('a finish cut short by its caller', () => {
  it('stops as a step does: at the last step that finished, with no teardown', async () => {
    const cutShort: { at?: string; controller?: AbortController } = { at: '#c', controller: new AbortController() };
    const { replay, recorder, ran } = makeReplay(cutShort);

    await replay.handler({ action: 'run', sequenceId: 'seq-abort', connection: CONNECTION, wait: true, stepTo: 1 });
    await replay.handler({ action: 'finish' }, cutShort.controller!.signal);

    expect(ran).toEqual(['#a', '#b', '#c']);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 2 });

    await replay.handler({ action: 'finish' });
    expect(ran).toEqual(['#a', '#b', '#c', '#c', '#teardown']);
  });
});

describe('a pause point saved before a step', () => {
  it('stops the run before that step, and finish carries on through it', async () => {
    const marked = sequence.commands[2] as { pauseBefore?: true };
    marked.pauseBefore = true;
    try {
      const { replay, recorder, ran } = makeReplay({});

      await replay.handler({ action: 'run', sequenceId: 'seq-abort', connection: CONNECTION, wait: true });
      expect(ran).toEqual(['#a', '#b']);
      expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 2 });

      await replay.handler({ action: 'finish' });
      expect(ran).toEqual(['#a', '#b', '#c', '#teardown']);
      expect(recorder.getActiveSequence()).toBeNull();
    } finally {
      delete marked.pauseBefore;
    }
  });
});
