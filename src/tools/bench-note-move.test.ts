/**
 * A note moved between steps is lifted whole and put down in one write.
 * Detaching and attaching as two saves leaves the note in no step at all
 * when the second save fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSequenceDriver } from '../bench-mode/sequence-driver.js';

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
