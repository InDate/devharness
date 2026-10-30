#!/usr/bin/env node

/**
 * Writes build/build-info.json: the commit this build was compiled from, and
 * whether the working tree held uncommitted changes when it was.
 *
 * A recording is stamped with it, so a field a recording lacks can be read
 * against the code that captured it. The package version alone names a release
 * and not the builds between two releases, and a build from uncommitted code
 * captures what no commit holds.
 *
 * Read at build time rather than at runtime: at runtime the working directory
 * is the app under test, and an installed package has no repository at all.
 * Outside a repository it writes nothing, and the stamp carries the version alone.
 */
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  const commit = git('rev-parse', '--short=8', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no', '--', 'src') !== '';
  writeFileSync(join(root, 'build', 'build-info.json'), JSON.stringify({ commit, ...(dirty ? { dirty: true } : {}) }) + '\n');
} catch {
  // No repository, or no git: the stamp carries the version alone.
}
