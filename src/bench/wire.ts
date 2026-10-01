/**
 * The shapes that cross between the bench server and the bench page.
 *
 * Outside `frontend/` because the root tsconfig excludes that directory, and a
 * type declared inside it binds nothing on the server. `tsconfig.bench.json`
 * is what makes a disagreement between the two sides a build error.
 */

import type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';
import type { ExpectedValue } from './kinds.js';

export type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';

/** One callback the page ran, as a step passed through it. */
export interface CallbackEntry {
  /** Position in the run since the hold, 1-based. */
  index: number;
  /** Page milliseconds this callback landed at, measured from the hold. */
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
  /** Total the page has been allowed to run since the hold. */
  tickMs: number;
  /** Total callbacks run since the hold. */
  totalSteps: number;
  /** True when the page had nothing scheduled, so the step could not advance. */
  quiet: boolean;
  /** The callbacks this step ran through, in order. */
  ran: CallbackEntry[];
}

/** One step a check's sequence ran, and the sequence it ran in turn. */
export interface RanStep {
  tool: string;
  line: string;
  /** A check's parameters, which its answer's words are read from. */
  params?: Record<string, unknown>;
  success: boolean;
  error?: string;
  check?: {
    outcome: 'held' | 'failed'; action: 'continue' | 'stop' | 'run'; subject?: string; found?: string;
    waitedMs?: number; limitMs?: number;
  };
  branch?: { name: string; ranSteps: RanStep[] };
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
  /** The value it stores, where it stores a fixed one rather than reading the page. */
  stores?: string;
  /** The variables it reads, by the `{{var:name}}` tokens in what it is given. */
  reads?: string[];
  /** The tool it calls and what it is given, for editing a saved step. */
  tool?: string;
  params?: Record<string, unknown>;
  /** When the action that produced this step happened, by the page's clock. */
  at?: number;
  /** What crossed the boundary while this step was being taken. */
  traffic?: StepTraffic;
  /** Payloads marked on this step's kinds as having to hold on replay, by kind. */
  expected?: Record<string, ExpectedValue>;
  /** Notes taken against this step, in the order they were made. */
  annotations?: Annotation[];
  /** When this step was put into the sequence; absent once a baseline has taken it in. */
  addedAt?: number;
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
  /** What kind of sequence it is, as `replay declare` set; `runAll` selects by these. */
  tags?: string[];
}

/**
 * What one step of a run did, counted by category. `state` is absent where no
 * bench watched the browser, since only a bench's write watch sees storage.
 */
export interface StepTally {
  requests: number;
  frames: number;
  intercepted: number;
  state?: number;
  /** How long the step ran, in ms. */
  ms?: number;
  check?: StepCheck;
}

/**
 * How a check, assert or wait step read, and what the run did on it: carried
 * on, stopped, or ran another sequence. An assert or a wait records no reading
 * of its own, so it has the outcome and action alone: held, or failed and stopped.
 */
export interface StepCheck {
  outcome: 'held' | 'failed';
  action: 'continue' | 'stop' | 'run';
  subject?: string;
  found?: string;
  waitedMs?: number;
  limitMs?: number;
  /** The sequence the reading ran: its steps, and how many of them failed. */
  ran?: { name: string; steps: number; failed: number };
  error?: string;
}

/** One run of a sequence, going or ended: a replay run, or a bench's own play. */
export interface RunRow {
  /** The replay run's id, which stops it; a bench play is stopped by its connection. */
  runId?: string;
  sequence: string;
  connection?: string;
  via: 'replay' | 'bench';
  status: string;
  /** 1-based step running now, or reached. */
  step: number;
  total: number;
  /** The tool that step calls. */
  tool?: string;
  startedAt: number;
  endedAt?: number;
  failure?: string;
  suite?: { id: string; label: string };
  /** Per step, by position, what it did. */
  steps?: StepTally[];
}

/** One `runAll`: what chose its sequences, and how many have ended and failed. */
export interface SuiteRow {
  id: string;
  label: string;
  names: string[];
  done: number;
  failed: number;
  startedAt: number;
  endedAt?: number;
}

/** What `GET /runs` answers with: runs going now, suites, and runs that ended, newest first. */
export interface RunsView {
  running: RunRow[];
  suites: SuiteRow[];
  finished: RunRow[];
}

/**
 * One sequence's steps, read from its file when its row opens. Kept off the
 * card because the card rides every state poll, and the steps of every
 * sequence on disk would ride with it.
 */
