/**
 * Whether the project's state directory stays out of git.
 *
 * `.devharness/` holds machine-local state - pids, ports, local paths, logs -
 * that a commit carries into a repository others read. A session that never
 * loads the skill never runs the check the skill describes, so the server
 * runs it once and the first reply of the session says what it found.
 *
 * The check asks about a path inside the directory: a `.devharness/*`
 * pattern ignores everything in it while `git check-ignore .devharness`
 * still reports the directory itself as not ignored.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { withOnce } from './messages.js';

export type StateDirStanding = 'ignored' | 'unignored' | 'tracked' | 'no-repo';

/** Runs git in `cwd`, answering its exit code and output; a git that cannot run answers -1. */
type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

const runGit: Git = (args, cwd) => new Promise(resolve => {
  execFile('git', args, { cwd, timeout: 5000 }, (error, stdout) => {
    const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : -1) : 0;
    resolve({ code, stdout: String(stdout ?? '') });
  });
});

/** Whether `dir` lies in a git work tree, found by its `.git` without running git. */
function inRepo(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
}

/** Where the state directory of the project at `projectDir` stands with git. */
export async function stateDirStanding(projectDir: string, git: Git = runGit): Promise<StateDirStanding> {
  if (!inRepo(projectDir)) return 'no-repo';
  const tracked = await git(['ls-files', '--', '.devharness'], projectDir);
  if (tracked.code === 0 && tracked.stdout.trim()) return 'tracked';
  const ignored = await git(['check-ignore', '-q', '--', '.devharness/config.json'], projectDir);
  if (ignored.code === 0) return 'ignored';
  return ignored.code === 1 ? 'unignored' : 'no-repo';
}

let standing: Promise<StateDirStanding> | undefined;

/**
 * The note the session's first reply carries where the state directory would
 * reach git, read once per process; empty where it is ignored, outside a
 * repository, or once the session has seen it.
 */
export async function stateDirNote(projectDir: string | undefined, git: Git = runGit): Promise<string> {
  if (!projectDir) return '';
  standing ??= stateDirStanding(projectDir, git).catch(() => 'no-repo' as const);
  const found = await standing;
  if (found === 'unignored') return withOnce('', 'DEVHARNESS_DIR_UNIGNORED').trim();
  if (found === 'tracked') return withOnce('', 'DEVHARNESS_DIR_TRACKED').trim();
  return '';
}

/** Forget the reading, so the next note reads the repository again. */
export function resetStateDirStanding(): void {
  standing = undefined;
}
