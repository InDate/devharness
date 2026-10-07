import { appendEvent } from '../session-events.js';
import { getMessage } from '../messages.js';
import type { Annotation, StepTraffic } from '../annotation.js';
import type { SequenceState, SequenceStep } from '../bench/wire.js';
import { evaluateInPage, setInspectMode } from './cdp.js';
import { holdUi, releaseUi, withPageReleased } from './page-hold.js';
import { armSiteRules, originOf, persistRules } from './rules.js';
import { getSequenceState, selectSequence } from './sequence.js';
import { type BenchSession, CANCELLED, sessions } from './session.js';
import { withWrites } from './traffic.js';

/** The steps the recording in progress has captured so far. */
export async function recordedSteps(session: BenchSession) {
  return session.sequences!.recordedSoFar(
    await readCapturedEvents(session),
    // Recorded into a sequence mid-run: the page is already where its steps
    // left it, so the recording opens nothing of its own.
    session.recordingInto ? '' : session.recordingStartUrl ?? session.page.url(),
    session.recordingEdits,
  );
}

/**
 * Record what is clicked in the page into a new sequence.
 *
 * The page runs and the picker is disarmed for the length of the recording: a
 * held page discards input, and an armed picker turns every click into a pick
 * instead of an action. Both are restored when it ends.
 */
export async function recordSequence(
  connection: string,
  name: string,
  withAgent = false,
  /** Where the recording opens. Empty leaves the page where it stands. */
  startUrl = '',
  /** Record into this sequence, after this step, rather than as a sequence of its own. */
  into?: { name: string; after: number },
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  if (session.sequenceBusy) return getSequenceState(connection);

  session.sequenceBusy = true;
  session.sequencePaused = false;
  session.sequenceFailure = undefined;
  const wasArmed = session.pickerArmed;
  let cancelled = false;
  if (withAgent) {
    await appendEvent(session.session, 'sequence', {
      connection,
      sequence: name,
      recording: 'started',
      review: getMessage('RECORDING_BRIEF'),
      detail: `recording "${name}" - the person is clicking through the app now`,
    });
  }

  try {
    await setInspectMode(session, false);
    // Nothing carried over from a previous recording: the page keeps its buffer
    // across runs, and a stale event would land as this recording's first step.
    await evaluateInPage(session, 'globalThis.__cdpRecordingEvents = []').catch(() => {});
    // Driven there before the first step, so the recording opens on the page
    // it is about rather than on whatever happened to be up - and the step
    // that navigates is not itself recorded as one of the run's own.
    if (startUrl && startUrl !== session.page.url()) {
      await session.page.goto(startUrl, { waitUntil: 'load' }).catch(() => {});
    }
    session.recordingStartUrl = startUrl || session.page.url();
    session.recordingInto = into;
    // A new sequence answers with the site's rules and nothing else: the open
    // sequence's own are its decisions, not this one's.
    await armSiteRules(connection, originOf(session.recordingStartUrl) ?? session.sequences.siteOf(), new Map(), new Map());
    session.recordingStartedAt = Date.now();
    session.recordingEndedAt = undefined;
    session.recordedName = undefined;
    session.stepTraffic = new Map();
    session.recordingNotes = new Map();
    session.recordingEdits = new Map();
    session.recordingAnnotations = new Map();
    session.recordingSequence = true;
    session.recordingName = name;
    session.recordingWithAgent = withAgent;
    session.announcedSteps = 0;
    session.pendingStep = null;
    session.keptEvents = 0;
    const outcome = await withPageReleased(
      session,
      () => session.sequences!.record(name, connection, session.recordingStartUrl ?? '')
    );
    // Abandoning a recording is a choice, not a failure: reporting it on the
    // failure line puts a red box in front of someone who did what they meant.
    cancelled = outcome === CANCELLED;
    session.sequenceFailure = cancelled ? undefined : outcome;
  } catch (error) {
    session.sequenceFailure = String(error);
  } finally {
    session.recordingSequence = false;
    session.recordingEndedAt = Date.now();
    session.recordedName = cancelled ? undefined : name;
    session.recordingWithAgent = false;
    session.pendingStep = null;
    if (wasArmed) await setInspectMode(session, true).catch(() => {});
    session.sequenceBusy = false;
  }

  if (!cancelled) await flushRecordingNotes(session);
  // Rules made while recording were held on the session, since the sequence
  // had no file; it has one now, and is the one selected.
  if (!cancelled) await persistRules(connection);
  if (!cancelled) await persistStepTraffic(session, connection);
  // Steps changed while recording were held against their positions; the
  // file exists now, so they are written into it.
  if (!cancelled) {
    for (const [index, params] of session.recordingEdits ?? []) {
      const failure = await session.sequences.editStep(index, params).catch(error => String(error));
      if (failure) session.sequenceFailure = failure;
    }
  }
  session.recordingEdits = undefined;
  if (withAgent) await announceRecording(session, connection, name, cancelled);
  // Recorded into another sequence: its steps go there, after the step the
  // run stood on, and that sequence is the one open again.
  session.recordingInto = undefined;
  if (into) {
    if (!cancelled) {
      const failure = await session.sequences.spliceRecording(name, into.name, into.after).catch(error => String(error));
      if (failure) session.sequenceFailure = failure;
    }
    await selectSequence(connection, into.name);
  }
  return getSequenceState(connection);
}