export interface SequenceOutline {
  startUrl?: string;
  /** `params` is carried for a check, assert or wait step, whose answer is worded from them. */
  steps: Array<{ label: string; tool: string; notes: number; params?: Record<string, unknown> }>;
  teardown: string[];
}

/** One tool call this devharness ran, as its History row lists it. */
export interface HistoryEntry {
  /** The index `replay repeat` takes. */
  index: number;
  at: number;
  tool: string;
  /** The action and what it acted on, without the tool's name. */
  label: string;
  connection?: string;
  /** The channel the call came in on; a run's step carries the channel its run was started from. */
  from: 'mcp' | 'cli' | 'bench';
  /** The sequence whose run executed this call as a step. */
  run?: string;
  /** Absent while the call is still running. */
  failed?: boolean;
  /** The first line the call returned. */
  said?: string;
}

/** One call opened: what it was given and all the text it returned. */
export interface HistoryDetail {
  params: Record<string, unknown>;
  /** Absent while the call is still running. */
  result?: string;
}

/** One tracked issue, as the Issues tab lists it; times are epoch milliseconds. */
export interface IssueRow {
  id: number;
  type: 'bug' | 'feature';
  status: 'pending' | 'acknowledged' | 'in_progress' | 'fixed' | 'implemented';
  title: string;
  /** Markdown, shown as written. */
  body: string;
  labels: string[];
  comments: Array<{ at: number; text: string }>;
  /** The repro sequence's file in the issues folder, where one is linked. */
  sequenceFile?: string;
  reportedAt: number;
  resolvedAt?: number;
  /** How the issue stands against GitHub, from what the tracker recorded at the last sync; absent while it is local only. */
  github?: IssueSync;
}

/**
 * One linked issue against GitHub, read from the local file alone. It holds
 * what changed here since the two last agreed; what changed upstream needs
 * `issues sync`, which asks GitHub.
 */
export interface IssueSync {
  number: number;
  /** owner/name, where the link recorded one; otherwise the repo gh infers for the project. */
  repo?: string;
  /** When the two last agreed; absent for a link never synced. */
  syncedAt?: number;
  /** The body differs from the one hashed at the last sync, so the next sync pushes it. */
  bodyChanged: boolean;
  /** Comments carrying no GitHub marker, so the next sync pushes them. */
  unpushedComments: number;
  /** Marked for sync; an unmarked linked issue is left out of every sync. */
  marked: boolean;
  /** Marked or left out by someone; false while nobody has decided, which is what the bench offers. */
  decided: boolean;
}

/** A note written against a step of a saved sequence, for quoting into an issue. */
export interface SequenceNote {
  sequence: string;
  /** The file, relative to its sequences folder; an issue's `sequenceFile` names one the same way. */
  file: string;
  /** 1-based, as the step list numbers it. */
  step: number;
  stepLabel: string;
  comment: string;
  at: string;
  url: string;
  selector?: string;
  component?: string;
  /** file:line, from a dev build's JSX source. */
  source?: string;
  /** Capture files taken with the note. */
  screenshots?: string[];
}

/** A dev server devharness manages, as the Running tab's Servers section lists it. */
export interface ServerRow {
  id: string;
  command: string;
  cwd: string;
  running: boolean;
  pid: number;
  port?: number;
  /** How long it has run, as `12m 3s`. */
  uptime: string;
  runnerType: string;
  autoRun: boolean;
  /** Where a change restarts it, for a server started with `watch`. */
  watchPaths?: string[];
}

/** One connection this session holds, as `connection list` reads it. */
export interface ConnectionRow {
  name: string;
  type: string;
  port: number;
  active: boolean;
  connected: boolean;
  paused: boolean;
  url?: string;
  title?: string;
}

/**
 * What runs alongside the bench besides its servers: this session's event
 * stream and the watch reading it, the directories devharness reloads
 * sequences from, and the connections.
 */
export interface RunningView {
  stream: string;
  /** Processes holding the stream open; absent where lsof gave no reading. */
  readers?: number;
  /** Events written past what a watch has read; absent before any watch has run. */
  unread?: number;
  /** The call that arms a watch, for when none reads the stream. */
  watchCall: string;
  sequenceDirs: string[];
  connections: ConnectionRow[];
}

/**
 * The end of one server's log, read from the file devharness writes it to.
 * A runner with no log file (Docker) answers with the command that shows its
 * logs instead.
 */
export interface ServerLog {
  path?: string;
  /** The last bytes of the file, cut back to a whole first line. */
  text?: string;
  /** The file's whole size in bytes, so the page can say how much it holds. */
  size?: number;
  command?: string;
  /** Why nothing could be read: no such server, or no log kept. */
  unavailable?: string;
}

