import { appendEvent } from '../session-events.js';
import { debugLog } from '../debug-logger.js';
import { attachLayer, hold, holdReading, isHeld, release, step, type HoldLayer, type HoldSource, type LayerHold, type LayerStanding } from '../hold.js';
import type { CallbackEntry, TickResult } from '../bench/wire.js';
import { isRunning, nextPause, pageTime, send, setInspectMode } from './cdp.js';
import { dialogMonitorOf } from '../dialog-monitor.js';
import { type BenchSession, MAX_CALLBACK_LOG, sessions } from './session.js';

/**
 * Hand the page over for the duration of `work`, then put it back as it was.
 *
 * Three things have to hold while a step runs, and they are the reason this is
 * one primitive rather than a sequence of calls at each call site:
 *
 * - the page must be running, because puppeteer's own queries - how a step
 *   finds its element - block on a paused isolate and report it as missing;
 * - no pause of ours may land while it runs, and detaching the agent is the
 *   only thing that cancels one already armed;
 * - a pause that is NOT ours is left exactly alone, so a breakpoint someone
 *   set is still there, still stopped, when the step is done.
 */
export async function withPageReleased<T>(session: BenchSession, work: () => Promise<T>): Promise<T> {
  // A JavaScript dialog stops the page's scripts, so no hold of ours is in
  // force and every call below would wait out its bound: 3s apiece, which
  // stretched the step that answers a confirm past 20s.
  if (stoppedByDialog(session)) return work();
  const { client } = session;
  const wasFrozen = session.frozen;
  // Every layer the step would otherwise drive into a stop: the queue lets
  // held traffic cross during the step, so it lands under the step.
  const restore = holdReading(session.connection).held.filter(stopsDriving);
  if (restore.length) await release(session.connection, { layers: restore.map(held => held.layer) });
  if (session.heldByOther) {
    debugLog('bench', 'a pause the bench did not request is in play');
  }

  // The step instrumentation lives in EventBreakpoints, a domain of its own:
  // Debugger.disable below leaves it armed. A step that drives the page runs
  // page.evaluate to resolve its selector, that evaluate schedules a timer, the
  // armed setTimeout.callback instrumentation stops the page inside the
  // evaluate, and the evaluate never returns - the step then hangs to its
  // 30s timeout and reports the selector as the failure. Clearing it here
  // covers the release that arrives with `frozen` already false, which
  // releaseScreenHold's own EventBreakpoints.disable never reaches.
  await send(client, 'EventBreakpoints.disable');

  // Detaching the agent is what cancels a pause of ours that is armed but has
  // not landed. `pauseRequested` deliberately stays set until the next hold
  // replaces it: clearing it here would misread our own late-landing pause as
  // someone else's, and then nothing would ever release it.
  await send(client, 'Debugger.setSkipAllPauses', { skip: true });
  await send(client, 'Debugger.disable');
  session.stepBreakpointsSet = false;
  session.pauseTaken = false;

  // Detaching usually drops our pause with it. When it does not, the step would
  // run against a stopped page and hang on puppeteer's own queries, so it is
  // worth one more attempt - through our own agent only. A pause someone else
  // set is reported and left exactly where it is.
  if (!(await isRunning(client))) {
    // If the bench was the one holding the page, finishing that release is ours
    // to do - including a pause of ours that landed late and got recorded as
    // foreign. Only a page the bench was NOT holding is left alone, which is the
    // case that would be someone else's breakpoint.
    if (wasFrozen || !session.heldByOther) {
      await send(client, 'Debugger.enable');
      await send(client, 'Debugger.resume');
      await send(client, 'Debugger.disable');
      session.heldByOther = false;
      if (!(await isRunning(client))) {
        debugLog('bench', 'page is still held going into the step');
      }
    } else {
      debugLog('bench', 'page held by a pause the bench did not take; leaving it alone');
    }
  }

  try {
    return await work();
  } finally {
    // A dialog the step opened leaves the agent detached until the next
    // step's release, which runs once the dialog is answered.
    if (!stoppedByDialog(session)) await restoreAfterStep(session, restore);
  }
}

