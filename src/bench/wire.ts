/**
 * The shapes that cross between the bench server and the bench page.
 *
 * Outside `frontend/` because the root tsconfig excludes that directory, and a
 * type declared inside it binds nothing on the server. `tsconfig.bench.json`
 * is what makes a disagreement between the two sides a build error.
 */

import type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';

export type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';

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

/** A sequence step as the bench shows it. */
export interface SequenceStep {
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
  /** When the action that produced this step happened, by the page's clock. */
  at?: number;
  /** What crossed the boundary while this step was being taken. */
  traffic?: StepTraffic;
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

/** One sequence as the list shows it, before anything is opened. */
export interface SequenceCard {
  name: string;
  steps: number;
  notes: number;
  description?: string;
  expectedOutcome?: string;
}

/** A step held while the agent reads it, and whether it needs the person. */
export interface HeldStep {
  index: number;
  label: string;
  verdict: 'validating' | 'flagged';
  /** One line: what is wrong. */
  reason?: string;
  /** A second line of context, where it helps. */
  detail?: string;
  /** Selectors that would work here, one row each for the person to pick. */
  options?: Array<{ selector: string; note: string }>;
}

export interface SequenceState {
  /** Names that can be selected - saved on disk, plus anything in memory. */
  available: string[];
  /** The same set with enough on each to choose between them. */
  catalogue: SequenceCard[];
  name?: string;
  steps: SequenceStep[];
  currentStep: number;
  total: number;
  /** Set while a step or a play is mid-flight, so the page can disable itself. */
  busy: boolean;
  /**
   * Set while a play is walking the steps, and not for a single step.
   *
   * A step is brief and finishes or fails on its own, so a control to stop it
   * has nothing to act on - and a bar that grows one while the step runs
   * changes shape twice for something that lasted a moment.
   */
  playing?: boolean;
  /**
   * Set when a play was stopped by hand and left standing on its step.
   *
   * A run that stopped because someone asked and a run that reached its end
   * both sit still with nothing in flight; without this the screen states
   * neither, and the only sign a pause landed is a control disappearing.
   */
  paused?: boolean;
  /** What the sequence describes itself as doing. */
  description?: string;
  /** What it should end up having done, in the recorder's own words. */
  expectedOutcome?: string;
  /**
   * Set while the agent reviews each step as it lands.
   *
   * The page is held and the capture paused for every step in this mode, so
   * the bench states it: a held page with nothing saying why reads as a hang.
   */
  withAgent?: boolean;
  /** Values the run is carrying, newest capture last. */
  variables: SequenceVariable[];
  /** Set when the last step failed, which ends replay's session. */
  failure?: string;
  /** Origin every absolute URL in the run is rewritten onto, when set. */
  baseUrl?: string;
  /** Set while clicks in the page are being recorded into a new sequence. */
  recording?: boolean;
  /** The step capture is held on, and whether it needs the person. */
  pendingStep?: HeldStep;
  /** The tracked issue this sequence reproduces, when one references it. */
  issue?: { id: number; type: string; title: string };
}

/** A capture waiting on the person: the image, and what it is of. */
export interface PendingShot {
  /** PNG bytes, base64 - shown in the bench and written only once accepted. */
  data: string;
  selector?: string;
  /** The note this capture joins when accepted, when it was taken from one. */
  annotationId?: string;
  /** How many parents out from the selector's own element the clip sits. */
  widen: number;
  /** What the clip actually covers, for the bench to state. */
  label: string;
}

/**
 * What `GET /state` answers with, which is everything the page draws from.
 *
 * Distinct from the report the tool returns to the agent: this is read four
 * times a second by a browser, that is read once by whoever called `bench`.
 */
export interface BenchView {
  connection: string;
  /** The page being driven. Not the address the bench itself is served at. */
  pageUrl: string;
  frozen: boolean;
  pickerArmed: boolean;
  tickMs: number;
  totalSteps: number;
  lastTick?: TickResult;
  /** Tail of the callback log, oldest first. */
  callbacks: CallbackEntry[];
  /** Absent when no sequence driver is wired in. */
  sequence?: SequenceState;
  pending: AnnotationTarget | null;
  /** The step a note would land on right now, chosen or fallen back to. */
  noteTarget?: number;
  /**
   * Whether this copy of the bench owns the caret.
   *
   * Set per caller from the `client` the poll carries, so a second copy of the
   * page renders without stealing focus from the one being typed into.
   */
  primary: boolean;
  /** A capture taken and waiting on the person. */
  shot?: PendingShot;
}

/** One thing the proxy saw cross, as the bench receives it. */
export interface BoundaryEvent {
  id: string;
  at: number;
  kind: 'request' | 'frame';
  direction: 'out' | 'in';
  url: string;
  method?: string;
  status?: number;
  size: number;
  contentType?: string;
  durationMs?: number;
  preview?: string;
  heldAs?: 'replaced' | 'dropped' | 'refused';
  /** The response is still arriving - a stream, rather than a finished call. */
  open?: boolean;
  commandIndex?: number;
  runId?: string;
  step?: number;
  level: 'observed' | 'likely' | 'positional' | 'unprompted';
  owned: boolean;
  root?: string;
  verdict?: string;
  evidence?: { shape?: string; [key: string]: unknown };
}

/** What the boundary holds, in the counts a reader needs at a glance. */
export interface BoundaryTotals {
  events: number;
  requests: number;
  failed: number;
  out: number;
  in: number;
  owned: number;
  free: number;
  ruled: number;
  shapesRuled: number;
  holds: number;
  levels: Record<string, number>;
  roots: Record<string, number>;
  sockets: { idle: number; reply: number; push: number; open: number };
}

/**
 * One decision about a kind of traffic, standing until it is cleared.
 *
 * Keyed on the path for a request and on the recorded payload for a frame,
 * which is the same coarseness the proxy's own pin matches at. A second
 * decision about the same key replaces the first rather than joining it, so
 * the set never holds two rules that contradict each other.
 */
export interface BoundaryRule {
  key: string;
  /**
   * answer - the sequence serves this instead of the server.
   * block  - it never leaves the browser.
   * hide   - it stays out of the list, and no traffic is changed.
   */
  verb: 'answer' | 'block' | 'hide';
  /** A frame rule matches on payload text; a request rule matches on the path. */
  frame?: boolean;
  /**
   * The method the request crossed with. A path alone is one match for every
   * verb on it, so a rule staged from a POST otherwise answers the GET too.
   */
  method?: string;
  /**
   * The replay step the crossing was staged under.
   *
   * Bounds the rule to that position in the run: the same call at another
   * position reaches the server, so an order the recording did not have fails
   * where the server checks it rather than being served over. Absent on a
   * rule staged from the live stream, which answers at every position.
   */
  step?: number;
  /** answer: what is served in its place. */
  body?: string;
  /** answer, for a request: the status served with it. */
  status?: string;
  /** The payload as it was recorded, so an edited answer reads as edited. */
  recorded?: string;
  /** What the row said, for a rule whose traffic has not crossed this run. */
  label?: string;
  /**
   * The socket the frame crossed on, and which way it went.
   *
   * A frame carries no method, path or status, so the payload text is the
   * whole of what a rule matches on. Recorded alongside it, these bound that
   * text to the one connection and one direction it was read from: an app with
   * two sockets carrying a common payload shape otherwise has every rule
   * answering on both, and a rule made from a received frame otherwise
   * replaces the sent frame that prompted it.
   */
  url?: string;
  direction?: 'out' | 'in';
  /** Times the proxy has answered from this rule. A rule that never fires is
   *  one whose matcher has stopped matching. */
  hits?: number;
  /**
   * How the armed pin compares a frame: one top-level JSON field by value,
   * or characters anywhere in the payload. Read off the pin, never stored:
   * the key's form selects it.
   */
  matchedAs?: 'field' | 'text';
  /**
   * The constraint values the crossing was recorded with.
   *
   * Dropping a constraint removes it from the rule, and the value it held is
   * the only thing that binds it back. Held apart from the active
   * constraints, so the editor still offers the binding after it has been
   * dropped; a pin is armed from the active constraints alone and never
   * reads these.
   */
  staged?: {
    step?: number;
    method?: string;
    url?: string;
    direction?: 'out' | 'in';
  };
}

/** What `GET /proxy/events` answers with. */
export interface BoundaryState {
  running: boolean;
  /** Hosts this browser may reach. Empty means every host. */
  allowed: string[];
  refused: number;
  /** Whether an unmatched POST, PUT, PATCH or DELETE is answered 403. */
  refusesWrites: boolean;
  /** Writes answered 403 under that setting. */
  refusedWrites: number;
  /** Every decision standing against this connection's traffic. */
  rules: BoundaryRule[];
  /** Steps told to wait, and how many arrivals each waits for. */
  waits: Array<{ step: number; count: number }>;
  /**
   * Which hosts were refused, and how often.
   *
   * A count alone names a black hole without saying where it is: a scope that
   * excludes the app under test reads as the app being broken.
   */
  refusals: Array<{ host: string; count: number }>;
  events: BoundaryEvent[];
  totals: BoundaryTotals | null;
  /**
   * The open sequence's steps, by index and call.
   *
   * A rule is bound to a position in the run, and this screen holds the rules
   * without holding the sequence. Without these the only positions on offer
   * are the ones traffic has already crossed under, so a rule cannot be bound
   * to a step the run has not yet reached.
   */
  steps: Array<{ index: number; label: string }>;
  /**
   * The open sequence's name.
   *
   * A step is a position, not a call, and the positions above are that
   * sequence's. Opening another sequence drops every rule and arms that one's
   * own, so each rule listed is a decision of the sequence named here - which
   * is what the name states, and why a rule carries no sequence of its own.
   */
  forSequence?: string;
}
