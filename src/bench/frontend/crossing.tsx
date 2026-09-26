/** @jsxImportSource preact */
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoundaryEvent, BoundaryRule, HiddenKind, RuleCatalogueEntry } from '../wire.js';
import { useEscape } from './escape.js';
import { revealResponse } from './focus.js';
import { Glyph } from './glyph.js';

/**
 * One thing that crossed the boundary, wherever it is being read.
 *
 * BOUNDARY reads the stream and STEPS reads it under the step that caused it,
 * and both ask the same questions of a row: what crossed, what the attribution
 * rests on, and what should happen to it next time. Two renderers drifted
 * within a day of there being two, so there is one.
 */

/** The shortest thing that tells one socket from another. */
export function socketName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.host : parsed.pathname;
  } catch {
    return url;
  }
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Status, size, how long it took, and with `typed` what it was - in that order of interest. */
export function describe(event: BoundaryEvent, typed = true): string {
  const parts: string[] = [];
  if (event.kind === 'write') return event.size ? bytes(event.size) : '';
  if (event.heldAs) parts.push(event.heldAs);
  else if (event.kind === 'request') parts.push(String(event.status ?? ''));
  if (event.open) parts.push('open');
  parts.push(bytes(event.size));
  if (event.durationMs !== undefined && event.durationMs > 0) parts.push(`${event.durationMs} ms`);
  if (typed && event.contentType) parts.push(event.contentType);
  return parts.filter(Boolean).join(' · ');
}

export { isFrame, keyOf, frameMatch, leadingPairs } from '../kinds.js';
import { isFrame, keyOf, leavesOf, samePayload, type ExpectedValue, type KindCount, type Verdict } from '../kinds.js';
import { lineDiff, sideBySide } from './diff.js';
import { jsonLines } from './json-lines.js';
import { Fold, LabelInput, Row } from './row.js';

/**
 * The same text with the origin taken off every URL in it.
 *
 * Beside the app the row is a column, and `http://localhost:7788/` spends
 * twenty-two of its characters saying what the scope band above already says:
 * every row in the list came from the host the browser is scoped to. The path
 * is what separates one row from another, so the path is what survives.
 *
 * Applied to a whole label rather than a URL, because a step reads
 * `navigate.goto http://localhost:7788/` and only the tail is a URL.
 */
export function lean(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s]+/gi, '');
}


/** What this row says on screen, for a rule that outlives the event. */
export function labelOf(event: BoundaryEvent): string {
  const head = isFrame(event) ? socketName(event.url) : (event.method ?? 'GET');
  return `${head} ${keyOf(event)}`;
}

/**
 * How many passes a kind appeared in, out of the passes still held.
 *
 * Counted over the proxy's own ring, which holds the newest 2000 events, so
 * the denominator is the passes it still carries rather than every pass ever
 * run. A kind that trails the count is one the shape has not settled on, and
 * waiting for it would hang a step.
 */
export interface Stability {
  /** Passes this kind crossed in. */
  in: number;
  /** Passes the ring still holds. */
  runs: number;
}

/** Every pass the ring still carries, oldest first. */
export function passesIn(events: BoundaryEvent[]): string[] {
  const seen: string[] = [];
  for (const event of events) {
    if (event.runId === undefined || seen.includes(event.runId)) continue;
    seen.push(event.runId);
  }
  return seen;
}

/** How many of those passes carried each key. */
export function stabilityIn(events: BoundaryEvent[]): Map<string, Stability> {
  const passes = passesIn(events);
  const byKey = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.runId === undefined) continue;
    const held = byKey.get(keyOf(event)) ?? new Set<string>();
    held.add(event.runId);
    byKey.set(keyOf(event), held);
  }
  const out = new Map<string, Stability>();
  for (const [key, runs] of byKey) out.set(key, { in: runs.size, runs: passes.length });
  return out;
}

/**
 * Whether an ignore rule covers a crossing: its socket or path, its direction
 * or verb, its step, and then its one kind - or, for a socket-wide rule,
 * anything that crossed there.
 */
export function ignoreMatches(rule: HiddenKind, event: BoundaryEvent): boolean {
  if (rule.frame !== undefined && !!rule.frame !== isFrame(event)) return false;
  if (rule.url && !event.url.includes(rule.url)) return false;
  if (rule.direction && event.direction !== rule.direction) return false;
  if (rule.method && (event.method ?? 'GET') !== rule.method) return false;
  if (rule.step !== undefined && event.step !== rule.step) return false;
  return !!rule.any || keyOf(event) === rule.key;
}

/**
 * Whether an ignore rule covers a kind recorded on a step, which a run may
 * not have produced. A recorded kind carries no socket, so a socket-wide rule
 * covers every recorded message kind going its way.
 */
export function ignoreCoversKind(rule: HiddenKind, kind: string, step: number): boolean {
  if (rule.step !== undefined && rule.step !== step) return false;
  const arrow = kind.startsWith('← ') ? 'in' : kind.startsWith('→ ') ? 'out' : undefined;
  if (rule.any) return !!rule.frame && arrow !== undefined && (!rule.direction || rule.direction === arrow);
  const key = arrow ? kind.slice(2) : kind.slice(kind.indexOf(' ') + 1);
  return key === rule.key;
}

/**
 * Whether a saved response would answer this crossing: a frame rule by its
 * text, socket and direction, a request rule by its path and verb - the
 * constraints its pin is armed with.
 */
export function answersEvent(rule: BoundaryRule, event: BoundaryEvent): boolean {
  if (rule.frame) {
    if (event.kind !== 'frame') return false;
    if (rule.url && !event.url.includes(rule.url)) return false;
    if (rule.direction && rule.direction !== event.direction) return false;
    return (event.preview ?? '').includes(rule.key) || keyOf(event) === rule.key;
  }
  if (event.kind !== 'request') return false;
  if (rule.method && rule.method !== (event.method ?? 'GET')) return false;
  return event.url.includes(rule.key);
}

export interface RuleActions {
  /** Every saved response held for this site, each with the open sequence's use of it. */
  responses?: BoundaryRule[];
  /** Set the open sequence's use of a response. */
  use?: (key: string, use: 'none' | 'all' | number[]) => void;
  /** List a hidden kind again, in the open sequence. */
  unhide?: (key: string) => void;
  /** Make an ignore rule, from the Ignore editor. */
  ignore?: (rule: Record<string, unknown>) => void;
  /** The key of the ignore rule covering a crossing, where one does. */
  ignoredBy?: (event: BoundaryEvent) => string | undefined;
  /**
   * Serve this instead of the server, with whatever the box holds.
   *
   * `match` is what a later crossing is recognised by - a path for a request,
   * a substring of the payload for a frame. It is separate from the body
   * because a frame edited into something else would otherwise stop matching
   * itself, and because only a person can say which part of a payload names it.
   */
  answer: (event: BoundaryEvent, body: string, status: string, match: string, edited?: boolean, scope?: RuleScope, payload?: string, wait?: ResponseWait) => void;
  /** Never let it leave the browser. */
  block: (event: BoundaryEvent) => void;
  /** Keep this kind out of the list. Changes no traffic. */
  hide: (event: BoundaryEvent) => void;
  /** Drop whatever rule stands against it. */
  clear: (event: BoundaryEvent) => void;
  /** Hand the row and its reading to the session. */
  report?: (event: BoundaryEvent) => void;
  /** Tell a step to hold open until this arrives. Absent where no step owns it. */
  waitFor?: (event: BoundaryEvent, step: number) => void;
  /** The step that would wait, for the button to name it. */
  waitStep?: number;
  /** Whether a wait stands on this step, which the button shows and a second press drops. */
  waiting?: (step: number, key: string) => boolean;
  unwait?: (step: number, key: string) => void;
  /** The wait a step holds for a kind, with what it waits for. */
  waitOf?: (step: number, key: string) => ResponseWait | undefined;
  setWait?: (step: number, key: string, wait: ResponseWait) => void;
  /** Change a standing rule, where the row can open the full rule editor. */
  set?: (rule: BoundaryRule, next: RuleEdit) => void;
  /** What a rule's constraints can be bound to, for that editor. */
  choices?: RuleChoices;
  /** Whether a replay is running, which is the only time a step-bound rule can answer. */
  replaying?: boolean;
  /** A person's names for kinds of traffic, by rule key. */
  names?: Record<string, string>;
  /** Name this kind of traffic, under `key` where the row has its own; an empty name goes back to its payload. */
  rename?: (event: BoundaryEvent, name: string, key?: string) => void;
  /**
   * The key a row's name is kept under, where a list names each row rather
   * than each kind: two rows of one kind on two steps are two things said.
   * Absent, a name is the kind's, wherever it crosses.
   */
  nameKey?: (event: BoundaryEvent) => string;
  /** What is marked to hold on replay for this row's kind on its step. */
  expected?: (event: BoundaryEvent, step?: number) => ExpectedValue | undefined;
  /** Mark what this row's kind has to carry on replay of its step; none unmarks it. */
  expect?: (event: BoundaryEvent, mark: ExpectedValue | undefined, step?: number) => void;
}

/** A replayed row read against its recording, with what writes the recording from this run. */
export interface RowVerdict {
  verdict: Verdict | 'missing';
  /** What differs, one line each; empty on a match. */
  reasons: string[];
  /** The kind as recorded on this step; absent on an unexpected row. */
  recorded?: KindCount;
  /** Write this run's count, statuses and payload over the recording; on a missing row, drop the kind. */
  onUpdate: () => void;
}

export const VERDICT_WORDS: Record<RowVerdict['verdict'], string> = {
  match: 'Match', mismatch: 'Mismatch', unexpected: 'Unexpected', missing: 'Missing',
};

/** The button that writes this run over the recording, by verdict; absent where there is nothing to write. */
function saveWords(verdict: RowVerdict | undefined): string | undefined {
  if (!verdict) return undefined;
  if (verdict.verdict === 'missing') return 'Remove';
  // A pushed kind is compared by presence, so there is no payload of it to save.
  if (verdict.recorded?.presence && verdict.verdict === 'match') return undefined;
  if (verdict.verdict === 'unexpected' || verdict.verdict === 'mismatch') return 'Save';
  return verdict.recorded?.body === undefined ? 'Save' : undefined;
}

