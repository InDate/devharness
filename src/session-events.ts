/**
 * One event stream per session.
 *
 * Every push event devharness produces - a guard block, an incoming message,
 * an annotation picked in the browser -
 * appends one JSON line to `~/.devharness/events/<session>.jsonl`. One file
 * means one watch: a session arms a single watch and receives every kind of
 * event, including kinds added later, instead of one watch per feature.
 *
 * The plugin's SessionStart hook names this path to each session as it starts,
 * which is what gets the watch armed. A session with no watch receives
 * nothing mid-task, so streamReaders counts the processes holding the file
 * open, and a response that depends on the watch prints watchCall when that
 * count is zero.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getOutputPath } from './helpers/paths.js';

export type EventKind = 'block' | 'message' | 'annotation' | 'sequence' | 'screenshot' | 'comparison' | 'investigate' | 'proxy';

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

/** How far `devharness watch` has read the stream, shared by its one-off and --follow forms. */
export function getEventCursorPath(sessionName: string): string {
  return join(getEventsDir(), `${sessionName}.cursor`);
}

/** This package's CLI entry, which a session reaches without `devharness` on PATH. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'mcp-supervisor.js');

/** The call that arms a one-off watch on the stream; its output holds the next one. */
export function watchCall(sessionName: string): string {
  return `Bash({ command: "node ${CLI_ENTRY} watch --session=${sessionName}", run_in_background: true, description: "devharness events" })`;
}

/**
 * The number of processes holding the stream open, read with lsof.
 *
 * `devharness watch`, plain or under a Monitor, holds the file open for as long as it runs,
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
 * Who caused what is being done: the agent, through a tool call or a bench
 * request it marks as its own, or a person, through the bench. Carried on each
 * event, so a watch can leave out the agent's echo of its own changes.
 */
const origin = new AsyncLocalStorage<{ by: 'agent' | 'person'; live: boolean }>();

/**
 * Run `work` as `by`. The mark holds only while the work runs: a listener it
 * sets up that fires later - a launch's page events, a bench's picks - carries
 * the context it was made in, and an event from it then is no longer the
 * call's doing.
 */
export async function runAs<T>(by: 'agent' | 'person', work: () => Promise<T>): Promise<T> {
  const context = { by, live: true };
  try {
    return await origin.run(context, work);
  } finally {
    context.live = false;
  }
}

/** Who is running the current work, for an event announced after that work has returned. */
export function currentOrigin(): 'agent' | 'person' | undefined {
  const context = origin.getStore();
  return context?.live ? context.by : undefined;
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
  const context = origin.getStore();
  const by = context?.live ? context.by : undefined;
  const event: SessionEvent = { ts: new Date().toISOString(), kind, ...payload, ...(by ? { by } : {}) };
  try {
    await fs.mkdir(getEventsDir(), { recursive: true });
    await fs.appendFile(getEventStreamPath(sessionName), JSON.stringify(event) + '\n');
  } catch (error) {
    console.error(`[devharness] Failed to append ${kind} event: ${error}`);
  }
}
