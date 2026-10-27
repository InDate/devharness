/**
 * Check engine - one reading of the page, a value, or time, repeated until it
 * holds or its time runs out.
 *
 * `check`, `assert` and `wait` are three faces of this: `assert` stops a run
 * when the reading fails, `wait` gives it a time limit, and a sequence's
 * `check` step says what to do on either result. Each face translates its
 * arguments into a `CheckSpec` and formats the `CheckReading` it gets back;
 * none of them polls, probes or times anything itself.
 *
 * The page is read by expressions evaluated through the debugger, re-sent on
 * every poll. A navigation between polls destroys the context one poll ran in
 * and the next runs in the new document, so the reading survives it; a page
 * held at a breakpoint cannot change, so the reading fails at once rather than
 * burning its time limit.
 */

import type { ExecuteToolCall } from '../types.js';
import { isExtendedSelector, parseExtendedSelector } from '../utils/selector-resolver.js';
import { abortableSleep, isAbortError, throwIfAborted } from '../utils/abort.js';
import { evaluateCondition, type ExecutionContext } from './replay-executor.js';
import { callBack, getProxy } from '../proxy/registry.js';
import type { CrossingMatch, ProxyEvent } from '../proxy/intercept-proxy.js';
import { observationsIn, observationsOf, recordOf, type Observation, type ObservationKind } from '../observation-log.js';
import { whenSettled } from '../root-credit.js';

export const CHECK_OPERATORS = [
  'equals', 'notEquals', 'exists', 'notExists', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches',
] as const;
export type CheckOperator = typeof CHECK_OPERATORS[number];

export const ELEMENT_CONDITIONS = [
  'present', 'visible', 'hittable', 'absent', 'text', 'attribute', 'count', 'enabled',
] as const;
export type ElementCondition = typeof ELEMENT_CONDITIONS[number];
export const SOCKET_CONDITIONS = ['open', 'closed'] as const;
export type SocketCondition = typeof SOCKET_CONDITIONS[number];

/** A wait's time limit and read interval when its call names none. */
export const WAIT_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 100;
// How long an owns check waits on a step whose roots have not settled: what bounds a loop that runs on.
const OWNS_SETTLE_BOUND_MS = 10000;

/**
 * The check an assert is: its DOM form read until it holds or `timeoutMs`
 * passes, its value form once. Kept beside the engine rather than in the
 * assert tool, because the replay executor reads it too, and the executor
 * importing a tool module that builds its schema from this module's constants
 * leaves those constants unset while the schema is built.
 */
export function assertAsCheck(args: {
  selector?: string; condition?: ElementCondition; attribute?: string;
  left?: unknown; operator?: CheckOperator; right?: unknown; timeoutMs?: number;
}): CheckSpec {
  if (args.selector && args.condition) {
    return {
      selector: args.selector, condition: args.condition,
      ...(args.attribute ? { attribute: args.attribute } : {}),
      ...(args.operator ? { operator: args.operator } : {}),
      right: args.right,
      withinMs: args.timeoutMs ?? 5000, pollMs: 250,
    };
  }
  return { value: args.left, hasValue: true, ...(args.operator ? { operator: args.operator } : {}), right: args.right };
}

/** The check a wait is. */
export function waitAsCheck(args: {
  selector?: string; selectorGone?: string; expression?: string; ms?: number; timeoutMs?: number; pollIntervalMs?: number;
}): CheckSpec {
  const withinMs = args.timeoutMs ?? WAIT_TIMEOUT_MS;
  const pollMs = args.pollIntervalMs ?? WAIT_POLL_MS;
  if (args.ms !== undefined) return { afterMs: args.ms };
  if (args.expression !== undefined) return { expression: args.expression, withinMs, pollMs };
  return {
    selector: (args.selector ?? args.selectorGone)!,
    condition: args.selector !== undefined ? 'present' : 'absent',
    withinMs, pollMs,
  };
}

