import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import {
  __resetForTests,
  addIssue,
  getIssue,
  getIssues,
  addIssueComment,
  getIssueItemsDir,
  updateIssueFields,
  findIssueByGithub,
  isCompletedStatus,
} from './issue-tracker.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-issue-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('issue-tracker', () => {
  it('round-trips title/body/labels through frontmatter, including special characters', async () => {
    const created = await addIssue({
      type: 'bug',
      title: 'Bug: submit fails "hard" & breaks',
      body: '## Steps\n1. Click submit\n2. Watch it fail',
      labels: ['ui', 'checkout'],
    });

    // Drop the in-memory index and re-read straight from disk to actually
    // exercise the serialize -> file -> parse round trip.
    __resetForTests();

    const reloaded = await getIssue(created.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.title).toBe('Bug: submit fails "hard" & breaks');
    expect(reloaded!.body).toBe('## Steps\n1. Click submit\n2. Watch it fail');
    expect(reloaded!.labels).toEqual(['ui', 'checkout']);
    expect(reloaded!.type).toBe('bug');
    expect(reloaded!.status).toBe('pending');
  });

  it('round-trips multiple comments, preserving order and markdown content', async () => {
    const issue = await addIssue({ type: 'feature', title: 'Add dark mode' });
    await addIssueComment(issue.id, 'First: tried on Chrome, works.');
    await addIssueComment(issue.id, '```js\nconsole.log("ok")\n```\nFixed in commit abc123.');

    __resetForTests();

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.comments).toHaveLength(2);
    expect(reloaded!.comments[0].text).toBe('First: tried on Chrome, works.');
    expect(reloaded!.comments[1].text).toBe('```js\nconsole.log("ok")\n```\nFixed in commit abc123.');
    expect(reloaded!.comments[0].timestamp.getTime()).toBeLessThanOrEqual(
      reloaded!.comments[1].timestamp.getTime()
    );
  });

  it('migrates a legacy issues.csv into one .md file per row and renames it to .bak', async () => {
    const issuesDir = join(tempDir, '.devharness', 'issues');
    await fsp.mkdir(issuesDir, { recursive: true });

    const csvHeader = 'id,type,status,description,sequence_file,start_url,reported_at,acknowledged_at,started_at,resolved_at,recording_name';
    const csvRow = '1,bug,pending,"Login button, does ""nothing""",,http://localhost:3000,2026-01-01T00:00:00.000Z,,,,manual';
    await fsp.writeFile(join(issuesDir, 'issues.csv'), `${csvHeader}\n${csvRow}\n`, 'utf-8');

    const issues = await getIssues({ includeCompleted: true });

    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Login button, does "nothing"');
    expect(issues[0].body).toBe('');
    expect(issues[0].type).toBe('bug');
    expect(issues[0].status).toBe('pending');

    const items = await fsp.readdir(join(issuesDir, 'items'));
    expect(items.filter(f => f.endsWith('.md'))).toHaveLength(1);

    await expect(fsp.access(join(issuesDir, 'issues.csv.bak'))).resolves.toBeUndefined();
    await expect(fsp.access(join(issuesDir, 'issues.csv'))).rejects.toThrow();
  });

  it('keeps the github stamp and unknown keys across a rewrite (bug 020)', async () => {
    // A file as it exists on disk today: hand-added `github:` on line 2, plus
    // a key no version of the serializer knows about.
    await getIssues();
    const itemsDir = getIssueItemsDir();
    await fsp.mkdir(itemsDir, { recursive: true });
    const file = join(itemsDir, 'bug-042-stamped.md');
    await fsp.writeFile(file, [
      '---',
      'github: 93',
      'id: 42',
      'type: bug',
      'status: acknowledged',
      'title: "Stamped issue"',
      'reportedAt: 2026-01-01T00:00:00.000Z',
      'somethingNewerWrote: "keep me"',
      '---',
      '',
      'Body.',
      '',
    ].join('\n'), 'utf-8');
    // Re-read from disk rather than waiting on fs.watch, which the OS does
    // not guarantee to fire; watcher pickup has its own test below.
    __resetForTests();

    // A comment rewrites the whole file - the path that used to drop the stamp.
    await addIssueComment(42, 'A comment.');
    __resetForTests();

    const reloaded = await getIssue(42);
    expect(reloaded!.github).toBe(93);
    expect(reloaded!.extraFrontmatter).toEqual({ somethingNewerWrote: '"keep me"' });
    expect(reloaded!.comments).toHaveLength(1);

    const raw = await fsp.readFile(file, 'utf-8');
    expect(raw.split('\n')[1]).toBe('github: 93');
    expect(raw).toContain('somethingNewerWrote: "keep me"');
  });

  it('round-trips the sync fields and rejects an unknown closedReason', async () => {
    const created = await addIssue({ type: 'bug', title: 'Closed upstream' });
    await updateIssueFields(created.id, {
      status: 'fixed',
      github: 108,
      githubRepo: 'InDate/devharness',
      closedReason: 'not_planned',
      githubSyncedAt: new Date('2026-08-11T04:12:07.918Z'),
      githubBodyHash: 'abc123',
    });
    __resetForTests();

    const reloaded = await getIssue(created.id);
    expect(reloaded!.github).toBe(108);
    expect(reloaded!.githubRepo).toBe('InDate/devharness');
    expect(reloaded!.closedReason).toBe('not_planned');
    expect(reloaded!.githubSyncedAt?.toISOString()).toBe('2026-08-11T04:12:07.918Z');
    expect(reloaded!.githubBodyHash).toBe('abc123');
    // Closed by a reason with no local status of its own, so it still filters out.
    expect(await getIssues()).toHaveLength(0);
    expect(isCompletedStatus(reloaded!.status)).toBe(true);

    // A token we don't recognise gates network writes, so it must not survive.
    await fsp.writeFile(
      reloaded!.filePath,
      (await fsp.readFile(reloaded!.filePath, 'utf-8')).replace('closedReason: not_planned', 'closedReason: wontfix'),
      'utf-8'
    );
    __resetForTests();
    expect((await getIssue(created.id))!.closedReason).toBeUndefined();
  });

  it('leaves an unstamped file free of github keys', async () => {
    const created = await addIssue({ type: 'feature', title: 'Never published' });
    await addIssueComment(created.id, 'Local only.');

    const raw = await fsp.readFile(created.filePath, 'utf-8');
    expect(raw).not.toContain('github');
    expect(raw).not.toContain('closedReason');
  });

  it('finds an issue by its upstream number', async () => {
    const created = await addIssue({ type: 'bug', title: 'Linked' });
    await updateIssueFields(created.id, { github: 97, githubRepo: 'InDate/devharness' });

    expect((await findIssueByGithub(97))!.id).toBe(created.id);
    expect((await findIssueByGithub(97, 'InDate/devharness'))!.id).toBe(created.id);
    expect(await findIssueByGithub(97, 'someone/else')).toBeUndefined();
    expect(await findIssueByGithub(999)).toBeUndefined();
  });

  it('picks up an externally-written issue file after the debounce window', async () => {
    // Prime the index/watcher with an initial (empty) load.
    await getIssues();

    const itemsDir = getIssueItemsDir();
    await fsp.mkdir(itemsDir, { recursive: true });
    const externalFile = [
      '---',
      'id: 42',
      'type: feature',
      'status: pending',
      'title: "Externally added issue"',
      'reportedAt: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      'Added directly to disk, not through addIssue().',
      '',
    ].join('\n');
    await fsp.writeFile(join(itemsDir, 'feature-042-externally-added-issue.md'), externalFile, 'utf-8');

    await vi.waitFor(async () => {
      const issues = await getIssues();
      expect(issues.some(i => i.id === 42 && i.title === 'Externally added issue')).toBe(true);
    }, { timeout: 5000 });
  });
});