/** Whether JSON is read pretty-printed or as it crossed, kept per viewer across rows and reloads. */
function useFormatted(): [boolean, (next: boolean) => void] {
  const read = () => {
    try { return localStorage.getItem('bench.jsonRaw') !== '1'; } catch { return true; }
  };
  const [formatted, setFormatted] = useState<boolean>(read);
  return [formatted, (next) => {
    setFormatted(next);
    try { localStorage.setItem('bench.jsonRaw', next ? '0' : '1'); } catch { /* per-viewer only */ }
  }];
}

/** A JSON payload pretty-printed; anything that does not parse, as it is. */
function formatJson(payload: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return undefined;
  }
}

/** The layout a diff is read in, kept per viewer across rows and reloads. */
function useDeltaLayout(): ['inline' | 'side', (next: 'inline' | 'side') => void] {
  const read = () => {
    try { return localStorage.getItem('bench.deltaLayout') === 'side' ? 'side' : 'inline'; } catch { return 'inline'; }
  };
  const [layout, setLayout] = useState<'inline' | 'side'>(read);
  return [layout, (next) => {
    setLayout(next);
    try { localStorage.setItem('bench.deltaLayout', next); } catch { /* per-viewer only */ }
  }];
}

/**
 * What a row carried, read once, in a box whose top edge says what it is.
 *
 * Against the recording as a line diff where the two differ; on its own where
 * they do not, or nothing was recorded. A recorded kind this run did not
 * produce shows what was recorded.
 */
export function PayloadBox({ verdict, replayed, contentType, compared = [], served }: {
  verdict?: RowVerdict;
  replayed: string | undefined;
  contentType?: string;
  /** The fields a replay is compared on, by dotted path; their lines are tagged. */
  compared?: string[];
  /**
   * What a standing replacement serves in place of the crossing. Read against
   * what the server sent, so what is being served is on screen on opening the
   * row rather than behind its editor.
   */
  served?: string;
}) {
  const [layout, setLayout] = useDeltaLayout();
  const [formatted, setFormatted] = useFormatted();
  const was = served !== undefined ? replayed : verdict?.recorded?.body;
  const now = served !== undefined ? served : verdict?.verdict === 'missing' ? undefined : replayed;
  const lines = was !== undefined && now !== undefined ? lineDiff(was, now) : undefined;
  const changed = lines?.some(line => line.op !== 'same') ?? false;
  const shown = verdict?.verdict === 'missing' ? was : now;
  const pretty = shown !== undefined && !changed ? formatJson(shown) : undefined;
  // Each printed line's field, where the payload is JSON, for the tags.
  const pathsOf = (payload: string | undefined) => {
    try { return payload === undefined ? [] : jsonLines(JSON.parse(payload)).map(line => line.path); } catch { return []; }
  };
  const tag = (path: string | undefined) => path !== undefined && compared.includes(path)
    ? <span class="fieldtag" title="a replay is compared on this field">match</span>
    : null;
  const laterPaths = lines && changed ? pathsOf(now) : [];
  let later = 0;
  const facts = [
    contentType,
    shown !== undefined ? bytes(shown.length) : undefined,
    changed ? (served !== undefined ? 'server sent → served' : 'recorded → this run')
      : served !== undefined ? 'served as the server sent it'
      : verdict?.verdict === 'missing' ? 'as recorded' : undefined,
  ].filter(Boolean).join(' · ');
  return (
    <div class="pbox" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <div class="pboxhead">
        <span class="grow">{facts || 'payload'}</span>
        {pretty !== undefined && (
          <button class={formatted ? 'tool plain chosen' : 'tool plain'} aria-pressed={formatted}
            title={formatted ? 'show it as it crossed' : 'pretty-print it'}
            onClick={() => setFormatted(!formatted)}>Format</button>
        )}
        {changed && <>
          <button class={layout === 'inline' ? 'tool plain chosen' : 'tool plain'} aria-pressed={layout === 'inline'}
            onClick={() => setLayout('inline')}>Inline</button>
          <button class={layout === 'side' ? 'tool plain chosen' : 'tool plain'} aria-pressed={layout === 'side'}
            onClick={() => setLayout('side')}>Side by side</button>
        </>}
      </div>
      {lines && changed
        ? layout === 'inline'
          ? <pre class="diff">{lines.map((line, k) => {
              const path = line.op === 'gone' ? undefined : laterPaths[later++];
              return <div key={k} class={line.op}>{line.op === 'gone' ? '- ' : line.op === 'new' ? '+ ' : '  '}{line.text}{tag(path)}</div>;
            })}</pre>
          : <div class="diff side">
            <div class="pair head">
              <span>{served !== undefined ? 'server sent' : 'recorded'}</span>
              <span>{served !== undefined ? 'served' : 'this run'}</span>
            </div>
            {sideBySide(lines).map((row, k) => (
              <div key={k} class="pair">
                <pre class={row.left?.op ?? 'blank'}>{row.left?.text ?? ''}</pre>
                <pre class={row.right?.op ?? 'blank'}>{row.right?.text ?? ''}</pre>
              </div>
            ))}
          </div>
        : <pre class="pboxbody">{shown === undefined ? 'reading…'
            : formatted && pretty !== undefined
              ? jsonLines(JSON.parse(shown)).map((line, k) => <div key={k}>{line.text}{tag(line.path)}</div>)
            : shown.length > LARGE_BODY ? `${shown.slice(0, LARGE_BODY)}…` : (shown || '(nothing kept for this one)')}</pre>}
    </div>
  );
}

/**
 * How this run compares with the recording, in words: what it matched on, or
 * what differs. Absent where the row is not being compared.
 */
function comparison(verdict: RowVerdict | undefined, mark: ExpectedValue | undefined): string | undefined {
  if (!verdict) return mark?.fields ? `compared on ${Object.keys(mark.fields).map(path => `.${path}`).join(', ')}` : undefined;
  if (verdict.verdict === 'unexpected') return 'Not in the recording';
  if (verdict.verdict === 'missing') return 'Recorded, not produced by this run';
  if (verdict.verdict === 'mismatch') return `Differs · ${verdict.reasons.join(', ')}`;
  if (verdict.recorded?.presence && !mark?.fields) return 'Arrived, as recorded';
  if (mark?.fields) return `Matches on ${Object.keys(mark.fields).map(path => `.${path}`).join(', ')}`;
  return verdict.recorded?.body === undefined ? 'Matches on status and count' : 'Matches the recording';
}

/**
 * The line under the payload: how it compares on the left, and on the right
 * what it is compared on and what can be done with it.
 */
function BodyFoot({ summary, children }: {
  summary?: string;
  children?: preact.ComponentChildren;
}) {
  return (
    <div class="bodyfoot" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <span class="footsummary">{summary}</span>
      <span class="grow" />
      <span class="footactions">{children}</span>
    </div>
  );
}

/** The step above and below a row's kind can be moved to; an absent side has none. */
export interface RowMoves {
  up?: () => void;
  down?: () => void;
}

/** A kind the recording holds on this step that this run never produced. */
export function MissingRow({ kind, verdict, open, onOpen, moves }: {
  kind: string;
  verdict: RowVerdict;
  open: boolean;
  onOpen: () => void;
  moves?: RowMoves;
}) {
  const [head, ...rest] = kind.split(' ');
  return (
    <Row
      classes={['missing']}
      source={head}
      title="recorded on this step, and not produced by this run"
      label={<span class="what">{rest.join(' ')}</span>}
      reading={<>
        <span class="verdict missing">Missing</span>
        <span class="meta">recorded ×{verdict.recorded?.n ?? 0}</span>
      </>}
      slots={{
        remove: () => verdict.onUpdate(),
        ...(moves?.up ? { up: moves.up } : {}), ...(moves?.down ? { down: moves.down } : {}),
      }}
      glyphs={{ remove: 'clear' }}
      titles={{ remove: 'take this kind out of the step\'s recording, so runs stop looking for it' }}
      open={open}
      onOpen={onOpen}
    >
      <div class="body">
        <PayloadBox verdict={verdict} replayed={undefined} />
        <BodyFoot summary={comparison(verdict, undefined)} />
      </div>
    </Row>
  );
}

/**
 * The fields of a JSON payload, each with a tick, in the payload box's place
 * while the ones a replay is compared on are chosen. A replayed payload is
 * compared whole against its recording, and one that holds an id or a clock
 * differs on every run; comparing only the fields that matter leaves the
 * rest free.
 */