/** Whether a JavaScript dialog has stopped the bench's page. */
export function stoppedByDialog(session: BenchSession): boolean {
  return dialogMonitorOf(session.page)?.current()?.kind === 'javascript';
}

async function restoreAfterStep(session: BenchSession, restore: LayerHold[]): Promise<void> {
  const { client } = session;
  await send(client, 'Debugger.enable');
  await send(client, 'Debugger.setSkipAllPauses', { skip: false });
  for (const source of new Set(restore.map(held => held.source))) {
    const layers = restore.filter(held => held.source === source).map(held => held.layer);
    await hold(session.connection, { source, layers }).catch(() => {});
  }
}

/**
 * Turn a pause into a log line. The instrumentation name arrives as
 * "instrumentation:setTimeout.callback"; only the middle of that is worth
 * showing, and a frame with no function name is an anonymous callback.
 */
export function describePause(session: BenchSession, event: any, at: number): CallbackEntry {
  const frame = event?.callFrames?.[0];
  const raw = typeof event?.data?.eventName === 'string' ? event.data.eventName : undefined;
  const kind = raw?.replace(/^instrumentation:/, '').replace(/\.callback$/, '');
  // A script parsed before the bench attached - an inline script of the page -
  // is not in the bench's own list; the paused frame carries its URL itself.
  const url = (frame?.location?.scriptId ? session.scripts.get(frame.location.scriptId) : undefined) || frame?.url || undefined;
  return {
    index: session.totalSteps + 1,
    at: Math.round(at),
    ...(kind ? { kind } : {}),
    ...(frame ? { fn: frame.functionName || '(anonymous)' } : {}),
    ...(url ? { url } : {}),
    ...(frame?.location?.lineNumber !== undefined ? { line: frame.location.lineNumber + 1 } : {}),
  };
}


/**
 * Both clocks stopped: JS via the debugger, CSS animation via playback rate.
 *
 * An idle page has nothing to stop, so the pause is armed rather than taken and
 * no paused event arrives. The page is held either way - the next callback walks
 * into it - but the two states are released differently, so which one happened
 * has to be remembered.
 */
async function holdScreen(session: BenchSession): Promise<void> {
  if (session.frozen) return;
  const { client } = session;
  // Debugger.pause does nothing against a disabled agent or one set to skip
  // every pause, and a release leaves it in both of those states.
  await send(client, 'Debugger.enable');
  await send(client, 'Debugger.setSkipAllPauses', { skip: false });
  await send(client, 'Animation.setPlaybackRate', { playbackRate: 0 });
  session.pauseRequested = true;
  // The JS is still stopped where a screen was released on its own; a second
  // pause raises no event, and waiting on one would read the stop as armed.
  if (session.jsKept) {
    session.jsKept = false;
  } else {
    const paused = nextPause(client, 1000);
    await send(client, 'Debugger.pause');
    session.pauseTaken = !!(await paused);
  }
  session.frozen = true;
}

/**
 * Let the page run again without closing the bench. The step breakpoints
 * go first, or the resume would pause on the very next callback.
 */
async function releaseScreenHold(session: BenchSession): Promise<void> {
  if (!session.frozen) return;
  await releaseScreen(session);
  await releaseJs(session);
}

/**
 * The screen's half of a release: the step breakpoints come off and CSS
 * animation runs again, and the page's JS stays paused where it stands. The
 * step breakpoints go first, or a later resume would stop on the very next
 * callback.
 */
async function releaseScreen(session: BenchSession): Promise<void> {
  if (!session.frozen) return;
  await send(session.client, 'EventBreakpoints.disable');
  session.stepBreakpointsSet = false;
  await send(session.client, 'Animation.setPlaybackRate', { playbackRate: 1 });
  session.frozen = false;
  session.jsKept = true;
}

/** The JS half: the bench's pause resumed, or discarded where it was armed and never taken. */
async function releaseJs(session: BenchSession): Promise<void> {
  const { client } = session;
  if (session.pauseTaken) {
    await send(client, 'Debugger.resume');
    session.pauseTaken = false;
  } else {
    // Nothing is stopped, so there is nothing to resume - the pause is armed and
    // waiting. Only disabling the debugger discards it; leaving it would stop
    // the page the next time it did anything, with no one left holding it.
    await send(client, 'Debugger.disable');
    await send(client, 'Debugger.enable');
  }
  session.pausedEvent = undefined;
  session.jsKept = false;
}

