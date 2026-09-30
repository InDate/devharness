import type { Page, CDPSession } from 'puppeteer-core';
import type { BenchServer } from '../bench-control.js';
import type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';
import type { BoundaryRule, CallbackEntry, HiddenKind, CaptureRecord, FactKind, PendingShot, TickResult } from '../bench/wire.js';
import { WriteWatch } from '../write-watch.js';
import type { ElementFacts, StyleSheets } from '../element-facts.js';
import { type SequenceDriver } from './driver.js';

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
  /** The bench's JS pause, left in place by a screen released on its own, until the code is released. */
  jsKept?: boolean;
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
  /** True between asking for a pause and releasing it: what makes a pause
   *  ours. A pause arriving without it belongs to someone else - a breakpoint
   *  from the breakpoint tool, say - and is never resumed from here. */
  pauseRequested: boolean;
  /** Set when the page is stopped by something that is not the bench. */
  heldByOther: boolean;
  /** Whether V8 is actually stopped, as opposed to holding an armed pause.
   *  Debugger.pause on an idle page does not stop anything - there is nothing
   *  running to stop - it arms a pause that the next callback walks into. The
   *  page is held either way, but only a taken pause can be resumed. */
  pauseTaken: boolean;
  /** scriptId -> url, from Debugger.scriptParsed, to name a callback's source. */
  scripts: Map<string, string>;
  /** styleSheetId -> url, from CSS.styleSheetAdded, to name a rule's source. */
  sheets: StyleSheets;
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
