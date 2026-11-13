/**
 * The parts of this Claude Code session - the main session and each subagent -
 * with when each one's prompt cache runs out, and which of them made the MCP
 * call now arriving.
 *
 * The main session and its subagents run in one Claude process and share this
 * server and its one MCP connection, so a call carries no agent id and no pid
 * of its own, and the tool_use block naming it reaches the transcript only
 * after the call returns. What is on disk when the call arrives is the
 * `api-request` record of the request whose reply holds the call, written to
 * the caller's transcript as the request goes out: `<session>.jsonl` for the
 * main session, `<session>/subagents/agent-<id>.jsonl` for a subagent. A
 * transcript ending in an `api-request` with no reply after it is a part
 * whose request is in flight, which the caller is.
 *
 * The cache ages from that request's start, and lasts as long as the newest
 * write's kind: 5 minutes for a subagent, 1 hour for a main session on the
 * long TTL. Ported from chsum's `_cache_basis` (`chsum/prompt_cache.py`) and
 * read off the same transcript records, so a change to their shape in Claude
 * Code breaks both.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getClaudeSessionId, readCurrentSessionId } from './session-identity.js';

const LIFETIME_MS: Record<string, number> = {
  ephemeral_1h_input_tokens: 3_600_000,
  ephemeral_5m_input_tokens: 300_000,
};

/** A part with no write yet runs on the shorter lifetime, the one a subagent gets. */
const DEFAULT_LIFETIME_MS = 300_000;

/** The last request and the newest write sit in the tail of a live transcript. */
const TAIL_BYTES = 1024 * 1024;

export interface SessionPart {
  kind: 'session' | 'agent';
  /** The session id, or the agent id from `agent-<id>.jsonl`. */
  id: string;
  agentType?: string;
  /** `main session d07156ff` or `agent a1e51387 (general-purpose)`. */
  label: string;
  /** When the request now in flight went out; absent where none is. */
  pendingSince?: number;
  expiresAt: number;
  lifetimeMs: number;
}

interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: { id?: string; model?: string; usage?: { cache_creation?: Record<string, number> } };
}

let projectDirCache: { sessionId: string; dir: string } | undefined;

/** The ~/.claude/projects/<slug> directory holding `<sessionId>.jsonl`. */
export function projectDirOf(sessionId: string, projectsRoot: string = join(homedir(), '.claude', 'projects')): string | undefined {
  if (projectDirCache?.sessionId === sessionId) return projectDirCache.dir;
  let slugs: string[];
  try { slugs = readdirSync(projectsRoot); } catch { return undefined; }
  for (const slug of slugs) {
    const dir = join(projectsRoot, slug);
    try {
      statSync(join(dir, `${sessionId}.jsonl`));
      projectDirCache = { sessionId, dir };
      return dir;
    } catch { /* not this project */ }
  }
  return undefined;
}

function readTailRecords(path: string): TranscriptRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf-8').split('\n');
    if (length < size) lines.shift();
    const records: TranscriptRecord[] = [];
    for (const line of lines) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* a line still being written */ }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isReply(record: TranscriptRecord): boolean {
  return record.type === 'assistant'
    && typeof record.message?.usage === 'object'
    && record.message?.model !== '<synthetic>';
}

function stamp(record: TranscriptRecord | undefined): number | undefined {
  const at = Date.parse(record?.timestamp ?? '');
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The cache state of one transcript. Its lifetime is the kind of the newest
 * write, since later requests only read; a request writing both kinds holds
 * the shorter. With a request in flight the clock runs from that request's
 * `api-request` record. Otherwise it runs from the last reply's request,
 * bounded below by the record its first block hangs off.
 */
export function cacheStateOf(records: TranscriptRecord[]): { pendingSince?: number; expiresAt: number; lifetimeMs: number } | undefined {
  let lifetimeMs: number | undefined;
  for (let i = records.length - 1; i >= 0 && lifetimeMs === undefined; i--) {
    if (!isReply(records[i])) continue;
    const split = records[i].message?.usage?.cache_creation ?? {};
    const written = Object.keys(LIFETIME_MS).filter(kind => split[kind]).map(kind => LIFETIME_MS[kind]);
    if (written.length) lifetimeMs = Math.min(...written);
  }
  lifetimeMs ??= DEFAULT_LIFETIME_MS;

  let lastRequest = -1;
  let lastReply = -1;
  records.forEach((record, i) => {
    if (record.type === 'api-request') lastRequest = i;
    if (isReply(record)) lastReply = i;
  });
  if (lastRequest > lastReply) {
    const pendingSince = stamp(records[lastRequest]);
    if (pendingSince !== undefined) return { pendingSince, expiresAt: pendingSince + lifetimeMs, lifetimeMs };
  }
  if (lastReply < 0) return undefined;
  const last = records[lastReply];
  const id = last.message?.id;
  const first = (id && records.find(r => r.type === 'assistant' && r.message?.id === id)) || last;
  const parent = first.parentUuid ? records.find(r => r.uuid === first.parentUuid) : undefined;
  const start = stamp(parent) ?? stamp(first) ?? stamp(last);
  return start === undefined ? undefined : { expiresAt: start + lifetimeMs, lifetimeMs };
}

/** The main session and each subagent not yet finished. */
export function sessionParts(options: { sessionId?: string; projectsRoot?: string } = {}): SessionPart[] {
  const sessionId = options.sessionId ?? readCurrentSessionId() ?? getClaudeSessionId();
  if (!sessionId) return [];
  const projectDir = projectDirOf(sessionId, options.projectsRoot);
  if (!projectDir) return [];
  const parts: SessionPart[] = [];
  const main = cacheStateOf(readTailRecords(join(projectDir, `${sessionId}.jsonl`)));
  if (main) parts.push({ kind: 'session', id: sessionId, label: `main session ${sessionId.slice(0, 8)}`, ...main });
  const subagents = join(projectDir, sessionId, 'subagents');
  let names: string[] = [];
  try { names = readdirSync(subagents); } catch { /* no subagents */ }
  for (const name of names) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (!match) continue;
    let meta: { finished?: boolean; agentType?: string } = {};
    try { meta = JSON.parse(readFileSync(join(subagents, `agent-${match[1]}.meta.json`), 'utf-8')); } catch { /* no meta */ }
    if (meta.finished === true) continue;
    const state = cacheStateOf(readTailRecords(join(subagents, name)));
    if (!state) continue;
    const agentType = typeof meta.agentType === 'string' ? meta.agentType : undefined;
    parts.push({
      kind: 'agent', id: match[1], ...(agentType ? { agentType } : {}),
      label: `agent ${match[1].slice(0, 8)}${agentType ? ` (${agentType})` : ''}`,
      ...state,
    });
  }
  return parts;
}

