import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { setGhSpawnForTests } from './gh-cli.js';
import {
  handlePublish, handleSync, handleImport, handleLink, handlePullSequence,
} from './issue-actions.js';
import {
  __resetForTests, addIssue, getIssue, addIssueComment, updateIssueFields,
  getIssueSequencesDir,
} from '../issue-tracker.js';
import { emitSequenceBlock } from './issue-body.js';
import { bodyHash } from './gh-issues.js';

let tempDir: string;
/** Every gh invocation, in order, as argv arrays. */
let calls: string[][];
/** argv[0..2] prefix -> stdout. An array is served in order, its last entry
 *  repeating. Missing entries exit 0 with empty stdout. */
let responses: Map<string, string | string[]>;
let stdinSeen: string[];

function key(args: string[]): string {
  return args.slice(0, 2).join(' ');
}

function installFakeGh() {
  calls = [];
  stdinSeen = [];
  responses = new Map([
    ['repo view', JSON.stringify({ nameWithOwner: 'InDate/devharness' })],
    ['label list', JSON.stringify([{ name: 'bug' }, { name: 'enhancement' }])],
    ['issue list', JSON.stringify([])],
    ['api user', 'InDate\n'],
  ]);

  setGhSpawnForTests(((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (s: string) => stdinSeen.push(s), end: () => {} };
    child.kill = () => true;

    setImmediate(() => {
      const entry = responses.get(key(args));
      const body = Array.isArray(entry)
        ? (entry.length > 1 ? entry.shift() : entry[0])
        : entry;
      if (body) child.stdout.emit('data', body);
      child.emit('close', 0);
    });
    return child;
  }) as any);
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'gh-actions-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
  installFakeGh();
});

afterEach(async () => {
  setGhSpawnForTests(null);
  __resetForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function ran(prefix: string): boolean {
  return calls.some(args => key(args) === prefix);
}

function text(response: any): string {
  return response.content.map((c: any) => c.text).join('\n');
}

describe('publish', () => {
  it('drafts without posting anything', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Submit fails', body: '## Steps\n1. Click' });

    const response = await handlePublish({ id: issue.id });

    expect(ran('issue create')).toBe(false);
    expect(ran('label create')).toBe(false);
    expect(response._meta.github).toMatchObject({ posted: false });
    // The draft is the local body verbatim, not a rewrite of it.
    expect(text(response)).toContain('## Steps\n1. Click');
    expect((await getIssue(issue.id))!.github).toBeUndefined();
  });

  it('lists the labels it would have to create', async () => {
    const issue = await addIssue({ type: 'bug', title: 'x', labels: ['inspect', 'bug'] });

    const response = await handlePublish({ id: issue.id });

    expect(text(response)).toContain('inspect');
    expect(ran('label create')).toBe(false);
  });

  it('creates missing labels, posts, then stamps', async () => {
    responses.set('issue create', 'https://github.com/InDate/devharness/issues/111\n');
    const issue = await addIssue({ type: 'bug', title: 'x', body: 'Body', labels: ['inspect', 'bug'] });

    const response = await handlePublish({ id: issue.id, confirm: true });

    const created = calls.filter(a => key(a) === 'label create').map(a => a[2]);
    expect(created).toEqual(['inspect']);  // 'bug' already exists upstream
    expect(response._meta.github).toMatchObject({ number: 111, posted: true });

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.github).toBe(111);
    expect(reloaded!.githubRepo).toBe('InDate/devharness');
    expect(reloaded!.githubBodyHash).toBeTruthy();
  });

  it('sends the sequence as a fenced block in the body', async () => {
    responses.set('issue create', 'https://github.com/InDate/devharness/issues/112\n');
    const issue = await addIssue({ type: 'bug', title: 'x', body: 'Body', sequenceFile: 'repro.json' });
    const dir = getIssueSequencesDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'repro.json'), JSON.stringify({ name: 'repro', commands: [{ tool: 'navigate' }] }), 'utf-8');

    await handlePublish({ id: issue.id, confirm: true });

    expect(stdinSeen.join('\n')).toContain('```json devharness-sequence');
    expect(stdinSeen.join('\n')).toContain('<!-- devharness: local #');
  });

  it('refuses a second publish of an already linked issue', async () => {
    const issue = await addIssue({ type: 'bug', title: 'x' });
    await updateIssueFields(issue.id, { github: 93, githubRepo: 'InDate/devharness' });

    const response = await handlePublish({ id: issue.id, confirm: true });

    expect(response.isError).toBe(true);
    expect(ran('issue create')).toBe(false);
  });

  it('hands back the number when the upstream issue exists but cannot be stamped', async () => {
    // gh printed something we cannot parse a number out of: the issue is
    // real, so this must not read as a create failure.
    responses.set('issue create', 'Creating issue in InDate/devharness\n');
    const issue = await addIssue({ type: 'bug', title: 'x' });

    const response = await handlePublish({ id: issue.id, confirm: true });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('exists');
    expect(text(response)).toContain('link');
  });

  it('keeps the stamp across a later comment', async () => {
    responses.set('issue create', 'https://github.com/InDate/devharness/issues/113\n');
    const issue = await addIssue({ type: 'bug', title: 'x', body: 'Body' });
    await handlePublish({ id: issue.id, confirm: true });

    await addIssueComment(issue.id, 'A local note.');
    __resetForTests();

    expect((await getIssue(issue.id))!.github).toBe(113);
  });

  it('stamps comments it pushes at publish time', async () => {
    responses.set('issue create', 'https://github.com/InDate/devharness/issues/114\n');
    responses.set('issue view', JSON.stringify({
      number: 114, title: 'x', body: 'Body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u',
      comments: [{ id: 'IC_7', body: 'A note', createdAt: '2026-08-10T00:00:00.000Z' }],
    }));
    const issue = await addIssue({ type: 'bug', title: 'x', body: 'Body' });
    await addIssueComment(issue.id, 'A note');

    await handlePublish({ id: issue.id, confirm: true });

    expect((await getIssue(issue.id))!.comments[0].text).toContain('<!-- gh: IC_7 -->');
  });

  it('surfaces a typed error when gh is missing, changing nothing', async () => {
    setGhSpawnForTests(((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      child.kill = () => true;
      setImmediate(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return child;
    }) as any);

    const issue = await addIssue({ type: 'bug', title: 'x' });
    const response = await handlePublish({ id: issue.id, confirm: true });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('gh');
    expect((await getIssue(issue.id))!.github).toBeUndefined();
  });
});

