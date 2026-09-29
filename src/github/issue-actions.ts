/**
 * The GitHub actions on the `issues` tool.
 *
 * Only `publish` and `sync` touch the network; `link` never does. Everything
 * here is written so that failing offline costs nothing: reads happen first,
 * local writes second, upstream writes last, and any gh failure aborts before
 * the first local mutation.
 */

import { join } from 'path';
import { promises as fsp } from 'fs';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { GhError, ghDetail, type RunGhOptions } from './gh-cli.js';
import {
  ghRepoName, ghExistingLabels, ghCreateLabel, ghCreateIssue, ghViewIssue, ghListIssues,
  ghEditBody, ghAddComment, ghCloseIssue, ghCurrentUser,
  markComment, commentGithubId, stripCommentMarker, stripLocalMarker,
  bodyHash, classifySync, resolveStatus, unionLabels, closedReasonFrom,
  type RemoteIssue, type RemoteIssueSummary,
} from './gh-issues.js';
import {
  emitSequenceBlock, stripSequenceBlocks, findSequenceBlock, findSequenceBlocks,
  parseRemoteSequence, auditSequence,
} from './issue-body.js';
import {
  getIssue, getIssues, addIssue, addIssueComment, updateIssueFields, findIssueByGithub,
  updateIssueCommentText,
  getIssueSequencesDir, generateSequenceFilename, updateIssueSequenceFile,
  isCompletedStatus, completedStatusFor,
  type TrackedIssue, type IssueType,
} from '../issue-tracker.js';
import { getProjectDir } from '../helpers/paths.js';

/** GitHub's hard cap is 65536; leave room for the marker and fence. */
const MAX_BODY_CHARS = 65_000;

export interface GithubActionArgs {
  id?: number;
  github?: number;
  repo?: string;
  confirm?: boolean;
  take?: 'local' | 'remote';
  fromComment?: number;
  allowPrivilegedSteps?: boolean;
  type?: IssueType;
}

export interface GithubActionDeps {
  /** Injected so tests never spawn gh. Defaults to the real module. */
  runOpts?: RunGhOptions;
}

/** Every handler funnels gh failures through here, so one taxonomy covers all. */
export function ghErrorResponse(err: unknown): any {
  if (!(err instanceof GhError)) throw err;
  switch (err.code) {
    case 'GH_NOT_INSTALLED':
      return createErrorResponse('ISSUES_GH_NOT_INSTALLED');
    case 'GH_NOT_AUTHENTICATED':
      return createErrorResponse('ISSUES_GH_NOT_AUTHENTICATED');
    case 'GH_NO_REPO':
      return createErrorResponse('ISSUES_GH_NO_REPO', { cwd: getProjectDir() });
    case 'GH_TIMEOUT':
      return createErrorResponse('ISSUES_GH_TIMEOUT', {
        command: err.args.slice(0, 2).join(' '),
        timeoutSeconds: 20,
      });
    default:
      return createErrorResponse('ISSUES_GH_FAILED', {
        command: err.args.slice(0, 2).join(' '),
        detail: ghDetail(err),
      });
  }
}

