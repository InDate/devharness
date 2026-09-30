/**
 * Which Claude Code session this process serves.
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID into the environment it spawns
 * the supervisor with, and the child inherits it. That value is present from
 * the first instruction and unchanged when the supervisor replaces the child,
 * so anything naming this session on disk - a mailbox filename, a presence
 * record - keeps the same name across a rebuild.
 *
 * The session detector produces the same id, but only after a tool response
 * carrying a `pid:` footer has been written into the session's .jsonl and
 * matched. A session driven from the CLI writes no such footer, and a child
 * restarted by a rebuild has not written one yet.
 */

import { readFileSync } from 'fs';
import { join, basename } from 'path';
import { getOutputPath } from './helpers/paths.js';

/** Ids become filenames; anything outside this set could escape the directory
 *  holding them. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The full session id from the environment, or undefined when this process
 *  was not spawned by Claude Code. */
export function getClaudeSessionId(): string | undefined {
  const value = process.env.CLAUDE_CODE_SESSION_ID;
  if (!value || !SESSION_ID_PATTERN.test(value)) return undefined;
  return value;
}

/** The first 8 characters of the session id - the form the dashboard and the
 *  session detector both display. */
export function getClaudeShortId(): string | undefined {
  return getClaudeSessionId()?.slice(0, 8);
}

/**
 * The name this session is known by on disk - its mailbox filename, its event
 * stream filename, its presence record.
 *
 * The hook's record comes first: it is the only source that follows the
 * conversation through a `/clear`, which changes the id without restarting this
 * process. The environment is next, correct from the first instruction and for
 * as long as the conversation lasts. The detector covers a client that exports
 * no session id. The pid form is last, and changes on every restart, which is
 * why it is the fallback rather than the default.
 */
export function resolveSessionName(detectedShortId?: string): string {
  return resolveRestartStableSessionName(detectedShortId) ?? `pid-${process.pid}`;
}

/** resolveSessionName without the pid form: undefined where no source names
 *  the session, so a record keyed on it is never written under a name the next
 *  restart replaces. */
export function resolveRestartStableSessionName(detectedShortId?: string): string | undefined {
  return readCurrentSessionId()?.slice(0, 8)
    ?? getClaudeShortId()
    ?? detectedShortId;
}

/**
 * The Claude process this server belongs to.
 *
 * `CLAUDE_CODE_MESSAGING_SOCKET` carries that pid in its filename, and it is
 * present in both the hook's environment and the server's, under `-p` and
 * interactively. `CLAUDE_PID` carries it more directly and is absent from the
 * server under `-p`, so the socket path is the derivation that works on both
 * sides.
 */
export function getClientPid(): number | undefined {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socket) return undefined;
  const pid = Number(basename(socket).replace(/\.sock$/, ''));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Where the plugin's SessionStart hook records the conversation a client is
 *  currently on. */
export function getClientsDir(): string {
  return getOutputPath('clients', { global: true });
}

export function getClientRecordPath(clientPid: number): string {
  return join(getClientsDir(), `${clientPid}.json`);
}

/**
 * The conversation this client is on now, as last written by the hook.
 *
 * `CLAUDE_CODE_SESSION_ID` is read once when the process is spawned, and
 * `/clear` gives the conversation a new id without restarting it. The hook runs
 * on every start reason including `clear`, carrying the current id, so this
 * file is the only source that tracks the change while the process lives.
 */
export function readCurrentSessionId(): string | undefined {
  const clientPid = getClientPid();
  if (clientPid === undefined) return undefined;
  try {
    const record = JSON.parse(readFileSync(getClientRecordPath(clientPid), 'utf-8'));
    const id = record?.sessionId;
    return typeof id === 'string' && SESSION_ID_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
