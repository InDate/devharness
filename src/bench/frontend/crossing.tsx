/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { BoundaryEvent, BoundaryRule } from '../wire.js';

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

/** Status, size, how long it took, what it was - in that order of interest. */
export function describe(event: BoundaryEvent): string {
  const parts: string[] = [];
  if (event.heldAs) parts.push(event.heldAs);
  else if (event.kind === 'request') parts.push(String(event.status ?? ''));
  if (event.open) parts.push('open');
  parts.push(bytes(event.size));
  if (event.durationMs !== undefined && event.durationMs > 0) parts.push(`${event.durationMs} ms`);
  if (event.contentType) parts.push(event.contentType);
  return parts.filter(Boolean).join(' · ');
}

export const isFrame = (event: BoundaryEvent) => event.kind === 'frame';

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

export function keyOf(event: BoundaryEvent): string {
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
      const entries = Object.entries(parsed);
      const pair = ([key, value]: [string, unknown]) => `"${key}":${JSON.stringify(value)}`;
      const named = entries.find(([key, value]) => NAMING_KEYS.includes(key) && names(value));
      if (named) return pair(named);
      const stable = entries.find(([, value]) => names(value));
      if (stable) return pair(stable);
      for (const entry of entries) {
        const [, value] = entry;
        if (typeof value === 'string' && !/^\d+$/.test(value)) return pair(entry);
      }
      const [first] = Object.keys(parsed);
      if (first) return `"${first}"`;
    }
    if (Array.isArray(parsed)) {
      const named = parsed.find(
        (part): part is string => typeof part === 'string' && !/^\d+$/.test(part));
      if (named !== undefined) return JSON.stringify(named);
    }
  } catch { /* not JSON: the payload itself is all there is to match on */ }
  return text.slice(0, 40);
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

export interface RuleActions {
  /**
   * Serve this instead of the server, with whatever the box holds.
   *
   * `match` is what a later crossing is recognised by - a path for a request,
   * a substring of the payload for a frame. It is separate from the body
   * because a frame edited into something else would otherwise stop matching
   * itself, and because only a person can say which part of a payload names it.
   */
  answer: (event: BoundaryEvent, body: string, status: string, match: string) => void;
  /** Never let it leave the browser. */
  block: (event: BoundaryEvent) => void;
  /** Keep this kind out of the list. Changes no traffic. */
  hide: (event: BoundaryEvent) => void;
  /** Drop whatever rule stands against it. */
  clear: (event: BoundaryEvent) => void;
  /** Hand the row and its reading to the session. */
  report?: (event: BoundaryEvent) => void;
  /** Tell a step to hold open until this arrives. Absent where no step owns it. */
  waitFor?: (event: BoundaryEvent) => void;
  /** The step that would wait, for the button to name it. */
  waitStep?: number;
}

/**
 * The payload, as it will be served rather than as it crossed.
 *
 * A frame keeps both: the recorded text is what a later frame is matched on,
 * and the box below it is what goes out in its place. Held apart, because a
 * frame edited into something else would stop matching itself.
 */
