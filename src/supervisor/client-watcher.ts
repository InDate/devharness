/**
 * Watches the MCP client (Claude Code, the Claude desktop app, an IDE) that
 * this supervisor was launched to serve, and reports when it is gone.
 *
 * WHY THIS EXISTS
 * The supervisor already shuts down on stdin end/close, which is supposed to
 * catch a client that dies without signalling. It does not fire when the
 * client was launched through `npx`: the `npm exec` wrapper sits between the
 * client and this process, survives the client's death (reparented to init),
 * and keeps holding the write end of our stdin pipe. No EOF ever arrives, so
 * the whole tree - supervisor, real server, its Chrome and dev servers - lives
 * on for days holding memory nobody is asking it to hold (issue #138).
 *
 * So instead of waiting to be told, we find out who the client actually is and
 * check whether it is still alive.
 *
 * FINDING THE CLIENT
 * Walk up the process ancestry from this process and take the first ancestor
 * that isn't part of the launch plumbing - Node itself, npm/npx, a shell. For
 * the three shapes seen in the wild that lands on:
 *   node <- npm exec <- claude                          => claude
 *   node <- npm exec <- disclaimer <- Claude.app         => disclaimer (the
 *       Claude app's own helper - it dies with the app, which is what matters)
 *   node <- code helper                                  => the IDE helper
 *
 * If the walk finds nothing but plumbing all the way to pid 1, there is no
 * client to watch and reaping is disabled - better to leak than to kill a tree
 * that is still serving someone.
 *
 * IDENTIFYING THE CLIENT ACROSS DAYS
 * A pid alone does not identify a process for the length of a session. The
 * client exits, the OS recycles its pid onto an unrelated process, and a
 * liveness check on that number reports alive forever. Twelve supervisors were
 * found in exactly that state, the oldest 5 days 16 hours past its session,
 * each consuming CPU linear in its age at about 1.4 ms per 60-second poll -
 * that poll and nothing else.
 *
 * So each poll re-walks the ancestry instead of testing a number. The client's
 * death reparents everything below it onto init, so the walk hits ppid 1 and
 * yields null - a reading that holds however the pid is later reused. A walk
 * that lands on a different pid, or the same pid running a different command,
 * reads as gone for the same reason.
 *
 * `ps` failing is indistinguishable from an exit in a single reading, so the
 * tree comes down on the third consecutive miss. A transient probe failure
 * costs two poll intervals; a real exit costs the same delay.
 */
import { execFileSync } from 'child_process';

export interface ProcessInfo {
  ppid: number;
  command: string;
}

export interface ProcessProbe {
  /** Parent pid + command for a pid, or null if the pid is gone/unreadable. */
  info(pid: number): ProcessInfo | null;
}

export interface ClientIdentity {
  pid: number;
  command: string;
}

/**
 * Package managers and shells that are only ever launch plumbing, never the
 * client itself. Matched against the command's leading token's basename.
 */
const PLUMBING = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bunx',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'env',
  'exec',
  'login',
]);

/** Runtimes that are plumbing or client depending on what they are running. */
const RUNTIMES = new Set(['node', 'node.exe', 'nodejs', 'bun', 'deno']);

/**
 * Scripts that mean a runtime process is npm/npx machinery rather than the
 * client. Anything else a runtime is running is treated as the client itself:
 * an npm-installed MCP host appears in `ps` as `node .../cli.js`, and calling
 * every node process plumbing would walk straight past it to the user's shell
 * and terminal - which live for weeks, so the tree would never be reaped.
 */
const RUNTIME_PLUMBING_SCRIPTS = [
  'npm-cli.js',
  'npx-cli.js',
  'npm-prefix.js',
  '/node_modules/.bin/',
  '/npm/bin/',
  '/_npx/',
  '/corepack/',
];

function isPlumbing(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const basename = (tokens[0] ?? '').split('/').pop() ?? '';

  if (PLUMBING.has(basename)) return true;

  if (RUNTIMES.has(basename)) {
    // A bare runtime with no script (a REPL, or an unreadable command) tells
    // us nothing; treat it as plumbing, as before.
    const script = tokens.slice(1).find((token) => !token.startsWith('-'));
    if (!script) return true;
    return RUNTIME_PLUMBING_SCRIPTS.some((marker) => script.includes(marker));
  }

  return false;
}