/**
 * Leave the page as the bench found it: running, with no agent of ours attached.
 *
 * Every hold on the connection is released except a breakpoint's. A pause
 * someone else set - a breakpoint from the breakpoint tool, a `debugger`
 * statement - is left stopped, because
 * resuming it would throw away what they stopped to look at and they would have
 * no way to know the bench did it.
 */
export async function releaseBench(session: BenchSession): Promise<void> {
  await releaseHolds(session.connection);
  session.detachUi?.();
  if (session.heldByOther) {
    debugLog('bench', 'leaving a pause that is not ours in place');
  }
  await send(session.client, 'Debugger.disable');
}

export function holdUi(session: BenchSession): Promise<unknown> {
  return hold(session.connection, { source: 'bench', layers: ['ui'] });
}

export function releaseUi(session: BenchSession): Promise<unknown> {
  return release(session.connection, { layers: ['ui'] });
}

/** Release every layer held on the connection, leaving a breakpoint's pause where it stopped. */
export async function releaseHolds(connection: string): Promise<void> {
  const layers = holdReading(connection).held
    .filter(held => held.source !== 'breakpoint')
    .map(held => held.layer);
  if (layers.length) await release(connection, { layers });
}

/** The bench's own UI hold, attached to the hold record for as long as the bench is open. */
export function attachUiLayer(session: BenchSession): void {
  session.detachUi = attachLayer(session.connection, 'ui', {
    covers: ['code'],
    engage: async () => {
      await holdScreen(session);
      return uiStanding(session);
    },
    disengage: () => releaseScreenHold(session),
    disengageKeeping: () => releaseScreen(session),
    releaseKept: () => releaseJs(session),
    step: async () => {
      await tickBench(session.connection, { steps: 1 });
      return uiStanding(session);
    },
  });
}

function uiStanding(session: BenchSession): LayerStanding {
  const last = session.lastTick?.ran.at(-1);
  return {
    pageMs: session.tickMs,
    callbacks: session.totalSteps,
    ...(last ? { callback: `${last.kind ?? 'callback'} ${last.fn ?? ''}`.trim() } : {}),
  };
}

/**
 * Let go of every hold before a run drives the page. Pressing play is the
 * request to run: a hold left in place would be released by every step for
 * its own duration and taken again after, and the run would flicker through
 * the hold instead of either stopping for it or running. A breakpoint's stop
 * is left where it is.
 */
export async function letGoForRun(session: BenchSession): Promise<void> {
  const reading = holdReading(session.connection).held;
  const layers = reading.filter(stopsDriving).map(held => held.layer);
  if (layers.length === 0) return;
  await release(session.connection, { layers });
  await announceHold(session, reading.map(held => held.layer), false, 'bench');
}

/**
 * Whether a hold has to be let go for a step to drive the page.
 *
 * A held screen or held code stops the page's JS, so a click reaches nothing
 * and a step waits on it to its timeout: those go, a breakpoint's excepted,
 * which is left where it stopped. Held traffic stops nothing the page does -
 * it stands for a network that is slow or gone, which is a condition to drive
 * the app under - so a person's traffic hold stays. The traffic a sequence's
 * own pause took goes, so what crosses lands under the step that let it
 * through.
 */
function stopsDriving(held: LayerHold): boolean {
  if (held.source === 'breakpoint') return false;
  return held.layer !== 'network' || held.source === 'sequence';
}

/**
 * Write a hold or release the bench made to the session's event stream, so the
 * agent reads the moment the person stopped on while it is still held.
 */
export async function announceHold(session: BenchSession, before: HoldLayer[], held: boolean, source: HoldSource): Promise<void> {
  const after = holdReading(session.connection).held.map(layer => layer.layer);
  const changed = held ? after.filter(layer => !before.includes(layer)) : before.filter(layer => !after.includes(layer));
  if (changed.length === 0) return;
  await appendEvent(session.session, 'hold', {
    connection: session.connection,
    change: held ? 'held' : 'released',
    layers: changed,
    source,
    detail: `${changed.join(', ')} ${held ? `held by the ${source}` : 'released'} on ${session.connection}`,
  });
}