function FieldList({ payload, ticked, onToggle }: {
  payload: string;
  ticked: string[];
  onToggle: (path: string) => void;
}) {
  const leaves = leavesOf(payload);
  return (
    <div class="pbox" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <div class="pboxhead"><span class="grow">fields</span></div>
      <ul class="expectfields">
        {Object.keys(leaves).map(path => (
          <li key={path}>
            <label>
              <input type="checkbox" checked={ticked.includes(path)} onChange={() => onToggle(path)} />
              <span class="path">.{path}</span>
              <span class="quiet">{JSON.stringify(leaves[path])}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Re-arm a rule under what its editor now holds.
 *
 * The store keys by match, so a changed match clears the old rule first, or the
 * old and the new would both answer. Shared by the traffic row and the proxy
 * panel, which edit the same rule.
 */
export async function rearmRule(
  post: (path: string, body?: Record<string, unknown>) => Promise<unknown>,
  rule: BoundaryRule,
  next: RuleEdit,
): Promise<void> {
  if (next.key !== rule.key) await post('/boundary/rule/clear', { key: rule.key });
  await post('/boundary/rule', {
    key: next.key, verb: rule.verb, body: next.body, status: next.status,
    ...(rule.frame ? { frame: true } : {}),
    ...(rule.label !== undefined ? { label: rule.label } : {}),
    ...(rule.recorded !== undefined ? { recorded: rule.recorded } : {}),
    ...(rule.edited || next.body !== (rule.body ?? '') ? { edited: true } : {}),
    // Carried so a constraint dropped below keeps the value that binds it
    // back, which a replace would otherwise discard.
    ...(rule.staged !== undefined ? { staged: rule.staged } : {}),
    // Absent means unbound: the rule is replaced whole, so a constraint left
    // out here is not armed on the new pin.
    ...(next.url !== null ? { url: next.url } : {}),
    ...(next.direction !== null ? { direction: next.direction } : {}),
    ...(next.method !== null ? { method: next.method } : {}),
    ...(next.payload ? { payload: next.payload } : {}),
    // The open sequence's use of it, where the edit chose one: every step,
    // or the one picked. Left out, the use stands as it was.
    ...(next.step !== undefined ? { use: next.step === null ? 'all' : [next.step] } : {}),
    ...(next.mode ? { mode: next.mode } : {}),
    ...(next.wait ? { wait: next.wait } : {}),
  });
}

/**
 * How a rule's use reads. A rule bound to a step answers only while a replay
 * runs that step, so outside a replay its count stands still and says so
 * rather than reading as a rule that failed to match.
 */
export function ruleUse(rule: BoundaryRule, replaying: boolean): { said: string; cold: boolean } | undefined {
  if (rule.verb === 'hide' || rule.hits === undefined) return undefined;
  if (rule.hits > 0) return { said: `used ${rule.hits}×`, cold: false };
  if (rule.steps && !replaying) {
    return { said: `at step ${rule.steps.map(n => n + 1).join(', ')}, answers during a replay`, cold: false };
  }
  return { said: 'never fired', cold: true };
}

/** Past this a body is shown in part. */
const LARGE_BODY = 16 * 1024;



/**
 * The payload, as it will be served rather than as it crossed.
 *
 * A frame keeps both: the recorded text is what a later frame is matched on,
 * and the box below it is what goes out in its place. Held apart, because a
 * frame edited into something else would stop matching itself.
 */
export function CrossingBody({ event, base, rule, actions, verdict }: {
  event: BoundaryEvent;
  base: string;
  rule?: BoundaryRule;
  actions?: RuleActions;
  verdict?: RowVerdict;
}) {
  const [payload, setPayload] = useState<string | undefined>(undefined);
  // The replacement box opens on asking: the payload is read above it already,
  // and a second copy of it in an editable box is the same text twice.
  const [replacing, setReplacing] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [picking, setPicking] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`${base}/proxy/body?id=${encodeURIComponent(event.id)}`)
      .then(res => res.text())
      .then(text => { if (live) setPayload(text || ''); })
      .catch(() => { if (live) setPayload(''); });
    return () => { live = false; };
  }, [event.id, base]);

  const stop = (e: MouseEvent) => e.stopPropagation();
  // The step the row is listed on, which a row moved in from the gutter has
  // and its stamp does not; a mark is kept on the step the row is read under.
  const markStep = actions?.waitStep ?? event.step;
  const mark = actions?.expected?.(event, markStep);
  const canMark = !!actions?.expect && markStep !== undefined && payload !== undefined;
  // What a replay is compared on: the whole payload, or the fields ticked.
  const matchButton = canMark && Object.keys(leavesOf(payload ?? '')).length > 0
    ? <button class="tool plain" title={mark?.fields ? 'change which fields a replay is compared on' : 'compare a replay on some fields only'}
        onClick={() => { setReplacing(false); setTicked(Object.keys(mark?.fields ?? {})); setPicking(true); }}>Match Fields</button>
    : null;
  const save = saveWords(verdict);
  // While fields are picked, the box lists them and the line under it holds
  // only what finishes the choice, in the place the row's buttons stand.
  const pickingNow = picking && payload !== undefined;
  const box = pickingNow
    ? <FieldList payload={payload} ticked={ticked}
        onToggle={(path) => setTicked(ticked.includes(path) ? ticked.filter(held => held !== path) : [...ticked, path])} />
    : <PayloadBox verdict={verdict} replayed={payload} contentType={event.contentType}
        compared={Object.keys(mark?.fields ?? {})}
        served={rule?.verb === 'answer' ? rule.body : undefined} />;
  const endPicking = () => { setPicking(false); setTicked([]); };
  const pickingFoot = pickingNow && (
    <BodyFoot summary={ticked.length ? 'compared on the fields ticked' : 'nothing ticked: compared whole'}>
      <button class="tool plain" onClick={() => {
        const leaves = leavesOf(payload!);
        actions!.expect!(event, ticked.length
          ? { fields: Object.fromEntries(ticked.map(path => [path, leaves[path]])) }
          : undefined, markStep);
        endPicking();
      }}>{ticked.length ? `Match on ${ticked.length} field${ticked.length === 1 ? '' : 's'}` : 'Match whole payload'}</button>
      <button class="tool plain" onClick={endPicking}>Cancel</button>
    </BodyFoot>
  );
  const saveButton = save && verdict && (
    <button class="tool plain" title="make what this run carried the recording for this step"
      onClick={() => verdict.onUpdate()}>{save}</button>
  );

  // A write never leaves the page, so it can be compared and saved and nothing else.
  if (!actions || event.kind === 'write') {
    return (
      <div class="body">
        {box}
        {pickingFoot || <BodyFoot summary={comparison(verdict, mark)}>{saveButton}{matchButton}</BodyFoot>}
      </div>
    );
  }

  const served = rule?.verb === 'answer' && !rule.off ? rule : undefined;
  const blocked = rule?.verb === 'block' && !rule.off;
  // The saved responses that would answer this crossing, used here or not:
  // one line each, so the sequence opts into the one it wants.
  const here = actions.waitStep ?? event.step;
  const matching = (actions.responses ?? []).filter(one => one.verb !== 'hide' && !one.foreign && answersEvent(one, event));
  const usedHere = (one: BoundaryRule) => !one.off && (!one.steps || (here !== undefined && one.steps.includes(here)));
  // A replacement applies to crossings of the row's kind, the same key the
  // row is listed by; the fields a replay is compared on are a separate choice.
  const carrying = served?.key ?? keyOf(event);

  return (
    <div class="body">
      {box}
      {matching.length > 0 && !pickingNow && (
        <ol class="savedhere">
          {matching.map(one => {
            const used = usedHere(one);
            return (
              <li key={one.key} class={used ? 'used' : ''}>
                <span class="savedwhat" title={one.payload ?? one.body}>
                  Response
                </span>
                <button class="tool plain" title="open the proxy panel on this response"
                  onClick={() => revealResponse(one.key)}>Open</button>
                {used
                  ? <button class="tool plain" title="stop this response answering in this sequence"
                      onClick={() => actions.use?.(one.key, 'none')}>Opt out</button>
                  : <button class="tool plain" title="answer with this response in this sequence, at every step"
                      onClick={() => actions.use?.(one.key, 'all')}>Opt in</button>}
              </li>
            );
          })}
        </ol>
      )}
      {pickingFoot || <BodyFoot summary={comparison(verdict, mark)}>
        {saveButton}
        {matchButton}
        {blocked
          ? <button class="tool plain" title="let this leave the browser again" onClick={() => actions.use?.(rule!.key, 'none')}>Unblock</button>
          : served
            ? <button class={replacing ? 'tool plain chosen' : 'tool plain'} title="change the saved response - for every sequence using it"
                onClick={() => setReplacing(!replacing)}>Edit</button>
            : <>
                <button class={replacing ? 'tool plain chosen' : 'tool plain'} title="serve something else in place of the response"
                  onClick={() => setReplacing(!replacing)}>Replace</button>
                <button class="tool plain" title="never let this leave the browser"
                  onClick={() => actions.block(event)}>Block</button>
              </>}
        {actions.waitFor && actions.waitStep !== undefined && (actions.waiting?.(actions.waitStep, keyOf(event))
          ? <button class="tool plain chosen" title={`step ${actions.waitStep + 1} holds open until this arrives; press to stop waiting`}
              onClick={() => actions.unwait?.(actions.waitStep!, keyOf(event))}>Will wait</button>
          : <button class="tool plain" title={`step ${actions.waitStep + 1} holds open until this arrives`}
              onClick={() => actions.waitFor!(event, actions.waitStep!)}>Wait</button>)}
        {actions.ignore && (
          <button class={ignoring ? 'tool plain chosen' : 'tool plain'}
            title="leave this traffic out of the list and out of comparisons"
            onClick={() => setIgnoring(!ignoring)}>Ignore</button>
        )}
      </BodyFoot>}

      {/* What this step waits for, set here where Wait was pressed: a row
          with no saved response has no editor to carry it. */}
      {actions.waitStep !== undefined && actions.waiting?.(actions.waitStep, keyOf(event)) && (
        <WaitSettings
          wait={actions.waitOf?.(actions.waitStep, keyOf(event))}
          onChange={(wait) => actions.setWait?.(actions.waitStep!, keyOf(event), wait)}
        />
      )}

      {ignoring && actions.ignore && (
        <IgnoreEditor event={event} step={actions.waitStep ?? event.step}
          onSave={(rule) => { actions.ignore!(rule); setIgnoring(false); }}
          onCancel={() => setIgnoring(false)} />
      )}

      {replacing && payload !== undefined && (
        <ReplaceEditor
          event={event}
          rule={served}
          recorded={payload}
          carrying={carrying}
          stepHere={actions.waitStep ?? event.step}
          choices={actions.choices}
          base={base}
          onSave={(next) => {
            if (served && actions.set) {
              actions.set(served, { key: served.key, body: next.body, status: next.status, ...next.scope,
                wait: next.wait, ...(next.payload ? { payload: next.payload } : {}) });
            } else {
              actions.answer(event, next.body, next.status, carrying, next.edited, next.scope, next.payload, next.wait);
            }
            setReplacing(false);
          }}
          onStop={served ? () => { actions.use?.(served.key, 'none'); setReplacing(false); } : undefined}
          onCancel={() => setReplacing(false)}
        />
      )}
    </div>
  );
}

/**
 * What an ignore rule covers, chosen from the row it is made on: this one
 * kind or everything on its socket or path, which way, at which step, and in
 * which sequences.
 */
function IgnoreEditor({ event, step, onSave, onCancel }: {
  event: BoundaryEvent;
  step?: number;
  onSave: (rule: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const frame = isFrame(event);
  const [every, setEvery] = useState(false);
  const [way, setWay] = useState<'in' | 'out' | null>(frame ? event.direction ?? null : null);
  const [verb, setVerb] = useState<string | null>(frame ? null : event.method ?? 'GET');
  const [atStep, setAtStep] = useState(false);
  const [mode, setMode] = useState<'local' | 'optIn' | 'optOut'>('local');
  // Matched as a substring, so the query that changes per run is left off.
  const where = (() => { try { const at = new URL(event.url); return `${at.origin}${at.pathname}`; } catch { return event.url; } })();
  const save = () => {
    const key = every
      ? `*${where}|${way ?? ''}|${verb ?? ''}|${atStep && step !== undefined ? step : ''}`
      : keyOf(event);
    onSave({
      key, frame, url: where, mode,
      label: every ? `everything on ${frame ? socketName(event.url) : where}` : labelOf(event),
      ...(every ? { any: true } : {}),
      ...(way ? { direction: way } : {}),
      ...(verb ? { method: verb } : {}),
      ...(atStep && step !== undefined ? { step } : {}),
    });
  };
  return (
    <div class="replace ignoreeditor" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <ScopeRow label="ignore">
        <Choice on={!every} onPick={() => setEvery(false)} title="only this kind of traffic">this kind</Choice>
        <Choice on={every} onPick={() => setEvery(true)}
          title={frame ? 'every message on this socket or stream' : 'every call to this path'}>
          everything on {frame ? socketName(event.url) : 'this path'}
        </Choice>
      </ScopeRow>
      {frame
        ? <ScopeRow label="direction">
            <Choice on={way === null} onPick={() => setWay(null)}>either way</Choice>
            <Choice on={way === 'out'} onPick={() => setWay('out')}>sent</Choice>
            <Choice on={way === 'in'} onPick={() => setWay('in')}>received</Choice>
          </ScopeRow>
        : <ScopeRow label="method">
            <Choice on={verb === null} onPick={() => setVerb(null)}>any verb</Choice>
            <Choice on={verb !== null} onPick={() => setVerb(event.method ?? 'GET')}>{event.method ?? 'GET'}</Choice>
          </ScopeRow>}
      {step !== undefined && (
        <ScopeRow label="step">
          <Choice on={!atStep} onPick={() => setAtStep(false)}>any step</Choice>
          <Choice on={atStep} onPick={() => setAtStep(true)}>step {step + 1}</Choice>
        </ScopeRow>
      )}
      <ScopeRow label="type">
        {RESPONSE_TYPES.map(([choice, word]) => (
          <Choice key={choice} on={mode === choice} onPick={() => setMode(choice)}
            title={choice === 'local' ? 'ignored in this sequence only'
              : choice === 'optIn' ? 'ignored in the sequences that opt in - this one, as made here'
              : 'ignored in every sequence on the site that does not opt out'}>{word}</Choice>
        ))}
      </ScopeRow>
      <div class="bodyfoot">
        <span class="grow" />
        <span class="footactions">
          <button class="chip-toggle keep" title="save this ignore rule" aria-label="save" onClick={save}><Glyph of="save" /></button>
          <button class="chip-toggle bin" title="cancel" aria-label="cancel" onClick={onCancel}><Glyph of="cross" /></button>
        </span>
      </div>
    </div>
  );
}

/**
 * A body box that grows to what it holds, up to a screen's worth, so what is
 * typed is on screen without a handle to drag.
 */
function GrowBox({ value, onInput }: { value: string; onInput: (value: string) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = box.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={box}
      class="growbox"
      spellcheck={false}
      value={value}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onInput={(e: Event) => onInput((e.target as HTMLTextAreaElement).value)}
    />
  );
}

/**
 * One line of where a replacement applies: what it is on the left, the
 * choices on the right, the one in force underlined.
 */
function ScopeRow({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="replrow">
      <span class="repllabel">{label}</span>
      <span class="grow" />
      <span class="replchoices">{children}</span>
    </div>
  );
}

function Choice({ on, onPick, title, children }: {
  on: boolean;
  onPick: () => void;
  title?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <button class={on ? 'tool plain chosen' : 'tool plain'} aria-pressed={on} title={title}
      onClick={(e: MouseEvent) => { e.stopPropagation(); onPick(); }}>{children}</button>
  );
}

/**
 * What is served in place of a crossing, and where.
 *
 * Every constraint is a row - the step, and for a socket message its socket
 * and direction, for a request its verb and status - each either held to one
 * value or left off. It applies to crossings of the row's own kind; which
 * fields a replay is compared on is chosen apart from it. The box opens on the payload as it
 * crossed, formatted where it is JSON; formatting alone is no edit, and what
 * is served goes out compact, the shape it crossed in.
 */
function ReplaceEditor({ event, rule, recorded, carrying, stepHere, choices, base, onSave, onStop, onCancel, stepless }: {
  event: BoundaryEvent;
  /**
   * Leave the step row out: opened on a saved response rather than a row, the
   * step belongs to each sequence's use of it, not to the response.
   */
  stepless?: boolean;
  /** The replacement already standing, where this edits one. */
  rule?: BoundaryRule;
  recorded: string;
  carrying: string;
  /** The step the row is listed on, which a step constraint holds to. */
  stepHere?: number;
  choices?: RuleChoices;
  base: string;
  onSave: (next: { body: string; status: string; edited: boolean; scope: RuleScope; payload?: string; wait: ResponseWait }) => void;
  onStop?: () => void;
  onCancel: () => void;
}) {
  const frame = isFrame(event);
  // Held from opening: a socket that keeps pushing hands the row a new
  // payload every few hundred milliseconds, and against a moving payload an
  // untouched box would read as edited.
  const [opened] = useState(recorded);
  const [body, setBody] = useState(rule?.body !== undefined ? (formatJson(rule.body) ?? rule.body) : (formatJson(opened) ?? opened));
  const [status, setStatus] = useState(rule?.status ?? String(event.status ?? '200'));
  const [scope, setScope] = useState<RuleScope>(rule
    ? { step: rule.steps?.length === 1 ? rule.steps[0] : null, method: rule.method ?? null, url: rule.url ?? null,
        direction: rule.direction ?? null, mode: rule.mode ?? 'local' }
    // New: at any step, as a replacement made from a row always began, and on
    // this socket, this way - or with this verb - as it crossed.
    : { step: null, method: frame ? null : event.method ?? null, url: frame ? event.url : null, direction: frame ? event.direction : null,
        mode: 'local' });
  const set = (next: Partial<RuleScope>) => setScope({ ...scope, ...next });
  // What a step waiting on this kind waits for; defaults stand until changed.
  const [wait, setWait] = useState<ResponseWait>(rule?.wait ?? { count: 1, seconds: 10, onFail: 'fail' });
  // The step the row is listed under first: a replacement made from a row
  // with no stamp is staged at step 0, which is where it was made, not where it sits.
  const pickedStep = scope.step ?? stepHere ?? rule?.staged?.step ?? 0;
  const sockets = [...new Set([event.url, ...(choices?.sockets ?? [])])].filter(url => /^wss?:/.test(url));

  // Payloads saved by name, and which one this serves; none serves the box as typed.
  const [saved, setSaved] = useState<Array<{ name: string; bytes: number }>>([]);
  const [source, setSource] = useState<string | null>(rule?.payload ?? null);
  const [savedText, setSavedText] = useState<string | undefined>(undefined);
  const [naming, setNaming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const refresh = () => fetch(`${base}/payloads`).then(res => res.json()).then(setSaved).catch(() => {});
  useEffect(() => { void refresh(); }, [base]);
  useEffect(() => {
    if (source === null) { setSavedText(undefined); return; }
    let live = true;
    void fetch(`${base}/payloads/read?name=${encodeURIComponent(source)}`)
      .then(res => (res.ok ? res.text() : undefined))
      .then(text => { if (live) setSavedText(text); })
      .catch(() => { if (live) setSavedText(undefined); });
    return () => { live = false; };
  }, [base, source]);

  const compact = (text: string) => (formatJson(text) !== undefined ? JSON.stringify(JSON.parse(text)) : text);
  const served = source !== null ? savedText ?? '' : body;
  const edited = !samePayload(served, opened);
  const firstSaved = saved[0]?.name;

  const save = () => {
    if (source !== null) {
      onSave({ body: savedText ?? '', status, edited, scope, payload: source, wait });
      return;
    }
    onSave({ body: edited ? compact(body) : opened, status, edited, scope, wait });
  };
  const savePayload = async () => {
    const name = (naming ?? '').trim();
    const res = await fetch(`${base}/payloads/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content: formatJson(body) ?? body }),
    }).catch(() => undefined);
    const said = res ? await res.json().catch(() => ({})) as { failure?: string } : { failure: 'the bench did not answer' };
    if (said.failure) { setFailure(said.failure); return; }
    setFailure(undefined);
    setNaming(null);
    await refresh();
    setSource(name);
  };

  return (
    <div class="replace" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <ScopeRow label="response type">
        {RESPONSE_TYPES.map(([mode, word, says]) => (
          <Choice key={mode} on={scope.mode === mode} onPick={() => set({ mode })} title={says}>{word}</Choice>
        ))}
      </ScopeRow>
      {!stepless && <ScopeRow label="step">
        <Choice on={scope.step === null} onPick={() => set({ step: null })}>any step</Choice>
        <Choice on={scope.step !== null} onPick={() => set({ step: pickedStep })}>
          {/* The select fills the choice, so a click on it chooses the step
              it shows; picking the step already shown fires no change. */}
          <select value={String(pickedStep)}
            onClick={(e: MouseEvent) => { e.stopPropagation(); if (scope.step === null) set({ step: pickedStep }); }}
            onChange={(e: Event) => set({ step: Number((e.target as HTMLSelectElement).value) })}>
            {/* Marked on the option as well as the select: set on the select
                alone, it lands before the options exist and shows the first. */}
            {(choices?.steps ?? []).map(step => (
              <option key={step.index} value={String(step.index)} selected={step.index === pickedStep}>step {step.index + 1}</option>
            ))}
          </select>
        </Choice>
      </ScopeRow>}
      {frame
        ? <>
            <ScopeRow label="socket">
              <Choice on={scope.url === null} onPick={() => set({ url: null })}>any socket</Choice>
              {sockets.map(url => (
                <Choice key={url} on={scope.url === url} onPick={() => set({ url })} title={url}>{socketName(url)}</Choice>
              ))}
            </ScopeRow>
            <ScopeRow label="direction">
              <Choice on={scope.direction === null} onPick={() => set({ direction: null })}>either way</Choice>
              <Choice on={scope.direction === 'out'} onPick={() => set({ direction: 'out' })}>sent</Choice>
              <Choice on={scope.direction === 'in'} onPick={() => set({ direction: 'in' })}>received</Choice>
            </ScopeRow>
          </>
        : <>
            <ScopeRow label="method">
              <Choice on={scope.method === null} onPick={() => set({ method: null })}>any verb</Choice>
              <Choice on={scope.method !== null} onPick={() => set({ method: event.method ?? 'GET' })}>{scope.method ?? event.method ?? 'GET'}</Choice>
            </ScopeRow>
            <ScopeRow label="status">
              <input class="replinput" value={status} onClick={(e: MouseEvent) => e.stopPropagation()}
                onInput={(e: Event) => setStatus((e.target as HTMLInputElement).value)} />
            </ScopeRow>
            <ScopeRow label="path">
              <span class="replvalue">{carrying}</span>
            </ScopeRow>
          </>}
      {/* Read by any step told to Wait on this kind: how many to hold for,
          how long, and whether a miss fails the step or lets the run on. */}
      <ScopeRow label="wait for">
        <input class="replinput" type="number" min={1} value={wait.count}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          onInput={(e: Event) => setWait({ ...wait, count: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) })} />
        <span class="replvalue">within</span>
        <input class="replinput" type="number" min={1} value={wait.seconds}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          onInput={(e: Event) => setWait({ ...wait, seconds: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) })} />
        <span class="replvalue">s</span>
      </ScopeRow>
      <ScopeRow label="on timeout">
        <Choice on={wait.onFail === 'fail'} onPick={() => setWait({ ...wait, onFail: 'fail' })}
          title="the waiting step fails and the run stops there">fail the step</Choice>
        <Choice on={wait.onFail === 'continue'} onPick={() => setWait({ ...wait, onFail: 'continue' })}
          title="the run goes on without them">carry on</Choice>
      </ScopeRow>
      <ScopeRow label="payload">
        <Choice on={source === null} onPick={() => setSource(null)}>typed</Choice>
        {saved.length > 0
          ? <Choice on={source !== null} onPick={() => setSource(source ?? firstSaved ?? null)}>
              <select value={source ?? firstSaved} onClick={(e: MouseEvent) => e.stopPropagation()}
                onChange={(e: Event) => setSource((e.target as HTMLSelectElement).value)}>
                {saved.map(one => (
                  <option key={one.name} value={one.name} selected={one.name === (source ?? firstSaved)}>{one.name}</option>
                ))}
              </select>
            </Choice>
          : <span class="quiet">none saved yet</span>}
      </ScopeRow>
      {source !== null
        ? <pre class="growbox saved" title="a saved payload: change it by saving another under its name">{formatJson(savedText ?? '') ?? savedText ?? 'reading…'}</pre>
        : <GrowBox value={body} onInput={setBody} />}
      <div class="bodyfoot">
        {naming !== null
          ? <>
              <span class="footsummary">
                <input class="replinput naming" value={naming} placeholder="name this payload"
                  ref={(box) => box?.focus()}
                  onInput={(e: Event) => setNaming((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') void savePayload();
                    if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); setFailure(undefined); }
                  }} />
                {failure && <span class="bad">{failure}</span>}
              </span>
              <span class="grow" />
              <span class="footactions">
                <button class="tool plain" disabled={!naming.trim()} onClick={() => void savePayload()}>Save payload</button>
                <button class="tool plain" onClick={() => { setNaming(null); setFailure(undefined); }}>Cancel</button>
              </span>
            </>
          : <>
              {/* The size served, which is the compact form, not the formatted one in the box. */}
              <span class="footsummary">
                {source !== null ? `${source} · ` : ''}{bytes(compact(served).length)}{edited ? ' · edited' : ''}
              </span>
              <span class="grow" />
              <span class="footactions">
                {source === null && (
                  <button class="tool plain" title="keep what is in the box under a name, for any replacement to serve"
                    onClick={() => setNaming('')}>Save as payload…</button>
                )}
                <button class="tool plain" onClick={save}>{rule ? 'Update' : 'Replace with this'}</button>
                {onStop && <button class="tool plain" onClick={onStop}>Stop replacing</button>}
                <button class="tool plain" onClick={onCancel}>Cancel</button>
              </span>
            </>}
      </div>
    </div>
  );
}

/** How a crossing came to sit where it does, in words, for the row's tooltip. */
function attribution(event: BoundaryEvent): string {
  const how = event.level === 'observed' ? 'caused by this step: the protocol ties it to the action'
    : event.level === 'likely' ? 'probably caused by this step'
    : event.level === 'positional' ? 'placed under this step by when it crossed'
    : 'the app did this on its own';
  return event.root ? `${how} · started by ${event.root}` : how;
}

/**
 * One row of what crossed.
 *
 * The left rule carries the only question this list asks - did a step cause
 * this, or did the app do it on its own - so nothing else here is coloured. A
 * row a rule answers takes the second hue, because the app is no longer the
 * thing deciding it.
 */
export function CrossingRow({
  event, base, rule, repeats, cadence: every, seen, stale, open, onOpen, actions, extra,
  onMenu, verdict, moves, hidden,
}: {
  /** A hidden kind listed after all, as the footing asked: dimmed, and × shows it again. */
  hidden?: boolean;
  /** Move this row's kind to the step above or below, where there is one. */
  moves?: RowMoves;
  /** This row against its recording, on a replay of a recorded step. */
  verdict?: RowVerdict;
  event: BoundaryEvent;
  base: string;
  rule?: BoundaryRule;
  /** How many of this kind collapsed into the row. */
  repeats?: number;
  cadence?: string;
  /** Passes this kind crossed in, of the passes still held. */
  seen?: Stability;
  /** Held over from an earlier pass because a rule stands against it. */
  stale?: boolean;
  open: boolean;
  onOpen: () => void;
  actions?: RuleActions;
  /** Anything the screen wants after the payload, such as an arrival note. */
  extra?: preact.JSX.Element | null;
  onMenu?: (x: number, y: number) => void;
}) {
  // What the proxy did to this crossing, not whether a rule exists: a rule
  // made after it crossed, or one bound to another step, left it as sent.
  const answered = event.heldAs === 'replaced';
  const blocked = event.heldAs === 'dropped' || event.heldAs === 'refused';
  const pending = !answered && !blocked && !rule?.off && (rule?.verb === 'answer' || rule?.verb === 'block');
  // A row's own name first, then one given to its kind before rows were named.
  const named = (actions?.nameKey ? actions.names?.[actions.nameKey(event)] : undefined)
    ?? actions?.names?.[keyOf(event)];
  const [renaming, setRenaming] = useState(false);
  const served = blocked ? 'never sent'
    : answered && rule?.verb === 'answer'
      ? `${isFrame(event) ? '' : (rule.status ?? '') + ' · '}${bytes(rule.body?.length ?? 0)}`
      : null;

  const hidable = actions && event.kind !== 'write';
  const intercepting = !!actions && !!rule && !rule.off && (rule.verb === 'answer' || rule.verb === 'block');
  return (
    <Row
      id={`crossing-${event.id}`}
      classes={[
        // Not `write`: the step row's hover-only note button already has that
        // class, and a row sharing it was hidden until hovered.
        event.kind === 'write' ? 'storewrite' : '',
        stale ? 'stale' : '',
        hidden ? 'hiddentraffic' : '',
        event.owned ? 'caused' : 'unowned',
        answered || blocked ? 'answers' : '',
        event.verdict === 'background' || event.verdict === 'unknown' ? 'ruled' : '',
      ]}
      source={event.kind === 'request' ? (event.method ?? 'GET')
        : event.kind === 'write' ? event.method
        : socketName(event.url)}
      sourceTitle={event.url}
      way={event.kind === 'frame' ? (event.direction === 'out' ? '→' : '←') : ''}
      title={attribution(event)}
      label={<>
        {renaming && actions?.rename
          ? <LabelInput
              value={named ?? ''}
              placeholder={event.kind === 'request' ? lean(event.url) || '/' : (event.preview ?? event.url).slice(0, 60)}
              onSave={(name) => actions.rename!(event, name, actions.nameKey?.(event))}
              onDone={() => setRenaming(false)} />
          // An intercepted frame's payload is not what the page got, so the
          // tag stands in its place and says what did.
          : answered && event.kind === 'frame' && !named ? null
          : <span class={named ? 'what named' : 'what'}
              title={named ? (event.kind === 'request' ? event.url : event.preview) : (event.kind === 'request' ? event.url : undefined)}>
              {named
                ? named
                : event.kind === 'request'
                  ? <><span class="wide">{event.url}</span><span class="lean">{lean(event.url) || '/'}</span></>
                  : (event.preview ?? event.url)}
            </span>}
        {(answered || blocked) && (
          <span class="tag">{blocked ? (event.heldAs === 'refused' ? 'refused' : 'never sent')
            : `Intercepted: ${rule?.mode === 'local' ? 'Local' : 'Global'} Response`}</span>
        )}
        {pending && (
          <span class="tag nexttime" title="a rule stands against this kind; the proxy applies it to the next crossing it covers">
            {rule?.verb === 'block' ? 'blocked next time' : 'answers next time'}
          </span>
        )}
        {rule?.off && (
          <span class="tag nexttime" title="a saved response answers this in other sequences; this sequence does not use it">
            not used here
          </span>
        )}
        {stale && <span class="stale" title="staged, and this pass has not produced it">not this pass</span>}
      </>}
      reading={<>
        {/* A verdict is a person's; how the crossing was attributed is in the
            head's tooltip, in words, rather than on the line as a term. */}
        {event.verdict && <span class="reading">{event.verdict}</span>}
        {/* Stability is a count, never a colour: the two hues are spoken for. */}
        {seen && seen.runs > 1 && !answered && !blocked && (
          <span
            class={seen.in < seen.runs ? 'seen moves' : 'seen'}
            title={seen.in < seen.runs
              ? `crossed in ${seen.in} of the ${seen.runs} passes still held - not settled`
              : `crossed in every one of the ${seen.runs} passes still held`}
          >{seen.in}/{seen.runs}</span>
        )}
        {repeats !== undefined && repeats > 1 && (
          <span class="repeat" title={every ?? `${repeats} of this message`}>
            ×{repeats}{every ? ` ${every}` : ''}
          </span>
        )}
        {verdict && (
          <span class={`verdict ${verdict.verdict}`} title={verdict.reasons.join(' · ') || undefined}>
            {VERDICT_WORDS[verdict.verdict]}
          </span>
        )}
        {/* Not `held`: that class is the held-step panel's, and a size sharing
            it was drawn as a bordered panel. */}
        <span class={`meta ${event.heldAs || served ? 'served' : ((event.status ?? 0) >= 400 ? 'bad' : '')}`}>
          {served ?? describe(event, false)}
        </span>
      </>}
      slots={{
        ...(actions?.rename ? { rename: () => setRenaming(true) } : {}),
        ...(actions?.report ? { send: () => actions.report!(event) } : {}),
        ...(moves?.up ? { up: moves.up } : {}),
        ...(moves?.down ? { down: moves.down } : {}),
        // On an intercepted row, × takes the interception away here: a local
        // response goes; a global one is opted out of by this sequence.
        // × takes an interception away here: a local response goes; a global
        // one is opted out of by this sequence.
        ...(intercepting
          ? { remove: () => (rule!.mode === 'local' ? actions!.clear(event) : actions!.use?.(rule!.key, 'none')) }
          : {}),
        // The eye hides a kind of traffic, or lists a hidden one again. Not
        // while it is intercepted: the interception is taken away first.
        ...(intercepting ? {}
          : hidden ? { hide: () => actions!.unhide?.(actions!.ignoredBy?.(event) ?? keyOf(event)) }
          : hidable ? { hide: () => actions!.hide(event) } : {}),
      }}
      glyphs={hidden ? { hide: 'eye' } : undefined}
      titles={{
        remove: rule?.mode === 'local' ? 'remove this interception' : 'stop intercepting this in this sequence',
        hide: hidden ? 'stop ignoring this - it is listed and compared again' : 'ignore this kind: out of the list and out of comparisons',
      }}
      open={open}
      onOpen={onOpen}
      onMenu={onMenu}
      extra={extra}
    >
      <CrossingBody event={event} base={base} rule={rule} actions={actions} verdict={verdict} />
    </Row>
  );
}

/**
 * The value a rule serves, where the rule is.
 *
 * A rule outlives the reading it was made from: the events are one pass, and a
 * pass that does not produce that traffic leaves the crossing row it was
 * edited on with nothing to attach to. Read from the rule alone, so a value
 * stays correctable once the run that prompted it is gone - which is also the
 * state a sequence reopened tomorrow starts in.
 *
 * The recorded payload sits under the box rather than in it, so what the
 * server sent and what is served in its place are both readable at once.
 *
 * The body is served verbatim. Text that does not parse arms the same way
 * anything else does: a frame the app cannot read is a failure worth
 * injecting, and nothing here decides which one that is.
 */
/**
 * Where a new replacement applies, chosen as it is made: null leaves a
 * constraint off, so it applies at any step, on any socket, either way, to
 * any verb.
 */
export interface RuleScope {
  step: number | null;
  method: string | null;
  url: string | null;
  direction: 'out' | 'in' | null;
  /** Which sequences on the site it answers in; see BoundaryRule.mode. */
  mode?: 'local' | 'optIn' | 'optOut';
}

/**
 * How many a step waits for, how long, and what a miss does. The sliders
 * show their value as they move and save on release, so a drag writes the
 * file once rather than at every notch - on the pointer or key coming up,
 * since `onChange` on an input fires at every notch here.
 */
export function WaitSettings({ wait: held, onChange }: {
  wait?: ResponseWait;
  onChange: (wait: ResponseWait) => void;
}) {
  const wait = held ?? { count: 1, seconds: 10, onFail: 'fail' as const };
  const [count, setCount] = useState(wait.count);
  const [seconds, setSeconds] = useState(wait.seconds);
  useEffect(() => { setCount(wait.count); setSeconds(wait.seconds); }, [wait.count, wait.seconds]);
  const change = (next: Partial<ResponseWait>) => onChange({ ...wait, count, seconds, ...next });
  return (
    <div class="body waitset" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <label class="waitslider">
        <span class="waitlabel">wait for</span>
        <input type="range" min={1} max={10} step={1} value={count}
          onInput={(e: Event) => setCount(Number((e.target as HTMLInputElement).value))}
          onPointerUp={(e: Event) => change({ count: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e: Event) => change({ count: Number((e.target as HTMLInputElement).value) })} />
        <span class="waitvalue">{count} arrival{count === 1 ? '' : 's'}</span>
      </label>
      <label class="waitslider">
        <span class="waitlabel">within</span>
        <input type="range" min={1} max={60} step={1} value={seconds}
          onInput={(e: Event) => setSeconds(Number((e.target as HTMLInputElement).value))}
          onPointerUp={(e: Event) => change({ seconds: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={(e: Event) => change({ seconds: Number((e.target as HTMLInputElement).value) })} />
        <span class="waitvalue">{seconds} s</span>
      </label>
      <div class="waitslider">
        <span class="waitlabel">on timeout</span>
        <span class="waitchoices">
          <Choice on={wait.onFail === 'fail'} onPick={() => change({ onFail: 'fail' })}
            title="the waiting step fails and the run stops there">fail the step</Choice>
          <Choice on={wait.onFail === 'continue'} onPick={() => change({ onFail: 'continue' })}
            title="the run goes on without them">carry on</Choice>
        </span>
      </div>
    </div>
  );
}

/** What a step waiting on a response's kind waits for. */
export type ResponseWait = { count: number; seconds: number; onFail: 'fail' | 'continue' };

/** The three response types, as each reads and what it does. */
const RESPONSE_TYPES: Array<['local' | 'optIn' | 'optOut', string, string]> = [
  ['local', 'Local', 'answers in this sequence only, and is offered to no other'],
  ['optIn', 'Opt In', 'answers in the sequences that opt in; offered to the rest'],
  ['optOut', 'Opt Out', 'answers in every sequence on the site that does not opt out'],
];

export interface RuleEdit {
  key: string;
  body: string;
  status: string;
  /** A saved payload served in place of the body, by name; absent serves the body as typed. */
  payload?: string;
  /**
   * The open sequence's use of it: a step, or null for every step. Absent
   * leaves the use as it stands, as an edit of the response alone does.
   */
  step?: number | null;
  method: string | null;
  url: string | null;
  direction: 'out' | 'in' | null;
  mode?: 'local' | 'optIn' | 'optOut';
  wait?: ResponseWait;
}


/**
 * What a constraint can be bound to here.
 *
 * The recorded value is one candidate among these, not the only one: a rule
 * bound to the step it was staged under answers nowhere else, and without the
 * other steps to choose from the only way past that is to drop the constraint
 * and widen the rule to any step. Typed values are accepted too, so a socket
 * the run has not opened yet can still be named.
 */
export interface RuleChoices {
  steps: Array<{ index: number; label: string }>;
  sockets: string[];
  methods: string[];
  /** The sequence those steps are positions within. */
  forSequence?: string;
}

/**
 * The candidates this run offers each constraint.
 *
 * The sequence's own steps where the screen has them; otherwise the positions
 * traffic has already crossed under, which is every position a rule bound by
 * step can currently answer at. Sockets are the ones the run has opened, and
 * the verbs are the ones it has used over the four a request rule is most
 * often bound to.
 */
export function choicesIn(
  events: BoundaryEvent[],
  steps?: Array<{ index: number; label: string }>,
  forSequence?: string,
): RuleChoices {
  const sockets = new Set<string>();
  const methods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
  const crossed = new Set<number>();
  for (const event of events) {
    if (event.kind === 'frame') sockets.add(event.url);
    else if (event.method) methods.add(event.method);
    if (event.step !== undefined) crossed.add(event.step);
  }
  return {
    steps: steps ?? [...crossed].sort((a, b) => a - b).map(index => ({ index, label: '' })),
    sockets: [...sockets].sort(),
    methods: [...methods].sort(),
    ...(forSequence ? { forSequence } : {}),
  };
}


/**
 * Every saved response, by the site it answers on, and under each the
 * sequences whose use of it differs from its mode: the ones opted in to an
 * opt-in response, the ones opted out of an opt-out one.
 *
 * Read from every file on disk rather than from what the open sequence armed:
 * the proxy is the browser's, and what it will answer depends on which
 * sequence is opened next. What the open sequence armed is overlaid, so its
 * rows carry their hit counts and can be edited in place.
 */
export function SavedResponses({
  base, rules, choices, replaying, names, onSet, onClear, site, sequence, onUse, onMode, reveal,
}: {
  base: string;
  /** A response to open and bring into view, by key, as a traffic row asked. */
  reveal?: string | null;
  /** The responses held in this browser now, each with the open sequence's use of it. */
  rules: BoundaryRule[];
  /** The origin whose responses are held. */
  site?: string;
  /** The open sequence. */
  sequence?: string;
  /** Set the open sequence's use of a response: 'none', 'all', or step indexes. */
  onUse: (key: string, use: 'none' | 'all' | number[]) => void;
  onMode: (key: string, mode: 'local' | 'optIn' | 'optOut') => void;
  names?: Record<string, string>;
  choices: RuleChoices;
  replaying: boolean;
  onSet: (rule: BoundaryRule, next: RuleEdit) => void;
  onClear: (key: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  useEscape(open !== null, () => setOpen(null));
  // The sequence row whose step list is open, under the response it uses.
  const [openUse, setOpenUse] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<RuleCatalogueEntry[]>([]);
  useEffect(() => {
    if (!reveal) return;
    const id = `${site ?? ''}|${reveal}`;
    setOpen(id);
    setTimeout(() => document.getElementById(`response-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
  }, [reveal]);
  useEffect(() => {
    let live = true;
    const read = () => fetch(`${base}/boundary/catalogue`).then(res => res.json())
      .then((entries: RuleCatalogueEntry[]) => { if (live) setCatalogue(entries); }).catch(() => {});
    void read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  // site → key → the response and each sequence's stated use of it.
  const bySite = new Map<string, Map<string, { rule: BoundaryRule; uses: Map<string, Use> }>>();
  const held = (origin: string) => {
    const responses = bySite.get(origin) ?? new Map<string, { rule: BoundaryRule; uses: Map<string, Use> }>();
    bySite.set(origin, responses);
    return responses;
  };
  for (const entry of catalogue) {
    if (entry.sequence) continue;
    for (const rule of entry.rules) held(entry.site ?? '').set(rule.key, { rule, uses: new Map() });
  }
  // The sequences on each site, which an opt-out response is used by.
  const sequencesOf = new Map<string, Set<string>>();
  for (const entry of catalogue) {
    if (!entry.sequence) continue;
    sequencesOf.set(entry.site ?? '', (sequencesOf.get(entry.site ?? '') ?? new Set()).add(entry.sequence));
  }
  if (sequence) sequencesOf.set(site ?? '', (sequencesOf.get(site ?? '') ?? new Set()).add(sequence));
  for (const entry of catalogue) {
    if (!entry.sequence) continue;
    const responses = held(entry.site ?? '');
    for (const key of entry.off ?? []) responses.get(key)?.uses.set(entry.sequence, 'none');
    for (const { key, steps } of entry.on ?? []) responses.get(key)?.uses.set(entry.sequence, steps?.length ? steps : 'all');
  }
  // What is held now is newer than the file it was last written to.
  const here = site ?? '';
  for (const rule of rules) {
    const responses = held(here);
    const known = responses.get(rule.key);
    const uses = known?.uses ?? new Map<string, Use>();
    if (sequence) uses.set(sequence, rule.off ? 'none' : rule.steps ?? 'all');
    responses.set(rule.key, { rule, uses });
  }

  const summary = (rule: BoundaryRule) => rule.verb === 'answer'
    ? `${rule.payload ?? (rule.frame ? bytes(rule.body?.length ?? 0) : `${rule.status ?? '200'} · ${bytes(rule.body?.length ?? 0)}`)}`
      + (rule.edited ? ' · edited' : '')
    : rule.verb === 'block' ? 'never sent' : 'hidden';
  const useSays = (use: Use) => use === 'none' ? 'opted out'
    : use === 'all' ? 'opted in · every step'
    : `opted in · step ${use.map(n => n + 1).join(', ')}`;

  const response = (origin: string, key: string, rule: BoundaryRule, uses: Map<string, Use>) => {
    const live = origin === here ? rules.find(one => one.key === key) : undefined;
    const mode = rule.mode ?? 'local';
    const given: Use = mode === 'optOut' ? 'all' : 'none';
    // Listed: the sequences whose use differs from what the mode gives, and
    // the open one, whose use can be changed here.
    const listed = [...uses.entries()]
      .filter(([name, use]) => name === sequence || JSON.stringify(use) !== JSON.stringify(given))
      .sort(([a], [b]) => (a === sequence ? -1 : b === sequence ? 1 : a.localeCompare(b)));
    if (live && !live.foreign && sequence && !uses.has(sequence)) listed.unshift([sequence, given]);
    // Uses: the sequences it answers in. Opt out counts every sequence on the
    // site less those opting out; the other two count those opting in.
    const used = mode === 'optOut'
      ? [...(sequencesOf.get(origin) ?? [])].filter(name => uses.get(name) !== 'none').length
      : [...uses.entries()].filter(([name, one]) => one !== 'none' && (mode !== 'local' || name === rule.owner)).length;
    const use = live ? (live.off ? 'none' : live.steps ?? 'all') as Use : undefined;
    const hits = live ? ruleUse({ ...live, steps: undefined }, replaying) : undefined;
    const rowId = `${origin}|${key}`;
    const stepsHere = choices.steps;
    const toggle = (step: number) => {
      const now = use === 'all' ? stepsHere.map(one => one.index) : use === 'none' || !use ? [] : use;
      const next = now.includes(step) ? now.filter(n => n !== step) : [...now, step];
      onUse(key, next.length === 0 ? 'none' : next.length === stepsHere.length ? 'all' : next);
    };
    return (
      <Fragment key={rowId}>
        <Row
          id={`response-${rowId}`}
          classes={['rulerow', reveal === key && origin === here ? 'revealed' : '']}
          source={rule.frame ? 'frame' : (rule.method ?? 'any')}
          sourceTitle={rule.url}
          way={rule.frame ? (rule.direction === 'out' ? '→' : rule.direction === 'in' ? '←' : '↔') : ''}
          title={key}
          label={<span class="what">{names?.[key] ?? (rule.frame ? rule.label : undefined) ?? key}</span>}
          reading={<>
            <span class="meta">{summary(rule)}</span>
            {hits && !live?.off && <span class={hits.cold ? 'hits cold' : 'hits'}>{hits.cold ? hits.said : ` · ${hits.said}`}</span>}
            <span class="meta"> · {used} use{used === 1 ? '' : 's'}</span>
          </>}
          slots={live ? { remove: () => onClear(key) } : {}}
          titles={{ remove: 'delete this response from every sequence on the site' }}
          open={open === rowId}
          onOpen={() => setOpen(open === rowId ? null : rowId)}
        >
          {live && live.verb === 'answer'
            ? <ReplaceEditor
                stepless
                event={responseEvent(live)}
                rule={live}
                recorded={live.recorded ?? live.body ?? ''}
                carrying={key}
                choices={choices}
                base={base}
                onSave={(next) => {
                  onSet(live, {
                    key, body: next.body, status: next.status,
                    method: next.scope.method, url: next.scope.url, direction: next.scope.direction,
                    ...(next.scope.mode ? { mode: next.scope.mode } : {}),
                    wait: next.wait,
                    ...(next.payload ? { payload: next.payload } : {}),
                  });
                }}
                onCancel={() => setOpen(null)}
              />
            : <>
                <div class="replace responsemode" onClick={(e: MouseEvent) => e.stopPropagation()}>
                  <ScopeRow label="response type">
                    {RESPONSE_TYPES.map(([choice, word, says]) => (
                      <Choice key={choice} on={mode === choice} onPick={() => live && onMode(key, choice)} title={says}>{word}</Choice>
                    ))}
                  </ScopeRow>
                </div>
                {rule.verb === 'answer' && <pre class="payload">{rule.body ?? ''}</pre>}
              </>}
        </Row>
        {/* The sequences whose use of it differs from its mode: rows of the
            list under the response, not inside it. */}
        {open === rowId && listed.map(([name, stated]) => {
          const mine = live && !live.foreign && name === sequence;
          return (
            <Row
              key={`${rowId}|${name}`}
              classes={['usedrow', mine ? 'rulerow' : '', stated === 'none' ? 'off' : '']}
              source="sequence"
              label={<span class="what">{name}</span>}
              reading={<span class="meta">{useSays(stated)}</span>}
              {...(mine ? {
                more: use === 'none'
                  ? <button class="tool plain" onClick={() => onUse(key, 'all')}>opt in</button>
                  : <button class="tool plain" onClick={() => onUse(key, 'none')}>opt out</button>,
              } : {})}
              columns={[]}
              slots={{}}
              open={!!mine && openUse === `${rowId}|${name}`}
              onOpen={() => { if (mine) setOpenUse(openUse === `${rowId}|${name}` ? null : `${rowId}|${name}`); }}
            >
              {/* Which of its steps it answers at, each named, so a long
                  sequence is chosen from by what each step does. */}
              <div class="steppick" onClick={(e: MouseEvent) => e.stopPropagation()}>
                <label>
                  <input type="radio" checked={use === 'all'} onChange={() => onUse(key, 'all')} /> every step
                </label>
                <label>
                  <input type="radio" checked={use === 'none'} onChange={() => onUse(key, 'none')} /> no steps (opted out)
                </label>
                <ol>
                  {stepsHere.map(step => (
                    <li key={step.index}>
                      <label>
                        <input type="checkbox"
                          checked={use === 'all' || (Array.isArray(use) && use.includes(step.index))}
                          onChange={() => toggle(step.index)} />
                        <span class="stepnum">{step.index + 1}</span>
                        <span class="steplabel">{step.label}</span>
                      </label>
                    </li>
                  ))}
                </ol>
              </div>
            </Row>
          );
        })}
      </Fragment>
    );
  };

  const origins = [...bySite.keys()].filter(origin => bySite.get(origin)!.size > 0)
    .sort((a, b) => (a === here ? -1 : b === here ? 1 : a.localeCompare(b)));
  const total = origins.reduce((sum, origin) => sum + bySite.get(origin)!.size, 0);
  return (
    <Fold title="Saved responses" count={total}>
      {!origins.length && (
        <p class="sechint">None yet. Open a request or frame on a step and choose what it should be answered with.</p>
      )}
      <div class="saved">
        {origins.map(origin => {
          const all = [...bySite.get(origin)!.entries()];
          const shown = all.filter(([, one]) => one.rule.verb !== 'hide');
          return (
            <Fold key={origin} level="group" title={origin ? new URL(origin).host : 'no site'} count={shown.length}>
              <ol class="activitycards">{shown.map(([key, one]) => response(origin, key, one.rule, one.uses))}</ol>

            </Fold>
          );
        })}
      </div>
    </Fold>
  );
}

/**
 * The kinds kept out of the list, by site, each with its type and, opened,
 * the sequences that hide it or list it anyway. Read from every file on disk,
 * with what the open sequence holds laid over it.
 */
export function SavedHidden({ base, hidden, site, sequence, onUse, onMode, onClear }: {
  base: string;
  hidden: HiddenKind[];
  site?: string;
  sequence?: string;
  onUse: (key: string, on: boolean) => void;
  onMode: (key: string, mode: HiddenKind['mode']) => void;
  onClear: (key: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<RuleCatalogueEntry[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => fetch(`${base}/boundary/catalogue`).then(res => res.json())
      .then((entries: RuleCatalogueEntry[]) => { if (live) setCatalogue(entries); }).catch(() => {});
    void read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  // site → key → the kind, and each sequence's stated choice: hidden or listed.
  const bySite = new Map<string, Map<string, { kind: HiddenKind; said: Map<string, boolean> }>>();
  const held = (origin: string) => {
    const kinds = bySite.get(origin) ?? new Map<string, { kind: HiddenKind; said: Map<string, boolean> }>();
    bySite.set(origin, kinds);
    return kinds;
  };
  const sequencesOf = new Map<string, Set<string>>();
  for (const entry of catalogue) {
    if (entry.sequence) {
      sequencesOf.set(entry.site ?? '', (sequencesOf.get(entry.site ?? '') ?? new Set()).add(entry.sequence));
      continue;
    }
    for (const kind of entry.hidden ?? []) held(entry.site ?? '').set(kind.key, { kind, said: new Map() });
  }
  for (const entry of catalogue) {
    if (!entry.sequence) continue;
    const kinds = held(entry.site ?? '');
    for (const key of entry.hiddenOn ?? []) kinds.get(key)?.said.set(entry.sequence, true);
    for (const key of entry.hiddenOff ?? []) kinds.get(key)?.said.set(entry.sequence, false);
  }
  const here = site ?? '';
  if (sequence) sequencesOf.set(here, (sequencesOf.get(here) ?? new Set()).add(sequence));
  for (const kind of hidden) {
    const known = held(here).get(kind.key);
    const said = known?.said ?? new Map<string, boolean>();
    if (sequence && kind.mode !== 'local') said.set(sequence, !kind.off);
    held(here).set(kind.key, { kind, said });
  }

  const row = (origin: string, key: string, kind: HiddenKind, said: Map<string, boolean>) => {
    const live = origin === here ? hidden.find(one => one.key === key) : undefined;
    const hiddenIn = kind.mode === 'local' ? [kind.owner ?? '']
      : kind.mode === 'optIn' ? [...said.entries()].filter(([, hid]) => hid).map(([name]) => name)
      : [...(sequencesOf.get(origin) ?? [])].filter(name => said.get(name) !== false);
    const listed = kind.mode === 'local' ? (kind.owner ? [[kind.owner, true] as const] : [])
      : [...said.entries()];
    const rowId = `hidden|${origin}|${key}`;
    return (
      <Fragment key={rowId}>
        <Row
          classes={['hiddenrow', live?.off ? 'off' : '']}
          columns={['remove']}
          source={kind.frame ? (kind.url ? socketName(kind.url) : 'frame') : (kind.method ?? 'GET')}
          sourceTitle={kind.url}
          way={kind.frame ? (kind.direction === 'out' ? '→' : '←') : ''}
          title={key}
          label={<span class="what">{kind.any ? kind.label ?? `everything on ${kind.url ?? 'a socket'}` : kind.label?.replace(/^\S+\s+/, '') ?? key}</span>}
          reading={<span class="meta">
            {kind.mode === 'local' ? 'Local' : kind.mode === 'optIn' ? 'Opt In' : 'Opt Out'} · {hiddenIn.length} use{hiddenIn.length === 1 ? '' : 's'}
          </span>}
          slots={live ? { remove: () => onClear(key) } : {}}
          titles={{ remove: 'delete this rule: what it matches is listed and compared again, in every sequence' }}
          open={open === rowId}
          onOpen={() => setOpen(open === rowId ? null : rowId)}
        >
          <div class="replace responsemode" onClick={(e: MouseEvent) => e.stopPropagation()}>
            {/* What the rule matches, as it was made. */}
            <ScopeRow label="matches">
              <span class="replvalue">
                {kind.any ? 'every message' : 'this kind'}
                {kind.url ? ` on ${kind.frame ? socketName(kind.url) : kind.url}` : ''}
                {kind.direction ? (kind.direction === 'in' ? ' · received' : ' · sent') : ''}
                {kind.method ? ` · ${kind.method}` : ''}
                {kind.step !== undefined ? ` · step ${kind.step + 1}` : ' · any step'}
              </span>
            </ScopeRow>
            <ScopeRow label="type">
              {RESPONSE_TYPES.map(([mode, word]) => (
                <Choice key={mode} on={kind.mode === mode} onPick={() => live && onMode(key, mode)}
                  title={mode === 'local' ? 'ignored in this sequence only'
                    : mode === 'optIn' ? 'ignored in the sequences that opt in'
                    : 'ignored in every sequence on the site that does not opt out'}>{word}</Choice>
              ))}
            </ScopeRow>
          </div>
        </Row>
        {open === rowId && listed.map(([name, hid]) => {
          const mine = live && kind.mode !== 'local' && name === sequence;
          return (
            <Row
              key={`${rowId}|${name}`}
              classes={['usedrow', hid ? '' : 'off']}
              columns={[]}
              source="sequence"
              label={<span class="what">{name}</span>}
              reading={<span class="meta">{hid ? 'ignored here' : 'compared here'}</span>}
              {...(mine ? {
                more: <button class="tool plain" onClick={() => onUse(key, !hid)}>{hid ? 'compare here' : 'ignore here'}</button>,
              } : {})}
              slots={{}}
              open={false}
              onOpen={() => {}}
            />
          );
        })}
      </Fragment>
    );
  };

  const origins = [...bySite.keys()].filter(origin => bySite.get(origin)!.size > 0)
    .sort((a, b) => (a === here ? -1 : b === here ? 1 : a.localeCompare(b)));
  const total = origins.reduce((sum, origin) => sum + bySite.get(origin)!.size, 0);
  return (
    <Fold title="Ignored" count={total} open={false}>
      {!origins.length && (
        <p class="sechint">None. The eye, or Ignore, on a traffic row leaves traffic out of the list and out of comparisons.</p>
      )}
      {origins.map(origin => (
        <Fold key={origin} level="group" title={origin ? new URL(origin).host : 'no site'} count={bySite.get(origin)!.size}>
          <ol class="activitycards">
            {[...bySite.get(origin)!.entries()].map(([key, one]) => row(origin, key, one.kind, one.said))}
          </ol>
        </Fold>
      ))}
    </Fold>
  );
}

/**
 * The crossing a saved response answers, rebuilt from what it matches on, so
 * the editor a traffic row opens can open on the response alone.
 */
function responseEvent(rule: BoundaryRule): BoundaryEvent {
  return {
    id: `response:${rule.key}`, at: 0, owned: false,
    kind: rule.frame ? 'frame' : 'request',
    url: rule.url ?? rule.key,
    ...(rule.frame ? { direction: rule.direction ?? 'in' } : { method: rule.method ?? 'GET' }),
    ...(rule.status ? { status: Number(rule.status) } : {}),
    ...(rule.recorded !== undefined ? { preview: rule.recorded } : {}),
  } as BoundaryEvent;
}

/** A sequence's use of a response: not at all, at every step, or at these step indexes. */
type Use = 'none' | 'all' | number[];


/**
 * The payloads saved by name, each a row: its name, its size, and on opening
 * it its content to change. Saving one re-arms every replacement serving it.
 */
export function SavedPayloads({ base }: { base: string }) {
  const [saved, setSaved] = useState<Array<{ name: string; bytes: number }>>([]);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => fetch(`${base}/payloads`).then(res => res.json()).then(setSaved).catch(() => {});
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [base]);
  return (
    <Fold title="Saved payloads" count={saved.length}>
    {!saved.length
      ? <p class="sechint">None yet. Save as payload… in a replacement keeps one here.</p>
      : <ol class="activitycards payloads">
      {saved.map(one => (
        <Row
          key={one.name}
          classes={['payloadrow']}
          columns={['remove']}
          source="payload"
          label={<span class="what">{one.name}</span>}
          reading={<span class="meta">{bytes(one.bytes)}</span>}
          slots={{
            remove: () => void fetch(`${base}/payloads/delete`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: one.name }),
            }).then(() => { if (open === one.name) setOpen(null); return refresh(); }),
          }}
          titles={{ remove: 'delete this payload; replacements serving it keep what they last read' }}
          open={open === one.name}
          onOpen={() => setOpen(open === one.name ? null : one.name)}
        >
          <PayloadEditor base={base} name={one.name} onSaved={() => void refresh()} />
        </Row>
      ))}
    </ol>}
    </Fold>
  );
}

/** One saved payload's content, changed in place and saved under its own name. */
function PayloadEditor({ base, name, onSaved }: { base: string; name: string; onSaved: () => void }) {
  const [held, setHeld] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [said, setSaid] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetch(`${base}/payloads/read?name=${encodeURIComponent(name)}`)
      .then(res => (res.ok ? res.text() : ''))
      .then(content => {
        if (!live) return;
        const shown = formatJson(content) ?? content;
        setHeld(shown);
        setText(shown);
      });
    return () => { live = false; };
  }, [base, name]);
  if (held === undefined) return <p class="quiet">reading…</p>;
  const changed = text !== held;
  const save = async () => {
    const res = await fetch(`${base}/payloads/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, content: text }),
    }).catch(() => undefined);
    const answer = res ? await res.json().catch(() => ({})) as { failure?: string } : { failure: 'the bench did not answer' };
    if (answer.failure) { setSaid(answer.failure); return; }
    setHeld(text);
    setSaid('saved · replacements serving it now serve this');
    onSaved();
  };
  return (
    <div class="body" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <GrowBox value={text} onInput={(next) => { setText(next); setSaid(undefined); }} />
      <div class="bodyfoot">
        <span class="footsummary">{said ?? `${bytes(text.length)}${changed ? ' · not saved' : ''}`}</span>
        <span class="grow" />
        <span class="footactions">
          <button class="tool plain" disabled={!changed} onClick={() => void save()}>Save</button>
          <button class="tool plain" disabled={!changed} onClick={() => { setText(held); setSaid(undefined); }}>Revert</button>
        </span>
      </div>
    </div>
  );
}