/** A tool call starred from History, listed under Favourites on the Tools tab. */
export interface ToolFavourite {
  id: string;
  tool: string;
  /** The History row's label: the action and what it acted on. */
  label: string;
  args: Record<string, unknown>;
  at: number;
}

/** One tool as `listTools` gives it, for the tools tab. */
export interface ToolCard {
  name: string;
  description: string;
  /** JSON Schema of the arguments; the tab builds its starting payload from it. */
  inputSchema: Record<string, unknown>;
}

/** The tools one toolset builds, in the order `listTools` gives them. */
export interface ToolGroup {
  name: string;
  tools: ToolCard[];
}

/** Names devharness holds, offered as values in the tools tab's form. */
export interface ToolValues {
  /** Live connections, by name. */
  connections: string[];
  /** Managed servers, running or saved. */
  servers: string[];
  /** Sequences in memory or saved on disk. */
  sequences: string[];
  /** Named persistent Chrome profiles. */
  profiles: string[];
}

export const NO_TOOL_VALUES: ToolValues = { connections: [], servers: [], sequences: [], profiles: [] };

/** What a call from the tools tab returned: the response text, and whether it failed. */
export interface ToolRun {
  failed: boolean;
  result: string;
  /** The response's `_meta`, for a page that acts on what the call found rather than its words. */
  meta?: Record<string, any>;
  /** A parameter error's fields, each with what is wrong with it, which the form marks. */
  parameters?: Record<string, string>;
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
  /** Where a kind of traffic is listed and compared, by where it crossed: `"3|kind"` or `"after|kind"` → step, the step count being the gutter. */
  placements?: Record<string, number>;
  currentStep: number;
  total: number;
  /** Set while a step or a play is mid-flight, so the page can disable itself. */
  busy: boolean;
  /**
   * The step running now, and the position inside it when it runs another
   * sequence, read from the replay's cursor. Absent between steps.
   */
  runningAt?: { step: number; within?: number[] };
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
  /**
   * A recording going into another sequence: its name, the step the new
   * steps follow, and that sequence's step labels, for the list to show the
   * recording in its place.
   */
  into?: { name: string; after: number; labels: string[] };
  /** Set when the last step failed, which ends replay's session. */
  failure?: string;
  /** Origin every absolute URL in the run is rewritten onto, when set. */
  baseUrl?: string;
  /** Set while clicks in the page are being recorded into a new sequence. */
  recording?: boolean;
  /** When the recording began, in ms since the epoch: what crossed before it is not the recording's. */
  recordingSince?: number;
  /** The step capture is held on, and whether it needs the person. */
  pendingStep?: HeldStep;
  /** The tracked issue this sequence reproduces, when one references it. */
  issue?: { id: number; type: string; title: string };
  /** A browser dialog open over the app's page: the run waits on it. */
  dialog?: BenchDialog;
}

/** An alert, confirm, prompt, "leave this page?" dialog or file picker over the app's page. */
export interface BenchDialog {
  /** One line: what the person does, or the dialog's own question. */
  text: string;
  /** Why it stands this way, for the tooltip. */
  why?: string;
  /** action: the run waits on the person; info: the sequence answers it itself. */
  kind: 'action' | 'info';
  /**
   * What the bench can answer it with: OK alone for an alert, OK and Cancel
   * for the others, Cancel alone for a picker a step holds, and nothing for a
   * picker on screen, which a person answers in the app's window.
   */
  answers: Array<'accept' | 'cancel'>;
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
  kind: CaptureKind;
  /** Where the viewport sat, in the image's pixels, drawn as a mark on a page capture. */
  viewportMark?: CaptureRect;
  /** The page's own stop, when the page was held inside a function. */
  pause: CapturePause;
  /** Which element facts were read with it, and so can be kept. */
  facts: FactKind[];
}

/** The element; what the window showed; the whole document. */
export type CaptureKind = 'element' | 'screen' | 'page';

export type FactKind = 'events' | 'css' | 'html' | 'a11y';

export interface CaptureRect { x: number; y: number; w: number; h: number; }

/**
 * Where the page's JS stood when it was captured.
 *
 * A held page with nothing running has no location: the pause is armed for the
 * next callback and `taken` is false. Taken, the frame is the one the page is
 * stopped in, and the picture is the page as that line leaves it.
 */
export interface CapturePause {
  taken: boolean;
  fn?: string;
  url?: string;
  line?: number;
  /** The bench's own hold, a breakpoint, or the reason V8 gave for any other stop. */
  by?: string;
}

