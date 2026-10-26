#!/usr/bin/env node
/**
 * Sync the version `plugin/.mcp.json` installs to the one package.json now
 * carries.
 *
 * Runs from the npm `version` lifecycle, which fires AFTER package.json is
 * bumped and BEFORE the version commit is made - so staging the file here
 * folds it into that same commit.
 *
 * Left to a human the pin gets forgotten, and the failure is late and loud -
 * the tag is already public, publish.yml fails its verify step, and
 * notify-marketplace has meanwhile opened a PR pinning a version npm never got.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

const pinPath = join(repoRoot, 'plugin', '.mcp.json');

if (!existsSync(pinPath)) {
  console.error(`[sync-plugin-pin] No plugin manifest at ${pinPath} - update this script if it moved.`);
  process.exit(1);
}

const pinSource = readFileSync(pinPath, 'utf-8');
const pinned = /"devharness@([^"]+)"/.exec(pinSource);

if (!pinned) {
  console.error(`[sync-plugin-pin] No "devharness@<version>" arg in ${pinPath} - cannot bump the pin.`);
  process.exit(1);
}

if (pinned[1] === version) {
  console.log(`[sync-plugin-pin] plugin/.mcp.json already pins ${version}`);
} else {
  writeFileSync(pinPath, pinSource.replace(/"devharness@[^"]+"/, `"devharness@${version}"`));
  console.log(`[sync-plugin-pin] plugin/.mcp.json pinned ${pinned[1]} -> ${version}`);
}

execFileSync('git', ['add', pinPath], { cwd: repoRoot });