/**
 * Write what was said during the recording onto the sequence it produced.
 *
 * It runs here rather than at the stop route because the stop route only
 * resolves the recorder: the file is written, and the driver's selection moved
 * onto it, by the record call returning. A write sent at the stop lands on
 * whichever sequence was open before, or on nothing.
 */
async function flushRecordingNotes(session: BenchSession): Promise<void> {
  const purpose = session.recordingPurpose;
  const notes = session.recordingNotes;
  const findings = session.recordingAnnotations;
  session.recordingPurpose = undefined;
  session.recordingNotes = undefined;
  session.recordingAnnotations = undefined;
  session.recordingName = undefined;
  if (!session.sequences) return;

  const failures: string[] = [];
  if (purpose && (purpose.description || purpose.expectedOutcome)) {
    const failure = await session.sequences
      .describe(purpose.description, purpose.expectedOutcome)
      .catch(error => String(error));
    if (failure) failures.push(failure);
  }
  for (const [index, note] of [...(notes ?? new Map())].sort((a, b) => a[0] - b[0])) {
    if (note.comment) {
      const failure = await session.sequences
        .commentStep(index, note.comment)
        .catch(error => String(error));
      if (failure) failures.push(failure);
    }
  }
  for (const [index, held] of [...(findings ?? new Map<number, Annotation[]>())].sort((a, b) => a[0] - b[0])) {
    for (const annotation of held) {
      const failure = await session.sequences.attachAnnotation(index, annotation)
        .catch(error => String(error));
      if (failure) failures.push(failure);
    }
  }
  // Surfaced rather than swallowed: these are words someone typed, and a note
  // that never reached the file leaves the sequence reading as though nobody
  // explained it.
  if (failures.length) session.sequenceFailure = failures[0];
}

/** Whether a step produced anything worth showing under it. */
function hasEvidence(traffic: StepTraffic): boolean {
  return traffic.requests > 0 || traffic.writes > 0 || traffic.opened > 0;
}

/**
 * Close the last step's window and write every step's traffic to the file.
 *
 * The newest step's window stays open while the recording runs, since its
 * effects are still arriving; the recording ending is what closes it.
 */