/** What one check reads. At most one subject; none is a check on time alone. */
export interface CheckSpec {
  /** An element, and what is required of it. */
  selector?: string;
  condition?: ElementCondition | SocketCondition;
  /** `condition: 'attribute'`: which attribute is read. */
  attribute?: string;
  /** A value, typically a resolved `{{var:...}}`. Read when `hasValue` is set, since the value may be undefined. */
  value?: unknown;
  hasValue?: boolean;
  operator?: CheckOperator;
  right?: unknown;
  /** A synchronous JS predicate, valid against a page or a Node target. */
  expression?: string;
  /** The page's URL, compared by `operator` (equals, contains or matches). */
  url?: string;
  /**
   * What a step owns: the observations whose credit in the log is that step's
   * History entry, matched by kind, by text in the row, and for a request or
   * frame by the fields a pin matches on. `count` with `operator` says how
   * many; the default is at least one.
   */
  owns?: OwnsMatch;
  count?: number;
  /** Which step's credit is read: the call this many back. Default 1, the call before the check. */
  stepsBack?: number;
  /** `stamped`: an observation counts only where the cause was stamped on its record, not placed by time. */
  basis?: 'stamped';
  /** A socket whose URL carries this, `condition` `open` (default) or `closed`. */
  socket?: string;
  /**
   * A connection of this session, `condition` `present` (default: open) or
   * `absent`: whether a run left a browser standing, which no page read sees.
   */
  connectionOpen?: string;
  /** Presence of a cookie, a localStorage key, or an IndexedDB record (`DB/STORE/KEY`, or `DB/STORE` for any). */
  cookie?: string;
  localStorage?: string;
  indexedDB?: string;
  /** Nothing is read until this much time has passed. */
  afterMs?: number;
  /** Read again until it holds, for at most this long after `afterMs`. 0 or absent reads once. */
  withinMs?: number;
  /** Time between reads. */
  pollMs?: number;
}

export type CheckForm = 'time' | 'value' | 'element' | 'expression' | 'url' | 'cookie' | 'localStorage' | 'indexedDB' | 'owns' | 'socket' | 'connectionOpen';

/** What an element probe saw. */
export interface ElementProbe {
  count: number;
  visible: boolean;
  hittable: boolean;
  text: string | null;
  attribute: string | null;
  enabled: boolean;
  /** What hit-testing returned instead, when the element is covered. */
  coveredBy: string | null;
}

export interface CheckReading {
  /** held and failed are answers; error is a check that could not be read at all. */
  outcome: 'held' | 'failed' | 'error';
  form: CheckForm;
  /** The check in words: `#done present`, `{{var:token}} matches "^s-"`. */
  subject: string;
  /** What the last read found, in words. */
  found?: string;
  /** The last element probe, for a face that reports its fields. */
  probe?: ElementProbe;
  /** Why a comparison could not be made, or why the check could not be read. */
  detail?: string;
  /** The last read that threw, when the reading failed on errors rather than on the page. */
  lastError?: string;
  errorKind?: 'invalid' | 'paused' | 'no-connection' | 'not-connected' | 'node' | 'unreadable' | 'no-proxy';
  elapsedMs: number;
  polls: number;
}

export interface CheckDeps {
  connection?: string;
  resolveConnection?: (connection: string) => Promise<any>;
  /** For url, cookie and storage reads, which go through those tools. */
  executeToolCall?: ExecuteToolCall;
  abortSignal?: AbortSignal;
}

/**
 * Coerce both sides to Number for ordering comparisons if both look numeric -
 * avoids string-comparison surprises ("10" < "9") when values arrive as
 * strings (e.g. captured header values, or numbers that round-tripped through
 * JSON as strings).
 */