async function readSequence(issue: TrackedIssue): Promise<unknown | null> {
  if (!issue.sequenceFile) return null;
  try {
    const raw = await fsp.readFile(join(getIssueSequencesDir(), issue.sequenceFile), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The local body as it is compared, hashed, and pushed: sequence blocks and
 *  the upstream-only marker removed. */
function localProse(issue: TrackedIssue): string {
  return stripLocalMarker(stripSequenceBlocks(issue.body)).trim();
}

/** Same normalisation for a body that came down from GitHub. */
function remoteProse(body: string): string {
  return stripLocalMarker(stripSequenceBlocks(body)).trim();
}

/** The body as it goes to GitHub: local prose, then the sequence, then a
 *  marker that identifies the issue if the local stamp is ever lost. */
function buildPublishBody(issue: TrackedIssue, sequence: unknown | null): string {
  const parts = [localProse(issue)];
  if (sequence) parts.push(emitSequenceBlock(sequence));
  parts.push(`<!-- devharness: local #${issue.id} -->`);
  return parts.filter(Boolean).join('\n\n');
}

/** Fold remote comments into the local timeline without duplicating. A local
 *  comment stamped with a gh id claims that id; an unstamped local comment
 *  with identical text claims the first unclaimed remote comment that matches
 *  (it was pushed before its id could be recorded) and is stamped now.
 *  Whatever remains is genuinely new and is appended. */
async function reconcileComments(
  issueId: number, remoteComments: RemoteIssue['comments']
): Promise<{ added: number; stamped: number }> {
  const issue = (await getIssue(issueId))!;
  const seen = new Set(
    issue.comments.map(c => commentGithubId(c.text)).filter((v): v is string => v !== null)
  );

  let added = 0, stamped = 0;
  for (const remote of remoteComments) {
    if (!remote.id || seen.has(remote.id)) continue;
    seen.add(remote.id);

    const match = issue.comments.find(
      c => commentGithubId(c.text) === null && c.text.trim() === remote.body.trim()
    );
    if (match) {
      match.text = markComment(remote.id, match.text);
      await updateIssueCommentText(issueId, match.timestamp, match.text);
      stamped++;
      continue;
    }

    await addIssueComment(issueId, markComment(remote.id, remote.body));
    added++;
  }
  return { added, stamped };
}

// =============================================================================
// publish
// =============================================================================

export async function handlePublish(args: GithubActionArgs, deps: GithubActionDeps = {}): Promise<any> {
  if (args.id === undefined) return createErrorResponse('MISSING_PARAMETER', { missing: 'id', action: 'publish' });

  const issue = await getIssue(args.id);
  if (!issue) return createErrorResponse('ISSUES_NOT_FOUND', { id: args.id, message: 'Nothing to publish.' });

  if (issue.github !== undefined) {
    return createErrorResponse('ISSUES_PUBLISH_ALREADY_LINKED', {
      type: issue.type, id: issue.id, number: issue.github, repo: issue.githubRepo ?? 'GitHub',
    });
  }

  try {
    const repo = await ghRepoName(args.repo, deps.runOpts);
    const sequence = await readSequence(issue);
    const body = buildPublishBody(issue, sequence);

    if (body.length > MAX_BODY_CHARS) {
      const sequenceLength = sequence ? emitSequenceBlock(sequence).length : 0;
      return createErrorResponse('ISSUES_PUBLISH_TOO_LARGE', {
        bodyLength: body.length, limit: MAX_BODY_CHARS, sequenceLength: sequenceLength || undefined,
      });
    }

    const existing = await ghExistingLabels(args.repo, deps.runOpts);
    const missing = issue.labels.filter(l => !existing.has(l));

    if (!args.confirm) {
      const response = createSuccessResponse('ISSUES_PUBLISH_DRAFT', {
        type: issue.type, id: issue.id, repo, title: issue.title,
        labels: issue.labels.length > 0 ? issue.labels.join(', ') : '(none)',
        labelsToCreate: missing.length > 0 ? missing.join(', ') : undefined,
        draftBody: body,
      });
      response._meta = {
        tool: 'issues', action: 'publish', timestamp: Date.now(),
        github: { action: 'publish', repo, posted: false },
      };
      return response;
    }

    for (const label of missing) await ghCreateLabel(label, args.repo, deps.runOpts);

    const created = await ghCreateIssue(
      { title: issue.title, body, labels: issue.labels, repo: args.repo }, deps.runOpts
    );

    if (created.number === null) {
      return createErrorResponse('ISSUES_PUBLISH_STAMP_FAILED', {
        type: issue.type, id: issue.id, url: created.url, number: '<see the URL>',
        reason: 'gh did not print a parseable issue number',
      });
    }

    // Upstream first, stamp second: a failure here is recoverable, the
    // reverse order is not.
    const now = new Date();
    try {
      await updateIssueFields(issue.id, {
        github: created.number,
        githubRepo: repo,
        githubSyncedAt: now,
        githubBodyHash: bodyHash(localProse(issue)),
      });
    } catch (err) {
      return createErrorResponse('ISSUES_PUBLISH_STAMP_FAILED', {
        type: issue.type, id: issue.id, url: created.url, number: created.number,
        reason: (err as Error).message,
      });
    }

    let commentsPushed = 0;
    for (const comment of issue.comments) {
      if (commentGithubId(comment.text)) continue;
      await ghAddComment(created.number, comment.text, args.repo, deps.runOpts);
      commentsPushed++;
    }
    if (commentsPushed > 0) {
      // gh does not return the new comment ids; re-read the issue so the
      // pushed comments get stamped and are never pushed twice.
      const refreshed = await ghViewIssue(created.number, args.repo, deps.runOpts);
      await reconcileComments(issue.id, refreshed.comments);
    }

    const response = createSuccessResponse('ISSUES_PUBLISHED', {
      type: issue.type, id: issue.id, number: created.number, url: created.url, repo,
      labelsCreated: missing.length > 0 ? missing.join(', ') : undefined,
      commentsPushed: commentsPushed || undefined,
    });
    response._meta = {
      tool: 'issues', action: 'publish', timestamp: Date.now(),
      github: { action: 'publish', repo, number: created.number, url: created.url, posted: true },
    };
    return response;
  } catch (err) {
    return ghErrorResponse(err);
  }
}

// =============================================================================
// link
// =============================================================================

export async function handleLink(args: GithubActionArgs): Promise<any> {
  if (args.id === undefined) return createErrorResponse('MISSING_PARAMETER', { missing: 'id', action: 'link' });
  if (args.github === undefined) return createErrorResponse('MISSING_PARAMETER', { missing: 'github', action: 'link' });

  const issue = await getIssue(args.id);
  if (!issue) return createErrorResponse('ISSUES_NOT_FOUND', { id: args.id, message: 'Nothing to link.' });

  await updateIssueFields(issue.id, { github: args.github, githubRepo: args.repo ?? issue.githubRepo });

  const response = createSuccessResponse('ISSUES_LINKED', {
    type: issue.type, id: issue.id, number: args.github, repo: args.repo ?? issue.githubRepo ?? 'GitHub',
  });
  response._meta = {
    tool: 'issues', action: 'link', timestamp: Date.now(),
    github: { action: 'link', number: args.github, repo: args.repo ?? issue.githubRepo },
  };
  return response;
}

// =============================================================================
// import
// =============================================================================

function inferType(labels: string[]): IssueType {
  return labels.some(l => /^(bug|defect|regression)$/i.test(l)) ? 'bug' : 'feature';
}

export async function handleImport(args: GithubActionArgs, deps: GithubActionDeps = {}): Promise<any> {
  if (args.github === undefined) return createErrorResponse('MISSING_PARAMETER', { missing: 'github', action: 'import' });

  try {
    const repo = await ghRepoName(args.repo, deps.runOpts);
    const existing = await findIssueByGithub(args.github, repo);
    if (existing) {
      return createSuccessResponse('ISSUES_IMPORT_EXISTS', {
        repo, number: args.github, type: existing.type, id: existing.id, status: existing.status,
      });
    }

    const remote = await ghViewIssue(args.github, args.repo, deps.runOpts);
    const type = args.type ?? inferType(remote.labels);
    const closed = remote.state === 'CLOSED';
    const body = remoteProse(remote.body);

    // acknowledged, never pending: a pending bug blocks every other tool, so
    // importing must not wedge the toolchain.
    const created = await addIssue({
      type,
      title: remote.title,
      body,
      labels: remote.labels,
      initialStatus: closed ? completedStatusFor(type) : 'acknowledged',
      recordingName: 'github',
    });

    const now = new Date();
    await updateIssueFields(created.id, {
      github: remote.number,
      githubRepo: repo,
      githubSyncedAt: now,
      githubBodyHash: bodyHash(body),
      closedReason: closed ? closedReasonFrom(remote.stateReason) : undefined,
      resolvedAt: closed ? now : undefined,
    });

    for (const comment of remote.comments) {
      await addIssueComment(created.id, markComment(comment.id, comment.body));
    }

    const response = createSuccessResponse('ISSUES_IMPORTED', {
      repo, number: remote.number, type, id: created.id, title: remote.title,
      status: closed ? completedStatusFor(type) : 'acknowledged',
      sequenceFound: findSequenceBlock(remote.body) ? true : undefined,
    });
    response._meta = {
      tool: 'issues', action: 'import', timestamp: Date.now(),
      github: { action: 'import', repo, number: remote.number, url: remote.url },
    };
    return response;
  } catch (err) {
    return ghErrorResponse(err);
  }
}

// =============================================================================
// sync
// =============================================================================

interface SyncOutcome {
  id: number;
  number: number;
  action: string;
  detail?: string;
}

/**
 * Reconcile status, independent of whether the body moved.
 *
 * These are separate concerns: an issue closed locally but still open
 * upstream needs closing whatever its body says. Folding this into the body
 * classification loses the pending close the moment a body sync marks the
 * issue as up to date.
 */
async function applyStatus(
  issue: TrackedIssue, remote: Pick<RemoteIssueSummary, 'state' | 'stateReason'>,
  repo: string | undefined, now: Date, confirm: boolean, opts?: RunGhOptions
): Promise<{ detail?: string; pendingConfirm?: string }> {
  const status = resolveStatus(issue, remote, now);

  if (status.closeUpstream) {
    if (!confirm) return { pendingConfirm: `close #${issue.github} upstream` };
    await ghCloseIssue(issue.github!, status.closeUpstream, repo, opts);
    await updateIssueFields(issue.id, { closedReason: status.closeUpstream });
    return { detail: 'closed upstream' };
  }

  if (status.status || status.closedReason !== issue.closedReason) {
    await updateIssueFields(issue.id, {
      status: status.status ?? issue.status,
      closedReason: status.closedReason,
      resolvedAt: status.reopened ? undefined : (status.resolvedAt ?? issue.resolvedAt),
    });
    if (status.reopened) return { detail: 'reopened' };
    if (status.status) return { detail: `status ${status.status}` };
  }

  return {};
}

async function applyPull(issue: TrackedIssue, remote: RemoteIssue, now: Date): Promise<string> {
  const body = remoteProse(remote.body);

  await updateIssueFields(issue.id, {
    body,
    title: remote.title || issue.title,
    labels: unionLabels(issue.labels, remote.labels),
    githubSyncedAt: now,
    githubBodyHash: bodyHash(body),
  });

  const { added } = await reconcileComments(issue.id, remote.comments);

  const bits = ['body'];
  if (added > 0) bits.push(`${added} comment(s)`);
  return `pulled ${bits.join(', ')}`;
}

/** Push unstamped local comments up, claiming any that are already upstream
 *  first (a previous push may have posted one and died before its id was
 *  stored). Returns how many were actually posted. */
async function pushComments(
  issueId: number, github: number, repo: string | undefined, opts?: RunGhOptions
): Promise<number> {
  const before = (await getIssue(issueId))!;
  if (!before.comments.some(c => commentGithubId(c.text) === null)) return 0;

  const remote = await ghViewIssue(github, repo, opts);
  await reconcileComments(issueId, remote.comments);

  let pushed = 0;
  for (const comment of (await getIssue(issueId))!.comments) {
    if (commentGithubId(comment.text)) continue;
    await ghAddComment(github, comment.text, repo, opts);
    pushed++;
  }
  if (pushed > 0) {
    // gh does not return the new comment ids; re-read the issue so the
    // pushed comments get stamped and are never pushed twice.
    const refreshed = await ghViewIssue(github, repo, opts);
    await reconcileComments(issueId, refreshed.comments);
  }
  return pushed;
}

async function applyPush(
  issue: TrackedIssue, repo: string | undefined, now: Date, opts?: RunGhOptions
): Promise<string> {
  const sequence = await readSequence(issue);
  const prose = localProse(issue);

  await ghEditBody(issue.github!, buildPublishBody(issue, sequence), repo, opts);

  const pushed = await pushComments(issue.id, issue.github!, repo, opts);

  await updateIssueFields(issue.id, { githubSyncedAt: now, githubBodyHash: bodyHash(prose) });

  const bits = ['body'];
  if (pushed > 0) bits.push(`${pushed} comment(s)`);
  return `pushed ${bits.join(', ')}`;
}

export async function handleSync(args: GithubActionArgs, deps: GithubActionDeps = {}): Promise<any> {
  try {
    const repo = await ghRepoName(args.repo, deps.runOpts);
    const all = await getIssues({ includeCompleted: true });
    // Scoped to one repo: a stamped issue must match it, and a bare
    // `github: N` stamp belongs to the repo gh infers for this project,
    // never to an explicit override - otherwise an override sweeps every
    // linked issue and can adopt a stranger's issue with the same number.
    const linked = all.filter(i =>
      i.github !== undefined
      && (args.id === undefined || i.id === args.id)
      && (i.githubRepo ? i.githubRepo === repo : args.repo === undefined)
    );

    if (linked.length === 0) return createSuccessResponse('ISSUES_SYNC_NOTHING_LINKED');

    const summaries = await ghListIssues(args.repo, deps.runOpts);
    const byNumber = new Map<number, RemoteIssueSummary>(summaries.map(s => [s.number, s]));

    const now = new Date();
    const outcomes: SyncOutcome[] = [];
    const conflicts: Array<{ id: number; number: number }> = [];
    const pendingConfirm: string[] = [];

    for (const issue of linked) {
      const summary = byNumber.get(issue.github!);
      const prose = localProse(issue);
      const classification = classifySync(issue, summary, prose);

      // An explicit --take overrides the classification for this issue only.
      let action = classification.action;
      if (args.take && args.id !== undefined) action = args.take === 'local' ? 'push' : 'pull';

      if (action === 'missing-upstream') {
        outcomes.push({ id: issue.id, number: issue.github!, action: 'missing upstream' });
        continue;
      }
      if (action === 'conflict') {
        conflicts.push({ id: issue.id, number: issue.github! });
        outcomes.push({ id: issue.id, number: issue.github!, action: 'CONFLICT - both sides changed, nothing written' });
        continue;
      }

      // Status first, and for every issue - including ones whose body is
      // already up to date, which is where a pending close would otherwise
      // be dropped and never retried.
      const statusResult = await applyStatus(
        issue, summary!, args.repo, now, args.confirm === true, deps.runOpts
      );
      if (statusResult.pendingConfirm) pendingConfirm.push(statusResult.pendingConfirm);

      const details: string[] = [];
      if (statusResult.detail) details.push(statusResult.detail);

      if (action !== 'none') {
        const fresh = (await getIssue(issue.id))!;
        if (action === 'pull') {
          const remote = await ghViewIssue(issue.github!, args.repo, deps.runOpts);
          details.push(await applyPull(fresh, remote, now));
        } else {
          details.push(await applyPush(fresh, args.repo, now, deps.runOpts));
        }
      }

      // Comments are timeline additions, not part of the body hash, so a new
      // local comment must push even when the body classifies as unchanged
      // (push already sent them; pull only claimed or imported).
      if (action !== 'push') {
        const pushed = await pushComments(issue.id, issue.github!, args.repo, deps.runOpts);
        if (pushed > 0) details.push(`pushed ${pushed} comment(s)`);
      }

      outcomes.push({
        id: issue.id, number: issue.github!,
        action: details.length > 0 ? details.join(', ') : 'up to date',
      });
    }

    const response = createSuccessResponse('ISSUES_SYNC_RESULT', {
      repo,
      checked: linked.length,
      results: outcomes.map(o => `- #${o.id} (${repo}#${o.number}): ${o.action}`).join('\n'),
      conflictCount: conflicts.length || undefined,
      pendingConfirm: pendingConfirm.length > 0 ? pendingConfirm.join(', ') : undefined,
    });
    response._meta = {
      tool: 'issues', action: 'sync', timestamp: Date.now(),
      github: {
        action: 'sync', repo,
        changed: outcomes.map(o => ({ id: o.id, number: o.number, action: o.action })),
        conflicts,
      },
    };
    return response;
  } catch (err) {
    return ghErrorResponse(err);
  }
}

// =============================================================================
// pullSequence
// =============================================================================

export async function handlePullSequence(
  args: GithubActionArgs,
  deps: GithubActionDeps & { knownTools?: () => string[] } = {}
): Promise<any> {
  if (args.id === undefined) return createErrorResponse('MISSING_PARAMETER', { missing: 'id', action: 'pullSequence' });

  const issue = await getIssue(args.id);
  if (!issue) return createErrorResponse('ISSUES_NOT_FOUND', { id: args.id, message: 'Nothing to pull into.' });
  if (issue.github === undefined) {
    return createErrorResponse('ISSUES_PUBLISH_ALREADY_LINKED', {
      type: issue.type, id: issue.id, number: 0, repo: 'no upstream issue - link or publish it first',
    });
  }

  try {
    const remote = await ghViewIssue(issue.github, args.repo ?? issue.githubRepo, deps.runOpts);

    const source = args.fromComment !== undefined ? `comment ${args.fromComment}` : 'the issue body';
    const haystack = args.fromComment !== undefined
      ? remote.comments[args.fromComment - 1]?.body ?? ''
      : remote.body;

    const block = findSequenceBlock(haystack);
    if (!block) {
      const candidates = remote.comments
        .map((c, i) => (findSequenceBlock(c.body) ? i + 1 : null))
        .filter((v): v is number => v !== null);
      return createErrorResponse('ISSUES_SEQUENCE_NOT_IN_ISSUE', {
        source, candidates: candidates.length > 0 ? candidates.join(', ') : undefined,
      });
    }

    const parsed = parseRemoteSequence(block.content);
    if (!parsed.ok) return createErrorResponse('ISSUES_SEQUENCE_INVALID', { source, reason: parsed.reason });

    // A sequence written by someone else is third-party code that will drive
    // this machine. Only the account gh is logged in as vouches for itself;
    // anything else needs a human to read the sequence and confirm once.
    const author = args.fromComment !== undefined
      ? remote.comments[args.fromComment - 1]?.author ?? ''
      : remote.author;
    if (args.confirm !== true) {
      const viewer = await ghCurrentUser(deps.runOpts);
      if (!author || author !== viewer) {
        return createErrorResponse('ISSUES_SEQUENCE_FOREIGN_AUTHOR', {
          author: author || 'an unknown account', viewer, source,
          repo: args.repo ?? issue.githubRepo ?? 'GitHub', number: issue.github,
        });
      }
    }

    const audit = auditSequence(parsed.sequence);

    if (audit.privileged.length > 0 && args.allowPrivilegedSteps !== true) {
      const steps = [...parsed.sequence.commands, ...(parsed.sequence.teardown ?? [])]
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => audit.privileged.includes(s.tool))
        .map(({ s, i }) => `${i + 1}. ${s.tool}${s.comment ? ` - ${s.comment}` : ''}`);
      return createErrorResponse('ISSUES_SEQUENCE_PRIVILEGED_BLOCKED', {
        privileged: audit.privileged.join(', '), stepList: steps.join('\n'),
      });
    }

    // Validate tool names before anything lands on disk. replay only checks
    // on create/load, so a file written straight into the sequences dir
    // would otherwise skip the backstop entirely.
    const known = deps.knownTools?.();
    if (known && known.length > 0) {
      const unknown = audit.tools.filter(t => !known.includes(t) && t !== 'forEach');
      if (unknown.length > 0) {
        return createErrorResponse('ISSUES_SEQUENCE_INVALID', {
          source, reason: `Unknown tool name(s): ${unknown.join(', ')}`,
        });
      }
    }

    // The payload's own `name` is discarded: loading a sequence evicts any
    // same-named one already in memory, so a hostile name could delete the
    // user's own sequence.
    const filename = generateSequenceFilename(issue.type, issue.id, issue.title);
    const name = filename.replace(/\.json$/, '');
    const dir = getIssueSequencesDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      join(dir, filename),
      JSON.stringify({ ...parsed.sequence, name, _comment: `Pulled from ${issue.githubRepo ?? 'GitHub'}#${issue.github}` }, null, 2),
      'utf-8'
    );
    await updateIssueSequenceFile(issue.id, filename);

    const response = createSuccessResponse('ISSUES_SEQUENCE_PULLED', {
      type: issue.type, id: issue.id, sequenceFile: filename, source,
      steps: audit.steps, tools: audit.tools.join(', '),
      privileged: audit.privileged.length > 0 ? audit.privileged.join(', ') : undefined,
    });
    response._meta = {
      tool: 'issues', action: 'pullSequence', timestamp: Date.now(),
      github: { action: 'pullSequence', number: issue.github, sequence: audit },
    };
    return response;
  } catch (err) {
    return ghErrorResponse(err);
  }
}
