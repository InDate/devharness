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
async function withPageReleased<T>(session: AnnotateSession, work: () => Promise<T>): Promise<T> {
  const { client } = session;
  const wasFrozen = session.frozen;

  if (wasFrozen) await unfreeze(session);
  if (session.heldByOther) {
    debugLog('annotate', 'a pause not requested by annotate is in play');
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
    // If annotate was the one holding the page, finishing that release is ours
    // to do - including a pause of ours that landed late and got recorded as
    // foreign. Only a page annotate was NOT holding is left alone, which is the
    // case that would be someone else's breakpoint.
    if (wasFrozen || !session.heldByOther) {
      await send(client, 'Debugger.enable');
      await send(client, 'Debugger.resume');
      await send(client, 'Debugger.disable');
      session.heldByOther = false;
      if (!(await isRunning(client))) {
        debugLog('annotate', 'page is still held going into the step');
      }
    } else {
      debugLog('annotate', 'page held by a pause annotate did not take; leaving it alone');
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
 * Annotate mode - hold the page still, point at what is wrong, type a few words.
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
 * Nothing is injected into the page being annotated. Picking is Chrome's own
 * picker (Overlay.setInspectMode), which is browser-side and keeps working
 * however hard the page is frozen; the comment box lives in a separate control
 * tab (`annotate-control.ts`), because a frozen page cannot accept a keystroke
 * and its DOM should not be edited by the act of annotating it.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { Page, CDPSession } from 'puppeteer-core';
import { getOutputPath } from './helpers/paths.js';
import { appendEvent } from './session-events.js';
import { getMessage } from './messages.js';
import { CANCELLED } from './tools/annotate-tools.js';
import { parseExtendedSelector } from './utils/selector-resolver.js';
import { debugLog } from './debug-logger.js';
import { startControlServer, type ControlServer, type ControlState } from './annotate-control.js';
import type { Annotation, AnnotationTarget } from './annotation.js';

export type { Annotation, AnnotationTarget } from './annotation.js';

// =============================================================================
// Types
// =============================================================================

export interface AnnotateSessionState {
  connection: string;
  session: string;
  startedAt: number;
  /** Milliseconds the page has been allowed to run since the freeze began. */
  tickMs: number;
  /** Callbacks run since the freeze began. */
  totalSteps: number;
  /** Every callback stepped through since the freeze, oldest first, capped. */
  callbacks: CallbackEntry[];
  /** What the last step did, for the control pane to report. */
  lastTick?: TickResult;
  picks: number;
  annotations: number;
  pickerArmed: boolean;
  /** Whether the page is held. Annotate mode outlives an unfreeze: the picker
   *  stays available so the app can be driven up to the moment worth holding. */
  frozen: boolean;
  /** Where the person types. Open this if the tab was closed. */
  controlUrl: string;
}

interface AnnotateSession extends AnnotateSessionState {
  client: CDPSession;
  page: Page;
  control?: ControlServer;
  controlPage?: Page;
  pending: AnnotationTarget | null;
  /**
   * Step the next saved note attaches to, set by the + on a step row. Absent
   * means the step the run has reached, which is what a pick made without
   * choosing a row describes.
   */
  noteStep?: number;
  /** A capture taken and waiting to be accepted or discarded. */
  pendingShot?: PendingShot | null;
  /** Captures accepted while a pick is waiting, attached when it is saved. */
  pickShots?: string[];
  recordingSequence?: boolean;
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
  stepBreakpointsSet: boolean;
  /** Driving a sequence one step at a time, when one is wired in. */
  sequences?: SequenceDriver;
  /** True while a sequence step is running, so two cannot overlap. */
  sequenceBusy: boolean;
  /** Why the last step stopped, when it failed. */
  sequenceFailure?: string;
  /** True between asking for a pause and releasing it: what makes a pause
   *  ours. A pause arriving without it belongs to someone else - a breakpoint
   *  from the breakpoint tool, say - and is never resumed from here. */
  pauseRequested: boolean;
  /** Set when the page is stopped by something that is not annotate. */
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

/** A sequence step as the control pane shows it. */
export interface SequenceStepView {
  index: number;
  /** The call itself - `input.click [data-testid=order-{{var:id}}] button`. */
  label: string;
  /** What the step is for, which is what someone actually tracks. */
  comment?: string;
  /** The call with {{var:}} tokens filled in, when it has any. An env token is
   *  never resolved here - the value is a credential and this is a web page. */
  resolved?: string;
  /** Variable this step captures, when it captures one. */
  captures?: string;
  /** Notes taken against this step, in the order they were made. */
  annotations?: Annotation[];
  done: boolean;
  current: boolean;
  /** The step the run stopped on. */
  failed?: boolean;
}

/** A variable the run is carrying, and where it came from. */
export interface SequenceVariable {
  name: string;
  /** Rendered for display and truncated; never the raw object. */
  value: string;
  /** Expanded one level, for an object or array. */
  fields?: Array<{ key: string; value: string }>;
  /** 'step 2', or 'run' when nothing in the sequence captured it. */
  source: string;
}

/** The step-through session, or what could be started if none is open. */
export interface SequenceState {
  /** Names that can be selected - saved on disk, plus anything in memory. */
  available: string[];
  name?: string;
  steps: SequenceStepView[];
  currentStep: number;
  total: number;
  /** Set while a step or a play is mid-flight, so the pane can disable itself. */
  busy: boolean;
  /** What the sequence describes itself as doing. */
  description?: string;
  /** Values the run is carrying, newest capture last. */
  variables: SequenceVariable[];
  /** Set when the last step failed, which ends replay's session. */
  failure?: string;
  /** Origin every absolute URL in the run is rewritten onto, when set. */
  baseUrl?: string;
  /** Set while clicks in the page are being recorded into a new sequence. */
  recording?: boolean;
  /** The step capture is held on, and whether it needs the person. */
  pendingStep?: {
    index: number;
    label: string;
    verdict: 'validating' | 'flagged';
    reason?: string;
    detail?: string;
    options?: Array<{ selector: string; note: string }>;
  };
  /** The tracked issue this sequence reproduces, when one references it. */
  issue?: { id: number; type: string; title: string };
}

/** What annotate needs from the replay side: read the session, drive the run. */
export interface SequenceDriver {
  listNames: () => Promise<string[]>;
  /** The open step-through session, or null. */
  active: () => {
    name: string;
    description?: string;
    currentStep: number;
    total: number;
    steps: Array<{ label: string; comment?: string; resolved?: string; captures?: string; annotations?: Annotation[] }>;
    variables: SequenceVariable[];
    /** 0-based index of the step that failed, when one did. */
    failedStep?: number;
  } | null;
  /** Each returns the failure text when the run stopped on one, else nothing. */
  start: (name: string, connection: string) => Promise<string | undefined>;
  step: () => Promise<string | undefined>;
  /** Re-run from the start up to and including `step` (0-based). */
  goto: (step: number) => Promise<string | undefined>;
  /** Swap the origin every absolute URL in the run uses. '' clears it. */
  setBaseUrl: (baseUrl: string) => void;
  baseUrl: () => string | undefined;
  finish: () => Promise<string | undefined>;
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
  /** Remove the step that defines a variable. */
  removeVariable: (name: string) => Promise<string | undefined>;
  /**
   * The steps a recording has captured, converted from the page's raw events.
   * The events are read by the caller over CDP: Puppeteer's page.evaluate
   * blocks on a paused isolate, and the page is held while a step is judged.
   */
  recordedSoFar: (eventsJson: string, startUrl: string) => SequenceStepView[];
  /** One note of the open sequence with the step holding it, by id. */
  findAnnotation: (id: string) => { annotation: Annotation; step: number; sequence: string } | undefined;
  /** The tracked issue whose reproduction is the open sequence, when there is one. */
  issue: () => Promise<{ id: number; type: string; title: string } | undefined>;
}

/** One callback the page ran, as a step passed through it. */
export interface CallbackEntry {
  /** Position in the run since the freeze, 1-based. */
  index: number;
  /** Page milliseconds this callback landed at, measured from the freeze. */
  at: number;
  /** What scheduled it - setTimeout, setInterval, requestAnimationFrame. */
  kind?: string;
  /** Function that ran, where it has a name. */
  fn?: string;
  /** Source location, already through the dev server's own paths. */
  url?: string;
  line?: number;
}

/**
 * What a step actually did. The callback is the unit: it is what the page
 * executes and where its state changes, so it is the only quantity a step can
 * ask for exactly. Milliseconds come back as a measurement.
 */
export interface TickResult {
  /** Callbacks asked for, when the step was expressed in callbacks. */
  requestedSteps?: number;
  /** Milliseconds asked for, when the step was expressed as a time to reach. */
  requestedMs?: number;
  /** Callbacks actually run. 0 means nothing was scheduled. */
  steps: number;
  /** Milliseconds the page was allowed to run to get there. */
  actualMs: number;
  /** Total the page has been allowed to run since the freeze. */
  tickMs: number;
  /** Total callbacks run since the freeze. */
  totalSteps: number;
  /** True when the page had nothing scheduled, so the step could not advance. */
  quiet: boolean;
  /** The callbacks this step ran through, in order. */
  ran: CallbackEntry[];
}

const sessions = new Map<string, AnnotateSession>();

/** Enough log to see a pattern, not enough to bloat a 250ms poll. */
const MAX_CALLBACK_LOG = 200;

/** Longest a single sequence step may take before the drive gives up on it. */
const STEP_TIMEOUT_MS = 45000;

/**
 * Turn a pause into a log line. The instrumentation name arrives as
 * "instrumentation:setTimeout.callback"; only the middle of that is worth
 * showing, and a frame with no function name is an anonymous callback.
 */
function describePause(session: AnnotateSession, event: any, at: number): CallbackEntry {
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
async function setInspectMode(session: AnnotateSession, armed: boolean): Promise<void> {
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
 * every later press in the control pane silently does nothing. A paused or
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
    debugLog('annotate', `${method}: ${error instanceof Error ? error.message : String(error)}`);
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
async function freeze(session: AnnotateSession): Promise<void> {
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
 * Let the page run again without leaving annotate mode. The step breakpoints
 * go first, or the resume would pause on the very next callback.
 */
async function unfreeze(session: AnnotateSession): Promise<void> {
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
 * Leave the page as annotate found it: running, with no agent of ours attached.
 *
 * Only annotate's own hold is released. A pause someone else set - a breakpoint
 * from the breakpoint tool, a `debugger` statement - is left stopped, because
 * resuming it would throw away what they stopped to look at and they would have
 * no way to know annotate did it.
 */
async function release(session: AnnotateSession): Promise<void> {
  await unfreeze(session);
  if (session.heldByOther) {
    debugLog('annotate', 'leaving a pause that is not ours in place');
  }
  await send(session.client, 'Debugger.disable');
}

/**
 * Hold the page, or let it run. Driving the app needs an unfrozen page - under
 * a freeze its JS is stopped, so a click reaches nothing - and picking works
 * either way, since Chrome's picker is browser-side.
 */
export async function setFrozen(connection: string, frozen: boolean): Promise<AnnotateSessionState | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  if (frozen) await freeze(session);
  else await unfreeze(session);
  // The picker survives the transition either way.
  await setInspectMode(session, session.pickerArmed).catch(() => {});
  return getAnnotateSession(connection);
}

/** Pause on every scheduled callback, which is what makes a step land on one. */
const STEP_EVENTS = ['setTimeout.callback', 'setInterval.callback', 'requestAnimationFrame.callback'];

async function ensureStepBreakpoints(session: AnnotateSession): Promise<void> {
  if (session.stepBreakpointsSet) return;
  for (const eventName of STEP_EVENTS) {
    await session.client.send('EventBreakpoints.setInstrumentationBreakpoint', { eventName } as any).catch(() => {});
  }
  session.stepBreakpointsSet = true;
}

/**
 * Whether another annotate session already holds this page.
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

export function getAnnotateSession(connection: string): AnnotateSessionState | undefined {
  const session = sessions.get(connection);
  if (!session) return undefined;
  const { client: _c, page: _p, control: _s, controlPage: _cp, pending: _pending, ...state } = session;
  return state;
}

export function isAnnotating(connection: string): boolean {
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
 * Commit the pending pick with the comment typed in the control pane.
 *
 * The note is stored in the open sequence, against the step on screen. With no
 * sequence open there is nowhere for it to go: the pick is held rather than
 * discarded, so the same pick saves once a sequence is selected, and the pane
 * states why on its failure line.
 */
export async function saveAnnotation(connection: string, comment: string): Promise<Annotation | undefined> {
  const session = sessions.get(connection);
  if (!session?.pending) return undefined;

  const active = session.sequences?.active();
  if (!active) {
    // Nothing to attach to yet. The pick is held rather than dropped, so
    // selecting a sequence and saving again keeps the element already picked.
    session.sequenceFailure = 'no sequence open - a note is stored in the step it belongs to';
    return undefined;
  }

  const target = session.pending;
  const annotation: Annotation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    url: session.page.url(),
    tick: session.tickMs,
    comment,
    target,
  };

  if (session.pickShots?.length) {
    annotation.screenshots = [...session.pickShots];
    session.pickShots = [];
  }

  const step = noteTargetStep(session, active.currentStep, active.total);
  const failure = await session.sequences!.attachAnnotation(step, annotation);
  if (failure) {
    session.sequenceFailure = failure;
    return undefined;
  }

  session.pending = null;
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
    selector: target.selector,
    // Once per session: on every note it buries the notes.
    ...(firstOfSession
      ? { review: getMessage('ANNOTATE_SELECTOR_REVIEW') }
      : {}),
    component: target.component,
    source: target.source?.fileName,
    sequence: `${active.name} step ${step + 1}/${active.total}`,
    detail: `${target.component ? target.component + ' ' : ''}${target.selector}${comment ? ` - "${comment}"` : ''}`,
  });

  await setInspectMode(session, true).catch(() => {});
  return annotation;
}

/** What the pane shows for the sequence card, whether or not one is running. */
export async function getSequenceState(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;

  const available = await session.sequences.listNames().catch(() => [] as string[]);

  // A recording has no open run to read; its steps come from what has been
  // clicked so far, so the list fills as the person works.
  if (session.recordingSequence) {
    const steps = session.sequences.recordedSoFar(
      await readCapturedEvents(session),
      session.recordingStartUrl ?? session.page.url()
    );
    await gateNewStep(session, connection, steps);
    return {
      available, steps, currentStep: steps.length, total: steps.length,
      busy: session.sequenceBusy, recording: true, variables: [],
      ...(session.pendingStep ? { pendingStep: session.pendingStep } : {}),
      ...(session.sequences.baseUrl() ? { baseUrl: session.sequences.baseUrl() } : {}),
      ...(session.sequenceFailure ? { failure: session.sequenceFailure } : {}),
    };
  }

  const active = session.sequences.active();
  if (!active) {
    return {
      available, steps: [], currentStep: 0, total: 0, busy: session.sequenceBusy, variables: [],
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
    ...(issue ? { issue } : {}),
    name: active.name,
    ...(active.description ? { description: active.description } : {}),
    currentStep: active.currentStep,
    total: active.total,
    busy: session.sequenceBusy,
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
      // nothing under the step it was just filed against.
      ...(step.annotations?.length ? { annotations: step.annotations } : {}),
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
  drive: (driver: SequenceDriver) => Promise<string | undefined>
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences || session.sequenceBusy) return getSequenceState(connection);

  session.sequenceBusy = true;
  session.sequenceFailure = undefined;
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
        drive(session.sequences!),
        new Promise<string>(resolve =>
          setTimeout(() => resolve('the step did not finish in time'), STEP_TIMEOUT_MS)),
      ]);
    });
  } catch (error) {
    debugLog('annotate', `sequence step failed: ${error}`);
  } finally {
    clearTimeout(unlatch);
    if (wasArmed) await setInspectMode(session, true).catch(() => {});
    session.sequenceBusy = false;
  }
  return getSequenceState(connection);
}

