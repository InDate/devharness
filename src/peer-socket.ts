/**
 * Messages written straight into a Claude Code session, through the socket
 * Claude Code itself reads peer messages from.
 *
 * The event stream reaches a session only on its next devharness call or
 * through a watch it armed, so a session working in Bash alone receives
 * nothing from it. Claude Code drains its messaging socket at the session's
 * next tool round, Bash rounds included, so a frame written there reaches
 * that session mid-task at no extra request.
 *
 * Two Claude Code internals carry this, neither a public API:
 * - the registry `~/.claude/sessions/<pid>.json`, one file per running
 *   session, holding `messagingSocketPath`;
 * - the frame: one newline-ended JSON object of type `user`, as chsum's
 *   `sessions.send` writes it (measured on Claude Code 2.1.296, read on
 *   2.1.318 with `peerProtocol: 1`).
 * A change to either stops delivery; `sendPeerMessage` then throws.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { connect } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { collectAncestors, readParentMap } from './cli/process-tree.js';

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  socketPath: string;
}

function registryDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
}

/**
 * Milliseconds since epoch at which `pid` started, from `ps -o etime=`
 * ([[dd-]hh:]mm:ss elapsed). `lstart` prints local time while the registry's
 * `procStart` holds UTC, so elapsed time is the form both sides convert from.
 * Returns undefined where ps fails.
 */
function processStartedAt(pid: number): number | undefined {
  try {
    const etime = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 }).trim();
    const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!match) return undefined;
    const [, d = '0', h = '0', m, s] = match;
    const seconds = ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s);
    return Date.now() - seconds * 1000;
  } catch {
    return undefined;
  }
}

/**
 * The registry entry for the Claude Code process `pid`, where one stands and
 * belongs to the process holding that pid now. A crashed session leaves its
 * file behind, and a later process can reuse the pid: that process started
 * after the entry was written, so a start time later than `startedAt` (past
 * the 2 s ps rounding) returns undefined.
 */
export function registryEntry(pid: number): ClaudeSession | undefined {
  const file = join(registryDir(), `${pid}.json`);
  if (!existsSync(file)) return undefined;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof entry.messagingSocketPath !== 'string' || typeof entry.sessionId !== 'string') return undefined;
  const started = processStartedAt(pid);
  if (started !== undefined && typeof entry.startedAt === 'number' && started > entry.startedAt + 2000) return undefined;
  return {
    pid,
    sessionId: entry.sessionId,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    socketPath: entry.messagingSocketPath,
  };
}

/**
 * The running session whose id opens with `prefix`, the form an event stream
 * is named by (`abd3ac35` for `abd3ac35-6a83-...`). Two matches return
 * undefined: a frame written to the wrong one lands in a conversation it does
 * not belong to.
 */
export function sessionByIdPrefix(prefix: string): ClaudeSession | undefined {
  let files: string[];
  try {
    files = readdirSync(registryDir()).filter(f => /^\d+\.json$/.test(f));
  } catch {
    return undefined;
  }
  const hits: ClaudeSession[] = [];
  for (const file of files) {
    const session = registryEntry(Number(file.slice(0, -5)));
    if (session?.sessionId.startsWith(prefix)) hits.push(session);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** The Claude Code session `pid` runs under: `pid` itself or its nearest ancestor holding a registry entry. */
export function claudeSessionOf(pid: number, parents: Map<number, number> = readParentMap()): ClaudeSession | undefined {
  for (const candidate of [pid, ...collectAncestors(pid, parents)]) {
    const session = registryEntry(candidate);
    if (session) return session;
  }
  return undefined;
}

/**
 * Writes `text` to the session listening on `socketPath` as one peer
 * message. `from` fills the frame's reply address. The connection stays open
 * `holdMs`: Claude Code reads the sender's pid off the open connection, and
 * one closed at once arrives with no verified sender. Rejects where the
 * socket is gone or refuses the connection.
 */
export function sendPeerMessage(
  socketPath: string,
  text: string,
  options: { from?: string; holdMs?: number } = {},
): Promise<void> {
  const frame = {
    type: 'user',
    message: { role: 'user', content: text },
    msg_id: randomUUID(),
    ...(options.from ? { from: options.from } : {}),
  };
  const holdMs = options.holdMs ?? 3000;
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(JSON.stringify(frame) + '\n', (err) => {
        if (err) {
          socket.destroy();
          reject(err);
          return;
        }
        setTimeout(() => {
          socket.end();
          resolve();
        }, holdMs);
      });
    });
  });
}
