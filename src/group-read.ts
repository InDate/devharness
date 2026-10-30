/**
 * One reading of what a group's browsers did over a window, per browser: the
 * headline every group read opens with. A group read lists rows only when
 * narrowed, so the headline carries what picks the browser to look at -
 * failures, console errors, and traffic one browser's call caused on another.
 *
 * Each browser takes a number by its place in the group, and listed rows
 * carry that number in place of the three-word name.
 *
 * A read starts where the same tool's last read of the group ended, so a
 * session watching a group across steps receives each event once; `full`
 * starts at the group's creation, and `since` at a given time.
 */

import { groupCreatedAt, membersOf } from './groups.js';
import { observationsIn, type Observation } from './observation-log.js';
import type { HistoryCommand } from './command-recorder.js';

export interface GroupSources {
  history(): HistoryCommand[];
  isOpen(connection: string): boolean;
  hasProxy(connection: string): boolean;
  /** Console errors at or after `since`, epoch ms each. */
  consoleErrors(connection: string, since: number): number[];
  /** Requests a browser outside any proxy started at or after `since`. */
  networkRequests(connection: string, since: number): Array<{ at: number; failed: boolean }>;
}

let sources: GroupSources | undefined;

export function setGroupSources(next: GroupSources): void {
  sources = next;
}

export interface BrowserTally {
  tag: number;
  connection: string;
  open: boolean;
  calls: number;
  failedCalls: number;
  requests: number;
  failedRequests: number;
  frames: number;
  writes: number;
  consoleErrors: number;
  last?: number;
}

export interface GroupReading {
  group: string;
  /** Where the headline's window starts. */
  since: number;
  /** Where the rows' window starts: this tool's previous read of the group. */
  rowsSince: number;
  /** The headline's window starts at the group's previous read, by any tool. */
  fromLastRead: boolean;
  browsers: BrowserTally[];
  /** Observations on `to` stamped to a call made on `from`. */
  across: Array<{ from: number; to: number; count: number }>;
  calls: HistoryCommand[];
  observations: Observation[];
}

/**
 * Two ledgers. The headline's is the group's: any tool's read moves it, so a
 * session holds each stretch of the headline once whichever tool it reads
 * through. The rows' is the tool's own, keyed `<tool> <group>`: a proxy read
 * after a history read still lists the events that history's headline counted.
 */
const headlineRead = new Map<string, number>();
const rowsRead = new Map<string, number>();

const connectionOf = (cmd: HistoryCommand): string | undefined =>
  typeof cmd.params?.connection === 'string' ? cmd.params.connection : undefined;

export const callFailed = (cmd: HistoryCommand): boolean => cmd.result?.isError === true || (cmd as { stepFailed?: boolean }).stepFailed === true;

export function readGroup(group: string, tool: string, window: { since?: number; full?: boolean } = {}): GroupReading {
  if (!sources) throw new Error('group sources are not set');
  const now = Date.now();
  const created = groupCreatedAt(group) ?? 0;
  const start = (previous: number | undefined) => window.since ?? (window.full || previous === undefined ? created : previous);
  const headlinePrevious = headlineRead.get(group);
  const since = start(headlinePrevious);
  const rowsSince = start(rowsRead.get(`${tool} ${group}`));
  headlineRead.set(group, now);
  rowsRead.set(`${tool} ${group}`, now);

  const members = membersOf(group);
  const tags = new Map(members.map((member, i) => [member, i + 1]));
  const history = sources.history();
  const byIndex = new Map(history.map(cmd => [cmd.index, cmd]));
  const callsFrom = (from: number) => history
    .filter(cmd => cmd.timestamp >= from && tags.has(connectionOf(cmd) ?? ''))
    .sort((a, b) => a.index - b.index);
  const observedFrom = (from: number) => observationsIn(from, now + 1).filter(one => tags.has(one.connection ?? ''));
  const headCalls = callsFrom(since);
  const headObserved = observedFrom(since);

  const browsers: BrowserTally[] = members.map(connection => {
    const own = headObserved.filter(one => one.connection === connection);
    const ownCalls = headCalls.filter(cmd => connectionOf(cmd) === connection);
    const unproxied = sources!.hasProxy(connection) ? [] : sources!.networkRequests(connection, since);
    const requests = own.filter(one => one.kind === 'request');
    const errors = sources!.consoleErrors(connection, since);
    const times = [...own.map(one => one.at), ...ownCalls.map(cmd => cmd.timestamp), ...unproxied.map(r => r.at), ...errors];
    return {
      tag: tags.get(connection)!,
      connection,
      open: sources!.isOpen(connection),
      calls: ownCalls.length,
      failedCalls: ownCalls.filter(callFailed).length,
      requests: requests.length + unproxied.length,
      failedRequests: requests.filter(one => one.failed).length + unproxied.filter(r => r.failed).length,
      frames: own.filter(one => one.kind === 'frame').length,
      writes: own.filter(one => one.kind === 'storage' || one.kind === 'motion').length,
      consoleErrors: errors.length,
      ...(times.length ? { last: Math.max(...times) } : {}),
    };
  });

  const crossings = new Map<string, number>();
  for (const one of headObserved) {
    const caller = one.entry !== undefined ? connectionOf(byIndex.get(one.entry) ?? ({} as HistoryCommand)) : undefined;
    if (caller === undefined || caller === one.connection || !tags.has(caller)) continue;
    const pair = `${tags.get(caller)} ${tags.get(one.connection!)}`;
    crossings.set(pair, (crossings.get(pair) ?? 0) + 1);
  }
  const across = [...crossings].map(([pair, count]) => {
    const [from, to] = pair.split(' ').map(Number);
    return { from, to, count };
  });

  return {
    group, since, rowsSince,
    fromLastRead: window.since === undefined && !window.full && headlinePrevious !== undefined,
    browsers, across,
    calls: callsFrom(rowsSince), observations: observedFrom(rowsSince),
  };
}

