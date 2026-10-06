/** @jsxImportSource preact */
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Row } from './row.js';
import { CLIENT_ID, RunMark } from './editing.js';
import { Glyph } from './glyph.js';
import { ToolGlyph } from './tool-glyph.js';
import { Markdown } from './markdown.js';
import { useGoToAnyTarget } from './goto.js';
import { rowOf, useActivity, type Activity } from './activity.js';
import { CrossingRow, MissingRow } from './crossing.js';
import type { BenchView, HistoryDetail, HistoryEntry, ToolFavourite } from '../wire.js';
import type { ToolSeed } from './tools.js';

/** Each channel in words, for a row's tooltip. */
const WHERE: Record<HistoryEntry['from'], string> = {
  mcp: 'the MCP connection',
  cli: 'the devharness CLI',
  bench: 'the bench',
  person: 'a person, in the app',
};

/**
 * Every tool call this devharness has run, newest first, one row each: the
 * tool, what it acted on, where it came in, and whether it failed. A row
 * opens to what the call was given and all it returned.
 *
 * A row runs its call again with what it was given, opens the Tools tab on
 * that tool with those arguments filled in, or stars the call, which lists it
 * under Favourites on the Tools tab. A run from here is a bench call,
 * so it lands at the top of this list as a row of its own.
 *
 * History lives in the server process, so a rebuild, which restarts that
 * process, starts the list again from nothing.
 */
