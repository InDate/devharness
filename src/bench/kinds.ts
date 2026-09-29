/**
 * What a crossing is, as a key, and how many of each kind a step produced.
 *
 * Shared by the server, which counts a recording's steps, and the bench, which
 * counts a replay's and compares the two - one definition of a kind, so the
 * two sides agree on what they are counting.
 */

import type { BoundaryEvent } from './wire.js';

export const isFrame = (event: Pick<BoundaryEvent, 'kind'>) => event.kind === 'frame';

/**
 * What a rule matches on.
 *
 * A request is keyed on its path, which is the substring the proxy's own pin
 * matches at.
 *
 * A frame carries no path, so it is keyed on what it said - and what it said
 * usually carries something that changes every time. `{"tag":"ready","at":
 * 1790148730882}` matched as a whole never matches a second frame, because the
 * clock moved. So the default is the part that names the message and nothing
 * after it, and the row lets that be edited: only a person can say which part
 * of a payload identifies it.
 */
export function keyOf(event: BoundaryEvent): string {
  // A write is keyed by the store and key it wrote, which its url already is.
  if (event.kind === 'write') return event.url;
  if (isFrame(event)) return frameMatch(event.preview ?? event.url);
  try {
    return new URL(event.url).pathname;
  } catch {
    return event.url.split('?')[0];
  }
}

/**
 * Keys that carry a message's name across the protocols this meets: the
 * Socket.IO and Phoenix event, the JSON-RPC method, the GraphQL-over-WS and
 * Redux-style type, the probe app's tag. Read before position, because the
 * field that names a message sits after a per-run id as readily as before it.
 */
const NAMING_KEYS = ['tag', 'type', 'event', 'kind', 'op', 'action', 'cmd', 'method', 'topic', 'name', 'msg', 't', 'e'];

/**
 * A string value that differs per run: digits, hex or a UUID, an ISO date, an
 * email, a long unbroken token. Keyed on one of these, a rule matches the
 * frame it was made from and never another.
 */
const MOVING_VALUE = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{16,}|\d{4}-\d\d-\d\d[T ]\S*|[^@\s]+@[^@\s]+\.[^@\s]+|[A-Za-z0-9+/_=.-]{24,})$/i;

/** Whether a key carries a per-run value, so rows keyed by it are grouped under one kind. */
export const movesPerRun = (value: string) => MOVING_VALUE.test(value);

const names = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !MOVING_VALUE.test(value);

/**
 * The part of a payload that names it, as a substring the proxy can match on.
 *
 * A naming key holding a string that does not move; then the first entry
 * holding one; then the first string that is not all digits, which is the
 * rule every stored key was made under; then the first key. A number, an id
 * and a timestamp all move between runs, so keying on any of them gives every
 * frame its own key and no rule ever applies twice.
 */
export function frameMatch(payload: string): string {
  const text = payload.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const chosen = namingPair(Object.entries(parsed));
      if (chosen) return chosen;
    }
    if (Array.isArray(parsed)) {
      const named = parsed.find(
        (part): part is string => typeof part === 'string' && !/^\d+$/.test(part));
      if (named !== undefined) return JSON.stringify(named);
    }
  } catch {
    // A preview of a large frame is cut short and does not parse, but its
    // leading fields are whole, and a naming field usually leads.
    const chosen = namingPair(leadingPairs(text));
    if (chosen) return chosen;
  }
  return text.slice(0, 40);
}

/** The pair that names an object, by the order `frameMatch` describes. */
function namingPair(entries: Array<[string, unknown]>): string | undefined {
  const pair = ([key, value]: [string, unknown]) => `"${key}":${JSON.stringify(value)}`;
  const named = entries.find(([key, value]) => NAMING_KEYS.includes(key) && names(value));
  if (named) return pair(named);
  const stable = entries.find(([, value]) => names(value));
  if (stable) return pair(stable);
  for (const entry of entries) {
    const [, value] = entry;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return pair(entry);
  }
  return entries[0] ? `"${entries[0][0]}"` : undefined;
}

/**
 * The top-level `"key":value` pairs an object's text opens with, up to the
 * first value that is nested or cut off - all of a truncated object that can
 * be read without guessing.
 */
export function leadingPairs(text: string): Array<[string, unknown]> {
  if (!text.startsWith('{')) return [];
  const pairs: Array<[string, unknown]> = [];
  const next = /\s*"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\s*([,}])/y;
  next.lastIndex = 1;
  for (let found = next.exec(text); found; found = next.exec(text)) {
    try {
      pairs.push([JSON.parse(`"${found[1]}"`), JSON.parse(found[2])]);
    } catch {
      break;
    }
    if (found[3] === '}') break;
  }
  return pairs;
}

