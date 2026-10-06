/**
 * A person's input landing mid-run, under the default `pause`: the run holds
 * before the next step with the page's layers held by the run, and carrying
 * it on releases what the run held before the next step drives the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const landing = vi.hoisted(() => ({ next: [] as any[] }));
vi.mock('../person-watch.js', async (original) => ({
  ...(await original<typeof import('../person-watch.js')>()),
  personInputSince: () => landing.next.splice(0),
}));

import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { attachLayer, hold, holdReading, release } from '../hold.js';
import { forgetCursor, standPausedRun } from '../proxy/registry.js';

const CONNECTION = 'person-hold-page';

const sequence: CommandSequence = {
  id: 'seq-person', name: 'person-seq', createdAt: 1,
  commands: [
    { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
  ],
};

let detach: (() => void) | undefined;

function makeReplay() {
  let active: any = null;
  let running = true;
  const ran: Array<{ selector: string; running: boolean }> = [];
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
      ran.push({ selector: params.selector, running });
      // A person clicks the page while the first step runs.
      if (params.selector === '#a') landing.next.push({ action: 'click', selector: 'body', at: Date.now(), index: 5 });
    }
    return { content: [{ type: 'text', text: '' }] };
  }));
  detach = attachLayer(CONNECTION, 'code', {
    engage: async () => { running = false; },
    disengage: async () => { running = true; },
  });
  const { replay } = createReplayTools(recorder, executeToolCall, async () => null, async () => 9222, undefined);
  return { replay, recorder, ran, isRunning: () => running };
}

beforeEach(() => { runRegistry.clear(); landing.next = []; });
afterEach(async () => {
  await release(CONNECTION).catch(() => {});
  detach?.(); detach = undefined;
  await standPausedRun(undefined);
  forgetCursor();
});

describe("a run a person's input lands on", () => {
  it('holds before the next step, with the page held by the run', async () => {
    const { replay, recorder, ran, isRunning } = makeReplay();

    const result: any = await replay.handler({ action: 'run', sequenceId: 'seq-person', connection: CONNECTION, wait: true });

    expect(ran.map(one => one.selector)).toEqual(['#a']);
    expect(result.content[0].text).toContain("the run is held before step 2, with the page's code held");
    expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', source: 'sequence' })]);
    expect(isRunning()).toBe(false);
    expect(recorder.getActiveSequence().pauseHeld).toEqual(['code']);
  });

  it('releases what the run held before finish drives the next step', async () => {
    const { replay, ran } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-person', connection: CONNECTION, wait: true });
    await replay.handler({ action: 'finish' });

    expect(ran).toEqual([{ selector: '#a', running: true }, { selector: '#b', running: true }]);
    expect(holdReading(CONNECTION).held).toEqual([]);
  });

  it('leaves a hold placed by someone else in the pause', async () => {
    const { replay } = makeReplay();

    await replay.handler({ action: 'run', sequenceId: 'seq-person', connection: CONNECTION, wait: true });
    await release(CONNECTION);
    await hold(CONNECTION, { source: 'tool', layers: ['code'] });
    await replay.handler({ action: 'cancel' });

    expect(holdReading(CONNECTION).held).toEqual([expect.objectContaining({ layer: 'code', source: 'tool' })]);
  });
});