export function History({ base, onGoTo, entry: focus, onGoToEvent, onGoToStep }: {
  base: string;
  onGoTo: (seed: ToolSeed) => void;
  /** The entry a go-to from Traffic asked for: opened, its run unfolded, and scrolled to. */
  entry?: number | null;
  /** Open Traffic on one crossing or write this call caused. */
  onGoToEvent?: (id: string) => void;
  /** Open `sequence`'s card on the home page with its 0-based `step` marked, leaving from History `entry`. */
  onGoToStep?: (sequence: string, step: number, entry: number) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  // What each call caused is drawn from the bench's boundary, as the Traffic
  // tab reads it, and judged against the open sequence's recording as the
  // Sequence tab judges it.
  const [view, setView] = useState<BenchView | null>(null);
  const activity = useActivity(base, view?.sequence);
  const [favourites, setFavourites] = useState<ToolFavourite[]>([]);

  useEffect(() => {
    fetch(`${base}/favourites`)
      .then(res => (res.ok ? res.json() : []))
      .then(setFavourites)
      .catch(() => {});
  }, [base]);
  // A row carries its label and no arguments, so a star is shown filled by tool and label.
  const starred = (entry: HistoryEntry) => favourites.some(favourite => favourite.tool === entry.tool && favourite.label === entry.label);

  // A row carries no arguments; they are read when a row's action needs them.
  const paramsOf = (index: number): Promise<Record<string, unknown> | null> =>
    fetch(`${base}/history/entry?index=${index}`)
      .then(res => (res.ok ? res.json() : null))
      .then((detail: HistoryDetail | null) => detail?.params ?? null)
      .catch(() => null);
  const rerun = async (entry: HistoryEntry) => {
    const args = await paramsOf(entry.index);
    if (!args) return;
    await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: entry.tool, args }),
    }).catch(() => {});
  };
  const goTo = async (entry: HistoryEntry) => {
    const args = await paramsOf(entry.index);
    if (args) onGoTo({ tool: entry.tool, args });
  };
  const star = async (entry: HistoryEntry) => {
    const args = await paramsOf(entry.index);
    if (!args) return;
    const res = await fetch(`${base}/favourites/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: entry.tool, label: entry.label, args }),
    }).catch(() => null);
    if (res?.ok) setFavourites(await res.json());
  };

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const [res, state] = await Promise.all([
        fetch(`${base}/history`).catch(() => null),
        fetch(`${base}/state?client=${CLIENT_ID}`).catch(() => null),
      ]);
      if (live && res?.ok) setEntries(await res.json());
      if (live && state?.ok) setView(await state.json());
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  // The entry the address names - a go-to from Traffic, or Back to the call a
  // go-to left from: opened, with the run that holds it unfolded, once the
  // list holding it has been read.
  useEffect(() => {
    if (focus == null || !entries) return;
    setReading(focus);
    const group = grouped(entries).find((item): item is RunGroup =>
      item.kind === 'run' && (item.steps.some(step => step.index === focus) || item.calls.some(call => call.index === focus)));
    if (group) setOpenRuns(now => new Set(now).add(`run-${group.steps[group.steps.length - 1].index}`));
  }, [focus, entries === null]);
  useGoToAnyTarget();

  // A run's step is judged by the verdicts the open sequence holds, which are
  // its newest pass's: only the newest call made as that step is that pass.
  const comparedStep = (entry: HistoryEntry): number | undefined => {
    if (entry.run === undefined || entry.runStep === undefined || entry.run !== view?.sequence?.name) return undefined;
    const newest = entries?.find(one => one.run === entry.run && one.runStep === entry.runStep);
    return newest?.index === entry.index ? entry.runStep : undefined;
  };

  if (!entries) return <div class="hint">reading the history…</div>;
  if (entries.length === 0) return <p class="hint nothing">no tool calls since devharness started</p>;

  const callRow = (entry: HistoryEntry) => (
    <Row key={entry.index} id={`history-${entry.index}`}
      classes={['historyrow', entry.failed ? 'failed' : entry.failed === undefined ? 'running' : '']}
      source={<><span class="toolmark"><ToolGlyph tool={entry.tool} /></span>{entry.tool}</>}
      label={<><span class="historyindex" title="the number repeat and create take">#{entry.index}</span><span class="what">{entry.label}</span></>}
      title={[`#${entry.index}`, entry.connection, entry.said].filter(Boolean).join(' · ')}
      reading={<>
        <span class="where" title={entry.run
          ? `a step of ${entry.run}, run from ${WHERE[entry.from]}`
          : `came in through ${WHERE[entry.from]}`}>
          {entry.run && <span class="whererun">{entry.run} · </span>}{entry.from}
        </span>
        {entry.activity && <ActivityTally counts={entry.activity} />}
        {entry.failed && <span class="meta bad">failed</span>}
        {entry.failed === undefined && <span class="meta">running</span>}
        <span class="meta">{new Date(entry.at).toLocaleTimeString()}</span>
      </>}
      slots={{
        here: () => void rerun(entry), open: () => void goTo(entry), star: () => void star(entry),
        ...(onGoToStep && entry.run !== undefined && entry.runStep !== undefined
          ? { sequence: () => onGoToStep(entry.run!, entry.runStep!, entry.index) } : {}),
      }}
      titles={{
        here: 'run this call again with what it was given',
        open: 'open this call in Tools, filled with what it was given',
        star: starred(entry) ? 'kept under Favourites on the Tools tab' : 'keep this call under Favourites on the Tools tab',
      }}
      glyphs={{ open: 'goto:tools', ...(starred(entry) ? { star: 'starred' } : {}) }}
      columns={['here', 'open', 'sequence', 'star']}
      open={reading === entry.index}
      onOpen={() => setReading(reading === entry.index ? null : entry.index)}>
      <CallDetail base={base} entry={entry} activity={activity} onGoToEvent={onGoToEvent}
        compared={comparedStep(entry)} />
    </Row>
  );

  // A run's steps newest first, as History lists every call, between the markers the sequence view
  // draws a nested run with: folded to one, or opened from where it ended down
  // to where it moved in.
  const runRows = (group: RunGroup) => {
    const key = `run-${group.steps[group.steps.length - 1].index}`;
    const open = openRuns.has(key);
    const toggle = () => setOpenRuns(now => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    const failed = group.steps.some(step => step.failed) || group.calls.some(call => call.failed);
    const running = group.steps.some(step => step.failed === undefined) || group.calls.some(call => call.failed === undefined);
    const from = (group.calls[group.calls.length - 1] ?? group.steps[group.steps.length - 1]).from;
    const at = new Date(group.steps[0].at).toLocaleTimeString();
    const span = group.steps.length === 1 ? 'step 1' : `steps 1–${group.steps.length}`;
    // Played again whole, on the browser its steps drove: a bench play walked
    // it a step per call, and the first of those calls runs step 1 alone.
    const connection = group.steps.find(step => step.connection)?.connection;
    const playArgs = { action: 'run', name: group.name, wait: true, ...(connection ? { connection } : {}) };
    const started = group.calls[group.calls.length - 1];
    const tools = (
      <>
        <button class="marknote" title={`play ${group.name} again`} aria-label="play again"
          onClick={(e: Event) => {
            e.stopPropagation();
            void fetch(`${base}/tools/call`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tool: 'replay', args: playArgs }),
            }).catch(() => {});
          }}><Glyph of="play" /></button>
        <button class="marknote" title={started ? 'open the replay call that started this run in Tools' : `open a run of ${group.name} in Tools`}
          aria-label="go to the tool call"
          onClick={(e: Event) => {
            e.stopPropagation();
            if (!started) { onGoTo({ tool: 'replay', args: playArgs }); return; }
            void paramsOf(started.index).then(args => onGoTo({ tool: 'replay', args: args ?? playArgs }));
          }}><Glyph of="goto:tools" /></button>
      </>
    );
    if (!open) {
      return (
        <RunMark key={key} classes={['mark', 'switch', 'runfold', failed ? 'failed' : '', running ? 'running' : ''].filter(Boolean).join(' ')}
          title="open the calls it ran" onClick={toggle} tools={tools}>
          ran {span} from <span class="seqname">{group.name}</span>{failed ? ' · failed' : running ? ' · running' : ''} · {from} · {at}
        </RunMark>
      );
    }
    return (
      <Fragment key={key}>
        <RunMark classes={failed ? 'mark switch runfold open runend failed' : 'mark switch runfold open runend'}
          title="fold the calls it ran" onClick={toggle} tools={tools}>
          {failed ? 'failed' : running ? 'running' : 'completed'} · <span class="seqname">{group.name}</span>
        </RunMark>
        <ol class="activitycards">{[...group.steps, ...group.calls.filter(call => listedWalker(call, group))].map(callRow)}</ol>
        <RunMark classes="mark switch runfold open runstart" title="fold the calls it ran" onClick={toggle}>
          {from} · moved to: <span class="seqname">{group.name}</span>
        </RunMark>
      </Fragment>
    );
  };

  // Calls between runs share one list; each run stands between its markers.
  const blocks: preact.ComponentChildren[] = [];
  let calls: HistoryEntry[] = [];
  const flush = () => {
    if (calls.length) blocks.push(<ol key={`calls-${calls[0].index}`} class="activitycards">{calls.map(callRow)}</ol>);
    calls = [];
  };
  for (const item of grouped(entries)) {
    if (item.kind === 'call') { calls.push(item.entry); continue; }
    flush();
    blocks.push(runRows(item));
    // The call that started the run is a call of its own, listed below the run as older.
    calls.push(...item.calls.filter(call => !walks(call)));
  }
  flush();
  return <div class="historylist">{blocks}</div>;
}

