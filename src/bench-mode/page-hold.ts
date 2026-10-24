import { appendEvent } from '../session-events.js';
import { debugLog } from '../debug-logger.js';
import { releasedRate, seekAnimations } from './animations.js';
import { attachLayer, hold, holdReading, isHeld, release, step, type HoldLayer, type HoldSource, type LayerHold, type LayerStanding } from '../hold.js';
import type { CallbackEntry, TickResult } from '../bench/wire.js';
import { pageTime, request, send, setInspectMode } from './cdp.js';
import { ownScript } from '../utils/own-script.js';
import { CLOCK_KEY } from '../page-clock.js';
import { dialogMonitorOf } from '../dialog-monitor.js';
import { type BenchSession, type PageDebugger, MAX_CALLBACK_LOG, sessions } from './session.js';

/**
 * Hand the page over for the duration of `work`, then put it back as it was.
 *
 * Three things have to hold while a step runs, and they are the reason this is
 * one primitive rather than a sequence of calls at each call site:
 *
 * - the page must be running, because puppeteer's own queries - how a step
 *   finds its element - block on a paused isolate and report it as missing;
 * - no pause of ours may land while it runs, so one asked for and not landed
 *   is disarmed, and the callback stops come off;
 * - a pause that is NOT ours is left exactly alone, so a breakpoint someone
 *   set is still there, still stopped, when the step is done.
 */
export async function withPageReleased<T>(session: BenchSession, work: () => Promise<T>): Promise<T> {
  // A JavaScript dialog stops the page's scripts, so no hold of ours is in
  // force and every call below would wait out its bound: 3s apiece, which
  // stretched the step that answers a confirm past 20s.
  if (stoppedByDialog(session)) return work();
  // Every layer the step would otherwise drive into a stop: the queue lets
  // held traffic cross during the step, so it lands under the step.
  const restore = holdReading(session.connection).held.filter(stopsDriving);
  if (restore.length) await release(session.connection, { layers: restore.map(held => held.layer) });

  // A step that drives the page runs page.evaluate to resolve its selector,
  // that evaluate schedules a timer, and a callback stop left armed would stop
  // the page inside the evaluate, which then never returns.
  await session.debugger?.clearInstrumentationBreakpoints();
  session.stepBreakpointsSet = false;

  // A pause standing or armed that no hold accounts for is a late one of the
  // bench's; a breakpoint's is recorded on the code layer and stays.
  const dbg = session.debugger;
  const foreign = holdReading(session.connection).held.some(held => held.layer === 'code' && held.source === 'breakpoint');
  if (dbg && !foreign) {
    if (dbg.isPaused()) await dbg.resume().catch(() => {});
    else await dbg.disarmPause().catch(() => {});
  } else if (foreign) {
    debugLog('bench', 'page held by a pause the bench did not take; leaving it alone');
  }

  try {
    return await work();
  } finally {
    // A dialog the step opened leaves the page unheld until the next step's
    // release, which runs once the dialog is answered.
    if (!stoppedByDialog(session)) await restoreAfterStep(session, restore);
  }
}

/** Whether a JavaScript dialog has stopped the bench's page. */
export function stoppedByDialog(session: BenchSession): boolean {
  return dialogMonitorOf(session.page)?.current()?.kind === 'javascript';
}

async function restoreAfterStep(session: BenchSession, restore: LayerHold[]): Promise<void> {
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
  const scriptId = frame?.location?.scriptId;
  const url = (scriptId ? session.debugger?.scriptUrl(scriptId) : undefined) || frame?.url || undefined;
  return {
    index: session.totalSteps + 1,
    at: Math.round(at),
    ...(kind ? { kind } : {}),
    ...(frame ? { fn: frame.functionName || '(anonymous)' } : {}),
    ...(url ? { url } : {}),
    ...(frame?.location?.lineNumber !== undefined ? { line: frame.location.lineNumber + 1 } : {}),
  };
}


/** The page's debugger connection, which a screen hold cannot do without. */
function debuggerOf(session: BenchSession): PageDebugger {
  if (!session.debugger) throw new Error(`The screen of "${session.connection}" cannot be held: no debugger is connected to its page.`);
  return session.debugger;
}

