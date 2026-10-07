// @vitest-environment node
/**
 * An insert during a paused run requires history viewed since the agent's last
 * call. The dispatcher records a call before its handler runs, so the insert
 * call itself is recorded between the history view and the check.
 */
import { describe, it, expect } from 'vitest';
import { CommandRecorder } from './command-recorder.js';

function pausedRecorder(): CommandRecorder {
  const recorder = new CommandRecorder();
  recorder.setActiveSequence({
    sequenceId: 'seq-paused', sequenceName: 'paused', connection: 'app',
    currentStep: 1, totalSteps: 2, pausedAt: Date.now(), historyIndexAtPause: -1,
  });
  recorder.markHistoryViewed();
  return recorder;
}

describe('history viewed while paused', () => {
  it('stands through the recording of the insert call that checks it', async () => {
    const recorder = pausedRecorder();

    await recorder.recordCommand('replay', { action: 'insert', insertIndices: [0] });

    expect(recorder.wasHistoryViewed()).toBe(true);
  });

  it('is cleared by a call to another tool, whose index the view did not list', async () => {
    const recorder = pausedRecorder();

    await recorder.recordCommand('inspect', { action: 'evaluateExpression', connection: 'app', expression: '1' });

    expect(recorder.wasHistoryViewed()).toBe(false);
  });
});
