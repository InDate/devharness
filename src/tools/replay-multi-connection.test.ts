/**
 * bug-018: a recorded multi-browser sequence must replay against the browsers it
 * was recorded against.
 *
 * `recordCommand` used to delete `connectionReason` from every recorded command
 * "to make sequences reusable", so `replay create` produced steps with no
 * connection at all and the executor injected the single run-level connection
 * into all of them. A two-browser sequence therefore replayed in ONE browser -
 * and, being a replay of a cross-user propagation check, it PASSED while never
 * involving a second user.
 *
 * These tests are written so the multi-connection ones fail against the
 * pre-fix code (see the notes on each): a test that would pass either way is
 * worthless for a silent-pass bug.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';
import {
  analyzeRecordedStepConnections,
  normalizeStepConnections,
} from './replay-executor.js';

const OWNER = 'duo-owner-console';
const MEMBER = 'duo-member-two';

/** connection list as the real tool answers it: the connections in `_meta`. */
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
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'check') return HELD;
    calls.push({ tool, params });
    if (tool === 'connection' && params.action === 'list') return connectionsResponse(opts.live ?? []);
    return { content: [{ type: 'text', text: '' }] };
  }));

  const recorder = new CommandRecorder();
  const { replay } = createReplayTools(
    recorder,
    executeToolCall as any,
    async () => null,        // no page -> no cursor/overlay injection
    async () => null,
    undefined
  );

  return { calls, replay, recorder };
}

/** The connection each dom step actually executed against, in order. */
const domConnections = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'dom' && c.params.action === 'querySelector')
    .map(c => c.params.connectionReason);

const domSelectors = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'dom' && c.params.action === 'querySelector')
    .map(c => c.params.selector);

const text = (res: any) => res.content[0].text as string;

/** Drive the two-browser recording the issue describes. */
async function recordDuo(recorder: CommandRecorder) {
  await recorder.recordCommand('dom', { action: 'querySelector', selector: '#owner-stock', connectionReason: OWNER });
  await recorder.recordCommand('dom', { action: 'querySelector', selector: '#member-draw', connectionReason: MEMBER });
  await recorder.recordCommand('dom', { action: 'querySelector', selector: '#owner-stock-again', connectionReason: OWNER });
}

const commandsOf = (recorder: CommandRecorder, name: string) =>
  recorder.listSequences().find(s => s.name === name)!.commands;

const run = (replay: any, extra: Record<string, any>) =>
  replay.handler({ action: 'run', wait: true, ...extra } as any);

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('recordCommand keeps the connection the call was made with', () => {
  it('preserves connectionReason in history, sanitized to the stored reference form', async () => {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('input', { action: 'click', selector: '#go', connectionReason: 'Duo Member Two' });

    // PRE-FIX: connectionReason is deleted here, so this is undefined.
    expect(recorder.getCommand(0)!.params.connectionReason).toBe(MEMBER);
  });

  it('does not invent a connection for a call that had none', async () => {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#x' });
    expect(recorder.getCommand(0)!.params).not.toHaveProperty('connectionReason');
  });
});

// ---------------------------------------------------------------------------
// create: keep per-step connections, hoist a uniform one
// ---------------------------------------------------------------------------