/**
 * What a capture was taken from, carried inside its PNG.
 *
 * Enough to take it again: the page, the window size, the region and how to
 * find it once the layout has moved. A retake is a new file with the same
 * `series` and the next `version`.
 */
export interface CaptureRecord {
  /** Version 1's file name without `.png`; every retake carries the same one. */
  series: string;
  version: number;
  at: string;
  url: string;
  kind: CaptureKind;
  viewport: { width: number; height: number; dpr: number };
  document: { width: number; height: number };
  /** Image pixels per CSS px in this file's capture, measured from the image. */
  scale: number;
  /** Screen and page-with-viewport captures only. */
  scroll?: { x: number; y: number };
  /** The viewport's rectangle in document CSS px, on a page capture drawn with one. */
  viewportMark?: CaptureRect;
  element?: { selector: string; widen: number; box: CaptureRect; tag: string };
  /**
   * The element holding a crop of a screen or page capture, and the crop's
   * offset from its corner, so a crop follows the content when the layout
   * above it moves.
   */
  anchor?: { selector: string; offset: { x: number; y: number } };
  /** In CSS px, measured from the element's corner, the viewport's, or the document's. */
  crop?: CaptureRect & { from: 'element' | 'viewport' | 'document' };
  frozen: boolean;
  pause: CapturePause;
  facts?: FactKind[];
  /** Set on a retake: how it differs from the version it was compared against. */
  compared?: CaptureComparison;
}

export interface CaptureComparison {
  against: number;
  changed: number;
  edges: number;
  share: number;
  box?: CaptureRect;
  size: { before: [number, number]; after: [number, number] };
  /** How the region was found again: by the element, the crop's anchor, or the stored rectangle. */
  placedBy: 'element' | 'anchor' | 'rectangle';
  /**
   * Image px per CSS px of the two captures, set when they differ. Their pixels
   * then do not line up, and `changed` and `share` measure the scaling.
   */
  scales?: [number, number];
  /**
   * Set when the window was not at the recorded size and was set to it for
   * the retake: width, height and pixel ratio before and during. `ran` is set
   * when a held page was let run while the size changed, so its handlers could
   * lay it out - the page may have moved on by that much.
   */
  resized?: {
    from: [number, number, number];
    to: [number, number, number];
    ran: boolean;
    /**
     * Set when the tab was in the background: Chrome renders no frames there
     * and so fires no resize handlers, and layout set by script kept the old size.
     */
    hidden?: boolean;
  };
  /** One line per element fact that changed. */
  factChanges?: string[];
}

/** One version of a capture series, for the bench to list under a finding. */
export interface CaptureVersion {
  version: number;
  path: string;
  at: string;
  compared?: CaptureComparison;
}

export interface HeldLayerView {
  layer: 'code' | 'ui' | 'network';
  source: 'bench' | 'tool' | 'sequence' | 'breakpoint' | 'trigger';
  /** Epoch ms the layer was held at. */
  since: number;
  /** The layer whose hold stops this one: the screen's hold stops the code. */
  via?: 'code' | 'ui' | 'network';
  /** The layer whose pause still holds this one after that layer was released. */
  keptBy?: 'code' | 'ui' | 'network';
  standing?: Record<string, unknown>;
}

export interface QueuedView {
  id: number;
  kind: 'frame' | 'response';
  url: string;
  direction?: 'sent' | 'received';
  preview?: string;
  /** How long it has waited: past the app's own timeout, the request has already failed. */
  ageMs: number;
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
  /** Each layer held - code, ui, network - with what holds it; empty while everything runs. */
  held: HeldLayerView[];
  /** Traffic kept at the proxy while the network is held, oldest first. */
  queued: QueuedView[];
  /** The layers this page can hold: code needs the debugger, ui the bench, network the proxy. */
  holdable: Array<HeldLayerView['layer']>;
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
  /**
   * Set while the capture dialog is open: the picker is armed for a capture,
   * and `heldBefore` records a hold that was already on, which closing the
   * dialog leaves in place. `annotationId` is the note the capture joins.
   */
  shotArmed?: { heldBefore: boolean; annotationId?: string };
  /** The element facts ticked in the capture dialog, kept between captures. */
  factChoice: FactKind[];
  /** Every version of each capture the open sequence cites, keyed by version 1's path. */
  series?: Record<string, CaptureVersion[]>;
}

