/**
 * A breakpoint the sequence did not set stops the page mid-run. The run holds
 * on the step that ran into it, so it can be carried on from there, and
 * carrying it on resumes the page through the hold record before the next step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { attachLayer, recordHeld, holdReading } from '../hold.js';
import { currentCursor, forgetCursor, standPausedRun } from '../proxy/registry.js';

const CONNECTION = 'hold-test-page';
const LOGPOINT_LINE = { url: 'http://localhost:3101/client.js', lineNumber: 180, functionName: 'handleCalculate' };

const sequence: CommandSequence = {
  id: 'seq-hold', name: 'hold-seq', createdAt: 1,
  commands: [
    { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#stops' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#c' } },
  ],
};

let detach: (() => void) | undefined;

function makeReplay() {
  let active: any = null;
  let paused = false;
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
      return { content: [{ type: 'text', text: '' }], _meta: { debugger: paused ? { paused: true, pausedAt: LOGPOINT_LINE } : { paused: false } } };
    }
    if (tool === 'dom') {
      ran.push(params.selector);
      if (params.selector === '#stops') {
        paused = true;
        recordHeld(CONNECTION, 'code', 'breakpoint', { at: `${LOGPOINT_LINE.url}:${LOGPOINT_LINE.lineNumber}` });
      }
    }
    return { content: [{ type: 'text', text: '' }] };
  }));
  // The code layer's release resumes the page, as the connection's debugger does.
  const resume = vi.fn(async () => { paused = false; });
  detach = attachLayer(CONNECTION, 'code', { engage: async () => { paused = true; }, disengage: resume });
  const { replay } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, recorder, ran, resume, isPaused: () => paused };
}

beforeEach(() => runRegistry.clear());
afterEach(async () => { detach?.(); detach = undefined; await standPausedRun(undefined); forgetCursor(); });

describe('a run that a breakpoint the sequence did not set stops', () => {
  it('holds on the step that ran into it, with where the page stopped', async () => {
    const { replay, recorder, ran } = makeReplay();

    const result: any = await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });

    expect(result._meta.replay).toMatchObject({ paused: true });
    expect(result.content[0].text).toContain("replay({ action: 'finish' })");
    expect(ran).toEqual(['#a', '#stops']);
    expect(recorder.getActiveSequence()).toMatchObject({
      currentStep: 2,
      breakpointHit: { url: LOGPOINT_LINE.url, lineNumber: 180 },
    });
  });

  it('resumes the page and runs the remaining steps on finish', async () => {
    const { replay, recorder, ran, resume, isPaused } = makeReplay();
    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });

    const result: any = await replay.handler({ action: 'finish' });

    expect(result.isError).toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(isPaused()).toBe(false);
    expect(holdReading(CONNECTION).held).toEqual([]);
    expect(ran).toEqual(['#a', '#stops', '#c']);
    expect(recorder.getActiveSequence()).toBeNull();
  });

  it('holds a step-through session on that step, and the next step resumes the page first', async () => {
    const { replay, recorder, ran, resume } = makeReplay();
    // Holding nothing at the stepTo pause, so the one resume counted is the breakpoint's.
    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true, stepTo: 1, hold: [] });

    const held: any = await replay.handler({ action: 'step' });

    expect(held.content[0].text).toContain('Held at step 2');
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 2, breakpointHit: { lineNumber: 180 } });

    await replay.handler({ action: 'step' });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(['#a', '#stops', '#c']);
    expect(recorder.getActiveSequence()).toBeNull();
  });
});

describe('the step a breakpoint stopped the page inside', () => {
  it("stays open through the pause, its cursor standing on the run's own pass", async () => {
    const { replay, recorder } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });

    const active = recorder.getActiveSequence();
    expect(active.openStep).toMatchObject({ step: 1 });
    expect(active.runTimestamp).toEqual(expect.any(Number));
    expect(currentCursor()).toMatchObject({ kind: 'replay', runId: `run-${active.runTimestamp.toString(36)}`, step: 1 });
    expect(currentCursor()).not.toHaveProperty('paused');
  });

  it('is closed by finish, which leaves no cursor standing once the run ends', async () => {
    const { replay } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });
    await replay.handler({ action: 'finish' });

    expect(currentCursor()).toBeUndefined();
  });
});

describe('a run paused at stepTo', () => {
  it('stands a pause stamp before the step it resumes at, which cancel takes down', async () => {
    const { replay } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true, stepTo: 1 });
    expect(currentCursor()).toMatchObject({ kind: 'replay', step: 1, paused: true });

    await replay.handler({ action: 'cancel' });
    expect(currentCursor()).toBeUndefined();
  });
});

describe('what a stepTo pause holds', () => {
  it('holds the page by default, and finish releases it before the next step', async () => {
    const { replay, isPaused } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true, stepTo: 1 });
    expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', source: 'sequence' })]);
    expect(isPaused()).toBe(true);

    await replay.handler({ action: 'step' });
    expect(holdReading(CONNECTION).held.filter(held => held.source === 'sequence')).toEqual([]);
  });

  it('holds nothing where the run asks for nothing', async () => {
    const { replay, isPaused } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true, stepTo: 1, hold: [] });
    expect(holdReading(CONNECTION).held).toEqual([]);
    expect(isPaused()).toBe(false);
  });
});

describe('what a pause point holds', () => {
  it('holds every layer by default, and only the layers it names', async () => {
    const marked = sequence.commands[1] as { pauseBefore?: true; pauseHolds?: string[] };
    marked.pauseBefore = true;
    try {
      const first = makeReplay();
      await first.replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });
      expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', source: 'sequence' })]);
      await first.replay.handler({ action: 'cancel' });
      detach?.(); detach = undefined;

      marked.pauseHolds = [];
      const second = makeReplay();
      await second.replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true });
      expect(second.ran).toEqual(['#a']);
      expect(holdReading(CONNECTION).held).toEqual([]);
    } finally {
      delete marked.pauseBefore;
      delete marked.pauseHolds;
    }
  });
});
