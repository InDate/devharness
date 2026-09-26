/**
 * The proxies this session has started, one per browser that asked for one.
 *
 * Kept here rather than on the connection, because a proxy outlives the
 * connection that launched it: a hold is meant to persist while someone
 * browses, and a browse crosses tabs.
 */
import { InterceptProxy, type ProxyCursor } from './intercept-proxy.js';

const proxies = new Map<string, InterceptProxy>();
/** The flags that launch a browser through each reference's proxy. */
const launchArgs = new Map<string, string[]>();

/** What was last marked, so a proxy started mid-command inherits it. */
let current: ProxyCursor | undefined;

/**
 * A replay step held open until what it waits for has crossed: `count` of
 * the kind `key` names, or of anything with no key, within `seconds`. On
 * `onFail: 'fail'` a step whose crossings never came fails; on `continue` the
 * run goes on without them.
 */
export interface StepWait {
  step: number;
  key?: string;
  count: number;
  seconds: number;
  onFail: 'fail' | 'continue';
}

const stepWaits = new Map<string, StepWait[]>();
const waitFailures = new Map<string, string>();

/**
 * How one wait went in one pass: `waiting` while its step is held, then met,
 * failed, or carried on without what it waited for, with how many arrived.
 */
export interface WaitOutcome {
  runId: string;
  step: number;
  key?: string;
  state: 'waiting' | 'met' | 'failed' | 'carried';
  arrived: number;
  count: number;
  seconds: number;
  startedAt: number;
}

const waitOutcomes = new Map<string, WaitOutcome[]>();

/** How this browser's waits went, newest pass last. */
export function waitOutcomesFor(reference: string): WaitOutcome[] {
  return waitOutcomes.get(reference) ?? [];
}

/** The waits a browser's replays hold their steps open for, replacing any it had. */
export function setStepWaits(reference: string, waits: StepWait[]): void {
  if (waits.length) stepWaits.set(reference, waits);
  else stepWaits.delete(reference);
}

/** The failure a wait left on this browser's last released step, taken once. */
export function takeWaitFailure(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const failure = waitFailures.get(reference);
  waitFailures.delete(reference);
  return failure;
}

export async function startProxyFor(reference: string, appUrl?: string): Promise<{
  proxy: InterceptProxy;
  chromeArgs: string[];
}> {
  // A browser relaunched under the same reference outlives nothing of the old
  // one: it needs the flags again, or it starts outside the proxy that is
  // still recording for it and every crossing goes unseen.
  const existing = proxies.get(reference);
  if (existing) return { proxy: existing, chromeArgs: launchArgs.get(reference) ?? [] };

  const proxy = new InterceptProxy();
  const { chromeArgs } = await proxy.start();
  launchArgs.set(reference, chromeArgs);
  // Only the app under test reaches the network. Everything the browser does
  // on its own account is refused, which is what makes a count of events
  // between two steps a statement about the app.
  if (appUrl) {
    try { proxy.allowOnly([new URL(appUrl).host]); } catch { /* not a URL to scope by */ }
  }
  // launchChrome creates its proxy while it runs, after the cursor was set for
  // it, so without this the page load that launch causes carries no command.
  if (current) proxy.mark(current);
  proxies.set(reference, proxy);
  return { proxy, chromeArgs };
}

/**
 * Stamp every running proxy with what is now in flight.
 *
 * Every proxy takes the same cursor because the history counter and the run
 * are both global to the session. An event then carries what was running when
 * it crossed, whichever browser produced it, and no reference has to be
 * resolved at the point a command is recorded - some carry no connection.
 */
export function markOnProxies(cursor: ProxyCursor | undefined): void {
  current = cursor;
  for (const proxy of proxies.values()) proxy.mark(cursor);
}

/**
 * Hold until every proxy's boundary is quiet, while the returning command's
 * cursor stays in place.
 *
 * Attribution by position, and the last resort among the three mechanisms the
 * `stepSettleMs` config describes. Traffic that starts inside the window is
 * credited to the command that just returned because it crossed then, not
 * because anything measured a cause. Where the page reports a cause - a
 * parser-rooted subresource, a timer-rooted request or send - that measurement
 * already stands and the wait adds nothing to it.
 *
 * Marking idle before the wait, as an earlier build did, stamped the tail this
 * exists to keep with no command and dropped it from every step.
 */
export async function settleProxies(quietMs: number, capMs: number): Promise<void> {
  if (quietMs <= 0 || proxies.size === 0) return;
  await Promise.all([...proxies.values()].map(proxy => proxy.settle(quietMs, capMs)));
}

/** Runs one boundary at a time; see markNextCommand and releaseCommand. */
let boundary: Promise<void> = Promise.resolve();