/** One thing the proxy saw cross, as the bench receives it. */
export interface BoundaryEvent {
  id: string;
  at: number;
  /** `write` is a change no network carries: storage the page wrote, a socket it closed, a worker it started or stopped. */
  kind: 'request' | 'frame' | 'write';
  direction: 'out' | 'in';
  url: string;
  method?: string;
  status?: number;
  size: number;
  contentType?: string;
  durationMs?: number;
  preview?: string;
  answeredAs?: 'replaced' | 'dropped' | 'refused';
  /** The response is still arriving - a stream, rather than a finished call. */
  open?: boolean;
  commandIndex?: number;
  runId?: string;
  step?: number;
  /** The position inside `step` it crossed at, when that step ran another sequence. */
  within?: number[];
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
  /**
   * A saved payload served in place of `body`, by name, read from its file
   * each time the replacement is armed, so a change to the file reaches every
   * replacement serving it. `body` holds its content as last read.
   */
  payload?: string;
  /** answer, for a request: the status served with it. */
  status?: string;
  /** The head of the payload as it was recorded, for reference beside an edited answer. */
  recorded?: string;
  /** Set when the answer was changed from what the server sent. */
  edited?: boolean;
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
  /**
   * Which sequences on the site it answers in. `local`, only `owner`;
   * `optIn`, only the sequences listing it as on; `optOut`, the sequences
   * that do not list it as off.
   */
  mode?: 'local' | 'optIn' | 'optOut';
  /** The sequence a local response belongs to. */
  owner?: string;
  /** A local response belonging to another sequence: never offered here. Never stored. */
  foreign?: boolean;
  /**
   * The open sequence's steps it answers at; absent, every step. Read off the
   * sequence's use of it, never stored on the response: a step number names a
   * different action in each sequence.
   */
  steps?: number[];
  /** Not used by the open sequence: listed, and armed in no pin. Never stored. */
  off?: boolean;
}

/**
 * Every response kept on disk, wherever it is kept: one entry per site file
 * and one per sequence activity file, each with the origin it answers on.
 */
export interface RuleCatalogueEntry {
  /** The origin the rules answer on; absent for a sequence whose start names none. */
  site?: string;
  /** The sequence whose activity file holds them; absent for a site file. */
  sequence?: string;
  rules: BoundaryRule[];
  /** Site responses the sequence opts out of, by key. */
  off?: string[];
  /** Site responses the sequence opts into, by key, at every step or at those given. */
  on?: Array<{ key: string; steps?: number[] }>;
  /** A site file's hidden kinds. */
  hidden?: HiddenKind[];
  /** Hidden kinds the sequence opts into and out of, by key. */
  hiddenOn?: string[];
  hiddenOff?: string[];
}

/**
 * A kind of traffic kept out of the list, with the types a response has:
 * `local` to `owner`, `optIn` where a sequence opts in, `optOut` except where
 * one opts out. `off` marks one the open sequence lists anyway.
 */
export interface HiddenKind {
  /** The rule's identity; for one kind, the key that kind is matched on. */
  key: string;
  label?: string;
  frame?: boolean;
  /** The socket, stream or path it covers, matched as a substring. */
  url?: string;
  direction?: 'out' | 'in';
  method?: string;
  /** Every message on `url`, whatever it carries, rather than the one kind `key` names. */
  any?: boolean;
  /** Only at this step of a sequence; absent, at every step. */
  step?: number;
  mode: 'local' | 'optIn' | 'optOut';
  owner?: string;
  off?: boolean;
}

/** What `GET /proxy/events` answers with. */
export interface BoundaryState {
  /** Every hidden kind held for the site, each marked as the open sequence uses it. */
  hidden?: HiddenKind[];
  running: boolean;
  /** The origin whose site rules are armed, when one is known. */
  site?: string;
  /** A person's names for kinds of traffic, by rule key. */
  names?: Record<string, string>;
  /** Hosts this browser may reach. Empty means every host. */
  allowed: string[];
  refused: number;
  /** Whether an unmatched POST, PUT, PATCH or DELETE is answered 403. */
  refusesWrites: boolean;
  /** Writes answered 403 under that setting. */
  refusedWrites: number;
  /** Every decision standing against this connection's traffic. */
  rules: BoundaryRule[];
  /** How each check step went in the latest pass: the answer, what the step did on it, and any sequence it ran. */
  checkOutcomes?: Array<{
    runId: string; step: number; outcome: 'held' | 'failed'; subject: string; found?: string;
    action: 'continue' | 'stop' | 'run'; ran?: string; steps?: number; error?: string;
    waitedMs?: number; limitMs?: number;
    ranSteps?: RanStep[];
  }>;
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
  /** Traffic kept at the proxy while the network is held, oldest first. */
  queued?: QueuedView[];
  /** Whether the proxy is holding what crosses it now. */
  holding?: boolean;
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