/** How many of one kind a step produced. */
export interface KindCount {
  n: number;
  /** Statuses seen, for requests; a socket opening is a 101. */
  statuses?: number[];
  /**
   * Counted as present or absent rather than by number: a message the app
   * sends on its own schedule lands under whichever step is running, so its
   * number measures how long the step took, not what it did.
   */
  presence?: true;
  /** The payload of the last of this kind, as the proxy or the write watch kept it. */
  body?: string;
}

type Countable = Pick<BoundaryEvent, 'kind' | 'url' | 'direction'>
  & Partial<Pick<BoundaryEvent, 'method' | 'preview' | 'status' | 'answeredAs'>>;

/** One kind's name as it reads on a step: `POST /draft`, `← "tag":"big"`, `localStorage socket-app:draft`. */
export function kindOf(event: Countable): string {
  if (event.kind === 'request') return `${event.method ?? 'GET'} ${keyOf(event as BoundaryEvent)}`;
  if (event.kind === 'frame') return `${event.direction === 'out' ? '→' : '←'} ${keyOf(event as BoundaryEvent)}`;
  return event.url.replace(':', ' ');
}

/** Count a step's crossings by kind. A response a saved rule answered is left out of the statuses. */
export function countKinds(events: Countable[]): Record<string, KindCount> {
  const counts: Record<string, KindCount> = {};
  for (const event of events) {
    const kind = kindOf(event);
    const held = counts[kind] ??= { n: 0 };
    held.n += 1;
    if (event.kind === 'frame' && event.direction === 'in') held.presence = true;
    if (event.kind === 'request' && event.status !== undefined && event.answeredAs !== 'replaced') {
      const statuses = held.statuses ??= [];
      if (!statuses.includes(event.status)) statuses.push(event.status);
    }
  }
  return counts;
}

/**
 * How a replayed step's kinds differ from its recording's, one line each; empty when they match.
 *
 * A kind is missing, new, a different number, or answered with a different
 * status. A received message the app pushes is left to `missingPushes`: which
 * step it lands under is set by how long each step took - the length of a
 * person's pause while recording, a fraction of a second on replay - so per
 * step it differs on every run for no reason in the app.
 */
export function compareKinds(recorded: Record<string, KindCount>, observed: Record<string, KindCount>): string[] {
  const lines: string[] = [];
  for (const [kind, was] of Object.entries(recorded)) {
    if (was.presence) continue;
    const now = observed[kind];
    if (!now) { lines.push(`missing: ${kind}`); continue; }
    if (!now.presence && now.n !== was.n) lines.push(`${kind} ×${now.n}, recorded ×${was.n}`);
    const before = (was.statuses ?? []).slice().sort().join('/');
    const after = (now.statuses ?? []).slice().sort().join('/');
    if (before && after && before !== after) lines.push(`${kind} ${after}, recorded ${before}`);
  }
  for (const [kind, now] of Object.entries(observed)) {
    if (!now.presence && !recorded[kind]) lines.push(`new: ${kind}`);
  }
  return lines;
}

/**
 * The kinds of pushed message a recording received that a whole replay did
 * not: the server that stopped pushing, which is the difference in them that
 * holds across runs.
 */
export function missingPushes(recordedSteps: Array<Record<string, KindCount> | undefined>, seen: Countable[]): string[] {
  const expected = new Set<string>();
  for (const kinds of recordedSteps) {
    for (const [kind, count] of Object.entries(kinds ?? {})) if (count.presence) expected.add(kind);
  }
  const arrived = new Set(seen.map(kindOf));
  return [...expected].filter(kind => !arrived.has(kind));
}

/**
 * What a person marked on one kind of a step as having to hold on replay.
 *
 * `fields` holds a JSON payload's chosen leaves by dotted path, so a timestamp
 * or id beside them differs freely; `value` holds the whole payload, compared
 * as JSON where it parses and as text where it does not.
 */
export interface ExpectedValue {
  value?: string;
  /** Fields whose value has to be the same, by dotted path. */
  fields?: Record<string, unknown>;
  /**
   * Fields that have to be there with the same JSON type, by dotted path,
   * whatever they hold: a token or an id that is new on every run is matched
   * on being there rather than on its value.
   */
  shape?: Record<string, string>;
}

/** A leaf's JSON type, as a shape compares it. */
export function typeOfLeaf(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Whether a mark compares fields, by value or by shape, rather than the payload whole. */
export function marksFields(mark: ExpectedValue | undefined): boolean {
  return !!mark && (Object.keys(mark.fields ?? {}).length > 0 || Object.keys(mark.shape ?? {}).length > 0);
}

const LEAF_LIMIT = 60;

/** A JSON payload's leaves by dotted path, `items.0.id`; empty for a payload that is not a JSON object or array. */
export function leavesOf(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {};
  }
  const leaves: Record<string, unknown> = {};
  const walk = (value: unknown, path: string) => {
    if (Object.keys(leaves).length >= LEAF_LIMIT) return;
    if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
      for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
    } else if (path) {
      leaves[path] = value;
    }
  };
  if (parsed !== null && typeof parsed === 'object') walk(parsed, '');
  return leaves;
}

