import { describe, it, expect, vi } from 'vitest';
import { createSequenceDriver } from './sequence-driver.js';
import { runRegistry } from '../tools/replay-run-registry.js';
import { ToolError } from '../tool-error.js';

/**
 * The `run` a bench issues for the sequence it holds.
 *
 * A sequence carries the connection references it was recorded against. One
 * recorded against a single browser is rebound onto the bench's tab, or the
 * play drives a browser the bench does not show. One spanning two browsers
 * keeps both: rebinding the other browser onto the bench's tab sends that
 * browser's steps - its logins, its cookies - to the wrong page (#105).
 */

function driverHolding(commands: Array<{ tool: string; params: Record<string, any> }>, extra: Record<string, any> = {}) {
  const sequence = { id: 's', name: 'walk', commands, ...extra };
  const runs: Array<Record<string, any>> = [];
  const navigations: Array<Record<string, any>> = [];
  const recorder = {
    getActiveSequence: () => null,
    findMatchingFilename: async () => null,
    getSequence: (id: string) => (id === 's' ? sequence : undefined),
    listSequences: () => [sequence],
    listSavedSequencesOnDisk: async () => [],
  } as any;
  const driver = createSequenceDriver(recorder, async (tool: string, params: Record<string, any>) => {
    if (tool === 'run' && params.action === 'sequence') runs.push(params);
    if (tool === 'navigate' && params.action === 'goto') navigations.push(params);
    return { content: [{ type: 'text', text: 'ok' }] };
  }, () => []);
  return { driver, runs, navigations };
}

describe('the connections a bench play binds', () => {
  it('leaves both browsers of a two-browser sequence bound to themselves, with the bench on one of them', async () => {
    const { driver, runs } = driverHolding([
      { tool: 'input', params: { action: 'click', selector: '#unlock', connection: 'chat-host-admin' } },
      { tool: 'navigate', params: { action: 'goto', url: 'http://localhost:4100/join', connection: 'messaging-person-one' } },
    ]);

    await driver.start('walk', 'messaging-person-one');
    await driver.finish();

    expect(runs).toHaveLength(1);
    expect(runs[0].connections).toBeUndefined();
  });

  it('counts a browser the sequence only declares in requiredConnections', async () => {
    const { driver, runs } = driverHolding(
      [{ tool: 'input', params: { action: 'click', selector: '#open', connection: 'messaging-person-one' } }],
      { requiredConnections: [{ connection: 'chat-host-admin', forceNewInstance: true }] },
    );

    await driver.start('walk', 'messaging-person-one');
    await driver.finish();

    expect(runs[0].connections).toBeUndefined();
  });

  it('launches the one browser a sequence declares rather than driving the bench tab with its cookies', async () => {
    const { driver, runs, navigations } = driverHolding(
      [{ tool: 'input', params: { action: 'type', selector: 'input[name=password]', text: 'x', connection: 'setup-window-admin' } }],
      { startUrl: 'http://localhost:4100/setup', requiredConnections: [{ connection: 'setup-window-admin', forceNewInstance: true }] },
    );

    await driver.start('walk', 'chat-person-one');
    await driver.finish();

    expect(runs[0].connections).toBeUndefined();
    expect(navigations).toEqual([]);
  });

  it('leaves the bench tab where it is for a sequence whose steps run in other browsers', async () => {
    const { driver, navigations } = driverHolding(
      [
        { tool: 'input', params: { action: 'click', selector: '#pair', connection: 'chat-host-admin' } },
        { tool: 'input', params: { action: 'click', selector: '#join', connection: 'chat-person-one' } },
      ],
      { startUrl: 'http://localhost:4100/pair.html' },
    );

    await driver.start('walk', 'chat-person-one');

    expect(navigations).toEqual([]);
  });

  it('rebinds a one-browser sequence recorded elsewhere onto the bench tab', async () => {
    const { driver, runs } = driverHolding([
      { tool: 'input', params: { action: 'click', selector: '#a', connection: 'recorded-tab' } },
      { tool: 'input', params: { action: 'click', selector: '#b', connection: 'recorded-tab' } },
    ]);

    await driver.start('walk', 'bench-tab');
    await driver.finish();

    expect(runs[0].connections).toEqual({ 'recorded-tab': 'bench-tab' });
  });
});