/**
 * Opening the session runs no steps, but replay still touches the page to set
 * itself up - it injects a replay cursor - and every replay call is refused
 * while the page is held, since the guard sees a connection paused at a
 * breakpoint. So selecting goes through the same release as a step.
 */
export const selectSequence = (connection: string, name: string) =>
  driveSequence(connection, (driver) => driver.start(name, connection));

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
  driveSequence(connection, (driver) => driver.step());

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

  let state = await getSequenceState(connection);
  const total = state?.total ?? 0;

  // Bounded by the step count: a step that fails ends the run, and one that
  // does not advance would otherwise loop forever.
  for (let guard = 0; guard <= total; guard++) {
    const before = state?.currentStep ?? 0;
    state = await stepSequence(connection);
    if (!state || state.failure) break;
    if (state.currentStep >= state.total) break;
    if (state.currentStep === before) break;
  }
  return state;
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
  withAgent = false
): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  if (session.sequenceBusy) return getSequenceState(connection);

  session.sequenceBusy = true;
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
    session.recordingStartUrl = session.page.url();
    session.recordingSequence = true;
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

  if (withAgent) await announceRecording(session, connection, name, cancelled);
  return getSequenceState(connection);
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
  session: AnnotateSession,
  connection: string,
  steps: SequenceStepView[]
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
 * after it queues behind that one - which takes the control pane's own polling
 * down with it. These run on the annotate client, which answers while held.
 */
