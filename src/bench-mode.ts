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
async function withPageReleased<T>(session: BenchSession, work: () => Promise<T>): Promise<T> {
  const { client } = session;
  const wasFrozen = session.frozen;

  if (wasFrozen) await unfreeze(session);
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
  // unfreeze's own EventBreakpoints.disable never reaches.
  await send(client, 'EventBreakpoints.disable');

  // Detaching the agent is what cancels a pause of ours that is armed but has
  // not landed. `pauseRequested` deliberately stays set until the next freeze
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
    await send(client, 'Debugger.enable');
    await send(client, 'Debugger.setSkipAllPauses', { skip: false });
    if (wasFrozen) await freeze(session).catch(() => {});
  }
}

/**
 * The bench - hold the page still, point at what is wrong, type a few words.
 *
 * Prose is the expensive part of reporting a UI bug: the toast has gone by the
 * time it is described, and "the row under the header" stays ambiguous. This
 * takes a click on the element in place of the description, and freezes time so
 * a state that only exists mid-interaction is still on screen to be clicked.
 *
 * Freezing is two clocks, not one. Debugger.pause stops the page's JS, and with
 * it every timer and rAF callback; CSS animations run on the compositor and
 * keep going until Animation.setPlaybackRate(0) stops them separately.
 *
 * Stepping runs to the next scheduled callback rather than advancing a clock.
 * Emulation.setVirtualTimePolicy would give exact millisecond steps, but it is
 * a one-way door: it replaces the page's clock with a synthetic one and has no
 * off switch, so the tab can never be handed back working - `advance` runs away
 * at thousands of times real speed, and neither detaching nor reloading clears
 * it. Stepping by callback lands exactly on the boundaries where state actually
 * changes, reports the page time it reached, and releases cleanly.
 *
 * Nothing is injected into the page being driven. Picking is Chrome's own
 * picker (Overlay.setInspectMode), which is browser-side and keeps working
 * however hard the page is frozen; the comment box lives in a separate control
 * tab (`bench-control.ts`), because a frozen page cannot accept a keystroke
 * and its DOM should not be edited by the act of writing about it.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { Page, CDPSession } from 'puppeteer-core';
import { getOutputPath } from './helpers/paths.js';
import { appendEvent } from './session-events.js';
import { getMessage } from './messages.js';
import { CANCELLED } from './tools/bench-tools.js';
import { parseExtendedSelector } from './utils/selector-resolver.js';
import { debugLog } from './debug-logger.js';
import { startBenchServer, type BenchServer } from './bench-control.js';
import { getProxy } from './proxy/registry.js';
import { levelOf, causeOf, type ProxyEvent } from './proxy/intercept-proxy.js';
import type { Annotation, AnnotationTarget, StepTraffic } from './annotation.js';
import type {
  BenchView, BoundaryEvent, BoundaryRule, BoundaryState, BoundaryTotals, CallbackEntry,
  HeldStep, PendingShot, SequenceCard, SequenceState, SequenceStep, SequenceVariable,
  TickResult,
} from './bench/wire.js';

export type { Annotation, AnnotationTarget, StepTraffic } from './annotation.js';
export type {
  BenchView, BoundaryRule, CallbackEntry, PendingShot, SequenceCard, SequenceState,
  SequenceStep, SequenceVariable, TickResult,
} from './bench/wire.js';

// =============================================================================
// Types
// =============================================================================

export interface BenchReport {
  connection: string;
  session: string;
  startedAt: number;
  /** Milliseconds the page has been allowed to run since the freeze began. */
  tickMs: number;
  /** Callbacks run since the freeze began. */
  totalSteps: number;
  /** Every callback stepped through since the freeze, oldest first, capped. */
  callbacks: CallbackEntry[];
  /** What the last step did, for the bench to report. */
  lastTick?: TickResult;
  picks: number;
  annotations: number;
  pickerArmed: boolean;
  /** Whether the page is held. The bench outlives an unfreeze: the picker
   *  stays available so the app can be driven up to the moment worth holding. */
  frozen: boolean;
  /** Where the person types. Open this if the tab was closed. */
  benchUrl: string;
}

interface BenchSession extends BenchReport {
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
  /** Set when the page was frozen to hold a step, so only that freeze is undone. */
  heldForStep?: boolean;
  /** The page the recording began on, which becomes its first step. */
  recordingStartUrl?: string;
  /** When the recording began, which bounds its first step. */
  recordingStartedAt?: number;
  /** The newest step's clock, which the recording ending closes the window on. */
  lastStepAt?: number;
  /** Traffic per step index, computed once the step's window has closed. */
  stepTraffic?: Map<number, StepTraffic>;
  /**
   * What the person decided about each kind of traffic, keyed as the proxy
   * matches it. Held on the session rather than in the page so a decision
   * survives a reload and a replay, and written onto the sequence only when
   * they ask for it.
   */
  boundaryRules?: Map<string, BoundaryRule>;
  /** Steps told to hold open, and how many arrivals each waits for. */
  boundaryWaits?: Map<number, number>;
  /** The proxy pin each answering rule armed, so clearing one releases it. */
  boundaryPins?: Map<string, string>;
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
}

/**
 * Confirm a reported source position against the file on disk, and correct it
 * where it is wrong.
 *
 * A dev transform reports where it thinks the JSX is, and it is not always
 * right: @vitejs/plugin-react prepends an HMR preamble before computing
 * positions, so its line is shifted by however many lines that preamble took
 * while its column stays correct. The column and the tag are enough to find the
 * real line, and reading the file is the only way to know which of the two the
 * framework gave us.
 */
export async function verifySourceLine(
  source: { fileName: string; lineNumber?: number; columnNumber?: number },
  tag: string,
  readOriginal?: (fileName: string) => Promise<string | null>
): Promise<{ fileName: string; lineNumber?: number; columnNumber?: number; corrected?: boolean }> {
  if (!source.lineNumber || !source.columnNumber) return source;

  // The source map is asked first: it carries sourcesContent, so it answers for
  // a bundled or remote app as well as a local one. Disk is the fallback for a
  // dev server that serves no map.
  let text: string | null = null;
  try {
    text = (await readOriginal?.(source.fileName)) ?? null;
  } catch {
    text = null;
  }
  if (text === null) {
    try {
      text = await fs.readFile(source.fileName, 'utf-8');
    } catch {
      return source;   // nothing can show us the original
    }
  }
  const lines = text.split('\n');

  const opening = `<${tag}`;
  const atColumn = (line: string | undefined) =>
    !!line && line.slice(Math.max(0, source.columnNumber! - 1)).startsWith(opening);

  if (atColumn(lines[source.lineNumber - 1])) return source;

  // Prefer the candidate nearest the reported line: a shifted report is still
  // a report about the same file, and files repeat tags.
  const candidates = lines
    .map((line, index) => (atColumn(line) ? index + 1 : 0))
    .filter(Boolean)
    .sort((a, b) => Math.abs(a - source.lineNumber!) - Math.abs(b - source.lineNumber!));

  if (!candidates.length) return source;
  return { ...source, lineNumber: candidates[0], corrected: true };
}

