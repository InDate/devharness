/**
 * Everything a page did that devharness observed, in one log and one shape.
 *
 * Requests and socket frames come from the proxy, storage writes and motion
 * from the write watch; each store hands its record here as it is stamped
 * with the call in flight (`observeEvent`, `observeWrite`), and it lands as an
 * observation: an id of one letter and a number, the history entry it was
 * stamped to, the line it reads as, and the evidence that ties it to that
 * entry. A record stamped again by a late cause moves its observation, so one
 * record reads as one line.
 *
 * An entry owns an observation only where something shows it caused it. A
 * time window holds for what an action initiates, synchronous with it - a
 * request it issues, a frame it sends, a storage write - and fails for what
 * follows: a frame that arrived 500ms after the next click had closed the
 * window piled onto the wrong entry (evidence-timeline skill). So a received
 * frame is owned only when it pairs with a send, a timer-rooted request by
 * nothing, and motion by nothing until its cause is stamped at source; each
 * stands under the entry it was stamped to as a consequence, in time order.
 *
 * Every view of an entry's activity reads this log: the bench's rows, the run
 * reply's caused column, `replay history` and a lookup by id.
 */

import { entryOf, levelOf, type ProxyCursor, type ProxyEvent } from './proxy/intercept-proxy.js';
import { causeBefore } from './proxy/cause-timeline.js';
import type { PageWrite, WriteMotion } from './write-watch.js';

export type ObservationKind = 'request' | 'frame' | 'storage' | 'motion';

/** One letter per kind: the id's prefix, and the key a reply prints once. */
export const OBSERVATION_LETTERS: Record<ObservationKind, string> = { request: 'r', frame: 'f', storage: 's', motion: 'm' };
const KIND_WORDS: Record<ObservationKind, string> = { request: 'request', frame: 'socket frame', storage: 'storage', motion: 'motion' };

export interface Observation {
  id: string;
  kind: ObservationKind;
  /** What it reads as on its line: `POST /draft 200`, `← /live 27b`, `#toast opacity`. */
  text: string;
  /** What runs of it fold and compare by. */
  key: string;
  at: number;
  entry?: number;
  /** What ties it to its entry, where something does: `input`, `script`, `reply`, `window`. */
  owned?: string;
  /** A rule that acted on it. */
  rule?: string;
  failed?: boolean;
  /**
   * The entry is the cause stamped on the record itself, where present; absent,
   * the entry is the action the record followed in time. A step's traffic is
   * compared over the stamped ones alone.
   */
  stamped?: true;
  /** The entry whose call opened the stream a pushed frame arrived on. */
  opener?: number;
  /** A motion's reading in fields: its carrier, duration, frames and values. */
  motion?: WriteMotion;
  /** The connection whose browser made it: the proxy's launching reference, or the write watch's page. */
  connection?: string;
  /** The proxy event or page write behind it, for its payload. */
  ref: { source: 'proxy' | 'write'; id: string };
}

/**
 * Kept per kind, so a page full of motion leaves its requests and writes in
 * place. A socket's frames run to thousands in one step, and a step's frame
 * count is read from here, so frames keep ten times the others.
 */
const KEPT: Record<ObservationKind, number> = { request: 2000, frame: 20000, storage: 2000, motion: 2000 };

const byKind = new Map<ObservationKind, Observation[]>();
const byId = new Map<string, Observation>();
const byEntry = new Map<number, string[]>();
const byOpener = new Map<number, string[]>();
const counters = new Map<ObservationKind, number>();
/**
 * The latest observation of each proxy event or page write id, for a lookup by
 * that id. Each proxy numbers its events from `ev-1`, so two browsers' records
 * share ids; the record itself, by identity, is what a restamp finds.
 */
const byRef = new Map<string, string>();
const ofRecord = new WeakMap<ProxyEvent | PageWrite, string>();
/** The proxy event or page write behind each observation, read where a view needs its live fields. */
const records = new Map<string, ProxyEvent | PageWrite>();
/** Arrival order across kinds, which the ids number per kind and so do not hold. */
const arrival = new Map<string, number>();
let arrived = 0;

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function index(map: Map<number, string[]>, key: number | undefined, id: string): void {
  if (key === undefined) return;
  const ids = map.get(key) ?? [];
  ids.push(id);
  map.set(key, ids);
}

