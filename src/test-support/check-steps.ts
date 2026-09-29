import type { RecordedCommand } from '../command-recorder.js';

/**
 * A check step that runs `sequence` when it holds and carries on when it
 * fails: the step a test nests one sequence inside another with. It reads
 * nothing but time, so its answer comes from the fake tool layer alone.
 */
export function runsOnPass(sequence: string): RecordedCommand {
  return { tool: 'check', params: { afterMs: 0, holds: { run: sequence }, fails: 'continue' } };
}

/**
 * The check tool's answer when it holds, as the executor reads it off
 * `_meta`. A fake that leaves a `check` call unanswered returns no outcome,
 * which reads as failed and stops the run on the default `fails: 'stop'`.
 */
export const HELD = {
  content: [{ type: 'text', text: 'held: 0ms passed' }],
  _meta: { check: { outcome: 'held', subject: '0ms passed', elapsedMs: 0, polls: 1 } },
};

/** The same answer when it fails. */
export const FAILED = {
  content: [{ type: 'text', text: 'failed: 0ms passed' }],
  _meta: { check: { outcome: 'failed', subject: '0ms passed', elapsedMs: 0, polls: 1 } },
};
