import type { Page, CDPSession } from 'puppeteer-core';
import type { BenchServer } from '../bench-control.js';
import type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';
import type { BoundaryRule, BurstView, CallbackEntry, HiddenKind, CaptureRecord, FactKind, PendingShot, TickResult } from '../bench/wire.js';
import { WriteWatch } from '../write-watch.js';
import type { ElementFacts, StyleSheets } from '../element-facts.js';
import { type SequenceDriver } from './driver.js';
import type { MotionApplied, MotionRule } from './motion-rules.js';
import type { MotionSetting } from '../bench/kinds.js';

export interface BenchReport {
  connection: string;
  session: string;
  startedAt: number;
  /** Milliseconds the page has been allowed to run since the hold began. */
  tickMs: number;
  /** Callbacks run since the hold began. */
  totalSteps: number;
  /** Every callback stepped through since the hold, oldest first, capped. */
  callbacks: CallbackEntry[];
  /** What the last step did, for the bench to report. */
  lastTick?: TickResult;
  picks: number;
  annotations: number;
  pickerArmed: boolean;
  /** The person's input in the app is recorded into history; the binding's listener while it is. */
  /** Whether the screen is held. The bench outlives a release: the picker
   *  stays available so the app can be driven up to the moment worth holding. */
  frozen: boolean;
  /** Where the person types. Open this if the tab was closed. */
  benchUrl: string;
}

/** The part of a capture's record known at capture time, completed on save. */
export interface CaptureContext {
  layout: { viewport: { width: number; height: number; dpr: number }; scroll: { x: number; y: number }; document: { width: number; height: number } };
  url: string;
  frozen: boolean;
  element?: CaptureRecord['element'];
  facts?: ElementFacts;
  /** Set on a capture from the dialog: whether the page was held before the dialog opened. */
  heldBefore?: boolean;
}

/** What the bench drives the page's JS through: the page's debugger connection. */
import type { PageTime } from '../page-time.js';

export interface PageDebugger {
  pause(): Promise<void>;
  /** Resolves once Chrome confirms the page runs again. */
  resume(): Promise<void>;
  /** Drop a pause asked for that has not landed. */
  disarmPause(): Promise<void>;
  isPaused(): boolean;
  waitForPause(timeoutMs?: number): Promise<void>;
  watchPause(watcher: (paused: boolean, event?: any) => void): () => void;
  setInstrumentationBreakpoints(eventNames: readonly string[]): Promise<void>;
  clearInstrumentationBreakpoints(): Promise<void>;
  scriptUrl(scriptId: string): string | undefined;
}