/** What the bench needs from the replay side: read the session, drive the run. */
export interface SequenceDriver {
  listNames: () => Promise<string[]>;
  /** The same list with what each one holds, for choosing between them. */
  listCatalogue: () => Promise<SequenceCard[]>;
  /** The open step-through session, or null. */
  active: () => {
    name: string;
    description?: string;
    expectedOutcome?: string;
    currentStep: number;
    total: number;
    steps: Array<{
      label: string;
      comment?: string;
      resolved?: string;
      captures?: string;
      annotations?: Annotation[];
      traffic?: StepTraffic;
    }>;
    variables: SequenceVariable[];
    /** 0-based index of the step that failed, when one did. */
    failedStep?: number;
  } | null;
  /**
   * Every host this sequence reaches: its start url, the url of any step that
   * names one, and the base url when the run is retargeted.
   *
   * The proxy is scoped to these, so a run reaches the app it drives and
   * nothing else - and so the bench is not the only thing allowed through.
   */
  hosts: (name: string) => string[];
  /** Each returns the failure text when the run stopped on one, else nothing. */
  start: (name: string, connection: string) => Promise<string | undefined>;
  /**
   * Run the next step.
   *
   * The signal stops it part-way. Without one a step waiting on the page runs
   * out its own settle before it returns, and a run stopped by hand reports
   * itself as still going for as long as that takes.
   */
  step: (signal?: AbortSignal) => Promise<string | undefined>;
  /** Re-run from the start up to and including `step` (0-based). */
  goto: (step: number) => Promise<string | undefined>;
  /** Swap the origin every absolute URL in the run uses. '' clears it. */
  setBaseUrl: (baseUrl: string) => void;
  baseUrl: () => string | undefined;
  finish: () => Promise<string | undefined>;
  /**
   * Stop the run where it stands, holding the step it reached.
   *
   * Distinct from `cancel`, which closes the sequence: a run stopped part-way
   * is a position someone wants to look at and carry on from, and closing it
   * returns the pane to step one with the captured variables gone.
   */
  halt: () => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * Erase a saved sequence, file and all. Returns the failure text when the
   * name matched nothing on disk, so the pane states that rather than
   * showing a list the deletion never left.
   */
  remove: (name: string) => Promise<string | undefined>;
  /**
   * Store a note against a command of the open sequence and persist the file.
   * Returns the failure text when the write did not land, so the pick is held
   * rather than lost to a sequence that never recorded it.
   */
  attachAnnotation: (step: number, annotation: Annotation) => Promise<string | undefined>;
  /** Erase one note by id, wherever in the open sequence it sits. */
  detachAnnotation: (id: string) => Promise<string | undefined>;
  /**
   * Carry one note to another step of the open sequence.
   *
   * A note is stored in the step it belongs to, so a note filed against the
   * wrong one is wrong in the file rather than only on screen - and without
   * this the only way back is to erase it and take the capture again.
   */
  moveAnnotation: (id: string, step: number) => Promise<string | undefined>;
  /** Add a picture to a note already saved, and write the file back. */
  attachScreenshot: (id: string, path: string) => Promise<string | undefined>;
  /**
   * Record clicks in the page into a new sequence, returning when the person
   * stops. Returns the failure text when nothing was recorded.
   */
  record: (name: string, connection: string, startUrl: string) => Promise<string | undefined>;
  /** Finish a recording in progress, from the pane rather than the page. */
  stopRecording: (connection: string) => Promise<void>;
  /** Abandon a recording in progress, saving nothing. */
  cancelRecording: (connection: string) => Promise<void>;
  /** Erase one step of the open sequence and write the file back. */
  removeStep: (index: number) => Promise<string | undefined>;
  /** Move one step to another position and write the file back. */
  moveStep: (from: number, to: number) => Promise<string | undefined>;
  /**
   * Define a variable the sequence carries, as a step that sets it. A run has
   * no way to be handed a literal from outside, so the value lives in the
   * sequence and travels with it.
   */
  setVariable: (name: string, value: string) => Promise<string | undefined>;
  /** What the sequence is for and what it should end up doing. */
  describe: (description: string, expectedOutcome: string) => Promise<string | undefined>;
  /** Why one step is here, against the step. */
  commentStep: (index: number, words: string) => Promise<string | undefined>;
  /**
   * Insert a step that runs `thenSequence` when `condition` holds.
   *
   * `rejoinAt` names the step of this sequence the run resumes at once the
   * branch has run, for a branch that replaces the steps between. Left out,
   * the run resumes at the step after the conditional.
   */
  addConditional: (
    index: number, condition: string, thenSequence: string, rejoinAt?: number
  ) => Promise<string | undefined>;
  /** Remove the step that defines a variable. */
  removeVariable: (name: string) => Promise<string | undefined>;
  /**
   * Write the boundary decisions onto the open sequence, replacing whatever
   * stood there. Returns the failure text when the write did not land.
   */
  saveBoundaryRules: (
    rules: Array<Record<string, unknown>>,
    waits: Array<{ step: number; count: number }>,
    refuseWrites: boolean
  ) => Promise<string | undefined>;
  /**
   * The decisions written onto the open sequence, as they stand on disk.
   *
   * Read when the sequence is opened: without it a saved rule arms nothing and
   * the run it was written for serves the server's own answer, while the panel
   * that would show the rule is empty.
   */
  openBoundaryRules: () => {
    rules: Array<Record<string, unknown>>;
    waits: Array<{ step: number; count: number }>;
    refuseWrites: boolean;
  };
  /**
   * Write each step's traffic onto the sequence on disk.
   *
   * A recording's traffic is held per session while it is being taken; without
   * this it goes when the session does, and a note keeps its own text while
   * losing the evidence it was written about.
   */
  saveStepTraffic: (entries: Array<{ index: number; traffic: StepTraffic }>) => Promise<string | undefined>;
  /**
   * What crossed the boundary between two clocks, for one connection.
   *
   * Read off the network tool rather than the monitor directly, so the same
   * windowing rule applies here as to anyone asking by hand.
   */
  trafficIn: (connection: string, from: number, to: number) => Promise<StepTraffic>;
  /**
   * The steps a recording has captured, converted from the page's raw events.
   * The events are read by the caller over CDP: Puppeteer's page.evaluate
   * blocks on a paused isolate, and the page is held while a step is judged.
   */
  recordedSoFar: (eventsJson: string, startUrl: string) => SequenceStep[];
  /** One note of the open sequence with the step holding it, by id. */
  findAnnotation: (id: string) => { annotation: Annotation; step: number; sequence: string } | undefined;
  /** The tracked issue whose reproduction is the open sequence, when there is one. */
  issue: () => Promise<{ id: number; type: string; title: string } | undefined>;
}

const sessions = new Map<string, BenchSession>();

/** Enough log to see a pattern, not enough to bloat a 250ms poll. */
const MAX_CALLBACK_LOG = 200;

/** Longest a single sequence step may take before the drive gives up on it. */
const STEP_TIMEOUT_MS = 45000;

/**
 * Turn a pause into a log line. The instrumentation name arrives as
 * "instrumentation:setTimeout.callback"; only the middle of that is worth
 * showing, and a frame with no function name is an anonymous callback.
 */
/**
 * What the boundary holds, in the counts a reader needs at a glance.
 *
 * Four questions, in the order they are asked of a run: how much crossed, how
 * much of it any step owns, what the attribution rests on, and what the sockets
 * are doing. A reader who cannot answer the second from the list alone reads
 * every row looking for it.
 */
function summariseBoundary(
  events: ProxyEvent[],
  rules: Record<string, string>,
  sockets: Array<{ shape: string }>,
  open: number,
  holds: number
): BoundaryTotals {
  const levels = { observed: 0, likely: 0, positional: 0, unprompted: 0 };
  const roots: Record<string, number> = {};
  const shapes = { idle: 0, reply: 0, push: 0 };
  let requests = 0;
  let failed = 0;
  let out = 0;
  let incoming = 0;
  let owned = 0;
  let ruled = 0;

  for (const event of events) {
    if (event.kind === 'request') {
      requests += 1;
      if ((event.status ?? 0) >= 400 || event.status === 0) failed += 1;
    } else if (event.direction === 'out') out += 1;
    else incoming += 1;
    levels[levelOf(event)] += 1;
    if (causeOf(event)) owned += 1;
    const root = event.evidence?.initiator;
    if (root) roots[root] = (roots[root] ?? 0) + 1;
    const verdict = event.evidence?.shape ? rules[event.evidence.shape] : undefined;
    if (verdict === 'background' || verdict === 'unknown') ruled += 1;
  }
  for (const socket of sockets) {
    if (socket.shape === 'idle' || socket.shape === 'reply' || socket.shape === 'push') {
      shapes[socket.shape] += 1;
    }
  }
  return {
    events: events.length, requests, failed, out, in: incoming,
    owned, free: events.length - owned, levels, roots,
    sockets: { ...shapes, open }, holds, ruled,
    shapesRuled: Object.keys(rules).length,
  };
}

function describePause(session: BenchSession, event: any, at: number): CallbackEntry {
  const frame = event?.callFrames?.[0];
  const raw = typeof event?.data?.eventName === 'string' ? event.data.eventName : undefined;
  const kind = raw?.replace(/^instrumentation:/, '').replace(/\.callback$/, '');
  const url = frame?.location?.scriptId ? session.scripts.get(frame.location.scriptId) : undefined;
  return {
    index: session.totalSteps + 1,
    at: Math.round(at),
    ...(kind ? { kind } : {}),
    ...(frame ? { fn: frame.functionName || '(anonymous)' } : {}),
    ...(url ? { url } : {}),
    ...(frame?.location?.lineNumber !== undefined ? { line: frame.location.lineNumber + 1 } : {}),
  };
}

// =============================================================================
// Page-side source (a string: this runs in the page, not here)
// =============================================================================

/**
 * Describe the picked element. Framework lookup is best-effort by design -
 * every branch degrades to omitting the field rather than failing the pick.
 */
/** Describe the picked element. Exported so it can be run against a real DOM. */
export const DESCRIBE_ELEMENT = `function () {
  var el = this;

  // A selector good enough to point Chrome's overlay at, built mechanically.
  // Whether it names the element or merely where the element sat is not
  // decided here - the material below goes to the agent, which raises it with
  // the person who took the pick.
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return '';
    var testId = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test-id'));
    if (testId) return '[data-testid="' + testId + '"]';
    if (node.id) return '#' + CSS.escape(node.id);
    var parts = [];
    var cur = node;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      var part = cur.localName;
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.localName === cur.localName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  var out = { tag: el.localName, selector: selectorFor(el) };

  try {
    var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) out.text = text.slice(0, 200);
  } catch (e) {}
  try {
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) out.testId = testId;
  } catch (e) {}
  try {
    var r = el.getBoundingClientRect();
    out.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  } catch (e) {}

  // React: the fiber is an own key on the DOM node. Walk up to the nearest
  // function component and take whichever dev-build source survives.
  try {
    var fiberKey = Object.keys(el).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
    });
    if (fiberKey) {
      var f = el[fiberKey];
      var hops = 0;
      while (f && hops < 30) {
        if (!out.source && f._debugSource && f._debugSource.fileName) out.source = f._debugSource;
        if (!out.source && f.pendingProps && f.pendingProps.__source) out.source = f.pendingProps.__source;
        if (typeof f.type === 'function') {
          out.component = f.type.displayName || f.type.name || undefined;
          if (out.component) break;
        }
        f = f.return;
        hops++;
      }
    }
  } catch (e) {}

  // Preact keeps no back-pointer on the DOM node - Object.keys(el) is empty -
  // but it does hang the whole vnode tree off the container it rendered into,
  // as an own __k. So find the container above this element and walk down to
  // the vnode whose element is this one, keeping the components passed through.
  try {
    if (!out.component) {
      var container = el;
      while (container && !Object.prototype.hasOwnProperty.call(container, '__k')) {
        container = container.parentElement;
      }
      if (container) {
        // A component vnode shares its element with the host it rendered, so
        // the first match on the way down is the component's *call site*. The
        // host vnode deeper in is the element itself, which is what was clicked.
        var hostSource = null;
        var nearestComponent = null;
        var walk = function (vnode, components, depth) {
          if (!vnode || depth > 60) return;
          var next = components;
          if (typeof vnode.type === 'function') {
            next = vnode.type.displayName || vnode.type.name || components;
          }
          if (vnode.__e === el) {
            if (!nearestComponent) nearestComponent = next;
            if (typeof vnode.type === 'string') {
              hostSource = vnode.__source || (vnode.props && vnode.props.__source) || null;
              nearestComponent = next;
              return;
            }
          }
          var kids = vnode.__k;
          if (Array.isArray(kids)) {
            for (var i = 0; i < kids.length; i++) walk(kids[i], next, depth + 1);
          }
        };
        walk(container.__k, null, 0);
        if (nearestComponent) out.component = nearestComponent;
        if (!out.source && hostSource && hostSource.fileName) out.source = hostSource;
      }
    }
  } catch (e) {}

  return out;
}`;

