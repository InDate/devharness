import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { walkSequenceFiles, isHelperPath, selectSuiteFiles, sequenceFolders } from './sequence-tree.js';

describe('walkSequenceFiles', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'cdp-seq-tree-'));
    await fs.mkdir(join(dir, 'spine'), { recursive: true });
    await fs.mkdir(join(dir, '_helpers'), { recursive: true });
    await fs.mkdir(join(dir, 'story', 'nested'), { recursive: true });
    await fs.writeFile(join(dir, 'top.json'), '{}');
    await fs.writeFile(join(dir, 'spine', 'spine-01.json'), '{}');
    await fs.writeFile(join(dir, '_helpers', 'unlock.json'), '{}');
    await fs.writeFile(join(dir, 'story', 'nested', 'deep.json'), '{}');
    // Non-JSON must be ignored — backup files live beside sequences.
    await fs.writeFile(join(dir, 'spine', 'spine-01.json.pre-migration-backup'), '{}');
    await fs.writeFile(join(dir, 'notes.md'), 'x');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('finds sequences in subfolders, not just the top level', async () => {
    const files = await walkSequenceFiles(dir);
    expect(files).toContain('spine/spine-01.json');
    expect(files).toContain('story/nested/deep.json');
    expect(files).toContain('_helpers/unlock.json');
    expect(files).toContain('top.json');
  });

  it('reports paths relative to the root so they round-trip through load', async () => {
    const files = await walkSequenceFiles(dir);
    expect(files.every(f => !f.startsWith('/'))).toBe(true);
    expect(files.every(f => !f.startsWith(dir))).toBe(true);
  });

  it('ignores files that are not .json', async () => {
    const files = await walkSequenceFiles(dir);
    expect(files).not.toContain('notes.md');
    expect(files.some(f => f.endsWith('.pre-migration-backup'))).toBe(false);
  });

  it('returns sorted output so a suite runs in a predictable order', async () => {
    const files = await walkSequenceFiles(dir);
    expect(files).toEqual([...files].sort());
  });

  it('treats a missing directory as empty rather than an error', async () => {
    await expect(walkSequenceFiles(join(dir, 'does-not-exist'))).resolves.toEqual([]);
  });
});

describe('isHelperPath', () => {
  it('flags any folder segment starting with underscore', () => {
    expect(isHelperPath('_helpers/unlock.json')).toBe(true);
    expect(isHelperPath('spine/_shared/guard.json')).toBe(true);
  });

  it('does not flag a top-level file whose NAME starts with underscore', () => {
    // Only folders mark helpers; a bare file is still runnable.
    expect(isHelperPath('_scratch.json')).toBe(false);
  });

  it('leaves ordinary paths alone', () => {
    expect(isHelperPath('spine/spine-01.json')).toBe(false);
    expect(isHelperPath('top.json')).toBe(false);
  });
});

describe('selectSuiteFiles', () => {
  const all = [
    'top.json',
    '_helpers/unlock.json',
    'spine/spine-02.json',
    'spine/spine-01.json',
    'spine/_local/body.json',
    'story/story-a1.json',
  ];

  it('runs everything except helper folders when no folder is given', () => {
    expect(selectSuiteFiles(all)).toEqual([
      'spine/spine-01.json',
      'spine/spine-02.json',
      'story/story-a1.json',
      'top.json',
    ]);
  });

  it('scopes to one folder when asked', () => {
    expect(selectSuiteFiles(all, 'spine')).toEqual([
      'spine/spine-01.json',
      'spine/spine-02.json',
    ]);
  });

  it('tolerates surrounding slashes on the folder argument', () => {
    expect(selectSuiteFiles(all, '/spine/')).toEqual(selectSuiteFiles(all, 'spine'));
  });

  it('returns nothing for a folder that does not exist', () => {
    expect(selectSuiteFiles(all, 'nope')).toEqual([]);
  });

  it('does not match a folder name by prefix alone', () => {
    // 'spin' must not sweep in 'spine/...'.
    expect(selectSuiteFiles(all, 'spin')).toEqual([]);
  });

  it('runs a helper folder when it is asked for by name', () => {
    // Skipping helpers is a default for the bare case, not a prohibition:
    // naming _helpers explicitly is deliberate, and refusing it while listing
    // it as an available folder is a dead end.
    expect(selectSuiteFiles(all, '_helpers')).toEqual(['_helpers/unlock.json']);
    expect(selectSuiteFiles(all, 'spine/_local')).toEqual(['spine/_local/body.json']);
  });
});

describe('sequenceFolders', () => {
  it('lists distinct folders for an error message', () => {
    expect(sequenceFolders(['a.json', 'spine/x.json', 'spine/y.json', 'story/nested/z.json']))
      .toEqual(['spine', 'story/nested']);
  });

  it('is empty when everything is top level', () => {
    expect(sequenceFolders(['a.json', 'b.json'])).toEqual([]);
  });
});
