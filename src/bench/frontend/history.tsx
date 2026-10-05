/** @jsxImportSource preact */
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Row } from './row.js';
import { RunMark } from './editing.js';
import { Glyph } from './glyph.js';
import type { HistoryDetail, HistoryEntry, ToolFavourite } from '../wire.js';
import type { ToolSeed } from './tools.js';

/** Each channel in words, for a row's tooltip. */
const WHERE: Record<HistoryEntry['from'], string> = {
  mcp: 'the MCP connection',
  cli: 'the devharness CLI',
  bench: 'the bench',
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
export function History({ base, onGoTo }: { base: string; onGoTo: (seed: ToolSeed) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
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
      const res = await fetch(`${base}/history`).catch(() => null);
      if (live && res?.ok) setEntries(await res.json());
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  if (!entries) return <div class="hint">reading the history…</div>;
  if (entries.length === 0) return <p class="hint nothing">no tool calls since devharness started</p>;

  const callRow = (entry: HistoryEntry) => (
    <Row key={entry.index}
      classes={['historyrow', entry.failed ? 'failed' : entry.failed === undefined ? 'running' : '']}
      source={entry.tool}
      label={<span class="what">{entry.label}</span>}
      title={[`#${entry.index}`, entry.connection, entry.said].filter(Boolean).join(' · ')}
      reading={<>
        <span class="where" title={entry.run
          ? `a step of ${entry.run}, run from ${WHERE[entry.from]}`
          : `came in through ${WHERE[entry.from]}`}>
          {entry.run && <span class="whererun">{entry.run} · </span>}{entry.from}
        </span>
        {entry.failed && <span class="meta bad">failed</span>}
        {entry.failed === undefined && <span class="meta">running</span>}
        <span class="meta">{new Date(entry.at).toLocaleTimeString()}</span>
      </>}
      slots={{ here: () => void rerun(entry), open: () => void goTo(entry), star: () => void star(entry) }}
      titles={{
        here: 'run this call again with what it was given',
        open: 'open this call in Tools, filled with what it was given',
        star: starred(entry) ? 'kept under Favourites on the Tools tab' : 'keep this call under Favourites on the Tools tab',
      }}
      glyphs={starred(entry) ? { star: 'starred' } : undefined}
      columns={['here', 'open', 'star']}
      open={reading === entry.index}
      onOpen={() => setReading(reading === entry.index ? null : entry.index)}>
      <CallDetail base={base} entry={entry} />
    </Row>
  );

  // A run's calls in the order they ran - the replay calls that walked it,
  // then its steps - between the markers the sequence view draws a nested run
  // with: folded to one, or opened from where it moved in to where it ended.
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
          }}><Glyph of="arrow" /></button>
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
        <RunMark classes="mark switch runfold open runstart" title="fold the calls it ran" onClick={toggle} tools={tools}>
          {from} · moved to: <span class="seqname">{group.name}</span>
        </RunMark>
        <ol class="activitycards">{[...group.calls].reverse().concat([...group.steps].reverse()).map(callRow)}</ol>
        <RunMark classes={failed ? 'mark switch runfold open runend failed' : 'mark switch runfold open runend'}
          title="fold the calls it ran" onClick={toggle}>
          {failed ? 'failed' : running ? 'running' : 'completed'} · <span class="seqname">{group.name}</span>
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
  }
  flush();
  return <div class="historylist">{blocks}</div>;
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

/** An opened call: its parameters and its response, read when the row opens and again once a running call ends. */
function CallDetail({ base, entry }: { base: string; entry: HistoryEntry }) {
  const { index } = entry;
  const running = entry.failed === undefined;
  const [detail, setDetail] = useState<HistoryDetail | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`${base}/history/entry?index=${index}`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(read => { if (live) setDetail(read); });
    return () => { live = false; };
  }, [base, index, running]);

  if (detail === undefined) return <div class="body"><p class="quiet">reading…</p></div>;
  if (detail === null) return <div class="body"><p class="quiet">history no longer holds this call</p></div>;
  return (
    <div class="body historybody">
      <p class="historyfacts">
        #{index}{entry.connection && <> · {entry.connection}</>} · {new Date(entry.at).toLocaleString()}
      </p>
      <div class="pbox">
        <div class="pboxhead">given</div>
        <pre class="pboxbody">{JSON.stringify(detail.params, null, 2)}</pre>
      </div>
      <div class="pbox">
        <div class="pboxhead">returned</div>
        <pre class="pboxbody">{detail.result ?? 'still running'}</pre>
      </div>
    </div>
  );
}
