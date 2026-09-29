/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CrossingRow, choicesIn, socketName, keyOf, type RuleActions } from './crossing.js';
import { useActivity } from './activity.js';
import type { BoundaryEvent, BoundaryTotals, QueuedView } from '../wire.js';
import { waited } from './sequence.js';
import { useGoToTarget } from './goto.js';
import { useEscape } from './escape.js';
import { Fold, Row } from './row.js';

export type { BoundaryEvent, BoundaryState, BoundaryTotals } from '../wire.js';
export { socketName } from './crossing.js';

interface Filter {
  field: string;
  label: string;
  value: string;
  mode: 'on' | 'out';
}

/** The value a filter compares against, for one event. */
function fieldValue(event: BoundaryEvent, field: string): string | undefined {
  if (field === 'socket') return socketName(event.url);
  if (field === 'shape') return event.evidence?.shape;
  if (field === 'level') return event.level;
  if (field === 'root') return event.root;
  if (field === 'direction') {
    return event.kind === 'request' ? undefined : (event.direction === 'out' ? 'sent' : 'received');
  }
  if (field === 'method') return event.kind === 'request' ? (event.method ?? 'GET') : undefined;
  if (field === 'status') return event.kind === 'request' ? String(event.status ?? '') : undefined;
  if (field === 'kind') return event.kind;
  return undefined;
}

/** What a row can be filtered by, read off the row itself. */
function filterableFields(event: BoundaryEvent): Array<{ field: string; label: string; value: string }> {
  const fields: Array<{ field: string; label: string; value: string }> = [];
  const add = (field: string, label: string) => {
    const value = fieldValue(event, field);
    if (value !== undefined && value !== '') fields.push({ field, label, value });
  };
  add('socket', event.kind === 'request' ? 'host' : 'socket');
  add('shape', 'shape');
  add('level', 'level');
  add('root', 'started by');
  add('direction', 'direction');
  add('method', 'method');
  add('status', 'status');
  add('kind', 'kind');
  return fields;
}

/**
 * Repeats collapse into one line.
 *
 * A socket sending the same message every two seconds is one fact about the
 * app, and twenty rows of it buries the traffic a step actually caused. The
 * group carries the count and the period, and opens to its own frames.
 */
interface Group {
  key: string;
  newest: BoundaryEvent;
  /** When this kind was first seen, which is what keeps it in place. */
  firstAt: number;
  events: BoundaryEvent[];
  periodMs?: number;
}

/**
 * Repeats often enough to sit above the stream rather than in it.
 *
 * Three is where a pair stops being a coincidence. Below it a group stays in
 * the stream and reads in the order it happened; at three it moves once, and
 * then holds its place however often it ticks.
 */
const REPEATS_AT = 3;

/**
 * How long a kind may go without arriving before it stops counting as repeating.
 *
 * A socket that closed is not still beating, so its group drops back into the
 * stream at the time it last arrived. Measured against the group's own period
 * where it has one - a message every thirty seconds is not stale at ten - and
 * against a flat window where it does not.
 */
const QUIET_FOR = 6000;

function stillArriving(made: Group, now: number): boolean {
  const gap = now - made.newest.at;
  return made.periodMs ? gap < Math.max(made.periodMs * 3, 3000) : gap < QUIET_FOR;
}

function group(events: BoundaryEvent[]): Group[] {
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const event of events) {
    // A request is its own row: two calls to one endpoint are two facts, where
    // two frames of one shape on one socket are the same fact twice.
    const key = event.kind === 'request'
      ? event.id
      : `${event.url}|${event.direction}|${event.evidence?.shape ?? event.size}`;
    const held = byKey.get(key);
    if (held) {
      held.events.push(event);
      if (event.at > held.newest.at) held.newest = event;
      if (event.at < held.firstAt) held.firstAt = event.at;
      continue;
    }
    const made: Group = { key, newest: event, firstAt: event.at, events: [event] };
    byKey.set(key, made);
    groups.push(made);
  }
  for (const made of groups) {
    if (made.events.length < 3) continue;
    const times = made.events.map(e => e.at).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Regular enough to call a period: every gap within a quarter of the mean.
    if (mean > 0 && gaps.every(gap => Math.abs(gap - mean) < mean * 0.25)) {
      made.periodMs = Math.round(mean);
    }
  }
  return groups;
}

function cadence(ms: number): string {
  return ms >= 1000 ? `every ${(ms / 1000).toFixed(1)}s` : `every ${ms}ms`;
}