describe('link', () => {
  it('stamps without any network call', async () => {
    const issue = await addIssue({ type: 'bug', title: 'x' });

    const response = await handleLink({ id: issue.id, github: 97, repo: 'InDate/devharness' });

    expect(calls).toHaveLength(0);
    expect(response._meta.github).toMatchObject({ action: 'link', number: 97 });
    expect((await getIssue(issue.id))!.github).toBe(97);
  });
});

describe('import', () => {
  const remote = {
    number: 110, title: 'Filed upstream', body: 'Remote body',
    state: 'OPEN', stateReason: null, labels: [{ name: 'bug' }],
    updatedAt: '2026-08-10T00:00:00.000Z', url: 'https://github.com/InDate/devharness/issues/110',
    comments: [{ id: 'IC_1', body: 'A remote comment', createdAt: '2026-08-10T01:00:00.000Z' }],
  };

  it('creates a local file as acknowledged, never pending', async () => {
    responses.set('issue view', JSON.stringify(remote));

    const response = await handleImport({ github: 110 });

    const id = response._meta.github.number === 110 ? 1 : 1;
    const issue = await getIssue(id);
    // pending would block every other tool via checkBugBlocking.
    expect(issue!.status).toBe('acknowledged');
    expect(issue!.type).toBe('bug');
    expect(issue!.github).toBe(110);
    expect(issue!.body).toBe('Remote body');
    expect(issue!.comments).toHaveLength(1);
    expect(issue!.sequenceFile).toBe('');
    expect(issue!.startUrl).toBe('');
  });

  it('is idempotent - a second import finds the existing local issue', async () => {
    responses.set('issue view', JSON.stringify(remote));
    await handleImport({ github: 110 });

    const response = await handleImport({ github: 110 });

    expect(text(response)).toContain('already tracked');
    expect((await getIssue(2))).toBeUndefined();
  });

  it('imports a closed issue with its reason', async () => {
    responses.set('issue view', JSON.stringify({ ...remote, state: 'CLOSED', stateReason: 'NOT_PLANNED' }));

    await handleImport({ github: 110 });

    const issue = await getIssue(1);
    expect(issue!.status).toBe('fixed');
    expect(issue!.closedReason).toBe('not_planned');
  });

  it('leaves a sequence in the issue rather than writing it to disk', async () => {
    const withSequence = {
      ...remote,
      body: `Remote body\n\n${emitSequenceBlock({ name: 'x', commands: [{ tool: 'navigate' }] })}`,
    };
    responses.set('issue view', JSON.stringify(withSequence));

    await handleImport({ github: 110 });

    const issue = await getIssue(1);
    expect(issue!.sequenceFile).toBe('');
    expect(issue!.body).not.toContain('devharness-sequence');
    await expect(fsp.readdir(getIssueSequencesDir())).resolves.toEqual([]);
  });
});

