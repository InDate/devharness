/** @jsxImportSource preact */
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Markdown } from './markdown.js';
import { Row } from './row.js';
import { Glyph } from './glyph.js';
import { useEscape } from './escape.js';
import type { IssueRow, IssueSync, MatrixPlace, MatrixRefLink, SequenceNote, ToolRun } from '../wire.js';

/** Each status in words, for the issue page's sidebar. */
const STATUS_WORDS: Record<IssueRow['status'], string> = {
  pending: 'pending',
  acknowledged: 'acknowledged',
  in_progress: 'in progress',
  fixed: 'fixed',
  implemented: 'implemented',
};

/** Closed, in GitHub's sense: the tracker's two finished statuses. */
function closed(issue: IssueRow): boolean {
  return issue.status === 'fixed' || issue.status === 'implemented';
}

/** Open issues among those this one waits on. */
function openBlockers(issue: IssueRow, byId: Map<number, IssueRow>): IssueRow[] {
  return issue.blockedBy.map(id => byId.get(id)).filter((b): b is IssueRow => !!b && !closed(b));
}

function piecesOf(id: number, issues: IssueRow[]): IssueRow[] {
  return issues.filter(issue => issue.parent === id).sort((a, b) => a.id - b.id);
}

/** `#12` as a button that opens that issue, its title on hover. */
function IssueRef({ id, byId, onOpen }: { id: number; byId: Map<number, IssueRow>; onOpen: (id: number) => void }) {
  const target = byId.get(id);
  return (
    <button class="issueref" title={target ? target.title : 'no issue carries this number'}
      onClick={(e: Event) => { e.stopPropagation(); onOpen(id); }}>#{id}</button>
  );
}

/** What a line in the list carries about its links: what it is a piece of, what it waits on, how far its pieces are. */
function LinkFacts({ issue, issues, byId, onOpen }: {
  issue: IssueRow; issues: IssueRow[]; byId: Map<number, IssueRow>; onOpen: (id: number) => void;
}) {
  const blockers = closed(issue) ? [] : openBlockers(issue, byId);
  const pieces = piecesOf(issue.id, issues);
  const shut = pieces.filter(closed).length;
  return (
    <>
      {issue.parent !== undefined && <> · piece of <IssueRef id={issue.parent} byId={byId} onOpen={onOpen} /></>}
      {pieces.length > 0 && <> · <span class={shut === pieces.length ? '' : 'issuepieces'}>{shut} of {pieces.length} pieces closed</span></>}
      {blockers.length > 0 && <> · <span class="issuewaits">waits on {blockers.map((b, at) => (
        <Fragment key={b.id}>{at > 0 && ', '}<IssueRef id={b.id} byId={byId} onOpen={onOpen} /></Fragment>
      ))}</span></>}
    </>
  );
}

/** The issue's type, marked and coloured, and a button that filters the list to that type. */
function TypeChip({ type, onType }: { type: IssueRow['type']; onType: (type: IssueRow['type']) => void }) {
  return (
    <button class={`issuetype issuetype-${type}`} title={`show the ${type}s`}
      onClick={(e: Event) => { e.stopPropagation(); onType(type); }}>
      <Glyph of={type} />{type}
    </button>
  );
}

/** A label as a filter term; a label with a space is quoted, as GitHub quotes it. */
function labelTerm(label: string): string {
  return /\s/.test(label) ? `label:"${label}"` : `label:${label}`;
}

/**
 * The filter box read as GitHub reads it: each `label:name` (or
 * `label:"two words"`) term keeps the issues carrying that label exactly,
 * `type:bug` or `type:feature` keeps that type, `is:ready` keeps what
 * `issues next` offers and `is:waiting` the open rest, and the words left
 * over match title, body, a label or `#number`.
 */
function parseFilter(filter: string): { labels: string[]; type?: IssueRow['type']; readiness?: 'ready' | 'waiting'; words: string } {
  const labels: string[] = [];
  let type: IssueRow['type'] | undefined;
  let readiness: 'ready' | 'waiting' | undefined;
  const words = filter
    .replace(/is:(ready|waiting)\b/gi, (_, named: string) => {
      readiness = named.toLowerCase() as 'ready' | 'waiting';
      return ' ';
    })
    .replace(/label:(?:"([^"]+)"|(\S+))/gi, (_, quoted: string | undefined, bare: string | undefined) => {
      labels.push((quoted ?? bare ?? '').toLowerCase());
      return ' ';
    })
    .replace(/type:(bug|feature)\b/gi, (_, named: string) => {
      type = named.toLowerCase() as IssueRow['type'];
      return ' ';
    });
  return { labels, type, readiness, words: words.trim().toLowerCase() };
}

/** How long ago, in the largest whole unit, as GitHub words it. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const units: Array<[number, string]> = [[31_536_000, 'year'], [2_592_000, 'month'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [size, word] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${word}${count === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** What the next sync would send up for a linked issue, in words; empty when nothing is waiting. */
function outgoing(sync: IssueSync): string[] {
  const words: string[] = [];
  if (sync.bodyChanged) words.push('body edited here');
  if (sync.unpushedComments > 0) words.push(`${sync.unpushedComments} comment${sync.unpushedComments === 1 ? '' : 's'} to push`);
  return words;
}

/** One marked issue in a sync plan: what a confirmed sync would change on it; empty is up to date. */
interface PlannedIssue { id: number; number: number; title: string; changes: string[] }

/**
 * The whole tracker against GitHub, above the list: how many issues are
 * linked, how many of those are marked for sync, how many marked ones carry
 * changes to send, how many are local only, and when the newest sync ran. It
 * reads the issue files alone, so a change made on GitHub shows only in a
 * sync plan.
 *
 * Sync opens on the linked issues nobody has decided on yet, each with its
 * state - not decided, sync, leave out - chosen from a list; those already
 * decided are counted and shown on asking. With none undecided it goes
 * straight to the plan. It then asks for the plan - `issues sync` without confirm reads GitHub and
 * writes nothing - and lists what each marked issue would send or take. Only
 * Confirm runs the sync, with `confirm: true`.
 */