/**
 * Everything that crossed, in the rows the UI tab lists under each step: the
 * same card, the same actions, the same hidden kinds. Repeats still arriving
 * sit above the stream, counted in place.
 */
export function Traffic({ base }: { base: string }): preact.JSX.Element {
  const activity = useActivity(base, undefined);
  const state = activity.boundary;
  const [filters, setFilters] = useState<Filter[]>([]);
  const [menu, setMenu] = useState<{ event: BoundaryEvent; x: number; y: number } | null>(null);
  const [report, setReport] = useState<{ event: BoundaryEvent; alike: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEscape(open !== null, () => setOpen(null));
  useEscape(menu !== null, () => setMenu(null));
  useEscape(report !== null, () => setReport(null));
  const [said, setSaid] = useState('');
  const note = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setReport(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', key);
    };
  }, []);

  const passes = useCallback((event: BoundaryEvent) => {
    if (activity.isHidden(event)) return false;
    for (const filter of filters) {
      if (filter.mode === 'out' && fieldValue(event, filter.field) === filter.value) return false;
    }
    const only = filters.filter(f => f.mode === 'on');
    return only.length === 0 || only.every(f => fieldValue(event, f.field) === f.value);
  }, [filters, activity.isHidden]);

  const { repeating, stream } = useMemo(() => {
    const groups = group((state?.events ?? []).filter(passes));
    const now = Date.now();
    const live = (made: Group) => made.events.length >= REPEATS_AT && stillArriving(made, now);
    return {
      // Ordered by when each kind first appeared, so a group that ticks does
      // not climb over the others every time it does.
      repeating: groups.filter(live).sort((a, b) => a.firstAt - b.firstAt),
      // A kind that has gone quiet rejoins the stream at the time it last
      // arrived, which is where it belongs once it is a thing that happened
      // rather than a thing that is happening.
      stream: groups.filter(made => !live(made)).sort((a, b) => b.newest.at - a.newest.at),
    };
  }, [state, passes]);

  // Step labels come from the proxy's own reading here, since this tab holds
  // no sequence state of its own.
  const actions: RuleActions = {
    ...activity.actions,
    choices: choicesIn(state?.events ?? [], state?.steps, state?.forSequence),
  };

  const sendReport = async (event: BoundaryEvent) => {
    const words = note.current?.value.trim() ?? '';
    const res = await fetch(
      `${base}/proxy/investigate?id=${encodeURIComponent(event.id)}&note=${encodeURIComponent(words)}`,
      { method: 'POST' });
    setSaid(await res.text());
    setTimeout(() => { setReport(null); setSaid(''); }, 1400);
  };

  if (!state) return <div class="hint">reading the traffic…</div>;
  if (!state.running) {
    return <div class="hint">this browser was not launched through a proxy</div>;
  }

  const rowFor = (made: Group) => (
    <CrossingRow
      key={made.key}
      event={made.newest}
      base={base}
      hidden={activity.wasHidden(made.newest)}
      rule={activity.ruleFor(made.newest)}
      seen={activity.stability.get(keyOf(made.newest))}
      repeats={made.events.length}
      cadence={made.periodMs ? cadence(made.periodMs) : undefined}
      open={open === made.key}
      onOpen={() => setOpen(open === made.key ? null : made.key)}
      actions={actions}
      onMenu={(x, y) => setMenu({ event: made.newest, x, y })}
    />
  );

  return (
    <div class="traffic">
      {/* The proxy's own controls - what it may reach, what it refuses, what
          it holds - are carried by the bar's panel, under every tab. */}
      <Totals totals={state.totals} />
      {filters.length > 0 && (
        <div class="filters">
          {filters.map(filter => (
            <span class={`chip ${filter.mode}`} key={`${filter.field}${filter.value}${filter.mode}`}>
              {(filter.mode === 'on' ? 'only ' : 'not ') + filter.label + ' ' + filter.value}
              <button
                title="remove this filter"
                onClick={() => setFilters(filters.filter(f => f !== filter))}
              >×</button>
            </span>
          ))}
        </div>
      )}
      {(state.holding || (state.queued?.length ?? 0) > 0) && (
        <Waiting base={base} queued={state.queued ?? []} />
      )}
      {repeating.length > 0 && (
        <section class="repeating">
          {/* Headed as the home page heads its groups: the name, then the count. */}
          <div class="sectionhead" title="kinds still arriving, each counted in place on one row">
            repeating <span class="quiet">{repeating.length}</span>
          </div>
          <ol class="activitycards">{repeating.map(rowFor)}</ol>
        </section>
      )}
      <section class="crossed-all">
        <div class="sectionhead" title="everything else that crossed, newest first">
          crossed <span class="quiet">{stream.length}</span>
        </div>
        <ol class="activitycards">{stream.map(rowFor)}</ol>
      </section>
      {menu && (
        <Menu
          menu={menu}
          onFilter={(filter) => {
            setFilters(held => held.some(f =>
              f.field === filter.field && f.value === filter.value && f.mode === filter.mode)
              ? held : [...held, filter]);
            setMenu(null);
          }}
          onAsk={() => {
            const alike = (state?.events ?? []).filter(e =>
              e.evidence?.shape !== undefined && e.evidence.shape === menu.event.evidence?.shape).length;
            setReport({ event: menu.event, alike: alike || 1 });
            setMenu(null);
          }}
        />
      )}
      {report && (
        <Report
          event={report.event}
          alike={report.alike}
          said={said}
          note={note}
          onClose={() => { setReport(null); setSaid(''); }}
          onSend={() => sendReport(report.event)}
        />
      )}
    </div>
  );
}