/**
 * Whether a replay call is listed among a run's steps. A `step` or `finish`
 * call repeats what the step it ran shows, one row per step; it is listed only
 * where it failed and no step carries the failure. The call that started the
 * run is listed outside it.
 */
function listedWalker(call: HistoryEntry, group: RunGroup): boolean {
  return walks(call) && call.failed === true && !group.steps.some(step => step.failed);
}

/** A `step` or `finish` call: it carries a run on rather than starting one. */
function walks(call: HistoryEntry): boolean {
  return call.replay?.action === 'step' || call.replay?.action === 'finish';
}

/** A sequence run's steps, newest first, with the replay calls that walked it. */
interface RunGroup { kind: 'run'; name: string; steps: HistoryEntry[]; calls: HistoryEntry[] }
type HistoryItem = { kind: 'call'; entry: HistoryEntry } | RunGroup;

/**
 * History, newest first, with each run's steps folded under the replay call
 * that started them. A run's steps are contiguous, a nested sequence's among
 * them; the replay call that started them sits just below, being older. A
 * `step` or `finish` call carries on the run below it, so a bench play - a run
 * to step 1, then a step at a time - reads as one run, not one per step.
 */
function grouped(entries: HistoryEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    const last = items[items.length - 1];
    if (entry.run) {
      if (last?.kind === 'run' && last.calls.length === 0) last.steps.push(entry);
      else items.push({ kind: 'run', name: entry.run, steps: [entry], calls: [] });
      continue;
    }
    if (entry.replay && last?.kind === 'run' && last.calls.length === 0) {
      last.calls.push(entry);
      if (entry.replay.name) last.name = entry.replay.name;
      // A step or finish call continues the run whose group comes next, being older.
      continue;
    }
    items.push({ kind: 'call', entry });
  }
  // Fold a group started by a step or finish into the older group of the same
  // sequence it continues.
  const folded: HistoryItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const older = folded[folded.length - 1];
    const continues = item.kind === 'run' && item.calls.every(call => call.replay?.action === 'step' || call.replay?.action === 'finish');
    if (continues && older?.kind === 'run' && older.name === (item as RunGroup).steps[(item as RunGroup).steps.length - 1].run) {
      older.steps = [...(item as RunGroup).steps, ...older.steps];
      older.calls = [...(item as RunGroup).calls, ...older.calls];
      continue;
    }
    folded.push(item);
  }
  return folded.reverse();
}