async function persistStepTraffic(session: BenchSession, connection: string): Promise<void> {
  const held = session.stepTraffic;
  if (!session.sequences || !held) return;

  const steps = session.sequences.active()?.steps ?? [];
  const last = steps.length - 1;
  if (last >= 0 && !held.has(last) && session.lastStepAt !== undefined) {
    const to = Date.now();
    const traffic = await session.sequences.trafficIn(connection, session.lastStepAt, to)
      .catch(() => undefined);
    if (traffic) held.set(last, withWrites(session, traffic, session.lastStepAt, to));
  }

  const entries = [...held.entries()]
    .filter(([, traffic]) => hasEvidence(traffic))
    .map(([index, traffic]) => ({ index, traffic }));
  if (entries.length === 0) return;
  session.sequenceFailure = await session.sequences.saveStepTraffic(entries)
    .catch(error => String(error));
}

/**
 * Give each step what crossed the boundary while it was being taken.
 *
 * A step's window opens when the step before it was observed and closes when it
 * was, and a request is windowed on when it started, so the requests a click
 * issues fall inside the window that closes on the step that click produced.
 * The poll is 250ms, which is coarser than the gap between a click and its
 * first request and finer than the gap between two clicks.
 *
 * One step is computed per poll and the result is held: recomputing every step
 * four times a second would put the whole recording's traffic through the
 * network tool continuously.
 */
export async function attachStepTraffic(
  session: BenchSession,
  connection: string,
  steps: SequenceStep[]
): Promise<void> {
  if (!session.sequences) return;
  const held = session.stepTraffic ??= new Map();

  for (let index = 0; index < steps.length; index++) {
    const cached = held.get(index);
    if (cached) {
      if (hasEvidence(cached)) steps[index].traffic = cached;
      continue;
    }
    // Only a window that has closed is computed. The newest step's effects are
    // still arriving - a socket it opened delivers its first frame half a
    // second later - so it fills in when the next action bounds it.
    const from = steps[index].at;
    const to = steps[index + 1]?.at;
    if (from !== undefined && to === undefined) session.lastStepAt = from;
    if (from === undefined || to === undefined) continue;

    const traffic = withWrites(session, await session.sequences.trafficIn(connection, from, to)
      .catch(() => ({ requests: 0, failed: 0, opened: 0, writes: 0, lines: [] as string[] })), from, to);
    held.set(index, traffic);
    if (hasEvidence(traffic)) steps[index].traffic = traffic;
    return;
  }
}

/**
 * Hold each new action until it is kept or dropped.
 *
 * Capture is paused the moment a step appears, so the next click is not taken
 * while the last one is still unanswered - a step judged after three more have
 * landed cannot be removed without taking those with it. One step is in
 * question at a time, and the page records nothing until it is settled.
 */
export async function gateNewStep(
  session: BenchSession,
  connection: string,
  steps: SequenceStep[]
): Promise<void> {
  if (!session.recordingWithAgent || session.pendingStep) return;
  const sent = session.announcedSteps ?? 0;
  if (steps.length <= sent) return;

  const index = steps.length - 1;

  // The opening navigate is this code's own doing, not something the person
  // did, so holding it asks them to answer for a step they never took.
  if (index === 0 && steps[index].label.startsWith('navigate.goto')) {
    session.announcedSteps = 1;
    session.keptEvents = await capturedEventCount(session);
    return;
  }

  session.pendingStep = { index, label: steps[index].label, verdict: 'validating' };
  await setCapturePaused(session, true);
  // The page is held as well as the capture: left running, it re-renders while
  // the step is read, and the element the step names moves underneath it.
  session.heldForStep = !session.frozen;
  if (session.heldForStep) await holdUi(session);

  await appendEvent(session.session, 'sequence', {
    connection,
    recording: 'step',
    step: index + 1,
    label: steps[index].label,
    review: getMessage('RECORDING_STEP_HELD'),
    detail: `step ${index + 1} held for review: ${steps[index].label}`,
  });
}

/** Stop or resume the page's own capture, which the recorder checks per event. */
async function setCapturePaused(session: BenchSession, paused: boolean): Promise<void> {
  await evaluateInPage(session, `globalThis.__cdpRecordingPaused = ${paused ? 'true' : 'false'}`)
    .catch(() => {});
}