/**
 * A JSON payload's leaves by path with their types, or nothing for a payload
 * that is not a JSON object or array.
 */
export function shapeOf(payload: string): Record<string, string> {
  return Object.fromEntries(Object.entries(leavesOf(payload)).map(([path, leaf]) => [path, typeOfLeaf(leaf)]));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const cut = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;

const shown = (value: unknown) => value === undefined ? 'absent' : cut(JSON.stringify(value), 40);

/** How a replayed payload differs from what was marked on its kind, one line each; empty when it holds. */
export function compareExpected(kind: string, expected: ExpectedValue, payload: string): string[] {
  if (marksFields(expected)) {
    const leaves = leavesOf(payload);
    const byValue = Object.entries(expected.fields ?? {})
      .filter(([path, value]) => !same(leaves[path], value))
      .map(([path, value]) => `${kind} .${path}: ${shown(leaves[path])}, expected ${shown(value)}`);
    const byShape = Object.entries(expected.shape ?? {})
      .filter(([path, type]) => !(path in leaves) || typeOfLeaf(leaves[path]) !== type)
      .map(([path, type]) => `${kind} .${path}: ${path in leaves ? `a ${typeOfLeaf(leaves[path])}` : 'absent'}, expected a ${type}`);
    return [...byValue, ...byShape];
  }
  if (expected.value === undefined) return [];
  let equal = payload === expected.value;
  if (!equal) {
    try {
      equal = same(JSON.parse(payload), JSON.parse(expected.value));
    } catch { /* text that is not JSON compares as text, already done */ }
  }
  return equal ? [] : [`${kind}: ${cut(payload, 60)}, expected ${cut(expected.value, 60)}`];
}

/** Two payloads as the same value: equal as text, or equal once parsed as JSON. */
export function samePayload(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return same(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

export type Verdict = 'match' | 'mismatch' | 'unexpected';

/**
 * One replayed row against the recording of its kind on the same step.
 *
 * A kind the recording lacks is unexpected. A recorded kind mismatches on a
 * different count, status or payload; a pushed kind is judged on arriving,
 * for the reason `KindCount.presence` gives, and on its ticked fields where
 * it has some. Ticked fields narrow the payload comparison to themselves,
 * so a payload carrying a clock can match.
 * `body` undefined while the replayed payload is still being read returns no
 * verdict for a kind whose payload is compared.
 *
 * `byShape` compares an unmarked payload on its fields and their types. A
 * stored value holds tokens, ids and clocks that differ on every run, so
 * compared whole it differs every time; a value that is not a JSON object or
 * array is then compared on being written at all. A mark's `value` compares
 * the payload whole.
 */
export function verdictOf(
  recorded: KindCount | undefined,
  observed: KindCount,
  body: string | undefined,
  mark?: ExpectedValue,
  byShape = false,
): { verdict: Verdict; reasons: string[] } | undefined {
  if (!recorded) return { verdict: 'unexpected', reasons: [] };
  // A pushed kind arrives on the server's schedule, so its count and status
  // say nothing; it is judged on arriving, and on ticked fields where some are.
  if (recorded.presence && !marksFields(mark)) return { verdict: 'match', reasons: [] };
  const reasons: string[] = [];
  if (!recorded.presence) {
    if (observed.n !== recorded.n) reasons.push(`×${observed.n}, recorded ×${recorded.n}`);
    const before = (recorded.statuses ?? []).slice().sort().join('/');
    const after = (observed.statuses ?? []).slice().sort().join('/');
    if (before !== after) reasons.push(`status ${after || '—'}, recorded ${before || '—'}`);
  }
  const shape = byShape && recorded.body !== undefined ? shapeOf(recorded.body) : {};
  const compared = marksFields(mark) ? mark
    : mark?.value !== undefined ? { value: mark.value }
    : byShape ? (Object.keys(shape).length ? { shape } : undefined)
    : recorded.body !== undefined ? { value: recorded.body } : undefined;
  if (compared) {
    if (body === undefined) return undefined;
    if (marksFields(compared)) {
      reasons.push(...compareExpected('', compared, body).map(line => line.trim()));
    } else if (!samePayload(body, compared.value ?? '')) {
      reasons.push('payload differs');
    }
  }
  return { verdict: reasons.length ? 'mismatch' : 'match', reasons };
}

/**
 * One kind moved to the adjacent step, or between the last step and the
 * gutter after it. `at` and `to` are step positions, the step count being the
 * gutter; `origin` is where the moved rows crossed, a step or `after`, and is
 * absent for a recorded kind this run did not produce. `recorded` is what the
 * gutter's rows add to the recording, which holds nothing for them yet.
 */
export interface ActivityMove {
  kind: string;
  at: number;
  to: number;
  origin?: string;
  recorded?: KindCount;
}