export interface BenchSession extends BenchReport {
  client: CDPSession;
  page: Page;
  server?: BenchServer;
  benchPage?: Page;
  pending: AnnotationTarget | null;
  /**
   * Step the next saved note attaches to, set by the + on a step row. Absent
   * means the step the run has reached, which is what a pick made without
   * choosing a row describes.
   */
  noteStep?: number;
  /** A capture taken and waiting to be accepted or discarded. */
  pendingShot?: PendingShot | null;
  /** What the held capture was taken from, kept here rather than sent to the bench on every poll. */
  pendingCapture?: CaptureContext;
  /** Set while the capture dialog is open; see BenchView.shotArmed. */
  shotArmed?: { heldBefore: boolean; annotationId?: string };
  /** The element facts an element capture reads, as last ticked in the dialog. */
  factChoice: FactKind[];
  /** The last Debugger.paused, while the page stays stopped in it. */
  pausedEvent?: any;
  /** Captures accepted and waiting for the note they are evidence for. */
  pickShots?: string[];
  recordingSequence?: boolean;
  /** The name the recording was started under, for the pane to show. */
  recordingName?: string;
  /**
   * Steps taken out of the recording in progress, by position in the full list
   * its events convert to. That list only grows at its end, so a position holds
   * one step for the length of the recording; the save takes these out.
   */
  recordingDropped?: number[];
  /** The last test run of the recording in progress: running, or how it ended. */
  recordingTest?: { state: 'running' | 'passed' | 'failed'; total: number; summary?: string };
  /** Each step taken out of the recording in progress, newest last, with what was written against it, for undo to put back. */
  recordingUndo?: Array<{
    full: number;
    index: number;
    edit?: Record<string, unknown>;
    note?: { comment: string };
    annotations?: Annotation[];
    traffic?: StepTraffic;
    motion?: Record<string, MotionSetting>;
  }>;
  /** The recording in progress takes no steps while set; the page's recorder reads it as `__cdpRecordingPaused`. */
  recordingPaused?: boolean;
  /**
   * What the recording is for and what it should end up doing.
   *
   * Held here while it runs: the sequence does not exist as a file until the
   * recording stops, and these are stated before the first click. Written onto
   * it once there is something to write onto.
   */
  recordingPurpose?: { description: string; expectedOutcome: string };
  /**
   * Why each step is there, keyed by its position in the list the pane shows.
   *
   * Held here for the same reason the purpose is: the steps are a projection of
   * the captured events, rebuilt on every poll, so a note written onto one is
   * discarded at the next tick. Written onto the file once the recording lands.
   */
  recordingNotes?: Map<number, { comment: string }>;
  /** Where a recording goes when it goes into another sequence, for the list to show it in place. */
  recordingInto?: { name: string; after: number };
  /** What a step of the recording in progress is given, as changed in the bench; written once it is saved. */
  recordingEdits?: Map<number, Record<string, unknown>>;
  /**
   * Findings written during the recording, with their captures, keyed by step.
   *
   * The sequence has no file until the recording stops, so an attach has
   * nothing to write to and the finding would be refused. Written onto the
   * file once the recording lands, as the step comments are.
   */
  recordingAnnotations?: Map<number, Annotation[]>;
  /** Set when the recording in progress reports each action to the agent. */
  recordingWithAgent?: boolean;
  /** Steps of the recording already announced, so each is sent once. */
  announcedSteps?: number;
  /**
   * The step capture is held on. 'validating' while the agent reads it, which
   * needs nothing from the person; 'flagged' once the agent has raised
   * something, which is when the pane offers a choice.
   */
  pendingStep?: {
    index: number;
    label: string;
    verdict: 'validating' | 'flagged';
    /** One line: what is wrong. */
    reason?: string;
    /** A second line of context, where it helps. */
    detail?: string;
    /** Selectors that would work here, one row each for the person to pick. */
    options?: Array<{ selector: string; note: string }>;
  } | null;
  /** Raw events captured up to the last kept step, for a drop to rewind to. */
  keptEvents?: number;
  /** Detaches the bench's UI hold from the hold record when the bench closes. */
  detachUi?: () => void;
  /** Ends the feed of Chrome's animation reports into the page's animation record. */
  detachRecord?: () => void;
  /** Set when the page was frozen to hold a step, so only that freeze is undone. */
  heldForStep?: boolean;
  /** Drives nested inside the one that brought the app's tab to the front. */
  appInFront?: number;
  /** Storage writes, which the proxy never sees. */
  writeWatch?: WriteWatch;
  /** The page the recording began on, which becomes its first step. */
  recordingStartUrl?: string;
  /** When the recording began, which bounds its first step. */
  recordingStartedAt?: number;
  /** The newest step's clock, which the recording ending closes the window on. */
  lastStepAt?: number;
  /**
   * When each recorded step was taken, by position. A person's click is no
   * tool command, so nothing stamps the proxy's cursor while a recording runs;
   * the events route places each crossing under the step whose window holds it.
   */
  recordingStepTimes?: Array<number | undefined>;
  /**
   * When the last recording stopped, and the sequence it produced. The step
   * windows above keep placing that recording's crossings after it stops, so
   * its rows stay under their steps; what crossed after this time is the
   * recording's tail, placed under no step.
   */
  recordingEndedAt?: number;
  recordedName?: string;
  /**
   * Whether the open sequence has rules on its file. Clearing the last rule
   * still writes, so the file loses it; with none written, an empty set is not
   * written onto every sequence opened.
   */
  rulesWritten?: boolean;
  /** Traffic per step index, computed once the step's window has closed. */
  stepTraffic?: Map<number, StepTraffic>;
  /**
   * What the person decided about each kind of traffic, keyed as the proxy
   * matches it. Held on the session rather than in the page so a decision
   * survives a reload and a replay, and written onto the sequence only when
   * they ask for it.
   */
  boundaryRules?: Map<string, BoundaryRule>;
  /** A person's names for kinds of traffic, by rule key. */
  boundaryNames?: Map<string, string>;
  /** The proxy pin each answering rule armed, so clearing one releases it. */
  boundaryPins?: Map<string, string>;
  /** The origin whose responses are held, which names the site file they are written to. */
  site?: string;
  /**
   * How the open sequence uses each response, where it says: a response it
   * names nothing about takes its mode's default - every step for `optOut`,
   * none for `optIn`.
   */
  uses?: Map<string, ResponseUse>;
  /** The responses as last written, so a change that leaves them alone writes no site file. */
  siteWritten?: string;
  /** The open sequence's steps as last armed, so a change to them re-arms what is held by step number. */
  armedShape?: string;
  /** The site's hidden kinds, by key. */
  hiddenKinds?: Map<string, HiddenKind>;
  /** Where the open sequence differs from a hidden kind's type: hidden here, or listed anyway. */
  hiddenUses?: Map<string, boolean>;
  stepBreakpointsSet: boolean;
  /** Driving a sequence one step at a time, when one is wired in. */
  sequences?: SequenceDriver;
  /** True while a sequence step is running, so two cannot overlap. */
  sequenceBusy: boolean;
  /**
   * Set while a play is to stop at the step it is on.
   *
   * A play is a loop of steps rather than one handed-over run, so nothing
   * inside the replay layer can end it: the loop is what has to read this and
   * stop, which it does after the step in flight finishes.
   */
  sequenceHalt?: boolean;
  /** Set once a halt has stopped a play, and cleared by anything that moves. */
  sequencePaused?: boolean;
  /** Set while a play walks the steps, and not for a single step. */
  sequencePlaying?: boolean;
  /** When the play in progress began, for the runs the home page lists. */
  playStartedAt?: number;
  /** When each step of that play started, by position. */
  playStepStarts?: Array<number | undefined>;
  /**
   * The drive in flight, so it can be stopped part-way.
   *
   * A step waiting on the page returns when the page answers or when its own
   * settle runs out. Held here, the wait is cut short instead, which is what
   * lets a pause take effect at the moment it is pressed.
   */
  driving?: AbortController;
  /** Why the last step stopped, when it failed. */
  sequenceFailure?: string;
  /** The steps of the last baseline whose motion is still running, and how often it was taken again as their rows landed. */
  baselineFilling?: { steps: number[]; retakes: number };
  /**
   * The page's one debugger connection, the debugger tools' own. The page's
   * JS is paused, resumed and stepped through it alone: a second debugger
   * agent of the bench's kept its own record of whether the page stood
   * stopped, and the two records disagreed in the moments between a command
   * and the event confirming it.
   */
  debugger?: PageDebugger;
  /** Stops following the debugger connection's pauses when the bench closes. */
  unwatchPause?: () => void;
  /** styleSheetId -> url, from CSS.styleSheetAdded, to name a rule's source. */
  sheets: StyleSheets;
  /** Ends the motion rules' watch on the page's animation record. */
  detachRules?: () => void;
  /** The next screen hold arms a stop in front of the page's next frame in place of pausing it now. */
  frameStopArming?: boolean;
  /** The page clock holds the app's frame callbacks, from a screen hold or frame stop until the release. */
  framesHeld?: boolean;
  /** The screen hold stopped the page's JS with the debugger: a page with no clock, whose timers nothing else holds. */
  pausedForScreen?: boolean;
  /** When the last frame stop was armed: the animations created after it are the group its input started. */
  groupSince?: number;
  /** The page's time - its clock and its CSS animation rate - which every hold, step and speed goes through. */
  time: PageTime;
  /** Drops a page time the bench made on its own session, for a page with no debugger connection. */
  detachTime?: () => void;
  /** Rules acting on single animations as they start; see motion-rules.ts. */
  motionRules?: MotionRule[];
  /** Animations a rule paused, which run again once no rule holds them. */
  motionPaused?: Set<string>;
  /**
   * Animations a rule paused, sought or retimed. Chrome reports each of them
   * cancelled as the rule acts, though it goes on; their cancels are passed over.
   */
  motionTouched?: Set<string>;
  /** What the rules did, newest last, capped. */
  motionApplied?: MotionApplied[];
  /** The timing the page first gave each animation a rule acted on, by id, which a rule applied again works from. */
  motionBases?: Map<string, { delay: number; duration: number }>;
  /** Settles once a whole-page freeze a step's motion scheduled has landed. */
  pendingFreeze?: Promise<void>;
  /** Motion set on the steps of the recording in progress, by step position, written onto the file when it lands. */
  recordingMotion?: Map<number, Record<string, MotionSetting>>;
  /** A burst a step filmed, waiting on the person to keep or drop it. */
  burst?: BurstView;
}

