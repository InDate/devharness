/**
 * The browsers a run owns: launching the ones a sequence declares, closing
 * what the run launched, and leaving a browser up when another connection
 * shares its port.
 */
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { sanitizeReference } from '../reference-validator.js';
import { connectionsOf } from './replay-executor.js';
import { declaredProfileConflict } from './replay-validation.js';

/**
 * Live connection references sharing `port`, excluding `self`. Empty when the
 * session cannot be read - an unreadable list must not stop a requested kill,
 * only a KNOWN co-tenant does.
 */
export async function connectionsSharingPort(
  executeToolCall: ExecuteToolCall,
  port: number,
  self: string
): Promise<string[]> {
  try {
    const parsed = connectionsOf(await executeToolCall('connection', { action: 'list' }));
    if (!parsed) return [];
    return parsed
      .filter(c => c.port === port
        && c.connected !== false
        && sanitizeReference(c.reference) !== sanitizeReference(self))
      .map(c => c.reference);
  } catch {
    return [];
  }
}

/**
 * Connections a sequence actually loads the app in - the ones a declared
 * WebSocket could plausibly belong to.
 *
 * A navigate step names its connection or takes the run's; either way the app
 * comes up there and its sockets open. Everything else (asserting a captured
 * value, waiting, inspecting) can take a connection without ever giving the
 * transport a page to live on, so counting those made an idle browser look
 * driven and failed the run for a socket nothing had asked it to open.
 *
 * Empty when the sequence never navigates - it is then driving a page someone
 * else loaded, and the caller falls back to the wider rule rather than
 * silently checking nothing.
 */
