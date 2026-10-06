/**
 * What each history entry caused, indexed as it is stamped.
 *
 * The proxy stamps every crossing and the write watch every storage write with
 * the call in flight. Reading "what did entry 12 cause" by filtering those
 * buffers costs a scan per read; this keeps, per history entry, the list of
 * what was stamped to it, appended at the moment of stamping. An entry's
 * activity is one map lookup, and an activity's entry is the stamp it carries.
 *
 * Network traffic arrives only from a browser launched through the proxy;
 * storage writes, cookies, IndexedDB, Cache Storage, files and workers arrive
 * from the write watch whenever the bench is open on the connection.
 */
import { entryOf, stampedEvents, type ProxyEvent } from './proxy/intercept-proxy.js';
import { stampedWrites, type PageWrite } from './write-watch.js';

/** As many entries as history keeps, oldest dropped first. */
const ENTRIES_KEPT = 1000;

type Item = { source: 'proxy'; event: ProxyEvent } | { source: 'write'; write: PageWrite };

const byEntry = new Map<number, Item[]>();

function add(entry: number | undefined, item: Item): void {
  if (entry === undefined) return;
  const items = byEntry.get(entry);
  if (items) { items.push(item); return; }
  byEntry.set(entry, [item]);
  if (byEntry.size > ENTRIES_KEPT) byEntry.delete(byEntry.keys().next().value!);
}

function entryOfWrite(write: PageWrite): number | undefined {
  const cursor = write.cursor;
  return cursor?.kind === 'command' ? cursor.index : cursor?.kind === 'replay' ? cursor.entry : undefined;
}

/**
 * The entry whose call opened each stream or socket, by URL. A message the
 * server pushes later arrives under no call and is stamped to none, which is
 * right for comparing a step's traffic; History lists it under the call that
 * opened what it arrived on, so a stream's count rises on that call's row.
 */
const openedBy = new Map<string, { entry: number; opener: ProxyEvent }>();

/** Each message credited through `openedBy`, by event id, so Traffic lists the same opener History counts. */
const openerOfMessage = new Map<string, number>();
const MESSAGES_KEPT = 20000;

stampedEvents.add(event => {
  const entry = entryOf(event);
  if (event.kind === 'request' && (event.open || event.status === 101) && entry !== undefined) openedBy.set(event.url, { entry, opener: event });
  if (entry === undefined && event.kind === 'frame' && event.direction === 'in') {
    // Only while what opened it is open: a stream the page closed and opened
    // again under a call nobody claimed must not feed the old call's row.
    const opened = openedBy.get(event.url);
    const opener = opened && (opened.opener.open || opened.opener.status === 101) ? opened.entry : undefined;
    if (opener !== undefined) {
      openerOfMessage.set(event.id, opener);
      if (openerOfMessage.size > MESSAGES_KEPT) openerOfMessage.delete(openerOfMessage.keys().next().value!);
    }
    add(opener, { source: 'proxy', event });
    return;
  }
  add(entry, { source: 'proxy', event });
});
stampedWrites.add(write => add(entryOfWrite(write), { source: 'write', write }));

/** The entry whose call opened the stream a message arrived on, where History credits it there. */
export function openerEntryOf(id: string): number | undefined {
  return openerOfMessage.get(id);
}

/** One line per item: `POST /prefs 200`, `← frame /live`, `localStorage socket-app:draft set`. */
export interface ActivityLine {
  /** The proxy event or the write, as the Traffic tab keys its row. */
  id: string;
  kind: 'request' | 'frame' | 'write';
  line: string;
  at: number;
  failed?: boolean;
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function lineOf(item: Item): ActivityLine {
  if (item.source === 'write') {
    const write = item.write;
    return { id: write.id, kind: 'write', at: write.at, line: `${write.store} ${write.key ?? ''} ${write.operation}`.replace(/\s+/g, ' ').trim() };
  }
  const event = item.event;
  if (event.kind === 'request') {
    const failed = event.status === 0 || (event.status ?? 0) >= 400;
    return {
      id: event.id, kind: 'request', at: event.at, ...(failed ? { failed } : {}),
      line: `${event.method ?? 'GET'} ${event.answeredAs === 'outOfScope' ? `${event.url} out of scope` : `${pathOf(event.url)} ${event.status ?? 'pending'}`}`,
    };
  }
  return { id: event.id, kind: 'frame', at: event.at, line: `${event.direction === 'out' ? '→' : '←'} frame ${pathOf(event.url)}` };
}

/** What one history entry caused, oldest first; empty where nothing was stamped to it. */
export function activityOf(entry: number): ActivityLine[] {
  return (byEntry.get(entry) ?? []).map(lineOf);
}

/** The crossings stamped to an entry, as the proxy recorded them. */
export function eventsOf(entry: number): ProxyEvent[] {
  return (byEntry.get(entry) ?? []).flatMap(item => (item.source === 'proxy' ? [item.event] : []));
}

/** Counts by kind, and the failures among the requests. */
export interface ActivityCounts { requests: number; failed: number; frames: number; writes: number }

export function countsOf(lines: ActivityLine[]): ActivityCounts {
  return {
    requests: lines.filter(l => l.kind === 'request').length,
    failed: lines.filter(l => l.failed).length,
    frames: lines.filter(l => l.kind === 'frame').length,
    writes: lines.filter(l => l.kind === 'write').length,
  };
}

/**
 * The reply's line for an entry's activity: counts, and the one item that
 * stands out - the first failed request, or the lone item of its kind -
 * never the whole list. Undefined where nothing was stamped.
 */
export function activitySummary(entry: number): string | undefined {
  const lines = activityOf(entry);
  if (lines.length === 0) return undefined;
  const counts = countsOf(lines);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const named = (kind: ActivityLine['kind']) => {
    const ofKind = lines.filter(l => l.kind === kind);
    return ofKind.length === 1 ? ` (${ofKind[0].line})` : '';
  };
  const failure = lines.find(l => l.failed);
  const parts = [
    counts.requests ? `${plural(counts.requests, 'request')}${failure ? ` (${counts.failed} failed: ${failure.line})` : named('request')}` : '',
    counts.frames ? `${plural(counts.frames, 'frame')}${named('frame')}` : '',
    counts.writes ? `${plural(counts.writes, 'write')}${named('write')}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}