export const sessions = new Map<string, BenchSession>();

/** Enough log to see a pattern, not enough to bloat a 250ms poll. */
export const MAX_CALLBACK_LOG = 200;

/** Longest a single sequence step may take before the drive gives up on it. */
export const STEP_TIMEOUT_MS = 45000;

/**
 * Whether another bench session already holds this page.
 *
 * Two sessions on one tab drive the same page from two panes: a navigate for
 * one takes the other off the page it was watching, and a hold by one blocks
 * the other's own reads.
 */
export function pageHeldElsewhere(page: Page, exceptConnection: string): boolean {
  for (const [reference, session] of sessions) {
    if (reference !== exceptConnection && session.page === page) return true;
  }
  return false;
}

/** Put a burst a step filmed on the bench open on `connection`, for the person to look through. */
export function showBenchBurst(connection: string, burst: BurstView): void {
  const session = sessions.get(connection);
  if (session) session.burst = burst;
}

export function getBenchSession(connection: string): BenchReport | undefined {
  const session = sessions.get(connection);
  return session ? getStateOf(session) : undefined;
}

export function isBenchOpen(connection: string): boolean {
  return sessions.has(connection);
}

/**
 * A page or tab of a session that no longer exists. A session outlives the
 * browser it was opened in when that browser is killed rather than its tab
 * closed: the tab's close never fires.
 */