/** Let the oldest crossing kept at the proxy through, and keep the rest held. */
export async function stepTraffic(connection: string): Promise<void> {
  if (isHeld(connection, 'network')) await step(connection, 'network');
}

/** Pause on every scheduled callback, which is what makes a step land on one. */
const STEP_EVENTS = ['setTimeout.callback', 'setInterval.callback', 'requestAnimationFrame.callback'];

async function ensureStepBreakpoints(session: BenchSession): Promise<void> {
  if (session.stepBreakpointsSet) return;
  for (const eventName of STEP_EVENTS) {
    await session.client.send('EventBreakpoints.setInstrumentationBreakpoint', { eventName } as any).catch(() => {});
  }
  session.stepBreakpointsSet = true;
}

/**
 * Run the frozen page forward, then freeze again.
 *
 * `steps` is the honest unit: one callback is one atomic thing the page does,
 * and the only amount a step can deliver exactly. `budgetMs` is the convenience
 * for chasing a known timeout - "get me past the 800ms dismiss" - and runs
 * callbacks until at least that much page time has been spent, reporting where
 * it landed rather than pretending it stopped on the millisecond.
 */
export async function tickBench(
  connection: string,
  request: { steps?: number; budgetMs?: number } = {},
  stepTimeoutMs = 2000
): Promise<TickResult | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;

  const { client } = session;
  // Stepping only means anything against a held page.
  if (!session.frozen) await holdUi(session);
  await ensureStepBreakpoints(session);

  // Neither given means the smallest possible move: one callback.
  const wantSteps = request.steps ?? (request.budgetMs === undefined ? 1 : undefined);
  const wantMs = request.budgetMs;

  // Only the resume windows count. performance.now() keeps running while V8 is
  // paused - the clock is wall-clock based, and pausing stops execution, not
  // time - so measuring from the start of the hold would charge the page for
  // however long someone spent looking at it.
  let elapsed = 0;
  let steps = 0;
  let quiet = false;
  const ran: CallbackEntry[] = [];

  const satisfied = () =>
    (wantSteps !== undefined && steps >= wantSteps) ||
    (wantMs !== undefined && elapsed >= wantMs);

  while (!satisfied()) {
    const before = await pageTime(client);
    const paused = nextPause(client, stepTimeoutMs);
    // An armed pause needs no resume: the page is already running towards it,
    // and the next callback is what it will stop on.
    if (session.pauseTaken) {
      session.pauseTaken = false;
      await client.send('Debugger.resume').catch((error) => {
        debugLog('bench', `step: resume failed: ${error}`);
      });
    }
    const event = await paused;
    if (!event) {
      // Nothing was scheduled within the window - the page has gone quiet, so
      // there is nothing to step to. Hold again where it stands.
      quiet = true;
      await client.send('Debugger.pause').catch(() => {});
      await nextPause(client, stepTimeoutMs);
      break;
    }
    steps++;
    elapsed += Math.max(0, (await pageTime(client)) - before);

    const entry = describePause(session, event, session.tickMs + elapsed);
    entry.index = session.totalSteps + steps;
    ran.push(entry);
    session.callbacks.push(entry);
    if (session.callbacks.length > MAX_CALLBACK_LOG) {
      session.callbacks.splice(0, session.callbacks.length - MAX_CALLBACK_LOG);
    }
  }

  const actualMs = Math.round(elapsed);
  session.tickMs += actualMs;
  session.totalSteps += steps;
  const result: TickResult = {
    ...(wantSteps !== undefined ? { requestedSteps: wantSteps } : {}),
    ...(wantMs !== undefined ? { requestedMs: wantMs } : {}),
    steps,
    actualMs,
    tickMs: session.tickMs,
    totalSteps: session.totalSteps,
    quiet,
    ran,
  };
  session.lastTick = result;
  await setInspectMode(session, session.pickerArmed).catch(() => {});

  return result;
}
