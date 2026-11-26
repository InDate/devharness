import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { debugLog } from './debug-logger.js';

const execFileAsync = promisify(execFile);

/**
 * On macOS, Chrome copies its app bundle into
 * `<DARWIN_USER_TEMP_DIR>/../X/com.google.Chrome.code_sign_clone/code_sign_clone.<random>`
 * at every launch and removes the copy only on a normal quit. A Chrome that
 * exits by SIGKILL or a crash leaves the copy behind, and each one holds up to
 * 1.5 GB of blocks once Chrome.app has updated past the version it was copied
 * from. This layout belongs to Chrome's current macOS build; a Chrome that
 * moves or renames the directory turns this sweep into a no-op.
 */
export const CHROME_CLONE_PARENT = 'com.google.Chrome.code_sign_clone';
const CLONE_PREFIX = 'code_sign_clone.';

/**
 * A copy younger than this is skipped: a Chrome still starting up holds no
 * file inside its copy yet, so the lsof check alone would not protect it.
 */
export const CLONE_MIN_AGE_MS = 2 * 60 * 1000;

export async function defaultChromeCloneRoot(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync('getconf', ['DARWIN_USER_TEMP_DIR']);
    const tempDir = stdout.trim();
    if (!tempDir) return undefined;
    return path.join(path.dirname(path.resolve(tempDir)), 'X', CHROME_CLONE_PARENT);
  } catch {
    return undefined;
  }
}

/**
 * Names of the copies a live Chrome process holds a file in, or undefined when
 * lsof fails. An undefined result removes nothing, because a missing reading
 * cannot separate a held copy from an orphaned one.
 */
async function heldCloneNames(): Promise<Set<string> | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('lsof', ['-w', '-c', 'Google Chrome', '-Fn'], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const partial = (error as { stdout?: string }).stdout;
    if (!partial) return undefined;
    stdout = partial;
  }
  const held = new Set<string>();
  const marker = `/${CHROME_CLONE_PARENT}/${CLONE_PREFIX}`;
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const rest = line.slice(at + marker.length - CLONE_PREFIX.length);
    held.add(rest.split('/')[0]);
  }
  return held;
}

/** Removes the Chrome app copies no live Chrome holds. Returns the removed paths. */
export async function sweepChromeCodeSignClones(
  options: { cloneRoot?: string; minAgeMs?: number } = {}
): Promise<string[]> {
  const removed: string[] = [];
  const root = options.cloneRoot ?? (await defaultChromeCloneRoot());
  if (!root) return removed;
  const minAgeMs = options.minAgeMs ?? CLONE_MIN_AGE_MS;

  let names: string[];
  try {
    names = (await fs.promises.readdir(root)).filter(n => n.startsWith(CLONE_PREFIX));
  } catch {
    return removed;
  }
  if (names.length === 0) return removed;

  const held = await heldCloneNames();
  if (!held) {
    await debugLog('ChromeClones', 'lsof returned no reading; no Chrome app copy removed');
    return removed;
  }

  const now = Date.now();
  for (const name of names) {
    if (held.has(name)) continue;
    const dir = path.join(root, name);
    try {
      const stats = await fs.promises.stat(dir);
      if (now - stats.mtimeMs < minAgeMs) continue;
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (error) {
      await debugLog('ChromeClones', `Failed to remove ${dir}: ${error}`);
    }
  }
  if (removed.length) {
    await debugLog('ChromeClones', `Removed ${removed.length} orphaned Chrome app copy(ies)`);
  }
  return removed;
}