/**
 * A call's activity as the bar counts its tabs: one mark per kind that has
 * events, its count badged on the mark's corner, in the colour that kind's
 * rows carry on the home page. A failed request turns its mark to the alert
 * colour.
 */
function ActivityTally({ counts }: { counts: NonNullable<HistoryEntry['activity']> }) {
  const kinds = [
    { n: counts.requests, glyph: 'request', kind: 'requests', unit: ['HTTP request', 'HTTP requests'] },
    { n: counts.frames, glyph: 'frame', kind: 'frames', unit: ['socket or stream message', 'socket or stream messages'] },
    { n: counts.writes, glyph: 'store', kind: 'state', unit: ['change to what the page holds', 'changes to what the page holds'] },
  ].filter(one => one.n > 0);
  return (
    <span class="activitymarks">
      {kinds.map(one => {
        const failed = one.kind === 'requests' && counts.failed > 0;
        return (
          <span key={one.kind} class={`tabmark activitymark ${one.kind}${failed ? ' failed' : ''}`}
            title={`${one.n} ${one.n === 1 ? one.unit[0] : one.unit[1]}${failed ? `, ${counts.failed} failed` : ''}`}>
            <Glyph of={one.glyph} />
            <span class="tabbadge">{one.n > 999 ? '999+' : one.n}</span>
          </span>
        );
      })}
    </span>
  );
}