// =============================================================================
// Mode control
// =============================================================================

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.5 },
};

/**
 * Arm or disarm Chrome's picker. Disarming matters: while it is armed every
 * click is a pick, so the app cannot be driven at all.
 */
async function setInspectMode(session: BenchSession, armed: boolean): Promise<void> {
  await send(session.client, 'Overlay.setInspectMode', {
    mode: armed ? 'searchForNode' : 'none',
    highlightConfig: HIGHLIGHT_CONFIG,
  });
  session.pickerArmed = armed;
}

/**
 * Does the page execute? A held page still answers anything synchronous, so
 * the only honest test is whether scheduled work runs.
 */
async function isRunning(client: CDPSession, timeoutMs = 600): Promise<boolean> {
  const ran = client
    .send('Runtime.evaluate', {
      expression: 'new Promise(resolve => setTimeout(() => resolve(true), 20))',
      awaitPromise: true,
      returnByValue: true,
    } as any)
    .then(() => true)
    .catch(() => false);
  return Promise.race([ran, new Promise<boolean>(r => setTimeout(() => r(false), timeoutMs))]);
}

/**
 * Every CDP call in the hold path is bounded.
 *
 * A call that rejects is survivable; one that never returns is not - it leaves
 * the drive suspended before its `finally`, so `sequenceBusy` stays latched and
 * every later press in the bench silently does nothing. A paused or
 * mid-navigation target can leave a send unanswered, so none of them are
 * awaited without a limit.
 */