/**
 * Put a fixed pause into the recording, after the last action: it lands in
 * the page's buffer with the clicks, so it takes its place in their order and
 * becomes a timed `check` step (`afterMs`) when the recording is saved.
 */
export async function addRecordingTimer(connection: string, ms: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.recordingSequence || !(ms > 0)) return;
  await evaluateInPage(session,
    `(globalThis.__cdpRecordingEvents ||= []).push({ type: 'timer', ms: ${Math.round(ms)}, timestamp: Date.now() })`)
    .catch(() => {});
}

/** Store a named value into the recording, after the last action; see VariableEvent. */
export async function addRecordingVariable(connection: string, name: string, value: string, byOrigin?: Record<string, string>): Promise<string | undefined> {
  const session = sessions.get(connection);
  if (!session?.recordingSequence) return 'nothing is recording';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a usable variable name`;
  const event = { type: 'variable', name, value, ...(byOrigin && Object.keys(byOrigin).length ? { byOrigin } : {}) };
  await evaluateInPage(session,
    `(globalThis.__cdpRecordingEvents ||= []).push(Object.assign(${JSON.stringify(event)}, { timestamp: Date.now() }))`)
    .catch(() => {});
  return undefined;
}

/**
 * Change or drop a variable the recording stores: every stored value of that
 * name in the page's buffer takes the new value, or goes. Nothing else in the
 * buffer moves, so the steps around it keep their places.
 */
export async function editRecordingVariable(connection: string, name: string, value: string | null): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.recordingSequence) return;
  const match = `(event) => event && event.type === 'variable' && event.name === ${JSON.stringify(name)}`;
  await evaluateInPage(session, value === null
    ? `globalThis.__cdpRecordingEvents = (globalThis.__cdpRecordingEvents || []).filter(event => !(${match})(event))`
    : `(globalThis.__cdpRecordingEvents || []).filter(${match}).forEach(event => { event.value = ${JSON.stringify(value)}; })`)
    .catch(() => {});
}

/** The raw events the page has buffered, as JSON. */
async function readCapturedEvents(session: BenchSession): Promise<string> {
  return (await evaluateInPage(session, 'JSON.stringify(globalThis.__cdpRecordingEvents || [])')
    .catch(() => '[]')) ?? '[]';
}

/** How many raw events the page holds, which a drop rewinds to. */
async function capturedEventCount(session: BenchSession): Promise<number> {
  return (await evaluateInPage(session, '(globalThis.__cdpRecordingEvents || []).length')
    .catch(() => 0)) ?? 0;
}

/**
 * Raise something about the held step, which is what puts the choice in front
 * of the person. Until this the pane says only that validation is running, so
 * a step that reads correctly costs them nothing.
 */
export async function flagRecordedStep(
  connection: string,
  reason: string,
  options?: Array<{ selector: string; note: string }>,
  detail?: string
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.pendingStep) return getSequenceState(connection);
  session.pendingStep = { ...session.pendingStep, verdict: 'flagged', reason, detail, options };
  return getSequenceState(connection);
}

/**
 * Take one of the offered selectors for the held step.
 *
 * The step is rebuilt from the page's raw events on every poll, so the choice
 * is written onto the event that produced it - written onto the step alone, the
 * next poll would overwrite it.
 */
export async function chooseStepSelector(connection: string, index: number): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  const option = session?.pendingStep?.options?.[index];
  if (!session || !option) return getSequenceState(connection);

  await evaluateInPage(session, `(() => {
    const events = globalThis.__cdpRecordingEvents || [];
    const last = events[events.length - 1];
    if (last) last.elementInfo = Object.assign({}, last.elementInfo || {}, { selector: ${JSON.stringify(option.selector)} });
  })()`).catch(() => {});

  return keepRecordedStep(connection, `selector set to ${option.selector}`);
}

/** Accept the held step and let capture continue. */
export async function keepRecordedStep(
  connection: string,
  settledAs?: string
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.pendingStep) return getSequenceState(connection);
  const held = session.pendingStep;
  session.announcedSteps = held.index + 1;
  session.keptEvents = await capturedEventCount(session);
  session.pendingStep = null;
  await releaseForStep(session);
  await setCapturePaused(session, false);
  await announceSettled(session, connection, held.index, settledAs ?? `kept as ${held.label}`);
  return getSequenceState(connection);
}

/**
 * Say how a held step was settled.
 *
 * The pane settles steps too, and a verdict taken there reaches nobody
 * otherwise - leaving the agent waiting on a step already resolved, and the
 * recording moving on without it.
 */
async function announceSettled(
  session: BenchSession,
  connection: string,
  index: number,
  outcome: string
): Promise<void> {
  if (!session.recordingWithAgent) return;
  await appendEvent(session.session, 'sequence', {
    connection,
    recording: 'settled',
    step: index + 1,
    outcome,
    detail: `step ${index + 1} settled: ${outcome}`,
  });
}

/** Let the page run on, where holding it for the step was this code's doing. */
async function releaseForStep(session: BenchSession): Promise<void> {
  if (!session.heldForStep) return;
  session.heldForStep = false;
  await releaseUi(session);
}

/**
 * Remove the held step and let capture continue.
 *
 * The page's event buffer is rewound to where the last kept step left it, so
 * the events behind the dropped step go with it rather than reappearing as the
 * same step on the next poll.
 */
export async function dropRecordedStep(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.pendingStep) return getSequenceState(connection);
  const rewindTo = session.keptEvents ?? 0;
  await evaluateInPage(session, `(() => {
    const events = globalThis.__cdpRecordingEvents;
    if (Array.isArray(events)) events.length = Math.min(${rewindTo}, events.length);
  })()`).catch(() => {});
  const dropped = session.pendingStep.index;
  session.pendingStep = null;
  await releaseForStep(session);
  await setCapturePaused(session, false);
  await announceSettled(session, connection, dropped, 'dropped');
  return getSequenceState(connection);
}

/** Put a finished recording on the event stream, for review as a whole. */
async function announceRecording(
  session: BenchSession,
  connection: string,
  name: string,
  cancelled: boolean
): Promise<void> {
  if (cancelled) {
    await appendEvent(session.session, 'sequence', {
      connection,
      sequence: name,
      recording: 'cancelled',
      detail: `recording "${name}" cancelled - nothing saved`,
    });
    return;
  }

  const steps = session.sequences?.active()?.steps ?? [];
  await appendEvent(session.session, 'sequence', {
    connection,
    sequence: name,
    recording: 'finished',
    steps: steps.map((step, i) => `${i + 1}. ${step.label}`),
    ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    review: getMessage('RECORDING_REVIEW'),
    detail: `recording "${name}" finished - ${steps.length} step(s)`,
  });
}

/** Finish the recording in progress; recordSequence returns once it lands. */
export async function stopRecordingSequence(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  // The purpose and the notes are written by recordSequence once the record
  // call returns, which is the point the file exists and is selected.
  await session.sequences.stopRecording(connection).catch(() => {});
}

/** Abandon the recording in progress, saving nothing. */
export async function cancelRecordingSequence(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  // Gating stops before the driver is told: the poll runs every 250ms, and a
  // recording still marked live re-raises the step that was just abandoned.
  session.recordingWithAgent = false;
  // Thrown away with the rest of it: a purpose or a note left behind would
  // land on whatever was recorded next.
  session.recordingPurpose = undefined;
  session.recordingNotes = undefined;
  session.recordingAnnotations = undefined;
  session.recordingName = undefined;
  session.recordingSequence = false;
  session.pendingStep = null;
  await releaseForStep(session);
  await session.sequences.cancelRecording(connection).catch(() => {});
}