describe('create preserves a two-connection recording', () => {
  it('keeps every step on the connection it was recorded against', async () => {
    const { replay, recorder } = makeHarness();
    await recordDuo(recorder);

    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);

    // PRE-FIX: all three steps come out bare, so this is [undefined x3].
    expect(commandsOf(recorder, 'duo-seq').map(c => c.params.connectionReason))
      .toEqual([OWNER, MEMBER, OWNER]);
  });

  it('tells the user the sequence spans connections and how to rebind it', async () => {
    const { replay, recorder } = makeHarness();
    await recordDuo(recorder);

    const res = await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);

    expect(text(res)).toContain('Multi-connection sequence');
    expect(text(res)).toContain(MEMBER);
    expect(text(res)).toContain('connections');
  });

  it('does not rewrite the history entries it built the sequence from', async () => {
    const { replay, recorder } = makeHarness();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connectionReason: OWNER });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: OWNER });

    // uniform -> hoisted off the sequence steps...
    await replay.handler({ action: 'create', name: 'solo-seq', indices: [0, 1] } as any);
    expect(commandsOf(recorder, 'solo-seq').map(c => c.params.connectionReason)).toEqual([undefined, undefined]);

    // ...but history still knows what each call was driven against
    expect(recorder.getCommand(0)!.params.connectionReason).toBe(OWNER);
  });

  it('hoists a uniform connection so the sequence stays portable', async () => {
    const { replay, recorder } = makeHarness();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connectionReason: OWNER });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: OWNER });

    const res = await replay.handler({ action: 'create', name: 'solo-seq', indices: [0, 1] } as any);

    expect(commandsOf(recorder, 'solo-seq').every(c => !('connectionReason' in c.params))).toBe(true);
    expect(text(res)).toContain('hoisted');
  });

  it('leaves an ambiguous (partly bare) recording per-step and says so', async () => {
    const { replay, recorder } = makeHarness();
    // recorded bare, as recordings made before every call named its connection are...
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a' });
    // ...and explicitly
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: MEMBER });

    const res = await replay.handler({ action: 'create', name: 'mixed-seq', indices: [0, 1] } as any);

    expect(commandsOf(recorder, 'mixed-seq').map(c => c.params.connectionReason)).toEqual([undefined, MEMBER]);
    expect(text(res)).toContain('Mixed connections');
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('run against a two-connection sequence', () => {
  it('replays each step against its own connection', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, MEMBER] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, { sequenceId, connectionReason: OWNER });

    // PRE-FIX: [OWNER, OWNER, OWNER] - the member step ran in the owner's browser.
    expect(domConnections(calls)).toEqual([OWNER, MEMBER, OWNER]);
  });

  it('does not let a run-level connectionReason collapse it', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, MEMBER, 'other-browser-one'] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, { sequenceId, connectionReason: 'other-browser-one' });

    expect(domConnections(calls)).toEqual([OWNER, MEMBER, OWNER]);
  });

  it('rebinds recorded references onto this session with connections', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, 'my-second-browser'] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { [MEMBER]: 'my-second-browser' },
    });

    expect(domConnections(calls)).toEqual([OWNER, 'my-second-browser', OWNER]);
  });

  it('renames the launch of a mapped reference too', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, 'my-second-browser'] });
    await recorder.recordCommand('connection', { action: 'launch', name: MEMBER });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connectionReason: OWNER });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: MEMBER });
    await replay.handler({ action: 'create', name: 'duo-launch', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { [MEMBER]: 'my-second-browser' },
    });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.name))
      .toEqual(['my-second-browser']);
    expect(domConnections(calls)).toEqual([OWNER, 'my-second-browser']);
  });

  it('fails the step loudly when a recorded reference does not exist here', async () => {
    // only the owner browser is live in this session
    const { replay, recorder, calls } = makeHarness({ live: [OWNER] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    const res = await run(replay, { sequenceId, connectionReason: OWNER });
    const out = text(res);

    expect(out).toContain(MEMBER);
    expect(out).toContain('does not exist in this session');
    expect(out).toContain('connections');

    // and crucially: it did NOT quietly run in the owner's browser
    expect(domSelectors(calls)).toEqual(['#owner-stock']);
    expect(domConnections(calls)).toEqual([OWNER]);
  });

  it('rejects a connections key that names no recorded reference', async () => {
    const { replay, recorder } = makeHarness({ live: [OWNER, MEMBER] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo-seq', indices: [0, 1, 2] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    const res = await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { 'duo-member-twoo': 'my-second-browser' },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('duo-member-twoo');
    expect(text(res)).toContain(MEMBER);
  });

  // A setup sequence normally sits BEHIND a check, so its references have
  // to be rebindable from the outer run - otherwise the only references you can
  // rebind are the ones that needed no rebinding.
  it('accepts a key that only a nested sequence names', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, 'my-second-browser'] });
    await recorder.createSequenceFromCommands('duo-setup', [
      { tool: 'connection', params: { action: 'launch', name: MEMBER } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#member-claim', connectionReason: MEMBER } },
    ]);
    await recorder.createSequenceFromCommands('duo-outer', [
      runsOnPass('duo-setup'),
    ]);
    const sequenceId = recorder.listSequences().find(s => s.name === 'duo-outer')!.id;

    const res = await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { [MEMBER]: 'my-second-browser' },
    });

    expect(res.isError).toBeFalsy();
    // the rebinding reached the nested step, and the nested launch was skipped
    // because the mapped browser is already live
    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toEqual([]);
    // the check that runs duo-setup reads through the check tool, so the one
    // dom call is the nested step's, on the rebound connection
    expect(domConnections(calls)).toEqual(['my-second-browser']);
  });

  it('launches the mapped browser when the session does not have it', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER] });
    await recorder.createSequenceFromCommands('duo-setup', [
      { tool: 'connection', params: { action: 'launch', name: MEMBER } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#member-claim', connectionReason: MEMBER } },
    ]);
    await recorder.createSequenceFromCommands('duo-outer', [
      runsOnPass('duo-setup'),
    ]);
    const sequenceId = recorder.listSequences().find(s => s.name === 'duo-outer')!.id;

    await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { [MEMBER]: 'my-second-browser' },
    });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.name))
      .toEqual(['my-second-browser']);
  });

  it('still rejects a typo when every sub-sequence is resolvable', async () => {
    const { replay, recorder } = makeHarness({ live: [OWNER, 'my-second-browser'] });
    await recorder.createSequenceFromCommands('duo-setup', [
      { tool: 'dom', params: { action: 'querySelector', selector: '#member-claim', connectionReason: MEMBER } },
    ]);
    await recorder.createSequenceFromCommands('duo-outer', [
      runsOnPass('duo-setup'),
    ]);
    const sequenceId = recorder.listSequences().find(s => s.name === 'duo-outer')!.id;

    const res = await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { 'duo-member-twoo': 'my-second-browser' },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain(MEMBER);
  });

  // Mutual recursion between sub-sequences must not hang the validation.
  it('terminates on a cycle of checks running each other', async () => {
    const { replay, recorder } = makeHarness({ live: [OWNER] });
    await recorder.createSequenceFromCommands('ping', [
      runsOnPass('pong'),
    ]);
    await recorder.createSequenceFromCommands('pong', [
      runsOnPass('ping'),
    ]);
    const sequenceId = recorder.listSequences().find(s => s.name === 'ping')!.id;

    const res = await run(replay, {
      sequenceId,
      connectionReason: OWNER,
      connections: { 'nobody-names-this': 'my-second-browser' },
    });

    expect(res.isError).toBe(true);
  });
});