function SyncBox({ base, issues, onSynced }: { base: string; issues: IssueRow[]; onSynced: () => void }) {
  const [stage, setStage] = useState<'idle' | 'choose' | 'planning' | 'review' | 'applying' | 'done'>('idle');
  const [marking, setMarking] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const mark = async (issue: IssueRow, state: SyncState) => {
    setMarking(issue.id);
    await callIssues(base, { action: 'edit', id: issue.id, sync: SYNC_VALUE[state] });
    setMarking(null);
    onSynced();
  };
  const [plan, setPlan] = useState<PlannedIssue[]>([]);
  const [said, setSaid] = useState<ToolRun | null>(null);
  const sending = useRef(false);

  const ask = async (args: Record<string, unknown>): Promise<ToolRun | null> => {
    if (sending.current) return null;
    sending.current = true;
    const run = await callIssues(base, args);
    sending.current = false;
    return run;
  };
  const planSync = async () => {
    setStage('planning');
    setSaid(null);
    const run = await ask({ action: 'sync' });
    if (!run) return;
    const planned = run.meta?.github?.plan as PlannedIssue[] | undefined;
    if (run.failed || !planned) { setSaid(run); setStage('done'); return; }
    setPlan(planned);
    setStage('review');
  };
  const applySync = async () => {
    setStage('applying');
    const run = await ask({ action: 'sync', confirm: true });
    if (!run) return;
    setSaid(run);
    setStage('done');
    onSynced();
  };

  const linked = issues.filter(issue => issue.github);
  const marked = linked.filter(issue => issue.github!.marked);
  const undecided = linked.filter(issue => !issue.github!.decided);
  const waiting = marked.filter(issue => outgoing(issue.github!).length > 0);
  const neverSynced = marked.filter(issue => issue.github!.syncedAt === undefined).length;
  const local = issues.length - linked.length;
  const newest = Math.max(0, ...linked.map(issue => issue.github!.syncedAt ?? 0));
  const repos = [...new Set(linked.map(issue => issue.github!.repo).filter(Boolean))];
  const changing = plan.filter(entry => entry.changes.length > 0);

  return (
    <div class={waiting.length > 0 ? 'issuesync waiting' : 'issuesync'}>
      <span class="issuesynchead">GitHub{repos.length === 1 && <span class="issuesyncrepo"> · {repos[0]}</span>}</span>
      {linked.length === 0 ? (
        <span class="issuesyncfacts">No issue is linked yet. <code>issues publish</code> or <code>issues link</code> connects one.</span>
      ) : (
        <span class="issuesyncfacts">
          <span>{linked.length} linked</span>
          <span>{marked.length} marked for sync</span>
          {waiting.length > 0 && <span class="issuesyncout">{waiting.length} with changes to send</span>}
          {neverSynced > 0 && <span>{neverSynced} never synced</span>}
          <span>{local} local only</span>
          <span>{newest > 0 ? `last synced ${ago(newest)}` : 'never synced'}</span>
        </span>
      )}
      <span class="grow" />
      {linked.length > 0 && (stage === 'idle' || stage === 'done') && (
        <button class="resetbtn issuesyncbtn" onClick={() => {
          setSaid(null);
          setShowAll(false);
          // Every issue decided and some marked: nothing to ask, so straight to the plan.
          if (undecided.length === 0 && marked.length > 0) void planSync();
          else setStage('choose');
        }}
          title="choose the issues to sync, then see what a sync would change; nothing is written until you confirm">
          Sync…
        </button>
      )}
      {(stage === 'choose' || stage === 'planning') ? (
        <div class="syncplan">
          <p class="syncplanhead">
            {undecided.length > 0
              ? `${undecided.length} linked issue${undecided.length === 1 ? ' has' : 's have'} no sync decision yet. Choose Sync or Leave out for each; Not decided ones are offered again next time.`
              : 'Every linked issue is set to sync or left out.'}
          </p>
          <ol class="syncchoose">
            {(showAll ? linked : undecided).map(issue => (
              <li key={issue.id}>
                <div class="syncchoice">
                  <SyncStateSelect state={syncStateOf(issue)} disabled={marking === issue.id || stage === 'planning'}
                    label={`Sync state of issue #${issue.id}`} onChoose={state => void mark(issue, state)} />
                  <span>#{issue.id} · {issue.title}</span>
                  <span class="quiet">GitHub #{issue.github!.number}{outgoing(issue.github!).length > 0 && ` · ${outgoing(issue.github!).join(', ')}`}</span>
                </div>
              </li>
            ))}
          </ol>
          {!showAll && linked.length > undecided.length && (
            <p class="quiet syncplanrest">
              {marked.length} set to sync, {linked.length - undecided.length - marked.length} left out.{' '}
              <button class="linkbtn" onClick={() => setShowAll(true)}>Show all</button>
            </p>
          )}
          <div class="syncplanfoot">
            <button class="runbtn" disabled={marked.length === 0 || stage === 'planning'} onClick={() => void planSync()}>
              {stage === 'planning' ? 'Reading GitHub…' : `Read GitHub for ${marked.length} set to sync`}
            </button>
            <button class="resetbtn" disabled={stage === 'planning'} onClick={() => setStage('idle')}>Cancel</button>
          </div>
        </div>
      ) : (stage === 'review' || stage === 'applying') ? (
        <div class="syncplan">
          <p class="syncplanhead">
            {changing.length === 0
              ? `All ${plan.length} marked issue${plan.length === 1 ? ' is' : 's are'} up to date. Nothing to send or take.`
              : `A sync would change ${changing.length} of ${plan.length} marked issue${plan.length === 1 ? '' : 's'}:`}
          </p>
          {changing.length > 0 && (
            <ol class="syncplanlist">
              {changing.map(entry => (
                <li key={entry.id}>
                  <span class="syncplanissue">#{entry.id} · {entry.title} <span class="quiet">→ GitHub #{entry.number}</span></span>
                  <ul>{entry.changes.map(change => <li key={change}>{change}</li>)}</ul>
                </li>
              ))}
            </ol>
          )}
          {plan.length > changing.length && changing.length > 0 && (
            <p class="quiet syncplanrest">{plan.length - changing.length} other marked issue{plan.length - changing.length === 1 ? ' is' : 's are'} up to date.</p>
          )}
          <div class="syncplanfoot">
            <button class="runbtn" disabled={changing.length === 0 || stage === 'applying'} onClick={() => void applySync()}>
              {stage === 'applying' ? 'Syncing…' : 'Confirm sync'}
            </button>
            <button class="resetbtn" disabled={stage === 'applying'} onClick={() => setStage('idle')}>Cancel</button>
          </div>
        </div>
      ) : said
        ? <pre class={said.failed ? 'issuesyncsaid bad' : 'issuesyncsaid'}>{said.result.trim()}</pre>
        : <span class="issuesyncnote">Only issues marked for sync take part. Sync reads GitHub and shows the changes; nothing is sent until you confirm.</span>}
    </div>
  );
}

/** Open: a ring with a dot. Closed: a ring with a tick. Both 16px, as GitHub draws them. */
export function StateMark({ shut }: { shut: boolean }) {
  return shut ? (
    <svg class="issuemark closed" width="16" height="16" viewBox="0 0 16 16" aria-label="closed">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ) : (
    <svg class="issuemark open" width="16" height="16" viewBox="0 0 16 16" aria-label="open">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

function CommentMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    </svg>
  );
}