/**
 * Both clocks stopped: JS via the page's debugger connection, CSS animation
 * via playback rate.
 *
 * An idle page has nothing to stop, so the pause is armed rather than taken
 * and lands on the next script the page runs; the debugger connection tells
 * the two apart and releases each its own way. A pause already standing - the
 * code kept stopped after a screen released on its own - is the hold's.
 *
 * Armed for a frame stop, the hold pauses nothing yet: the input dispatched
 * after it runs with the animations it starts standing at 0ms, and
 * `landFrameStop` stops the page in front of the frame it scheduled.
 */
async function holdScreen(session: BenchSession): Promise<void> {
  if (session.frozen) return;
  const dbg = debuggerOf(session);
  await send(session.client, 'Animation.setPlaybackRate', { playbackRate: 0 });
  if (session.frameStopArming) {
    session.frameStopArming = false;
    session.groupSince = Date.now();
    const { result } = await request(session.client, 'Runtime.evaluate', {
      expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.holdFrames() === true`), returnByValue: true,
    }, 1000).catch(() => ({ result: undefined }));
    session.framesHeld = result?.value === true;
  } else if (!dbg.isPaused()) {
    await dbg.pause();
  }
  session.frozen = true;
}

/**
 * Let the page run again without closing the bench. The callback stops go
 * first, or the resume would stop on the very next callback.
 */
async function releaseScreenHold(session: BenchSession): Promise<void> {
  if (!session.frozen) return;
  await releaseScreen(session);
  await releaseJs(session);
}

/**
 * The screen's half of a release: the callback stops come off and CSS
 * animation runs again, and the page's JS stays paused where it stands.
 */
async function releaseScreen(session: BenchSession): Promise<void> {
  if (!session.frozen) return;
  await session.debugger?.clearInstrumentationBreakpoints();
  session.stepBreakpointsSet = false;
  await send(session.client, 'Animation.setPlaybackRate', { playbackRate: releasedRate(session) });
  session.frozen = false;
}

/**
 * Stop the page's clock where it stands, read on the stopped page: the
 * timers it holds fire, and Date and performance.now read, as if no time
 * passed while the page is held.
 */
export async function pauseClock(session: BenchSession): Promise<void> {
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.pause()`), returnByValue: true,
  }, 1000).catch(() => undefined);
}

/** The next timer or held frame a stopped page clock holds, run on the stopped page; none when it holds nothing. */
async function clockNext(session: BenchSession): Promise<{ kind: string; fn: string; now: number } | undefined> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.next(${FRAME_MS}) ?? null`), returnByValue: true,
  }, 3000).catch(() => ({ result: undefined }));
  return result?.value ?? undefined;
}

/** Run the page's clock on from where it stopped, before the page itself runs again. */
export async function resumeClock(session: BenchSession): Promise<void> {
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.resume()`), returnByValue: true,
  }, 1000).catch(() => undefined);
}

/**
 * The JS half: the pause resumed, or discarded where it was armed and never
 * landed. A stop recorded as a breakpoint's, which the hold found standing,
 * is someone else's and stays.
 */
async function releaseJs(session: BenchSession): Promise<void> {
  const dbg = session.debugger;
  const foreign = holdReading(session.connection).held.some(held => held.layer === 'code' && held.source === 'breakpoint' && !held.via);
  if (foreign) return;
  if (dbg?.isPaused()) {
    await resumeClock(session);
    await dbg.resume();
  } else {
    await dbg?.disarmPause();
    await resumeClock(session);
  }
  session.framesHeld = false;
  session.pausedEvent = undefined;
}

/**
 * Leave the page as the bench found it: running.
 *
 * Every hold on the connection is released except a breakpoint's. A pause
 * someone else set - a breakpoint from the breakpoint tool, a `debugger`
 * statement - is left stopped, because resuming it would throw away what they
 * stopped to look at and they would have no way to know the bench did it.
 */