function toComparable(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function compare(left: unknown, operator: CheckOperator | undefined, right: unknown): { passed: boolean; detail?: string } {
  switch (operator) {
    case 'exists':
      return { passed: left !== undefined && left !== null };
    case 'notExists':
      return { passed: left === undefined || left === null };
    case 'equals':
      return { passed: deepEqual(left, right) };
    case 'notEquals':
      return { passed: !deepEqual(left, right) };
    case 'contains': {
      if (typeof left === 'string') return { passed: left.includes(String(right)) };
      if (Array.isArray(left)) return { passed: left.some(item => deepEqual(item, right)) };
      return { passed: false, detail: `left is ${typeof left}, expected string or array for "contains"` };
    }
    case 'matches': {
      try {
        return { passed: new RegExp(String(right)).test(String(left)) };
      } catch (e: any) {
        return { passed: false, detail: `invalid regex: ${e.message}` };
      }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const l = toComparable(left);
      const r = toComparable(right);
      let cmp: boolean;
      if ((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string')) {
        cmp = operator === 'gt' ? l > r : operator === 'gte' ? l >= r : operator === 'lt' ? l < r : l <= r;
      } else {
        return { passed: false, detail: `cannot compare ${JSON.stringify(left)} ${operator} ${JSON.stringify(right)} (mismatched/unsupported types)` };
      }
      return { passed: cmp };
    }
    default:
      return { passed: false, detail: 'no operator given' };
  }
}

/**
 * An in-page expression for the elements a selector matches, as an array.
 * Extended selectors (:has-text etc.) compile to an inline text match rather
 * than marking elements, so nothing is lost when the document is replaced
 * between polls. Matching follows resolveSelector(): textContent, aria-label
 * and title; case-insensitive partial for has-text, exact for text/text-is.
 */
export function elementsExpression(selector: string): string | { error: string } {
  if (!isExtendedSelector(selector)) {
    return `[...document.querySelectorAll(${JSON.stringify(selector)})]`;
  }
  const parsed = parseExtendedSelector(selector);
  if ('error' in parsed) return { error: parsed.error };
  const { baseSelector, textMatch, scopeSelector, descendantSelector } = parsed;
  if (!textMatch) return `[...document.querySelectorAll(${JSON.stringify(baseSelector)})]`;
  const descendant = descendantSelector ?? '';
  return `(() => {
    const found = [];
    const els = document.querySelectorAll(${JSON.stringify(descendant ? (scopeSelector ?? baseSelector) : baseSelector)});
    const matchText = ${JSON.stringify(textMatch.value)};
    const partial = ${JSON.stringify(textMatch.type === 'has-text')};
    const descendant = ${JSON.stringify(descendant)};
    for (const el of els) {
      const tc = (el.textContent || '').trim();
      const al = el.getAttribute('aria-label') || '';
      const ti = el.getAttribute('title') || '';
      const hit = partial
        ? [tc, al, ti].filter(Boolean).join(' ').toLowerCase().includes(matchText.toLowerCase())
        : (tc === matchText || al === matchText || ti === matchText);
      if (!hit) continue;
      if (!descendant) { found.push(el); continue; }
      const inner = el.querySelector(descendant);
      if (inner) found.push(inner);
    }
    return found;
  })()`;
}

/** A synchronous in-page predicate: true when the selector matches anything. */
export function presenceExpression(selector: string): string | { error: string } {
  if (!isExtendedSelector(selector)) return `!!document.querySelector(${JSON.stringify(selector)})`;
  const all = elementsExpression(selector);
  return typeof all === 'string' ? `(${all}).length > 0` : all;
}

/**
 * One read of everything the element conditions need, as a JSON string so it
 * crosses the debugger whole, and every fact describes the same moment.
 */
function probeExpression(selector: string, attribute?: string): string | { error: string } {
  const all = elementsExpression(selector);
  if (typeof all !== 'string') return all;
  return `JSON.stringify((() => {
    const all = ${all};
    const el = all[0];
    if (!el) return { count: 0, visible: false, hittable: false, text: null, attribute: null, enabled: false, coveredBy: null };
    // Brought into view first, as input does: hit-testing an element below
    // the fold returns null and reads as unreachable, where a user would scroll.
    // Run quietly: devharness's own scroll is not the app's work.
    (globalThis[Symbol.for('devharness.trigger')]?.quietly ?? ((run) => run()))(() => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), ${JSON.stringify(`check ${selector}`)});
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    const hit = visible ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    const hittable = !!hit && (hit === el || el.contains(hit));
    const describe = (n) => n
      ? n.tagName.toLowerCase() + (n.getAttribute && n.getAttribute('aria-label') ? '[' + n.getAttribute('aria-label') + ']' : '') + ': ' + (n.textContent || '').trim().slice(0, 40)
      : null;
    return {
      count: all.length, visible, hittable,
      text: (el.textContent || '').trim(),
      attribute: ${JSON.stringify(attribute ?? null)} ? el.getAttribute(${JSON.stringify(attribute ?? '')}) : null,
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      coveredBy: hittable ? null : describe(hit),
    };
  })())`;
}

/** Errors that mean the selector itself is bad - no further read can help. */
function isSelectorSyntaxError(message: string): boolean {
  return /is not a valid selector|Failed to execute 'querySelector/i.test(message);
}

const said = (value: unknown) => (typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? 'undefined');

export function formOf(spec: CheckSpec): CheckForm {
  if (spec.selector !== undefined) return 'element';
  if (spec.hasValue) return 'value';
  if (spec.expression !== undefined) return 'expression';
  if (spec.url !== undefined) return 'url';
  if (spec.cookie !== undefined) return 'cookie';
  if (spec.localStorage !== undefined) return 'localStorage';
  if (spec.indexedDB !== undefined) return 'indexedDB';
  if (spec.owns !== undefined) return 'owns';
  if (spec.socket !== undefined) return 'socket';
  if (spec.connectionOpen !== undefined) return 'connectionOpen';
  return 'time';
}

/** The check in words, for a result line and a row. */
export function subjectOf(spec: CheckSpec): string {
  const compared = spec.operator ? ` ${spec.operator}${spec.operator === 'exists' || spec.operator === 'notExists' ? '' : ` ${said(spec.right)}`}` : '';
  switch (formOf(spec)) {
    case 'element': {
      const what = spec.condition ?? 'present';
      const attr = what === 'attribute' && spec.attribute ? ` ${spec.attribute}` : '';
      return `${spec.selector} ${what}${attr}${what === 'text' || what === 'attribute' || what === 'count' ? compared : ''}`;
    }
    case 'value': return `${said(spec.value)}${compared}`;
    case 'expression': return spec.expression!;
    case 'url': return `url ${spec.operator ?? 'equals'} ${said(spec.url)}`;
    case 'cookie': return `cookie ${spec.cookie} ${spec.condition === 'absent' ? 'absent' : 'present'}`;
    case 'localStorage': return `localStorage ${spec.localStorage} ${spec.condition === 'absent' ? 'absent' : 'present'}`;
    case 'indexedDB': return `indexedDB ${spec.indexedDB} ${spec.condition === 'absent' ? 'absent' : 'present'}`;
    case 'owns': {
      const t = spec.owns!;
      const what = [t.kind, t.method, t.direction, t.urlIncludes, t.includes, t.textIncludes !== undefined ? said(t.textIncludes) : undefined]
        .filter(Boolean).join(' ');
      return `step ${spec.stepsBack ?? 1} back owns ${what || 'anything'} count ${spec.operator ?? 'gte'} ${spec.count ?? 1}${spec.basis ? `, ${spec.basis}` : ''}`;
    }
    case 'socket': return `socket ${spec.socket} ${spec.condition === 'closed' ? 'closed' : 'open'}`;
    case 'connectionOpen': return `connection ${spec.connectionOpen} ${spec.condition === 'absent' ? 'absent' : 'open'}`;
    case 'time': return `${spec.afterMs ?? 0}ms passed`;
  }
}

/** What a check of a step's credit matches: a kind, text in the row, and a request's or frame's crossing fields. */
export type OwnsMatch = CrossingMatch & { kind?: ObservationKind; includes?: string };

/** Whether an observation is one an `owns` check names. */
function ownsMatches(match: OwnsMatch, one: Observation): boolean {
  if (match.kind && one.kind !== match.kind) return false;
  if (match.includes !== undefined && !one.text.includes(match.includes) && !one.key.includes(match.includes)) return false;
  const crossing = match.urlIncludes !== undefined || match.method !== undefined || match.direction !== undefined || match.textIncludes !== undefined;
  if (!crossing) return true;
  const record = recordOf(one);
  const proxy = one.connection ? getProxy(one.connection) : undefined;
  return one.ref.source === 'proxy' && !!record && !!proxy && proxy.matches(match, record as ProxyEvent);
}

/** What placed an observation: the cause stamped on its record, by its evidence, or its time alone. */
function basisOf(one: Observation): string {
  return one.stamped ? (one.owned ?? 'stamped') : 'timing';
}

/** Observations in words by what placed them, with their History entries where `entries` asks. */
function placesOf(observations: Observation[], entries: boolean): string {
  const counts = new Map<string, number>();
  for (const one of observations) {
    const place = entries ? `${one.entry !== undefined ? `#${one.entry}` : 'no step'} ${basisOf(one)}` : basisOf(one);
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  return [...counts].map(([place, n]) => (n > 1 ? `${place} ×${n}` : place)).join(', ');
}

/** What an element probe found, in words: the fields the condition turns on. */
function foundOf(condition: ElementCondition, probe: ElementProbe, attribute?: string): string {
  const parts = [`matched ${probe.count}`];
  if (probe.count > 0) {
    parts.push(`visible=${probe.visible}`, `hittable=${probe.hittable}`);
    if (probe.coveredBy) parts.push(`covered by ${probe.coveredBy}`);
    if (condition === 'text') parts.push(`text=${JSON.stringify((probe.text || '').slice(0, 60))}`);
    if (condition === 'attribute') parts.push(`${attribute}=${JSON.stringify(probe.attribute)}`);
    if (condition === 'enabled') parts.push(`enabled=${probe.enabled}`);
  }
  return parts.join(', ');
}

/**
 * One read. `final` says whether the answer can still change: a count that
 * must not be exceeded holds only once its time is up, and fails as soon as it
 * is exceeded; left undefined, a read that holds is final and one that fails
 * is read again.
 */
type Read = { held: boolean; found?: string; probe?: ElementProbe; detail?: string; final?: boolean };
class CheckError extends Error {
  constructor(message: string, readonly kind: NonNullable<CheckReading['errorKind']>) { super(message); }
}

/**
 * Read a check until it holds or its time runs out.
 *
 * Throws only an abort, so a cancelled run stops here rather than at the
 * deadline; every other way it ends is a reading.
 */
export async function runCheck(spec: CheckSpec, deps: CheckDeps): Promise<CheckReading> {
  const form = formOf(spec);
  const subject = subjectOf(spec);
  const started = Date.now();
  let polls = 0;
  const reading = (outcome: CheckReading['outcome'], extra: Partial<CheckReading> = {}): CheckReading =>
    ({ outcome, form, subject, elapsedMs: Date.now() - started, polls, ...extra });

  const comparing = spec.condition === 'text' || spec.condition === 'attribute' || spec.condition === 'count';
  if (form === 'element' && comparing && !spec.operator) {
    return reading('error', { errorKind: 'invalid', detail: `condition "${spec.condition}" compares a value, so it needs an operator` });
  }
  if (form === 'element' && spec.condition === 'attribute' && !spec.attribute) {
    return reading('error', { errorKind: 'invalid', detail: 'condition "attribute" needs the attribute to read' });
  }
  if (form === 'element' && (SOCKET_CONDITIONS as readonly string[]).includes(spec.condition ?? '')) {
    return reading('error', { errorKind: 'invalid', detail: `condition "${spec.condition}" is a socket's, not an element's` });
  }
  if (form === 'value' && !spec.operator) {
    return reading('error', { errorKind: 'invalid', detail: 'a value check needs an operator' });
  }

  // What a single read of this check does; built once, so a bad selector or a
  // missing connection is an error before any time is spent.
  let read: () => Promise<Read>;
  let cdpManager: any;
  try {
    read = await readerFor(spec, form, deps, (manager) => { cdpManager = manager; });
  } catch (error: any) {
    if (isAbortError(error)) throw error;
    return reading('error', {
      errorKind: error instanceof CheckError ? error.kind : 'unreadable',
      detail: error?.message || String(error),
    });
  }

  return await readUntilAnswered();

  async function readUntilAnswered(): Promise<CheckReading> {
    if (spec.afterMs && spec.afterMs > 0) await abortableSleep(spec.afterMs, deps.abortSignal);
    // Time alone needs no read: the wait above is the whole check.
    if (form === 'time') return reading('held', { found: `${spec.afterMs ?? 0}ms passed` });
    const pollMs = spec.pollMs ?? 100;
    const deadline = Date.now() + (spec.withinMs ?? 0);
    let last: Read | undefined;
    let lastError: string | undefined;

    while (true) {
      throwIfAborted(deps.abortSignal);
      // Nothing on a page held at a breakpoint can change, so waiting on it only
      // spends the time limit.
      if (cdpManager?.isPaused?.()) {
        return reading('error', { errorKind: 'paused', detail: 'the page is paused at a breakpoint, so nothing on it can change' });
      }
      polls++;
      try {
        last = await read();
        lastError = undefined;
        if (last.final ?? last.held) {
          return reading(last.held ? 'held' : 'failed', {
            ...(last.found !== undefined ? { found: last.found } : {}),
            ...(last.probe ? { probe: last.probe } : {}),
            ...(last.detail ? { detail: last.detail } : {}),
          });
        }
      } catch (error: any) {
        if (isAbortError(error)) throw error;
        if (error instanceof CheckError) return reading('error', { errorKind: error.kind, detail: error.message });
        lastError = error?.message || String(error);
        if (form !== 'expression' && isSelectorSyntaxError(lastError!)) {
          return reading('error', { errorKind: 'invalid', detail: `invalid selector "${spec.selector}": ${lastError}` });
        }
      }
      if (Date.now() + pollMs > deadline) {
        // A read that holds but could still change - a count that must not be
        // exceeded - is answered by where it stands when the time is up.
        if (last?.held) return reading('held', { ...(last.found !== undefined ? { found: last.found } : {}) });
        return reading('failed', {
          ...(last?.found !== undefined ? { found: last.found } : {}),
          ...(last?.probe ? { probe: last.probe } : {}),
          ...(last?.detail ? { detail: last.detail } : {}),
          ...(lastError ? { lastError } : {}),
        });
      }
      await abortableSleep(pollMs, deps.abortSignal);
    }
  }
}

async function readerFor(
  spec: CheckSpec,
  form: CheckForm,
  deps: CheckDeps,
  onManager: (cdpManager: any) => void,
): Promise<() => Promise<Read>> {
  if (form === 'time') return async () => ({ held: true, found: `${spec.afterMs ?? 0}ms passed` });

  if (form === 'connectionOpen') {
    const executeToolCall = deps.executeToolCall;
    if (!executeToolCall) throw new CheckError('a connection check reads the session\'s connection list, and nothing here can call the connection tool', 'invalid');
    const wantOpen = spec.condition !== 'absent';
    return async () => {
      const listed: any = await executeToolCall('connection', { action: 'list' });
      const rows: Array<{ reference?: string; connected?: boolean }> = listed?._meta?.connections ?? [];
      const open = rows.some(row => row.reference === spec.connectionOpen && row.connected !== false);
      return { held: open === wantOpen, found: open ? 'open' : 'not open' };
    };
  }

  if (form === 'socket') {
    const proxy = deps.connection ? getProxy(deps.connection) : undefined;
    if (!proxy) {
      throw new CheckError(
        `a socket check reads what crosses the proxy, and "${deps.connection ?? '(no connection)'}" was not launched through one - connection({ action: 'launch', proxy: true })`,
        'no-proxy');
    }
    const wantOpen = spec.condition !== 'closed';
    return async () => {
      const open = proxy.socketOpen(spec.socket!);
      return { held: open === wantOpen, found: open ? 'open' : 'closed' };
    };
  }

  if (form === 'owns') {
    const back = spec.stepsBack ?? 1;
    if (back < 1) throw new CheckError('stepsBack names an earlier call; the check itself owns nothing', 'invalid');
    const call = callBack(back);
    if (!call) throw new CheckError(`no call stands ${back} back`, 'invalid');
    const match = spec.owns!;
    const operator = spec.operator ?? 'gte';
    const target = spec.count ?? 1;
    // What the step caused lands until its roots settle, so the count is read
    // once they have. A root that never settles - a loop running on - is read
    // at the bound, and a count that more arrivals can break holds only then.
    const bounded = operator === 'equals' || operator === 'lte' || operator === 'lt';
    return async () => {
      if (call.entry === undefined) return { held: false, found: `the call ${back} back has no History entry` };
      const settled = await whenSettled(call.entry, spec.withinMs ?? OWNS_SETTLE_BOUND_MS);
      const owned = observationsOf(call.entry).filter(one => ownsMatches(match, one));
      const counted = owned.filter(one => spec.basis !== 'stamped' || one.stamped === true);
      const uncounted = owned.length - counted.length;
      // What the step should have owned and another entry, or none, holds: the
      // reading that names where a misplaced observation went.
      const elsewhere = observationsIn(call.at, Date.now() + 1).filter(one => one.entry !== call.entry && ownsMatches(match, one));
      const held = compare(counted.length, operator, target).passed;
      const found = [
        `${counted.length} owned${counted.length ? ` (${placesOf(counted, false)})` : ''}`,
        ...(uncounted ? [`${uncounted} placed by time, not counted`] : []),
        ...(elsewhere.length ? [`${elsewhere.length} elsewhere: ${placesOf(elsewhere, true)}`] : []),
        ...(settled ? [] : ['the step\'s work still running']),
      ].join(' · ');
      return { held, found, final: settled || (bounded ? counted.length > target : held) };
    };
  }

  if (form === 'value') {
    return async () => {
      const { passed, detail } = compare(spec.value, spec.operator, spec.right);
      return { held: passed, found: said(spec.value), ...(detail ? { detail } : {}) };
    };
  }

  if (form === 'url' || form === 'cookie' || form === 'localStorage' || form === 'indexedDB') {
    if (!deps.executeToolCall || !deps.connection) {
      throw new CheckError(`a ${form} check reads a browser, so it needs a connection`, 'no-connection');
    }
    const negated = form !== 'url' && spec.condition === 'absent';
    const value = form === 'url'
      ? (spec.operator === 'contains' ? `contains:${spec.url}` : spec.operator === 'matches' ? `matches:${spec.url}` : spec.url!)
      : (spec[form] as string);
    const condition = `{{${negated ? '!' : ''}${form}:${value}}}`;
    const ctx = { executeToolCall: deps.executeToolCall, connection: deps.connection } as ExecutionContext;
    return async () => {
      const result = await evaluateCondition(condition, ctx);
      if (!result.met && 'isError' in result && result.isError) throw new CheckError(result.reason, 'unreadable');
      return { held: result.met, found: result.met ? 'it holds' : 'it does not hold' };
    };
  }

  // element and expression read the page through the debugger.
  if (!deps.resolveConnection || !deps.connection) {
    throw new CheckError(`a ${form} check reads a page, so it needs a connection`, 'no-connection');
  }
  const resolved = await deps.resolveConnection(deps.connection);
  if (!resolved) throw new CheckError(`no connection named "${deps.connection}"`, 'no-connection');
  const cdpManager = resolved.cdpManager;
  if (!cdpManager?.isConnected?.()) throw new CheckError('the debugger is not connected', 'not-connected');
  onManager(cdpManager);
  if (form === 'element' && cdpManager.getRuntimeType?.() === 'node') {
    throw new CheckError('an element check needs a page, and this is a Node target', 'node');
  }

  const evaluate = async (expression: string) => {
    const detailed = await cdpManager.evaluateExpressionDetailed(
      expression, undefined, false, 1, { awaitPromise: false, captureRaw: true });
    return detailed.rawCaptured ? detailed.rawValue : detailed.formatted;
  };

  if (form === 'expression') {
    // A trailing newline stops a `//` comment swallowing the parenthesis.
    const predicate = `!!(${spec.expression}\n)`;
    return async () => {
      const value = await evaluate(predicate);
      const held = value === true || value === 'true';
      return { held, found: held ? 'truthy' : 'falsy' };
    };
  }

  // A socket's condition on an element is refused before any read, in runCheck.
  const condition = (spec.condition ?? 'present') as ElementCondition;
  if (condition === 'present' || condition === 'absent') {
    const present = presenceExpression(spec.selector!);
    if (typeof present !== 'string') throw new CheckError(`invalid selector "${spec.selector}": ${present.error}`, 'invalid');
    const predicate = condition === 'present' ? present : `!(${present})`;
    return async () => {
      const value = await evaluate(predicate);
      const held = value === true || value === 'true';
      return { held, found: held === (condition === 'present') ? 'present' : 'absent' };
    };
  }

  const probe = probeExpression(spec.selector!, spec.attribute);
  if (typeof probe !== 'string') throw new CheckError(`invalid selector "${spec.selector}": ${probe.error}`, 'invalid');
  return async () => {
    const raw = await evaluate(probe);
    const seen: ElementProbe = JSON.parse(String(raw));
    const found = foundOf(condition, seen, spec.attribute);
    let result: { passed: boolean; detail?: string };
    switch (condition) {
      case 'visible': result = { passed: seen.visible }; break;
      case 'hittable': result = { passed: seen.hittable }; break;
      case 'enabled': result = { passed: seen.count > 0 && seen.enabled }; break;
      case 'count': result = compare(seen.count, spec.operator, spec.right); break;
      case 'text': result = seen.count === 0 ? { passed: false, detail: 'no element matched' } : compare(seen.text, spec.operator, spec.right); break;
      case 'attribute': result = seen.count === 0 ? { passed: false, detail: 'no element matched' } : compare(seen.attribute, spec.operator, spec.right); break;
    }
    return { held: result.passed, found, probe: seen, ...(result.detail ? { detail: result.detail } : {}) };
  };
}