describe('run against an existing single-connection sequence', () => {
  it('is unaffected: every step takes the run-level connection', async () => {
    const { replay, recorder, calls } = makeHarness();
    // a sequence already on disk, from before any of this: no per-step connections
    await recorder.createSequenceFromCommands('legacy-seq', [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
    ]);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, { sequenceId, connectionReason: 'legacy-run-one' });

    expect(domConnections(calls)).toEqual(['legacy-run-one', 'legacy-run-one']);
    // no connection probing for a sequence that names none
    expect(calls.some(c => c.tool === 'connection' && c.params.action === 'list')).toBe(false);
  });

  it('still stamps the run connection onto a launch step', async () => {
    const { replay, recorder, calls } = makeHarness();
    await recorder.createSequenceFromCommands('legacy-launch', [
      { tool: 'connection', params: { action: 'launch', name: 'recorded-ref-one' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    ]);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, { sequenceId, connectionReason: 'legacy-run-one' });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.name))
      .toEqual(['legacy-run-one']);
  });
});

describe('a node-only sequence with per-step connections', () => {
  it('never launches Chrome, mapped or not', async () => {
    const { replay, recorder, calls } = makeHarness({ live: ['node-one-app', 'node-two-app'] });
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '1+1', connectionReason: 'node-one-app' });
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '2+2', connectionReason: 'node-two-app' });
    await replay.handler({ action: 'create', name: 'node-duo', indices: [0, 1] } as any);
    const sequenceId = recorder.listSequences()[0].id;

    await run(replay, { sequenceId, connections: { 'node-two-app': 'node-two-app' } });

    expect(calls.some(c => c.tool === 'connection' && c.params.action === 'launch')).toBe(false);
    expect(calls.filter(c => c.tool === 'inspect' && c.params.action === 'evaluateExpression')
      .map(c => c.params.connectionReason)).toEqual(['node-one-app', 'node-two-app']);
  });
});