/**
 * What the proxy is keeping while the traffic is held, oldest first.
 *
 * Each can be let through on its own while the rest stay held, so the page
 * receives one chosen message and its effect is read on a screen that nothing
 * else has moved. Recorded as it crosses, so it lands under the step that let
 * it through.
 */
function Waiting({ base, queued }: { base: string; queued: QueuedView[] }) {
  const here = useGoToTarget<HTMLElement>('waiting');
  const letThrough = (id: number) => void fetch(`${base}/hold/let`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  }).catch(() => {});
  return (
    <section class="waiting" id="waiting" ref={here}>
      <div class="sectionhead" title={queued.length
        ? 'held at the proxy, oldest first - let one through and the rest stay held'
        : 'the traffic is held, and nothing has arrived since'}>
        waiting <span class="quiet">{queued.length}</span>
      </div>
      {queued.length > 0 && (
        <ol class="activitycards">
          {queued.map(item => {
            let path = item.url;
            try { path = new URL(item.url).pathname; } catch { /* not a URL */ }
            return (
              <Row
                key={item.id}
                classes={['waitrow']}
                columns={['here']}
                source={item.kind === 'response' ? 'response' : item.direction === 'sent' ? 'sent' : 'received'}
                way={item.kind === 'response' ? undefined : item.direction === 'sent' ? '→' : '←'}
                label={<><span class="tag">{path}</span><span class="what">{item.preview ?? ''}</span></>}
                title={item.preview}
                reading={<span class="meta">{waited(item.ageMs)}</span>}
                slots={{ here: () => letThrough(item.id) }}
                titles={{ here: 'let this one through to the page; the rest stay held' }}
                open={false}
                onOpen={() => {}}
              />
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * What this browser may reach, and the way out of a scope that is too tight.
 *
 * An allow list is set by opening a sequence, which scopes the run to the app
 * it drives. Browsing without one needs the opposite, so the refusals are
 * listed beside the control that clears it: a host refused with nothing naming
 * it reads as the app being broken.
 */
/**
 * What the proxy may reach, what it refuses, and what it is holding.
 *
 * Carried by the bar's own panel rather than a screen: every one of these is a
 * property of the browser and the proxy it runs through, and none of them is a
 * reading of the tab that happens to be open.
 */
export function Scope({
  allowed, refusals, refusesWrites, refusedWrites, said, held, counts, onClear, onOpen, onRefuse, onAllow,
}: {
  allowed: string[];
  refusals: Array<{ host: string; count: number }>;
  /** Whether an unmatched write is answered 403 rather than forwarded. */
  refusesWrites: boolean;
  refusedWrites: number;
  said: string;
  /** Events the proxy is holding, which is what CLEAR drops. */
  held: number;
  /**
   * What crossed, split by whether a step caused it. `sinceRecording` scopes
   * it to a recording in progress, whose steps read their traffic from the
   * proxy as each closes - which is why CLEAR waits for the recording to end.
   */
  counts?: { caused: number; own: number; failed: number; sockets: number; sinceRecording: boolean };
  onClear: () => void;
  onOpen: () => void;
  onRefuse: (on: boolean) => void;
  /** Bound the proxy to these hosts. An empty list lets every host through. */
  onAllow?: (hosts: string[]) => void;
}) {
  const [adding, setAdding] = useState('');
  const blockedTotal = refusals.reduce((sum, one) => sum + one.count, 0);

  const add = (text: string) => {
    const host = text.trim();
    if (!host || !onAllow || allowed.includes(host)) return;
    onAllow([...allowed, host]);
    setAdding('');
  };

  return (
    <div class="scope">
      {/* Folded to a line: the lists are long, and are read when a site will
          not load rather than every time the panel opens. */}
      <Fold
        title="Sites"
        open={false}
        summary={<>
          {allowed.length === 0 ? 'every site loads' : `${allowed.length} allowed`}
          {blockedTotal > 0 && <> · <span class="bad">{blockedTotal} blocked</span></>}
        </>}
      >
        <p class="sechint">Only these load; anything else is blocked before it leaves the browser.</p>
        <ol class="activitycards">
          {allowed.map(host => (
            <Row
              key={host}
              classes={['siterow']}
              columns={['remove']}
              source="allowed"
              label={<span class="what">{host}</span>}
              reading={<span class="meta">loads</span>}
              slots={onAllow ? { remove: () => onAllow(allowed.filter(one => one !== host)) } : {}}
              titles={{ remove: `stop allowing ${host}` }}
              open={false}
              onOpen={() => {}}
            />
          ))}
          {refusals.map(one => (
            <Row
              key={`blocked ${one.host}`}
              classes={['siterow', 'blocked']}
              columns={['remove']}
              source="blocked"
              label={<span class="what">{one.host}</span>}
              reading={<span class="meta">{one.count}×</span>}
              slots={{}}
              open={false}
              onOpen={() => {}}
            />
          ))}
        </ol>
        {onAllow && (
          <div class="addhost">
            <input
              class="namebox"
              placeholder="example.com  or  localhost:3000"
              value={adding}
              onInput={(e: Event) => setAdding((e.target as HTMLInputElement).value)}
              /* Read off the field, never off the held text: a key pressed in
                 the same turn as the input before it sees the state from
                 before that input, so the host would be added a keystroke
                 behind, or empty. */
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') add((e.currentTarget as HTMLInputElement).value);
              }}
            />
            <button class="tool plain" disabled={adding.trim() === ''} onClick={() => add(adding)}>Add</button>
            {allowed.length > 0 && <button class="tool plain" onClick={onOpen}>Allow every site</button>}
          </div>
        )}
      </Fold>

      {/* The rules bound what is answered; this bounds what the rest may do.
          Off, a write no rule covers reaches the server and the server acts. */}
      <section class="panelsec">
        <h3>
          Writes no rule answers
          <span class="grow" />
          <span class="segmented">
            <button class={refusesWrites ? '' : 'on'} onClick={() => refusesWrites && onRefuse(false)}>Let through</button>
            <button class={refusesWrites ? 'on refuse' : ''} onClick={() => !refusesWrites && onRefuse(true)}>Refuse</button>
          </span>
        </h3>
        <p class="sechint">
          {refusesWrites
            ? `POST, PUT, PATCH and DELETE are answered 403 and never reach the server; reads still do.${
                refusedWrites > 0 ? ` ${refusedWrites} refused so far.` : ''}`
            : 'They reach the server, and the server acts on them.'}
        </p>
      </section>

      <section class="panelsec">
        <h3>
          Recorded
          <span class="secsummary">{held} crossing{held === 1 ? '' : 's'}</span>
          <span class="grow" />
          {/* Drops the reading and keeps every decision: the rules stay armed,
              so the next run is scoped and answered exactly as this one was. */}
          <button
            class="tool"
            disabled={held === 0 || counts?.sinceRecording}
            title={counts?.sinceRecording
              ? 'each recorded step reads its traffic from here as it closes - stop the recording first'
              : 'drop what was recorded; every rule stays'}
            onClick={onClear}
          >Clear</button>
        </h3>
        {counts?.sinceRecording && (
          <p class="sechint">Clear waits for the recording to stop: its steps read their traffic from here.</p>
        )}
      </section>

      {said && <p class="scopesaid">{said}</p>}
    </div>
  );
}

/**
 * What the boundary holds, as one reading rather than a wall of counts.
 *
 * The split between what a step caused and what the app did on its own is the
 * question this card exists to answer, so it is the only thing with weight.
 */
function Totals({ totals }: { totals: BoundaryTotals | null }) {
  if (!totals) return null;
  const share = totals.events ? Math.round((totals.owned / totals.events) * 100) : 0;
  return (
    <div class="totals">
      <div class="headline">
        <span class="count">{totals.owned}</span>
        <span class="of">of {totals.events} crossed under a step</span>
        {totals.failed > 0 && <span class="bad">{totals.failed} failed</span>}
      </div>
      <div class="bar">
        <span class="owned" style={{ width: `${share}%` }} />
        <span class="unowned" style={{ width: `${100 - share}%` }} />
      </div>
      <div class="under">
        <span class={totals.free ? 'free' : 'quiet'}>
          {totals.free ? `${totals.free} the app did on its own` : 'nothing unaccounted for'}
        </span>
        <span class="quiet grow">
          {totals.sockets.open
            ? `${totals.sockets.open} socket${totals.sockets.open === 1 ? '' : 's'} open`
            : 'no socket open'}
          {totals.sockets.push ? ` · ${totals.sockets.push} push` : ''}
        </span>
        {totals.holds > 0 && <span class="free">{totals.holds} held</span>}
      </div>
    </div>
  );
}

function Menu({ menu, onFilter, onAsk }: {
  menu: { event: BoundaryEvent; x: number; y: number };
  onFilter: (filter: Filter) => void;
  onAsk: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Raised at the pointer, then pulled back inside the window.
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
  }, [menu.x, menu.y]);

  return (
    <div class="menu" ref={box} onClick={(e: MouseEvent) => e.stopPropagation()}>
      <div class="menulabel">filter this stream by</div>
      {filterableFields(menu.event).map(({ field, label, value }) => (
        ['on', 'out'] as const).map(mode => (
          <button key={`${field}${mode}`} onClick={() => onFilter({ field, label, value, mode })}>
            <span class="op">{mode === 'on' ? 'only' : 'not'}</span>
            <span class="val">{label} {value}</span>
          </button>
        )))}
      <div class="menurule" />
      <button onClick={onAsk}>
        <span class="op">report</span>
        <span class="val">this reading looks wrong…</span>
      </button>
    </div>
  );
}

/**
 * Reporting a reading that looks wrong.
 *
 * The conclusion and what it was drawn from sit above the box, because the
 * note is about them: a report saying "this is wrong" without the reading it
 * disagrees with cannot be acted on, and asking a person to retype what is
 * already on screen is asking them to do the machine's filing.
 */
function Report({ event, alike, said, note, onClose, onSend }: {
  event: BoundaryEvent;
  alike: number;
  said: string;
  note: { current: HTMLTextAreaElement | null };
  onClose: () => void;
  onSend: () => void;
}) {
  useEffect(() => { note.current?.focus(); }, []);

  const facts: Array<[string, string]> = [
    ['reading', event.level],
    ['owned by a step', event.owned ? 'yes' : 'no'],
  ];
  if (event.root) facts.push(['started by', event.root]);
  if (event.evidence?.shape) facts.push(['shape', event.evidence.shape]);
  if (alike > 1) facts.push(['of this kind', String(alike)]);
  if (event.commandIndex !== undefined) facts.push(['step', `cmd ${event.commandIndex}`]);
  if (event.runId !== undefined) facts.push(['step', `${event.runId}/${event.step}`]);

  return (
    <div class="scrim" onClick={onClose}>
      <div class="report" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div class="reporthead">
          <span class="where">
            {event.kind === 'request' ? (event.method ?? 'GET') : socketName(event.url)}
          </span>
          <span class="way">{event.kind === 'request' ? '' : (event.direction === 'out' ? '→' : '←')}</span>
          <span class="what">{event.kind === 'request' ? event.url : (event.preview ?? event.url)}</span>
          <button class="close" title="close" onClick={onClose}>×</button>
        </div>
        <dl class="facts">
          {facts.map(([name, value]) => (
            <div key={name + value}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <label class="asklabel" for="reportnote">what looks wrong here?</label>
        <textarea
          id="reportnote"
          class="why"
          rows={6}
          ref={note as any}
          placeholder="the reading, and what you can see that it missed"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSend();
          }}
        />
        <div class="reportfoot">
          <button class="save" onClick={onSend}>Send to the session</button>
          <span class="hint grow">{said || 'the reading above goes with it, so the rule can be changed'}</span>
          <span class="hint">⌘↵</span>
        </div>
      </div>
    </div>
  );
}
