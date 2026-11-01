/**
 * `config({ action: 'useLocal', path: X })` moves the issue tracker's storage
 * root in-process. `checkBugBlocking` calls `hasPendingBugs()` before every
 * tool's handler, which loads the index and binds an `fs.watch` to the items
 * dir; the root-bound resource issue-tracker.ts registers drops both on
 * relocation, so the next read scans the new root. Relocation is driven
 * through `relocateRoot` or `ConfigManager.useLocal` alone, so a missing
 * registration or a `useLocal` that does not forward fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride, relocateRoot } from './helpers/paths.js';
import { ConfigManager } from './config.js';
import {
  __resetForTests,
  addIssue,
  getIssues,
  getIssueItemsDir,
  hasPendingBugs,
} from './issue-tracker.js';

let rootA: string;
let rootB: string;

const relocate = relocateRoot;

beforeEach(async () => {
  rootA = await fsp.mkdtemp(join(tmpdir(), 'devharness-it-reloc-a-'));
  rootB = await fsp.mkdtemp(join(tmpdir(), 'devharness-it-reloc-b-'));
  setWorkingDirOverride(rootA);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(rootA, { recursive: true, force: true });
  await fsp.rm(rootB, { recursive: true, force: true });
});

function issueFrontmatter(id: number, type: 'bug' | 'feature', title: string): string {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    'status: pending',
    `title: "${title}"`,
    'reportedAt: 2026-01-01T00:00:00.000Z',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

describe('relocateRoot: issue-tracker index (scenario a)', () => {
  it('reflects X\'s items dir after relocateRoot(X), even though the index was primed from A first (the reported scenario)', async () => {
    // Prime the in-memory index/watcher from root A, exactly like
    // checkBugBlocking's hasPendingBugs() does on every tool call before a
    // handler ever runs (index.ts:1683).
    await hasPendingBugs();

    // Root B already has issues on disk - as if created by another process,
    // or manually moved there, before relocation ever ran.
    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-001-first.md'), issueFrontmatter(1, 'feature', 'First'), 'utf-8');
    await fsp.writeFile(join(itemsDirB, 'feature-002-second.md'), issueFrontmatter(2, 'feature', 'Second'), 'utf-8');

    await relocate(rootB);

    const issues = await getIssues();
    expect(issues.map(i => i.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(issues.map(i => i.title).sort()).toEqual(['First', 'Second']);
  });
});

describe('relocateRoot: issue numbering (scenario b)', () => {
  it('a created issue after relocation numbers after what already exists on disk at X (collision case: feature-001 pre-exists at X)', async () => {
    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-001-existing.md'), issueFrontmatter(1, 'feature', 'Existing'), 'utf-8');

    await relocate(rootB);

    const created = await addIssue({ type: 'feature', title: 'New after relocation' });

    // Must not restart numbering from 1 - that would collide with the
    // feature-001 file already on disk at X.
    expect(created.id).toBe(2);

    const items = await fsp.readdir(itemsDirB);
    expect(items.filter(f => f.startsWith('feature-001-'))).toHaveLength(1);
    expect(items.some(f => f.startsWith('feature-002-'))).toBe(true);
  });
});

describe('relocateRoot: fs.watch rebind (scenario c)', () => {
  it('a file added to X/items after relocation appears in the index', async () => {
    await hasPendingBugs(); // prime from A first, as in the reported scenario

    await relocate(rootB);

    const itemsDirB = getIssueItemsDir();
    expect(itemsDirB.startsWith(rootB)).toBe(true);

    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(
      join(itemsDirB, 'feature-007-external.md'),
      issueFrontmatter(7, 'feature', 'External after relocation'),
      'utf-8'
    );

    // Wait past the watcher's debounce window (250ms, issue-tracker.ts's
    // RELOAD_DEBOUNCE_MS) - same margin issue-tracker.test.ts's own
    // "picks up an externally-written issue file" case uses.
    await new Promise(resolve => setTimeout(resolve, 500));

    const issues = await getIssues();
    expect(issues.some(i => i.id === 7 && i.title === 'External after relocation')).toBe(true);
  });
});

describe('ConfigManager.useLocal forwards to relocateRoot', () => {
  it('serves X\'s issues after useLocal(path=X), with the index primed from A first', async () => {
    // The other tests call relocateRoot directly; this one fails where
    // useLocal sets the working dir without relocating.
    await hasPendingBugs();

    const itemsDirB = join(rootB, '.devharness', 'issues', 'items');
    await fsp.mkdir(itemsDirB, { recursive: true });
    await fsp.writeFile(join(itemsDirB, 'feature-011-useLocal.md'), issueFrontmatter(11, 'feature', 'Via useLocal'), 'utf-8');

    const manager = new ConfigManager();
    await manager.useLocal(false, rootB);

    const issues = await getIssues();
    expect(issues.some(i => i.id === 11 && i.title === 'Via useLocal')).toBe(true);
  });
});
