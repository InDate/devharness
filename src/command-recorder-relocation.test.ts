/**
 * `config({ action: 'useLocal', path: X })` rebinds CommandRecorder's
 * sequence-file watcher to X's sequences dir in-process, through the
 * root-bound resource command-recorder.ts registers. Relocation is driven
 * through `relocateRoot` alone, so a missing registration fails here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkingDirOverride, resolveStateDir, relocateRoot } from './helpers/paths.js';
import { CommandRecorder } from './command-recorder.js';

let rootA: string;
let rootB: string;
let recorder: CommandRecorder;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-cr-reloc-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-cr-reloc-b-'));
});

afterEach(() => {
  recorder?.stopSequenceWatch();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe('relocateRoot: command-recorder sequence watcher (scenario d)', () => {
  it('serves X\'s sequences dir after relocateRoot(X), not the root it started on', async () => {
    setWorkingDirOverride(rootA);
    recorder = new CommandRecorder();
    recorder.startSequenceWatch();

    await relocateRoot(rootB);

    const expectedSequencesDirB = join(resolveStateDir(rootB), 'sequences');
    const expectedSequencesDirA = join(resolveStateDir(rootA), 'sequences');

    expect(recorder.getWatchedDirs().some(d => d === expectedSequencesDirB)).toBe(true);
    expect(recorder.getWatchedDirs().some(d => d === expectedSequencesDirA)).toBe(false);
  });
});
