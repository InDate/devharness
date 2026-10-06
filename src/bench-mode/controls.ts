import { debugLog } from '../debug-logger.js';
import { hold, holdReading, isHeld, release, step, type HoldLayer, type HoldSource } from '../hold.js';
import type { SequenceState } from '../bench/wire.js';
import { setInspectMode } from './cdp.js';
import { announceHold, releaseHolds } from './page-hold.js';
import { getSequenceState, playSequence } from './sequence.js';
import { type BenchReport, type BenchSession, getBenchSession, sessions } from './session.js';

/**
 * Whether the bench holds a page a tool would drive, and how to let it go:
 * frozen, its JS stopped, so a click or a step waits on it until its timeout;
 * running a sequence, whose steps a second driver would interleave with; or
 * recording, which would take the tool's clicks for the person's. Nothing
 * for a page the bench holds in none of these ways, or a connection with no
 * bench; with no connection named, the first bench that holds its page.
 */
export function benchHold(connection?: string): { connection: string; why: string; release: string } | undefined {
  const held = connection !== undefined ? [[connection, sessions.get(connection)] as const] : [...sessions.entries()];
  for (const [name, session] of held) {
    if (!session) continue;
    if (session.recordingSequence) {
      return { connection: name, why: 'a recording is in progress, and it would record these actions as the person\'s', release: 'save or throw away the recording in the bench' };
    }
    if (session.sequenceBusy) {
      return { connection: name, why: 'the bench is running a sequence on it', release: 'let the run finish, or stop it in the bench' };
    }
    // Held traffic leaves the page drivable: a tool that drives it meets a
    // network that is slow or gone, which is what the hold stands for.
    const held = holdReading(name).held.filter(layer => !layer.via && layer.layer !== 'network' && HOLDING_SOURCES.has(layer.source));
    if (held.length) {
      return {
        connection: name,
        why: `its ${held.map(layer => layer.layer).join(' and ')} ${held.length > 1 ? 'are' : 'is'} held by the ${held[0].source}`,
        release: `bench({ action: 'release', connection: '${name}' }), or the hold button in the bench`,
      };
    }
  }
  return undefined;
}

/**
 * Hold every layer the connection has - code, screen, traffic - or let them
 * all run. Driving the app needs a running page - under a hold its JS is
 * stopped, so a click reaches nothing - and picking works either way, since
 * Chrome's picker is browser-side. A breakpoint's pause is left where it stopped.
 */
export async function setHeld(connection: string, frozen: boolean, source: HoldSource = 'bench'): Promise<BenchReport | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  if (frozen && source !== 'sequence' && runGoing(session)) {
    await haltSequence(connection);
    return getBenchSession(connection);
  }
  const before = holdReading(connection).held.map(held => held.layer);
  // The picker survives the transition either way, set before a hold for the
  // reason changeHold sets it there: Chrome's helper would be what the pause stops in.
  if (frozen) {
    await setInspectMode(session, session.pickerArmed).catch(() => {});
    await hold(connection, { source });
  } else {
    await releaseHolds(connection);
    await setInspectMode(session, session.pickerArmed).catch(() => {});
  }
  await announceHold(session, before, frozen, source);
  return getBenchSession(connection);
}

/** Holds a tool may not drive through: the person's, a paused sequence's, a trigger's. */
const HOLDING_SOURCES = new Set<HoldSource>(['bench', 'sequence', 'trigger']);

/**
 * Whether a run is driving the page. A hold pressed then halts the run first:
 * every step releases the hold for its duration and takes it again after, so
 * a run left going walks through the hold, and a hold landing inside a step
 * stops the page under the step's own queries until the step times out.
 */
function runGoing(session: BenchSession): boolean {
  return !!session.sequences && !session.recordingSequence && (session.sequencePlaying === true || session.sequenceBusy);
}

/**
 * Hold, release or step the named layers from the bench's hold panel, all of
 * them where none is named. A release here reaches every hold on those layers,
 * a breakpoint's included: the person asked for that layer to run.
 */