describe('the env file a bench play reads', () => {
  it('carries the env file set on the bench into the run', async () => {
    const { driver, runs } = driverHolding([{ tool: 'input', params: { action: 'click', selector: '#a' } }]);

    await driver.start('walk', 'bench-tab');
    driver.setEnvFile('keel/local.env');
    await driver.finish();

    expect(runs[0].envFile).toBe('keel/local.env');
  });

  it('names no env file once it is cleared, so the run reads .devharness/sequences.env', async () => {
    const { driver, runs } = driverHolding([{ tool: 'input', params: { action: 'click', selector: '#a' } }]);

    await driver.start('walk', 'bench-tab');
    driver.setEnvFile('keel/local.env');
    driver.setEnvFile('');
    await driver.finish();

    expect(runs[0]).not.toHaveProperty('envFile');
  });
});

/**
 * Whose run a bench is reading.
 *
 * `getActiveSequence` is global to the process, so a step-through session left
 * open by another bench - or by a run driven from the tool side - is visible
 * to every bench at once. Read without a check, a bench reports a sequence it
 * never opened, and a `goto` against it drives its own browser through another
 * sequence's steps.
 */

/** A recorder holding two sequences, with one of them mid-run. */
function recorderWith(runningName: string | null) {
  const sequences = [
    { id: 'a', name: 'other-bench-run', commands: [{ tool: 'navigate', params: { url: 'http://localhost:3102/' } }] },
    { id: 'b', name: 'socket-live-lifecycle', commands: [
      { tool: 'navigate', params: { url: 'http://localhost:7788/' } },
      { tool: 'input', params: { action: 'click', selector: 'button' } },
    ] },
  ];
  const running = runningName
    ? { sequenceId: sequences.find(s => s.name === runningName)!.id,
        sequenceName: runningName, currentStep: 1, totalSteps: 1 }
    : null;
  return {
    getActiveSequence: () => running,
    findMatchingFilename: async () => null,
    getSequence: (id: string) => sequences.find(s => s.id === id),
    listSequences: () => sequences,
    listSavedSequencesOnDisk: async () => [],
  } as any;
}

describe('whose run a bench reads', () => {
  it('ignores a run belonging to a sequence it did not open', async () => {
    const recorder = recorderWith('other-bench-run');
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);

    await driver.start('socket-live-lifecycle', 'app');

    // The run in flight is another bench's. This one opened the socket
    // sequence, so that is what it reports - two steps, not the other's one.
    expect(driver.active()?.name).toBe('socket-live-lifecycle');
    expect(driver.active()?.total).toBe(2);
  });

  it('adopts a run already in flight when it has opened nothing', () => {
    // A bench opened beside a run someone else started picks it up, which is
    // how `bench start` lands on a sequence already being stepped.
    const recorder = recorderWith('other-bench-run');
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);

    expect(driver.active()?.name).toBe('other-bench-run');
  });

  it('reads its own run once that sequence is the one in flight', async () => {
    const recorder = recorderWith('socket-live-lifecycle');
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);

    await driver.start('socket-live-lifecycle', 'app');

    expect(driver.active()?.name).toBe('socket-live-lifecycle');
    expect(driver.active()?.currentStep).toBe(1);
  });
});