/** The connection the call at history `index` named. */
export function callConnection(index: number): string | undefined {
  const cmd = sources?.history().find(one => one.index === index);
  return cmd ? connectionOf(cmd) : undefined;
}

export const clock = (at: number): string => new Date(at).toISOString().slice(11, 19);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The headline: one line per browser, then the traffic one browser's calls caused on another. */
export function formatHeadline(reading: GroupReading): string {
  if (reading.browsers.every(b => b.last === undefined)) {
    return `group ${reading.group} · ${plural(reading.browsers.length, 'browser')} · nothing since ${clock(reading.since)}${reading.fromLastRead ? ' (the last read)' : ''}`;
  }
  const width = Math.max(...reading.browsers.map(b => b.connection.length), 0);
  const lines = [
    `group ${reading.group} · ${plural(reading.browsers.length, 'browser')} · since ${clock(reading.since)}${reading.fromLastRead ? ' (the last read)' : ''}`,
    ...reading.browsers.map(b => {
      const parts = [
        b.open ? '' : 'closed',
        b.calls ? `${plural(b.calls, 'call')}${b.failedCalls ? ` (${b.failedCalls} failed)` : ''}` : '',
        b.requests ? `${plural(b.requests, 'request')}${b.failedRequests ? ` (${b.failedRequests} failed)` : ''}` : '',
        b.frames ? plural(b.frames, 'frame') : '',
        b.writes ? plural(b.writes, 'write') : '',
        b.consoleErrors ? plural(b.consoleErrors, 'console error') : '',
        b.last !== undefined ? `last ${clock(b.last)}` : 'nothing since',
      ].filter(Boolean);
      return ` ${b.tag} ${b.connection.padEnd(width)}  ${parts.join(' · ')}`;
    }),
    ...(reading.across.length
      ? [` across browsers: ${reading.across.map(a => `${a.count} on ${a.to} credited to calls on ${a.from}`).join('; ')}`]
      : []),
  ];
  return lines.join('\n');
}

/** The headline as `_meta` carries it. */
export function headlineMeta(reading: GroupReading) {
  return { group: reading.group, since: reading.since, rowsSince: reading.rowsSince, fromLastRead: reading.fromLastRead, browsers: reading.browsers, across: reading.across };
}

/** A narrowed read's reply: the headline where it carries something the session has not seen, then the rows. */
export function withHeadline(reading: GroupReading, body: string): string {
  const quiet = reading.fromLastRead && reading.browsers.every(b => b.last === undefined);
  return quiet ? body : `${formatHeadline(reading)}\n\n${body}`;
}

/** Rows from the group's browsers merged in time order, newest `limit` kept, each led by its browser's number, under the headline. */
export function mergedRows<T extends { at: number; connection: string; line: string }>(reading: GroupReading, rows: T[], limit: number): { text: string; shown: T[]; total: number; older: number } {
  const tagOf = new Map(reading.browsers.map(b => [b.connection, b.tag]));
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const shown = sorted.slice(-limit);
  const older = sorted.length - shown.length;
  const head = sorted.length === 0
    ? `Nothing matches since ${clock(reading.rowsSince)}.`
    : `${sorted.length} row(s) since ${clock(reading.rowsSince)}${older ? `; the newest ${shown.length} listed, ${older} older left out - narrow by connection, since or a pattern, or raise limit` : ''}`;
  const lines = shown.map(row => `${tagOf.get(row.connection) ?? '?'} ${row.line}`);
  return { text: withHeadline(reading, `${head}${lines.length ? `\n\n${lines.join('\n')}` : ''}`), shown, total: sorted.length, older };
}

/** The refusal for a group that does not exist or a connection outside it; undefined when both stand. */
export function groupRefusal(group: string, connection?: string): string | undefined {
  if (groupCreatedAt(group) === undefined) return `No group "${group}". \`group({ action: 'list' })\` names every group.`;
  const members = membersOf(group);
  if (connection !== undefined && !members.includes(connection)) return `"${connection}" is not in group "${group}": ${members.join(', ') || 'it has no browsers'}.`;
  return undefined;
}
