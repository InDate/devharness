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
import { resolveRestartStableSessionName } from './session-identity.js';
import { sendPeerMessage, sessionByIdPrefix } from './peer-socket.js';

export type EventKind = 'block' | 'annotation' | 'pick' | 'sequence' | 'screenshot' | 'comparison' | 'investigate' | 'proxy' | 'hold' | 'instruction' | 'run' | 'film' | 'notify';

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

/** The pid of the plain or --follow watch that last started on the stream from one Claude process. */
export function getEventWatchPath(sessionName: string, clientPid: number): string {
  return join(getEventsDir(), `${sessionName}.${clientPid}.watch`);
}

/** This package's CLI entry, which a session reaches without `devharness` on PATH. */
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'mcp-supervisor.js');

/** The call that arms a one-off watch on the stream; its output holds the next one. */
export function watchCall(sessionName: string): string {
  return `Bash({ command: "node ${CLI_ENTRY} watch --session=${sessionName}", run_in_background: true, description: "devharness events" })`;
}

/**
 * The events written past the point a watch has read to, or undefined before
 * any watch has run, since a first watch starts at the end of the stream.
 */
export async function unreadEvents(sessionName: string): Promise<number | undefined> {
  const stored = (await fs.readFile(getEventCursorPath(sessionName), 'utf8').catch(() => '')).trim();
  const cursor = Number(stored);
  if (!stored || !Number.isInteger(cursor) || cursor < 0) return undefined;
  const stream = await fs.readFile(getEventStreamPath(sessionName)).catch(() => undefined);
  if (!stream || cursor >= stream.length) return 0;
  return stream.subarray(cursor).toString('utf8').split('\n').filter(Boolean).length;
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
    return;
  }
  scheduleDelivery(sessionName);
}

/** A burst ends at this much quiet, so its lines arrive as one message; the same bounds `devharness watch` reads by. */
const SETTLE_MS = 1000;
/** A stream that never goes quiet still delivers within this. */
const BURST_CAP_MS = 5000;
/** A delivery lock older than this belongs to a process that died holding it. */
const STALE_LOCK_MS = 30000;

const bursts = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();

function scheduleDelivery(sessionName: string): void {
  const burst = bursts.get(sessionName);
  const firstAt = burst?.firstAt ?? Date.now();
  if (burst) clearTimeout(burst.timer);
  const wait = Math.max(0, Math.min(SETTLE_MS, firstAt + BURST_CAP_MS - Date.now()));
  const timer = setTimeout(() => {
    bursts.delete(sessionName);
    void deliverStream(sessionName);
  }, wait);
  timer.unref();
  bursts.set(sessionName, { timer, firstAt });
}

/**
 * The socket the session reading `sessionName` takes peer messages on: this
 * process's own client where the stream is its own, else the registry entry
 * whose session id opens with the stream name.
 */
export function socketFor(sessionName: string): string | undefined {
  const own = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (own && resolveRestartStableSessionName() === sessionName) return own;
  return sessionByIdPrefix(sessionName)?.socketPath;
}

/**
 * Sends the lines past the stream's cursor to its session's messaging socket
 * and moves the cursor past them, so a watch or a later delivery starts after
 * them. A lock directory beside the stream holds one delivery at a time across
 * processes, since two would each send the same lines. A stream with no socket,
 * or a send that fails, leaves the cursor where it stood and the lines for
 * `devharness watch`.
 */
export async function deliverStream(sessionName: string): Promise<void> {
  const socketPath = socketFor(sessionName);
  if (!socketPath) return;
  const streamPath = getEventStreamPath(sessionName);
  const cursorPath = getEventCursorPath(sessionName);
  const lock = `${streamPath}.delivering`;
  try {
    await fs.mkdir(lock);
  } catch {
    const held = await fs.stat(lock).catch(() => undefined);
    if (!held || Date.now() - held.mtimeMs < STALE_LOCK_MS) return;
    await fs.rm(lock, { recursive: true, force: true });
    try { await fs.mkdir(lock); } catch { return; }
  }
  try {
    const stream = await fs.readFile(streamPath);
    const stored = Number((await fs.readFile(cursorPath, 'utf8').catch(() => '')).trim());
    const from = Number.isInteger(stored) && stored >= 0 && stored <= stream.length ? stored : 0;
    const end = stream.lastIndexOf(0x0a) + 1;
    if (end <= from) return;
    const lines = stream.subarray(from, end).toString('utf8');
    await sendPeerMessage(socketPath, `devharness events (${streamPath}):\n${lines}`);
    await fs.writeFile(cursorPath, String(end));
  } catch (error) {
    console.error(`[devharness] Event delivery to ${sessionName} failed: ${error}`);
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
