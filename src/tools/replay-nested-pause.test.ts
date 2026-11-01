/**
 * A run that pauses inside a step running a child sequence.
 *
 * The child's pause point stops the parent inside the step that runs the
 * child, and `step` and `finish` carry the child on from its next step: a
 * restart of the child would take its earlier steps - its launches, its
 * logins - a second time. Positions count the child's saved steps, so a
 * launch skipped because its browser is live shifts no step number.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { CommandRecorder, type RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';
import { groupOf, membersOf } from '../groups.js';

function connectionsResponse(refs: string[]) {
  return {
    content: [{ type: 'text', text: `Active debugger connections (${refs.length} total)` }],
    _meta: {
      tool: 'connection', action: 'list', timestamp: 0,
      connections: refs.map((reference, i) => ({
        reference, type: 'chrome', host: 'localhost', port: 9222 + i, active: i === 0, connected: true, paused: false,
      })),
    },
  };
}

function makeHarness(opts: { live?: string[] } = {}) {
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const live = new Set(opts.live ?? []);
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    if (tool === 'check') return HELD;
    if (tool === 'connection' && params.action === 'list') return connectionsResponse([...live]);
    if (tool === 'connection' && params.action === 'launch') {
      const name = params.connection as string;
      const reused = live.has(name);
      live.add(name);
      return { content: [{ type: 'text', text: 'launched' }], _meta: { tool: 'connection', action: 'launch', launch: { name, reused } } };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));
  const recorder = new CommandRecorder();
  const { run } = createReplayTools(recorder, executeToolCall as any, async () => null, async () => null, undefined);
  return { calls, run, recorder };
}

const text = (res: any) => res.content[0].text as string;

const dom = (selector: string, extra: Partial<RecordedCommand> = {}): RecordedCommand =>
  ({ tool: 'dom', params: { action: 'querySelector', selector }, ...extra } as RecordedCommand);

const selectors = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'dom').map(c => c.params.selector);

const checkReads = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'check').length;

async function sequence(recorder: CommandRecorder, name: string, commands: RecordedCommand[]) {
  await recorder.createSequenceFromCommands(name, commands.map(c => ({ ...c, params: { ...c.params } })));
  const created = recorder.listSequences().find(s => s.name === name)!;
  commands.forEach((command, i) => {
    if ((command as any).pauseBefore) (created.commands[i] as any).pauseBefore = true;
  });
  return created;
}

describe('a pause point inside a child sequence', () => {
  it('stops the parent inside the step that runs the child, before the child step it marks', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'child-flow', [dom('#a'), dom('#b', { pauseBefore: true } as any), dom('#c')]);
    await sequence(recorder, 'parent-flow', [runsOnPass('child-flow'), dom('#after')]);

    const res = await run.handler({ action: 'sequence', name: 'parent-flow', wait: true } as any);

    expect(selectors(calls)).toEqual(['#a']);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 0, inside: { sequence: 'child-flow', branch: 'holds', step: 1 } });
    expect(text(res)).toContain('**Inside step 1:** the run stands before child-flow step 2');
  });

  it('stops before the first step the child runs when that step carries it', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'child-flow', [dom('#a', { pauseBefore: true } as any), dom('#b')]);
    await sequence(recorder, 'parent-flow', [runsOnPass('child-flow'), dom('#after')]);

    await run.handler({ action: 'sequence', name: 'parent-flow', wait: true } as any);

    expect(selectors(calls)).toEqual([]);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 0, inside: { sequence: 'child-flow', step: 0 } });
  });

  it('counts the child step by its saved number when a launch before it is skipped', async () => {
    const { run, recorder } = makeHarness({ live: ['already-open-tab'] });
    await sequence(recorder, 'child-flow', [
      { tool: 'connection', params: { action: 'launch', connection: 'already-open-tab' } } as RecordedCommand,
      dom('#a'),
      dom('#b', { pauseBefore: true } as any),
    ]);
    await sequence(recorder, 'parent-flow', [runsOnPass('child-flow')]);

    await run.handler({ action: 'sequence', name: 'parent-flow', wait: true, connection: 'already-open-tab' } as any);

    expect(recorder.getActiveSequence()?.inside).toMatchObject({ sequence: 'child-flow', step: 2 });
  });
});

describe('carrying on a run paused inside a child', () => {
  it('runs one child step on step, from the child step it stood before, without reading the check again', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'child-flow', [dom('#a'), dom('#b', { pauseBefore: true } as any), dom('#c')]);
    await sequence(recorder, 'parent-flow', [runsOnPass('child-flow'), dom('#after')]);
    await run.handler({ action: 'sequence', name: 'parent-flow', wait: true } as any);
    const readsAtPause = checkReads(calls);

    const stepped = await run.handler({ action: 'step' } as any);

    expect(text(stepped)).toContain('paused inside step 1 of 2 · child-flow step 3 runs next');
    expect(selectors(calls)).toEqual(['#a', '#b']);
    expect(checkReads(calls)).toBe(readsAtPause);
    expect(recorder.getActiveSequence()).toMatchObject({ currentStep: 0, inside: { sequence: 'child-flow', step: 2 } });
  });

  it('finishes the child from its next step and goes on with the parent', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'child-flow', [dom('#a'), dom('#b', { pauseBefore: true } as any), dom('#c')]);
    await sequence(recorder, 'parent-flow', [runsOnPass('child-flow'), dom('#after')]);
    await run.handler({ action: 'sequence', name: 'parent-flow', wait: true } as any);

    await run.handler({ action: 'finish' } as any);

    expect(selectors(calls)).toEqual(['#a', '#b', '#c', '#after']);
    expect(recorder.getActiveSequence()).toBeNull();
  });
});

describe('the browsers a sequence launches', () => {
  it('keeps each launch on its own name when the run names one connection', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'two-browser-flow', [
      { tool: 'connection', params: { action: 'launch', connection: 'first-test-browser' } } as RecordedCommand,
      { tool: 'connection', params: { action: 'launch', connection: 'second-test-browser' } } as RecordedCommand,
    ]);

    await run.handler({ action: 'sequence', name: 'two-browser-flow', wait: true, connection: 'first-test-browser' } as any);

    const launched = calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.connection);
    expect(launched).toEqual(['first-test-browser', 'second-test-browser']);
  });

  it('puts launches that name no group in a group named after the sequence, with the run connection', async () => {
    const { run, recorder } = makeHarness();
    await sequence(recorder, 'group-default-flow', [
      { tool: 'connection', params: { action: 'launch', connection: 'grouped-browser-one' } } as RecordedCommand,
      { tool: 'connection', params: { action: 'launch', connection: 'grouped-browser-two' } } as RecordedCommand,
    ]);

    await run.handler({ action: 'sequence', name: 'group-default-flow', wait: true, connection: 'grouped-browser-one' } as any);

    expect(groupOf('grouped-browser-two')).toBe('group-default-flow');
    expect(membersOf('group-default-flow').sort()).toEqual(['grouped-browser-one', 'grouped-browser-two']);
  });

  it('keeps a launch with group: false out of every group', async () => {
    const { run, recorder } = makeHarness();
    await sequence(recorder, 'group-opt-out-flow', [
      { tool: 'connection', params: { action: 'launch', connection: 'opted-out-browser', group: false } } as RecordedCommand,
    ]);

    await run.handler({ action: 'sequence', name: 'group-opt-out-flow', wait: true } as any);

    expect(groupOf('opted-out-browser')).toBeUndefined();
  });

  it('puts a browser a child launches in the group of the run connection, named after the parent', async () => {
    const { run, recorder } = makeHarness();
    await sequence(recorder, 'launching-child', [
      { tool: 'connection', params: { action: 'launch', connection: 'child-launched-browser' } } as RecordedCommand,
    ]);
    await sequence(recorder, 'parent-of-launching-child', [runsOnPass('launching-child')]);

    await run.handler({ action: 'sequence', name: 'parent-of-launching-child', wait: true, connection: 'parent-run-browser' } as any);

    expect(groupOf('child-launched-browser')).toBe('polc');
    expect(groupOf('parent-run-browser')).toBe('polc');
  });
});

describe('the check a run makes of the connections its steps name', () => {
  it('lets a step name a browser a child launches', async () => {
    const { calls, run, recorder } = makeHarness();
    await sequence(recorder, 'second-browser-child', [
      { tool: 'connection', params: { action: 'launch', connection: 'child-only-browser' } } as RecordedCommand,
    ]);
    await sequence(recorder, 'uses-child-browser', [
      runsOnPass('second-browser-child'),
      { tool: 'dom', params: { action: 'querySelector', selector: '#there', connection: 'child-only-browser' } } as RecordedCommand,
    ]);

    const res: any = await run.handler({ action: 'sequence', name: 'uses-child-browser', wait: true, connection: 'bench-run-browser' } as any);

    expect(res.isError).toBeFalsy();
    expect(calls.filter(c => c.tool === 'dom').map(c => c.params.connection)).toEqual(['child-only-browser']);
  });

  it('refuses a step naming a browser nothing in the run launches', async () => {
    const { run, recorder } = makeHarness();
    await sequence(recorder, 'names-absent-browser', [
      { tool: 'dom', params: { action: 'querySelector', selector: '#there', connection: 'nowhere-browser' } } as RecordedCommand,
    ]);

    const res: any = await run.handler({ action: 'sequence', name: 'names-absent-browser', wait: true, connection: 'bench-run-browser' } as any);

    expect(text(res)).toContain('a run-level connection does not reach a step that names its own connection');
  });
});
