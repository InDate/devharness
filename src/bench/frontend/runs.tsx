/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Row } from './row.js';
import type { RunRow, RunsView, SequenceOutline, StepCheck, StepTally, SuiteRow } from '../wire.js';
import { comparisonOf } from '../check-words.js';
import { Glyph } from './glyph.js';

/** How often the home page reads the runs: a step of a replay takes about this long. */
const POLL_MS = 1000;
/** Ended runs listed; the log holds more. */
const FINISHED_SHOWN = 12;

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** A run's outcome in words: `passed 35/35`, `failed at 12/35`, `stopped at 4/25`. */
function outcome(run: RunRow): string {
  if (run.status === 'completed') return `passed ${run.total}/${run.total}`;
  if (run.status === 'failed') return `failed at ${run.step}/${run.total}`;
  return `${run.status} at ${run.step}/${run.total}`;
}

/**
 * The runs going now, the `runAll` suites, and the runs that ended, above the
 * sequences. Several sequences run at once only through separate replay runs,
 * each on its own browser, or a bench play beside them, so each row names the
 * browser it drives. A row opens to the sequence's steps with the one reached
 * marked, which is all the bench holds of a run on another browser.
 */
export function RunsPanel({ view, base, post, onOpen }: {
  view: RunsView | null;
  base: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  onOpen: (name: string) => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!view) return null;
  const suites = view.suites.filter(suite => !suite.endedAt || Date.now() - suite.endedAt < 30 * 60 * 1000);
  const finished = view.finished.slice(0, FINISHED_SHOWN);
  if (!view.running.length && !suites.length && !finished.length) return null;
  const keyOf = (run: RunRow) => run.runId ?? `${run.via}:${run.connection}:${run.startedAt}`;

  return (
    <div class="runs">
      {notice && <p class="hint runnotice">{notice}</p>}
      {view.running.length > 0 && (
        <section>
          <div class="sectionhead">running <span class="quiet">{view.running.length}</span></div>
          <ol class="activitycards">
            {view.running.map(run => (
              <RunLine key={keyOf(run)} base={base} run={run} live
                open={reading === keyOf(run)} onOpen={() => setReading(reading === keyOf(run) ? null : keyOf(run))}
                onRun={() => void post('/runs/stop', run.runId ? { runId: run.runId } : { connection: run.connection })}
                onGo={() => onOpen(run.sequence)} />
            ))}
          </ol>
        </section>
      )}
      {suites.length > 0 && (
        <section>
          <div class="sectionhead">suites</div>
          <ol class="activitycards">{suites.map(suite => <SuiteLine key={suite.id} suite={suite} />)}</ol>
        </section>
      )}
      {finished.length > 0 && (
        <section>
          <div class="sectionhead">finished <span class="quiet">newest first</span></div>
          <ol class="activitycards">
            {finished.map(run => (
              <RunLine key={keyOf(run)} base={base} run={run}
                open={reading === keyOf(run)} onOpen={() => setReading(reading === keyOf(run) ? null : keyOf(run))}
                onRun={() => void startRun(base, run.sequence).then(setNotice)}
                onHere={() => void post('/runs/here', { name: run.sequence })}
                onGo={() => onOpen(run.sequence)} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function RunLine({ base, run, live, open, onOpen, onRun, onHere, onGo }: {
  base: string;
  run: RunRow;
  live?: boolean;
  open: boolean;
  onOpen: () => void;
  /** Stop a run going now; start a finished one again in a browser of its own. */
  onRun: () => void;
  /** Play a finished one again in this browser. */
  onHere?: () => void;
  onGo: () => void;
}) {
  const state = live ? 'running' : run.status === 'completed' ? 'passed' : run.status === 'failed' ? 'failed' : 'stopped';
  return (
    <Row classes={['runrow', `run-${state}`]}
      source={run.via === 'bench' ? 'bench' : 'replay'}
      label={<>
        <span class="seqname">{run.sequence}</span>
        {run.connection && <span class="what">{run.connection}</span>}
        {run.suite && <span class="what">· {run.suite.label}</span>}
      </>}
      title={run.failure}
      reading={<span class="runstate">
        {live ? `step ${run.step}/${run.total}${run.tool ? ` · ${run.tool}` : ''}` : `${outcome(run)} · ${ago(run.endedAt ?? run.startedAt)}`}
      </span>}
      slots={{ ...(live ? {} : { here: onHere }), run: onRun, open: onGo }} columns={['here', 'run', 'open']}
      glyphs={live ? { run: 'stop' } : {}}
      titles={{
        here: 'play this sequence again in this browser: the bench opens it and plays it from step 1',
        run: live ? 'stop this run' : 'run this sequence again, in a headless browser of its own',
        open: 'open this sequence in the bench',
      }}
      open={open} onOpen={onOpen}>
      <RunSteps base={base} run={run} live={!!live} onStop={live ? onRun : undefined} />
    </Row>
  );
}

/** The sequence's steps, the reached one marked, and a stop for a run going now. */
function RunSteps({ base, run, live, onStop }: { base: string; run: RunRow; live: boolean; onStop?: () => void }) {
  const [outline, setOutline] = useState<SequenceOutline | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch(`${base}/sequence/outline?name=${encodeURIComponent(run.sequence)}`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(read => { if (alive) setOutline(read); });
    return () => { alive = false; };
  }, [base, run.sequence]);
  const reached = run.status === 'completed' ? run.total + 1 : run.step;
  return (
    <div class="body seqreadme">
      {run.failure && <p class="runfailure">{run.failure}</p>}
      {outline === undefined && <p class="quiet">reading…</p>}
      {outline === null && <p class="quiet">the file could not be read</p>}
      {outline && (
        <ol class="seqsteps runsteps">
          {run.steps && (
            <li class="tallyhead">
              <span class="seqstepno" />
              <span class="seqsteplabel" />
              {TALLIES.map(column => <span key={column.key} class={`tally ${column.key}`} title={column.title}><Glyph of={column.glyph} /></span>)}
            </li>
          )}
          {outline.steps.map((step, k) => (
            <li key={k} class={k + 1 < reached ? 'runpast' : k + 1 === reached ? (live ? 'runnow' : `runend run-${run.status}`) : 'runahead'}>
              <span class="seqstepno">{k + 1}</span>
              <span class="seqsteplabel">{step.label}</span>
              <span class="fullcommand">{step.label}</span>
              {run.steps && <Tallies tally={run.steps[k]} tool={step.tool} params={step.params} />}
            </li>
          ))}
        </ol>
      )}
      {onStop && (
        <div class="bodyfoot">
          <span class="grow" />
          <span class="footactions"><button class="tool plain" onClick={onStop}>Stop</button></span>
        </div>
      )}
    </div>
  );
}

/** The categories a step is counted by, in the colour each one's rows carry elsewhere in the bench. */
const TALLIES: Array<{ key: keyof StepTally; glyph: string; title: string; unit: [string, string] }> = [
  { key: 'requests', glyph: 'request', title: 'HTTP requests the step sent', unit: ['HTTP request', 'HTTP requests'] },
  { key: 'frames', glyph: 'frame', title: 'socket and event-stream messages, sent and received', unit: ['socket or stream message', 'socket or stream messages'] },
  { key: 'intercepted', glyph: 'proxy', title: 'traffic a rule answered, blocked or refused', unit: ['crossing a rule answered', 'crossings a rule answered'] },
  { key: 'state', glyph: 'store', title: 'storage writes, socket closes and workers started or stopped: counted only where a bench watches the browser', unit: ['change to what the page holds', 'changes to what the page holds'] },
  { key: 'ms', glyph: 'timer', title: 'how long the step ran', unit: ['', ''] },
  { key: 'check', glyph: 'tick', title: 'how a check, assert or wait read, and what the run did on it', unit: ['', ''] },
];

function Tallies({ tally, tool, params }: { tally: StepTally | undefined; tool: string; params?: Record<string, unknown> }) {
  return (
    <>
      {TALLIES.map(({ key, unit }) => {
        if (key === 'check') return <CheckCell key={key} reading={tally?.check} tool={tool} params={params} />;
        if (key === 'ms') {
          const ms = tally?.ms;
          const shown = ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
          return <span key={key} class={`tally ms ${ms !== undefined && ms >= 1000 ? 'slow' : 'none'}`} title={ms === undefined ? undefined : `ran for ${shown}`}>{shown}</span>;
        }
        const value = tally?.[key] as number | undefined;
        const shown = value === undefined ? '—' : value === 0 ? '·' : String(value);
        const title = value === undefined
          ? 'not counted: no bench watched this browser'
          : `${value} ${value === 1 ? unit[0] : unit[1]}`;
        return <span key={key} class={`tally ${key} ${value ? 'some' : 'none'}`} title={title}>{shown}</span>;
      })}
    </>
  );
}

/**
 * A reading as the step list words it: `✓ present`, `○ absent` for a fail the
 * run carried past, `✗ not equal` for one that stopped it, then the sequence it
 * ran with how many of its steps passed.
 */
function CheckCell({ reading, tool, params }: { reading?: StepCheck; tool: string; params?: Record<string, unknown> }) {
  if (!reading) return <span class="tally check none" />;
  const [held, failed] = comparisonOf(tool, params ?? {});
  const mark = reading.outcome === 'held' ? `✓ ${held}` : `${reading.action === 'stop' ? '✗' : '○'} ${failed}`;
  const ran = reading.ran ? ` → ${reading.ran.name} ${reading.ran.steps - reading.ran.failed}/${reading.ran.steps}` : '';
  const title = [
    reading.subject,
    reading.found !== undefined ? `found ${reading.found}` : '',
    reading.waitedMs !== undefined ? `read for ${reading.waitedMs}ms${reading.limitMs !== undefined ? ` of ${reading.limitMs}ms` : ''}` : '',
    reading.ran ? `ran ${reading.ran.name}: ${reading.ran.steps} step${reading.ran.steps === 1 ? '' : 's'}, ${reading.ran.failed} failed` : '',
    reading.error ?? '',
  ].filter(Boolean).join('\n');
  const tone = reading.outcome === 'held' ? 'held' : reading.action === 'stop' ? 'stopped' : 'passed-over';
  const tones = `check-${tone}${reading.ran?.failed ? ' ranfailed' : ''}`;
  return (
    <>
      <span class={`tally check ${tones}`} title={title}>{mark}{ran}</span>
      <span class={`fullcheck ${tones}`} title={title}>{mark}{ran}</span>
    </>
  );
}

function SuiteLine({ suite }: { suite: SuiteRow }) {
  const going = suite.endedAt === undefined;
  return (
    <Row classes={['runrow', going ? 'run-running' : suite.failed ? 'run-failed' : 'run-passed']}
      source="runAll"
      label={<><span class="seqname">{suite.label}</span><span class="what">{suite.names.join(' · ')}</span></>}
      reading={<span class="runstate">
        {`${suite.done} of ${suite.names.length} done${suite.failed ? ` · ${suite.failed} failed` : ''}${going ? '' : ` · ${ago(suite.endedAt!)}`}`}
      </span>}
      slots={{}} columns={[]} open={false} onOpen={() => {}} />
  );
}

/** The runs going now, the suites and the runs that ended, read once a second while the home page shows. */
export function useRuns(base: string): RunsView | null {
  const [view, setView] = useState<RunsView | null>(null);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/runs`).catch(() => null);
      if (live && res?.ok) setView(await res.json());
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [base]);
  return view;
}

/** Start a sequence in a headless browser of its own; the failure text, or null once it runs. */
export async function startRun(base: string, name: string): Promise<string | null> {
  const res = await fetch(`${base}/runs/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  }).catch(() => null);
  if (!res?.ok) return `${name} did not start: the bench did not answer`;
  const { failure } = await res.json() as { failure: string | null };
  return failure ? `${name} did not start: ${failure}` : null;
}

/** Cards by tag, each tag once, sorted; a card with two tags is under both, one with none under `untagged`. */
export function byTag<T extends { tags?: string[] }>(cards: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const card of cards) {
    for (const tag of card.tags?.length ? card.tags : ['untagged']) {
      const held = groups.get(tag) ?? [];
      held.push(card);
      groups.set(tag, held);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 'untagged' ? 1 : b === 'untagged' ? -1 : a.localeCompare(b)));
}