async function evaluateInPage(session: AnnotateSession, expression: string): Promise<any> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result?.value;
}

/** Stop or resume the page's own capture, which the recorder checks per event. */
async function setCapturePaused(session: AnnotateSession, paused: boolean): Promise<void> {
  await evaluateInPage(session, `globalThis.__cdpRecordingPaused = ${paused ? 'true' : 'false'}`)
    .catch(() => {});
}

/** The raw events the page has buffered, as JSON. */
async function readCapturedEvents(session: AnnotateSession): Promise<string> {
  return (await evaluateInPage(session, 'JSON.stringify(globalThis.__cdpRecordingEvents || [])')
    .catch(() => '[]')) ?? '[]';
}

/** How many raw events the page holds, which a drop rewinds to. */
async function capturedEventCount(session: AnnotateSession): Promise<number> {
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
  session: AnnotateSession,
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
async function releaseForStep(session: AnnotateSession): Promise<void> {
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
  session: AnnotateSession,
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
  await session.sequences.stopRecording(connection).catch(() => {});
}

/** Abandon the recording in progress, saving nothing. */
export async function cancelRecordingSequence(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  // Gating stops before the driver is told: the poll runs every 250ms, and a
  // recording still marked live re-raises the step that was just abandoned.
  session.recordingWithAgent = false;
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

/** Where a pick is going, for the pane to state before it is saved. */
async function noteTargetFor(connection: string): Promise<{ noteTarget?: number; noteTargetLabel?: string }> {
  const session = sessions.get(connection);
  const active = session?.sequences?.active();
  if (!session || !active) return {};
  const step = noteTargetStep(session, active.currentStep, active.total);
  const command = active.steps[step];
  return { noteTarget: step, noteTargetLabel: command?.comment || command?.label || `step ${step + 1}` };
}

/**
 * The pen names a step; without one the run's own step is used, clamped - a
 * completed run sits one past its last command. The pane reads this too, or it
 * would state one step and save to another.
 */
function noteTargetStep(session: AnnotateSession, currentStep: number, total: number): number {
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

/** A capture waiting on the person: the image, and what it is of. */
export interface PendingShot {
  /** PNG bytes, base64 - shown in the pane and written only once accepted. */
  data: string;
  selector?: string;
  /** The note this capture joins when accepted, when it was taken from one. */
  annotationId?: string;
  /** How many parents out from the selector's own element the clip sits. */
  widen: number;
  /** What the clip actually covers, for the pane to state. */
  label: string;
}

/**
 * Take a capture and hold it; saveAnnotateScreenshot writes it once accepted.
 * `widen` walks up from the element the selector names, by that many parents.
 */
export async function captureAnnotateScreenshot(
  connection: string,
  selector?: string,
  widen = 0,
  annotationId?: string
): Promise<{ shot: PendingShot } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session) return { failure: 'annotate mode is not running here' };
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
export async function saveAnnotateScreenshot(connection: string): Promise<{ path: string } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session?.pendingShot) return { failure: 'nothing is waiting to be saved' };
  const shot = session.pendingShot;

  try {
    const date = new Date().toISOString().split('T')[0];
    const dir = getOutputPath('screenshots', date);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, `${shotFilename(shot)}.png`);
    await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
    session.pendingShot = null;

    // Where the capture goes, in the order the cases can arise: taken from a
    // note, it joins that note; taken while a pick is waiting, it joins the
    // note that pick becomes; taken with neither, it stands on its own.
    if (shot.annotationId && session.sequences) {
      const failure = await session.sequences.attachScreenshot(shot.annotationId, file);
      if (failure) session.sequenceFailure = failure;
    } else if (session.pending) {
      session.pickShots = [...(session.pickShots ?? []), file];
    }

    await appendEvent(session.session, 'screenshot', {
      connection,
      path: file,
      url: session.page.url(),
      ...(shot.selector ? { selector: shot.selector } : {}),
      detail: `screenshot of ${shot.label} at ${file}`,
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
  session: AnnotateSession,
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

  const found = session.sequences.findAnnotation(id);
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
    selector: annotation.target.selector,
    component: annotation.target.component,
    source: annotation.target.source?.fileName,
    sequence: `${sequence} step ${step + 1}`,
    review: getMessage('ANNOTATE_NOTIFY_REVIEW'),
    detail: `look at this: ${annotation.comment || '(no comment)'} - ${annotation.target.selector}`,
  });
}