export function navigatedConnections(commands: RecordedCommand[], runConnection: string | undefined): string[] {
  const refs: string[] = [];
  for (const cmd of commands) {
    if (cmd.tool !== 'navigate') continue;
    const raw = cmd.params?.connection;
    const ref = typeof raw === 'string' && raw.trim() ? sanitizeReference(raw) : runConnection;
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * Launch the browsers a sequence declares it needs, if they are not live yet,
 * and answer with the ones this run launched - the ones it owns and closes.
 *
 * Naming a connection on a step does not create it. Without this, a
 * multi-browser sequence runs only when someone has already opened those
 * browsers by hand — so an unattended suite run skips precisely the coverage
 * that a single browser cannot provide.
 *
 * A caller's `connections` rebinding wins: the declaration supplies a default
 * browser, it does not override where the caller wants the steps pointed.
 */
/** A declared browser that would not launch, with the launch's own error. */
export type DeclaredLaunchFailure = { connection: string; role?: string; error: string };

export async function ensureDeclaredConnections(
  sequence: CommandSequence,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connection: string) => Promise<any>,
  connectionMap: Record<string, string> | undefined
): Promise<{ launched: string[]; failed?: DeclaredLaunchFailure[]; error?: string; invalid?: boolean }> {
  const declared = sequence.requiredConnections;
  if (!Array.isArray(declared) || declared.length === 0) return { launched: [] };

  const conflict = declaredProfileConflict(declared, connectionMap);
  if (conflict) return { launched: [], error: `"${sequence.name}": ${conflict}`, invalid: true };

  const launched: string[] = [];
  // Every declaration is attempted: stopping at the first failure hides whether
  // the others would have come up, which is what tells a clash from a bad browser.
  const failed: DeclaredLaunchFailure[] = [];
  for (const decl of declared) {
    const wanted = sanitizeReference(decl.connection);
    if (!wanted) continue;
    // Rebound onto an existing session connection: nothing to launch.
    const target = connectionMap?.[wanted] ?? wanted;
    if (connectionMap?.[wanted]) continue;

    // Probing first is not enough: a reference can still resolve to a page after
    // the browser was killed out of band, and skipping the launch then fails the
    // first step that uses it. Attempt the launch and treat "already bound" as a
    // live browser to reuse.
    try {
      const result: any = await executeToolCall('connection', {
        action: 'launch',
        connection: target,
        url: decl.url ?? sequence.startUrl,
        // A profile IS the browser this declaration wants, so a live Chrome
        // already running it is the target rather than something to spawn
        // beside - and only one Chrome may hold a profile, so forcing a second
        // process fails against the browser it was asking for.
        forceNewInstance: decl.profile
          ? decl.forceNewInstance === true
          : decl.forceNewInstance !== false,
        ...(decl.profile && { profile: decl.profile }),
        ...(decl.proxy && { proxy: true }),
      });
      // A launch that found the name already up reused someone else's browser
      // (a profile-bearing declaration launches without forceNewInstance), and
      // a browser the run did not create is not the run's to close (#103).
      if (result?._meta?.launch?.reused !== true) launched.push(target);
    } catch (err: any) {
      if (err?.response?._errorId === 'CHROME_REFERENCE_ALREADY_BOUND') {
        try {
          if (await getPageForConnection(target)) continue;
        } catch { /* fall through to the error below */ }
      }
      failed.push({
        connection: target,
        ...(decl.role && { role: decl.role }),
        // The launch reply's own suggestions are for a direct caller; the play
        // names the failure, and the error up to them is the failure.
        error: String(err?.message || err).split('**Suggestions')[0]!.replace(/^Error:\s*/, '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 300),
      });
    }
  }
  if (failed.length === 0) return { launched };
  return {
    launched,
    failed,
    error: `"${sequence.name}" needs browsers that would not launch:\n`
      + failed.map(f => `- "${f.connection}"${f.role ? ` (${f.role})` : ''}: ${f.error}`).join('\n'),
  };
}

/**
 * Close browsers this run launched from a sequence's requiredConnections.
 *
 * The run created them, so the run owns them. Anything the caller supplied is
 * left alone. Without this a suite leaves a browser behind per multi-browser
 * sequence, and the next run silently reuses one holding state from before —
 * which is worse than the clutter, because it looks like a fresh browser.
 */
export async function closeLaunchedConnections(
  launched: string[],
  executeToolCall: ExecuteToolCall,
  getConnectionPort: ((connection: string) => Promise<number | null>) | undefined,
  sequenceName: string,
  /** How the run came to own these, for the kill reason and the closing note. */
  origin: string = 'declared and launched'
): Promise<string> {
  if (launched.length === 0 || !getConnectionPort) return '';
  const closed: string[] = [];
  for (const ref of launched) {
    try {
      const port = await getConnectionPort(ref);
      if (port === null) continue;
      const sharers = await connectionsSharingPort(executeToolCall, port, ref);
      if (sharers.length > 0) continue; // someone else is on this browser
      const reason = `sequence "${sequenceName}" ${origin} ${ref}`;
      await executeToolCall('browser', { action: 'kill', reason, port });
      // Release the reference as well. Killing the process leaves the name
      // bound, and the next sequence in a suite declaring the same reference
      // then fails to launch against a browser that no longer exists.
      await executeToolCall('connection', { action: 'close', reason, connection: ref }).catch(() => {});
      closed.push(ref);
    } catch {
      // Best-effort: a browser that will not close is not a run failure.
    }
  }
  return closed.length ? `\n\n**Browsers closed** (${origin}): ${closed.join(', ')}` : '';
}

/**
 * Declared-browser cleanups owed by a run that PAUSED, keyed by run id (or by
 * sequence id for a `wait: true` pause, which registers no run record).
 *
 * A pause is the one outcome that deliberately keeps its browsers - they are
 * the state someone stopped to inspect. Every way out of a pause is terminal
 * though (cancel, step to the end, finish), and each has to close them, or
 * the browsers stay up and the next run reuses one carrying the previous
 * run's state (issue #127).
 */
export const pendingDeclaredCleanups = new Map<string, () => Promise<string>>();

export const cleanupKey = (runId: string | undefined, sequenceId: string) => runId ?? `seq:${sequenceId}`;

/** Run and forget the cleanup a paused run left owing, if any. */
export async function drainDeclaredCleanup(runId: string | undefined, sequenceId: string): Promise<string> {
  const key = cleanupKey(runId, sequenceId);
  const cleanup = pendingDeclaredCleanups.get(key);
  if (!cleanup) return '';
  pendingDeclaredCleanups.delete(key);
  return cleanup().catch(() => '');
}