function unindex(map: Map<number, string[]>, key: number | undefined, id: string): void {
  if (key === undefined) return;
  const ids = map.get(key);
  const at = ids?.indexOf(id) ?? -1;
  if (at >= 0) ids!.splice(at, 1);
}

/** Append an observation, indexed by its id, its entry and the record behind it. */
export function record(input: Omit<Observation, 'id'>, behind?: ProxyEvent | PageWrite): Observation {
  const number = (counters.get(input.kind) ?? 0) + 1;
  counters.set(input.kind, number);
  const observation: Observation = { id: `${OBSERVATION_LETTERS[input.kind]}${number}`, ...input };
  const kept = byKind.get(input.kind) ?? [];
  kept.push(observation);
  byKind.set(input.kind, kept);
  if (kept.length > KEPT[input.kind]) {
    const dropped = kept.shift()!;
    byId.delete(dropped.id);
    const refKey = `${dropped.ref.source}:${dropped.ref.id}`;
    if (byRef.get(refKey) === dropped.id) byRef.delete(refKey);
    records.delete(dropped.id);
    arrival.delete(dropped.id);
    unindex(byEntry, dropped.entry, dropped.id);
    unindex(byOpener, dropped.opener, dropped.id);
  }
  byId.set(observation.id, observation);
  byRef.set(`${observation.ref.source}:${observation.ref.id}`, observation.id);
  arrival.set(observation.id, ++arrived);
  if (behind) { records.set(observation.id, behind); ofRecord.set(behind, observation.id); }
  index(byEntry, observation.entry, observation.id);
  index(byOpener, observation.opener, observation.id);
  return observation;
}

/**
 * Record a store's record as an observation, or move the one already made of
 * it: a late cause stamps a record that was stored under none, and its line
 * goes to that cause's entry.
 */
function observe(input: Omit<Observation, 'id'>, behind: ProxyEvent | PageWrite): Observation {
  const held = byId.get(ofRecord.get(behind) ?? '');
  if (!held) return record(input, behind);
  unindex(byEntry, held.entry, held.id);
  // A field the restamp leaves absent is cleared, so a line owned by its
  // window before reads as owned by the cause that took it.
  for (const field of ['owned', 'rule', 'failed', 'stamped'] as const) delete held[field];
  Object.assign(held, { ...input, opener: held.opener ?? input.opener });
  index(byEntry, held.entry, held.id);
  return held;
}

/** The observation of a proxy event, owned where the page or the proxy shows its cause. */
export function fromEvent(event: ProxyEvent, entry: number | undefined): Omit<Observation, 'id'> {
  const level = levelOf(event);
  const initiator = event.evidence?.initiator;
  const failed = event.kind === 'request' && (event.status === 0 || (event.status ?? 0) >= 400);
  const owned = level === 'unprompted' ? undefined
    : event.kind === 'frame' && event.direction === 'in' ? (level === 'observed' || level === 'likely' ? 'reply' : undefined)
    : initiator && initiator !== 'other' ? initiator : 'window';
  const rule = event.answeredAs ? `${event.answeredAs}${event.answeredBy ? ` (${event.answeredBy})` : ''}` : undefined;
  if (event.kind === 'request') {
    const text = event.answeredAs === 'outOfScope' ? `${event.method ?? 'GET'} ${event.url}` : `${event.method ?? 'GET'} ${pathOf(event.url)} ${event.status ?? 'pending'}`;
    return { kind: 'request', text, key: `${event.method ?? 'GET'} ${pathOf(event.url)}`, at: event.at, entry, ...(owned ? { owned } : {}), ...(rule ? { rule } : {}), ...(failed ? { failed } : {}), ref: { source: 'proxy', id: event.id } };
  }
  const arrow = event.direction === 'out' ? '→' : '←';
  return { kind: 'frame', text: `${arrow} ${pathOf(event.url)} ${event.size}b`, key: `${arrow} ${pathOf(event.url)}`, at: event.at, entry, ...(owned ? { owned } : {}), ...(rule ? { rule } : {}), ref: { source: 'proxy', id: event.id } };
}

