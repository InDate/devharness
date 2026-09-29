import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CommandRecorder } from '../command-recorder.js';
import { setWorkingDirOverride } from '../helpers/paths.js';

/**
 * A sequence saved back to disk must land in the folder it came from.
 *
 * addCheck persists through saveSequenceToDisk. If that always wrote to
 * the sequences root, editing spine/spine-04.json would leave the foldered
 * original stale and drop a second copy at the top level — which runAll then
 * runs twice and a basename load matches ambiguously.
 */
describe('saveSequenceToDisk folder handling', () => {
  let dir: string;
  let seqDir: string;
  let recorder: CommandRecorder;

  const write = (rel: string, seq: object) =>
    fs.mkdir(join(seqDir, rel, '..'), { recursive: true })
      .then(() => fs.writeFile(join(seqDir, rel), JSON.stringify(seq)));

  const sequence = (id: string, name: string) => ({
    id, name, description: 'x', commands: [{ tool: 'navigate', params: { action: 'goto', url: 'http://x/' } }],
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'cdp-folder-save-'));
    seqDir = join(dir, '.devharness', 'sequences');
    await fs.mkdir(seqDir, { recursive: true });
    setWorkingDirOverride(dir);
    recorder = new CommandRecorder();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rewrites a foldered sequence in place, and creates nothing at the root', async () => {
    await write('spine/spine-04-owner-shares-list.json', sequence('seq-04', 'spine-04-owner-shares-list'));
    const loaded = await recorder.loadSequenceFromDisk('spine/spine-04-owner-shares-list.json');
    expect(loaded).not.toBeNull();

    const result = await recorder.saveSequenceToDisk(loaded!.id, false, true);
    expect(result?.success).toBe(true);

    // Still in its folder...
    await expect(fs.access(join(seqDir, 'spine', 'spine-04-owner-shares-list.json'))).resolves.toBeUndefined();
    // ...and NOT forked to the root.
    await expect(fs.access(join(seqDir, 'spine-04-owner-shares-list.json'))).rejects.toThrow();

    const roots = (await fs.readdir(seqDir, { withFileTypes: true })).filter(e => e.isFile());
    expect(roots).toHaveLength(0);
  });

  it('still saves a top-level sequence at the root', async () => {
    await write('flat-one.json', sequence('seq-flat', 'flat-one'));
    const loaded = await recorder.loadSequenceFromDisk('flat-one.json');
    expect(loaded).not.toBeNull();

    const result = await recorder.saveSequenceToDisk(loaded!.id, false, true);
    expect(result?.success).toBe(true);
    await expect(fs.access(join(seqDir, 'flat-one.json'))).resolves.toBeUndefined();
  });

  it('finds a foldered sequence when loaded by bare basename', async () => {
    // Callers name sequences by file, not by path; moving one into a folder
    // must not break them.
    await write('_helpers/unlock-as-owner.json', sequence('seq-unlock', 'unlock-as-owner'));
    const loaded = await recorder.loadSequenceFromDisk('unlock-as-owner.json');
    expect(loaded?.name).toBe('unlock-as-owner');
  });
});
