/**
 * Announce a sequence reaching disk. Called from the tool boundary: the
 * recorder is driven directly by hundreds of tests, whose temp-directory
 * writes would otherwise bury the saves a person made.
 */

import { appendEvent } from './session-events.js';
import { resolveSessionName } from './session-identity.js';
import type { RecordedCommand } from './command-recorder.js';

export async function announceSequenceSaved(
  sequence: { name: string; commands?: RecordedCommand[] },
  filepath: string
): Promise<void> {
  const steps = sequence.commands?.length ?? 0;
  const notes = (sequence.commands ?? []).reduce((n, command) => n + (command.annotations?.length ?? 0), 0);
  await appendEvent(resolveSessionName(), 'sequence', {
    sequence: sequence.name,
    path: filepath,
    steps,
    annotations: notes,
    detail: `sequence "${sequence.name}" saved - ${steps} step(s), ${notes} note(s)`,
  });
}