function onBoundary<T>(work: () => Promise<T>): Promise<T> {
  const mine = boundary.then(work);
  boundary = mine.then(() => {}, () => {});
  return mine;
}

/**
 * Mark the next command, one caller at a time.
 *
 * Two tool calls in flight would otherwise interleave: the second marks its
 * index while the first command's boundary is still being released, and the
 * first command's tail is stamped with the second. Serialising holds each
 * boundary together.
 *
 * It does not make concurrent calls safe to attribute - traffic from two
 * commands running at once against one browser is interleaved on the wire,
 * and nothing here separates it. It bounds the damage to that.
 */
export async function markNextCommand(cursor: ProxyCursor): Promise<void> {
  await onBoundary(async () => { markOnProxies(cursor); });
}

/**
 * Clear the cursor once the command that set it has returned, and answer with
 * the time it was cleared.
 *
 * A bucket that runs until the next command marks holds everything between the
 * two, which on the last recorded step is the whole of the pause before the
 * recording is saved. Clearing at the return bounds a bucket to its own
 * command. What crosses afterwards carries no command, and ownership survives
 * without it: a paired arrival owns through the send it settles, and a request
 * owns through the cursor it was issued under. Only traffic nothing accounts
 * for falls out of every step, which is the reading a background set needs.
 *
 * The wait for quiet, where one is configured, runs here rather than before
 * the next mark, so a command pays for it out of the gap after it instead of
 * out of its own response. A second driving call arriving inside that gap
 * waits on the boundary for the remainder. With `stepSettleMs` at its default
 * of 0 there is no wait and the cursor clears as the command returns, which is
 * what every reading of a gap rests on.
 *
 * `reference` settles the proxy that command drove. A command that names no
 * connection settles every proxy, since any of them may carry what it caused.
 * A command naming a browser that has no proxy settles nothing: fanning out
 * there would charge every other browser's boundary for a command that cannot
 * have crossed it.
 */
export function releaseCommand(
  quietMs: number,
  capMs: number,
  reference?: string
): Promise<number> {
  return onBoundary(async () => {
    if (reference === undefined) await settleProxies(quietMs, capMs);
    else await proxies.get(reference)?.settle(quietMs, capMs);
    // Held open, still marked, until what the step waits for has crossed:
    // released on time alone, what arrives after is stamped with no step.
    const cursor = current;
    const proxy = reference === undefined ? undefined : proxies.get(reference);
    if (proxy && cursor?.kind === 'replay') {
      for (const wait of stepWaits.get(reference!) ?? []) {
        if (wait.step !== cursor.step) continue;
        // Kept per browser for the pass's rows; a pass replaces the one before.
        const outcome: WaitOutcome = {
          runId: cursor.runId, step: cursor.step, ...(wait.key ? { key: wait.key } : {}),
          state: 'waiting', arrived: 0, count: wait.count, seconds: wait.seconds, startedAt: Date.now(),
        };
        const kept = (waitOutcomes.get(reference!) ?? []).filter(one => one.runId === cursor.runId
          && !(one.step === outcome.step && one.key === outcome.key));
        waitOutcomes.set(reference!, [...kept, outcome]);
        const came = await proxy.awaitCrossings({
          runId: cursor.runId, step: cursor.step, count: wait.count, timeoutMs: wait.seconds * 1000,
          ...(wait.key ? { key: wait.key } : {}),
        });
        outcome.arrived = came.arrived;
        outcome.state = came.met ? 'met' : wait.onFail === 'fail' ? 'failed' : 'carried';
        if (outcome.state === 'failed') {
          waitFailures.set(reference!, `step ${wait.step + 1} waited ${wait.seconds}s for ${wait.count} of ${wait.key ?? 'anything'} and got ${came.arrived}`);
          break;
        }
      }
    }
    markOnProxies(undefined);
    return Date.now();
  });
}

/** Resolve once every queued mark and release has run. */
export function boundarySettled(): Promise<void> {
  return boundary;
}

/**
 * What is in flight now, as every proxy stamps it: a replay's run and step, or
 * a command. Read by what records outside the proxy - storage writes - so it
 * carries the same step as the traffic beside it.
 */
export function currentCursor(): ProxyCursor | undefined {
  return current;
}

export function getProxy(reference: string): InterceptProxy | undefined {
  return proxies.get(reference);
}

/** Drop the cursor, so a later proxy starts unstamped. Tests use it. */
export function forgetCursor(): void {
  current = undefined;
}

export function listProxies(): string[] {
  return [...proxies.keys()];
}

export async function stopProxyFor(reference: string): Promise<boolean> {
  const proxy = proxies.get(reference);
  if (!proxy) return false;
  proxies.delete(reference);
  launchArgs.delete(reference);
  await proxy.stop().catch(() => {});
  return true;
}