describe('sync', () => {
  async function linkedIssue(overrides: any = {}) {
    const issue = await addIssue({ type: 'bug', title: 'Linked', body: 'Original body' });
    await updateIssueFields(issue.id, {
      github: 92, githubRepo: 'InDate/devharness',
      githubSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
      githubBodyHash: undefined,
      githubSync: true,
      ...overrides,
    });
    return (await getIssue(issue.id))!;
  }

  it('says so when nothing is linked', async () => {
    await addIssue({ type: 'bug', title: 'Local only' });
    const response = await handleSync({ confirm: true });
    expect(text(response)).toContain('No local issue is linked');
    expect(ran('issue list')).toBe(false);
  });

  it('pulls a closed upstream state down', async () => {
    const issue = await linkedIssue();
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'CLOSED', stateReason: 'COMPLETED', labels: [{ name: 'bug' }], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Upstream body', state: 'CLOSED', stateReason: 'COMPLETED',
      labels: [{ name: 'bug' }], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
    }));

    await handleSync({ confirm: true });

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.status).toBe('fixed');
    expect(reloaded!.closedReason).toBe('completed');
    expect(reloaded!.body).toBe('Upstream body');
    // Local-only labels survive an upstream that never had them.
    expect(reloaded!.labels).toContain('bug');
  });

  it('never writes a sequence file', async () => {
    await linkedIssue();
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z',
      url: 'u', comments: [],
      body: `Upstream\n\n${emitSequenceBlock({ name: 'x', commands: [{ tool: 'navigate' }] })}`,
    }));

    await handleSync({ confirm: true });

    const reloaded = await getIssue(1);
    expect(reloaded!.sequenceFile).toBe('');
    expect(reloaded!.body).not.toContain('devharness-sequence');
    await expect(fsp.readdir(getIssueSequencesDir())).resolves.toEqual([]);
  });

  it('reports a conflict and writes nothing when both sides changed', async () => {
    const issue = await linkedIssue({ githubBodyHash: 'stale-hash-from-last-sync' });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));

    const response = await handleSync({ confirm: true });

    expect(response._meta.github.conflicts).toEqual([{ id: issue.id, number: 92 }]);
    expect(text(response)).toContain('CONFLICT');
    // Not even a view was fetched, let alone a write.
    expect(ran('issue view')).toBe(false);
    expect(ran('issue edit')).toBe(false);
    const reloaded = await getIssue(issue.id);
    expect(reloaded!.body).toBe('Original body');
  });

  it('resolves a conflict in favour of local when told to', async () => {
    const issue = await linkedIssue({ githubBodyHash: 'stale-hash-from-last-sync' });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Upstream body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
    }));

    await handleSync({ id: issue.id, take: 'local', confirm: true });

    expect(ran('issue edit')).toBe(true);
    expect(stdinSeen.join('\n')).toContain('Original body');
    expect((await getIssue(issue.id))!.body).toBe('Original body');
  });

  it('holds an upstream close behind confirm', async () => {
    const issue = await linkedIssue();
    await updateIssueFields(issue.id, { status: 'fixed', githubBodyHash: 'stale' });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Upstream body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u', comments: [],
    }));

    const planned = await handleSync({});
    expect(ran('issue close')).toBe(false);
    expect(ran('issue edit')).toBe(false);
    expect(planned._meta.github.plan[0].changes).toContain('close #92 on GitHub (completed)');

    await handleSync({ confirm: true });
    expect(ran('issue close')).toBe(true);
  });

  it('does not re-import a comment it already pulled', async () => {
    await linkedIssue();
    const remoteComment = { id: 'IC_1', body: 'From GitHub', createdAt: '2026-08-09T00:00:00.000Z' };
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Upstream body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [remoteComment],
    }));

    await handleSync({ confirm: true });
    await handleSync({ confirm: true });

    expect((await getIssue(1))!.comments).toHaveLength(1);
  });

  it('a repo override only sweeps issues stamped for that repo', async () => {
    await linkedIssue();  // stamped InDate/devharness
    const bare = await addIssue({ type: 'bug', title: 'Bare stamp' });
    await updateIssueFields(bare.id, { github: 92 });  // no githubRepo

    const response = await handleSync({ repo: 'InDate/other-repo' });

    expect(text(response)).toContain('No local issue is linked');
    expect(ran('issue list')).toBe(false);
  });

  it('a bare github stamp syncs against the inferred repo', async () => {
    const bare = await addIssue({ type: 'bug', title: 'Bare stamp', body: 'Local body' });
    await updateIssueFields(bare.id, { github: 92, githubSync: true });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Bare stamp', body: 'Upstream body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
    }));

    const response = await handleSync({ confirm: true });

    expect(text(response)).toContain('#92');
    expect(text(response)).not.toContain('No local issue is linked');
  });

  it('stamps a pushed comment so it is never pushed twice', async () => {
    const issue = await linkedIssue({ githubBodyHash: 'stale' });
    await addIssueComment(issue.id, 'Local note');
    const view = (comments: any[]) => JSON.stringify({
      number: 92, title: 'Linked', body: 'Original body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u', comments,
    });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u' },
    ]));
    // First view (pre-push reconcile): not upstream yet. Second (post-push): it is.
    responses.set('issue view', [
      view([]),
      view([{ id: 'IC_9', body: 'Local note', createdAt: '2026-08-10T00:00:00.000Z' }]),
    ]);

    await handleSync({ confirm: true });

    expect(calls.filter(a => key(a) === 'issue comment')).toHaveLength(1);
    expect((await getIssue(issue.id))!.comments[0].text).toContain('<!-- gh: IC_9 -->');

    // A forced second push must skip the now-stamped comment.
    await handleSync({ id: issue.id, take: 'local', confirm: true });

    expect(calls.filter(a => key(a) === 'issue comment')).toHaveLength(1);
    expect((await getIssue(issue.id))!.comments).toHaveLength(1);
  });

  it('pushes a new local comment even when the body is unchanged', async () => {
    const issue = await linkedIssue({ githubBodyHash: bodyHash('Original body') });
    await addIssueComment(issue.id, 'Late note');
    const view = (comments: any[]) => JSON.stringify({
      number: 92, title: 'Linked', body: 'Original body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u', comments,
    });
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', [
      view([]),
      view([{ id: 'IC_11', body: 'Late note', createdAt: '2026-08-10T00:00:00.000Z' }]),
    ]);

    await handleSync({ confirm: true });

    expect(ran('issue edit')).toBe(false);  // body classified as unchanged
    expect(calls.filter(a => key(a) === 'issue comment')).toHaveLength(1);
    expect((await getIssue(issue.id))!.comments[0].text).toContain('<!-- gh: IC_11 -->');
  });

  it('claims an unstamped comment that already exists upstream instead of re-posting it', async () => {
    // A push that died after `gh issue comment` but before the id was stored.
    const issue = await linkedIssue({ githubBodyHash: 'stale' });
    await addIssueComment(issue.id, 'Orphaned by a dead push');
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Original body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-07-01T00:00:00.000Z', url: 'u',
      comments: [{ id: 'IC_4', body: 'Orphaned by a dead push', createdAt: '2026-08-10T00:00:00.000Z' }],
    }));

    await handleSync({ confirm: true });

    expect(calls.filter(a => key(a) === 'issue comment')).toHaveLength(0);
    const comments = (await getIssue(issue.id))!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain('<!-- gh: IC_4 -->');
  });

  it('stamps a matching unstamped local comment on pull instead of duplicating it', async () => {
    const issue = await linkedIssue();
    await addIssueComment(issue.id, 'Same words');
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', body: 'Upstream body', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u',
      comments: [{ id: 'IC_5', body: 'Same words', createdAt: '2026-08-09T00:00:00.000Z' }],
    }));

    await handleSync({ confirm: true });

    const comments = (await getIssue(issue.id))!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain('<!-- gh: IC_5 -->');
  });

  it('strips the upstream marker on pull and pushes exactly one back', async () => {
    const issue = await linkedIssue();
    responses.set('issue list', JSON.stringify([
      { number: 92, state: 'OPEN', stateReason: null, labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u' },
    ]));
    responses.set('issue view', JSON.stringify({
      number: 92, title: 'Linked', state: 'OPEN', stateReason: null,
      labels: [], updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
      body: `Upstream body\n\n<!-- devharness: local #${issue.id} -->`,
    }));

    await handleSync({ confirm: true });
    expect((await getIssue(issue.id))!.body).toBe('Upstream body');

    await handleSync({ id: issue.id, take: 'local', confirm: true });
    const pushedBody = stdinSeen[stdinSeen.length - 1];
    expect(pushedBody.match(/devharness: local #/g)).toHaveLength(1);
  });
});

describe('pullSequence', () => {
  async function issueWithRemoteSequence(sequence: unknown, author = 'InDate') {
    const issue = await addIssue({ type: 'bug', title: 'Repro me' });
    await updateIssueFields(issue.id, { github: 97, githubRepo: 'InDate/devharness' });
    responses.set('issue view', JSON.stringify({
      number: 97, title: 'Repro me', state: 'OPEN', stateReason: null, labels: [],
      author: { login: author },
      updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
      body: `Prose\n\n${emitSequenceBlock(sequence)}`,
    }));
    return issue;
  }

  it('writes the sequence and links it', async () => {
    const issue = await issueWithRemoteSequence({ name: 'whatever', commands: [{ tool: 'navigate', params: { url: 'http://x' } }] });

    const response = await handlePullSequence({ id: issue.id }, { knownTools: () => ['navigate', 'input'] });

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.sequenceFile).toBe('bug-001-repro-me.json');
    const written = JSON.parse(await fsp.readFile(join(getIssueSequencesDir(), reloaded!.sequenceFile), 'utf-8'));
    // The payload's own name is discarded: loading a sequence evicts any
    // same-named one in memory, so a hostile name could delete the user's.
    expect(written.name).toBe('bug-001-repro-me');
    expect(response._meta.github.sequence).toMatchObject({ steps: 1, tools: ['navigate'] });
  });

  it('refuses a sequence written by another account, writing nothing', async () => {
    const issue = await issueWithRemoteSequence(
      { commands: [{ tool: 'navigate', params: { url: 'http://x' } }] }, 'someone-else'
    );

    const response = await handlePullSequence({ id: issue.id }, { knownTools: () => ['navigate'] });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('someone-else');
    expect(text(response)).toContain('stop here');
    expect((await getIssue(issue.id))!.sequenceFile).toBe('');
    await expect(
      fsp.readdir(getIssueSequencesDir()).catch(() => [])
    ).resolves.toEqual([]);  // nothing on disk
  });

  it('accepts a foreign sequence once a person has confirmed', async () => {
    const issue = await issueWithRemoteSequence(
      { commands: [{ tool: 'navigate', params: { url: 'http://x' } }] }, 'someone-else'
    );

    const response = await handlePullSequence(
      { id: issue.id, confirm: true }, { knownTools: () => ['navigate'] }
    );

    expect(response.isError).toBeUndefined();
    expect((await getIssue(issue.id))!.sequenceFile).toBe('bug-001-repro-me.json');
  });

  it('gates a comment sequence on the comment author, not the issue author', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Repro me' });
    await updateIssueFields(issue.id, { github: 97, githubRepo: 'InDate/devharness' });
    responses.set('issue view', JSON.stringify({
      number: 97, title: 'Repro me', state: 'OPEN', stateReason: null, labels: [],
      author: { login: 'InDate' }, body: 'Prose only',
      updatedAt: '2026-08-10T00:00:00.000Z', url: 'u',
      comments: [{
        id: 'IC_1', author: { login: 'driveby' }, createdAt: '2026-08-10T00:00:00.000Z',
        body: emitSequenceBlock({ commands: [{ tool: 'navigate', params: { url: 'http://x' } }] }),
      }],
    }));

    const response = await handlePullSequence(
      { id: issue.id, fromComment: 1 }, { knownTools: () => ['navigate'] }
    );

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('driveby');
  });

  it('refuses a sequence with privileged steps unless allowed', async () => {
    const issue = await issueWithRemoteSequence({
      commands: [{ tool: 'navigate' }, { tool: 'execution', params: { expression: 'fetch("/steal")' } }],
    });

    const blocked = await handlePullSequence({ id: issue.id }, { knownTools: () => ['navigate', 'execution'] });

    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain('execution');
    await expect(fsp.readdir(getIssueSequencesDir())).resolves.toEqual([]);

    const allowed = await handlePullSequence(
      { id: issue.id, allowPrivilegedSteps: true }, { knownTools: () => ['navigate', 'execution'] }
    );
    expect(allowed.isError).toBeUndefined();
  });

  it('rejects unknown tool names before anything is written', async () => {
    const issue = await issueWithRemoteSequence({ commands: [{ tool: 'navigat' }] });

    const response = await handlePullSequence({ id: issue.id }, { knownTools: () => ['navigate'] });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('navigat');
    await expect(fsp.readdir(getIssueSequencesDir())).resolves.toEqual([]);
  });

  it('rejects a structurally invalid sequence', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Repro me' });
    await updateIssueFields(issue.id, { github: 97 });
    responses.set('issue view', JSON.stringify({
      number: 97, title: 'x', state: 'OPEN', stateReason: null, labels: [],
      updatedAt: '2026-08-10T00:00:00.000Z', url: 'u', comments: [],
      body: '```json devharness-sequence\n{"commands":[{"tool":42}]}\n```',
    }));

    const response = await handlePullSequence({ id: issue.id });

    expect(response.isError).toBe(true);
    await expect(fsp.readdir(getIssueSequencesDir())).resolves.toEqual([]);
  });

  it('points at the comments that carry one when the body has none', async () => {
    const issue = await addIssue({ type: 'bug', title: 'x' });
    await updateIssueFields(issue.id, { github: 97 });
    responses.set('issue view', JSON.stringify({
      number: 97, title: 'x', body: 'No block here', state: 'OPEN', stateReason: null, labels: [],
      updatedAt: '2026-08-10T00:00:00.000Z', url: 'u',
      comments: [
        { id: 'IC_1', body: 'no', createdAt: '' },
        { id: 'IC_2', body: emitSequenceBlock({ commands: [{ tool: 'navigate' }] }), createdAt: '' },
      ],
    }));

    const response = await handlePullSequence({ id: issue.id });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain('2');
  });

  it('reads a comment sequence only when asked for it', async () => {
    const issue = await addIssue({ type: 'bug', title: 'x' });
    await updateIssueFields(issue.id, { github: 97 });
    responses.set('issue view', JSON.stringify({
      number: 97, title: 'x', state: 'OPEN', stateReason: null, labels: [],
      updatedAt: '2026-08-10T00:00:00.000Z', url: 'u',
      author: { login: 'InDate' },
      body: emitSequenceBlock({ name: 'body-one', commands: [{ tool: 'navigate' }] }),
      comments: [{ id: 'IC_1', author: { login: 'InDate' }, body: emitSequenceBlock({ name: 'comment-one', commands: [{ tool: 'input' }] }), createdAt: '' }],
    }));

    await handlePullSequence({ id: issue.id, fromComment: 1 }, { knownTools: () => ['navigate', 'input'] });

    const reloaded = await getIssue(issue.id);
    const written = JSON.parse(await fsp.readFile(join(getIssueSequencesDir(), reloaded!.sequenceFile), 'utf-8'));
    expect(written.commands[0].tool).toBe('input');
  });
});
