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
import { createSequenceDriver } from './bench-tools.js';

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
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

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
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    expect(driver.active()?.name).toBe('other-bench-run');
  });

  it('reads its own run once that sequence is the one in flight', async () => {
    const recorder = recorderWith('socket-live-lifecycle');
    const driver = createSequenceDriver(recorder, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    await driver.start('socket-live-lifecycle', 'app');

    expect(driver.active()?.name).toBe('socket-live-lifecycle');
    expect(driver.active()?.currentStep).toBe(1);
  });
});
