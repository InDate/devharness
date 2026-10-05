/**
 * The shapes a replay run passes between the executor and what it calls: the
 * run's context, one step's result, the run's result.
 */

import type { CommandRecorder, RecordedCommand, ActiveSequenceState } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import type { DialogAnswer, OpenDialog } from '../dialog-monitor.js';
import type { ElementRepair } from '../element-fingerprint.js';

export interface ExecutionContext {
  executeToolCall: ExecuteToolCall;
  commandRecorder: CommandRecorder;
  connection: string;
  logPrefix?: string;
  /** How many sequences deep this run is, through checks' `{ run }` and forEach's `do`; bounds recursion. */
  nestingDepth?: number;
  /** Call stack of sequence names for circular reference detection */
  nestingCallStack?: string[];
  /** Per-run variable store for {{var:name.path}} interpolation. Populated by
   *  { saveAs } steps (see CAPTURE_SOURCES), consumed by later steps' param
   *  interpolation. Shared BY REFERENCE with per-step ctx clones and nested
   *  sequences, so a capture anywhere is visible everywhere in the run. */
  variableStore?: Record<string, any>;
  /** {{timestamp}} value for this run, computed once and cached (not per-step). */
  runTimestamp?: number;
  /**
   * Maps a per-step `connection` as RECORDED onto a reference that exists
   * in THIS session (`{ 'duo-member-two': 'my-second-browser' }`). Connection
   * references are per-session, so a multi-connection sequence recorded elsewhere
   * needs its references rebound before it can run here. Both sides are expected
   * pre-sanitized (see sanitizeConnectionMap). Inherited by nested sequences.
   */
  connectionMap?: Record<string, string>;
  /**
   * References this run CAUSED to be launched, filled in as `connection launch`
   * steps succeed with `reused: false`. Shared by reference with per-step ctx
   * clones and nested sequences, so ownership survives every early return the
   * executor has - a paused, failed or aborted run knows what it created just
   * as well as a completed one. `killChromeOnFinish` kills exactly this set
   * plus the run's own connection, and nothing else (issue #103).
   */
  launchedConnections?: Set<string>;
  /**
   * The origin every absolute URL in this run takes, from `run`/`runAll`'s
   * `baseUrl`. Inherited by nested sequences (a check's `{ run }`, a
   * `forEach`'s `do`), which load from the recorder in their recorded form:
   * without it the parent runs against the target deployment and the helper
   * that logs in or navigates runs against the recorded one, so a retargeted
   * suite drives two origins at once.
   */
  rebaseOrigin?: string;
  /**
   * Recorded-typed-text substitutions for this run, from `run`/`runAll`'s
   * `variables`. Inherited by nested sequences (a check's `{ run }`, a
   * `forEach`'s `do`), which load from the recorder in their recorded form:
   * without it the credential a caller supplied stops at the top-level
   * sequence and the shared login helper types its RECORDED password into the
   * live app, with the run reporting success.
   */
  variables?: Record<string, string>;
  /**
   * Values from the run's `envFile`, checked by {{env:NAME}} before
   * process.env. Inherited by nested sequences, so a shared login helper
   * reached by a check's `{ run }` resolves against the same file. The server's
   * own process.env is never mutated: two background runs may name different
   * files, and a global write would let one run's credentials resolve inside
   * the other.
   */
  runEnv?: Record<string, string>;
  /**
   * The position this run's steps stamp their traffic under, when it runs
   * inside a step of another: that step's number, and the path of positions
   * down to this run. Absent on a top-level run, whose steps stamp their own.
   */
  stampUnder?: { step: number; within: number[] };
  /**
   * Set on a forEach body. Every iteration stamps its traffic at the same
   * position, so a comparison read there counts the earlier iterations' too.
   */
  trafficUncompared?: boolean;
}

export interface StepResult {
  step: number;
  tool: string;
  success: boolean;
  error?: string;
  // For a check that ran a sequence, or a forEach - nested substeps
  substeps?: StepResult[];
  sequenceName?: string;
  /** check: how the reading went, and what the step did on it. */
  check?: {
    outcome: 'held' | 'failed'; subject: string; found?: string; action: 'continue' | 'stop' | 'run';
    /** How long the check read for, and the most it could; absent for a check read once. */
    waitedMs?: number; limitMs?: number;
  };
  /** check that ran a sequence: that sequence's steps, so its results can be named by what each did. */
  ranCommands?: RecordedCommand[];
  /** forEach: how many items the source yielded, before `where` filtering. */
  itemsFound?: number;
  /** forEach: how many items actually ran `do` (post-filter, post-maxItems). */
  iterations?: number;
  /** The browser dialog this step opened: answered by the next step, or by a person while the run waited. */
  dialog?: OpenDialog;
  /** How the person answered the dialog, when the run waited on one. */
  dialogAnswer?: DialogAnswer;
}

export interface BreakpointHitInfo {
  url: string;
  lineNumber: number;
  columnNumber?: number;
  functionName?: string;
}

export interface ClickValidationFailure {
  step: number;
  selector: string;
  errors: string[];
  warnings: string[];
  info: string[];
  /** Present where the click hit another element than the one recorded. */
  repair?: ElementRepair;
}

export interface ExecutionResult {
  results: StepResult[];
  totalCommands: number;
  durationMs: number;
  pausedAtStep?: number;
  activeSequenceState?: ActiveSequenceState;
  breakpointHit?: BreakpointHitInfo;
  /** Click validation failure - sequence paused for inspection/retry */
  clickValidationFailure?: ClickValidationFailure;
  /**
   * Results of the sequence's `teardown` steps, when it has any and the run
   * reached a terminal state. Deliberately NOT merged into `results`: teardown
   * outcomes must never change the run's verdict, or a broken cleanup would
   * mask the failure it was cleaning up after.
   */
  teardownResults?: StepResult[];
  /** True when teardown ran but at least one of its steps failed. */
  teardownFailed?: boolean;
  /**
   * Steps whose boundary behaviour differs from what was recorded.
   *
   * Only present where the sequence carries a recorded baseline. A step that
   * fired one request when recorded and three now is a regression no assertion
   * on the page can see, because the screen can look identical either way.
   */
  behaviourDrift?: Array<{
    step: number;
    /** A nested sequence's step, as the caller's step and the path down to it: `1.3`. */
    path?: string;
    label: string;
    recorded: { requests: number; failed: number; opened: number; writes: number };
    observed: { requests: number; failed: number; opened: number; writes: number };
    /**
     * What crossed the boundary, per payload shape, weighted by how much of
     * each event this step owns. Present where the recording and the replay
     * both ran through a proxy; a shape in one side and not the other is the
     * difference a count cannot show.
     */
    shapes?: { recorded: Record<string, number>; observed: Record<string, number> };
    /**
     * How long each side held this step open, in ms.
     *
     * Unowned traffic lands in a step by duration, so a wide gap here is the
     * first thing to read a difference against: a step held 41s while
     * recording and 0.3s on replay differs in pacing before it differs in
     * behaviour.
     */
    window?: { recorded: number; observed: number };
  }>;
}

export interface ConnectionAnalysis {
  /** The first launch or attach step, or -1. */
  createIndex: number;
  firstConnectionToolIndex: number;
  /** A launch or attach comes before any step needs a browser, so the sequence creates the connection it runs on. */
  createsBeforeUse: boolean;
}