/** The observation of a page write: storage writes owned as initiating, motion a consequence. */
export function fromWrite(write: PageWrite, entry: number | undefined): Omit<Observation, 'id'> {
  if (write.store === 'animation') {
    // A motion's end stands under the step it came after; what stopped it is
    // not reported, so neither its start nor its end is owned.
    const ended = write.operation === 'stopped';
    return {
      kind: 'motion', text: `${write.key ?? ''}${write.value ? `  ${write.value}` : ''}`.trim(), key: `${write.key ?? ''}${ended ? ' ended' : ''}`,
      at: write.at, entry, ...(write.motion ? { motion: write.motion } : {}), ref: { source: 'write', id: write.id },
      // Credited by the identity of the input that started it: the strongest basis a motion has.
      ...(write.motion?.byRoot ? { stamped: true as const, owned: 'root' } : {}),
    };
  }
  const text = `${write.store} ${write.key ?? ''} ${write.operation}`.replace(/\s+/g, ' ').trim();
  return { kind: 'storage', text, key: `${write.store} ${write.group ?? write.key ?? ''}`.trim(), at: write.at, entry, owned: 'window', ref: { source: 'write', id: write.id } };
}

function entryOfCursor(cursor: ProxyCursor | undefined): number | undefined {
  return cursor?.kind === 'command' ? cursor.index : cursor?.kind === 'replay' ? cursor.entry : undefined;
}

// What arrived under no call - a server's push, a motion that began between
// two steps - stands where it arrived: after the action it followed in time,
// as a consequence that action owns nothing of.
// A run's pause between steps names the step it stands before, no entry, so
// the action looked for is the latest cause that names one.
const namesEntry = (cursor: ProxyCursor) => entryOfCursor(cursor) !== undefined;

/**
 * The entry whose call opened each stream or socket, by URL. A frame the
 * server pushes later arrives under no call; the history list counts it on
 * the call that opened what it arrived on.
 */
const openedBy = new Map<string, { entry: number; opener: ProxyEvent }>();

/** The connection an observation came from, where it differs from the reading call's: the label its line takes. */
export function foreignTo(one: Observation, reading: string | undefined): string | undefined {
  return reading !== undefined && one.connection !== undefined && one.connection !== reading ? one.connection : undefined;
}

/** A proxy event as the proxy stores or restamps it. */
export function observeEvent(event: ProxyEvent, connection?: string): Observation {
  const stamp = entryOf(event);
  if (event.kind === 'request' && (event.open || event.status === 101) && stamp !== undefined) openedBy.set(`${connection ?? ''} ${event.url}`, { entry: stamp, opener: event });
  // Only while what opened it is open: a stream the page closed and opened
  // again under a call nobody claimed must not feed the old call's count.
  const opened = stamp === undefined && event.kind === 'frame' && event.direction === 'in' ? openedBy.get(`${connection ?? ''} ${event.url}`) : undefined;
  const opener = opened && (opened.opener.open || opened.opener.status === 101) ? opened.entry : undefined;
  const input = fromEvent(event, stamp ?? entryOfCursor(causeBefore(event.at, namesEntry)));
  return observe({ ...input, ...(stamp !== undefined ? { stamped: true as const } : {}), ...(opener !== undefined ? { opener } : {}), ...(connection ? { connection } : {}) }, event);
}

/** A page write as the write watch stores or restamps it. */
export function observeWrite(write: PageWrite, connection?: string): Observation {
  const stamp = entryOfCursor(write.cursor);
  const input = fromWrite(write, stamp ?? entryOfCursor(causeBefore(write.at, namesEntry)));
  return observe({ ...input, ...(stamp !== undefined ? { stamped: true as const } : {}), ...(connection ? { connection } : {}) }, write);
}

function held(ids: string[] | undefined): Observation[] {
  return (ids ?? []).flatMap(id => { const one = byId.get(id); return one ? [one] : []; });
}

/** What one history entry caused, oldest first. */
export function observationsOf(entry: number): Observation[] {
  return held(byEntry.get(entry));
}

/**
 * What was stamped to one entry, with the pushed frames of the streams its
 * call opened, in arrival order: the step's traffic as recording and the
 * comparison count it.
 */
export function stampedOf(entry: number): Observation[] {
  const stamped = observationsOf(entry).filter(one => one.stamped);
  const pushed = held(byOpener.get(entry)).filter(one => one.entry !== entry || !one.stamped);
  return [...stamped, ...pushed].sort((a, b) => (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0));
}

