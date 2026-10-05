import { debugLog } from '../debug-logger.js';
import { currentCursor } from '../proxy/registry.js';
import type { SequenceCard, SequenceState } from '../bench/wire.js';
import { appendRun } from '../run-log.js';
import { evaluateInPage, request, send, setInspectMode } from './cdp.js';
import { type SequenceDriver } from './driver.js';
import { letGoForRun, stoppedByDialog, withPageReleased } from './page-hold.js';
import { dialogMonitorOf, describeDialog } from '../dialog-monitor.js';
import type { BenchDialog } from '../bench/wire.js';
import { addRecordingTimer, attachStepTraffic, gateNewStep, recordedSteps } from './recording.js';
import { armSavedRules } from './rules.js';
import { type BenchSession, STEP_TIMEOUT_MS, sessions } from './session.js';
import { benchReadings, stepTimes, withTallies } from './tallies.js';

/** What the pane shows for the sequence card, whether or not one is running. */
export async function getSequenceState(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;

  const available = await session.sequences.listNames().catch(() => [] as string[]);
  const catalogue = await session.sequences.listCatalogue().catch(() => [] as SequenceCard[]);

  // A recording has no open run to read; its steps come from what has been
  // clicked so far, so the list fills as the person works.
  if (session.recordingSequence) {
    const steps = await recordedSteps(session);
    session.recordingStepTimes = steps.map(step => step.at);
    for (const step of steps) {
      const note = session.recordingNotes?.get(step.index);
      if (note?.comment) step.comment = note.comment;
      const findings = session.recordingAnnotations?.get(step.index);
      if (findings?.length) step.annotations = findings;
    }
    await attachStepTraffic(session, connection, steps);
    await gateNewStep(session, connection, steps);
    return {
      available,
      catalogue,
      steps,
      name: session.recordingName,
      ...(session.recordingPurpose?.description
        ? { description: session.recordingPurpose.description } : {}),
      ...(session.recordingPurpose?.expectedOutcome
        ? { expectedOutcome: session.recordingPurpose.expectedOutcome } : {}),
      ...(session.recordingWithAgent ? { withAgent: true } : {}),
      currentStep: steps.length,
      total: steps.length,
      busy: session.sequenceBusy, recording: true, variables: [],
      ...(session.recordingInto ? {
        into: {
          name: session.recordingInto.name,
          after: session.recordingInto.after,
          labels: session.sequences.labelsOf(session.recordingInto.name),
        },
      } : {}),
      ...(session.recordingStartedAt ? { recordingSince: session.recordingStartedAt } : {}),
      ...(session.pendingStep ? { pendingStep: session.pendingStep } : {}),
      ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
      ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    };
  }

  const active = session.sequences.active();
  const next = active?.steps[active.currentStep];
  const cursor = session.sequenceBusy ? currentCursor() : undefined;
  const opener = active?.steps[cursor?.kind === 'replay' ? cursor.step : Math.max(0, (active?.currentStep ?? 0) - 1)];
  const dialog = await benchDialogOf(session,
    typeof opener?.params?.selector === 'string' ? { selector: opener.params.selector } : undefined,
    next?.tool === 'modal' && next.params?.action === 'answer' ? active!.currentStep : undefined);
  if (!active) {
    return {
      available,
    catalogue, steps: [], currentStep: 0, total: 0, busy: session.sequenceBusy, variables: [],
      ...(dialog ? { dialog } : {}),
      ...(session.recordingSequence ? { recording: true } : {}),
      ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
      // A failure with nothing selected still belongs on the pane's failure
      // line - a delete that matched no name reports here and nowhere else.
      ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    };
  }

  // The steps changed under the bench - a step put in, taken out or moved,
  // here or by an edit elsewhere - so what it armed by step number is armed
  // again from the file, which the change renumbered.
  const shape = `${active.name}\u0000${active.steps.map(step => step.label).join('\u0000')}`;
  if (session.armedShape !== undefined && session.armedShape !== shape && !session.sequenceBusy) {
    session.armedShape = shape;
    await armSavedRules(connection);
  }
  session.armedShape = shape;

  const issue = await session.sequences.issue().catch(() => undefined);

  // A run ended outside the bench, by a tool's finish or step, leaves nothing to carry on from.
  if (session.sequencePaused && !active.live && !session.sequencePlaying) session.sequencePaused = false;

  return {
    available,
    catalogue,
    ...(issue ? { issue } : {}),
    ...(dialog ? { dialog } : {}),
    name: active.name,
    ...(active.description ? { description: active.description } : {}),
    ...(active.expectedOutcome ? { expectedOutcome: active.expectedOutcome } : {}),
    currentStep: active.currentStep,
    total: active.total,
    // A play drives each step as a drive of its own, and sequenceBusy clears
    // at the end of each one; the play flag holds busy across the gaps.
    busy: session.sequenceBusy || !!session.sequencePlaying,
    ...(() => {
      const cursor = session.sequenceBusy ? currentCursor() : undefined;
      return cursor?.kind === 'replay'
        ? { runningAt: { step: cursor.step, ...(cursor.within ? { within: cursor.within } : {}) } }
        : {};
    })(),
    ...(session.sequencePlaying ? { playing: true } : {}),
    ...(session.sequencePaused ? { paused: true } : {}),
    ...(active.heldAt ? { heldAt: active.heldAt } : {}),
    ...(active.repair ? { repair: active.repair } : {}),
    ...(session.recordingSequence ? { recording: true } : {}),
    variables: active.variables,
    ...(active.placements ? { placements: active.placements } : {}),
    ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
    ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    steps: active.steps.map((step, index) => ({
      index,
      label: step.label,
      ...(step.comment ? { comment: step.comment } : {}),
      ...(step.resolved ? { resolved: step.resolved } : {}),
      ...(step.captures ? { captures: step.captures } : {}),
      ...(step.stores !== undefined ? { stores: step.stores } : {}),
      ...(step.reads?.length ? { reads: step.reads } : {}),
      ...(step.tool ? { tool: step.tool, params: step.params ?? {} } : {}),
      // Dropping these here is invisible at the write - the note reaches the
      // file and the event stream all the same - and leaves the pane showing
      // nothing under the step it was just filed against. The same held for
      // traffic: written to the file, whitelisted out on the way back.
      ...(step.annotations?.length ? { annotations: step.annotations } : {}),
      ...(step.traffic ? { traffic: step.traffic } : {}),
      ...(step.expected ? { expected: step.expected } : {}),
      ...(step.addedAt !== undefined ? { addedAt: step.addedAt } : {}),
      done: index < active.currentStep,
      current: index === active.currentStep,
      ...(active.failedStep === index ? { failed: true } : {}),
    })),
  };
}

