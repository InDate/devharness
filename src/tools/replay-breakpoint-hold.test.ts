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
afterEach(() => { detach?.(); detach = undefined; });

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
    await replay.handler({ action: 'run', sequenceId: 'seq-hold', connection: CONNECTION, wait: true, stepTo: 1 });

    const held: any = await replay.handler({ action: 'step' });

    expect(held.content[0].text).toContain('Held at step 2');
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 2, breakpointHit: { lineNumber: 180 } });

    await replay.handler({ action: 'step' });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(['#a', '#stops', '#c']);
    expect(recorder.getActiveSequence()).toBeNull();
  });
});