export async function changeHold(connection: string, action: 'hold' | 'release' | 'step', layers?: HoldLayer[]): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  // Holding the screen or the code stops the page under the run, so the run
  // pauses first. Holding only the traffic leaves the run driving a page whose
  // network is held, which is the condition being set up.
  if (action === 'hold' && runGoing(session) && (!layers || layers.some(layer => layer !== 'network'))) {
    await haltSequence(connection);
    return;
  }
  if (action === 'step') {
    for (const layer of layers ?? []) {
      if (isHeld(connection, layer)) await step(connection, layer);
    }
    return;
  }
  const before = holdReading(connection).held.map(held => held.layer);
  // The picker's mode is set before a hold and after a release: setting it
  // runs a helper of Chrome's in the page, and set after a hold on an idle
  // page, that helper is the first JS to run and the armed pause stops in it
  // rather than in the app.
  if (action === 'hold') {
    await setInspectMode(session, session.pickerArmed).catch(() => {});
    await hold(connection, { source: 'bench', ...(layers ? { layers } : {}) });
  } else {
    await release(connection, layers ? { layers } : {});
    await setInspectMode(session, session.pickerArmed).catch(() => {});
  }
  await announceHold(session, before, action === 'hold', 'bench');
  if (action === 'release') resumePausedRun(connection);
}

/**
 * Carry on a run paused by a hold once nothing holds the page any more. A
 * pause is a hold on every layer, so letting every layer run is letting the
 * run go on, as Play does. A layer still held - the traffic kept back while
 * the screen runs, a breakpoint's stop - leaves the run where it paused.
 * Started rather than awaited: a play lasts as long as its steps.
 */
export function resumePausedRun(connection: string): void {
  const session = sessions.get(connection);
  if (!session || session.sequencePlaying || session.sequenceBusy) return;
  // Paused by the bench, or by a tool's stepTo or pause point: a session
  // standing between steps with steps left, as the play bar reads it.
  const active = session.sequences?.active();
  const paused = session.sequencePaused || (!!active?.live && active.currentStep < active.total);
  if (!paused) return;
  if (holdReading(connection).held.some(held => held.layer !== 'network' || held.source === 'sequence')) return;
  void playSequence(connection).catch(error => debugLog('bench', `resuming the paused run failed: ${error}`));
}

/**
 * Open Chrome's built-in DevTools on the driven page, docked as F12 docks it,
 * so a code hold is read where the call stack, scopes and source live. A page
 * already paused reports that pause to DevTools as it attaches, so it opens on
 * Sources at the stopped line.
 *
 * `Target.openDevTools` is a browser-level CDP command. Measured on Chrome 154:
 * it opens the docked DevTools, where the frontend served on the debugging
 * port opened in a tab lost its socket, because that socket crossed the proxy.
 * Docked to the bottom by the profile's own DevTools setting, which the
 * launcher seeds.
 */
export async function openDevtools(connection: string): Promise<string> {
  const session = sessions.get(connection);
  if (!session) return 'no bench on this connection';
  const targetId = (session.page.target() as unknown as { _targetId?: string })._targetId;
  if (!targetId) return 'the page names no target to open DevTools on';
  const browserSession = await session.page.browser().target().createCDPSession();
  try {
    await browserSession.send('Target.openDevTools' as any, { targetId } as any);
    return 'DevTools opened on the page';
  } catch (error) {
    return `DevTools did not open: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await browserSession.detach().catch(() => {});
  }
}

export async function setPicker(connection: string, armed: boolean): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  await setInspectMode(session, armed);
}

/** Stop the run at the step it reached, leaving the sequence open there. */
export async function haltSequence(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  // Stopped where it stands, in the order these have to happen.
  //
  // The flag ends the loop once its step returns. That step is then abandoned
  // rather than waited on: the page is about to be held, a held page runs no
  // JS, and a step that cannot finish sits out the whole step timeout and
  // reports a failure nobody caused. The page is held last, so what was on
  // screen at the moment of the press is what stays there.
  session.sequenceHalt = true;
  session.sequenceFailure = undefined;
  // The step in flight is cut short by its own signal rather than waited on:
  // left alone it runs out its settle against a page about to be held, and
  // for those seconds the screen reports a run that has already stopped.
  session.driving?.abort();
  await session.sequences.halt().catch(() => {});
  await setHeld(connection, true, 'sequence');
  session.sequenceFailure = undefined;
  return getSequenceState(connection);
}