// ---------------------------------------------------------------------------
// repeat
// ---------------------------------------------------------------------------

describe('repeat across two connections', () => {
  it('replays each command against the connection it was recorded with', async () => {
    const { replay, recorder, calls } = makeHarness();
    await recordDuo(recorder);

    // No connectionReason: every command already knows its own.
    // PRE-FIX: the recorded connections are gone, so this errors with
    // MISSING_PARAMETER instead of running anything.
    const res = await replay.handler({ action: 'repeat', indices: [0, 1, 2] } as any);

    expect(text(res)).toContain('Repeated 3 commands');
    expect(domConnections(calls)).toEqual([OWNER, MEMBER, OWNER]);
  });

  it('refuses a batch-level connectionReason rather than collapsing it', async () => {
    const { replay, recorder, calls } = makeHarness();
    await recordDuo(recorder);

    const res = await replay.handler({ action: 'repeat', indices: [0, 1, 2], connectionReason: 'other-browser-one' } as any);

    // Running two browsers' commands in one would report success without ever
    // using the second, so there is no honest answer here - say so and run
    // nothing, rather than silently ignoring the parameter (which is what
    // "never overwrite a recorded connection" amounted to).
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('2 different connections');
    expect(calls.length).toBe(0);
  });

  it('honours a batch-level connectionReason when the batch is single-connection', async () => {
    const { replay, recorder, calls } = makeHarness();
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a' });
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: MEMBER });

    await replay.handler({ action: 'repeat', indices: [0, 1], connectionReason: OWNER } as any);

    // This is what the parameter has always meant. Once history started
    // retaining connections, honouring only the bare command turned it into a
    // silent no-op for everything else.
    expect(domConnections(calls)).toEqual([OWNER, OWNER]);
  });
});

// ---------------------------------------------------------------------------
// analysis helpers
// ---------------------------------------------------------------------------

describe('analyzeRecordedStepConnections / normalizeStepConnections', () => {
  it('does not count a bare wait({ms}) as an ambiguous browser step', () => {
    const commands = [
      { tool: 'wait', params: { ms: 100 } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: OWNER } },
    ];
    const normalized = normalizeStepConnections(commands);
    expect(normalized.hoisted).toBe(OWNER);
    expect(normalized.analysis.mixed).toBe(false);
  });

  it('treats a bare wait({selector}) as ambiguous', () => {
    const commands = [
      { tool: 'wait', params: { selector: '#a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: OWNER } },
    ];
    const normalized = normalizeStepConnections(commands);
    expect(normalized.hoisted).toBeUndefined();
    expect(normalized.analysis.mixed).toBe(true);
  });

  it('reports references in first-seen order and never mutates the input', () => {
    const commands = [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: OWNER } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: MEMBER } },
    ];
    const analysis = analyzeRecordedStepConnections(commands);
    expect(analysis.references).toEqual([OWNER, MEMBER]);
    expect(analysis.multiConnection).toBe(true);
    expect(analysis.uniform).toBeUndefined();

    const normalized = normalizeStepConnections(commands);
    expect(normalized.hoisted).toBeUndefined();
    expect(commands[0].params.connectionReason).toBe(OWNER);
  });
});

// ---------------------------------------------------------------------------
// Follow-up: paths the original fix left silently collapsing (adversarial pass)
// ---------------------------------------------------------------------------

const seqOf = (recorder: CommandRecorder, name: string) =>
  recorder.listSequences().find(s => s.name === name)!;

/** Record N steps against one connection and create a (hoisted) sequence. */
async function createSolo(recorder: CommandRecorder, replay: any, name: string, ref: string) {
  await recorder.recordCommand('dom', { action: 'querySelector', selector: '#a', connectionReason: ref });
  await recorder.recordCommand('dom', { action: 'querySelector', selector: '#b', connectionReason: ref });
  await replay.handler({ action: 'create', name, indices: [0, 1] } as any);
}