async function send(client: CDPSession, method: string, params?: any, timeoutMs = 3000): Promise<void> {
  try {
    await Promise.race([
      client.send(method as any, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
    ]);
  } catch (error) {
    debugLog('bench', `${method}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Like `send`, for the calls whose answer is the point.
 *
 * `send` discards the result and swallows the error, which is right for the
 * commands that only need to have been issued. A lookup needs both back: the
 * caller decides what a missing node or a refused selector means.
 */
async function request(client: CDPSession, method: string, params?: any, timeoutMs = 3000): Promise<any> {
  return Promise.race([
    client.send(method as any, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}

/** Resolve on the next Debugger.paused, or on timeout. */
function nextPause(client: CDPSession, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    const done = (event: any | null) => {
      clearTimeout(timer);
      client.off('Debugger.paused', handler);
      resolve(event);
    };
    const handler = (event: any) => done(event);
    const timer = setTimeout(() => done(null), timeoutMs);
    client.on('Debugger.paused', handler);
  });
}

/** The page's own clock. Readable while paused: V8 evaluates on the paused isolate. */
async function pageTime(client: CDPSession): Promise<number> {
  try {
    const result = (await client.send('Runtime.evaluate', {
      expression: 'performance.now()',
      returnByValue: true,
    } as any)) as any;
    return typeof result.result?.value === 'number' ? result.result.value : 0;
  } catch {
    return 0;
  }
}

/**
 * Both clocks stopped: JS via the debugger, CSS animation via playback rate.
 *
 * An idle page has nothing to stop, so the pause is armed rather than taken and
 * no paused event arrives. The page is held either way - the next callback walks
 * into it - but the two states are released differently, so which one happened
 * has to be remembered.
 */
async function freeze(session: BenchSession): Promise<void> {
  if (session.frozen) return;
  const { client } = session;
  // Debugger.pause does nothing against a disabled agent or one set to skip
  // every pause, and a release leaves it in both of those states.
  await send(client, 'Debugger.enable');
  await send(client, 'Debugger.setSkipAllPauses', { skip: false });
  await send(client, 'Animation.setPlaybackRate', { playbackRate: 0 });
  const paused = nextPause(client, 1000);
  session.pauseRequested = true;
  await send(client, 'Debugger.pause');
  session.pauseTaken = !!(await paused);
  session.frozen = true;
}

/**
 * Let the page run again without closing the bench. The step breakpoints
 * go first, or the resume would pause on the very next callback.
 */
async function unfreeze(session: BenchSession): Promise<void> {
  if (!session.frozen) return;
  const { client } = session;
  const attempt = (method: string, params?: any) => send(client, method, params);
  await attempt('EventBreakpoints.disable');
  session.stepBreakpointsSet = false;

  if (session.pauseTaken) {
    await attempt('Debugger.resume');
    session.pauseTaken = false;
  } else {
    // Nothing is stopped, so there is nothing to resume - the pause is armed and
    // waiting. Only disabling the debugger discards it; leaving it would stop
    // the page the next time it did anything, with no one left holding it.
    await attempt('Debugger.disable');
    await attempt('Debugger.enable');
  }
  await attempt('Animation.setPlaybackRate', { playbackRate: 1 });
  session.frozen = false;
}

/** Leave the page as it was found: running, with no debugger attached. */
/**
 * Leave the page as the bench found it: running, with no agent of ours attached.
 *
 * Only the bench's own hold is released. A pause someone else set - a breakpoint
 * from the breakpoint tool, a `debugger` statement - is left stopped, because
 * resuming it would throw away what they stopped to look at and they would have
 * no way to know the bench did it.
 */
async function release(session: BenchSession): Promise<void> {
  await unfreeze(session);
  if (session.heldByOther) {
    debugLog('bench', 'leaving a pause that is not ours in place');
  }
  await send(session.client, 'Debugger.disable');
}

/**
 * Hold the page, or let it run. Driving the app needs an unfrozen page - under
 * a freeze its JS is stopped, so a click reaches nothing - and picking works
 * either way, since Chrome's picker is browser-side.
 */
export async function setFrozen(connection: string, frozen: boolean): Promise<BenchReport | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  if (frozen) await freeze(session);
  else await unfreeze(session);
  // The picker survives the transition either way.
  await setInspectMode(session, session.pickerArmed).catch(() => {});
  return getBenchSession(connection);
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
 * Whether another bench session already holds this page.
 *
 * Two sessions on one tab drive the same page from two panes: a navigate for
 * one takes the other off the page it was watching, and a freeze by one blocks
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
  if (!session) return undefined;
  const { client: _c, page: _p, server: _s, benchPage: _bp, pending: _pending, ...state } = session;
  return state;
}

export function isBenchOpen(connection: string): boolean {
  return sessions.has(connection);
}

/** The pick waiting for a comment, if the person has made one. */
export function getPendingPick(connection: string): AnnotationTarget | null {
  return sessions.get(connection)?.pending ?? null;
}

export async function setPicker(connection: string, armed: boolean): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  await setInspectMode(session, armed);
}

/**
 * An in-page expression returning the element a selector names, or null.
 *
 * A note's selector may carry :has-text(), which DOM.querySelector refuses, so
 * the match is made in the page. One builder serves both the outline and the
 * screenshot clip - two matchers would let the picture and the outline land on
 * different elements.
 */
function matchExpression(selector: string): string {
  const parsed = parseExtendedSelector(selector);
  if ('error' in parsed || !parsed.textMatch) {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }
  const descendant = parsed.descendantSelector ?? '';
  const wanted = JSON.stringify(parsed.textMatch.value);
  const scope = JSON.stringify(descendant ? (parsed.scopeSelector ?? parsed.baseSelector) : parsed.baseSelector);
  return `(() => {
    const exact = ${JSON.stringify(parsed.textMatch.type !== 'has-text')};
    const descendant = ${JSON.stringify(descendant)};
    for (const el of document.querySelectorAll(${scope})) {
      const text = (el.textContent || '').trim();
      const label = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const hit = exact
        ? (text === ${wanted} || label === ${wanted} || title === ${wanted})
        : [text, label, title].join(' ').toLowerCase().includes(${wanted}.toLowerCase());
      if (!hit) continue;
      const found = descendant ? el.querySelector(descendant) : el;
      if (found) return found;
    }
    return null;
  })()`;
}

/**
 * Outline an annotated element in the page while its row is hovered.
 *
 * DOM and Overlay answer while V8 is stopped, which Runtime.evaluate does not -
 * so this works on a held page, which is the state the pane is used in. An
 * empty selector clears the outline. A selector matching nothing clears it too:
 * the element has moved or gone, and a stale outline over the wrong element
 * reads as a match.
 */
export async function highlightAnnotation(connection: string, selector: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const { client } = session;

  if (!selector) {
    await send(client, 'Overlay.hideHighlight').catch(() => {});
    return;
  }

  // A note's selector may carry :has-text(), which anchors on what an element
  // says rather than where it sits. DOM.querySelector refuses it, so the match
  // is made in the page and the element handed back by object id, which
  // Overlay.highlightNode takes in place of a node id.
  try {
    const expression = matchExpression(selector);
    const { result } = await request(client, 'Runtime.evaluate', { expression, returnByValue: false });
    if (!result?.objectId) {
      await send(client, 'Overlay.hideHighlight').catch(() => {});
      return;
    }
    await send(client, 'Overlay.highlightNode', {
      objectId: result.objectId,
      highlightConfig: {
        contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
        borderColor: { r: 42, g: 112, b: 180, a: 0.9 },
        showInfo: true,
      },
    });
    await send(client, 'Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  } catch {
    // An outline is a convenience: a selector the page will not parse, or a
    // node that went away mid-lookup, leaves the pane working without it.
    await send(client, 'Overlay.hideHighlight').catch(() => {});
  }
}

/**
 * Commit the pending pick with the comment typed in the bench.
 *
 * The note is stored in the open sequence, against the step on screen. During a
 * recording it is held against the recorded step until the recording lands.
 * With neither there is nowhere for it to go: the pick is held rather than
 * discarded, so the same pick saves once a sequence is selected, and the pane
 * states why on its failure line.
 */
export async function saveAnnotation(connection: string, comment: string): Promise<Annotation | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  // A note with no element is a note about the step, which is a thing people
  // write: "this one is flaky", "this is the wrong order". Refusing it unless
  // something was picked lost the note without saying so.
  if (!session.pending && !comment.trim()) return undefined;

  const target = session.pending ?? undefined;
  const annotation: Annotation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    url: session.page.url(),
    tick: session.tickMs,
    comment,
    ...(target ? { target } : {}),
    ...(session.pickShots?.length ? { screenshots: [...session.pickShots] } : {}),
  };

  const place = session.recordingSequence && session.sequences
    ? await holdRecordingAnnotation(session, annotation)
    : await attachToOpenSequence(session, annotation);
  if ('failure' in place) {
    session.sequenceFailure = place.failure;
    return undefined;
  }

  session.pending = null;
  session.pickShots = [];
  session.noteStep = undefined;
  session.sequenceFailure = undefined;
  const firstOfSession = session.annotations === 0;
  session.annotations++;
  await appendEvent(session.session, 'annotation', {
    annotationId: annotation.id,
    connection,
    url: annotation.url,
    tick: annotation.tick,
    comment: annotation.comment,
    ...(target
      ? {
        selector: target.selector,
        // Once per session: on every note it buries the notes.
        ...(firstOfSession ? { review: getMessage('BENCH_SELECTOR_REVIEW') } : {}),
        component: target.component,
        source: target.source?.fileName,
      }
      : {}),
    sequence: `${place.name} step ${place.step + 1}/${place.total}`,
    detail: target
      ? `${target.component ? target.component + ' ' : ''}${target.selector}${comment ? ` - "${comment}"` : ''}`
      : `about the step${comment ? ` - "${comment}"` : ''}`,
  });

  // A recording runs with the picker disarmed: armed, the next click in the
  // app becomes a pick and never reaches the page as an action.
  if (!session.recordingSequence) await setInspectMode(session, true).catch(() => {});
  return annotation;
}

type NotePlace = { name: string; step: number; total: number } | { failure: string };

async function attachToOpenSequence(session: BenchSession, annotation: Annotation): Promise<NotePlace> {
  const active = session.sequences?.active();
  // Nothing to attach to yet. The pick and its captures are held rather than
  // dropped, so selecting a sequence and saving again keeps them.
  if (!active) return { failure: 'no sequence open - a note is stored in the step it belongs to' };
  const step = noteTargetStep(session, active.currentStep, active.total);
  const failure = await session.sequences!.attachAnnotation(step, annotation);
  return failure ? { failure } : { name: active.name, step, total: active.total };
}

/**
 * Keep a finding against the recorded step it was written at until the
 * recording lands, when flushRecordingNotes writes it onto the file.
 */
async function holdRecordingAnnotation(session: BenchSession, annotation: Annotation): Promise<NotePlace> {
  const total = (await recordedSteps(session)).length;
  if (total === 0) return { failure: 'nothing recorded yet - a note is stored in the step it belongs to' };
  const step = noteTargetStep(session, total, total);
  const held = session.recordingAnnotations ?? new Map<number, Annotation[]>();
  session.recordingAnnotations = held;
  held.set(step, [...(held.get(step) ?? []), annotation]);
  return { name: session.recordingName ?? 'the recording', step, total };
}

/** The steps the recording in progress has captured so far. */
async function recordedSteps(session: BenchSession) {
  return session.sequences!.recordedSoFar(
    await readCapturedEvents(session),
    session.recordingStartUrl ?? session.page.url()
  );
}

/** A finding held by the recording in progress, and the step it is held at. */
function heldAnnotation(session: BenchSession, id: string): { annotation: Annotation; step: number } | undefined {
  for (const [step, notes] of session.recordingAnnotations ?? []) {
    const annotation = notes.find(note => note.id === id);
    if (annotation) return { annotation, step };
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * Decisions about traffic.
 *
 * A rule outlives the event that prompted it and the run that carried it: the
 * events are a reading of one pass, and the rule is what every later pass
 * should do. Held on the session until someone writes it onto the sequence.
 * ------------------------------------------------------------------------- */

/**
 * The rules, each carrying the count its pin has served.
 *
 * The count is held on the pin, which is the thing the wire passes through;
 * the rule holds the decision and is stamped zero when it arms. Reading the
 * count back here stops a rule that is firing from reading as never fired,
 * which sends a reader to correct a key that already matches.
 *
 * A `hide` rule arms no pin and stays at zero: it changes what the list shows
 * and nothing crosses under it.
 */
function rulesOf(connection: string): BoundaryRule[] {
  const session = sessions.get(connection);
  if (!session) return [];
  const proxy = getProxy(connection);
  const served = new Map<string, { hits: number; matchedAs?: 'field' | 'text' }>();
  if (proxy) {
    for (const pin of proxy.listPins()) served.set(pin.id, { hits: pin.hits });
    for (const pin of proxy.listFramePins()) {
      served.set(pin.id, { hits: pin.hits, matchedAs: pin.field ? 'field' : 'text' });
    }
  }
  return [...(session.boundaryRules?.values() ?? [])].map(rule => {
    const pin = session.boundaryPins?.get(rule.key);
    const live = pin === undefined ? undefined : served.get(pin);
    return live === undefined ? rule : { ...rule, ...live };
  });
}

/** The open sequence's positions, which a rule can be bound to. */
function openSteps(connection: string): Array<{ index: number; label: string }> {
  const steps = sessions.get(connection)?.sequences?.active()?.steps ?? [];
  return steps.map((step, index) => ({ index, label: step.label }));
}

/** The sequence those positions count within. */
function openSequence(connection: string): string | undefined {
  return sessions.get(connection)?.sequences?.active()?.name;
}

function waitsOf(connection: string): Array<{ step: number; count: number }> {
  return [...(sessions.get(connection)?.boundaryWaits?.entries() ?? [])]
    .map(([step, count]) => ({ step, count }))
    .sort((a, b) => a.step - b.step);
}

/**
 * Arm one rule at the proxy, replacing whatever stood against the same key.
 *
 * `answer` pins the body, so the call is served locally and never reaches the
 * server. `block` pins an empty 204 for a request and drops a frame outright,
 * which is the same guarantee by the only two mechanisms the wire allows.
 * `hide` arms nothing: it decides what the list shows, not what crosses.
 */
export function setBoundaryRule(connection: string, rule: BoundaryRule): BoundaryRule[] {
  const session = sessions.get(connection);
  if (!session) return [];
  const rules = session.boundaryRules ??= new Map();
  const pins = session.boundaryPins ??= new Map();
  const proxy = getProxy(connection);

  // One decision per key: the pin behind the old one goes with it, or the
  // proxy keeps answering from a rule the list no longer shows.
  const previous = pins.get(rule.key);
  if (previous && proxy) proxy.unpin(previous);
  pins.delete(rule.key);

  // A constraint dropped from the rule leaves no value to bind it back with,
  // and the editor's row for it goes with the value. Carrying the recorded
  // values forward across the replace keeps that row offering the binding.
  const staged = {
    ...rules.get(rule.key)?.staged,
    ...rule.staged,
    ...(rule.step !== undefined ? { step: rule.step } : {}),
    ...(rule.method !== undefined ? { method: rule.method } : {}),
    ...(rule.url !== undefined ? { url: rule.url } : {}),
    ...(rule.direction !== undefined ? { direction: rule.direction } : {}),
  };
  rule = Object.keys(staged).length > 0 ? { ...rule, staged } : rule;

  if (proxy && rule.verb !== 'hide') {
    const body = rule.verb === 'answer' ? (rule.body ?? '') : '';
    if (rule.frame) {
      // Bound to the socket and direction the frame was read from. Without
      // them the payload text is the whole predicate, and one rule answers
      // every socket carrying that text, both ways.
      const pin = proxy.pinFrame({
        textIncludes: rule.key,
        ...(rule.url ? { urlIncludes: rule.url } : {}),
        ...(rule.direction ? { direction: rule.direction === 'out' ? 'sent' as const : 'received' as const } : {}),
        ...(rule.step !== undefined ? { step: rule.step } : {}),
        ...(rule.verb === 'answer' ? { replaceWith: body } : {}),
      });
      pins.set(rule.key, pin.id);
    } else {
      const pin = proxy.pin({
        urlIncludes: rule.key,
        ...(rule.method ? { method: rule.method } : {}),
        ...(rule.step !== undefined ? { step: rule.step } : {}),
        status: rule.verb === 'answer' ? (Number(rule.status) || 200) : 204,
        body,
      });
      pins.set(rule.key, pin.id);
    }
  }

  rules.set(rule.key, { ...rule, hits: 0 });
  return rulesOf(connection);
}

/** Drop the rule against one key, and the pin it armed with it. */
export function clearBoundaryRule(connection: string, key: string): BoundaryRule[] {
  const session = sessions.get(connection);
  if (!session) return [];
  const pin = session.boundaryPins?.get(key);
  if (pin) getProxy(connection)?.unpin(pin);
  session.boundaryPins?.delete(key);
  session.boundaryRules?.delete(key);
  return rulesOf(connection);
}

/**
 * Hold a step open until `count` things have crossed under it.
 *
 * A count of 0 clears it. Stored rather than applied here: what consumes it is
 * the run, and a step told to wait while nothing runs has nothing to wait for.
 */
export function setBoundaryWait(
  connection: string,
  step: number,
  count: number
): Array<{ step: number; count: number }> {
  const session = sessions.get(connection);
  if (!session) return [];
  const waits = session.boundaryWaits ??= new Map();
  if (count > 0) waits.set(step, count);
  else waits.delete(step);
  return waitsOf(connection);
}

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
      ...(session.pendingStep ? { pendingStep: session.pendingStep } : {}),
      ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
      ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    };
  }

  const active = session.sequences.active();
  if (!active) {
    return {
      available,
    catalogue, steps: [], currentStep: 0, total: 0, busy: session.sequenceBusy, variables: [],
      ...(session.recordingSequence ? { recording: true } : {}),
      ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
      // A failure with nothing selected still belongs on the pane's failure
      // line - a delete that matched no name reports here and nowhere else.
      ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    };
  }

  const issue = await session.sequences.issue().catch(() => undefined);

  return {
    available,
    catalogue,
    ...(issue ? { issue } : {}),
    name: active.name,
    ...(active.description ? { description: active.description } : {}),
    ...(active.expectedOutcome ? { expectedOutcome: active.expectedOutcome } : {}),
    currentStep: active.currentStep,
    total: active.total,
    busy: session.sequenceBusy,
    ...(session.sequencePlaying ? { playing: true } : {}),
    ...(session.sequencePaused ? { paused: true } : {}),
    ...(session.recordingSequence ? { recording: true } : {}),
    variables: active.variables,
    ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
    ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    steps: active.steps.map((step, index) => ({
      index,
      label: step.label,
      ...(step.comment ? { comment: step.comment } : {}),
      ...(step.resolved ? { resolved: step.resolved } : {}),
      ...(step.captures ? { captures: step.captures } : {}),
      // Dropping these here is invisible at the write - the note reaches the
      // file and the event stream all the same - and leaves the pane showing
      // nothing under the step it was just filed against. The same held for
      // traffic: written to the file, whitelisted out on the way back.
      ...(step.annotations?.length ? { annotations: step.annotations } : {}),
      ...(step.traffic ? { traffic: step.traffic } : {}),
      done: index < active.currentStep,
      current: index === active.currentStep,
      ...(active.failedStep === index ? { failed: true } : {}),
    })),
  };
}

/**
 * Run part of a sequence against a held page.
 *
 * The page has to be running for a step to land at all - input is discarded
 * while V8 is stopped - so each step unfreezes, drives, and freezes again. The
 * gap measured about 6ms against a state that lasts 600ms, which is what makes
 * this worth doing by hand: the freeze is issued by the runner rather than by
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
  const unlatch = setTimeout(() => { session.sequenceBusy = false; }, STEP_TIMEOUT_MS + 15000);

  try {
    // The picker would swallow the step's own click.
    if (wasArmed) await setInspectMode(session, false);
    session.sequenceFailure = await withPageReleased(session, async () => {
      // Let the page paint before driving it: a step following a navigate can
      // otherwise look for an element the framework has not rendered yet.
      // Bounded, because rAF never fires on a page that is still held.
      await Promise.race([
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
        new Promise<string>(resolve =>
          setTimeout(() => resolve('the step did not finish in time'), STEP_TIMEOUT_MS)),
      ]);
    });
  } catch (error) {
    debugLog('bench', `sequence step failed: ${error}`);
  } finally {
    clearTimeout(unlatch);
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
  armSavedRules(connection);
  return state;
};

/**
 * Arm what the open sequence carries, replacing whatever the session held.
 *
 * A rule is written onto the sequence so a later run repeats the decision; it
 * arms nothing by sitting in the file. Opening the sequence is the point the
 * decisions become live, so the panel reads what will happen rather than
 * nothing, and the first pass serves the pinned body rather than the server's.
 *
 * The rules that stood for the sequence being closed go with it: they were
 * that sequence's decisions, and leaving them armed answers traffic the open
 * sequence never asked about.
 */
function armSavedRules(connection: string): void {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  for (const key of [...(session.boundaryRules?.keys() ?? [])]) clearBoundaryRule(connection, key);
  session.boundaryWaits?.clear();

  const held = session.sequences.openBoundaryRules();
  getProxy(connection)?.refuseUnmatchedWrites(held.refuseWrites);
  for (const raw of held.rules) {
    const key = String(raw.key ?? '');
    if (!key) continue;
    setBoundaryRule(connection, {
      key,
      verb: (raw.verb === 'block' || raw.verb === 'hide') ? raw.verb : 'answer',
      ...(raw.frame ? { frame: true } : {}),
      ...(typeof raw.method === 'string' ? { method: raw.method } : {}),
      ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
      ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
      ...(raw.status !== undefined ? { status: String(raw.status) } : {}),
      ...(typeof raw.recorded === 'string' ? { recorded: raw.recorded } : {}),
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      ...(raw.direction === 'out' || raw.direction === 'in' ? { direction: raw.direction } : {}),
      // Dropped here, a saved rule comes back without the values its dropped
      // constraints were recorded with, so the round trip through the file
      // undoes the widening and takes the row that reverses it.
      ...(raw.staged !== null && typeof raw.staged === 'object'
        ? { staged: raw.staged as BoundaryRule['staged'] } : {}),
    });
  }
  for (const wait of held.waits) setBoundaryWait(connection, wait.step, wait.count);
}

/** Clear the failure line, which otherwise stands until something else fails. */
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

/** Put a guarded jump into the run, after the step it is added against. */
export async function addSequenceConditional(
  connection: string,
  index: number,
  condition: string,
  thenSequence: string,
  rejoinAt?: number
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences
    .addConditional(index, condition, thenSequence, rejoinAt)
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
export async function playSequence(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;

  session.sequenceHalt = false;
  session.sequencePaused = false;
  session.sequencePlaying = true;
  let state = await getSequenceState(connection);
  const total = state?.total ?? 0;

  // Bounded by the step count: a step that fails ends the run, and one that
  // does not advance would otherwise loop forever.
  for (let guard = 0; guard <= total; guard++) {
    const before = state?.currentStep ?? 0;
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
    if (state.currentStep >= state.total) break;
    if (state.currentStep === before) break;
  }
  session.sequencePlaying = false;
  return getSequenceState(connection);
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
  startUrl = ''
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
    if (wasArmed) await setInspectMode(session, false);
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
    session.recordingStartedAt = Date.now();
    session.stepTraffic = new Map();
    session.recordingNotes = new Map();
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
    session.recordingWithAgent = false;
    session.pendingStep = null;
    if (wasArmed) await setInspectMode(session, true).catch(() => {});
    session.sequenceBusy = false;
  }

  if (!cancelled) await flushRecordingNotes(session);
  if (!cancelled) await persistStepTraffic(session, connection);
  if (withAgent) await announceRecording(session, connection, name, cancelled);
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
    const traffic = await session.sequences.trafficIn(connection, session.lastStepAt, Date.now())
      .catch(() => undefined);
    if (traffic) held.set(last, traffic);
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
async function attachStepTraffic(
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

    const traffic = await session.sequences.trafficIn(connection, from, to)
      .catch(() => ({ requests: 0, failed: 0, opened: 0, writes: 0, lines: [] as string[] }));
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
async function gateNewStep(
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
  if (session.heldForStep) await freeze(session);

  await appendEvent(session.session, 'sequence', {
    connection,
    recording: 'step',
    step: index + 1,
    label: steps[index].label,
    review: getMessage('RECORDING_STEP_HELD'),
    detail: `step ${index + 1} held for review: ${steps[index].label}`,
  });
}

/**
 * Evaluate in the page over CDP rather than through Puppeteer.
 *
 * page.evaluate never returns while the isolate is paused, and every call
 * after it queues behind that one - which takes the bench's own polling
 * down with it. These run on the bench's own client, which answers while held.
 */
async function evaluateInPage(session: BenchSession, expression: string): Promise<any> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result?.value;
}

/** Stop or resume the page's own capture, which the recorder checks per event. */
async function setCapturePaused(session: BenchSession, paused: boolean): Promise<void> {
  await evaluateInPage(session, `globalThis.__cdpRecordingPaused = ${paused ? 'true' : 'false'}`)
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
  await unfreeze(session);
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
  return getSequenceState(connection);
}

/** Move a step to another position in the open sequence. */
export async function moveSequenceStep(
  connection: string,
  from: number,
  to: number
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  session.sequenceFailure = await session.sequences.moveStep(from, to).catch(error => String(error));
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
  await setFrozen(connection, true);
  session.sequenceFailure = undefined;
  return getSequenceState(connection);
}

export async function cancelSequence(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  await session.sequences.cancel().catch(() => {});
  session.sequenceFailure = undefined;
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

/**
 * Every capture a live session still holds, by path.
 *
 * A capture taken and not yet saved belongs to no annotation, so a sweep
 * reading the sequences alone would call it unreferenced and delete the
 * picture out from under the draft that is about to cite it.
 */
export function capturesInFlight(): string[] {
  const held: string[] = [];
  for (const session of sessions.values()) {
    for (const file of session.pickShots ?? []) held.push(file);
    for (const notes of session.recordingAnnotations?.values() ?? []) {
      for (const note of notes) held.push(...(note.screenshots ?? []));
    }
  }
  return held;
}

/** The step a pick would land on, so the bench opens its composer there. */
async function noteTargetFor(connection: string): Promise<number | undefined> {
  const session = sessions.get(connection);
  if (session?.recordingSequence && session.sequences) {
    const total = (await recordedSteps(session)).length;
    return total > 0 ? noteTargetStep(session, total, total) : undefined;
  }
  const active = session?.sequences?.active();
  if (!session || !active) return undefined;
  return noteTargetStep(session, active.currentStep, active.total);
}

/**
 * The pen names a step; without one the run's own step is used, clamped - a
 * completed run sits one past its last command. The pane reads this too, or it
 * would state one step and save to another.
 */
function noteTargetStep(session: BenchSession, currentStep: number, total: number): number {
  const wanted = session.noteStep ?? currentStep;
  return Math.min(Math.max(wanted, 0), Math.max(0, total - 1));
}

/** Aim the next note at a step and arm the picker. */
export async function noteAtStep(connection: string, step: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  session.noteStep = Math.max(0, step);
  session.sequenceFailure = undefined;
  await setInspectMode(session, true).catch(() => {});
}

/**
 * Take a capture and hold it; saveBenchScreenshot writes it once accepted.
 * `widen` walks up from the element the selector names, by that many parents.
 */
export async function captureBenchScreenshot(
  connection: string,
  selector?: string,
  widen = 0,
  annotationId?: string
): Promise<{ shot: PendingShot } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session) return { failure: 'the bench is not open here' };
  const { client } = session;

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  let label = 'the whole page';
  if (selector) {
    const box = await elementBox(session, selector, widen);
    if (!box) return { failure: `nothing on the page matches \`${selector}\`` };
    clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    label = widen > 0 ? `${box.tag} - ${widen} out from ${selector}` : selector;
  }

  try {
    const shot = await request(client, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: !clip,
      ...(clip ? { clip } : {}),
    });
    if (!shot?.data) return { failure: 'the page returned no image' };
    session.pendingShot = { data: shot.data, selector, widen, label, ...(annotationId ? { annotationId } : {}) };
    return { shot: session.pendingShot };
  } catch (error) {
    return { failure: String(error) };
  }
}