/** An opened call: its parameters and its response, read when the row opens and again once a running call ends. */
function CallDetail({ base, entry, activity, onGoToEvent, compared }: {
  base: string;
  entry: HistoryEntry;
  activity: Activity;
  onGoToEvent?: (id: string) => void;
  /** The step of the open sequence this call ran as, where the verdicts the Sequence tab holds are this call's. */
  compared?: number;
}) {
  const { index } = entry;
  const running = entry.failed === undefined;
  const [detail, setDetail] = useState<HistoryDetail | null | undefined>(undefined);
  const [reading, setReading] = useState<string | null>(null);
  const [givenOpen, setGivenOpen] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${base}/history/entry?index=${index}`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(read => { if (live) setDetail(read); });
    return () => { live = false; };
  }, [base, index, running]);

  // A recorded kind this call's step did not produce, listed as the Sequence tab lists it.
  const absent = compared !== undefined ? activity.missing.get(compared) ?? [] : [];
  if (detail === undefined) return <div class="body"><p class="quiet">reading…</p></div>;
  if (detail === null) return <div class="body"><p class="quiet">history no longer holds this call</p></div>;
  return (
    <div class="body historybody">
      <dl class="callfacts">
        {entry.connection && <div title="the browser or target this call acted on"><dt>connection</dt><dd>{entry.connection}</dd></div>}
        <div title="traffic that began inside this window is attributed to this call">
          <dt>window</dt>
          <dd>
            {clock(detail.markedAt ?? entry.at)}
            {running
              ? <> → running</>
              : detail.releasedAt !== undefined
                ? <> → {clock(detail.releasedAt)} · {span(detail.releasedAt - (detail.markedAt ?? entry.at))}</>
                : <span class="quiet"> · holds no window</span>}
          </dd>
        </div>
        {entry.run && detail.runStep !== undefined && (
          <div title="the sequence whose run made this call, and the step it ran as">
            <dt>sequence</dt><dd>{entry.run} | step {detail.runStep + 1}</dd>
          </div>
        )}
      </dl>
      <div class="historysection">
        <div class="historysectionhead">given</div>
        <div class="historyindent">
          <button class="givenline" aria-expanded={givenOpen} title={givenOpen ? 'fold to one line' : 'show the whole payload'}
            onClick={() => setGivenOpen(!givenOpen)}>
            {givenOpen
              ? <pre class="givenfull"><code>{JSON.stringify(detail.params, null, 2)}</code></pre>
              : <code class="givenpeek">{JSON.stringify(detail.params)}</code>}
          </button>
        </div>
      </div>
      <div class="historysection">
        <div class="historysectionhead">returned</div>
        <div class="historyindent">
          {detail.result !== undefined ? <Markdown text={detail.result} breaks /> : <p class="quiet">still running</p>}
        </div>
      </div>
      {(detail.activity || absent.length > 0) && (
        <div class="historysection">
          <div class="historysectionhead">caused</div>
          {/* Each item drawn as a sequence step draws what crossed under it; an
              item the bench no longer holds keeps its line. A hidden kind has no
              Traffic row to go to, so it is listed dimmed without one. */}
          <ol class={compared !== undefined ? 'activitycards causedlist compared' : 'activitycards causedlist'}>{(detail.activity ?? []).map(item => {
            const event = activity.boundary?.events.find(one => one.id === item.id);
            if (!event) {
              return (
                <li key={item.id} class={item.failed ? 'bad' : undefined}>
                  <span class="grow">{item.line}</span>
                </li>
              );
            }
            const hidden = activity.wasHidden(event);
            return (
              <CrossingRow
                key={item.id}
                event={event}
                base={base}
                hidden={hidden}
                rule={activity.ruleFor(event)}
                open={reading === item.id}
                onOpen={() => setReading(reading === item.id ? null : item.id)}
                actions={activity.actions}
                verdict={compared !== undefined ? activity.verdicts.get(rowOf(compared, event)) : undefined}
                {...(onGoToEvent && !hidden ? { onGoToTraffic: () => onGoToEvent(item.id) } : {})}
              />
            );
          })}
            {absent.map(({ kind, verdict }) => (
              <MissingRow key={`missing|${kind}`} kind={kind} verdict={verdict}
                open={reading === `missing|${kind}`}
                onOpen={() => setReading(reading === `missing|${kind}` ? null : `missing|${kind}`)} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** A moment to the millisecond, the precision traffic is attributed at. */
function clock(at: number): string {
  const time = new Date(at);
  return `${time.toLocaleTimeString([], { hour12: false })}.${String(time.getMilliseconds()).padStart(3, '0')}`;
}

function span(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