describe('insert into a hoisted sequence', () => {
  it('re-hoists when the inserted steps came from the same browser', async () => {
    const { replay, recorder } = makeHarness({ live: [OWNER, 'other-browser-one'] });
    await createSolo(recorder, replay, 'solo', OWNER);
    expect(seqOf(recorder, 'solo').recordedConnection).toBe(OWNER);

    await replay.handler({ action: 'run', wait: true, name: 'solo', stepTo: 1 } as any);
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#c', connectionReason: OWNER });
    const idx = recorder.getCurrentHistoryIndex();
    await replay.handler({ action: 'history' } as any);   // insert requires history to be viewed first
    await replay.handler({ action: 'insert', name: 'solo', insertIndices: [idx], overwrite: true } as any);

    // PRE-FIX: the merged array read as "mixed" (one named reference + the
    // sequence's own bare steps), the hoist was skipped, and the sequence was
    // left half-pinned to this session - unportable, and green on a run that
    // split it across two browsers.
    const cmds = seqOf(recorder, 'solo').commands;
    expect(cmds.map(c => c.params.connectionReason)).toEqual([undefined, undefined, undefined]);
    expect(seqOf(recorder, 'solo').recordedConnection).toBe(OWNER);
  });

  it('stays retargetable by a run-level connectionReason afterwards', async () => {
    const { replay, recorder, calls } = makeHarness({ live: [OWNER, 'other-browser-one'] });
    await createSolo(recorder, replay, 'solo', OWNER);

    await replay.handler({ action: 'run', wait: true, name: 'solo', stepTo: 1 } as any);
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#c', connectionReason: OWNER });
    const idx = recorder.getCurrentHistoryIndex();
    await replay.handler({ action: 'history' } as any);   // insert requires history to be viewed first
    await replay.handler({ action: 'insert', name: 'solo', insertIndices: [idx], overwrite: true } as any);

    calls.length = 0;
    await run(replay, { name: 'solo', connectionReason: 'other-browser-one' });

    // PRE-FIX: ['other-browser-one', 'duo-owner-console', 'other-browser-one']
    // - a silent two-browser split, reported as a green run.
    expect(new Set(domConnections(calls))).toEqual(new Set(['other-browser-one']));
  });

  it('keeps a cross-browser insert per-step, and says so', async () => {
    const { replay, recorder } = makeHarness({ live: [OWNER, MEMBER] });
    await createSolo(recorder, replay, 'solo', OWNER);

    await replay.handler({ action: 'run', wait: true, name: 'solo', stepTo: 1 } as any);
    await recorder.recordCommand('dom', { action: 'querySelector', selector: '#c', connectionReason: MEMBER });
    const idx = recorder.getCurrentHistoryIndex();
    await replay.handler({ action: 'history' } as any);
    const res = await replay.handler({ action: 'insert', name: 'solo', insertIndices: [idx], overwrite: true } as any);

    // The sequence genuinely spans two browsers now: every step must be explicit
    // so the executor's existence guard (gated on multiConnection) applies.
    const cmds = seqOf(recorder, 'solo').commands;
    expect(cmds.map(c => c.params.connectionReason).filter(Boolean).length).toBe(cmds.length);
    expect(new Set(cmds.map(c => c.params.connectionReason))).toEqual(new Set([OWNER, MEMBER]));
    expect(seqOf(recorder, 'solo').recordedConnection).toBeUndefined();
    expect(text(res)).toContain('Multi-connection sequence');
  });
});

describe('warnings that were unreachable', () => {
  it('warns about bare steps in a sequence that ALSO spans connections', async () => {
    const { replay, recorder } = makeHarness();
    await recordDuo(recorder);
    // A step recorded without a connectionReason, as recordings made before
    // every call had to name one hold: nothing records which browser it belonged to.
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '1' });

    const res = await replay.handler({ action: 'create', name: 'mixed-duo', indices: [0, 1, 2, 3] } as any);

    // PRE-FIX: formatConnectionNote returned early on multiConnection, so the
    // "some steps name no connection" warning was unreachable in exactly the
    // case where a bare step silently lands in a different browser depending on
    // the run-level connectionReason - green either way.
    expect(text(res)).toContain('Multi-connection sequence');
    expect(text(res)).toContain('Some steps name no connection');
  });
});

