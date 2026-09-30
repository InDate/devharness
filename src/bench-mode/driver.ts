import type { Annotation, AnnotationTarget, StepTraffic } from '../annotation.js';
import type { RuleCatalogueEntry, HistoryDetail, HistoryEntry, ToolGroup, ToolRun, SequenceCard, SequenceOutline, SequenceStep, SequenceVariable } from '../bench/wire.js';
import type { ActivityMove, ExpectedValue, KindCount } from '../bench/kinds.js';

/** What the bench needs from the replay side: read the session, drive the run. */
export interface SequenceDriver {
  listNames: () => Promise<string[]>;
  /** The same list with what each one holds, for choosing between them. */
  listCatalogue: () => Promise<SequenceCard[]>;
  /** One sequence's steps by name, or undefined where no sequence has that name. */
  outlineOf: (name: string) => Promise<SequenceOutline | undefined>;
  /** Every tool call held in history, newest first. */
  history: () => HistoryEntry[];
  /** One call by its history index, or undefined once history has dropped it. */
  historyDetail: (index: number) => HistoryDetail | undefined;
  /** Every tool this devharness serves, by the toolset that built it. */
  tools: () => ToolGroup[];
  /** Run one tool with `args`, as a call arriving from the bench. */
  callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolRun>;
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
      stores?: string;
      reads?: string[];
      tool?: string;
      params?: Record<string, unknown>;
      annotations?: Annotation[];
      traffic?: StepTraffic;
      expected?: Record<string, ExpectedValue>;
      addedAt?: number;
    }>;
    placements?: Record<string, number>;
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
   * Carry one note to another step of the open sequence; `after` places it
   * among the step's activities (see Annotation.after).
   *
   * A note is stored in the step it belongs to, so a note filed against the
   * wrong one is wrong in the file rather than only on screen - and without
   * this the only way back is to erase it and take the capture again.
   */
  moveAnnotation: (id: string, step: number, after?: string) => Promise<string | undefined>;
  /** Replace a saved note's words, and write the file back. */
  rewordAnnotation: (id: string, words: string) => Promise<string | undefined>;
  /**
   * Add a picture to a note already saved, and write the file back. `target`
   * is the element the picture was picked from, which a note about no element
   * takes on.
   */
  attachScreenshot: (id: string, path: string, target?: AnnotationTarget) => Promise<string | undefined>;
  /**
   * Record clicks in the page into a new sequence, returning when the person
   * stops. Returns the failure text when nothing was recorded.
   */
  record: (name: string, connection: string, startUrl: string) => Promise<string | undefined>;
  /**
   * Move what a recording captured into another sequence after one of its
   * steps, and drop the recording. Returns the failure text.
   */
  spliceRecording: (recordedName: string, into: string, after: number) => Promise<string | undefined>;
  /** The labels of a loaded sequence's steps, in order. */
  labelsOf: (name: string) => string[];
  /** Finish a recording in progress, from the pane rather than the page. */
  stopRecording: (connection: string) => Promise<void>;
  /** Abandon a recording in progress, saving nothing. */
  cancelRecording: (connection: string) => Promise<void>;
  /** Erase one step of the open sequence and write the file back. */
  removeStep: (index: number) => Promise<string | undefined>;
  /** Replace what one step is given, and write the file back. */
  editStep: (index: number, params: Record<string, unknown>) => Promise<string | undefined>;
  /** Put a fixed pause of `ms` straight after one step, and write the file back. */
  insertTimer: (after: number, ms: number) => Promise<string | undefined>;
  /** Put a check step, with these parameters, straight after a step. */
  insertCheck: (after: number, params: Record<string, unknown>, comment?: string) => Promise<string | undefined>;
  /** Move `count` steps from `from` on, together, so the first lands at `to`, and write the file back. */
  moveStep: (from: number, to: number, count?: number) => Promise<string | undefined>;
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
  /** Remove the step that defines a variable. */
  removeVariable: (name: string) => Promise<string | undefined>;
  /**
   * Write the boundary decisions onto the open sequence, replacing whatever
   * stood there. Returns the failure text when the write did not land.
   */
  saveBoundaryRules: (
    rules: Array<Record<string, unknown>>,
    refuseWrites: boolean,
    names?: Record<string, string>,
    /** What changed, for the announcement of the write. */
    change?: string,
    /** Keys of the site's responses this sequence opts out of. */
    off?: string[],
    /** The site's responses this sequence opts into, at every step or at those given. */
    on?: Array<{ key: string; steps?: number[] }>,
    /** The site's hidden kinds this sequence opts into and out of. */
    hidden?: { on: string[]; off: string[] },
  ) => Promise<string | undefined>;
  /** The origin the open sequence runs against, whose site rules it arms. */
  siteOf: () => string | undefined;
  /** The rules kept for a whole site, as they stand on disk. */
  openSiteRules: (origin: string) => Promise<Array<Record<string, unknown>>>;
  /** The kinds a site keeps out of the list, as they stand on disk. */
  openSiteHidden: (origin: string) => Promise<Array<Record<string, unknown>>>;
  /** Every response on disk: each site file, and each sequence's activity file. */
  catalogueRules: () => Promise<RuleCatalogueEntry[]>;
  /** Write a whole site's rules, replacing what stood there. Returns the failure text. */
  saveSiteRules: (
    origin: string, rules: Array<Record<string, unknown>>, change?: string, hidden?: Array<Record<string, unknown>>,
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
    refuseWrites: boolean;
    names?: Record<string, string>;
    off?: string[];
    on?: Array<{ key: string; steps?: number[] }>;
    hiddenOn?: string[];
    hiddenOff?: string[];
  };
  /**
   * Write each step's traffic onto the sequence on disk.
   *
   * A recording's traffic is held per session while it is being taken; without
   * this it goes when the session does, and a note keeps its own text while
   * losing the evidence it was written about.
   */
  saveStepTraffic: (entries: Array<{ index: number; traffic: StepTraffic }>) => Promise<string | undefined>;
  /** Mark, or with none unmark, what one kind on one step has to carry on replay. */
  saveExpected: (index: number, kind: string, expected: ExpectedValue | undefined) => Promise<string | undefined>;
  /** Replace, or with none remove, what one kind on one step was recorded as. */
  saveRecorded: (index: number, kind: string, recorded: KindCount | undefined) => Promise<string | undefined>;
  /** Move one kind to the adjacent step, or between the last step and the gutter, on every run. */
  saveMove: (move: ActivityMove) => Promise<string | undefined>;
  /**
   * What crossed the boundary between two clocks, for one connection.
   *
   * Read off the network tool rather than the monitor directly, so the same
   * windowing rule applies here as to anyone asking by hand.
   */
  trafficIn: (connection: string, from: number, to: number) => Promise<StepTraffic>;
  /**
   * The steps a recording has captured, converted from the page's raw events;
   * `edits` replace what a step is given, by position, before its label is read.
   * The events are read by the caller over CDP: Puppeteer's page.evaluate
   * blocks on a paused isolate, and the page is held while a step is judged.
   */
  recordedSoFar: (eventsJson: string, startUrl: string, edits?: Map<number, Record<string, unknown>>) => SequenceStep[];
  /** One note of the open sequence with the step holding it, by id. */
  findAnnotation: (id: string) => { annotation: Annotation; step: number; sequence: string } | undefined;
  /** The tracked issue whose reproduction is the open sequence, when there is one. */
  issue: () => Promise<{ id: number; type: string; title: string } | undefined>;
}
