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
 * which is what gets the watch armed. Nothing here verifies that a watch
 * exists: a session with none simply receives nothing, the same as before the
 * stream existed.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';

export type EventKind = 'block' | 'message' | 'annotation' | 'sequence' | 'screenshot';

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