describe('connections mapping cannot re-collapse the sequence', () => {
  it('rejects two recorded references rebound onto one browser', async () => {
    const { replay, recorder, calls } = makeHarness({ live: ['solo-browser-here'] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo', indices: [0, 1, 2] } as any);

    calls.length = 0;
    const res = await run(replay, {
      name: 'duo',
      connections: { [OWNER]: 'solo-browser-here', [MEMBER]: 'solo-browser-here' },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('single browser');
    expect(domConnections(calls)).toEqual([]);
  });

  it('still allows rebinding each reference onto its own browser', async () => {
    const { replay, recorder, calls } = makeHarness({ live: ['browser-one-here', 'browser-two-here'] });
    await recordDuo(recorder);
    await replay.handler({ action: 'create', name: 'duo', indices: [0, 1, 2] } as any);

    calls.length = 0;
    await run(replay, {
      name: 'duo',
      connections: { [OWNER]: 'browser-one-here', [MEMBER]: 'browser-two-here' },
    });

    expect(domConnections(calls)).toEqual(['browser-one-here', 'browser-two-here', 'browser-one-here']);
  });
});

describe('generated test code', () => {
  it('gives each recorded browser its own page instead of merging them', async () => {
    const { replay, recorder } = makeHarness();
    // The generators only emit navigate/input steps, so drive the recording with
    // clicks rather than the dom probes the other tests use.
    await recorder.recordCommand('input', { action: 'click', selector: '#owner-btn', connectionReason: OWNER });
    await recorder.recordCommand('input', { action: 'click', selector: '#member-btn', connectionReason: MEMBER });
    await replay.handler({ action: 'create', name: 'duo', indices: [0, 1] } as any);

    const pw = text(await replay.handler({ action: 'get', name: 'duo', outputFormat: 'playwright' } as any));

    // PRE-FIX: every step was emitted against a single `page`, so the exported
    // test collapsed both browsers - the same silent pass, relocated.
    expect(pw).toContain('async ({ browser })');
    expect(pw).toContain('const pageDuoMemberTwo = await (await browser.newContext()).newPage();');
    expect(pw).toContain("await pageDuoMemberTwo.click('#member-btn');");
    expect(pw).toContain("await page.click('#owner-btn');");
    expect(pw).toContain(`drove 2 browsers`);
  });

  // A sequence made of steps the generators have no equivalent for used to
  // export as `test('recorded interaction', async ({ page }) => {});` - a file
  // that passes forever without doing anything it was recorded to do.
  it('refuses to emit a green empty test for steps it cannot generate', async () => {
    const { replay, recorder } = makeHarness();
    await recorder.createSequenceFromCommands('setup-only', [
      runsOnPass('mint-identity'),
      { tool: 'connection', params: { action: 'launch', name: MEMBER } },
    ]);

    for (const format of ['playwright', 'puppeteer'] as const) {
      const code = text(await replay.handler({ action: 'get', name: 'setup-only', outputFormat: format } as any));
      expect(code).toContain('[not generated] check');
      expect(code).toContain('mint-identity');
      expect(code).toContain('[not generated] connection');
      expect(code).toContain('would otherwise pass without doing anything');
    }
  });

  it('does not add the guard when something was generated', async () => {
    const { replay, recorder } = makeHarness();
    await recorder.recordCommand('input', { action: 'click', selector: '#go', connectionReason: OWNER });
    await replay.handler({ action: 'create', name: 'has-steps', indices: [0] } as any);

    const pw = text(await replay.handler({ action: 'get', name: 'has-steps', outputFormat: 'playwright' } as any));
    expect(pw).not.toContain('would otherwise pass without doing anything');
  });

  it('leaves single-connection output on the plain page fixture', async () => {
    const { replay, recorder } = makeHarness();
    await createSolo(recorder, replay, 'solo', OWNER);

    const pw = text(await replay.handler({ action: 'get', name: 'solo', outputFormat: 'playwright' } as any));

    expect(pw).toContain('async ({ page })');
    expect(pw).not.toContain('newContext');
    expect(pw).not.toContain('drove 2 browsers');
  });
});