export function pageGone(held?: Page): boolean {
  return held !== undefined && (held.isClosed?.() === true || held.browser?.()?.connected === false);
}

/** The bench open on this connection, when its page and its tab are still there. */
export function runningBench(connection: string): BenchReport | undefined {
  const session = sessions.get(connection);
  if (!session || pageGone(session.page) || pageGone(session.benchPage)) return undefined;
  return getStateOf(session);
}

/** How the open sequence uses a response: not at all, at every step, or at these steps. */
export type ResponseUse = 'none' | 'all' | number[];

/**
 * The session as a report, named field by field. Everything else on it is
 * live state - CDP sessions, the page, the write watch holding both - and a
 * copy of it in a tool's result was serialised with the page's whole object
 * graph, which left bench start never returning.
 */
export function getStateOf(session: BenchSession): BenchReport {
  return {
    connection: session.connection,
    session: session.session,
    startedAt: session.startedAt,
    tickMs: session.tickMs,
    totalSteps: session.totalSteps,
    callbacks: session.callbacks,
    ...(session.lastTick ? { lastTick: session.lastTick } : {}),
    picks: session.picks,
    annotations: session.annotations,
    pickerArmed: session.pickerArmed,
    frozen: session.frozen,
    benchUrl: session.benchUrl,
  };
}

/** Drop state for a connection that has gone away, without touching CDP. */
export function forgetBenchSession(connection: string): void {
  const session = sessions.get(connection);
  session?.writeWatch?.stop();
  sessions.delete(connection);
  void session?.server?.close().catch(() => {});
}

/** Returned by record() when the person abandoned it; not a failure. */
export const CANCELLED = '\u0000cancelled';