/** Write a held capture, named after what it is a picture of, and announce it. */
export async function saveBenchScreenshot(
  connection: string,
  /**
   * The capture with marks drawn on it, as a base64 PNG.
   *
   * Written in place of the raw capture, so what reaches whoever reads the
   * file is the picture with the box around the thing being pointed at. Marks
   * kept beside the image would have to be composited by every reader, and a
   * reader that did not know about them would see an unmarked page.
   */
  marked?: string
): Promise<{ path: string } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session?.pendingShot) return { failure: 'nothing is waiting to be saved' };
  const shot = marked ? { ...session.pendingShot, data: marked, marked: true } : session.pendingShot;

  try {
    const date = new Date().toISOString().split('T')[0];
    const dir = getOutputPath('screenshots', date);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${shotFilename(shot)}.png`);
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    session.pendingShot = null;

    // Where the capture goes: taken from a note, it joins that note; taken
    // otherwise, it waits for the next note written. A capture is the evidence
    // for something someone is about to say, and one that stood alone left the
    // words and the picture in different places.
    const held = shot.annotationId ? heldAnnotation(session, shot.annotationId) : undefined;
    if (held) {
      held.annotation.screenshots = [...(held.annotation.screenshots ?? []), file];
    } else if (shot.annotationId && session.sequences) {
      const failure = await session.sequences.attachScreenshot(shot.annotationId, file);
      if (failure) session.sequenceFailure = failure;
    } else {
      session.pickShots = [...(session.pickShots ?? []), file];
    }

    await appendEvent(session.session, 'screenshot', {
      connection,
      path: file,
      url: session.page.url(),
      ...(shot.selector ? { selector: shot.selector } : {}),
      ...(marked ? { marked: true } : {}),
      detail: `screenshot of ${shot.label}${marked ? ', marked up,' : ''} at ${file}`,
    });
    return { path: file };
  } catch (error) {
    return { failure: String(error) };
  }
}

/** Capped: a long selector path would exceed the name limit and fail the write. */
function shotFilename(shot: PendingShot): string {
  const base = shot.selector
    // A leading dot - which every class selector starts with - makes the file
    // hidden, so a capture would not appear in the directory it was saved to.
    ? shot.selector.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 120)
    : 'page';
  return `${base || 'element'}${shot.widen > 0 ? `-out${shot.widen}` : ''}-${Date.now()}`;
}

/**
 * The on-screen box of the element a selector names, in page coordinates.
 *
 * Runtime rather than DOM.getBoxModel: a note's selector may carry
 * :has-text(), which the DOM domain refuses, and the same match has to be made
 * for the outline and for the clip or the two disagree.
 */
async function elementBox(
  session: BenchSession,
  selector: string,
  widen: number
): Promise<{ x: number; y: number; width: number; height: number; tag: string } | undefined> {
  try {
    const { result } = await request(session.client, 'Runtime.evaluate', {
      expression: `(() => {
        let el = ${matchExpression(selector)};
        if (!el) return null;
        for (let out = 0; out < ${Math.max(0, Math.trunc(widen))}; out++) {
          if (!el.parentElement || el.parentElement === document.body) break;
          el = el.parentElement;
        }
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({
          x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height,
          tag: el.localName + (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
        });
      })()`,
      returnByValue: true,
    });
    return result?.value ? JSON.parse(result.value) : undefined;
  } catch {
    return undefined;
  }
}

/** Put one note on the session event stream, on demand. */
export async function notifyAnnotation(connection: string, id: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;

  const held = heldAnnotation(session, id);
  const found = held
    ? { ...held, sequence: session.recordingName ?? 'the recording' }
    : session.sequences.findAnnotation(id);
  if (!found) {
    session.sequenceFailure = 'that note is not in the open sequence';
    return;
  }

  const { annotation, step, sequence } = found;
  session.sequenceFailure = undefined;
  await appendEvent(session.session, 'annotation', {
    annotationId: annotation.id,
    connection,
    notify: true,
    url: annotation.url,
    tick: annotation.tick,
    comment: annotation.comment,
    ...(annotation.target
      ? {
        selector: annotation.target.selector,
        component: annotation.target.component,
        source: annotation.target.source?.fileName,
      }
      : {}),
    sequence: `${sequence} step ${step + 1}`,
    review: getMessage('BENCH_NOTIFY_REVIEW'),
    detail: `look at this: ${annotation.comment || '(no comment)'}`
      + (annotation.target ? ` - ${annotation.target.selector}` : ' - about the step itself'),
  });
}

/** Erase one note from the open sequence and write the file back. */
/** Carry one note to another step, and write the sequence back. */
export async function moveAnnotation(connection: string, id: string, step: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const held = heldAnnotation(session, id);
  if (held) {
    dropHeldAnnotation(session, id);
    const notes = session.recordingAnnotations!;
    notes.set(step, [...(notes.get(step) ?? []), held.annotation]);
    session.sequenceFailure = undefined;
    return;
  }
  const failure = await session.sequences.moveAnnotation(id, step).catch(error => String(error));
  session.sequenceFailure = failure;
}

/** Returns no failure: a held finding is removed from memory, with no write to refuse it. */
function dropHeldAnnotation(session: BenchSession, id: string): undefined {
  for (const [step, notes] of session.recordingAnnotations ?? []) {
    const kept = notes.filter(note => note.id !== id);
    if (kept.length) session.recordingAnnotations!.set(step, kept);
    else session.recordingAnnotations!.delete(step);
  }
  return undefined;
}

export async function removeAnnotation(connection: string, id: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const failure = heldAnnotation(session, id)
    ? dropHeldAnnotation(session, id)
    : await session.sequences.detachAnnotation(id).catch(error => String(error));
  session.sequenceFailure = failure;
  if (!failure && session.annotations > 0) session.annotations--;
}

export async function discardPick(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  session.pending = null;
  session.noteStep = undefined;
  session.pickShots = [];
  await setInspectMode(session, true).catch(() => {});
}

export async function startBench(params: {
  page: Page;
  connection: string;
  sessionName: string;
  /** Owns original source text - see SourceMapHandler.getOriginalContent. */
  sourceMapHandler?: { registerSourceMap: (scriptUrl: string, sourceMapURL: string) => void; getOriginalContent: (source: string) => Promise<string | null> };
  /** Drives replay's own step-through session; the bench never re-implements it. */
  sequences?: SequenceDriver;
  /** Opens the bench tab. Omitted in tests, which drive the handlers directly. */
  openBench?: (url: string) => Promise<Page | undefined>;
}): Promise<BenchReport> {
  const { page, connection, sessionName, openBench, sourceMapHandler, sequences } = params;
  const readOriginal = sourceMapHandler
    ? (fileName: string) => sourceMapHandler.getOriginalContent(fileName)
    : undefined;

  const existing = sessions.get(connection);
  if (existing) {
    await setInspectMode(existing, true);
    return getBenchSession(connection)!;
  }

  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('Overlay.enable');
  await client.send('Runtime.enable');
  await client.send('Animation.enable');

  const session: BenchSession = {
    client,
    page,
    connection,
    session: sessionName,
    startedAt: Date.now(),
    tickMs: 0,
    picks: 0,
    annotations: 0,
    pickerArmed: false,
    frozen: false,
    benchUrl: '',
    pending: null,
    pauseRequested: false,
    heldByOther: false,
    sequenceBusy: false,
    pauseTaken: false,
    sequences,
    scripts: new Map(),
    totalSteps: 0,
    callbacks: [],
    stepBreakpointsSet: false,
  };
  sessions.set(connection, session);

  client.on('Debugger.paused', (event: any) => {
    session.pauseTaken = true;
    // A pause we did not ask for is someone else's - a breakpoint, a debugger
    // statement. Recorded so it can be reported; the bench still releases its
    // own hold normally, but never attaches a second agent to force theirs.
    if (!session.pauseRequested) {
      session.heldByOther = true;
      debugLog('bench', `page stopped by something else: reason=${event?.reason}`);
    }
  });

  // Debugger.enable replays scriptParsed for everything already loaded, so this
  // has to be listening before the enable rather than after it.
  client.on('Debugger.scriptParsed', (event: any) => {
    if (event?.scriptId && event?.url) session.scripts.set(event.scriptId, event.url);
    // Registration is lazy - the map is only fetched if something asks for the
    // file behind it, which is a pick on an element from that module.
    if (event?.url && event?.sourceMapURL) {
      sourceMapHandler?.registerSourceMap(event.url, event.sourceMapURL);
    }
  });
  await client.send('Debugger.enable');

  client.on('Overlay.inspectNodeRequested', async (event: any) => {
    try {
      const { object } = (await client.send('DOM.resolveNode', {
        backendNodeId: event.backendNodeId,
      } as any)) as any;
      const described = (await client.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: DESCRIBE_ELEMENT,
        returnByValue: true,
      } as any)) as any;

      const target = described.result?.value as AnnotationTarget | undefined;
      if (!target) return;
      if (target.source?.fileName) {
        target.source = await verifySourceLine(target.source, target.tag, readOriginal);
      }

      // Chrome disarms its picker once it fires; the bench shows that,
      // and re-arms when the pick is saved or discarded.
      session.pickerArmed = false;
      session.picks++;
      session.pending = target;
    } catch (error) {
      debugLog('bench', `pick failed: ${error}`);
      await setInspectMode(session, true).catch(() => {});
    }
  });

  // Navigation drops the freeze with the old document.
  client.on('Page.frameNavigated', async (event: any) => {
    if (event.frame?.parentId) return;
    // Not while a sequence is being driven. A step that navigates would other-
    // wise be frozen the instant it lands, so nothing after it in the run can
    // render or be clicked - the drive re-freezes when it is done.
    if (session.sequenceBusy) return;
    try {
      session.stepBreakpointsSet = false;
      session.frozen = false;
      await freeze(session);
      session.tickMs = 0;
      session.totalSteps = 0;
      session.lastTick = undefined;
      session.callbacks = [];
      session.scripts.clear();
      await setInspectMode(session, session.pickerArmed);
    } catch (error) {
      debugLog('bench', `re-arm after navigation failed: ${error}`);
    }
  });
  await client.send('Page.enable');

  const server = await startBenchServer({
    // Everything but `primary`: only the route knows which copy is asking.
    getState: async (): Promise<Omit<BenchView, 'primary'>> => ({
      connection,
      pageUrl: page.url(),
      frozen: session.frozen,
      pickerArmed: session.pickerArmed,
      tickMs: session.tickMs,
      totalSteps: session.totalSteps,
      lastTick: session.lastTick,
      callbacks: session.callbacks.slice(-50),
      sequence: await getSequenceState(connection),
      pending: session.pending,
      noteTarget: await noteTargetFor(connection),
      ...(session.pendingShot ? { shot: session.pendingShot } : {}),
    }),
    save: async (comment: string) => { await saveAnnotation(connection, comment); },
    discard: async () => { await discardPick(connection); },
    tick: async (request: { steps?: number; budgetMs?: number }) => { await tickBench(connection, request); },
    setPicker: async (armed: boolean) => { await setPicker(connection, armed); },
    setFrozen: async (frozen: boolean) => { await setFrozen(connection, frozen); },
    selectSequence: async (name: string) => { await selectSequence(connection, name); },
    describeSequence: async (description: string, expectedOutcome: string) => {
      await describeSequence(connection, description, expectedOutcome);
    },
    commentSequenceStep: async (index: number, words: string) => {
      await commentSequenceStep(connection, index, words);
    },
    addSequenceConditional: async (
      index: number, condition: string, thenSequence: string, rejoinAt?: number
    ) => {
      await addSequenceConditional(connection, index, condition, thenSequence, rejoinAt);
    },
    gotoSequenceStep: async (step: number) => { await gotoSequenceStep(connection, step); },
    stepSequence: async () => { await stepSequence(connection); },
    playSequence: async () => { await playSequence(connection); },
    haltSequence: async () => { await haltSequence(connection); },
    cancelSequence: async () => { await cancelSequence(connection); },
    removeSequence: async (name: string) => { await removeSequence(connection, name); },
    dismissFailure: async () => { await dismissSequenceFailure(connection); },
    proxyBody: async (id: string) => getProxy(connection)?.bodyOf(id) ?? null,

    /**
     * Answer this from now on with what it answered here.
     *
     * A request is held by its own URL, so the next call to it is answered
     * locally. A frame is held by what it carried, since a socket message has
     * no other durable handle on it.
     */
    /**
     * Send one reading back to whoever is driving, with the evidence behind it.
     *
     * The classification is the code's job, so a person seeing a wrong one is
     * reporting a defect rather than correcting a label. Everything the rule
     * read goes with the note, because the next step is changing that rule and
     * a report without its inputs cannot be acted on.
     */
    proxyInvestigate: async (id: string, note: string) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      const event = live.eventsIn().find(e => e.id === id);
      if (!event) return 'that event has been dropped from the ring';
      const shape = event.evidence?.shape;
      const alike = shape
        ? live.eventsIn().filter(e => e.evidence?.shape === shape).length
        : 1;
      await appendEvent(sessions.get(connection)?.session ?? connection, 'investigate', {
        connection,
        note,
        reading: {
          level: levelOf(event), owned: causeOf(event) !== undefined,
          root: event.evidence?.initiator, shape, alike,
        },
        event: {
          id: event.id, at: event.at, kind: event.kind, direction: event.direction,
          url: event.url, method: event.method, status: event.status, size: event.size,
          preview: event.preview, commandIndex: event.commandIndex,
          runId: event.runId, step: event.step, evidence: event.evidence,
        },
      });
      return `sent \u00b7 ${shape ?? event.url} \u00b7 ${alike} of this kind`;
    },

    clearBoundary: async () => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      const held = live.eventsIn().length;
      live.clear();
      return held ? `cleared ${held} event${held === 1 ? '' : 's'}` : 'nothing was held';
    },

    allowHosts: async (hosts: string[]) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      live.allowOnly(hosts);
      return hosts.length
        ? `reaching ${hosts.join(', ')} and nothing else`
        : 'reaching every host';
    },

    requestProxy: async () => {
      if (getProxy(connection)) return 'this browser already runs through a proxy';
      const open = (await getSequenceState(connection))?.name;
      await appendEvent(sessions.get(connection)?.session ?? connection, 'proxy', {
        connection,
        wanted: true,
        ...(open ? { sequence: open } : {}),
        review: getMessage('BENCH_PROXY_WANTED', { connection, sequence: open ?? 'the open sequence' }),
        detail: `the person asked for "${connection}" to be relaunched through a proxy`
          + (open ? `, with "${open}" open` : ''),
      });
      return 'asked the session to relaunch this browser through a proxy';
    },

    proxyHold: async (id: string) => {
      const live = getProxy(connection);
      if (!live) return { text: 'no proxy' };
      const event = live.eventsIn().find(e => e.id === id);
      if (!event) return { text: 'gone' };
      const body = live.bodyOf(id);
      if (event.kind === 'request') {
        const pin = live.pin({
          urlIncludes: event.url,
          ...(event.method ? { method: event.method } : {}),
          ...(event.status ? { status: event.status } : {}),
          body: body ?? '',
        });
        // The pin's id goes back with the answer: without it the pane can hold
        // a value and never let go of it, since nothing else names which hold
        // belongs to which row.
        return { text: 'HELD', pin: pin.id };
      }
      if (body === undefined) return { text: 'BINARY - NOT HELD' };
      const pin = live.pinFrame({
        urlIncludes: event.url, direction: event.direction === 'out' ? 'sent' : 'received',
        textIncludes: body, replaceWith: body,
      });
      return { text: 'HELD', pin: pin.id };
    },

    proxyRelease: async (pin: string) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      return live.unpin(pin) ? 'RELEASED' : 'ALREADY GONE';
    },

    proxyEvents: async (sinceId: string | null): Promise<BoundaryState> => {
      const proxy = getProxy(connection);
      if (!proxy) {
        return {
          running: false, allowed: [], refused: 0, refusals: [],
          refusesWrites: false, refusedWrites: 0,
          rules: rulesOf(connection), waits: waitsOf(connection),
          events: [], totals: null, steps: openSteps(connection),
          ...(openSequence(connection) ? { forSequence: openSequence(connection) } : {}),
        };
      }
      const all = proxy.eventsIn();
      const rules = proxy.shapeRules();
      // Asked for by id rather than by clock: the list only grows, and an id
      // cannot land twice the way a millisecond can.
      const at = sinceId ? all.findIndex(e => e.id === sinceId) : -1;
      return {
        running: true,
        allowed: proxy.listAllowedHosts(),
        refused: proxy.blocked,
        refusals: proxy.refusals(),
        refusesWrites: proxy.refusesWrites,
        refusedWrites: proxy.refusedWrites,
        rules: rulesOf(connection),
        waits: waitsOf(connection),
        // The level and whether any step owns it are read here rather than
        // recomputed in the pane: both are policy over stored evidence, and a
        // second copy of that policy in the browser would drift from this one.
        events: all.slice(at + 1).map(event => ({
          ...event,
          level: levelOf(event),
          owned: causeOf(event) !== undefined,
          root: event.evidence?.initiator,
          // What a person decided this shape is. A verdict settles every frame
          // of that kind, so a row carries the one assigned to its shape even
          // when the decision was made on a different frame.
          verdict: event.evidence?.shape ? rules[event.evidence.shape] : undefined,
        })) as unknown as BoundaryEvent[],
        // Counted over everything the proxy holds, not over what this pane has
        // accumulated: a reader who opened the tab late would otherwise see a
        // summary of their own arrival time.
        totals: summariseBoundary(all, rules, proxy.socketShapes(), proxy.openSockets(),
          proxy.listPins().length + proxy.listFramePins().length),
        steps: openSteps(connection),
        ...(openSequence(connection) ? { forSequence: openSequence(connection) } : {}),
      };
    },
    keepRecordedStep: async () => { await keepRecordedStep(connection); },
    chooseStepSelector: async (index: number) => { await chooseStepSelector(connection, index); },
    flagRecordedStep: async (reason: string, options?: Array<{ selector: string; note: string }>, detail?: string) => {
      await flagRecordedStep(connection, reason, options, detail);
    },
    dropRecordedStep: async () => { await dropRecordedStep(connection); },
    recordSequence: async (name: string, withAgent: boolean, startUrl: string) => {
      await recordSequence(connection, name, withAgent, startUrl);
    },
    stopRecordingSequence: async () => { await stopRecordingSequence(connection); },
    cancelRecordingSequence: async () => { await cancelRecordingSequence(connection); },
    removeSequenceStep: async (index: number) => { await removeSequenceStep(connection, index); },
    moveSequenceStep: async (from: number, to: number) => { await moveSequenceStep(connection, from, to); },
    setSequenceVariable: async (name: string, value: string) => { await setSequenceVariable(connection, name, value); },
    removeSequenceVariable: async (name: string) => { await removeSequenceVariable(connection, name); },
    noteAtStep: async (step: number) => { await noteAtStep(connection, step); },
    moveAnnotation: async (id: string, step: number) => {
      await moveAnnotation(connection, id, step);
    },
    removeAnnotation: async (id: string) => { await removeAnnotation(connection, id); },
    notifyAnnotation: async (id: string) => { await notifyAnnotation(connection, id); },
    captureScreenshot: async (selector: string | undefined, widen: number, annotationId?: string) => {
      const held = sessions.get(connection);
      if (!held) return;
      const taken = await captureBenchScreenshot(connection, selector, widen, annotationId);
      held.sequenceFailure = 'failure' in taken ? taken.failure : undefined;
    },
    saveScreenshot: async (marked?: string) => {
      const held = sessions.get(connection);
      if (!held) return;
      const saved = await saveBenchScreenshot(connection, marked);
      held.sequenceFailure = 'failure' in saved ? saved.failure : undefined;
    },
    discardScreenshot: async () => {
      const held = sessions.get(connection);
      if (held) held.pendingShot = null;
    },
    highlightAnnotation: async (selector: string) => { await highlightAnnotation(connection, selector); },
    setBaseUrl: async (baseUrl: string) => { await setSequenceBaseUrl(connection, baseUrl); },

    setRule: async (rule: Record<string, unknown>) => {
      setBoundaryRule(connection, {
        key: String(rule.key ?? ''),
        verb: (rule.verb === 'block' || rule.verb === 'hide') ? rule.verb : 'answer',
        ...(rule.frame ? { frame: true } : {}),
        ...(typeof rule.method === 'string' && rule.method ? { method: rule.method } : {}),
        ...(typeof rule.step === 'number' ? { step: rule.step } : {}),
        ...(typeof rule.body === 'string' ? { body: rule.body } : {}),
        ...(rule.status !== undefined ? { status: String(rule.status) } : {}),
        ...(typeof rule.recorded === 'string' ? { recorded: rule.recorded } : {}),
        ...(typeof rule.label === 'string' ? { label: rule.label } : {}),
        ...(typeof rule.url === 'string' ? { url: rule.url } : {}),
        ...(rule.direction === 'out' || rule.direction === 'in' ? { direction: rule.direction } : {}),
        ...(rule.staged !== null && typeof rule.staged === 'object'
          ? { staged: rule.staged as BoundaryRule['staged'] } : {}),
      });
    },
    clearRule: async (key: string) => { clearBoundaryRule(connection, key); },
    setWait: async (step: number, count: number) => { setBoundaryWait(connection, step, count); },
    setRefuseWrites: async (on: boolean) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      live.refuseUnmatchedWrites(on);
      return on
        ? 'unmatched writes are answered 403 and recorded as refused'
        : 'unmatched writes reach the server';
    },

    /**
     * Write the decisions onto the sequence they were arrived at against.
     *
     * The events are not written with them: they are a reading of one pass,
     * and a pass tomorrow reads differently. What a later run needs is the
     * decision, which is small and does not go stale.
     */
    saveRules: async () => {
      const session = sessions.get(connection);
      if (!session?.sequences) return 'no bench here';
      const rules = rulesOf(connection).map(({ hits: _hits, matchedAs: _how, ...rule }) => rule);
      const waits = waitsOf(connection);
      const refuseWrites = getProxy(connection)?.refusesWrites ?? false;
      const failure = await session.sequences.saveBoundaryRules(rules, waits, refuseWrites);
      if (failure) {
        session.sequenceFailure = failure;
        return failure;
      }
      return `${rules.length} rule${rules.length === 1 ? '' : 's'}`
        + ` and ${waits.length} wait${waits.length === 1 ? '' : 's'}`
        + `${refuseWrites ? ', refusing unmatched writes,' : ''} written onto the sequence`;
    },
  });
  session.server = server;
  session.benchUrl = server.url;
  // The pane travels the same proxy as the app, so an allow list scoped to the
  // app refuses it and the pane never loads. Registered once its port is known,
  // and left out of the record: at four polls a second it would bury the app's
  // own traffic in its own.
  const liveProxy = getProxy(connection);
  if (liveProxy) {
    try { liveProxy.allowQuietly([new URL(server.url).host]); } catch { /* no host to add */ }
  }


  if (openBench) {
    try {
      session.benchPage = await openBench(server.url);
      // Closing the tab is how someone finishes: it releases the page and takes
      // the server with it, so there is no button that has to be found first.
      // stopBench closes this tab itself, which re-enters here - by then
      // the session is already gone, so the second pass is a no-op.
      session.benchPage?.on('close', () => {
        void stopBench(connection).catch((error) => {
          debugLog('bench', `cleanup after the bench tab closed failed: ${error}`);
        });
      });
    } catch (error) {
      debugLog('bench', `the bench tab failed to open: ${error}`);
    }
  }

  return getBenchSession(connection)!;
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
  await freeze(session);
  await ensureStepBreakpoints(session);

  // Neither given means the smallest possible move: one callback.
  const wantSteps = request.steps ?? (request.budgetMs === undefined ? 1 : undefined);
  const wantMs = request.budgetMs;

  // Only the resume windows count. performance.now() keeps running while V8 is
  // paused - the clock is wall-clock based, and pausing stops execution, not
  // time - so measuring from the start of the freeze would charge the page for
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
      // there is nothing to step to. Re-freeze where it stands.
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

export async function stopBench(connection: string): Promise<BenchReport | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  sessions.delete(connection);

  const state = getStateOf(session);
  // A sequence paused part-way is owed the teardown of whatever it launched,
  // and the recorder holding it outlives this bench. Closed here, that debt is
  // paid; left standing, the browsers the run opened stay open with nothing
  // left able to reach them.
  await session.sequences?.cancel().catch(() => {});
  const { client } = session;
  try {
    await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG } as any);
    await release(session);
    await client.send('Overlay.disable');
    await client.detach();
  } catch (error) {
    debugLog('bench', `stop cleanup failed: ${error}`);
  }
  // The bench tab closes after the server, so its last poll fails and the
  // page says so rather than hanging on a dead port.
  try {
    await session.server?.close();
    await session.benchPage?.close();
  } catch (error) {
    debugLog('bench', `bench server cleanup failed: ${error}`);
  }
  return state;
}

function getStateOf(session: BenchSession): BenchReport {
  const { client: _c, page: _p, server: _s, benchPage: _bp, pending: _pending, ...state } = session;
  return state;
}

/** Drop state for a connection that has gone away, without touching CDP. */
export function forgetBenchSession(connection: string): void {
  const session = sessions.get(connection);
  sessions.delete(connection);
  void session?.server?.close().catch(() => {});
}