/**
 * Parses one `ps -o ppid=,command=` line: leading spaces, the numeric ppid,
 * then the command as the rest of the line.
 *
 * `ps` prints start times in a locale-shaped form - this machine gives
 * `Sat  5 Sep 11:04:52 2026`, where another gives `Sat Sep  5 11:04:52 2026` -
 * so no start-time column is requested. A mis-parsed date would land inside
 * the command string and defeat the plumbing check that finds the client.
 */
const PS_LINE = /^\s*(\d+)\s+(.*)$/;

export function parseProcessLine(line: string): ProcessInfo | null {
  const match = line.match(PS_LINE);
  if (!match) return null;
  return { ppid: Number(match[1]), command: match[2] };
}

/** Reads process info via `ps`. Unavailable on Windows, which has no `ps`. */
export const systemProcessProbe: ProcessProbe = {
  info(pid: number): ProcessInfo | null {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      if (!out) return null;
      return parseProcessLine(out);
    } catch {
      return null;
    }
  },
};

/** Consecutive polls that must miss the client before the tree comes down. */
export const MISSES_BEFORE_SHUTDOWN = 3;

/**
 * True while a fresh walk from `startPid` lands on the same client.
 *
 * The client's exit reparents the tree onto init, so the walk stops at ppid 1
 * and returns null however the pid is reused afterwards. A different pid, or
 * the same pid carrying a different command, is the same reading.
 */
export function clientStillPresent(
  startPid: number,
  client: ClientIdentity,
  probe: ProcessProbe
): boolean {
  const current = resolveClientIdentity(startPid, probe);
  if (!current) return false;
  return current.pid === client.pid && current.command === client.command;
}

/**
 * Walk up from `startPid`'s parent and return the first ancestor that isn't
 * launch plumbing, or null if there is none.
 */
export function resolveClientIdentity(
  startPid: number,
  probe: ProcessProbe,
  maxDepth = 12
): ClientIdentity | null {
  let current = probe.info(startPid);
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!current || current.ppid <= 1) return null;
    const parent = probe.info(current.ppid);
    if (!parent) return null;
    if (!isPlumbing(parent.command)) {
      return { pid: current.ppid, command: parent.command };
    }
    current = parent;
  }
  return null;
}

export interface ClientWatcherOptions {
  /** How often to check the client is still alive (default: 60s). */
  pollIntervalMs?: number;
  probe?: ProcessProbe;
  logStderr?: (message: string) => void;
}

/**
 * Polls the resolved client's liveness and calls back once, when it dies.
 * Does nothing at all when no client could be resolved.
 */
export class ClientWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly probe: ProcessProbe;
  private readonly pollIntervalMs: number;
  private readonly logStderr: (message: string) => void;
  private client: ClientIdentity | null = null;
  /** Consecutive polls that have not found the client. */
  private misses = 0;

  constructor(private readonly options: ClientWatcherOptions = {}) {
    this.probe = options.probe ?? systemProcessProbe;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.logStderr = options.logStderr ?? (() => {});
  }

  getClient(): ClientIdentity | null {
    return this.client;
  }

  /**
   * Resolve the client and start watching. Returns the client it will watch,
   * or null if none could be resolved (in which case nothing is watched).
   */
  start(startPid: number, onClientGone: (client: ClientIdentity) => void): ClientIdentity | null {
    if (process.platform === 'win32') {
      this.logStderr('Client watcher disabled on Windows (no ps); relying on stdin close');
      return null;
    }

    this.client = resolveClientIdentity(startPid, this.probe);
    if (!this.client) {
      this.logStderr('Could not identify the MCP client process; orphan reaping disabled');
      return null;
    }

    const client = this.client;
    this.logStderr(`Watching client PID ${client.pid} (${client.command.slice(0, 80)})`);

    this.timer = setInterval(() => {
      if (clientStillPresent(startPid, client, this.probe)) {
        this.misses = 0;
        return;
      }
      if (++this.misses < MISSES_BEFORE_SHUTDOWN) {
        this.logStderr(
          `Client PID ${client.pid} not found (${this.misses}/${MISSES_BEFORE_SHUTDOWN})`
        );
        return;
      }
      this.stop();
      this.logStderr(`Client PID ${client.pid} is gone; shutting down`);
      onClientGone(client);
    }, this.pollIntervalMs);
    this.timer.unref?.();

    return client;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