/**
 * The issues this project tracks, laid out as GitHub lays out a repository's
 * issues: a list with Open and Closed counts in its head and a filter above,
 * and a page per issue with its body and comments as a timeline and its
 * facts in a sidebar.
 *
 * Every issue is read, completed ones included, so both counts hold whichever
 * side is shown. The list is read again every few seconds, since the issue
 * files change under an agent's `issues` calls and under hand edits.
 *
 * `issue` is the one open, as the bench's address holds it, and `onIssue`
 * moves the address, so the browser's back returns from an issue to the list.
 * `onGoToNote` opens a note's sequence and runs it through the note's step.
 * `onMatrix` opens a matrix ref's cell, row or column on the Matrix tab.
 */
export function Issues({ base, issue: openId, onIssue, onGoToNote, onMatrix }: {
  base: string;
  issue: number | null;
  onIssue: (issue: number | null) => void;
  /** `step` is 0-based. */
  onGoToNote: (sequence: string, step: number) => void;
  onMatrix: (place: MatrixPlace) => void;
}) {
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [filter, setFilter] = useState('');
  // Bumped after a write from this tab, so the list is read at once rather than on the next tick.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/issues?all=1`).catch(() => null);
      if (!live) return;
      if (res?.ok) { setIssues(await res.json()); setFailed(false); } else setFailed(true);
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [base, reads]);

  if (!issues) return failed ? <p class="hint nothing">the issues did not load</p> : <div class="hint">reading the issues…</div>;

  // A label pressed anywhere adds its term to the filter and shows the list.
  const filterByLabel = (label: string) => {
    const term = labelTerm(label);
    setFilter(now => (parseFilter(now).labels.includes(label.toLowerCase()) ? now : `${now.trim()} ${term}`.trim()));
    onIssue(null);
  };

  // A type pressed anywhere replaces any type term in the filter and shows the list.
  const filterByType = (type: IssueRow['type']) => {
    setFilter(now => `${now.replace(/type:(bug|feature)\b/gi, ' ').replace(/\s+/g, ' ').trim()} type:${type}`.trim());
    onIssue(null);
  };

  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const opened = openId === null ? undefined : byId.get(openId);
  if (opened) {
    return <IssuePage base={base} issue={opened} issues={issues} byId={byId} onOpen={onIssue}
      onBack={() => onIssue(null)} onChanged={() => setReads(n => n + 1)}
      onGoToNote={onGoToNote} onLabel={filterByLabel} onType={filterByType} onMatrix={onMatrix} />;
  }

  const { labels: wantedLabels, type: wantedType, readiness, words: query } = parseFilter(filter);
  const matching = issues.filter(issue => wantedLabels.every(wanted => issue.labels.some(label => label.toLowerCase() === wanted))
    && (wantedType === undefined || issue.type === wantedType)
    && (readiness === undefined
      || (readiness === 'ready' ? issue.nextPlace !== undefined : !closed(issue) && issue.nextPlace === undefined))
    && (!query
      || issue.title.toLowerCase().includes(query)
      || issue.body.toLowerCase().includes(query)
      || issue.labels.some(label => label.toLowerCase().includes(query))
      || `#${issue.id}` === query || String(issue.id) === query));
  const openCount = matching.filter(issue => !closed(issue)).length;
  const closedCount = matching.length - openCount;
  // Newest first, as GitHub lists them; under is:ready, in the order `issues next` offers them.
  const shown = matching.filter(issue => closed(issue) === showClosed)
    .sort(readiness === 'ready' ? (a, b) => (a.nextPlace ?? 0) - (b.nextPlace ?? 0) : (a, b) => b.id - a.id);
  const next = issues.find(issue => issue.nextPlace === 0);
  const readyCount = issues.filter(issue => issue.nextPlace !== undefined).length;
  const waitingCount = issues.filter(issue => !closed(issue) && issue.nextPlace === undefined).length;

  return (
    <div class="issues">
      <input class="issuefilter" type="search" placeholder="Filter issues by title, body, #number, label:name, type:bug or is:ready"
        aria-label="Filter issues" value={filter}
        onInput={(e: Event) => setFilter((e.target as HTMLInputElement).value)} />
      <SyncBox base={base} issues={issues} onSynced={() => setReads(n => n + 1)} />
      {next && (
        <div class="issuenext">
          <span class="issuenexthead">Next up</span>
          <button class="issuetitle" onClick={() => onIssue(next.id)}>{next.title}</button>
          <span class="quiet">#{next.id}{next.status === 'in_progress' && ' · in progress'}</span>
          <span class="grow" />
          <button class="linkbtn" title="list the issues `issues next` offers, in its order" onClick={() => {
            setShowClosed(false);
            setFilter(now => (parseFilter(now).readiness === 'ready' ? now : `${now.replace(/is:(ready|waiting)\b/gi, ' ').replace(/\s+/g, ' ').trim()} is:ready`.trim()));
          }}>{readyCount} ready</button>
          {waitingCount > 0 && (
            <button class="linkbtn" title="list the open issues waiting on another issue or on their open pieces" onClick={() => {
              setShowClosed(false);
              setFilter(now => `${now.replace(/is:(ready|waiting)\b/gi, ' ').replace(/\s+/g, ' ').trim()} is:waiting`.trim());
            }}>{waitingCount} waiting</button>
          )}
        </div>
      )}
      <div class="issuebox">
        <div class="issueboxhead">
          <button class={showClosed ? 'issueside' : 'issueside on'} onClick={() => setShowClosed(false)}>
            <StateMark shut={false} /> {openCount} Open
          </button>
          <button class={showClosed ? 'issueside on' : 'issueside'} onClick={() => setShowClosed(true)}>
            <StateMark shut /> {closedCount} Closed
          </button>
        </div>
        {shown.length === 0 ? (
          <p class="issueempty">
            {query ? `No ${showClosed ? 'closed' : 'open'} issue matches "${filter.trim()}".` : `No ${showClosed ? 'closed' : 'open'} issues.`}
          </p>
        ) : (
          <ol class="issuelist">
            {shown.map(issue => (
              <li key={issue.id} class="issueline">
                <StateMark shut={closed(issue)} />
                <div class="issuemain">
                  <div class="issuetitleline">
                    <button class="issuetitle" onClick={() => onIssue(issue.id)}>{issue.title}</button>
                    {issue.labels.map(label => (
                      <button key={label} class="issuelabel" title={`show the issues labelled ${label}`}
                        onClick={() => filterByLabel(label)}>{label}</button>
                    ))}
                  </div>
                  <div class="issuesub">
                    #{issue.id} · <TypeChip type={issue.type} onType={filterByType} /> · {closed(issue) && issue.resolvedAt !== undefined
                      ? `closed ${ago(issue.resolvedAt)}`
                      : `opened ${ago(issue.reportedAt)}`}
                    {!closed(issue) && issue.status !== 'acknowledged' && <> · <span class={`issuestatus issue-${issue.status}`}>{STATUS_WORDS[issue.status]}</span></>}
                    <LinkFacts issue={issue} issues={issues} byId={byId} onOpen={onIssue} />
                    {issue.github
                      ? <> · GitHub #{issue.github.number}{issue.github.marked
                        ? (outgoing(issue.github).length > 0 ? <> · <span class="issuesyncout">{outgoing(issue.github).join(', ')}</span></> : <> · synced</>)
                        : <> · {issue.github.decided ? 'left out of sync' : 'sync not decided'}</>}</>
                      : <> · local only</>}
                  </div>
                </div>
                {issue.comments.length > 0 && (
                  <button class="issuecount" title={`${issue.comments.length} comment${issue.comments.length === 1 ? '' : 's'}`}
                    onClick={() => onIssue(issue.id)}>
                    <CommentMark /> {issue.comments.length}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Run one `issues` action from the bench, as a call History lists. */
async function callIssues(base: string, args: Record<string, unknown>): Promise<ToolRun> {
  return fetch(`${base}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'issues', args }),
  })
    .then(async res => (res.ok ? res.json() : { failed: true, result: `The bench answered ${res.status}: ${await res.text()}` }))
    .catch((error: unknown) => ({ failed: true, result: `The bench did not answer: ${String(error)}` }));
}

/** One issue's page: its title and state, the body and comments as a timeline, and a sidebar of facts. */
function IssuePage({ base, issue, issues, byId, onOpen, onBack, onChanged, onGoToNote, onLabel, onType, onMatrix }: {
  base: string; issue: IssueRow; issues: IssueRow[]; byId: Map<number, IssueRow>; onOpen: (id: number) => void;
  onBack: () => void; onChanged: () => void; onGoToNote: (sequence: string, step: number) => void;
  /** A label pressed: the list, filtered to it. */
  onLabel: (label: string) => void;
  onType: (type: IssueRow['type']) => void;
  onMatrix: (place: MatrixPlace) => void;
}) {
  const count = issue.comments.length;
  const [editing, setEditing] = useState(false);
  // Resolving waits on a person answering the overlay in another tab, so the
  // page says where the question is until the call returns.
  const [resolving, setResolving] = useState(false);
  const [resolveSaid, setResolveSaid] = useState<ToolRun | null>(null);
  const resolve = async () => {
    if (resolving) return;
    setResolving(true);
    setResolveSaid(null);
    const run = await callIssues(base, { action: 'resolve', id: issue.id });
    setResolving(false);
    setResolveSaid(run);
    onChanged();
  };
  // Read once per page: the notes live in sequence files, which change only
  // when someone writes a note in the Sequence tab.
  const [notes, setNotes] = useState<SequenceNote[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${base}/issues/notes`)
      .then(res => (res.ok ? res.json() : []))
      .catch(() => [])
      .then((read: SequenceNote[]) => { if (live) setNotes(read); });
    return () => { live = false; };
  }, [base, issue.id]);

  return (
    <div class="issuepage">
      <button class="issueback" onClick={onBack}>‹ Issues</button>
      {editing ? (
        <IssueEditor base={base} issue={issue} notes={notes} onGoToNote={onGoToNote}
          onDone={saved => { setEditing(false); if (saved) onChanged(); }} />
      ) : (
        <div class="issuepagehead">
          <h2 class="issuepagetitle">{issue.title} <span class="issuepageid">#{issue.id}</span></h2>
          <button class="resetbtn issueeditbtn" onClick={() => setEditing(true)}>Edit</button>
          {!closed(issue) && (
            <button class="runbtn issueresolvebtn" disabled={resolving} onClick={() => void resolve()}
              title="replay this issue's sequence in a new tab, then answer Fixed or Not fixed there; the answer is recorded on the issue">
              {resolving ? 'Resolving…' : 'Resolve'}
            </button>
          )}
        </div>
      )}
      {resolving && (
        <p class="issueresolving">A tab has opened in the browser, replaying this issue. Answer <b>Fixed</b> or <b>Not fixed</b> there; the answer is recorded here.</p>
      )}
      {resolveSaid && !resolving && (
        <p class={resolveSaid.failed ? 'issueresolving bad' : 'issueresolving'}>{resolveSaid.result.split('\n')[0]}</p>
      )}
      {!closed(issue) && issue.nextPlace === undefined && (
        <p class="issuewaiting">
          {openBlockers(issue, byId).length > 0
            ? <>Waits on {openBlockers(issue, byId).map((b, at) => <Fragment key={b.id}>{at > 0 && ', '}<IssueRef id={b.id} byId={byId} onOpen={onOpen} /> {b.title}</Fragment>)}; it comes up in Next once {openBlockers(issue, byId).length === 1 ? 'that closes' : 'those close'}.</>
            : <>Worked through its pieces: it closes when the last open one closes.</>}
        </p>
      )}
      <div class="issuepagesub">
        <span class={closed(issue) ? 'issuestate closed' : 'issuestate open'}>
          <StateMark shut={closed(issue)} /> {closed(issue) ? 'Closed' : 'Open'}
        </span>
        <span>
          <TypeChip type={issue.type} onType={onType} /> · opened {ago(issue.reportedAt)} · {count} comment{count === 1 ? '' : 's'}
        </span>
      </div>
      <div class="issuecols">
        <ol class="issuetimeline">
          {!editing && (
            <li class="issuecomment">
              <div class="issuecommenthead" title={new Date(issue.reportedAt).toLocaleString()}>
                reported {ago(issue.reportedAt)}
              </div>
              <div class="issuecommentbody">
                {issue.body.trim() ? <Markdown text={issue.body} /> : <p class="quiet">No description provided.</p>}
              </div>
            </li>
          )}
          {issue.comments.map((comment, at) => (
            <li key={at} class="issuecomment">
              <div class="issuecommenthead" title={new Date(comment.at).toLocaleString()}>
                commented {ago(comment.at)}
              </div>
              <div class="issuecommentbody"><Markdown text={comment.text} /></div>
            </li>
          ))}
          {closed(issue) && issue.resolvedAt !== undefined && (
            <li class="issueevent" title={new Date(issue.resolvedAt).toLocaleString()}>
              <StateMark shut={closed(issue)} /> closed as {issue.status} {ago(issue.resolvedAt)}
            </li>
          )}
          <li class="issuecomment issuecompose">
            <CommentBox base={base} issue={issue} notes={notes} onPosted={onChanged} onGoToNote={onGoToNote} />
          </li>
        </ol>
        <aside class="issueside-facts">
          <section>
            <h3>Status</h3>
            <p class={`issuestatus issue-${issue.status}`}>{STATUS_WORDS[issue.status]}</p>
          </section>
          <section>
            <h3>Type</h3>
            <p><TypeChip type={issue.type} onType={onType} /></p>
          </section>
          <section>
            <h3>Labels</h3>
            {issue.labels.length
              ? <p class="issuelabels">{issue.labels.map(label => (
                <button key={label} class="issuelabel" title={`show the issues labelled ${label}`}
                  onClick={() => onLabel(label)}>{label}</button>
              ))}</p>
              : <p class="quiet">None yet</p>}
          </section>
          <IssueLinks base={base} issue={issue} issues={issues} byId={byId} onOpen={onOpen} onChanged={onChanged} />
          <section>
            <h3>Sequence</h3>
            {issue.sequenceFile ? <p class="issuemono">{issue.sequenceFile}</p> : <p class="quiet">None linked</p>}
            <SequenceLink base={base} issue={issue} onLinked={onChanged} />
          </section>
          {issue.matrix && issue.matrix.length > 0 && (
            <section>
              <h3>Matrix</h3>
              <ul class="issuelinks">
                {issue.matrix.map(link => <MatrixRefLine key={link.ref} link={link} onMatrix={onMatrix} />)}
              </ul>
            </section>
          )}
          <section>
            <h3>GitHub</h3>
            {issue.github ? (
              <>
                <p>#{issue.github.number}{issue.github.repo && <> in {issue.github.repo}</>}</p>
                <SyncMark base={base} issue={issue} onChanged={onChanged} />
                <p class="quiet">{issue.github.syncedAt !== undefined ? `synced ${ago(issue.github.syncedAt)}` : 'linked, never synced'}</p>
                {outgoing(issue.github).length > 0
                  ? <p class="issuesyncout">{outgoing(issue.github).join(', ')} since then</p>
                  : <p class="quiet">no local change since then</p>}
              </>
            ) : (
              <p class="quiet">Local only</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** One matrix ref: a link to its cell, row or column, or plain text marked where the ref names nothing in the store. */
function MatrixRefLine({ link, onMatrix }: { link: MatrixRefLink; onMatrix: (place: MatrixPlace) => void }) {
  const at = link.at;
  const area = at && (at.scenario !== undefined && at.capability !== undefined ? 'cell' : at.scenario !== undefined ? 'row' : 'column');
  return (
    <li class="issuelinkrow">
      {at
        ? <button class="issuereftitle issuemono" title={`open this ${area} on the Matrix tab`} onClick={() => onMatrix(at)}>{link.ref}</button>
        : <span class="issuemono matrixdead">{link.ref} <span class="matrixmissing" title="the store holds no matrix, scenario or capability this ref names">points at nothing</span></span>}
    </li>
  );
}

/**
 * The issue's title, labels and body in one form, as GitHub's Edit opens them.
 * Save sends only the fields that changed, through `issues edit`; a linked
 * issue's next sync then pushes the change.
 */
function IssueEditor({ base, issue, notes, onDone, onGoToNote }: {
  base: string; issue: IssueRow; notes: SequenceNote[] | null; onDone: (saved: boolean) => void;
  onGoToNote: (sequence: string, step: number) => void;
}) {
  const [title, setTitle] = useState(issue.title);
  const [labels, setLabels] = useState(issue.labels.join(', '));
  const [body, setBody] = useState(issue.body);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sending = useRef(false);

  const labelList = labels.split(',').map(label => label.trim()).filter(Boolean);
  const changes: Record<string, unknown> = {
    ...(title.trim() !== issue.title && { title: title.trim() }),
    ...(body !== issue.body && { body }),
    ...(labelList.join('\n') !== issue.labels.join('\n') && { labels: labelList }),
  };
  const changed = Object.keys(changes).length > 0;

  const save = async () => {
    if (!changed || sending.current || !title.trim()) return;
    sending.current = true;
    setSaving(true);
    setFailure(null);
    const run = await callIssues(base, { action: 'edit', id: issue.id, ...changes });
    sending.current = false;
    setSaving(false);
    if (run.failed) { setFailure(run.result); return; }
    onDone(true);
  };

  return (
    <div class="issueeditor">
      <input class="issueeditfield issueedittitle" value={title} aria-label="Title"
        onInput={(e: Event) => setTitle((e.target as HTMLInputElement).value)} />
      <input class="issueeditfield" value={labels} placeholder="Labels, separated by commas" aria-label="Labels"
        onInput={(e: Event) => setLabels((e.target as HTMLInputElement).value)} />
      <div class="issuecomment">
        <Composer text={body} onText={setBody} notes={notes} sequenceFile={issue.sequenceFile} onGoToNote={onGoToNote}
          placeholder="Describe the issue. Markdown is supported." label={`Body of issue #${issue.id}`} onSubmit={() => void save()}>
          {failure && <span class="bad composefailure" title={failure}>{failure}</span>}
          <span class="grow" />
          <button class="resetbtn" onClick={() => onDone(false)}>Cancel</button>
          <button class="runbtn" disabled={!changed || saving || !title.trim()} onClick={() => void save()}
            title={issue.github ? 'save; the next sync pushes it to GitHub (⌘↵)' : 'save (⌘↵)'}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </Composer>
      </div>
    </div>
  );
}

/**
 * A new comment, posted through `issues comment`, so it lands in the issue file
 * and History lists the call. The text stays in the box until the call returns
 * without failing.
 */
function CommentBox({ base, issue, notes, onPosted, onGoToNote }: {
  base: string; issue: IssueRow; notes: SequenceNote[] | null; onPosted: () => void;
  onGoToNote: (sequence: string, step: number) => void;
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set at once, where `posting` lands only on the next render: a second click
  // or ⌘↵ inside that render posted the comment twice.
  const sending = useRef(false);
  const empty = !text.trim();

  const post = async () => {
    if (empty || sending.current) return;
    sending.current = true;
    setPosting(true);
    setFailure(null);
    const run = await callIssues(base, { action: 'comment', id: issue.id, text });
    sending.current = false;
    setPosting(false);
    if (run.failed) { setFailure(run.result); return; }
    setText('');
    onPosted();
  };

  return (
    <Composer text={text} onText={setText} notes={notes} sequenceFile={issue.sequenceFile} onGoToNote={onGoToNote}
      placeholder="Leave a comment. Markdown is supported." label={`Comment on issue #${issue.id}`} onSubmit={() => void post()}>
      {failure && <span class="bad composefailure" title={failure}>{failure}</span>}
      <span class="grow" />
      <button class="runbtn" disabled={empty || posting} onClick={() => void post()} title="add this comment to the issue (⌘↵)">
        {posting ? 'Commenting…' : 'Comment'}
      </button>
    </Composer>
  );
}

/** A note as Markdown: a quote headed by where it was written, with what it pointed at underneath. */
function noteMarkdown(note: SequenceNote): string {
  const head = `**Note** · \`${note.sequence}\` step ${note.step} · ${note.stepLabel}`;
  const target = note.selector
    ? `Element: \`${note.selector}\`${note.component ? ` · ${note.component}` : ''}${note.source ? ` (\`${note.source}\`)` : ''}`
    : undefined;
  const lines = [
    head,
    '',
    ...(note.comment.trim() ? note.comment.trim().split('\n') : ['(no words, only the pick)']),
    '',
    ...(target ? [target] : []),
    `Page: ${note.url}`,
    ...(note.screenshots?.length ? [`Captures: ${note.screenshots.map(shot => `\`${shot.split('/').pop()}\``).join(', ')}`] : []),
  ];
  return lines.map(line => (line ? `> ${line}` : '>')).join('\n');
}

/**
 * Markdown text with Write and Preview tabs, as GitHub's comment box has, and
 * Add notes, which lists the notes written in saved sequences, newest first,
 * in the rows the Sequence tab draws them in. A row quotes its note into the
 * text at the caret, or goes to it: the note's sequence opens and runs through
 * the note's step. `children` is the footer: the buttons that act on the text.
 */
function Composer({ text, onText, notes, sequenceFile, onGoToNote, placeholder, label, onSubmit, children }: {
  text: string;
  onText: (text: string) => void;
  notes: SequenceNote[] | null;
  sequenceFile?: string;
  onGoToNote: (sequence: string, step: number) => void;
  placeholder: string;
  label: string;
  onSubmit: () => void;
  children: ComponentChildren;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [noteFilter, setNoteFilter] = useState('');
  const [readingNote, setReadingNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the caret stood when the box was last left, since opening the picker moves focus.
  const caret = useRef<number | null>(null);

  const insert = (note: SequenceNote) => {
    const at = caret.current ?? text.length;
    const before = text.slice(0, at).replace(/\n*$/, '');
    const after = text.slice(at).replace(/^\n*/, '');
    const quote = noteMarkdown(note);
    const next = `${before}${before ? '\n\n' : ''}${quote}\n\n${after}`;
    onText(next);
    caret.current = (before ? before.length + 2 : 0) + quote.length + 2;
    setPreviewing(false);
  };

  const query = noteFilter.trim().toLowerCase();
  // Newest first, as the notes route answers.
  const shownNotes = (notes ?? [])
    .filter(note => !query || [note.sequence, note.comment, note.stepLabel, note.selector ?? '']
      .some(field => field.toLowerCase().includes(query)));

  return (
    <>
      <div class="issuecommenthead composetabs" role="tablist">
        <button role="tab" aria-selected={!previewing} class={previewing ? 'composetab' : 'composetab on'} onClick={() => setPreviewing(false)}>Write</button>
        <button role="tab" aria-selected={previewing} class={previewing ? 'composetab on' : 'composetab'} onClick={() => setPreviewing(true)}>Preview</button>
        <span class="grow" />
        <button class={picking ? 'composenotes on' : 'composenotes'} aria-expanded={picking}
          title="quote a note written in a sequence" onClick={() => setPicking(!picking)}>
          Add notes{notes && notes.length > 0 && <span class="composenotecount">{notes.length}</span>}
        </button>
      </div>
      {picking && (
        <div class="notepicker">
          <input class="issuefilter" type="search" placeholder="Filter notes by sequence, words, step or element"
            aria-label="Filter notes" value={noteFilter}
            onInput={(e: Event) => setNoteFilter((e.target as HTMLInputElement).value)} />
          {notes === null && <p class="hint">reading the notes…</p>}
          {notes !== null && shownNotes.length === 0 && (
            <p class="hint">{notes.length === 0 ? 'No sequence holds a note yet. Notes are written in the Sequence tab.' : 'No note matches.'}</p>
          )}
          <ol class="activitycards notelist">
            {shownNotes.map(note => {
              const key = `${note.file}:${note.step}:${note.at}`;
              const [firstLine, ...restLines] = note.comment.split('\n');
              const own = note.file === sequenceFile;
              return (
                <Row key={key}
                  classes={['noterow']}
                  source="Note"
                  title={note.selector}
                  label={<span class="what">{`${firstLine || '(no words)'}${restLines.some(line => line.trim()) ? ' …' : ''}`}</span>}
                  reading={<span class="meta">
                    {own && <span class="noteown">this issue's · </span>}{note.sequence} · step {note.step} · {ago(Date.parse(note.at))}
                  </span>}
                  columns={['here', 'send']}
                  glyphs={{ send: 'quote' }}
                  slots={{
                    here: () => onGoToNote(note.sequence, note.step - 1),
                    send: () => insert(note),
                  }}
                  titles={{
                    here: `open ${note.sequence} and run it through step ${note.step}, where this note was written`,
                    send: 'quote this note into the text, at the caret',
                  }}
                  open={readingNote === key}
                  onOpen={() => setReadingNote(readingNote === key ? null : key)}>
                  {/* The words, what they point at, and last the one thing done
                      with them here, at the start of the last row. */}
                  <div class="notebody">
                    <p class="notefull">{note.comment || '(no words)'}</p>
                    <p class="historyfacts">
                      {note.selector ?? 'about the step'} · step {note.step} · {note.stepLabel} · {note.url}
                    </p>
                    <div class="bodyfoot">
                      <span class="footactions">
                        <button class="tool plain" onClick={() => insert(note)}>Quote</button>
                      </span>
                    </div>
                  </div>
                </Row>
              );
            })}
          </ol>
        </div>
      )}
      <div class="issuecommentbody">
        {previewing ? (
          <div class="composepreview">{text.trim() ? <Markdown text={text} /> : <p class="quiet">Nothing to preview</p>}</div>
        ) : (
          <textarea ref={box} class="composetext" placeholder={placeholder} value={text} aria-label={label}
            onInput={(e: Event) => onText((e.target as HTMLTextAreaElement).value)}
            onBlur={() => { caret.current = box.current?.selectionStart ?? null; }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
            }} />
        )}
        <div class="composefoot">{children}</div>
      </div>
    </>
  );
}

/** One row in a link list: the issue's state, its number and title, and a remove button where the link can be removed here. */
function LinkedIssue({ id, byId, onOpen, onRemove, busy }: {
  id: number; byId: Map<number, IssueRow>; onOpen: (id: number) => void; onRemove?: () => void; busy?: boolean;
}) {
  const target = byId.get(id);
  return (
    <li class="issuelinkrow">
      {target && <StateMark shut={closed(target)} />}
      <button class="issuereftitle" onClick={() => onOpen(id)} title={target ? `open #${id}` : 'no issue carries this number'}>
        <span class="quiet">#{id}</span> {target ? target.title : 'missing'}
      </button>
      {onRemove && (
        <button class="issuelinkdrop" disabled={busy} aria-label={`remove the link to #${id}`} title={`remove the link to #${id}`}
          onClick={onRemove}>×</button>
      )}
    </li>
  );
}

/** Where a search word was found in an issue, best place first: the field and a stretch of text around it. */
interface IssueHit { issue: IssueRow; score: number; field: 'title' | 'number' | 'label' | 'body' | 'comment'; snippet?: string }

const FIELD_SCORE = { number: 5, title: 4, label: 3, body: 2, comment: 1 } as const;

/** Up to 60 characters either side of the first word found, on one line. */
function snippetAround(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + word.length + 60);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

/**
 * Every word of the query has to appear somewhere in the issue, across its
 * number, title, labels, body and comments. The hit is scored by the best
 * field the first word lands in, so a title match ranks above one buried in a
 * comment; open issues come before closed ones at the same score.
 */
function searchIssues(issues: IssueRow[], query: string): IssueHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return issues.filter(issue => !closed(issue)).sort((a, b) => b.id - a.id)
      .map(issue => ({ issue, score: 0, field: 'title' as const }));
  }
  const hits: IssueHit[] = [];
  for (const issue of issues) {
    const fields: Array<[IssueHit['field'], string]> = [
      ['number', `#${issue.id}`],
      ['title', issue.title],
      ...issue.labels.map(label => ['label', label] as [IssueHit['field'], string]),
      ['body', issue.body],
      ...issue.comments.map(comment => ['comment', comment.text] as [IssueHit['field'], string]),
    ];
    const all = fields.map(([, text]) => text.toLowerCase()).join('\n');
    if (!words.every(word => all.includes(word))) continue;
    const first = words[0].replace(/^#/, '');
    const found = fields.find(([field, text]) => (field === 'number' ? text === `#${first}` : text.toLowerCase().includes(words[0])));
    const field = found?.[0] ?? 'title';
    hits.push({
      issue, field,
      score: FIELD_SCORE[field],
      ...(found && (field === 'body' || field === 'comment') && { snippet: snippetAround(found[1], words[0]) }),
    });
  }
  return hits.sort((a, b) => b.score - a.score || Number(closed(a.issue)) - Number(closed(b.issue)) || b.issue.id - a.issue.id);
}

/** The query's words marked inside a line of text. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return <>{parts.map((part, at) => (at % 2 === 1 ? <mark key={at}>{part}</mark> : part))}</>;
}

/**
 * A full-page search over every issue, for choosing the one a link points at:
 * each key searches number, title, labels, body and comments, and a hit in
 * the body or a comment shows the words around it, so the issue is found by
 * what it is about rather than by its number. Arrows or a moving pointer
 * move the highlight, Enter picks the highlighted row, Escape closes. `refusal` is the tool's answer to the last pick, shown in
 * place, so a pick that closes a loop is read where it was made.
 */
function IssueSearchDialog({ title, issues, exclude, busy, refusal, onPick, onClose }: {
  title: string; issues: IssueRow[]; exclude: Set<number>; busy: boolean; refusal: string | null;
  onPick: (id: number) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useEscape(true, onClose);
  useEffect(() => { box.current?.focus(); }, []);

  const hits = searchIssues(issues.filter(issue => !exclude.has(issue.id)), query.trim()).slice(0, 50);
  const chosen = Math.min(at, Math.max(0, hits.length - 1));
  useEffect(() => {
    list.current?.querySelector('.issuehit.on')?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);

  return (
    <div class="scrim" onClick={onClose}>
      <div class="report issuesearch" role="dialog" aria-label={title} onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div class="issuesearchhead">
          <h3>{title}</h3>
          <button class="close" title="close (Esc)" onClick={onClose}>×</button>
        </div>
        <input ref={box} class="issuefilter issuesearchbox" type="search" value={query} aria-label={`${title}: search`}
          placeholder="Search title, description, comments, labels or #number"
          onInput={(e: Event) => { setQuery((e.target as HTMLInputElement).value); setAt(0); }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(chosen + 1, hits.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(chosen - 1, 0)); }
            else if (e.key === 'Enter' && hits[chosen] && !busy) { e.preventDefault(); onPick(hits[chosen].issue.id); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }} />
        {refusal && <p class="bad issuesearchrefusal">{refusal}</p>}
        <p class="quiet issuesearchcount">
          {query.trim()
            ? `${hits.length === 50 ? '50+' : hits.length} match${hits.length === 1 ? '' : 'es'}`
            : 'Open issues, newest first. Type to search every issue, closed ones too.'}
        </p>
        {hits.length === 0 ? <p class="issueempty">Nothing matches "{query.trim()}".</p> : (
          <ol ref={list} class="issuehits">
            {hits.map((hit, place) => (
              <li key={hit.issue.id}>
                <button class={place === chosen ? 'issuehit on' : 'issuehit'} disabled={busy}
                  onMouseMove={(e: MouseEvent) => {
                    // A list redrawn under a still pointer fires hover events too; only real movement moves the highlight.
                    if ((e.movementX !== 0 || e.movementY !== 0) && place !== chosen) setAt(place);
                  }} onClick={() => onPick(hit.issue.id)}>
                  <StateMark shut={closed(hit.issue)} />
                  <span class="issuehitmain">
                    <span class="issuehittitle"><Marked text={hit.issue.title} query={query} /></span>
                    <span class="issuehitsub">
                      #{hit.issue.id} · {hit.issue.type}{!closed(hit.issue) && hit.issue.status !== 'acknowledged' && ` · ${STATUS_WORDS[hit.issue.status]}`}
                      {closed(hit.issue) && ' · closed'}
                      {hit.issue.labels.length > 0 && <> · <Marked text={hit.issue.labels.join(', ')} query={query} /></>}
                    </span>
                    {hit.snippet && (
                      <span class="issuehitsnippet">
                        <span class="quiet">{hit.field === 'comment' ? 'in a comment: ' : 'in the description: '}</span>
                        <Marked text={hit.snippet} query={query} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * The issue's links in the sidebar, each written through `issues edit`: what
 * it is a piece of, the issues it waits on, and read from the other side, its
 * pieces and the issues waiting on it. A link the tool refuses (one that
 * closes a loop) shows the refusal under the section.
 */
function IssueLinks({ base, issue, issues, byId, onOpen, onChanged }: {
  base: string; issue: IssueRow; issues: IssueRow[]; byId: Map<number, IssueRow>;
  onOpen: (id: number) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ on: 'parent' | 'waits'; text: string } | null>(null);
  const [searching, setSearching] = useState<'parent' | 'waits' | null>(null);

  const write = async (on: 'parent' | 'waits', change: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const run = await callIssues(base, { action: 'edit', id: issue.id, ...change });
    setBusy(false);
    if (run.failed) { setFailure({ on, text: run.result.replace(/^Error:\s*/, '').split('\n')[0] }); return; }
    setSearching(null);
    onChanged();
  };

  const pieces = piecesOf(issue.id, issues);
  const blocking = issues.filter(other => other.blockedBy.includes(issue.id)).sort((a, b) => a.id - b.id);
  const shut = pieces.filter(closed).length;

  return (
    <>
      <section>
        <h3>Piece of</h3>
        {issue.parent !== undefined
          ? <ol class="issuelinks"><LinkedIssue id={issue.parent} byId={byId} onOpen={onOpen} busy={busy}
              onRemove={() => void write('parent', { parent: null })} /></ol>
          : <p class="quiet">None</p>}
        <button class="linkbtn issuelinkadd" onClick={() => { setFailure(null); setSearching('parent'); }}>
          {issue.parent !== undefined ? 'Move to another issue…' : 'Make this a piece of…'}
        </button>
        {failure?.on === 'parent' && searching === null && <p class="bad">{failure.text}</p>}
      </section>
      {pieces.length > 0 && (
        <section>
          <h3>Pieces <span class="quiet">· {shut} of {pieces.length} closed</span></h3>
          <progress class="issuepiecebar" max={pieces.length} value={shut} aria-label={`${shut} of ${pieces.length} pieces closed`} />
          <ol class="issuelinks">
            {pieces.map(piece => <LinkedIssue key={piece.id} id={piece.id} byId={byId} onOpen={onOpen} />)}
          </ol>
          {!closed(issue) && <p class="quiet">Closes when the last piece closes.</p>}
        </section>
      )}
      <section>
        <h3>Waits on</h3>
        {issue.blockedBy.length > 0 ? (
          <ol class="issuelinks">
            {issue.blockedBy.map(id => (
              <LinkedIssue key={id} id={id} byId={byId} onOpen={onOpen} busy={busy}
                onRemove={() => void write('waits', { blockedBy: issue.blockedBy.filter(other => other !== id) })} />
            ))}
          </ol>
        ) : <p class="quiet">Nothing</p>}
        <button class="linkbtn issuelinkadd" onClick={() => { setFailure(null); setSearching('waits'); }}>Wait on another issue…</button>
        {failure?.on === 'waits' && searching === null && <p class="bad">{failure.text}</p>}
      </section>
      {searching !== null && (
        <IssueSearchDialog
          title={searching === 'waits' ? `#${issue.id} waits on…` : `#${issue.id} is a piece of…`}
          issues={issues}
          exclude={new Set(searching === 'waits' ? [issue.id, ...issue.blockedBy] : [issue.id, ...(issue.parent !== undefined ? [issue.parent] : [])])}
          busy={busy}
          refusal={failure?.on === searching ? failure.text : null}
          onClose={() => { setSearching(null); setFailure(null); }}
          onPick={id => void write(searching, searching === 'waits' ? { blockedBy: [...issue.blockedBy, id] } : { parent: id })} />
      )}
      {blocking.length > 0 && (
        <section>
          <h3>Waiting on this</h3>
          <ol class="issuelinks">
            {blocking.map(other => <LinkedIssue key={other.id} id={other.id} byId={byId} onOpen={onOpen} />)}
          </ol>
        </section>
      )}
    </>
  );
}

/**
 * Link a saved sequence to the issue, or swap the one it has, through
 * `issues edit`. The sequence is copied into the issues folder under the
 * issue's filename, which is what resolve and workOn replay.
 */
function SequenceLink({ base, issue, onLinked }: { base: string; issue: IssueRow; onLinked: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [linking, setLinking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${base}/tools/values`)
      .then(res => (res.ok ? res.json() : null))
      .then((read: { sequences?: string[] } | null) => { if (live) setNames(read?.sequences ?? []); })
      .catch(() => { if (live) setNames([]); });
    return () => { live = false; };
  }, [base]);

  const link = async () => {
    if (!chosen || linking) return;
    setLinking(true);
    setFailure(null);
    const run = await callIssues(base, { action: 'edit', id: issue.id, sequenceName: chosen });
    setLinking(false);
    if (run.failed) { setFailure(run.result.split('\n')[0]); return; }
    setChosen('');
    onLinked();
  };

  if (!names || names.length === 0) return null;
  return (
    <div class="sequencelink">
      <select class="issueeditfield" value={chosen} aria-label="Sequence to link"
        onChange={(e: Event) => setChosen((e.target as HTMLSelectElement).value)}>
        <option value="">{issue.sequenceFile ? 'Link another sequence…' : 'Link a sequence…'}</option>
        {names.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      {chosen && (
        <button class="tool plain" disabled={linking} onClick={() => void link()}>{linking ? 'Linking…' : 'Link'}</button>
      )}
      {failure && <p class="bad">{failure}</p>}
    </div>
  );
}

/** A linked issue's sync decision: nobody has decided, it syncs, or it is left out on purpose. */
type SyncState = 'undecided' | 'sync' | 'leave';

/** What `issues edit` takes for each state; null clears the decision. */
const SYNC_VALUE: Record<SyncState, boolean | null> = { undecided: null, sync: true, leave: false };

function syncStateOf(issue: IssueRow): SyncState {
  if (!issue.github?.decided) return 'undecided';
  return issue.github.marked ? 'sync' : 'leave';
}

/**
 * The three sync states as a list to choose from, each named, so a change is
 * a deliberate pick rather than a click that flips a box.
 */
function SyncStateSelect({ state, disabled, label, onChoose }: {
  state: SyncState; disabled: boolean; label: string; onChoose: (state: SyncState) => void;
}) {
  return (
    <select class={`syncstate syncstate-${state}`} value={state} disabled={disabled} aria-label={label}
      onChange={(e: Event) => onChoose((e.target as HTMLSelectElement).value as SyncState)}>
      <option value="undecided">Not decided</option>
      <option value="sync">Sync</option>
      <option value="leave">Leave out</option>
    </select>
  );
}

/** A linked issue's sync state on its page, through `issues edit`; sync reads and writes issues set to sync only. */
function SyncMark({ base, issue, onChanged }: { base: string; issue: IssueRow; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const choose = async (state: SyncState) => {
    if (saving) return;
    setSaving(true);
    await callIssues(base, { action: 'edit', id: issue.id, sync: SYNC_VALUE[state] });
    setSaving(false);
    onChanged();
  };
  return (
    <div class="syncmark" title="only issues set to sync are read from or sent to GitHub">
      <span>Sync with GitHub</span>
      <SyncStateSelect state={syncStateOf(issue)} disabled={saving} label={`Sync state of issue #${issue.id}`} onChoose={state => void choose(state)} />
    </div>
  );
}
