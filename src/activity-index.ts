/**
 * What each history entry caused, read from the observation log.
 *
 * The proxy and the write watch hand each record to the log as they stamp it
 * with the call in flight. A step's traffic is what was stamped to it, with
 * the frames pushed on the streams its call opened; what the log places
 * after an action by time alone stays out, since a comparison of two runs
 * counts only what each step caused.
 *
 * Network traffic arrives only from a browser launched through the proxy;
 * storage writes, cookies, IndexedDB, Cache Storage, files and workers arrive
 * from the write watch whenever the bench is open on the connection.
 */
import type { ProxyEvent } from './proxy/intercept-proxy.js';
import type { PageWrite } from './write-watch.js';
import { foreignTo, observation, recordOf, stampedOf } from './observation-log.js';

/** A record, and the connection it came from where that is not the reading call's. */
type Item = ({ source: 'proxy'; event: ProxyEvent } | { source: 'write'; write: PageWrite }) & { on?: string };

function itemsOf(entry: number, reading?: string): Item[] {
  return stampedOf(entry).flatMap((one): Item[] => {
    const held = recordOf(one);
    if (!held) return [];
    const on = foreignTo(one, reading);
    const marked = on ? { on } : {};
    return one.ref.source === 'proxy' ? [{ source: 'proxy', event: held as ProxyEvent, ...marked }] : [{ source: 'write', write: held as PageWrite, ...marked }];
  });
}

/** The entry whose call opened the stream a message arrived on, where History credits it there. */
export function openerEntryOf(id: string): number | undefined {
  return observation(id)?.opener;
}

/** One line per item: `POST /prefs 200`, `← frame /live`, `localStorage socket-app:draft set`. */
export interface ActivityLine {
  /** The proxy event or the write, as the Traffic tab keys its row. */
  id: string;
  kind: 'request' | 'frame' | 'write';
  line: string;
  at: number;
  failed?: boolean;
  /** The connection that made it, where that is not the reading call's: a step in one browser causing traffic in another. */
  on?: string;
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function lineOf(item: Item): ActivityLine {
  const line = lineOfRecord(item);
  return item.on ? { ...line, on: item.on } : line;
}

function lineOfRecord(item: Item): ActivityLine {
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

/**
 * What one history entry caused, oldest first; empty where nothing was stamped
 * to it. With the reading call's connection, each line another browser made
 * carries that browser's connection.
 */
export function activityOf(entry: number, reading?: string): ActivityLine[] {
  return itemsOf(entry, reading).map(lineOf);
}

/** The crossings stamped to an entry, as the proxy recorded them. */
export function eventsOf(entry: number): ProxyEvent[] {
  return itemsOf(entry).flatMap(item => (item.source === 'proxy' ? [item.event] : []));
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
export function activitySummary(entry: number, reading?: string): string | undefined {
  const lines = activityOf(entry, reading);
  if (lines.length === 0) return undefined;
  const groups = new Map<string, ActivityLine[]>();
  for (const line of lines) groups.set(line.on ?? '', [...(groups.get(line.on ?? '') ?? []), line]);
  const home = groups.get('') ?? [];
  return [['', home] as const, ...[...groups].filter(([on]) => on !== '')]
    .map(([on, group]) => summaryOfLines(group, on))
    .filter(Boolean)
    .join(', ');
}

/** One connection's lines as the summary reads them; `on` names a connection other than the reading call's. */
function summaryOfLines(lines: ActivityLine[], on: string): string {
  const counts = countsOf(lines);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}${on ? ` on ${on}` : ''}`;
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
