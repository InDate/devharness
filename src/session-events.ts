/**
 * One event stream per session.
 *
 * Every push event devharness produces - a guard block, an incoming message,
 * an annotation picked in the browser -
 * appends one JSON line to `~/.devharness/events/<session>.jsonl`. One file
 * means one watch: a session arms a single Monitor and receives every kind of
 * event, including kinds added later, instead of one watch per feature.
 *
 * The plugin's SessionStart hook names this path to each session as it starts,
 * which is what gets the watch armed. A session with no watch receives
 * nothing mid-task, so streamReaders counts the processes holding the file
 * open, and a response that depends on the watch prints the Monitor call when
 * that count is zero.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';

export type EventKind = 'block' | 'message' | 'annotation' | 'sequence' | 'screenshot' | 'investigate' | 'proxy';

export interface SessionEvent {
  ts: string;
  kind: EventKind;
  [key: string]: unknown;
}

export function getEventsDir(): string {
  return getOutputPath('events', { global: true });
}

export function getEventStreamPath(sessionName: string): string {
  return join(getEventsDir(), `${sessionName}.jsonl`);
}

/**
 * The number of processes holding the stream open, read with lsof.
 *
 * A Monitor's `tail -f` holds the file open for as long as the watch lives,
 * and appendEvent opens and closes it per line, so a count above zero is a
 * live watch. Returns undefined where lsof is absent or fails, which leaves
 * the caller with no reading rather than a false zero.
 */
export function streamReaders(sessionName: string): Promise<number | undefined> {
  return new Promise(resolve => {
    execFile('lsof', ['-t', getEventStreamPath(sessionName)], { timeout: 2000 }, (error, stdout) => {
      const pids = stdout.split('\n').filter(Boolean).length;
      if (pids > 0) return resolve(pids);
      // lsof exits 1 both for a file nobody holds and for a file that does not
      // exist; either way no watch is reading it.
      if (error && (error as { code?: unknown }).code === 1) return resolve(0);
      resolve(error ? undefined : 0);
    });
  });
}

/**
 * Append one event. Failures are logged and swallowed: the stream is a
 * notification path, and losing a line must not fail the operation that
 * produced it.
 */
export async function appendEvent(
  sessionName: string,
  kind: EventKind,
  payload: Record<string, unknown>
): Promise<void> {
  const event: SessionEvent = { ts: new Date().toISOString(), kind, ...payload };
  try {
    await fs.mkdir(getEventsDir(), { recursive: true });
    await fs.appendFile(getEventStreamPath(sessionName), JSON.stringify(event) + '\n');
  } catch (error) {
    console.error(`[devharness] Failed to append ${kind} event: ${error}`);
  }
}