/** How often a call in progress reads the transcripts again to narrow its callers. */
const REFRESH_MS = 5_000;

function requestKey(part: SessionPart): string {
  return `${part.id}@${part.pendingSince}`;
}

/**
 * The parts that may have made one call this server is serving. A part with
 * a request in flight when the call arrived stays a candidate while that
 * request is still in flight: an MCP caller's reply lands in its transcript
 * only after its call returns, so a candidate whose reply lands, or whose
 * transcript shows a newer request, made some other request. A candidate that
 * a later call narrowed to alone is that call's caller and leaves this one.
 */
export class CallerClaim {
  private listeners = new Set<() => void>();
  private released = false;

  constructor(public callers: SessionPart[]) {}

  /** Run `listener` each time the candidates narrow. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  narrow(parts: SessionPart[], takenByOthers: Set<string>): void {
    const inFlight = new Set(parts.filter(p => p.pendingSince !== undefined).map(requestKey));
    let next = this.callers.filter(c => inFlight.has(requestKey(c)));
    if (next.length > 1) {
      const untaken = next.filter(c => !takenByOthers.has(requestKey(c)));
      if (untaken.length) next = untaken;
    }
    if (next.length === 0 || next.length === this.callers.length) return;
    this.callers = next;
    for (const listener of this.listeners) listener();
  }

  /** The request this call is pinned to, where it has narrowed to one. */
  pinned(): string | undefined {
    return this.callers.length === 1 ? requestKey(this.callers[0]) : undefined;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.listeners.clear();
    inProgress.delete(this);
    if (inProgress.size === 0 && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }
}

const inProgress = new Set<CallerClaim>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshOptions: { sessionId?: string; projectsRoot?: string } = {};

/** Narrow every call in progress against `parts`, until none narrows further. */
function narrowAll(parts: SessionPart[]): void {
  for (let pass = 0; pass < inProgress.size + 1; pass++) {
    const before = [...inProgress].map(c => c.callers.length).join();
    for (const claim of inProgress) {
      const taken = new Set([...inProgress].filter(o => o !== claim).map(o => o.pinned()).filter((k): k is string => !!k));
      claim.narrow(parts, taken);
    }
    if ([...inProgress].map(c => c.callers.length).join() === before) return;
  }
}

/**
 * The claim of the call now arriving: the parts with a request in flight,
 * less those a call in progress is pinned to. Where every part in flight is
 * pinned, the call is a second one from a reply that made several, and the
 * pinned parts stand. None for a call from outside Claude Code. The claim
 * narrows as the call runs; `release` it when the call returns.
 */
export function claimCallers(options: { sessionId?: string; projectsRoot?: string } = {}): CallerClaim {
  const parts = sessionParts(options);
  narrowAll(parts);
  const pending = parts.filter(part => part.pendingSince !== undefined);
  const taken = new Set([...inProgress].map(c => c.pinned()).filter((k): k is string => !!k));
  const free = pending.filter(part => !taken.has(requestKey(part)));
  const claim = new CallerClaim(free.length ? free : pending);
  inProgress.add(claim);
  narrowAll(parts);
  refreshOptions = options;
  refreshTimer ??= setInterval(() => narrowAll(sessionParts(refreshOptions)), REFRESH_MS);
  refreshTimer.unref?.();
  return claim;
}

/** One line naming the caller, as status shows it. */
export function describeCallers(callers: SessionPart[] | undefined): string {
  if (!callers?.length) return 'unattributed (no part of this session has a request in flight)';
  if (callers.length === 1) return callers[0].label;
  return `one of ${callers.map(c => c.label).join(', ')} (their requests overlap)`;
}
