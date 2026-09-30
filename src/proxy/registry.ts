/**
 * The proxies this session has started, one per browser that asked for one.
 *
 * Kept here rather than on the connection, because a proxy outlives the
 * connection that launched it: a hold is meant to persist while someone
 * browses, and a browse crosses tabs.
 */
import { InterceptProxy, type ProxyCursor } from './intercept-proxy.js';
import { attachLayer } from '../hold.js';

const proxies = new Map<string, InterceptProxy>();
/** Detaches each proxy's queue from the hold record when the proxy stops. */
const networkDetach = new Map<string, () => void>();
/** The flags that launch a browser through each reference's proxy. */
const launchArgs = new Map<string, string[]>();

/** What was last marked, so a proxy started mid-command inherits it. */
let current: ProxyCursor | undefined;

/**
 * How one check step went in one pass: the answer, what
 * the step did on it, and the sequence it ran with how many steps that took.
 * Kept for the newest pass only, as a pass reads its own.
 */
export interface CheckOutcome {
  runId: string;
  step: number;
  outcome: 'held' | 'failed';
  subject: string;
  found?: string;
  action: 'continue' | 'stop' | 'run';
  /** How long the check read for, and the most it could; absent for a check read once. */
  waitedMs?: number;
  limitMs?: number;
  ran?: string;
  steps?: number;
  /** The steps the sequence ran, in order: what each did, and whether it succeeded. */
  ranSteps?: RanStep[];
  error?: string;
}

/** One step a check's sequence ran, and the sequence it ran in turn when it was a check that ran one. */
export interface RanStep {
  tool: string;
  line: string;
  /** A check's parameters, which its answer's words are read from. */
  params?: Record<string, unknown>;
  success: boolean;
  error?: string;
  check?: {
    outcome: 'held' | 'failed'; action: 'continue' | 'stop' | 'run'; subject?: string; found?: string;
    waitedMs?: number; limitMs?: number;
  };
  branch?: { name: string; ranSteps: RanStep[] };
}

const checkOutcomes = new Map<string, CheckOutcome[]>();

export function checkOutcomesFor(reference: string): CheckOutcome[] {
  return checkOutcomes.get(reference) ?? [];
}

export function recordCheckOutcome(reference: string, outcome: CheckOutcome): void {
  const kept = (checkOutcomes.get(reference) ?? [])
    .filter(one => one.runId === outcome.runId && one.step !== outcome.step);
  checkOutcomes.set(reference, [...kept, outcome]);
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
  // A launch creates its proxy while it runs, after the cursor was set for
  // it, so without this the page load that launch causes carries no command.
  if (current) proxy.mark(current);
  proxies.set(reference, proxy);
  networkDetach.set(reference, attachLayer(reference, 'network', proxy.queue.mechanism()));
  return { proxy, chromeArgs };
}

/**
 * Register `reference` against the proxy `holder` was launched through. A tab
 * opened in a browser that runs through a proxy sends its traffic through that
 * proxy, since the flag is the browser's; registering the tab's name is what
 * lets the `proxy` tool and initiator notes reach it. Answers whether `holder`
 * had a proxy to share.
 */
export function shareProxy(holder: string, reference: string): boolean {
  const proxy = proxies.get(holder);
  if (!proxy) return false;
  proxies.set(reference, proxy);
  launchArgs.set(reference, launchArgs.get(holder) ?? []);
  networkDetach.set(reference, attachLayer(reference, 'network', proxy.queue.mechanism()));
  return true;
}

/** Each running proxy once, however many names share it. */
function distinctProxies(): InterceptProxy[] {
  return [...new Set(proxies.values())];
}

const cursorEnds = new Set<(ending: ProxyCursor) => void>();

/**
 * Call `listener` with each cursor as it is replaced or cleared, before the
 * next one takes its place. A store read on a timer reads again here, so a
 * change made under a step is stamped with that step rather than with
 * whatever is in flight when the timer next fires. Returns the unsubscribe.
 */
export function onCursorEnd(listener: (ending: ProxyCursor) => void): () => void {
  cursorEnds.add(listener);
  return () => { cursorEnds.delete(listener); };
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
  if (current) for (const listener of cursorEnds) listener(current);
  current = cursor;
  for (const proxy of distinctProxies()) proxy.mark(cursor);
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
 * The cursor stays in place through the wait: marked idle before it, the tail
 * this exists to keep would carry no command and fall out of every step.
 */
export async function settleProxies(quietMs: number, capMs: number): Promise<void> {
  if (quietMs <= 0 || proxies.size === 0) return;
  await Promise.all(distinctProxies().map(proxy => proxy.settle(quietMs, capMs)));
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

/**
 * When each call started, newest last: every tool call an agent makes, and
 * every step a run takes. A traffic check counts from the start of a call a
 * given number back, so the list holds calls, not only the ones that mark the
 * proxies: every call counts, read-only ones included.
 */
const callStarts: number[] = [];
const MAX_CALL_STARTS = 500;

export function noteCallStart(at = Date.now()): void {
  callStarts.push(at);
  if (callStarts.length > MAX_CALL_STARTS) callStarts.splice(0, callStarts.length - MAX_CALL_STARTS);
}

/**
 * When the call `back` before the newest began. The newest is the call
 * asking, so 0 is its own start and 1 the call before it; undefined past the
 * first call noted.
 */
export function callStartedBack(back: number): number | undefined {
  const at = callStarts.length - 1 - back;
  return at >= 0 ? callStarts[at] : undefined;
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

/** Every name registered against the proxy `reference` names, in the order they were registered. */
export function namesSharing(reference: string): string[] {
  const proxy = proxies.get(reference);
  if (!proxy) return [];
  return [...proxies.entries()].filter(([, p]) => p === proxy).map(([name]) => name);
}

/** Proxies already reported idle, so each idle spell is reported once. */
const reportedIdle = new Set<InterceptProxy>();

/**
 * Proxies none of whose names `inUse` holds, reported once per idle spell: a
 * proxy reported idle is reported again only after one of its names was in
 * use. A proxy outlives its browser, so one nothing uses keeps its port and
 * its recorded traffic until it is stopped.
 */
export function newlyIdleProxies(inUse: (name: string) => boolean): Array<{ names: string[] }> {
  const groups = new Map<InterceptProxy, string[]>();
  for (const [name, proxy] of proxies) groups.set(proxy, [...(groups.get(proxy) ?? []), name]);
  const idle: Array<{ names: string[] }> = [];
  for (const [proxy, names] of groups) {
    if (names.some(inUse)) {
      reportedIdle.delete(proxy);
    } else if (!reportedIdle.has(proxy)) {
      reportedIdle.add(proxy);
      idle.push({ names });
    }
  }
  for (const proxy of reportedIdle) if (!groups.has(proxy)) reportedIdle.delete(proxy);
  return idle;
}

export async function stopProxyFor(reference: string): Promise<boolean> {
  const proxy = proxies.get(reference);
  if (!proxy) return false;
  proxies.delete(reference);
  launchArgs.delete(reference);
  networkDetach.get(reference)?.();
  networkDetach.delete(reference);
  // Another tab of the same browser still sends its traffic through it.
  if ([...proxies.values()].includes(proxy)) return true;
  proxy.queue.releaseAll();
  await proxy.stop().catch(() => {});
  return true;
}
