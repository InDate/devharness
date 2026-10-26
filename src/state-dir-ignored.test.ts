/**
 * Where the project's `.devharness/` stands with git, read with real git in a
 * fresh repository per case, and the note a session's first reply carries
 * when the directory would reach a commit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { stateDirStanding, stateDirNote, resetStateDirStanding } from './state-dir-ignored.js';

function project(opts: { repo: boolean; ignore?: string; track?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'devharness-state-'));
  mkdirSync(join(dir, '.devharness'));
  writeFileSync(join(dir, '.devharness', 'config.json'), '{}');
  if (!opts.repo) return dir;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (opts.ignore) writeFileSync(join(dir, '.gitignore'), `${opts.ignore}\n`);
  if (opts.track) execFileSync('git', ['add', '-f', '.devharness/config.json'], { cwd: dir });
  return dir;
}

describe('where .devharness/ stands with git', () => {
  it('outside a repository, nothing to say', async () => {
    expect(await stateDirStanding(project({ repo: false }))).toBe('no-repo');
  });

  it('ignored by a pattern on its contents, which check-ignore on the directory itself misses', async () => {
    expect(await stateDirStanding(project({ repo: true, ignore: '.devharness/*' }))).toBe('ignored');
  });

  it('ignored as a directory', async () => {
    expect(await stateDirStanding(project({ repo: true, ignore: '.devharness/' }))).toBe('ignored');
  });

  it('not ignored', async () => {
    expect(await stateDirStanding(project({ repo: true }))).toBe('unignored');
  });

  it('tracked, ignore pattern or not', async () => {
    expect(await stateDirStanding(project({ repo: true, ignore: '.devharness/', track: true }))).toBe('tracked');
  });
});

describe('the note on the session\'s first reply', () => {
  beforeEach(() => resetStateDirStanding());

  it('says the directory is not ignored once, and nothing after', async () => {
    const dir = project({ repo: true });
    const first = await stateDirNote(dir);
    const second = await stateDirNote(dir);

    expect(first).toContain('is not git-ignored');
    expect(first).toContain('Ask the person');
    expect(second).toBe('');
  });

  it('says nothing for a project whose directory is ignored, or for global state', async () => {
    expect(await stateDirNote(project({ repo: true, ignore: '.devharness/*' }))).toBe('');
    resetStateDirStanding();
    expect(await stateDirNote(undefined)).toBe('');
  });
});
