/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Markdown } from './markdown.js';
import { Row } from './row.js';
import { Glyph } from './glyph.js';
import type { IssueRow, IssueSync, SequenceNote, ToolRun } from '../wire.js';

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
 * `type:bug` or `type:feature` keeps that type, and the words left over match
 * title, body, a label or `#number`.
 */
function parseFilter(filter: string): { labels: string[]; type?: IssueRow['type']; words: string } {
  const labels: string[] = [];
  let type: IssueRow['type'] | undefined;
  const words = filter
    .replace(/label:(?:"([^"]+)"|(\S+))/gi, (_, quoted: string | undefined, bare: string | undefined) => {
      labels.push((quoted ?? bare ?? '').toLowerCase());
      return ' ';
    })
    .replace(/type:(bug|feature)\b/gi, (_, named: string) => {
      type = named.toLowerCase() as IssueRow['type'];
      return ' ';
    });
  return { labels, type, words: words.trim().toLowerCase() };
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

/**
 * The whole tracker against GitHub, above the list: how many issues are
 * linked, how many carry changes the next sync would push, how many are local
 * only, and when the newest sync ran. It reads the issue files alone, so a
 * change made on GitHub shows only after a sync.
 *
 * Sync runs `issues sync`: it pulls GitHub's changes and pushes local edits
 * and comments. Closing an issue upstream still needs `confirm`, so the reply
 * lists those closes and writes none of them.
 */
function SyncBox({ base, issues, onSynced }: { base: string; issues: IssueRow[]; onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [said, setSaid] = useState<ToolRun | null>(null);
  const sending = useRef(false);
  const sync = async () => {
    if (sending.current) return;
    sending.current = true;
    setSyncing(true);
    setSaid(null);
    const run = await callIssues(base, { action: 'sync' });
    sending.current = false;
    setSyncing(false);
    setSaid(run);
    onSynced();
  };
  const linked = issues.filter(issue => issue.github);
  const waiting = linked.filter(issue => outgoing(issue.github!).length > 0);
  const neverSynced = linked.filter(issue => issue.github!.syncedAt === undefined).length;
  const local = issues.length - linked.length;
  const newest = Math.max(0, ...linked.map(issue => issue.github!.syncedAt ?? 0));
  const repos = [...new Set(linked.map(issue => issue.github!.repo).filter(Boolean))];
  return (
    <div class={waiting.length > 0 ? 'issuesync waiting' : 'issuesync'}>
      <span class="issuesynchead">GitHub{repos.length === 1 && <span class="issuesyncrepo"> · {repos[0]}</span>}</span>
      {linked.length === 0 ? (
        <span class="issuesyncfacts">No issue is linked yet. <code>issues publish</code> or <code>issues link</code> connects one.</span>
      ) : (
        <span class="issuesyncfacts">
          <span>{linked.length} linked</span>
          {waiting.length > 0
            ? <span class="issuesyncout">{waiting.length} with changes to push</span>
            : <span>nothing waiting to push</span>}
          {neverSynced > 0 && <span>{neverSynced} never synced</span>}
          <span>{local} local only</span>
          <span>{newest > 0 ? `last synced ${ago(newest)}` : 'never synced'}</span>
        </span>
      )}
      <span class="grow" />
      {linked.length > 0 && (
        <button class="resetbtn issuesyncbtn" disabled={syncing} onClick={() => void sync()}
          title="pull GitHub's changes and push local edits and comments; closing an issue upstream waits for confirm">
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      )}
      {said
        ? <pre class={said.failed ? 'issuesyncsaid bad' : 'issuesyncsaid'}>{said.result.trim()}</pre>
        : <span class="issuesyncnote">Changes made on GitHub show after a sync.</span>}
    </div>
  );
}

/** Open: a ring with a dot. Closed: a ring with a tick. Both 16px, as GitHub draws them. */
function StateMark({ shut }: { shut: boolean }) {
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
 */
export function Issues({ base, issue: openId, onIssue, onGoToNote }: {
  base: string;
  issue: number | null;
  onIssue: (issue: number | null) => void;
  /** `step` is 0-based. */
  onGoToNote: (sequence: string, step: number) => void;
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

  const opened = openId === null ? undefined : issues.find(issue => issue.id === openId);
  if (opened) {
    return <IssuePage base={base} issue={opened} onBack={() => onIssue(null)} onChanged={() => setReads(n => n + 1)}
      onGoToNote={onGoToNote} onLabel={filterByLabel} onType={filterByType} />;
  }

  const { labels: wantedLabels, type: wantedType, words: query } = parseFilter(filter);
  const matching = issues.filter(issue => wantedLabels.every(wanted => issue.labels.some(label => label.toLowerCase() === wanted))
    && (wantedType === undefined || issue.type === wantedType)
    && (!query
      || issue.title.toLowerCase().includes(query)
      || issue.body.toLowerCase().includes(query)
      || issue.labels.some(label => label.toLowerCase().includes(query))
      || `#${issue.id}` === query || String(issue.id) === query));
  const openCount = matching.filter(issue => !closed(issue)).length;
  const closedCount = matching.length - openCount;
  // Newest first, as GitHub lists them.
  const shown = matching.filter(issue => closed(issue) === showClosed).sort((a, b) => b.id - a.id);

  return (
    <div class="issues">
      <input class="issuefilter" type="search" placeholder="Filter issues by title, body, #number, label:name or type:bug"
        aria-label="Filter issues" value={filter}
        onInput={(e: Event) => setFilter((e.target as HTMLInputElement).value)} />
      <SyncBox base={base} issues={issues} onSynced={() => setReads(n => n + 1)} />
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
                    {issue.github
                      ? <> · GitHub #{issue.github.number}{outgoing(issue.github).length > 0 && <> · <span class="issuesyncout">{outgoing(issue.github).join(', ')}</span></>}</>
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
function IssuePage({ base, issue, onBack, onChanged, onGoToNote, onLabel, onType }: {
  base: string; issue: IssueRow; onBack: () => void; onChanged: () => void; onGoToNote: (sequence: string, step: number) => void;
  /** A label pressed: the list, filtered to it. */
  onLabel: (label: string) => void;
  onType: (type: IssueRow['type']) => void;
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
          <section>
            <h3>Sequence</h3>
            {issue.sequenceFile ? <p class="issuemono">{issue.sequenceFile}</p> : <p class="quiet">None linked</p>}
            <SequenceLink base={base} issue={issue} onLinked={onChanged} />
          </section>
          <section>
            <h3>GitHub</h3>
            {issue.github ? (
              <>
                <p>#{issue.github.number}{issue.github.repo && <> in {issue.github.repo}</>}</p>
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
