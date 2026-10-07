/**
 * Whose run a bench is reading.
 *
 * `getActiveSequence` is global to the process, so a step-through session left
 * open by another bench - or by a run driven from the tool side - is visible
 * to every bench at once. Read without a check, a bench reports a sequence it
 * never opened, and a `goto` against it drives its own browser through another
 * sequence's steps.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSequenceDriver } from '../bench-mode/sequence-driver.js';
import { runRegistry } from './replay-run-registry.js';
import { ToolError } from '../tool-error.js';

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
