/**
 * A pause point carrying a note: the run stops before the marked step, the note
 * reaches the event stream as an `instruction` and the paused reply, and
 * `finish` carries on through the step. The `pause` action is the only way a
 * session sets the mark and its note, so it is pinned here too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const events = vi.hoisted(() => ({ appended: [] as Array<{ kind: string; payload: Record<string, unknown> }> }));
vi.mock('../session-events.js', async (original) => ({
  ...(await original<typeof import('../session-events.js')>()),
  appendEvent: async (_session: string, kind: string, payload: Record<string, unknown>) => {
    events.appended.push({ kind, payload });
  },
}));

import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { forgetCursor, standPausedRun } from '../proxy/registry.js';

const CONNECTION = 'pause-note-page';

function freshSequence(): CommandSequence {
  return {
    id: 'seq-note', name: 'note-seq', createdAt: 1,
    commands: [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
    ],
  };
}

function makeReplay(sequence: CommandSequence) {
  let active: any = null;
  const ran: string[] = [];
  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => null),
    listSavedSequencesOnDisk: vi.fn(async () => []),
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
    if (tool === 'dom') ran.push(params.selector);
    return { content: [{ type: 'text', text: '' }] };
  }));
  const { replay } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, recorder, ran };
}

const textOf = (response: any): string => response?.content?.[0]?.text ?? '';

beforeEach(() => {
  runRegistry.clear();
  events.appended.length = 0;
});
afterEach(async () => { await standPausedRun(undefined); forgetCursor(); });

describe('a pause point with a note', () => {
  it('stops before the step, sends the note as an instruction and in the reply, and finish carries on', async () => {
    const sequence = freshSequence();
    Object.assign(sequence.commands[1], { pauseBefore: true, pauseHolds: [], pauseNote: 'Play the other sequence in the bench.' });
    const { replay, recorder, ran } = makeReplay(sequence);

    const paused = await replay.handler({ action: 'run', sequenceId: 'seq-note', connection: CONNECTION, wait: true });
    expect(ran).toEqual(['#a']);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 1 });
    expect(textOf(paused)).toContain('To carry out before step 2:** Play the other sequence in the bench.');
    expect(events.appended).toEqual([{
      kind: 'instruction',
      payload: { sequence: 'note-seq', step: 2, note: 'Play the other sequence in the bench.', resolve: "replay({ action: 'finish' })" },
    }]);

    await replay.handler({ action: 'finish' });
    expect(ran).toEqual(['#a', '#b']);
    expect(events.appended).toHaveLength(1);
  });

  it('a pause point set to notify with no note sends an instruction that asks why', async () => {
    const sequence = freshSequence();
    Object.assign(sequence.commands[1], { pauseBefore: true, pauseHolds: [], pauseNotify: true });
    const { replay, ran } = makeReplay(sequence);

    const paused = await replay.handler({ action: 'run', sequenceId: 'seq-note', connection: CONNECTION, wait: true });
    expect(ran).toEqual(['#a']);
    expect(textOf(paused)).toContain('notifies the session before step 2, with no reason given');
    expect(events.appended).toEqual([{
      kind: 'instruction',
      payload: { sequence: 'note-seq', step: 2, resolve: "replay({ action: 'finish' })" },
    }]);
  });

  it('a pause point that does not notify stops the run without writing an instruction', async () => {
    const sequence = freshSequence();
    Object.assign(sequence.commands[1], { pauseBefore: true, pauseHolds: [] });
    const { replay, ran } = makeReplay(sequence);

    const paused = await replay.handler({ action: 'run', sequenceId: 'seq-note', connection: CONNECTION, wait: true });
    expect(ran).toEqual(['#a']);
    expect(textOf(paused)).not.toContain('To carry out before step');
    expect(events.appended).toEqual([]);
  });
});

describe('the pause action', () => {
  it('sets the mark, its holds and its note on the step, and remove takes all three away', async () => {
    const sequence = freshSequence();
    const { replay } = makeReplay(sequence);

    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, hold: ['network'], note: '  Do the thing.  ' });
    expect(sequence.commands[1]).toMatchObject({ pauseBefore: true, pauseHolds: ['network'], pauseNotify: true, pauseNote: 'Do the thing.' });

    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, note: '' });
    expect(sequence.commands[1]).toMatchObject({ pauseBefore: true, pauseHolds: ['network'], pauseNotify: true });
    expect(sequence.commands[1]).not.toHaveProperty('pauseNote');

    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, notify: false });
    expect(sequence.commands[1]).not.toHaveProperty('pauseNotify');

    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, notify: true, note: 'Again.' });
    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, notify: false });
    expect(sequence.commands[1]).not.toHaveProperty('pauseNotify');
    expect(sequence.commands[1]).not.toHaveProperty('pauseNote');

    await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 2, remove: true });
    expect(sequence.commands[1]).not.toHaveProperty('pauseBefore');
    expect(sequence.commands[1]).not.toHaveProperty('pauseHolds');
  });

  it('refuses step 1, a step past the end, and a call with no step', async () => {
    const { replay } = makeReplay(freshSequence());

    const first: any = await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 1 });
    const past: any = await replay.handler({ action: 'pause', sequenceId: 'seq-note', step: 3 });
    const none: any = await replay.handler({ action: 'pause', sequenceId: 'seq-note' });

    expect(first._errorId).toBe('INVALID_PARAMETER');
    expect(past._errorId).toBe('INVALID_PARAMETER');
    expect(none._errorId).toBe('MISSING_PARAMETER');
  });
});