export function CrossingBody({ event, base, rule, actions }: {
  event: BoundaryEvent;
  base: string;
  rule?: BoundaryRule;
  actions?: RuleActions;
}) {
  const [recorded, setRecorded] = useState('reading…');
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [match, setMatch] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`${base}/proxy/body?id=${encodeURIComponent(event.id)}`)
      .then(res => res.text())
      .then(text => { if (live) setRecorded(text || ''); })
      .catch(() => { if (live) setRecorded(''); });
    return () => { live = false; };
  }, [event.id, base]);

  if (!actions) {
    return <div class="body"><div class="payload">{recorded || '(nothing kept for this one)'}</div></div>;
  }

  const served = rule?.verb === 'answer' ? rule : undefined;
  const nowBody = draft ?? served?.body ?? recorded;
  const nowStatus = status ?? served?.status ?? String(event.status ?? '200');
  const base0 = served ?? { body: recorded, status: String(event.status ?? '200') };
  const dirty = nowBody !== base0.body || nowStatus !== base0.status;

  const nowMatch = match ?? rule?.key ?? keyOf(event);
  const commit = () => {
    actions.answer(event, nowBody, nowStatus, nowMatch);
    setDraft(null);
    setStatus(null);
    setMatch(null);
  };

  return (
    <div class="body">
      <div class="edit">
        <div class="editrow">
          {isFrame(event)
            ? <>
                <span>when a frame carries</span>
                {/* Editable, because the default is derived: a payload names
                    itself in a different place in every app, and a match that
                    keeps a clock or an id never fires twice. */}
                <input
                  class={nowMatch !== (rule?.key ?? keyOf(event)) ? 'match dirty' : 'match'}
                  value={nowMatch}
                  title={`the whole payload was ${event.preview ?? '(binary)'}`}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onInput={(e: Event) => setMatch((e.target as HTMLInputElement).value)}
                />
              </>
            : <>
                <span>answer with</span>
                <input
                  class={dirty ? 'status dirty' : 'status'}
                  value={nowStatus}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onInput={(e: Event) => setStatus((e.target as HTMLInputElement).value)}
                />
                <span class="quiet">recorded {event.status ?? '—'}</span>
              </>}
        </div>
        <div class="editrow">
          <span class="quiet">
            {isFrame(event)
              ? 'a later frame carrying that text is answered with the box below'
              : `every ${event.method ?? 'GET'} to ${nowMatch} is answered with the box below`}
          </span>
        </div>
        <textarea
          class={dirty ? 'dirty' : ''}
          spellcheck={false}
          value={nowBody}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          onInput={(e: Event) => setDraft((e.target as HTMLTextAreaElement).value)}
        />
        <div class="state">
          {dirty
            ? <>
                <span class="pend">
                  not saved · {bytes(nowBody.length)}
                  {served ? ` · answers ${bytes(served.body?.length ?? 0)}` : ` · recorded ${bytes(recorded.length)}`}
                </span>
                <button class="tool" onClick={(e: MouseEvent) => {
                  e.stopPropagation(); setDraft(null); setStatus(null);
                }}>REVERT</button>
              </>
            : <span class="ok">
                {rule?.verb === 'block' ? 'never leaves the browser'
                  : served ? `answers ${isFrame(event) ? '' : served.status + ' · '}${bytes(served.body?.length ?? 0)}`
                  : 'as recorded — the real request goes out'}
              </span>}
        </div>
      </div>

      <div class="bodyrow">
        {rule?.verb === 'block'
          ? <>
              <button class="tool done">NEVER SENT ✓</button>
              <button class="tool plain" onClick={(e: MouseEvent) => { e.stopPropagation(); actions.clear(event); }}>
                LET IT THROUGH
              </button>
            </>
          : served
            ? <>
                {dirty
                  ? <button class="save" onClick={(e: MouseEvent) => { e.stopPropagation(); commit(); }}>
                      UPDATE THE ANSWER
                    </button>
                  : <button class="tool done">ANSWERS THIS ✓</button>}
                <button class="tool plain" onClick={(e: MouseEvent) => { e.stopPropagation(); actions.clear(event); }}>
                  LET IT THROUGH
                </button>
              </>
            : <>
                <button class={dirty ? 'save' : 'tool'} onClick={(e: MouseEvent) => { e.stopPropagation(); commit(); }}>
                  {dirty ? 'ANSWER WITH MY EDIT' : 'ANSWER WITH THIS'}
                </button>
                <button class="tool" onClick={(e: MouseEvent) => { e.stopPropagation(); actions.block(event); }}>
                  NEVER SEND IT
                </button>
              </>}
        {actions.waitFor && actions.waitStep !== undefined && (
          <button class="tool" onClick={(e: MouseEvent) => { e.stopPropagation(); actions.waitFor!(event); }}>
            STEP {actions.waitStep + 1} SHOULD WAIT FOR THIS
          </button>
        )}
        {actions.report && (
          <button class="tool" onClick={(e: MouseEvent) => { e.stopPropagation(); actions.report!(event); }}>
            SEND TO SESSION
          </button>
        )}
      </div>
    </div>
  );
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
  onMenu,
}: {
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
  const answered = rule?.verb === 'answer';
  const blocked = rule?.verb === 'block';
  const edited = answered && rule?.body !== rule?.recorded;
  const served = blocked ? 'never sent'
    : answered ? `${isFrame(event) ? '' : (rule?.status ?? '') + ' · '}${bytes(rule?.body?.length ?? 0)}`
    : null;

  return (
    <li
      class={[
        'crossed',
        stale ? 'stale' : '',
        event.owned ? 'caused' : 'unowned',
        answered || blocked ? 'answers' : '',
        event.verdict === 'background' || event.verdict === 'unknown' ? 'ruled' : '',
        open ? 'open' : '',
      ].filter(Boolean).join(' ')}
      onContextMenu={onMenu
        ? (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }
        : undefined}
    >
      <div class="crossedhead" onClick={onOpen}>
        <span class="dir" title={event.url}>
          {event.kind === 'request' ? (event.method ?? 'GET') : socketName(event.url)}
        </span>
        <span class="way">{event.kind === 'request' ? '' : (event.direction === 'out' ? '→' : '←')}</span>
        <span class="what" title={event.kind === 'request' ? event.url : undefined}>
          {event.kind === 'request'
            ? <><span class="wide">{event.url}</span><span class="lean">{lean(event.url) || '/'}</span></>
            : (event.preview ?? event.url)}
        </span>
        {repeats !== undefined && repeats > 1 && (
          <span class="repeat" title={every ?? `${repeats} of this message`}>
            ×{repeats}{every ? ` ${every}` : ''}
          </span>
        )}
        {(answered || blocked) && (
          <span class="tag">{blocked ? 'never sent' : (edited ? 'answers, edited' : 'answers')}</span>
        )}
        {stale && <span class="stale" title="staged, and this pass has not produced it">not this pass</span>}
        <span class={`meta ${event.heldAs || served ? 'held' : ((event.status ?? 0) >= 400 ? 'bad' : '')}`}>
          {served ?? describe(event)}
        </span>
        {/* Beside the app the row has no width for these, and the payload is
            what it is found by. Grouped so the narrow rule can take them out
            of the line and hover can put them back over the row below, which
            leaves the row's height alone: a row that grew under the pointer
            would push the rows beneath it out from under the pointer. */}
        <span class="shaved">
          <span class="reading">{event.verdict ?? [event.level, event.root].filter(Boolean).join(' ')}</span>
          {/* Stability is a count, never a colour: the two hues are spoken for. */}
          {seen && seen.runs > 1 && !answered && !blocked && (
            <span
              class={seen.in < seen.runs ? 'seen moves' : 'seen'}
              title={seen.in < seen.runs
                ? `crossed in ${seen.in} of the ${seen.runs} passes still held - not settled`
                : `crossed in every one of the ${seen.runs} passes still held`}
            >{seen.in}/{seen.runs}</span>
          )}
        </span>
        {actions && (
          <button
            class="kill"
            title="not interested — keep this kind out of the list"
            onClick={(e: MouseEvent) => { e.stopPropagation(); actions.hide(event); }}
          >×</button>
        )}
      </div>
      {extra}
      {open && <CrossingBody event={event} base={base} rule={rule} actions={actions} />}
    </li>
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
export interface RuleEdit {
  key: string;
  body: string;
  status: string;
  /** null drops the constraint, so the step no longer narrows the match. */
  step: number | null;
  method: string | null;
  url: string | null;
  direction: 'out' | 'in' | null;
}

/**
 * One constraint the rule carries, and the width it costs to drop it.
 *
 * A pin answers a crossing that satisfies every constraint on it, and the
 * narrowest matching pin is the one that answers. So each of these is both
 * what the rule is recognised by and where it sits in that order: dropping one
 * widens the rule and lowers it, which is how one rule comes to answer a
 * crossing another was staged for.
 */
function Bound({ label, held, off, onDrop, onBind, dim = true, children }: {
  label: string;
  held: boolean;
  /** What the rule matches once the constraint is dropped. */
  off: string;
  onDrop: () => void;
  /** Put the constraint back on the value the control still shows. */
  onBind: () => void;
  /**
   * Whether dropping the constraint dims the value.
   *
   * It does where the value is one of many and the rule stops reading it. A
   * control that enumerates every value instead shows them all matching, and
   * dimming those would read as none of them matching.
   */
  dim?: boolean;
  /** The control the value is chosen with, which binds the constraint. */
  children: preact.JSX.Element;
}) {
  return (
    <div class="bound">
      <span class="boundlabel">{label}</span>
      {/* Dropped, the control is dimmed rather than disabled. A disabled one
          takes itself out of reach, and the value it holds is the only thing
          that puts the constraint back - which is the dead end this pair was
          built to remove. Reaching for it binds it again. */}
      <span
        class={held ? 'boundvalue on' : (dim ? 'boundvalue off' : 'boundvalue off whole')}
        onFocusCapture={held ? undefined : () => onBind()}
        onMouseDownCapture={held ? undefined : () => onBind()}
      >{children}</span>
      <button
        class={held ? 'boundpick' : 'boundpick on'}
        onClick={(e: MouseEvent) => { e.stopPropagation(); onDrop(); }}
      >{off}</button>
    </div>
  );
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

type Of = 'step' | 'method' | 'url' | 'direction';

function RuleBody({ rule, choices, onSet }: {
  rule: BoundaryRule;
  choices: RuleChoices;
  onSet: (rule: BoundaryRule, next: RuleEdit) => void;
}) {
  const [key, setKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Per constraint: absent leaves it as the rule carries it, null drops it,
  // and a string binds it to that value, which need not be the recorded one.
  const [bound, setBound] = useState<Partial<Record<Of, string | null>>>({});

  const stands = (of: Of) => (of in bound ? bound[of] !== null : rule[of] !== undefined);
  // The recorded value outlives the constraint being dropped, so a row keeps
  // offering the binding the rule was staged with after it has been widened.
  const recorded = (of: Of) => String(rule[of] ?? rule.staged?.[of] ?? '');
  const valueOf = (of: Of) => {
    const picked = bound[of];
    return picked === undefined || picked === null ? recorded(of) : picked;
  };
  // Binding through the value control, so choosing a value arms the
  // constraint in the one gesture rather than needing it turned on first.
  const bind = (of: Of, value: string) => setBound({ ...bound, [of]: value });
  const drop = (of: Of) => setBound({ ...bound, [of]: null });

  // The value the rule is bound to is always among the options. Left out of
  // the list, a select falls back to showing nothing, and a rule bound to a
  // step reads as one bound to none.
  const steps = choices.steps.some(step => String(step.index) === recorded('step'))
    || recorded('step') === ''
    ? choices.steps
    : [...choices.steps, { index: Number(recorded('step')), label: 'recorded here' }]
        .sort((a, b) => a.index - b.index);

  const nowKey = key ?? rule.key;
  const nowBody = draft ?? rule.body ?? '';
  const nowStatus = status ?? rule.status ?? '200';
  const armed = (of: Of) => {
    const value = valueOf(of);
    if (!stands(of) || value === '') return null;
    if (of !== 'step') return value;
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 ? value : null;
  };
  const moved = (['step', 'method', 'url', 'direction'] as const).some(of => {
    const was = rule[of] === undefined ? null : String(rule[of]);
    return armed(of) !== was;
  });
  const dirty = nowKey !== rule.key || nowBody !== (rule.body ?? '')
    || nowStatus !== (rule.status ?? '200') || moved;

  const commit = () => {
    const step = armed('step');
    const direction = armed('direction');
    onSet(rule, {
      key: nowKey, body: nowBody, status: nowStatus,
      step: step === null ? null : Number(step),
      method: armed('method'),
      url: armed('url'),
      direction: direction === 'out' || direction === 'in' ? direction : null,
    });
    setKey(null);
    setDraft(null);
    setStatus(null);
    setBound({});
  };

  return (
    <div class="body">
      <div class="edit">
        <div class="editrow">
          {rule.frame
            ? <>
                <span>when a frame carries</span>
                <input
                  class={nowKey !== rule.key ? 'match dirty' : 'match'}
                  value={nowKey}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onInput={(e: Event) => setKey((e.target as HTMLInputElement).value)}
                />
                {rule.matchedAs && (
                  <span class="quiet" title={rule.matchedAs === 'field'
                    ? 'one "key":value pair - compared against the frame\'s top-level JSON field, by value'
                    : 'anything else - matched as characters anywhere in the payload'}>
                    {rule.matchedAs === 'field' ? 'as a field' : 'as text'}
                  </span>
                )}
              </>
            : <>
                <span>answer with</span>
                <input
                  class={nowStatus !== (rule.status ?? '200') ? 'status dirty' : 'status'}
                  value={nowStatus}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onInput={(e: Event) => setStatus((e.target as HTMLInputElement).value)}
                />
                <span class="quiet">on {nowKey}</span>
              </>}
        </div>
        {/* Which rows appear follows the kind of crossing the rule answers,
            not the constraints it happens to carry: a rule staged from the
            live stream carries no step, and a row only for what was recorded
            leaves that rule answering at every position with no way to bind
            it to one. */}
        <div class="binds">
          <Bound
            label="step"
            held={stands('step')}
            off="any step"
            onDrop={() => drop('step')}
            onBind={() => bind('step', valueOf('step'))}
          >
            <select
              class="boundin"
              value={valueOf('step')}
              onClick={(e: MouseEvent) => e.stopPropagation()}
              onChange={(e: Event) => bind('step', (e.target as HTMLSelectElement).value)}
            >
              <option value="">pick a step</option>
              {steps.map(step => (
                <option key={step.index} value={String(step.index)}>
                  step {step.index + 1}{step.label ? ` · ${step.label}` : ''}
                </option>
              ))}
            </select>
          </Bound>
          {rule.frame
            ? <>
                <Bound
                  label="socket"
                  held={stands('url')}
                  off="any socket"
                  onDrop={() => drop('url')}
                  onBind={() => bind('url', valueOf('url'))}
                >
                  <input
                    class="boundin"
                    list="boundsockets"
                    placeholder="any part of the socket's URL"
                    value={valueOf('url')}
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                    onInput={(e: Event) => bind('url', (e.target as HTMLInputElement).value)}
                  />
                </Bound>
                <Bound
                  label="direction"
                  held={stands('direction')}
                  off="either way"
                  onDrop={() => drop('direction')}
                  onBind={() => bind('direction', valueOf('direction'))}
                  dim={false}
                >
                  {/* A frame goes one way or the other, so these two are the
                      whole of what a direction can be. Dropped, the rule
                      matches both, and both read as matching - which is what
                      `either way` names. Clicking one narrows to it. */}
                  <span class="boundways">
                    {([['out', 'sent'], ['in', 'received']] as const).map(([way, said]) => (
                      <button
                        key={way}
                        class={!stands('direction') || valueOf('direction') === way
                          ? 'boundpick on' : 'boundpick'}
                        onClick={(e: MouseEvent) => { e.stopPropagation(); bind('direction', way); }}
                      >{said}</button>
                    ))}
                  </span>
                </Bound>
              </>
            : <Bound
                label="method"
                held={stands('method')}
                off="any verb"
                onDrop={() => drop('method')}
                onBind={() => bind('method', valueOf('method'))}
              >
                <input
                  class="boundin"
                  list="boundmethods"
                  placeholder="the verb it crossed with"
                  value={valueOf('method')}
                  onClick={(e: MouseEvent) => e.stopPropagation()}
                  onInput={(e: Event) => bind('method', (e.target as HTMLInputElement).value.toUpperCase())}
                />
              </Bound>}
          {/* One rule body is open at a time, so these are named rather than
              keyed per rule. */}
          <datalist id="boundsockets">
            {choices.sockets.map(url => <option key={url} value={url}>{socketName(url)}</option>)}
          </datalist>
          <datalist id="boundmethods">
            {choices.methods.map(verb => <option key={verb} value={verb} />)}
          </datalist>
        </div>
        <div class="editrow">
          <span class="quiet">
            {rule.frame
              ? 'a later frame satisfying every one of these is answered with the box below'
              : `a request satisfying every one of these is answered with the box below`}
          </span>
        </div>
        <textarea
          class={dirty ? 'dirty' : ''}
          spellcheck={false}
          value={nowBody}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          onInput={(e: Event) => setDraft((e.target as HTMLTextAreaElement).value)}
        />
        {rule.recorded !== undefined && (
          <div class="editrow">
            <span class="quiet" title={rule.recorded}>
              replaces {bytes(rule.recorded.length)} the server sent: {rule.recorded.slice(0, 80)}
            </span>
          </div>
        )}
        <div class="state">
          {dirty
            ? <>
                <span class="pend">
                  not saved · {bytes(nowBody.length)} · serves {bytes(rule.body?.length ?? 0)}
                </span>
                <button class="tool" onClick={(e: MouseEvent) => {
                  e.stopPropagation(); setKey(null); setDraft(null); setStatus(null);
                }}>REVERT</button>
              </>
            : <span class="ok">serves {bytes(nowBody.length)}</span>}
        </div>
      </div>

      <div class="bodyrow">
        {dirty
          ? <button class="save" onClick={(e: MouseEvent) => { e.stopPropagation(); commit(); }}>
              UPDATE THE ANSWER
            </button>
          : <button class="tool done">ANSWERS THIS ✓</button>}
      </div>
    </div>
  );
}

/**
 * What this sequence will do next time it runs.
 *
 * One line per decision, never one per gesture: several actions land on one
 * key over a session - a variant hidden, then the surviving one answered - and
 * listed in the order they were made they contradict each other. The store
 * keeps one rule per key, so this is already reconciled by the time it is read.
 *
 * The events are not here and are not written. They are a reading of one pass;
 * the rule is what every later pass should do.
 */
export function OnReplay({ rules, waits, choices, hidden, said, onShowHidden, onClear, onSave, onSet }: {
  rules: BoundaryRule[];
  waits: Array<{ step: number; count: number }>;
  /** What the constraints in an open rule can be bound to. */
  choices: RuleChoices;
  /** Whether the hidden kinds are listed rather than folded away. */
  hidden: boolean;
  said: string;
  onShowHidden: () => void;
  onClear: (key: string) => void;
  onSave: () => void;
  /** Re-arm one rule under a changed match, body, status or set of bounds. */
  onSet?: (rule: BoundaryRule, next: RuleEdit) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = hidden ? rules : rules.filter(rule => rule.verb !== 'hide');
  const hiddenCount = rules.filter(rule => rule.verb === 'hide').length;
  const answers = rules.filter(rule => rule.verb === 'answer').length;
  const blocks = rules.filter(rule => rule.verb === 'block').length;

  return (
    <section class="onreplay">
      <div class="onreplayhead">
        <h2>ON REPLAY</h2>
        {choices.forSequence && <span class="target">{choices.forSequence}</span>}
        <span class="hint grow">
          What {choices.forSequence ?? 'this sequence'} will do next time it runs. The events
          stay in the proxy; only these rules are written.
        </span>
        {hiddenCount > 0 && (
          <button class="tool" onClick={onShowHidden}>
            {hidden ? 'FOLD HIDDEN AWAY' : `SHOW ${hiddenCount} HIDDEN`}
          </button>
        )}
      </div>

      {shown.length === 0 && waits.length === 0
        ? <p class="hint">nothing yet — delete the noise, choose what answers</p>
        : <ol class="rules">
            {waits.map(wait => (
              <li key={`wait${wait.step}`}>
                <span class="verb keep">wait for</span>
                <span class="target">step {wait.step + 1}</span>
                <span class="hint">{wait.count} to arrive before moving on</span>
              </li>
            ))}
            {shown.map(rule => (
              <li key={rule.key} class={open === rule.key ? 'open' : ''}>
                <div
                  class={rule.verb === 'answer' && onSet ? 'rulehead opens' : 'rulehead'}
                  onClick={rule.verb === 'answer' && onSet
                    ? () => setOpen(open === rule.key ? null : rule.key)
                    : undefined}
                >
                  <span class={rule.verb === 'hide' ? 'verb quiet' : 'verb'}>{rule.verb}</span>
                  <span class="target" title={rule.key}>{rule.label ?? rule.key}</span>
                  {/* The count stays on the line at every width: a rule that
                      stopped matching reads `never fired` here, and that is the
                      one thing on the row that calls for an edit. */}
                  {rule.hits !== undefined && rule.verb !== 'hide' && (
                    <span class={rule.hits > 0 ? 'hits' : 'hits cold'}>
                      {rule.hits > 0 ? `used ${rule.hits}×` : 'never fired'}
                    </span>
                  )}
                  <span class="shaved">
                    {rule.step !== undefined && rule.verb !== 'hide' && (
                      <span class="quiet" title="answers only while this step runs">step {rule.step + 1}</span>
                    )}
                    <span class="hint">
                      {rule.verb === 'answer'
                        ? `${rule.frame ? '' : (rule.status ?? '200') + ' · '}${bytes(rule.body?.length ?? 0)}`
                          + (rule.body !== rule.recorded ? ', edited' : '')
                        : rule.verb === 'block' ? 'never leaves the browser' : 'kept out of the list'}
                    </span>
                  </span>
                  <button
                    class="drop"
                    title="drop this rule"
                    onClick={(e: MouseEvent) => { e.stopPropagation(); onClear(rule.key); }}
                  >×</button>
                </div>
                {open === rule.key && rule.verb === 'answer' && onSet && (
                  <RuleBody rule={rule} choices={choices} onSet={onSet} />
                )}
              </li>
            ))}
          </ol>}

      <div class="onreplayfoot">
        <button class="save" onClick={onSave}>SAVE ONTO THE SEQUENCE</button>
        <span class="hint grow">
          {answers} answered · {blocks} blocked · {hiddenCount} hidden · {waits.length} waiting
        </span>
        {said && <span class="saved">{said}</span>}
      </div>
    </section>
  );
}
