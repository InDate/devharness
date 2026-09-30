/**
 * Post-run verdicts: socket closures, frame errors and missing declared
 * sockets, and console output a strict run fails on, each diffed against
 * the start of the run.
 */
import type { ExecuteToolCall } from '../types.js';

/** Console error/warning counts per connection, for a strict run's before/after. */
export async function snapshotConsole(
  refs: string[],
  executeToolCall: ExecuteToolCall
): Promise<Record<string, { errors: number; warnings: number }>> {
  const out: Record<string, { errors: number; warnings: number }> = {};
  for (const ref of refs) {
    try {
      const res: any = await executeToolCall('console', { action: 'list', limit: 1, connectionReason: ref });
      out[ref] = {
        errors: res?._meta?.console?.errorCount || 0,
        warnings: res?._meta?.console?.warnCount || 0,
      };
    } catch {
      // A connection that cannot be read yet contributes nothing to the diff.
    }
  }
  return out;
}

/**
 * What a strict run should fail on: console output the sequence PRODUCED.
 *
 * Counted per connection and diffed against the start of the run, so noise that
 * was already on the page is not blamed on this sequence. Warnings count only
 * when strict is 'warnings' — a sequence can be functionally correct and still
 * be logging, and those are different questions.
 */
export function strictConsoleFailures(
  before: Record<string, { errors: number; warnings: number }>,
  after: Record<string, { errors: number; warnings: number }>,
  includeWarnings: boolean
): string[] {
  const out: string[] = [];
  for (const ref of Object.keys(after)) {
    const b = before[ref] || { errors: 0, warnings: 0 };
    const errs = after[ref].errors - b.errors;
    const warns = after[ref].warnings - b.warnings;
    if (errs > 0) out.push(`${ref}: ${errs} new console error(s)`);
    if (includeWarnings && warns > 0) out.push(`${ref}: ${warns} new console warning(s)`);
  }
  return out;
}

/** One socket as the health diff sees it. */
interface SocketSnapshot {
  id: string;
  url: string;
  target: string;
  closed: boolean;
  errors: number;
  /** Went away with its target rather than closing on its own. */
  closedWithTarget?: boolean;
  /** The page hung up on purpose, rather than losing the transport. */
  clientClosed?: boolean;
  closedWithDocument?: boolean;
}

/**
 * Every WebSocket per connection, for a run's before/after comparison.
 *
 * A connection that cannot be read is recorded as unreadable rather than
 * omitted. Omitting it silently disables the health check for that connection -
 * a run then passes because nothing was measured, which is the exact failure
 * the check exists to prevent.
 */
export async function snapshotSockets(
  refs: string[],
  executeToolCall: ExecuteToolCall
): Promise<Record<string, SocketSnapshot[] | { unreadable: string }>> {
  const out: Record<string, SocketSnapshot[] | { unreadable: string }> = {};
  for (const ref of refs) {
    try {
      const res: any = await executeToolCall('network', { action: 'sockets', connectionReason: ref });
      const list = res?._meta?.socketList;
      out[ref] = Array.isArray(list)
        ? list
        : { unreadable: res?.isError ? firstLine(res) : 'socket health was not reported' };
    } catch (error: any) {
      out[ref] = { unreadable: error?.message || String(error) };
    }
  }
  return out;
}

/** First line of a tool response's text, for embedding in a failure message. */
function firstLine(res: any): string {
  const text = res?.content?.[0]?.text;
  return typeof text === 'string' ? text.split('\n')[0].slice(0, 120) : 'unreadable';
}

/** Shorten a socket URL for a failure message - the path is the identifying part. */
function socketLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 80) || url;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Socket problems a run CAUSED, per socket.
 *
 * Diffed against the start so a socket that was already dead is not blamed on
 * this sequence. Two failures, and the sequence's declaration sets which
 * sockets are in scope:
 *
 *  - one it depends on closed or hit frame errors mid-run. No assertion written
 *    as a final step can see this: the app keeps rendering its last synced
 *    snapshot after the socket dies, and a drop that recovered before the last
 *    step leaves no trace at all.
 *  - a declared socket is not open at the end. Absence and health are otherwise
 *    indistinguishable - a transport that never came up closes nothing, so
 *    counting closures alone passes an app that never connected.
 *
 * With no declaration (`requireSockets: true` on the run) every socket is in
 * scope for closures, but nothing can be required to exist - which socket ought
 * to be there is exactly what the declaration carries.
 *
 * Absence is returned separately because it is the one verdict worth waiting
 * on: sampled the instant the last step ends, it catches an app mid-reconnect
 * and calls a recovering transport a dead one. Closures and frame errors are
 * already-happened facts and never resolve by waiting.
 */
export function socketFailures(
  before: Record<string, SocketSnapshot[] | { unreadable: string }>,
  after: Record<string, SocketSnapshot[] | { unreadable: string }>,
  required: string[],
  requiredOn: string[]
): { settled: string[]; absent: string[] } {
  const out: string[] = [];
  const absent: string[] = [];
  const inScope = (url: string) => required.length === 0 || required.some(m => url.includes(m));
  const list = (v: SocketSnapshot[] | { unreadable: string } | undefined): SocketSnapshot[] =>
    Array.isArray(v) ? v : [];

  for (const ref of Object.keys(after)) {
    const afterEntry = after[ref];
    if (!Array.isArray(afterEntry)) {
      out.push(`${ref}: could not read socket health - ${afterEntry.unreadable}`);
      continue;
    }
    const was = new Map(list(before[ref]).map(s => [s.id, s]));
    const now = afterEntry;

    for (const sock of now) {
      if (!inScope(sock.url)) continue;
      const prev = was.get(sock.id);
      // Four closes this run did not cause, all of them normal:
      //  - already closed before the run started;
      //  - torn down with its target, since a `navigate` replaces the page's
      //    workers and takes their sockets with it;
      //  - taken with its document by a main-frame navigation the run drove;
      //  - hung up by the page itself. Chrome delivers no signal for a close()
      //    on a live document, so that one is caught only where the document
      //    went with it, and a sign-out mid-run still reports here.
      // Whether a socket came back afterwards is the end-state check's
      // question, not this one's.
      const deliberate = sock.closedWithTarget || sock.closedWithDocument || sock.clientClosed;
      if (sock.closed && !deliberate && !prev?.closed) {
        out.push(`${ref}: ${socketLabel(sock.url)} [${sock.target}] closed during the run`);
      }
      const newErrors = sock.errors - (prev?.errors || 0);
      if (newErrors > 0) {
        out.push(`${ref}: ${socketLabel(sock.url)} [${sock.target}] hit ${newErrors} frame error(s)`);
      }
    }

    for (const match of requiredOn.includes(ref) ? required : []) {
      const matching = now.filter(s => s.url.includes(match));
      if (!matching.some(s => !s.closed)) {
        absent.push(matching.length === 0
          ? `${ref}: no WebSocket matching "${match}" was ever seen - the transport this sequence asserts on never opened`
          : `${ref}: no open WebSocket matching "${match}" at the end of the run (${matching.length} seen, all closed)`);
      }
    }
  }
  return { settled: out, absent };
}