/** Erase one note from the open sequence and write the file back. */
export async function removeAnnotation(connection: string, id: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const failure = await session.sequences.detachAnnotation(id).catch(error => String(error));
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

export async function startAnnotateMode(params: {
  page: Page;
  connection: string;
  sessionName: string;
  /** Owns original source text - see SourceMapHandler.getOriginalContent. */
  sourceMapHandler?: { registerSourceMap: (scriptUrl: string, sourceMapURL: string) => void; getOriginalContent: (source: string) => Promise<string | null> };
  /** Drives replay's own step-through session; annotate never re-implements it. */
  sequences?: SequenceDriver;
  /** Opens the control tab. Omitted in tests, which drive the handlers directly. */
  openControlTab?: (url: string) => Promise<Page | undefined>;
}): Promise<AnnotateSessionState> {
  const { page, connection, sessionName, openControlTab, sourceMapHandler, sequences } = params;
  const readOriginal = sourceMapHandler
    ? (fileName: string) => sourceMapHandler.getOriginalContent(fileName)
    : undefined;

  const existing = sessions.get(connection);
  if (existing) {
    await setInspectMode(existing, true);
    return getAnnotateSession(connection)!;
  }

  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('Overlay.enable');
  await client.send('Runtime.enable');
  await client.send('Animation.enable');

  const session: AnnotateSession = {
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
    controlUrl: '',
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
    // statement. Recorded so it can be reported; annotate still releases its
    // own hold normally, but never attaches a second agent to force theirs.
    if (!session.pauseRequested) {
      session.heldByOther = true;
      debugLog('annotate', `page stopped by something else: reason=${event?.reason}`);
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

      // Chrome disarms its picker once it fires; the control pane shows that,
      // and re-arms when the pick is saved or discarded.
      session.pickerArmed = false;
      session.picks++;
      session.pending = target;
    } catch (error) {
      debugLog('annotate', `pick failed: ${error}`);
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
      debugLog('annotate', `re-arm after navigation failed: ${error}`);
    }
  });
  await client.send('Page.enable');

  const control = await startControlServer({
    getState: async (): Promise<ControlState> => ({
      connection,
      url: page.url(),
      frozen: session.frozen,
      pickerArmed: session.pickerArmed,
      tickMs: session.tickMs,
      totalSteps: session.totalSteps,
      lastTick: session.lastTick,
      callbacks: session.callbacks.slice(-50),
      sequence: await getSequenceState(connection),
      pending: session.pending,
      noteStep: session.noteStep,
      ...(await noteTargetFor(connection)),
      ...(session.pendingShot ? { shot: session.pendingShot } : {}),
    }),
    save: async (comment: string) => { await saveAnnotation(connection, comment); },
    discard: async () => { await discardPick(connection); },
    tick: async (request: { steps?: number; budgetMs?: number }) => { await tickAnnotateMode(connection, request); },
    setPicker: async (armed: boolean) => { await setPicker(connection, armed); },
    setFrozen: async (frozen: boolean) => { await setFrozen(connection, frozen); },
    selectSequence: async (name: string) => { await selectSequence(connection, name); },
    gotoSequenceStep: async (step: number) => { await gotoSequenceStep(connection, step); },
    stepSequence: async () => { await stepSequence(connection); },
    playSequence: async () => { await playSequence(connection); },
    cancelSequence: async () => { await cancelSequence(connection); },
    removeSequence: async (name: string) => { await removeSequence(connection, name); },
    dismissFailure: async () => { await dismissSequenceFailure(connection); },
    keepRecordedStep: async () => { await keepRecordedStep(connection); },
    chooseStepSelector: async (index: number) => { await chooseStepSelector(connection, index); },
    flagRecordedStep: async (reason: string, options?: Array<{ selector: string; note: string }>, detail?: string) => {
      await flagRecordedStep(connection, reason, options, detail);
    },
    dropRecordedStep: async () => { await dropRecordedStep(connection); },
    recordSequence: async (name: string, withAgent: boolean) => { await recordSequence(connection, name, withAgent); },
    stopRecordingSequence: async () => { await stopRecordingSequence(connection); },
    cancelRecordingSequence: async () => { await cancelRecordingSequence(connection); },
    removeSequenceStep: async (index: number) => { await removeSequenceStep(connection, index); },
    moveSequenceStep: async (from: number, to: number) => { await moveSequenceStep(connection, from, to); },
    setSequenceVariable: async (name: string, value: string) => { await setSequenceVariable(connection, name, value); },
    removeSequenceVariable: async (name: string) => { await removeSequenceVariable(connection, name); },
    noteAtStep: async (step: number) => { await noteAtStep(connection, step); },
    removeAnnotation: async (id: string) => { await removeAnnotation(connection, id); },
    notifyAnnotation: async (id: string) => { await notifyAnnotation(connection, id); },
    captureScreenshot: async (selector: string | undefined, widen: number, annotationId?: string) => {
      const held = sessions.get(connection);
      if (!held) return;
      const taken = await captureAnnotateScreenshot(connection, selector, widen, annotationId);
      held.sequenceFailure = 'failure' in taken ? taken.failure : undefined;
    },
    saveScreenshot: async () => {
      const held = sessions.get(connection);
      if (!held) return;
      const saved = await saveAnnotateScreenshot(connection);
      held.sequenceFailure = 'failure' in saved ? saved.failure : undefined;
    },
    discardScreenshot: async () => {
      const held = sessions.get(connection);
      if (held) held.pendingShot = null;
    },
    highlightAnnotation: async (selector: string) => { await highlightAnnotation(connection, selector); },
    setBaseUrl: async (baseUrl: string) => { await setSequenceBaseUrl(connection, baseUrl); },
  });
  session.control = control;
  session.controlUrl = control.url;


  if (openControlTab) {
    try {
      session.controlPage = await openControlTab(control.url);
      // Closing the tab is how someone finishes: it releases the page and takes
      // the server with it, so there is no button that has to be found first.
      // stopAnnotateMode closes this tab itself, which re-enters here - by then
      // the session is already gone, so the second pass is a no-op.
      session.controlPage?.on('close', () => {
        void stopAnnotateMode(connection).catch((error) => {
          debugLog('annotate', `cleanup after control tab closed failed: ${error}`);
        });
      });
    } catch (error) {
      debugLog('annotate', `control tab failed to open: ${error}`);
    }
  }

  return getAnnotateSession(connection)!;
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
export async function tickAnnotateMode(
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
        debugLog('annotate', `step: resume failed: ${error}`);
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

export async function stopAnnotateMode(connection: string): Promise<AnnotateSessionState | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  sessions.delete(connection);

  const state = getStateOf(session);
  const { client } = session;
  try {
    await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG } as any);
    await release(session);
    await client.send('Overlay.disable');
    await client.detach();
  } catch (error) {
    debugLog('annotate', `stop cleanup failed: ${error}`);
  }
  // The control tab closes after the server, so its last poll fails and the
  // page says so rather than hanging on a dead port.
  try {
    await session.control?.close();
    await session.controlPage?.close();
  } catch (error) {
    debugLog('annotate', `control pane cleanup failed: ${error}`);
  }
  return state;
}

function getStateOf(session: AnnotateSession): AnnotateSessionState {
  const { client: _c, page: _p, control: _s, controlPage: _cp, pending: _pending, ...state } = session;
  return state;
}

/** Drop state for a connection that has gone away, without touching CDP. */
export function forgetAnnotateSession(connection: string): void {
  const session = sessions.get(connection);
  sessions.delete(connection);
  void session?.control?.close().catch(() => {});
}