/**
 * A step's own time: the time it runs with no browser dialog over the page.
 * A run that waits on a person answering a dialog is not a step overrunning,
 * so the bounds on a step count only the time outside one.
 */
function stepClock(session: BenchSession): { past(ms: number): Promise<void>; stop(): void } {
  let spent = 0;
  let last = Date.now();
  const waiters: Array<{ ms: number; resolve: () => void }> = [];
  const timer = setInterval(() => {
    const now = Date.now();
    if (!dialogMonitorOf(session.page)?.current()) spent += now - last;
    last = now;
    for (const waiter of waiters.filter(w => spent >= w.ms)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }, 250);
  return {
    past: (ms: number) => new Promise<void>(resolve => { waiters.push({ ms, resolve }); }),
    stop: () => clearInterval(timer),
  };
}

/** The words on the element a step clicks, read once per selector, for naming it to the person. */
const labels = new WeakMap<BenchSession, { selector: string; label: string }>();

async function labelOf(session: BenchSession, selector: string): Promise<string> {
  const known = labels.get(session);
  if (known?.selector === selector) return known.label;
  const label = String(await evaluateInPage(session, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    return element ? (element.innerText || element.getAttribute('aria-label') || element.value || '').trim().slice(0, 60) : '';
  })()`).catch(() => '') ?? '');
  labels.set(session, { selector, label });
  return label;
}

/**
 * The browser dialog over the session's page, as one line for the pane: what
 * the person does, or what the sequence does for them. `stepAt` is the step
 * that opened it, and `answeredByStep` the next step when that is the
 * sequence's own answer.
 */
async function benchDialogOf(
  session: BenchSession,
  stepAt: { selector?: string } | undefined,
  answeredByStep: number | undefined,
): Promise<BenchDialog | undefined> {
  const monitor = dialogMonitorOf(session.page);
  const dialog = monitor?.current();
  if (!dialog && monitor?.awaitingGesture()) {
    const label = stepAt?.selector ? await labelOf(session, stepAt.selector) : '';
    return {
      kind: 'action',
      text: label ? `Click \u201c${label}\u201d in the app.` : 'Open the file picker from the app.',
      why: 'Chrome opens a file picker only in the focused tab, so this one waits on your own click there.',
      answers: [],
    };
  }
  if (!dialog) return undefined;
  if (answeredByStep !== undefined) {
    return { kind: 'info', text: `Step ${answeredByStep + 1} answers ${describeDialog(dialog)}.`, answers: [] };
  }
  if (dialog.kind === 'javascript') {
    return {
      kind: 'action',
      text: dialog.type === 'beforeunload' ? 'The app asks to leave this page.' : `The app asks: \u201c${dialog.message}\u201d`,
      answers: dialog.type === 'alert' ? ['accept'] : ['accept', 'cancel'],
    };
  }
  return dialog.intercepted
    ? { kind: 'action', text: 'A file picker is held with no window.', why: 'devharness opened it for a step; Cancel closes it unfilled.', answers: ['cancel'] }
    : { kind: 'action', text: 'Choose a file in the picker the app opened.', answers: [] };
}

/**
 * Close the dialog over the session's page from the bench: OK or Cancel for a
 * JavaScript dialog, Cancel for a picker a step holds.
 */
export async function answerBenchDialog(connection: string, accept: boolean): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  const monitor = session ? dialogMonitorOf(session.page) : undefined;
  const dialog = monitor?.current();
  if (monitor && dialog?.kind === 'javascript') await monitor.answerDialog(accept);
  else if (monitor && dialog?.kind === 'fileChooser' && dialog.intercepted && dialog.backendNodeId !== undefined && !accept) {
    await monitor.cancelChooser(dialog.backendNodeId);
  }
  return getSequenceState(connection);
}

/**
 * Run `drive` with the app's tab in front, then put the bench back.
 *
 * Chrome delivers no synthesised mouse input to a hidden tab, so a step's
 * click on an app tab behind the bench landed nowhere while the step read as
 * done. Counted, so a play wrapping many steps switches tabs once rather than
 * once per step; a tab already visible - beside the bench in split view - is
 * left alone.
 */
async function withAppInFront<T>(session: BenchSession, drive: () => Promise<T>): Promise<T> {
  if ((session.appInFront ?? 0) > 0) {
    session.appInFront = (session.appInFront ?? 0) + 1;
    try { return await drive(); } finally { session.appInFront = (session.appInFront ?? 1) - 1; }
  }
  session.appInFront = 1;
  // Raised on every play, hidden or not: the bench has a window of its own,
  // and the app's window behind it keeps rendering and reads visible while
  // the person watching the play sees only the bench.
  await session.page.bringToFront().catch(() => {});
  try {
    return await drive();
  } finally {
    session.appInFront = 0;
    // The bench comes back in front when the play ends, where its results are.
    await session.benchPage?.bringToFront().catch(() => {});
  }
}

/**
 * Run part of a sequence against a held page.
 *
 * The page has to be running for a step to land at all - input is discarded
 * while V8 is stopped - so each step releases, drives, and holds again. The
 * gap measured about 6ms against a state that lasts 600ms, which is what makes
 * this worth doing by hand: the hold is issued by the runner rather than by
 * someone noticing a state and reaching for a button.
 */
async function driveSequence(
  connection: string,
  drive: (driver: SequenceDriver, signal: AbortSignal) => Promise<string | undefined>
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences || session.sequenceBusy) return getSequenceState(connection);

  session.sequenceBusy = true;
  session.sequencePaused = false;
  session.sequenceFailure = undefined;
  // One per drive: aborting it stops the step in flight, and the next drive
  // starts under a fresh one rather than a signal already spent.
  const driving = new AbortController();
  session.driving = driving;
  const wasArmed = session.pickerArmed;
  // Last resort. Every call below is bounded, but a latched busy flag turns the
  // whole pane into a no-op with nothing on screen to say why, so it is cleared
  // on a timer as well as in the finally.
  const clock = stepClock(session);
  void clock.past(STEP_TIMEOUT_MS + 15000).then(() => { session.sequenceBusy = false; });

  try {
    // The picker would swallow the step's own click. Disarmed whatever the
    // flag says: Chrome's inspect mode outlives a pick, and a flag that read
    // off while it was on let every replayed click land as a pick.
    if (!stoppedByDialog(session)) await setInspectMode(session, false);
    session.sequenceFailure = await withAppInFront(session, () => withPageReleased(session, async () => {
      // Let the page paint before driving it: a step following a navigate can
      // otherwise look for an element the framework has not rendered yet.
      // Bounded, because rAF never fires on a page that is still held.
      if (!stoppedByDialog(session)) await Promise.race([
        send(session.client, 'Runtime.evaluate', {
          expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          awaitPromise: true,
        }, 600),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
      // The one unbounded await in this path. A replay step that never settles
      // leaves the release scope suspended before its `finally`, so the page
      // stays held and sequenceBusy stays latched - which is what wedges the
      // pane with nothing on screen to say why.
      return Promise.race([
        drive(session.sequences!, driving.signal),
        clock.past(STEP_TIMEOUT_MS).then(() => 'the step did not finish in time'),
      ]);
    }));
  } catch (error) {
    debugLog('bench', `sequence step failed: ${error}`);
  } finally {
    clock.stop();
    // A step stopped by hand reports itself aborted, and that text would
    // otherwise stand as a failure line over a pause somebody chose.
    if (driving.signal.aborted) session.sequenceFailure = undefined;
    if (wasArmed) await setInspectMode(session, true).catch(() => {});
    session.sequenceBusy = false;
    // Only while it is in flight: a spent controller left here would be the
    // one a later halt aborts, and that halt would stop nothing.
    if (session.driving === driving) session.driving = undefined;
  }
  return getSequenceState(connection);
}

/**
 * Opening the session runs no steps, but replay still touches the page to set
 * itself up - it injects a replay cursor - and every replay call is refused
 * while the page is held, since the guard sees a connection paused at a
 * breakpoint. So selecting goes through the same release as a step.
 */
export const selectSequence = async (connection: string, name: string) => {
  const state = await driveSequence(connection, (driver) => driver.start(name, connection));
  const session = sessions.get(connection);
  if (session) session.armedShape = undefined;
  await armSavedRules(connection);
  return state;
};

/** Clear the failure line, which otherwise stands until something else fails. */
/**
 * Repair the step the run stands on after it reached another element, and
 * clear the failure line that reported it. The run stays on the step, so the
 * next step or play runs the repaired step first.
 */
export async function repairSequenceStep(connection: string, accept: 'selector' | 'element'): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  const failure = await session.sequences.repair(accept);
  session.sequenceFailure = failure;
  return getSequenceState(connection);
}

export async function dismissSequenceFailure(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  session.sequenceFailure = undefined;
  return getSequenceState(connection);
}

/** Point the run at another deployment - another port, another host. */
export async function setSequenceBaseUrl(connection: string, baseUrl: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequences.setBaseUrl(baseUrl.trim());
  // Another host is another site, with its own site rules.
  await armSavedRules(connection);
  return getSequenceState(connection);
}

export const stepSequence = (connection: string) =>
  driveSequence(connection, (driver, signal) => driver.step(signal));

/**
 * Put the run back at a step, so an annotation taken there can be seen again.
 *
 * An annotation records the step it was taken at, but a step number is only
 * useful if you can return to it - the state it described is gone otherwise.
 * Getting back means running the sequence from the start to that point, which
 * is the only thing that reconstructs the state a step produced.
 */
export const gotoSequenceStep = (connection: string, step: number) =>
  driveSequence(connection, (driver) => driver.goto(step));

/** State what the open sequence is for and what it should do. */
export async function describeSequence(
  connection: string,
  description: string,
  expectedOutcome: string
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  // While recording there is no file to write onto yet, so this is held until
  // the recording stops. Writing straight through would answer "no sequence is
  // open" and lose what was typed before the first click.
  if (session.recordingSequence) {
    session.recordingPurpose = { description, expectedOutcome };
    return getSequenceState(connection);
  }
  session.sequenceFailure = await session.sequences
    .describe(description, expectedOutcome)
    .catch(error => String(error));
  return getSequenceState(connection);
}

/** Say why one step is here. */
export async function commentSequenceStep(
  connection: string,
  index: number,
  words: string
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  if (session.recordingSequence) {
    holdRecordingNote(session, index, words.trim());
    return getSequenceState(connection);
  }
  session.sequenceFailure = await session.sequences
    .commentStep(index, words)
    .catch(error => String(error));
  return getSequenceState(connection);
}

/**
 * Keep one step's note against its position until the recording lands.
 *
 * The steps are a projection of the captured events, rebuilt on every poll, so
 * a comment written onto one is discarded at the next tick without this.
 */
function holdRecordingNote(session: BenchSession, index: number, comment: string): void {
  const notes = session.recordingNotes ?? new Map();
  session.recordingNotes = notes;
  if (comment) notes.set(index, { comment });
  else notes.delete(index);
}

/**
 * Play by stepping, not by handing the whole run over at once.
 *
 * A straight `finish` runs every step inside one release window, and anything
 * that re-holds the page mid-run - a navigation, a pause landing late - takes
 * the rest of the run with it. Stepping gives each action its own release and
 * its own settle, which is the path that demonstrably works.
 */
/**
 * `throughHolds` carries a play past a breakpoint the sequence did not set, for
 * a pass that runs unattended: the next step resumes the page.
 */
export async function playSequence(connection: string, options: { throughHolds?: boolean } = {}): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;

  session.sequenceHalt = false;
  session.sequencePaused = false;
  await letGoForRun(session);
  session.sequencePlaying = true;
  const startedAt = session.playStartedAt = Date.now();
  session.playStepStarts = [];
  let state = await getSequenceState(connection);
  const total = state?.total ?? 0;

  // The app stays in front for the whole run, so the tabs switch once. The
  // play flag holds `busy` across the gaps between steps, so it clears in a
  // finally: left set by a throw, it would bar every control until a restart.
  try {
    await withAppInFront(session, async () => {
      // Bounded by the step count: a step that fails ends the run, and one that
      // does not advance would otherwise loop forever.
      for (let guard = 0; guard <= total; guard++) {
        const before = state?.currentStep ?? 0;
        (session.playStepStarts ??= [])[before] = Date.now();
        state = await stepSequence(connection);
        // Asked for part-way through: the step in flight is allowed to finish, so
        // the run stops on a step rather than inside one.
        if (session.sequenceHalt) {
          session.sequenceHalt = false;
          session.sequencePaused = true;
          // Interrupted, not failed: the step stopped because someone asked, and
          // a failure line here puts a red box in front of what they chose.
          session.sequenceFailure = undefined;
          state = await getSequenceState(connection);
          break;
        }
        if (!state || state.failure) break;
        if (state.heldAt && !options.throughHolds) {
          session.sequencePaused = true;
          break;
        }
        if (state.currentStep >= state.total) break;
        if (state.currentStep === before) break;
      }
    });
  } finally {
    session.sequencePlaying = false;
  }
  const playEnded = Date.now();
  const ended = await getSequenceState(connection);
  if (ended?.name) {
    const reached = ended.currentStep >= ended.total;
    void appendRun({
      sequence: ended.name, connection, via: 'bench',
      status: ended.failure ? 'failed' : reached ? 'completed' : 'stopped',
      startedAt, endedAt: Date.now(),
      step: ended.failure ? ended.currentStep + 1 : ended.currentStep, total: ended.total,
      ...(ended.failure ? { failure: ended.failure } : {}),
      ...withTallies(connection, startedAt, ended.total, benchReadings(ended), stepTimes(session.playStepStarts ?? [], playEnded)),
    });
  }
  return ended;
}

/**
 * Erase a step from the open sequence.
 *
 * A recording captures what was clicked, which includes what was clicked by
 * mistake; without this the only way to remove one is to record again.
 */
export async function removeSequenceStep(connection: string, index: number): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences.removeStep(index).catch(error => String(error));
  if (!session.sequenceFailure) await armSavedRules(connection);
  return getSequenceState(connection);
}

/** Replace what a step is given, as edited in the bench. */
export async function editSequenceStep(connection: string, index: number, params: unknown): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    session.sequenceFailure = `step ${index + 1}: what a step is given has to be a JSON object`;
    return getSequenceState(connection);
  }
  // A recording has no file yet: the change is held against the step and
  // written when the recording is saved.
  if (session.recordingSequence) {
    (session.recordingEdits ??= new Map()).set(index, params as Record<string, unknown>);
    session.sequenceFailure = undefined;
    return getSequenceState(connection);
  }
  session.sequenceFailure = await session.sequences.editStep(index, params as Record<string, unknown>).catch(error => String(error));
  return getSequenceState(connection);
}

/**
 * Put a check after a step of a saved sequence: what crossed under the step,
 * turned into a condition the run has to meet there.
 */
export async function insertSequenceCheck(connection: string, after: number, params: Record<string, unknown>, comment?: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences || session.recordingSequence) return undefined;
  session.sequenceFailure = await session.sequences.insertCheck(after, params, comment).catch(error => String(error));
  if (!session.sequenceFailure) await armSavedRules(connection);
  return getSequenceState(connection);
}

/**
 * Put a fixed pause after a step: into the file for a saved sequence, and
 * for one being recorded, after its latest action, which is the only place a
 * recording can take one.
 */
export async function insertSequenceTimer(connection: string, after: number, ms: number): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences || !(ms > 0)) return undefined;
  if (session.recordingSequence) await addRecordingTimer(connection, ms);
  else {
    session.sequenceFailure = await session.sequences.insertTimer(after, ms).catch(error => String(error));
    if (!session.sequenceFailure) await armSavedRules(connection);
  }
  return getSequenceState(connection);
}

/**
 * Move a step, or a run of steps selected together, to another position in
 * the open sequence.
 *
 * The file's waits, names and uses are renumbered by the move; the copies armed
 * in memory still carry the old step numbers, and the next rules write would
 * put those back, so they are read again from the file.
 */
export async function moveSequenceStep(
  connection: string,
  from: number,
  to: number,
  count = 1,
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences.moveStep(from, to, count).catch(error => String(error));
  if (!session.sequenceFailure) await armSavedRules(connection);
  return getSequenceState(connection);
}

/** Define or update a variable the open sequence carries. */
export async function setSequenceVariable(
  connection: string,
  name: string,
  value: string
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences.setVariable(name, value).catch(error => String(error));
  return getSequenceState(connection);
}

/** Remove a variable the open sequence defines. */
export async function removeSequenceVariable(connection: string, name: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences.removeVariable(name).catch(error => String(error));
  return getSequenceState(connection);
}

export async function cancelSequence(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  await session.sequences.cancel().catch(() => {});
  session.sequenceFailure = undefined;
  await armSavedRules(connection);
  return getSequenceState(connection);
}

/** Erase a saved sequence. The failure text reaches the pane's failure line. */
export async function removeSequence(connection: string, name: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  const failure = await session.sequences.remove(name).catch(error => String(error));
  session.sequenceFailure = failure;
  return getSequenceState(connection);
}