export async function releaseBench(session: BenchSession): Promise<void> {
  await releaseHolds(session.connection);
  session.detachUi?.();
  session.unwatchPause?.();
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

/**
 * Arm the next screen hold to stop the page in front of its next animation
 * frame rather than where it stands. Taken before an input is dispatched, the
 * hold lets the input run and stops the frame the input scheduled before it
 * paints; a hold taken after the dispatch can land once that frame has run.
 */
export function armFrameStop(session: BenchSession): void {
  session.frameStopArming = true;
}

/** Where a frame stop left the page: at the frame the input scheduled, or where it stood on a page with no clock to hold frames. */
export type FrameStopLanding = 'frame' | 'no clock';

/**
 * Stand the page at the frame an input scheduled, once the input is
 * delivered. The page clock has held the app's frame callbacks since before
 * the dispatch, with the page's JS left running for the whole input; page
 * time stops first, so no timer fires between, then the page is paused, with
 * the first frame's callbacks queued and unrun. A page opened before the clock
 * was put in has no frames to hold, and is paused where it stands.
 */
export async function landFrameStop(session: BenchSession): Promise<FrameStopLanding> {
  await pauseClock(session);
  const dbg = session.debugger;
  if (dbg && !dbg.isPaused()) await dbg.pause().catch(() => {});
  return session.framesHeld ? 'frame' : 'no clock';
}

/** One frame, in ms of page time, at 60 frames a second. */
export const FRAME_MS = 1000 / 60;

/**
 * Move a held page on one frame: page time and the timers due in it, the
 * app's queued frame callbacks once, and the CSS animations by the same span,
 * so the page's JS and its compositor stay together.
 */
export async function frameStep(session: BenchSession, ms = FRAME_MS): Promise<{ now: number; ran: number; waiting: number } | undefined> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.frame(${Number(ms)})`), returnByValue: true,
  }, 3000).catch(() => ({ result: undefined }));
  await seekAnimations(session, ms);
  return result?.value;
}

/** Let the oldest crossing kept at the proxy through, and keep the rest held. */
export async function stepTraffic(connection: string): Promise<void> {
  if (isHeld(connection, 'network')) await step(connection, 'network');
}

/** Pause on every scheduled callback, which is what makes a step land on one. */
const STEP_EVENTS = ['setTimeout.callback', 'setInterval.callback', 'requestAnimationFrame.callback'];

async function ensureStepBreakpoints(session: BenchSession): Promise<void> {
  if (session.stepBreakpointsSet) return;
  await debuggerOf(session).setInstrumentationBreakpoints(STEP_EVENTS);
  session.stepBreakpointsSet = true;
}

/** Resolve on the page's next stop, as its debugger connection confirms it, or on timeout. */
function nextStop(dbg: PageDebugger, timeoutMs: number): Promise<any | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { stop(); resolve(null); }, timeoutMs);
    const stop = dbg.watchPause((paused, event) => {
      if (!paused) return;
      clearTimeout(timer);
      stop();
      resolve(event ?? {});
    });
  });
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
  const dbg = debuggerOf(session);
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
    // A stopped page clock holds the page's timers and its held frames, which
    // no resume would reach: the next of them runs on the stopped page, page
    // time moved on to it.
    const held = dbg.isPaused() ? await clockNext(session) : undefined;
    if (held) {
      steps++;
      elapsed += Math.max(0, held.now - before);
      const entry: CallbackEntry = {
        index: session.totalSteps + steps, at: Math.round(session.tickMs + elapsed), kind: held.kind,
        ...(held.fn ? { fn: held.fn } : {}),
      };
      ran.push(entry);
      session.callbacks.push(entry);
      if (session.callbacks.length > MAX_CALLBACK_LOG) session.callbacks.splice(0, session.callbacks.length - MAX_CALLBACK_LOG);
      continue;
    }
    const stopped = nextStop(dbg, stepTimeoutMs);
    // An armed pause needs no resume: the page is already running towards it,
    // and the next callback is what it will stop on.
    if (dbg.isPaused()) {
      await dbg.resume().catch((error) => {
        debugLog('bench', `step: resume failed: ${error}`);
      });
    }
    const event = await stopped;
    if (!event) {
      // Nothing was scheduled within the window - the page has gone quiet, so
      // there is nothing to step to. Hold again where it stands.
      quiet = true;
      await dbg.pause().catch(() => {});
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