describe('a run the bench follows', () => {
  function recorderRunning(state: any) {
    const sequence = { id: 'b', name: 'socket-live-lifecycle', commands: [
      { tool: 'navigate', params: { url: 'http://localhost:7788/' } },
      { tool: 'input', params: { action: 'click', selector: 'button' } },
      { tool: 'input', params: { action: 'click', selector: 'button' } },
    ] };
    let running: any = { sequenceId: 'b', sequenceName: sequence.name, totalSteps: 3, ...state };
    return {
      end: () => { running = null; },
      recorder: {
        getActiveSequence: () => running,
        findMatchingFilename: async () => null,
        getSequence: () => sequence,
        listSequences: () => [sequence],
        listSavedSequencesOnDisk: async () => [],
      } as any,
    };
  }

  it('reads where a breakpoint holds the run', () => {
    const { recorder } = recorderRunning({ currentStep: 2, breakpointHit: { url: 'http://localhost:3101/client.js', lineNumber: 180 } });
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);

    expect(driver.active()).toMatchObject({ currentStep: 2, live: true, heldAt: 'http://localhost:3101/client.js:180' });
  });

  it('reads a run finished from the tool side as at its end', async () => {
    const { recorder, end } = recorderRunning({ currentStep: 2, runId: 'run-finished' });
    runRegistry.clear();
    runRegistry.register({ runId: 'run-finished', sequenceName: 'socket-live-lifecycle', status: 'completed', currentStep: 3, totalSteps: 3 } as any);
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);
    await driver.start('socket-live-lifecycle', 'app');
    driver.active();

    end();

    expect(driver.active()).toMatchObject({ currentStep: 3 });
    expect(driver.active()!.live).toBeUndefined();
  });

  it('reads a run that failed from the tool side at the step its record reached', async () => {
    const { recorder, end } = recorderRunning({ currentStep: 1, runId: 'run-failed' });
    runRegistry.clear();
    runRegistry.register({ runId: 'run-failed', sequenceName: 'socket-live-lifecycle', status: 'failed', currentStep: 2, totalSteps: 3 } as any);
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);
    await driver.start('socket-live-lifecycle', 'app');
    driver.active();

    end();

    expect(driver.active()).toMatchObject({ currentStep: 2 });
  });

  it('reads a failed step from the reply, with its whole reason', async () => {
    const { recorder, end } = recorderRunning({ currentStep: 1 });
    runRegistry.clear();
    const reason = 'Could not resolve template token {{env:KEEL_PASSWORD}}: KEEL_PASSWORD is not set: no envFile was read and the server\'s environment lacks it - add KEEL_PASSWORD=<value> to .devharness/sequences.env';
    const driver = createSequenceDriver(recorder, async (_tool: string, args: any) => {
      if (args.action !== 'step') return { content: [{ type: 'text', text: 'ok' }] };
      end();
      throw new ToolError({ isError: true, content: [{ type: 'text', text: `socket-live-lifecycle failed at step 3 of 3 · 2 passed\n\nStep 3: ${reason}` }] });
    }, () => []);
    await driver.start('socket-live-lifecycle', 'app');

    const failure = await driver.step();

    expect(failure).toBe(reason);
    expect(driver.active()).toMatchObject({ currentStep: 2, failedStep: 2 });
  });
});

/**
 * A note moved between steps is lifted whole and put down in one write.
 * Detaching and attaching as two saves leaves the note in no step at all
 * when the second save fails.
 */

function recorderHolding() {
  const sequence = {
    id: 'notes', name: 'noted', commands: [
      { tool: 'navigate', params: { url: 'http://localhost:7788/' },
        annotations: [{ id: 'n1', comment: 'the banner', screenshot: 'shots/n1.png', after: 'GET /' }] },
      { tool: 'input', params: { action: 'click', selector: 'button' } },
    ],
  } as any;
  // Refused, so the test writes nothing and the save it counts is the only one.
  const saveSequenceToDisk = vi.fn(async () => ({ success: false, error: 'disk refused the write' }));
  const recorder = {
    getActiveSequence: () => ({ sequenceId: 'notes', sequenceName: 'noted', currentStep: 0, totalSteps: 2 }),
    findMatchingFilename: async () => null,
    getSequence: () => sequence,
    listSequences: () => [sequence],
    listSavedSequencesOnDisk: async () => [],
    saveSequenceToDisk,
  } as any;
  return { recorder, sequence, saveSequenceToDisk };
}

describe('moving a note to another step', () => {
  it('carries the note and its capture whole, in one save', async () => {
    const { recorder, sequence, saveSequenceToDisk } = recorderHolding();
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }), () => []);

    const failure = await driver.moveAnnotation('n1', 1);

    expect(failure).toBe('disk refused the write');
    expect(saveSequenceToDisk).toHaveBeenCalledTimes(1);
    expect(sequence.commands[0].annotations).toBeUndefined();
    expect(sequence.commands[1].annotations).toEqual([{ id: 'n1', comment: 'the banner', screenshot: 'shots/n1.png' }]);
  });
});