/** What arrived from `from` up to `to`, whatever entry it stands under, in arrival order. */
export function observationsIn(from: number, to: number): Observation[] {
  return [...byKind.values()].flat().filter(one => one.at >= from && one.at < to)
    .sort((a, b) => (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0));
}

/** The proxy event or page write an observation was made of, as its store holds it now. */
export function recordOf(one: Observation): ProxyEvent | PageWrite | undefined {
  return records.get(one.id);
}

/** An observation by its id (`r31`), or by the proxy event or page write behind it. */
export function observation(id: string): Observation | undefined {
  return byId.get(id) ?? byId.get(byRef.get(`proxy:${id}`) ?? '') ?? byId.get(byRef.get(`write:${id}`) ?? '');
}

/** Five alike in a row read as one line; fewer are listed one by one, as Chrome's console does. */
const FOLD_FROM = 5;

export interface ObservationLine { ids: string[]; observation: Observation; count: number }

/** An entry's observations as lines: runs of five or more alike in a row folded, any other run left whole. */
export function linesOf(observations: Observation[]): ObservationLine[] {
  const lines: ObservationLine[] = [];
  let run: Observation[] = [];
  const flush = () => {
    if (run.length >= FOLD_FROM) lines.push({ ids: run.map(o => o.id), observation: run[0], count: run.length });
    else for (const one of run) lines.push({ ids: [one.id], observation: one, count: 1 });
    run = [];
  };
  for (const one of observations) {
    const alike = run[0] && run[0].kind === one.kind && run[0].key === one.key && Boolean(run[0].owned) === Boolean(one.owned) && run[0].rule === one.rule && run[0].connection === one.connection;
    if (!alike) flush();
    run.push(one);
  }
  flush();
  return lines;
}

/** The key of the letters a reply uses, printed once above its lines. */
export function letterKey(observations: Observation[]): string {
  const kinds = (Object.keys(OBSERVATION_LETTERS) as ObservationKind[]).filter(kind => observations.some(o => o.kind === kind));
  return kinds.map(kind => `${OBSERVATION_LETTERS[kind]} ${KIND_WORDS[kind]}`).join(' · ');
}

/**
 * An entry's lines as a reply prints them: what it owns indented with the
 * evidence, what followed it in time order, each with its id. A line from a
 * browser other than the reading call's names that browser's connection.
 */
export function formatLines(observations: Observation[], reading?: string): string[] {
  return linesOf(observations).map(({ ids, observation: one, count }) => {
    const id = ids.length > 1 ? `${ids[0]}…${ids[ids.length - 1].slice(1)}` : ids[0];
    const text = count > 1 ? `${one.text} ×${count}` : one.text;
    // Owned by the step's window is what the indent says; only stronger evidence is named.
    const evidence = one.owned && one.owned !== 'window' ? `<${one.owned}>` : '';
    const foreign = foreignTo(one, reading);
    const tail = [evidence, one.motion?.maker ? `${one.motion.maker}${one.motion.makerName ? ` ${one.motion.makerName}` : ''}` : '', one.motion?.trigger ? `from ${one.motion.trigger}` : '', foreign ? `on ${foreign}` : '', one.rule ? `rule: ${one.rule}` : '', one.failed ? 'failed' : ''].filter(Boolean).join(' · ');
    const indent = one.owned ? '       ' : '     ';
    return `${(indent + text).padEnd(41)} ${id.padEnd(9)}${tail}`.trimEnd();
  });
}

/** One line of what an entry caused, its kinds named and runs folded, cut to `most` lines. */
export function summaryOf(observations: Observation[], most = 4): string {
  const lines = linesOf(observations);
  const named = lines.slice(0, most).map(({ observation: one, count }) => (count > 1 ? `${one.text} ×${count}` : one.text));
  const rest = lines.length - named.length;
  return `${named.join('; ')}${rest > 0 ? `; +${rest} more` : ''}`;
}

/** Drop the log; tests use it. */
export function forgetObservations(): void {
  byKind.clear(); byId.clear(); byEntry.clear(); byOpener.clear(); counters.clear(); byRef.clear();
  records.clear(); arrival.clear(); openedBy.clear(); arrived = 0;
}
