/**
 * Replay Executor - Core execution engine for command sequences
 */

import type { CommandRecorder, RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { abortableDelayResult } from '../utils/abort.js';
import { debugLog } from '../debug-logger.js';
import { sanitizeReference, requireValidReference } from '../reference-validator.js';
import { checkUrlPort } from '../utils/port-check.js';
import { configManager, ClickValidationConfig } from '../config.js';
import type { ClickActionMeta, ConsoleToolMeta, NetworkToolMeta } from '../tool-response.js';
import { interpolateParams } from './interpolation.js';
import { getMessage, isElementNotFoundFailure } from '../messages.js';

// Re-export replay cursor functions
export { injectReplayCursor, showClickEffect, showKeyPress, removeReplayCursor } from '../replay-cursor.js';

// =============================================================================
// Replay Cursor Callbacks
// =============================================================================

interface ReplayCursorCallbacks {
  onClickBefore?: (x: number, y: number, isRightClick: boolean) => Promise<void>;
  onKeyPress?: (key: string) => Promise<void>;
}

let replayCursorCallbacks: ReplayCursorCallbacks = {};

export function setReplayCursorCallbacks(callbacks: ReplayCursorCallbacks): void {
  replayCursorCallbacks = callbacks;
}

// =============================================================================
// Types
// =============================================================================

export interface ExecutionContext {
  executeToolCall: ExecuteToolCall;
  commandRecorder: CommandRecorder;
  connectionReason: string;
  logPrefix?: string;
  /** Current nesting depth for conditional commands (used for recursion protection) */
  conditionalDepth?: number;
  /** Call stack of sequence names for circular reference detection */
  conditionalCallStack?: string[];
  /** Per-run variable store for {{var:name.path}} interpolation. Populated by
   *  { saveAs } steps (see CAPTURE_SOURCES), consumed by later steps' param
   *  interpolation. Shared BY REFERENCE with per-step ctx clones and nested
   *  sequences, so a capture anywhere is visible everywhere in the run. */
  variableStore?: Record<string, any>;
  /** {{timestamp}} value for this run, computed once and cached (not per-step). */
  runTimestamp?: number;
  /**
   * Maps a per-step `connectionReason` as RECORDED onto a reference that exists
   * in THIS session (`{ 'duo-member-two': 'my-second-browser' }`). Connection
   * references are per-session, so a multi-connection sequence recorded elsewhere
   * needs its references rebound before it can run here. Both sides are expected
   * pre-sanitized (see sanitizeConnectionMap). Inherited by nested sequences.
   */
  connectionMap?: Record<string, string>;
  /**
   * References this run CAUSED to be launched, filled in as `launchChrome`
   * steps succeed with `reused: false`. Shared by reference with per-step ctx
   * clones and nested sequences, so ownership survives every early return the
   * executor has - a paused, failed or aborted run knows what it created just
   * as well as a completed one. `killChromeOnFinish` kills exactly this set
   * plus the run's own connection, and nothing else (issue #103).
   */
  launchedConnections?: Set<string>;
  /**
   * The origin every absolute URL in this run takes, from `run`/`runAll`'s
   * `baseUrl`. Inherited by nested sequences (a `conditional`'s `then`, a
   * `forEach`'s `do`), which load from the recorder in their recorded form:
   * without it the parent runs against the target deployment and the helper
   * that logs in or navigates runs against the recorded one, so a retargeted
   * suite drives two origins at once.
   */
  rebaseOrigin?: string;
  /**
   * Recorded-typed-text substitutions for this run, from `run`/`runAll`'s
   * `variables`. Inherited by nested sequences (a `conditional`'s `then`, a
   * `forEach`'s `do`), which load from the recorder in their recorded form:
   * without it the credential a caller supplied stops at the top-level
   * sequence and the shared login helper types its RECORDED password into the
   * live app, with the run reporting success.
   */
  variables?: Record<string, string>;
  /**
   * Values from the run's `envFile`, checked by {{env:NAME}} before
   * process.env. Inherited by nested sequences, so a shared login helper
   * reached by a `conditional` resolves against the same file. The server's
   * own process.env is never mutated: two background runs may name different
   * files, and a global write would let one run's credentials resolve inside
   * the other.
   */
  runEnv?: Record<string, string>;
}

export interface StepResult {
  step: number;
  tool: string;
  success: boolean;
  error?: string;
  // For conditional commands - nested substeps
  substeps?: StepResult[];
  sequenceName?: string;
  conditionMet?: boolean;
  /** forEach: how many items the source yielded, before `where` filtering. */
  itemsFound?: number;
  /** forEach: how many items actually ran `do` (post-filter, post-maxItems). */
  iterations?: number;
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
}

export interface ConnectionAnalysis {
  launchChromeIndex: number;
  firstConnectionToolIndex: number;
  hasLaunchBeforeConnection: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Which tools a sequence step's `saveAs` can capture from, and what a capture
 * actually stores. Each entry pulls the value out of the tool's structured
 * `_meta` - never out of its display text - and returns `undefined` when this
 * particular call produced nothing capturable (wrong action, older response).
 *
 * `request` stores the whole response object, so later steps address into it
 * ({{var:login.body.token}}). `inspect` stores the evaluated value itself, so
 * a captured string is usable as {{var:pairingUrl}} directly.
 *
 * Adding `dom`/`content` later is a matter of adding an entry here plus the
 * matching `_meta` on that tool.
 */
const CAPTURE_SOURCES: Record<string, (meta: any) => { found: boolean; value?: unknown }> = {
  request: (meta) => meta?.request
    ? { found: true, value: meta.request }
    : { found: false },
  inspect: (meta) => meta?.inspect
    ? { found: true, value: meta.inspect.value }
    : { found: false },
};

/** Human-readable list of what supports saveAs, for error messages. */
const CAPTURE_CAPABLE_TOOLS = Object.keys(CAPTURE_SOURCES).join(', ');

/**
 * Iterations a `forEach` will run before stopping, unless the step raises it
 * with `maxItems`. A backstop against a source that unexpectedly returns
 * thousands of rows, not a considered limit - the stop is always logged.
 */
const DEFAULT_FOREACH_MAX_ITEMS = 100;

/**
 * Teardown's default total budget. Separate from the run's `totalTimeout`
 * because it must survive that budget being exhausted.
 */
const DEFAULT_TEARDOWN_TIMEOUT = 60000;

/**
 * Resolve what a step's `saveAs` should write to the variable store.
 * A `saveAs` that cannot be honoured is an error, not a silent no-op: the
 * later {{var:...}} step would otherwise fail somewhere far away with a
 * confusing "no variable named" message.
 */
export function captureVariable(
  tool: string,
  params: Record<string, any>,
  result: any
): { ok: true; value: unknown } | { ok: false; error: string } {
  const source = CAPTURE_SOURCES[tool];
  if (!source) {
    return {
      ok: false,
      error: `saveAs is not supported on "${tool}" steps (supported: ${CAPTURE_CAPABLE_TOOLS})`,
    };
  }
  const captured = source(result?._meta);
  if (!captured.found) {
    const action = params.action ? ` (action: ${params.action})` : '';
    return {
      ok: false,
      error: `saveAs: "${tool}"${action} returned no capturable result` +
        (tool === 'inspect' ? ' - only inspect({ action: "evaluateExpression" }) can be captured' : ''),
    };
  }
  return { ok: true, value: captured.value };
}

/**
 * Tools that can only run against a *browser*. Used to decide whether a sequence
 * needs Chrome auto-launched (analyzeSequenceConnections / sequenceNeedsConnection
 * and the auto-launch paths in replay-tools).
 *
 * Deliberately excludes tools that are equally valid against a Node target
 * (`inspect`, `execution`, `breakpoint`, `getSourceCode`, `request`) - listing
 * those here would make a Node-only sequence spuriously launch Chrome.
 */
export const TOOLS_NEEDING_CONNECTION = [
  'navigate', 'content', 'input', 'console', 'network', 'dom', 'screenshot', 'storage'
];

/**
 * Tools whose params accept a `connectionReason` and should therefore have the
 * run-level connection injected when the step doesn't name one itself. Superset of
 * TOOLS_NEEDING_CONNECTION: it adds the target-agnostic (Chrome *or* Node) debugging
 * tools, which need to be pinned to the run's target but must NOT drag a browser
 * launch in with them.
 *
 * `request` is handled separately - only `destination: 'browser'` takes a connection.
 */
export const TOOLS_ACCEPTING_CONNECTION = [
  ...TOOLS_NEEDING_CONNECTION,
  'inspect', 'execution', 'breakpoint', 'getSourceCode', 'detectModals', 'dismissModal', 'assert',
  'wait'
];

/**
 * Whether a single step requires a *browser* connection (drives Chrome
 * auto-launch). Param-aware variant of `TOOLS_NEEDING_CONNECTION.includes(tool)`:
 * `wait` is browser-bound only in its selector/selectorGone forms.
 * - `wait({ ms })` is a plain sleep and must not drag a Chrome launch in.
 * - `wait({ expression })` is target-agnostic (valid against Node too), so it
 *   behaves like `inspect`: the run connection is injected, but it never
 *   forces a browser launch on its own.
 */
export function commandNeedsBrowserConnection(cmd: { tool: string; params?: Record<string, any> }): boolean {
  if (cmd.tool === 'wait') {
    const p = cmd.params || {};
    return p.selector !== undefined || p.selectorGone !== undefined;
  }
  return TOOLS_NEEDING_CONNECTION.includes(cmd.tool);
}

/**
 * Whether a bare step will have the run-level connection injected into it -
 * i.e. whether leaving it bare is AMBIGUOUS about which browser it belongs to.
 *
 * Deliberately wider than `commandNeedsBrowserConnection`, which answers a
 * different question (does this drag a Chrome launch in?). `inspect`,
 * `execution`, `storage` and friends take an optional connectionReason, so a
 * recording made without one captures nothing about which browser it ran
 * against - and on replay it silently lands wherever the run-level connection
 * points. Measuring ambiguity with the narrower predicate missed exactly those
 * tools, which are the ones people actually leave bare.
 */
export function commandTakesInjectedConnection(cmd: { tool: string; params?: Record<string, any> }): boolean {
  // wait({ ms }) is a plain sleep - no connection is injected, nothing ambiguous.
  if (cmd.tool === 'wait') return (cmd.params || {}).ms === undefined;
  return TOOLS_ACCEPTING_CONNECTION.includes(cmd.tool);
}

// =============================================================================
// Conditional Evaluation
// =============================================================================

/**
 * Result of condition evaluation
 * - met: true - condition matched
 * - met: false, isError: undefined - condition legitimately not met
 * - met: false, isError: true - evaluation FAILED (should stop sequence)
 */
export type ConditionResult =
  | { met: true }
  | { met: false; reason?: string }
  | { met: false; reason: string; isError: true };

/** The condition types `evaluateCondition` knows how to answer. */
export const CONDITION_TYPES = ['selector', 'url', 'cookie', 'localStorage', 'indexedDB'] as const;

/** Shape of a handlebar condition: `{{type:value}}` or `{{!type:value}}`. */
const CONDITION_PATTERN = /^\{\{(!?)(\w+):(.+)\}\}$/;

/**
 * Check a condition at authoring time: shape, type, and the `url`/`indexedDB`
 * sub-forms. A value holding a `{{var:...}}` token is skipped - it is
 * substituted at run time, so its final shape is unknowable here.
 */
export function validateConditionSyntax(
  condition: string,
  maxRegexLength = configManager.getReplayConfig().maxRegexLength
): { ok: true } | { ok: false; reason: string } {
  const match = condition.match(CONDITION_PATTERN);
  if (!match) {
    return {
      ok: false,
      reason: `Invalid condition format: "${condition}". Expected {{type:value}} or {{!type:value}}. Supported types: ${CONDITION_TYPES.join(', ')}`
    };
  }

  const [, , type, value] = match;
  if (!(CONDITION_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      reason: `Unknown condition type: "${type}". Supported types: ${CONDITION_TYPES.join(', ')}`
    };
  }

  const interpolated = value.includes('{{');

  if (type === 'url' && value.startsWith('matches:') && !interpolated) {
    const pattern = value.substring('matches:'.length);
    if (pattern.length > maxRegexLength) {
      return {
        ok: false,
        reason: `Regex pattern too long (${pattern.length} chars, max ${maxRegexLength}). Simplify the pattern or increase maxRegexLength in config.`
      };
    }
    try {
      new RegExp(pattern);
    } catch (regexError: any) {
      return {
        ok: false,
        reason: `Invalid regex pattern "${pattern}": ${regexError.message}. Check syntax at https://regex101.com (JavaScript flavor).`
      };
    }
  }

  if (type === 'indexedDB' && !interpolated) {
    const [db, store, ...rest] = value.split('/');
    if (!db || !store) {
      return {
        ok: false,
        reason: `Invalid indexedDB condition "${value}". Expected {{indexedDB:DB/STORE/KEY}} or {{indexedDB:DB/STORE}}.`
      };
    }
    if (rest.length > 0 && !rest.join('/')) {
      return {
        ok: false,
        reason: `Invalid indexedDB condition "${value}": the key is empty.`
          + ` Use {{indexedDB:${db}/${store}}} to ask whether the store holds anything.`
      };
    }
  }

  return { ok: true };
}

/**
 * Evaluate a handlebar-style condition
 * Supported patterns:
 *   {{selector:CSS_SELECTOR}}     - true if element exists
 *   {{!selector:CSS_SELECTOR}}    - true if element does NOT exist
 *   {{url:contains:STRING}}       - true if URL contains string
 *   {{url:matches:REGEX}}         - true if URL matches regex
 *   {{cookie:NAME}}               - true if cookie exists
 *   {{!cookie:NAME}}              - true if cookie does NOT exist
 *   {{localStorage:KEY}}          - true if localStorage key exists
 *   {{!localStorage:KEY}}         - true if localStorage key does NOT exist
 *   {{indexedDB:DB/STORE/KEY}}    - true if that IndexedDB record exists
 *   {{indexedDB:DB/STORE}}        - true if that object store holds any record
 *   {{!indexedDB:...}}            - negation of either form
 */
export async function evaluateCondition(
  condition: string,
  ctx: ExecutionContext
): Promise<ConditionResult> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();

  // Parse the handlebar pattern
  const match = condition.match(CONDITION_PATTERN);
  if (!match) {
    return {
      met: false,
      reason: `Invalid condition format: "${condition}". Expected {{type:value}} or {{!type:value}}. Supported types: ${CONDITION_TYPES.join(', ')}`,
      isError: true
    };
  }

  const [, negated, type, value] = match;
  const isNegated = negated === '!';

  await debugLog(logPrefix, `Evaluating condition: ${type}${isNegated ? ' (negated)' : ''} = ${value}`);

  try {
    let conditionMet = false;

    switch (type) {
      case 'selector': {
        // Absence is the answer, not a broken condition: it arrives as a thrown
        // ToolError, which any other failure does too - hence the classifier.
        const probeSelector = async () => {
          try {
            const res: any = await executeToolCall('dom', {
              action: 'querySelector',
              selector: value,
              connectionReason
            });
            return { res };
          } catch (selectorError: any) {
            return {
              failure: selectorError?.message || String(selectorError),
              errorId: selectorError?.response?._errorId,
            };
          }
        };

        const attempt = await probeSelector();
        if (attempt.failure) {
          if (isElementNotFoundFailure({ errorId: attempt.errorId, text: attempt.failure })) {
            conditionMet = false;
            break;
          }
          return {
            met: false,
            reason: `Error evaluating selector condition "${value}": ${attempt.failure}`,
            isError: true
          };
        }
        conditionMet = (attempt.res?.content?.[0]?.text || '').includes('Element found');
        break;
      }

      case 'url': {
        const pageInfo = await executeToolCall('navigate', {
          action: 'info',
          connectionReason
        });
        // From `_meta` where it exists: the text fallback stops the URL at the
        // first comma or space, so a data: URL or a `?ids=1,2` query compared as
        // a truncated prefix - `{{url:EXACT}}` could never match one.
        const currentUrl = pageInfo?._meta?.navigate?.url ?? '';

        if (value.startsWith('contains:')) {
          const searchStr = value.substring('contains:'.length);
          conditionMet = currentUrl.includes(searchStr);
        } else if (value.startsWith('matches:')) {
          const pattern = value.substring('matches:'.length);

          // Check regex length limit
          if (pattern.length > replayConfig.maxRegexLength) {
            return {
              met: false,
              reason: `Regex pattern too long (${pattern.length} chars, max ${replayConfig.maxRegexLength}). Simplify the pattern or increase maxRegexLength in config.`,
              isError: true
            };
          }

          // Safely compile regex
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch (regexError: any) {
            return {
              met: false,
              reason: `Invalid regex pattern "${pattern}": ${regexError.message}. Check syntax at https://regex101.com (JavaScript flavor).`,
              isError: true
            };
          }

          conditionMet = regex.test(currentUrl);
        } else {
          conditionMet = currentUrl === value;
        }
        break;
      }

      case 'cookie': {
        const result = await executeToolCall('storage', {
          action: 'getCookies',
          connectionReason
        });
        // Names from `_meta`: grepping the rendered JSON matched another
        // cookie's VALUE, and the `name=wanted` form matched any cookie whose
        // name merely ENDS with it.
        conditionMet = (result?._meta?.storage?.cookieNames ?? []).includes(value);
        break;
      }

      case 'localStorage': {
        const result = await executeToolCall('storage', {
          action: 'getLocalStorage',
          key: value,
          connectionReason
        });
        // Presence from `_meta`. The old text test read the whole rendered
        // response, so a key whose VALUE was "null" - or contained "not found",
        // or any OTHER key's value did - reported the key as missing, and a
        // `{{localStorage:...}}` guard skipped work it should have done. An
        // empty string is a stored value and counts as present.
        conditionMet = result?._meta?.storage?.found === true;
        break;
      }

      case 'indexedDB': {
        // DB/STORE/KEY, where the key may itself contain slashes. Two segments
        // ask "does this store hold anything at all".
        const segments = value.split('/');
        const [db, store, ...rest] = segments;
        const key = rest.join('/');
        if (!db || !store) {
          return {
            met: false,
            reason: `Invalid indexedDB condition "${value}". Expected {{indexedDB:DB/STORE/KEY}} or {{indexedDB:DB/STORE}}.`,
            isError: true
          };
        }
        // A key segment that interpolated to nothing must NOT quietly become the
        // store form ("is anything in here"), which answers a different question
        // and would flip a setup decision with no signal.
        if (rest.length > 0 && !key) {
          return {
            met: false,
            reason: `Invalid indexedDB condition "${value}": the key is empty.`
              + ` Use {{indexedDB:${db}/${store}}} to ask whether the store holds anything,`
              + ` or check the {{var:...}} that produced the key.`,
            isError: true
          };
        }

        // A database or store that doesn't exist yet is the record being
        // ABSENT, not a broken condition: that is the state a fresh profile is
        // in, and the state a setup sequence exists to heal. It arrives as a
        // thrown ToolError, like any other tool failure.
        const probe = async (probeKey?: string | number) => {
          try {
            const res: any = probeKey !== undefined
              ? await executeToolCall('storage', { action: 'idbGet', db, store, key: probeKey, connectionReason })
              : await executeToolCall('storage', { action: 'idbGetAll', db, store, limit: 1, connectionReason });
            return { res };
          } catch (idbError: any) {
            return { failure: idbError?.message || String(idbError) };
          }
        };

        const isAbsence = (failure: string) =>
          /does not exist|not found in database|no object store/i.test(failure);

        /**
         * Presence comes from the tool's structured `_meta`, never from its
         * rendered text: a record whose VALUE contains "No record found for
         * this key." (or "**Count:** 0") read as absent when this grepped the
         * markdown.
         */
        const presentIn = (res: any): boolean => {
          const meta = res?._meta?.storage;
          return key ? meta?.found === true : (meta?.count ?? 0) > 0;
        };

        let attempt = await probe(key || undefined);
        if (attempt.failure) {
          if (isAbsence(attempt.failure)) { conditionMet = false; break; }
          return {
            met: false,
            reason: `Error evaluating indexedDB condition "${value}": ${attempt.failure}`,
            isError: true
          };
        }

        conditionMet = presentIn(attempt.res);

        // A condition is written as text, so a numerically-keyed store ("42")
        // would never match its own record - IndexedDB keys 42 and "42" are
        // different keys. Retry as a number before concluding absence.
        if (!conditionMet && key && /^-?\d+(\.\d+)?$/.test(key)) {
          const numeric = await probe(Number(key));
          if (!numeric.failure && presentIn(numeric.res)) {
            await debugLog(logPrefix, `indexedDB key "${key}" matched as a number, not a string`);
            conditionMet = true;
          }
        }
        break;
      }

      default:
        return {
          met: false,
          reason: `Unknown condition type: "${type}". Supported types: ${CONDITION_TYPES.join(', ')}`,
          isError: true
        };
    }

    // Apply negation
    const finalResult = isNegated ? !conditionMet : conditionMet;
    await debugLog(logPrefix, `Condition ${condition} = ${finalResult}`);

    if (finalResult) {
      return { met: true };
    } else {
      return { met: false };
    }
  } catch (error: any) {
    // Tool execution errors are real errors, not just "condition not met"
    return {
      met: false,
      reason: `Error evaluating ${type} condition: ${error.message}`,
      isError: true
    };
  }
}

export interface ConditionalFlowResult {
  success: boolean;
  executed: boolean;
  sequenceName: string;
  substeps?: StepResult[];
  error?: string;
  durationMs?: number;
}

/**
 * Shared preparation for any sequence run INSIDE another one (`conditional`'s
 * `then`, `forEach`'s `do`): decide which of its `launchChrome` steps still
 * apply, and which browser its bare steps belong to.
 *
 * Drop launchChrome steps whose browser already exists - the caller handed us a
 * live connection and relaunching it would throw the session away. Keep the ones
 * whose reference is NOT live: a setup sequence that spans two browsers has to be
 * able to create the second one, or it can only ever heal identity in browsers
 * that happened to be open already. Probed only when there is a launch to reason
 * about, so the common nested call costs no extra tool call.
 */
async function prepareNestedSequence(
  rawSequence: CommandSequence,
  ctx: ExecutionContext,
  label: string,
  logPrefix: string
): Promise<{ filteredSequence: CommandSequence; filteredCommands: RecordedCommand[]; nestedConnection?: string }> {
  // The parent run's retarget reaches here first: a nested sequence loads from
  // the recorder in its recorded form, so its absolute URLs still carry the
  // recorded origin until this runs.
  const sequence = ctx.rebaseOrigin
    ? rebaseSequence(rawSequence, { baseUrl: ctx.rebaseOrigin })
    : rawSequence;
  const liveRefs = sequence.commands.some(cmd => cmd.tool === 'launchChrome')
    ? await probeLiveConnectionReferences(ctx.executeToolCall)
    : null;
  const keptLaunches: string[] = [];
  const filteredCommands = sequence.commands.filter(cmd => {
    if (cmd.tool !== 'launchChrome') return true;

    const recorded = typeof cmd.params?.reference === 'string'
      ? sanitizeReference(cmd.params.reference)
      : undefined;
    // No reference to reason about, or no readable connection list: fall back to
    // the old always-drop behaviour rather than risk killing the live browser.
    if (!recorded || !liveRefs) return false;

    const resolved = ctx.connectionMap?.[recorded] ?? recorded;
    if (liveRefs.has(resolved)) return false;

    debugLog(logPrefix, `Keeping launchChrome for "${resolved}" in nested sequence "${label}": no such connection in this session`);
    keptLaunches.push(resolved);
    return true;
  });

  // A launch we KEPT created a browser that only this sub-sequence knows about,
  // and `create` hoists a uniform connection OFF the steps - so the setup
  // sequence is a launch followed by BARE steps. Left on the parent's
  // connection, those steps run in the caller's browser: the run creates a
  // browser, does nothing in it, and reports success. Bind the sub-run to the
  // browser it just launched, exactly as a top-level run of that sequence would
  // (extractConnectionFromSequence).
  //
  // Only for a launch we kept. A launch that was DROPPED means the browser
  // already existed, and re-pointing bare steps at it would hijack a nested
  // login/setup sequence that has always run in whatever browser called it.
  const nestedAnalysis = analyzeSequenceConnections(filteredCommands);
  const launchedConnection = extractConnectionFromSequence(filteredCommands, nestedAnalysis);
  const nestedConnection = launchedConnection && keptLaunches.includes(launchedConnection)
    ? launchedConnection
    : undefined;
  if (nestedConnection) {
    await debugLog(logPrefix, `Nested sequence "${label}" runs against the browser it launched ("${nestedConnection}"), not the caller's "${ctx.connectionReason}"`);
  }

  return { filteredSequence: { ...sequence, commands: filteredCommands }, filteredCommands, nestedConnection };
}

/**
 * Execute a conditional flow - runs a sequence if condition is met
 */
export async function executeConditionalFlow(
  condition: string,
  sequenceName: string,
  ctx: ExecutionContext,
  recorder: CommandRecorder,
  /**
   * The parent run's timeout budget, so substeps are bounded the way the
   * caller asked rather than silently falling back to the defaults.
   *
   * `totalTimeout` must be the parent's REMAINING budget, not a fresh copy of
   * its original value - otherwise wrapping steps in a conditional becomes a
   * way to extend the total, and a caller who set a tight bound to fail fast
   * would not get it.
   */
  budget?: { stepTimeout?: number; totalTimeout?: number },
  /**
   * The parent RUN's signal. Without it a nested sequence is deaf to
   * `replay cancel` even at its own step boundaries - the substep loop would
   * run to completion after the user cancelled.
   */
  abortSignal?: AbortSignal
): Promise<ConditionalFlowResult> {
  const { logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();
  const currentDepth = ctx.conditionalDepth ?? 0;
  const callStack = ctx.conditionalCallStack ?? [];

  // Check recursion depth limit - allows oscillating patterns (A→B→A) up to max depth
  if (currentDepth >= replayConfig.maxConditionalDepth) {
    const chain = [...callStack, sequenceName].join(' → ');
    await debugLog(logPrefix, `Conditional depth limit exceeded: ${chain}`);
    return {
      success: false,
      executed: false,
      sequenceName,
      error: `Conditional depth limit (${replayConfig.maxConditionalDepth}) reached: ${chain}. Increase maxConditionalDepth in config if this is intentional.`
    };
  }

  // Evaluate the condition
  const condResult = await evaluateCondition(condition, ctx);

  if (!condResult.met) {
    // Check if this is an error vs genuine "condition not met"
    if ('isError' in condResult && condResult.isError) {
      // This is an ERROR - fail the sequence
      await debugLog(logPrefix, `Condition evaluation ERROR: ${condResult.reason}`);
      return {
        success: false,
        executed: false,
        sequenceName,
        error: `Condition evaluation failed: ${condResult.reason}`
      };
    }

    // Genuine "condition not met" - this is success (we correctly evaluated and skipped)
    if ('reason' in condResult && condResult.reason) {
      await debugLog(logPrefix, `Condition not met: ${condResult.reason}`);
    } else {
      await debugLog(logPrefix, `Condition ${condition} not met, skipping sequence ${sequenceName}`);
    }
    return { success: true, executed: false, sequenceName };
  }

  await debugLog(logPrefix, `Condition ${condition} met, loading sequence: ${sequenceName}`);

  // Load the sequence
  const loadResult = await loadSequence({ name: sequenceName }, recorder);
  if (!loadResult.success) {
    return { success: false, executed: false, sequenceName, error: `Sequence "${sequenceName}" not found: ${loadResult.error}` };
  }

  const { filteredSequence, nestedConnection, filteredCommands } =
    await prepareNestedSequence(loadResult.sequence, ctx, sequenceName, logPrefix);

  await debugLog(logPrefix, `Executing conditional sequence "${filteredSequence.name}" with ${filteredCommands.length} commands (depth: ${currentDepth + 1})`);

  // Execute the sequence with updated call stack and depth
  const execResult = await executeSteps({
    sequence: filteredSequence,
    startStep: 0,
    ctx: {
      ...ctx,
      ...(nestedConnection ? { connectionReason: nestedConnection } : {}),
      conditionalDepth: currentDepth + 1,
      conditionalCallStack: [...callStack, sequenceName]
    },
    // Omitted keys fall back to executeSteps' own defaults, so an unbudgeted
    // caller behaves exactly as before.
    ...(budget?.stepTimeout !== undefined ? { stepTimeout: budget.stepTimeout } : {}),
    ...(budget?.totalTimeout !== undefined ? { totalTimeout: budget.totalTimeout } : {}),
    abortSignal,
  });

  // Check for failures
  const failedStep = execResult.results.find(r => !r.success);
  if (failedStep) {
    // Don't wrap errors that are already from nested conditionals - just pass through
    const isNestedConditionalError = failedStep.tool === 'conditional' ||
      failedStep.error?.includes('Conditional depth limit') ||
      failedStep.error?.includes('Condition evaluation failed');

    const error = isNestedConditionalError
      ? failedStep.error
      : `Conditional sequence "${sequenceName}" failed at step ${failedStep.step} (${failedStep.tool}): ${failedStep.error}`;

    return {
      success: false,
      executed: true,
      sequenceName,
      substeps: execResult.results,
      error,
      durationMs: execResult.durationMs
    };
  }

  await debugLog(logPrefix, `Conditional sequence completed successfully in ${execResult.durationMs}ms`);
  return {
    success: true,
    executed: true,
    sequenceName,
    substeps: execResult.results,
    durationMs: execResult.durationMs
  };
}

// =============================================================================
// forEach
// =============================================================================

export interface ForEachFlowResult {
  success: boolean;
  sequenceName: string;
  /** Items the source yielded, before `where` filtering. */
  itemsFound: number;
  /** Items that actually ran `do`. */
  iterations: number;
  substeps?: StepResult[];
  error?: string;
  durationMs?: number;
}

/**
 * Resolve a `forEach` source to the array it enumerates.
 *
 * Two forms, deliberately no more. `{{var:name}}` reads an array a previous
 * `saveAs` step captured - which is how anything non-DOM is enumerated, since
 * `inspect({ action: 'evaluateExpression' })` can already return exactly the
 * list the caller wants and is a recordable step. `{{selectorAll:CSS}}` covers
 * the DOM case without making the caller hand-write an evaluate for it.
 *
 * Note the asymmetry with `conditional`'s conditions: those ask whether one
 * named thing exists, so they can't express "give me every X". That gap is the
 * whole reason this step exists.
 */
export async function resolveForEachItems(
  source: unknown,
  ctx: ExecutionContext
): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }> {
  // Already an array: `{{var:rows}}` is a whole-string token, so the run's
  // normal param interpolation has resolved it before this step is dispatched -
  // and it preserves type, so what arrives IS the captured array. That is the
  // common path; the string form below only survives for a nested path that
  // resolved to something odd, and for direct calls.
  if (Array.isArray(source)) return { ok: true, items: source };

  if (typeof source !== 'string') {
    return {
      ok: false,
      error: `forEach: source resolved to ${source === null ? 'null' : typeof source}, not an array. Expected {{var:name}} pointing at an array, or {{selectorAll:CSS}}.`,
    };
  }

  const varMatch = source.match(/^\{\{var:([^}]+)\}\}$/);
  if (varMatch) {
    const path = varMatch[1].trim();
    const [head, ...rest] = path.split('.');
    let value: any = ctx.variableStore?.[head];
    if (value === undefined) {
      return { ok: false, error: `forEach: no variable named "${head}". Capture one first with a { saveAs } step.` };
    }
    for (const key of rest) {
      value = value?.[key];
      if (value === undefined) {
        return { ok: false, error: `forEach: "${path}" is undefined on the captured variable.` };
      }
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: `forEach: "${path}" is ${typeof value}, not an array. The source must resolve to an array.` };
    }
    return { ok: true, items: value };
  }

  const selectorMatch = source.match(/^\{\{selectorAll:(.+)\}\}$/);
  if (selectorMatch) {
    const selector = selectorMatch[1];
    // Elements themselves can't cross the CDP boundary, so each item is a plain
    // descriptor. `index` is what a `do` sequence uses to address the element
    // again (:nth-of-type and friends); text/id/class cover the common filters.
    const expression = `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el, index) => ({
      index,
      text: (el.textContent || '').trim(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      href: el.getAttribute && el.getAttribute('href'),
      value: 'value' in el ? el.value : undefined,
    })))()`;
    try {
      const result = await ctx.executeToolCall('inspect', {
        action: 'evaluateExpression',
        expression,
        ...(ctx.connectionReason ? { connectionReason: ctx.connectionReason } : {}),
      });
      const value = (result as any)?._meta?.inspect?.value;
      if (!Array.isArray(value)) {
        return { ok: false, error: `forEach: {{selectorAll:${selector}}} did not evaluate to a list.` };
      }
      return { ok: true, items: value };
    } catch (err: any) {
      return { ok: false, error: `forEach: enumerating {{selectorAll:${selector}}} failed: ${err?.message || String(err)}` };
    }
  }

  return {
    ok: false,
    error: `forEach: unrecognised source "${source}". Expected {{var:name}} (an array captured by a previous saveAs) or {{selectorAll:CSS}}.`,
  };
}

/**
 * Evaluate a `where` predicate for one item.
 *
 * The predicate is JavaScript with `item` and `index` in scope, evaluated in the
 * page - NOT the `{{...}}` condition grammar. Conditions probe the browser for
 * one named thing; a filter has to read fields off an arbitrary object, which
 * that grammar cannot express, and inventing a second mini-language to sit
 * beside it would leave two half-expressive syntaxes instead of one real one.
 */
async function evaluateForEachFilter(
  where: string,
  item: unknown,
  index: number,
  ctx: ExecutionContext
): Promise<{ ok: true; keep: boolean } | { ok: false; error: string }> {
  const expression = `(() => { const item = ${JSON.stringify(item)}; const index = ${index}; return !!(${where}); })()`;
  try {
    const result = await ctx.executeToolCall('inspect', {
      action: 'evaluateExpression',
      expression,
      ...(ctx.connectionReason ? { connectionReason: ctx.connectionReason } : {}),
    });
    return { ok: true, keep: (result as any)?._meta?.inspect?.value === true };
  } catch (err: any) {
    // A filter that cannot be evaluated is an error, not a quiet "exclude" -
    // the same rule conditions follow. Silently dropping every item would make
    // a typo'd predicate look like an empty result set.
    return { ok: false, error: `forEach: where "${where}" could not be evaluated: ${err?.message || String(err)}` };
  }
}

/**
 * Run a sequence once per item of an enumerated source.
 *
 * Each iteration binds the item to `as` in the run's variable store (and its
 * position to `<as>Index`), so the body addresses it with {{var:<as>.field}}
 * exactly like any captured variable. The binding is REPLACED per iteration
 * rather than scoped, because the variable store is shared by reference across
 * nested runs - which also means a body's own `saveAs` captures survive into
 * the next iteration, and a caller relying on that should say so.
 */
export async function executeForEachFlow(
  params: { in: unknown; as: string; do: string; where?: string; maxItems?: number },
  ctx: ExecutionContext,
  recorder: CommandRecorder,
  /** The parent's REMAINING budget - a loop must not extend the total. */
  budget?: { stepTimeout?: number; totalTimeout?: number },
  abortSignal?: AbortSignal
): Promise<ForEachFlowResult> {
  const { logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();
  const startedAt = Date.now();
  const sequenceName = params.do;
  const currentDepth = ctx.conditionalDepth ?? 0;
  const callStack = ctx.conditionalCallStack ?? [];

  // Shares the conditional depth budget: a loop body that loops is the same
  // runaway risk, and one cap is easier to reason about than two.
  if (currentDepth >= replayConfig.maxConditionalDepth) {
    const chain = [...callStack, sequenceName].join(' → ');
    return {
      success: false, sequenceName, itemsFound: 0, iterations: 0,
      error: `Nesting depth limit (${replayConfig.maxConditionalDepth}) reached: ${chain}. Increase maxConditionalDepth in config if this is intentional.`,
    };
  }

  const resolved = await resolveForEachItems(params.in, ctx);
  if (!resolved.ok) {
    return { success: false, sequenceName, itemsFound: 0, iterations: 0, error: resolved.error };
  }

  const itemsFound = resolved.items.length;
  const cap = params.maxItems ?? DEFAULT_FOREACH_MAX_ITEMS;

  const loadResult = await loadSequence({ name: sequenceName }, recorder);
  if (!loadResult.success) {
    return {
      success: false, sequenceName, itemsFound, iterations: 0,
      error: `Sequence "${sequenceName}" not found: ${loadResult.error}`,
    };
  }
  const { filteredSequence, nestedConnection } =
    await prepareNestedSequence(loadResult.sequence, ctx, sequenceName, logPrefix);

  const substeps: StepResult[] = [];
  let iterations = 0;

  for (let index = 0; index < itemsFound; index++) {
    if (abortSignal?.aborted) {
      return {
        success: false, sequenceName, itemsFound, iterations, substeps,
        error: 'Replay aborted by user', durationMs: Date.now() - startedAt,
      };
    }
    if (iterations >= cap) {
      await debugLog(logPrefix, `forEach: stopping at maxItems (${cap}) with ${itemsFound - index} item(s) unvisited`);
      break;
    }

    const item = resolved.items[index];

    if (params.where) {
      const filtered = await evaluateForEachFilter(params.where, item, index, ctx);
      if (!filtered.ok) {
        return {
          success: false, sequenceName, itemsFound, iterations, substeps,
          error: filtered.error, durationMs: Date.now() - startedAt,
        };
      }
      if (!filtered.keep) continue;
    }

    const store = (ctx.variableStore ??= {});
    store[params.as] = item;
    store[`${params.as}Index`] = index;
    iterations++;

    const elapsed = Date.now() - startedAt;
    const execResult = await executeSteps({
      sequence: filteredSequence,
      startStep: 0,
      ctx: {
        ...ctx,
        ...(nestedConnection ? { connectionReason: nestedConnection } : {}),
        conditionalDepth: currentDepth + 1,
        conditionalCallStack: [...callStack, sequenceName],
      },
      ...(budget?.stepTimeout !== undefined ? { stepTimeout: budget.stepTimeout } : {}),
      ...(budget?.totalTimeout !== undefined
        ? { totalTimeout: Math.max(0, budget.totalTimeout - elapsed) }
        : {}),
      abortSignal,
    });

    substeps.push(...execResult.results);

    const failedStep = execResult.results.find(r => !r.success);
    if (failedStep) {
      return {
        success: false, sequenceName, itemsFound, iterations, substeps,
        error: `forEach body "${sequenceName}" failed on item ${index + 1}/${itemsFound} at step ${failedStep.step} (${failedStep.tool}): ${failedStep.error}`,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  await debugLog(logPrefix, `forEach over ${itemsFound} item(s) ran ${iterations} iteration(s) of "${sequenceName}"`);
  return { success: true, sequenceName, itemsFound, iterations, substeps, durationMs: Date.now() - startedAt };
}

// =============================================================================
// Sequence Loading
// =============================================================================

export interface LoadSequenceArgs {
  name?: string;
  sequenceId?: string;
}

export type LoadSequenceResult = {
  success: true;
  sequence: CommandSequence;
} | {
  success: false;
  error: string;
  errorCode: string;
  /** Template variables for error response (e.g., action, missing for MISSING_PARAMETER) */
  templateVars?: Record<string, string>;
};

/**
 * Load a sequence from memory (by sequenceId) or disk (by name)
 */
export async function loadSequence(
  args: LoadSequenceArgs,
  recorder: CommandRecorder
): Promise<LoadSequenceResult> {
  if (args.sequenceId) {
    // Disk wins when the file is newer: memory used to shadow an edited
    // sequence for the whole session, so a re-run silently executed the old
    // version (issue #134).
    const sequence = await recorder.getFreshSequence(args.sequenceId);
    if (!sequence) {
      return {
        success: false,
        error: `Sequence "${args.sequenceId}" not found in memory. Use listSaved to see disk sequences or list for memory sequences.`,
        errorCode: 'SEQUENCE_NOT_FOUND'
      };
    }
    return { success: true, sequence };
  }

  if (args.name) {
    // Check memory first
    const memorySequences = recorder.listSequences();
    const memoryMatch = memorySequences.find(s => s.name === args.name);
    if (memoryMatch) {
      const current = await recorder.getFreshSequence(memoryMatch.id) ?? memoryMatch;
      await debugLog('executor', `Found sequence "${current.name}" in memory`);
      return { success: true, sequence: current };
    }

    // Then check disk (loadSequenceFromDisk has fuzzy matching built in)
    const sequence = await recorder.loadSequenceFromDisk(args.name);

    if (!sequence) {
      const savedSequences = await recorder.listSavedSequencesOnDisk();
      const availableNames = [
        ...memorySequences.map(s => s.name),
        ...savedSequences.map(s => s.name)
      ].join(', ');
      return {
        success: false,
        error: `No sequence found matching "${args.name}". Available: ${availableNames || 'none'}`,
        errorCode: 'SEQUENCE_NOT_FOUND'
      };
    }

    await debugLog('executor', `Loaded sequence "${sequence.name}" via fuzzy match for "${args.name}"`);
    return { success: true, sequence };
  }

  return {
    success: false,
    error: 'Either "name" or "sequenceId" parameter is required.',
    errorCode: 'MISSING_PARAMETER',
    templateVars: { missing: 'name or sequenceId' }
  };
}

// =============================================================================
// Run-time Rebasing
// =============================================================================

/**
 * Return a deep copy of the sequence retargeted at another deployment:
 * every absolute http(s) URL — the startUrl and any string param in any
 * command (navigate goto, request url, ...) — keeps its path/query/hash but
 * takes `baseUrl`'s origin. Relative URLs are untouched (they already follow
 * the page origin). An explicit `startUrl` replaces the sequence's startUrl
 * wholesale, after rebasing, for runs whose entry point differs per target
 * (e.g. a freshly minted share link). The stored sequence is never mutated —
 * loadSequence can return the recorder's in-memory object.
 */
export function rebaseSequence(
  sequence: CommandSequence,
  overrides: { baseUrl?: string; startUrl?: string }
): CommandSequence {
  const origin = overrides.baseUrl ? new URL(overrides.baseUrl).origin : null;
  const rebase = (value: string): string => {
    if (!origin || !/^https?:\/\//i.test(value)) return value;
    try {
      const u = new URL(value);
      return origin + u.pathname + u.search + u.hash;
    } catch {
      return value;
    }
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return rebase(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return {
    ...sequence,
    startUrl: overrides.startUrl ?? (sequence.startUrl ? rebase(sequence.startUrl) : sequence.startUrl),
    // A declared connection's `url` is where its browser comes up. Left on the
    // recorded origin it opens the wrong deployment before step 1, and every
    // step that assumes the app is already loaded runs against that page.
    ...(sequence.requiredConnections
      ? {
          requiredConnections: sequence.requiredConnections.map(d =>
            d.url ? { ...d, url: rebase(d.url) } : d
          ),
        }
      : {}),
    commands: sequence.commands.map(cmd => ({
      ...cmd,
      params: walk(cmd.params) as RecordedCommand['params'],
    })),
  };
}

// =============================================================================
// Connection Analysis
// =============================================================================

/**
 * Analyze sequence commands to find launchChrome and determine connection requirements
 */
export function analyzeSequenceConnections(commands: RecordedCommand[]): ConnectionAnalysis {
  let launchChromeIndex = -1;
  let firstConnectionToolIndex = -1;

  for (let i = 0; i < commands.length; i++) {
    if (commands[i].tool === 'launchChrome' && launchChromeIndex === -1) {
      launchChromeIndex = i;
    }
    if (commandNeedsBrowserConnection(commands[i]) && firstConnectionToolIndex === -1) {
      firstConnectionToolIndex = i;
    }
  }

  const hasLaunchBeforeConnection = launchChromeIndex !== -1 &&
    (firstConnectionToolIndex === -1 || launchChromeIndex < firstConnectionToolIndex);

  return { launchChromeIndex, firstConnectionToolIndex, hasLaunchBeforeConnection };
}

/**
 * Extract connectionReason from sequence's launchChrome command if present
 */
export function extractConnectionFromSequence(
  commands: RecordedCommand[],
  analysis: ConnectionAnalysis
): string | undefined {
  if (analysis.hasLaunchBeforeConnection) {
    const launchParams = commands[analysis.launchChromeIndex].params;
    if (launchParams.reference) {
      return sanitizeReference(launchParams.reference);
    }
  }
  return undefined;
}

export interface RecordedConnectionAnalysis {
  /** Distinct per-step connection references, in first-seen order. */
  references: string[];
  /** The one reference every connection-bearing step shares, if there is one. */
  uniform?: string;
  /**
   * True when some steps name a connection and other BROWSER steps don't - the
   * recording was driven partly through the active connection, so we cannot tell
   * which browser the bare steps belonged to. Such a sequence is not hoisted
   * (that could pin every step to the one named reference) and `create` says so.
   */
  mixed: boolean;
  /** More than one distinct per-step reference: a genuinely multi-connection sequence. */
  multiConnection: boolean;
}

/**
 * What connections a recorded/stored sequence's steps name.
 */
export function analyzeRecordedStepConnections(commands: RecordedCommand[]): RecordedConnectionAnalysis {
  const references: string[] = [];
  let bareBrowserSteps = 0;

  for (const cmd of commands) {
    const raw = cmd.params?.connectionReason;
    if (typeof raw === 'string' && raw.trim()) {
      const ref = sanitizeReference(raw);
      if (!references.includes(ref)) references.push(ref);
    } else if (commandTakesInjectedConnection(cmd)) {
      bareBrowserSteps++;
    }
  }

  return {
    references,
    ...(references.length === 1 ? { uniform: references[0] } : {}),
    mixed: references.length > 0 && bareBrowserSteps > 0,
    multiConnection: references.length > 1,
  };
}

/**
 * Hoist a uniform per-step connection back off the steps so the sequence stays
 * portable: `replay({ action: 'run', connectionReason: 'other' })` can then
 * retarget the whole thing. Steps keep their own connection only where the
 * sequence genuinely spans connections (or where it is ambiguous - see
 * `mixed`), which is the case a run-level connection cannot express.
 *
 * Returns a new command array; the input is never mutated.
 */
export function normalizeStepConnections(commands: RecordedCommand[]): {
  commands: RecordedCommand[];
  /** The reference that was hoisted off every step, if any. */
  hoisted?: string;
  analysis: RecordedConnectionAnalysis;
} {
  const analysis = analyzeRecordedStepConnections(commands);

  if (analysis.uniform === undefined || analysis.mixed) {
    return { commands, analysis };
  }

  const hoisted = analysis.uniform;
  const stripped = commands.map(cmd => {
    if (cmd.params?.connectionReason === undefined) return cmd;
    const { connectionReason, ...rest } = cmd.params;
    return { ...cmd, params: rest };
  });

  return { commands: stripped, hoisted, analysis };
}

/**
 * Normalize a recorded-reference -> session-reference map (both sides sanitized,
 * so `{ 'Duo Member Two': 'My Second Browser' }` works the same as the
 * hyphenated form). Returns undefined for an empty/absent map.
 */
export function sanitizeConnectionMap(
  map?: Record<string, string>
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string' || !to.trim()) continue;
    out[sanitizeReference(from)] = sanitizeReference(to);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Check if sequence needs a connection
 */
export function sequenceNeedsConnection(commands: RecordedCommand[]): boolean {
  return commands.some(cmd =>
    commandNeedsBrowserConnection(cmd) && !cmd.params.connectionReason
  );
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * The connection references live in this session, as `listConnections` reports
 * them. Returns null when that cannot be determined (probe failed, or a stubbed
 * executeToolCall returned nothing parseable) - callers must treat null as
 * "unknown" and NOT as "empty", or every per-step connection would be rejected.
 */
export async function probeLiveConnectionReferences(
  executeToolCall: ExecuteToolCall
): Promise<Set<string> | null> {
  try {
    const result = await executeToolCall('listConnections', {});
    const text = result?.content?.[0]?.text || '';
    const parsed = parseConnectionList(text);
    if (!parsed) return null;
    // A connection whose socket has already dropped is not somewhere a step can
    // run, so it must not count as live - otherwise a healing sequence skips the
    // launch that would have replaced it.
    const refs = new Set<string>();
    for (const c of parsed) {
      if (c.connected !== false) refs.add(sanitizeReference(c.reference));
    }
    return refs.size > 0 ? refs : null;
  } catch {
    return null;
  }
}

/**
 * The `connections` array out of a `listConnections` response, or null when the
 * response carries no parseable JSON block (a stub, or a future format) - null
 * means "unknown", never "empty".
 */
export function parseConnectionList(
  text: string
): Array<{ reference: string; port?: number; connected?: boolean }> | null {
  const block = text.match(/```json\s*([\s\S]*?)```/);
  if (!block) return null;
  try {
    const parsed = JSON.parse(block[1]);
    const list = parsed?.connections;
    if (!Array.isArray(list)) return null;
    return list.filter((c: any) => typeof c?.reference === 'string');
  } catch {
    return null;
  }
}

/**
 * Resolve a step's RECORDED connectionReason onto this session, and refuse to
 * proceed if it doesn't exist here (bug-018).
 *
 * Falling back to the run-level connection with a warning is exactly the failure
 * this exists to prevent: a sequence whose purpose is proving something crosses
 * a browser boundary would run entirely in one browser and still pass.
 */
export function formatMissingStepConnection(opts: {
  step: number;
  tool: string;
  recorded: string;
  resolved: string;
  mapped: boolean;
  runConnection?: string;
  live: string[];
}): string {
  const { step, tool, recorded, resolved, mapped, runConnection, live } = opts;
  const via = mapped ? ` (mapped from recorded "${recorded}")` : '';
  return [
    `Step ${step} (${tool}) needs connection "${resolved}"${via}, which does not exist in this session.`,
    `Active connections: ${live.length ? live.join(', ') : 'none'}.`,
    `The step names its own connection, so it is NOT run against` +
      ` the run-level connection${runConnection ? ` "${runConnection}"` : ''} - that would replay a` +
      ` multi-browser sequence in a single browser and report success.`,
    `Either create it (launchChrome({ reference: "${resolved}" })) or rebind it:` +
      ` replay({ action: 'run', ..., connections: { "${recorded}": "<a reference from this session>" } }).`,
  ].join(' ');
}

/**
 * Check if debugger is paused and return breakpoint info if so
 */
export async function checkIfPaused(
  ctx: ExecutionContext
): Promise<BreakpointHitInfo | null> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return null;

  try {
    const callStackResult = await executeToolCall('inspect', {
      action: 'getCallStack',
      connectionReason
    });

    const callStackText = callStackResult?.content?.[0]?.text || '';
    const isPaused = callStackText.includes('callFrameId');

    if (isPaused) {
      // Extract pause location from call stack - try header format first, then JSON
      let url = 'unknown';
      let lineNumber = 0;
      let columnNumber: number | undefined;
      let functionName: string | undefined;

      // Try header format: "Paused at: http://localhost:3101/client.js:6"
      const pausedAtMatch = callStackText.match(/Paused at:\s*([^:\s]+):(\d+)/);
      if (pausedAtMatch) {
        url = pausedAtMatch[1];
        lineNumber = parseInt(pausedAtMatch[2], 10);
      }

      // Try JSON format for more details
      const sourceMatch = callStackText.match(/"source":\s*"([^"]+)"/);
      const lineMatch = callStackText.match(/"line":\s*(\d+)/);
      const colMatch = callStackText.match(/"column":\s*(\d+)/);
      const funcMatch = callStackText.match(/"functionName":\s*"([^"]+)"/);

      if (sourceMatch) url = sourceMatch[1];
      if (lineMatch) lineNumber = parseInt(lineMatch[1], 10);
      if (colMatch) columnNumber = parseInt(colMatch[1], 10);
      if (funcMatch && funcMatch[1]) functionName = funcMatch[1];

      return { url, lineNumber, columnNumber, functionName };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if debugger is paused and auto-resume if so
 */
export async function resumeIfPaused(
  ctx: ExecutionContext
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return;

  const pauseInfo = await checkIfPaused(ctx);
  if (pauseInfo) {
    debugLog(logPrefix, `Debugger is paused at ${pauseInfo.url}:${pauseInfo.lineNumber}, auto-resuming`);
    try {
      await executeToolCall('execution', {
        action: 'resume',
        connectionReason
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      // Ignore resume errors
    }
  }
}

// =============================================================================
// Auto-Launch Helper
// =============================================================================

export type AutoLaunchResult = {
  success: true;
} | {
  success: false;
  error: string;
  errorType: 'INVALID_REFERENCE' | 'LAUNCH_FAILED';
};

/**
 * Validate reference and auto-launch Chrome if needed.
 * This is the shared helper for all auto-launch scenarios.
 */
export async function autoLaunchChrome(
  executeToolCall: ExecuteToolCall,
  connectionReason: string,
  logPrefix: string = 'auto-launch',
  forceNewInstance: boolean = false
): Promise<AutoLaunchResult> {
  // Validate connectionReason before launch (throws InvalidReferenceError if invalid)
  requireValidReference(connectionReason);

  await debugLog(logPrefix, `Auto-launching Chrome with reference: ${connectionReason} (forceNewInstance=${forceNewInstance})`);

  // A launch failure arrives as a THROW in production (executeToolCall rethrows
  // isError) - and this helper is called from inside ensureConnection's catch,
  // so letting it through escaped the run entirely: the caller's LAUNCH_FAILED
  // handling, and its "launch Chrome manually first" suggestion, never ran and
  // the user saw a raw tool error instead.
  try {
    await executeToolCall('launchChrome', { reference: connectionReason, forceNewInstance });
  } catch (launchError: any) {
    return {
      success: false,
      error: `Failed to auto-launch Chrome: ${launchError?.response?.content?.[0]?.text || launchError?.message || 'Unknown error'}`,
      errorType: 'LAUNCH_FAILED'
    };
  }

  await debugLog(logPrefix, `Chrome launched successfully with reference: ${connectionReason}`);
  return { success: true };
}

/**
 * Ensure a connection is available, auto-launching Chrome if needed
 */
export async function ensureConnection(
  ctx: ExecutionContext,
  needsConnection: boolean,
  hasLaunchBeforeConnection: boolean
): Promise<{ success: true; didAutoLaunch: boolean } | { success: false; error: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!needsConnection || hasLaunchBeforeConnection) {
    return { success: true, didAutoLaunch: false };
  }

  try {
    await debugLog(logPrefix, `Checking connection: ${connectionReason}`);
    const infoResult = await executeToolCall('navigate', { action: 'info', connectionReason });
    // In production this throws instead, into the same catch below; the check
    // is for a caller wired not to rethrow.
    if (infoResult?.isError) {
      throw new Error('Connection not active');
    }
    await debugLog(logPrefix, `Connection ${connectionReason} is active`);

    // Auto-resume if paused at a breakpoint
    await resumeIfPaused(ctx);

    return { success: true, didAutoLaunch: false };
  } catch {
    await debugLog(logPrefix, `Connection ${connectionReason} not active, launching Chrome...`);
    // Sequence runs always get a fresh Chrome process, not a tab in an existing one
    const launchResult = await autoLaunchChrome(executeToolCall, connectionReason, logPrefix, true);
    if (!launchResult.success) {
      return { success: false, error: launchResult.error };
    }
    return { success: true, didAutoLaunch: true };
  }
}

/**
 * Check if a URL's port is open (for localhost URLs only)
 * Returns success if port is open or URL is not localhost
 */
export async function checkPortBeforeNavigation(
  url: string,
  logPrefix: string = 'executor'
): Promise<{ success: true } | { success: false; error: string }> {
  const portCheck = await checkUrlPort(url, 2000);

  // null means non-localhost URL - skip check
  if (portCheck === null) {
    return { success: true };
  }

  if (!portCheck.open) {
    const error = `Port ${portCheck.port} is not open on ${portCheck.host}`;
    await debugLog(logPrefix, error);
    return { success: false, error };
  }

  await debugLog(logPrefix, `Port ${portCheck.port} is open on ${portCheck.host}`);
  return { success: true };
}

/**
 * Navigate to startUrl if sequence has one and doesn't start with navigate
 */
export async function navigateToStartUrl(
  ctx: ExecutionContext,
  sequence: CommandSequence,
  analysis: ConnectionAnalysis
): Promise<{ success: true } | { success: false; error: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!sequence.startUrl || !connectionReason) {
    return { success: true };
  }

  const commands = sequence.commands;
  const firstNavigateIndex = commands.findIndex(cmd =>
    cmd.tool === 'navigate' && cmd.params.action === 'goto'
  );
  const startsWithNavigate = firstNavigateIndex === 0 ||
    (analysis.hasLaunchBeforeConnection && firstNavigateIndex === analysis.launchChromeIndex + 1);

  if (startsWithNavigate) {
    return { success: true };
  }

  // Check if port is open before navigating (localhost only)
  const portCheck = await checkPortBeforeNavigation(sequence.startUrl, logPrefix);
  if (!portCheck.success) {
    return portCheck;
  }

  await debugLog(logPrefix, `Auto-navigating to startUrl: ${sequence.startUrl}`);
  try {
    await executeToolCall('navigate', {
      action: 'goto',
      url: sequence.startUrl,
      connectionReason
    });
    await debugLog(logPrefix, `Navigated to startUrl: ${sequence.startUrl}`);
    return { success: true };
  } catch (navError: any) {
    return {
      success: false,
      error: `Failed to navigate to startUrl: ${navError.message}`
    };
  }
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute a single command with retry logic for element not found errors
 */
export async function executeCommandWithRetry(
  executeToolCall: ExecuteToolCall,
  tool: string,
  params: Record<string, any>,
  logPrefix: string = 'executor',
  /**
   * The RUN's signal, forwarded to the tool handler so handlers that honour
   * it (currently `wait`) are interrupted mid-step by `replay cancel`. Note
   * this helper still RESOLVES `{ success: false }` when a handler throws an
   * abort - executeSteps consults the signal on the failure path to classify
   * it as "Replay aborted by user" rather than a genuine step failure.
   */
  abortSignal?: AbortSignal
): Promise<{ success: boolean; result?: any; error?: string }> {
  const isRetryableAction = tool === 'input' && ['click', 'type', 'hover'].includes(params.action);
  const maxRetries = isRetryableAction ? 5 : 1;
  const retryDelayMs = 500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // A tool error arrives as an EXCEPTION: executeToolCall raises a ToolError
    // for any isError response. The catch is what drives element-not-found
    // retries (e.g. an async-rendered button that hasn't mounted yet).
    let result: any;
    try {
      result = await executeToolCall(tool, params, abortSignal);
    } catch (err: any) {
      const errorText = err?.response?.content?.[0]?.text || err?.message || '';
      // A bare "not found" also matched CONNECTION_NOT_FOUND, SEQUENCE_NOT_FOUND
      // and friends, so a click against a dead connection burned all five
      // retries and 2.5s before reporting what was wrong on the first attempt.
      const isElementNotFound = isElementNotFoundFailure({
        errorId: err?.response?._errorId,
        text: errorText,
      });

      if (isRetryableAction && isElementNotFound && attempt < maxRetries) {
        debugLog(logPrefix, `Element not found, retrying... (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return { success: false, error: errorText.split('\n')[0] || 'Unknown error' };
    }

    return { success: true, result };
  }

  return { success: false, error: 'Max retries exceeded' };
}

/**
 * Validate that navigation succeeded (page loaded correctly)
 */
export async function validateNavigation(
  ctx: ExecutionContext,
  expectedUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  try {
    const infoResult = await executeToolCall('navigate', {
      action: 'info',
      connectionReason
    });

    const infoText = infoResult?.content?.[0]?.text || '';

    // Check for common error patterns
    if (infoText.includes('about:blank') && expectedUrl && !expectedUrl.includes('about:blank')) {
      return { success: false, error: 'Page failed to load (stuck on about:blank)' };
    }

    // Check for Chrome error pages
    if (infoText.includes('chrome-error://') || infoText.includes('ERR_')) {
      const errMatch = infoText.match(/(ERR_[A-Z_]+)/);
      return { success: false, error: `Page failed to load: ${errMatch?.[1] || 'connection error'}` };
    }

    // Check title for error indicators
    const titleMatch = infoText.match(/\*\*Title:\*\*\s*([^\n]+)/);
    const title = titleMatch?.[1]?.toLowerCase() || '';
    if (title.includes("site can't be reached") || title.includes("this site can't be reached")) {
      return { success: false, error: 'Site cannot be reached' };
    }

    debugLog(logPrefix, `Navigation validated successfully`);
    return { success: true };
  } catch (err: any) {
    debugLog(logPrefix, `Navigation validation failed: ${err.message}`);
    return { success: false, error: `Could not validate navigation: ${err.message}` };
  }
}

/**
 * Wait for an element to appear
 */
export async function waitForElement(
  ctx: ExecutionContext,
  selector: string
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Waiting for element: ${selector}`);

  let retries = 5;
  while (retries > 0) {
    try {
      const result = await executeToolCall('dom', {
        action: 'querySelector',
        selector,
        connectionReason
      });

      if (result && !result.isError) {
        debugLog(logPrefix, `Element ${selector} found`);
        return;
      }
    } catch {
      // Ignore errors during wait
    }

    retries--;
    if (retries > 0) {
      debugLog(logPrefix, `Element ${selector} not found, waiting... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  debugLog(logPrefix, `Warning: Element ${selector} not found after waiting`);
}

/**
 * Validate typed text was entered correctly
 */
export async function validateTypedText(
  ctx: ExecutionContext,
  selector: string,
  expectedText: string,
  append: boolean = false
): Promise<void> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Validating typed text in ${selector}${append ? ' (append mode)' : ''}`);

  try {
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check .value for inputs/textareas, fall back to .innerText for contenteditable elements (e.g., ProseMirror)
    const evalResult = await executeToolCall('inspect', {
      action: 'evaluateExpression',
      expression: `(() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return '';
        // For input/textarea, use .value
        if (el.value !== undefined && el.value !== '') return el.value;
        // For contenteditable (ProseMirror, etc.), use innerText
        if (el.isContentEditable || el.contentEditable === 'true') return el.innerText?.trim() || '';
        return el.value || '';
      })()`,
      connectionReason
    });

    let actualValue = '';
    if (evalResult?.content?.[0]?.text) {
      const codeBlockMatch = evalResult.content[0].text.match(/```(?:json)?\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        actualValue = codeBlockMatch[1].trim();
        if (actualValue.startsWith('"') && actualValue.endsWith('"')) {
          actualValue = JSON.parse(actualValue);
        }
      }
    }

    // In append mode, check if the field ends with the expected text
    // In replace mode, check for exact match
    if (append) {
      if (!actualValue.endsWith(expectedText)) {
        debugLog(logPrefix, `Text validation failed (append): expected to end with "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected to end with "${expectedText}", got "${actualValue}"`);
      }
    } else {
      if (actualValue !== expectedText) {
        debugLog(logPrefix, `Text validation failed: expected "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected "${expectedText}", got "${actualValue}"`);
      }
    }

    debugLog(logPrefix, `Text validated: "${actualValue}" ${append ? 'ends with' : 'matches'} expected`);
  } catch (error: any) {
    if (error.message?.includes('Text validation failed')) {
      throw error;
    }
    debugLog(logPrefix, `Warning: Could not validate typed text: ${error}`);
  }
}

// =============================================================================
// Click Validation
// =============================================================================

export interface PreClickState {
  consoleErrorCount: number;
  consoleWarnCount: number;
  consoleTotalCount: number;
  networkRequestCount: number;
  url: string;
  /** ids of the most-recent console errors seen before the click (bounded by
   *  CLICK_VALIDATION_ERROR_SAMPLE), to identify which post-click errors are
   *  actually new rather than just diffing a count. */
  errorIdsBeforeClick: Set<string>;
}

/** How many of the most recent console errors to sample around a click - enough
 *  to identify every genuinely new one in the common case, without pulling the
 *  whole console history for a check that runs after every click. */
const CLICK_VALIDATION_ERROR_SAMPLE = 10;

/** Browser-initiated noise a click didn't cause and can't prevent - a missing
 *  favicon 404s on nearly every page load, unrelated to what was clicked. */
function isNoiseConsoleUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /\/favicon\.ico$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface ClickValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

/**
 * Capture pre-click state for delta comparison
 */
export async function capturePreClickState(ctx: ExecutionContext): Promise<PreClickState> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  let consoleErrorCount = 0;
  let consoleWarnCount = 0;
  let consoleTotalCount = 0;
  let networkRequestCount = 0;
  let url = '';
  let errorIdsBeforeClick = new Set<string>();

  try {
    // Get console counts via _meta, plus the most recent errors' ids so a
    // post-click diff can tell which ones are actually new.
    const consoleResult = await executeToolCall('console', {
      action: 'recent', type: 'error', count: CLICK_VALIDATION_ERROR_SAMPLE, connectionReason
    });
    consoleErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    consoleWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    consoleTotalCount = consoleResult?._meta?.console?.totalCount || 0;
    errorIdsBeforeClick = new Set((consoleResult?._meta?.console?.entries || []).map((e: { id: string }) => e.id));
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click console state');
  }

  try {
    // Get network request count via _meta
    const networkResult = await executeToolCall('network', {
      action: 'list', limit: 1, connectionReason
    });
    networkRequestCount = networkResult?._meta?.network?.totalCount || 0;
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click network state');
  }

  try {
    // Get current URL via _meta
    const pageResult = await executeToolCall('navigate', {
      action: 'info', connectionReason
    });
    url = pageResult?._meta?.navigate?.url || '';
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click URL');
  }

  return { consoleErrorCount, consoleWarnCount, consoleTotalCount, networkRequestCount, url, errorIdsBeforeClick };
}

/**
 * Validate click action results
 */
export async function validateClickAction(
  ctx: ExecutionContext,
  preState: PreClickState,
  clickResult: any,
  config: ClickValidationConfig
): Promise<ClickValidationResult> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // Get structured data from _meta
  const clickMeta: ClickActionMeta | undefined = clickResult?._meta?.click;

  // Small delay before validation
  if (config.postClickDelayMs > 0) {
    await new Promise(r => setTimeout(r, config.postClickDelayMs));
  }

  // 1. Check if click had any effect (DOM changes)
  if (config.requireDomChanges && clickMeta?.domChanges) {
    if (clickMeta.domChanges.mutationCount === 0) {
      const msg = 'Click had no DOM effect (0 mutations)';
      if (config.domChangesFailMode === 'error') {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // 2. Check for navigation and validate it
  if (config.validateNavigation && clickMeta?.navigationOccurred) {
    const navResult = await validateNavigation(ctx);
    if (!navResult.success) {
      errors.push(`Navigation failed: ${navResult.error}`);
    }
  }

  // 3. Check for new console messages
  try {
    const consoleResult = await executeToolCall('console', {
      action: 'recent', type: 'error', count: CLICK_VALIDATION_ERROR_SAMPLE, connectionReason
    });
    const newErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    const newWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    const newTotalCount = consoleResult?._meta?.console?.totalCount || 0;

    // Report new errors (respecting failOnConsoleErrors config), excluding ones
    // identifiable as browser noise unrelated to the click (e.g. a favicon 404).
    if (config.failOnConsoleErrors && newErrorCount > preState.consoleErrorCount) {
      const diff = newErrorCount - preState.consoleErrorCount;
      const newEntries: Array<{ id: string; url?: string }> = consoleResult?._meta?.console?.entries || [];
      const genuinelyNew = newEntries.filter(e => !preState.errorIdsBeforeClick.has(e.id));
      const actionable = genuinelyNew.filter(e => !isNoiseConsoleUrl(e.url));

      if (genuinelyNew.length === 0 || actionable.length > 0) {
        const msg = `${diff} new console error(s) after click`;
        if (config.consoleErrorsFailMode === 'error') {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      } else {
        info.push(`${diff} new console error(s) after click, all identified as unrelated browser noise (e.g. favicon) - ignored`);
      }
    }

    // Report new warnings as info
    if (newWarnCount > preState.consoleWarnCount) {
      const diff = newWarnCount - preState.consoleWarnCount;
      info.push(`${diff} new console warning(s)`);
    }

    // Report other new messages (log/info) as info
    const newLogInfoCount = (newTotalCount - newErrorCount - newWarnCount) -
                            (preState.consoleTotalCount - preState.consoleErrorCount - preState.consoleWarnCount);
    if (newLogInfoCount > 0) {
      info.push(`${newLogInfoCount} new console log(s)`);
    }
  } catch {
    debugLog(logPrefix, 'Warning: Could not check console after click');
  }

  // 4. Check for network request failures
  if (config.validateNetworkPayload) {
    try {
      const networkResult = await executeToolCall('network', {
        action: 'list', connectionReason
      });
      const newCount = networkResult?._meta?.network?.totalCount || 0;
      if (newCount > preState.networkRequestCount) {
        // Check for failed POST requests
        const failedResult = await executeToolCall('network', {
          action: 'search', method: 'POST', statusCode: '4', connectionReason
        });
        const failedCount = failedResult?._meta?.network?.matchCount || 0;
        if (failedCount > 0) {
          const msg = 'POST request returned 4xx error';
          if (config.networkFailMode === 'error') {
            errors.push(msg);
          } else {
            warnings.push(msg);
          }
        }
      }
    } catch {
      debugLog(logPrefix, 'Warning: Could not check network after click');
    }
  }

  // Log validation result
  if (errors.length > 0) {
    debugLog(logPrefix, `Click validation failed: ${errors.join('; ')}`);
  } else if (warnings.length > 0) {
    debugLog(logPrefix, `Click validation warnings: ${warnings.join('; ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info
  };
}

/**
 * Gather diagnostic information after a failure
 */
async function gatherDiagnostics(ctx: ExecutionContext): Promise<string> {
  const { executeToolCall, connectionReason } = ctx;

  if (!connectionReason) return '';

  try {
    const consoleResult = await executeToolCall('console', {
      action: 'list',
      type: 'error',
      connectionReason
    });
    // Counts come from `_meta`, as validateClickAction's do. Counting
    // `**error**` in the rendered console text also counted the word inside a
    // logged MESSAGE, and `\d{3}` over the network text matched any three
    // digits anywhere - a timestamp, a byte count, an id in a URL.
    const errorCount = consoleResult?._meta?.console?.errorCount ?? 0;

    // `network search` REQUIRES a pattern and reads statusCode as an exact code
    // or an "Nxx" class. Asking for `{ statusCode: '4' }` with no pattern was
    // rejected outright, so this whole helper threw and every step failure was
    // reported with no page state at all - and had it got through, '4' would
    // have matched no request either.
    const countRequests = async (statusCode: string) => {
      const result = await executeToolCall('network', {
        action: 'search',
        pattern: '.',
        statusCode,
        connectionReason
      });
      return result?._meta?.network?.matchCount ?? 0;
    };
    const failedRequests = (await countRequests('4xx')) + (await countRequests('5xx'));

    const interactiveResult = await executeToolCall('content', {
      action: 'findInteractive',
      connectionReason
    });
    const interactiveCount = interactiveResult?._meta?.content?.totalCount ?? 'unknown';

    return ` | Page state: ${interactiveCount} interactive elements, ${errorCount} console errors, ${failedRequests} failed requests`;
  } catch (err: any) {
    // Say why. Swallowing this silently is how a malformed network probe hid
    // for as long as it did: every step failure simply carried no page state,
    // and nothing anywhere said the probe had failed.
    debugLog(ctx.logPrefix || 'executor', `Could not gather diagnostics: ${err?.message || err}`);
    return '';
  }
}

// =============================================================================
// Main Execution Loop
// =============================================================================

export interface ExecuteStepsOptions {
  /**
   * Teardown's own total budget, independent of `totalTimeout`.
   *
   * It has to be independent: the commonest reason a run needs cleaning up
   * after is that it ran out of time, and a teardown drawing on the exhausted
   * parent budget would be skipped in exactly that case.
   */
  teardownTimeout?: number;
  sequence: CommandSequence;
  startStep: number;
  endStep?: number; // undefined = run to completion
  ctx: ExecutionContext;
  variables?: Record<string, string>;
  record?: boolean;
  stepTimeout?: number;
  totalTimeout?: number;
  overrideConnectionReason?: string;
  abortSignal?: AbortSignal;
  /**
   * Called as each TOP-LEVEL step starts executing, so a background run can
   * report live progress. Deliberately not propagated into nested sequences
   * (conditional flows): substeps report through their parent step only.
   */
  onProgress?: (ev: { step: number; totalSteps: number; tool: string }) => void;
}

/**
 * Execute a range of steps from a sequence
 */
export async function executeSteps(options: ExecuteStepsOptions): Promise<ExecutionResult> {
  const {
    sequence,
    startStep,
    endStep,
    ctx,
    variables,
    record,
    stepTimeout = 30000,
    totalTimeout = 300000,
    overrideConnectionReason,
    abortSignal,
    onProgress
  } = options;

  const { executeToolCall, commandRecorder, connectionReason, connectionMap, logPrefix = 'executor' } = ctx;
  // The option wins for a direct caller (teardown, tests); the context is what
  // carries the run's substitutions into every nesting depth.
  const activeVariables = variables ?? ctx.variables;
  const commands = sequence.commands;
  const targetEnd = endStep ?? commands.length;
  const results: StepResult[] = [];
  const startTime = Date.now();

  // A sequence whose steps name more than one connection can only be replayed
  // faithfully against those connections. `overrideConnectionReason` (the
  // run-level connectionReason) must therefore NOT be stamped onto its
  // launchChrome steps - that would point every launch at one reference and
  // collapse the very interleaving the sequence exists to reproduce (bug-018).
  const recordedConnections = analyzeRecordedStepConnections(commands);

  /** Recorded reference -> this session's reference. */
  const mapConnection = (ref: string): string =>
    connectionMap?.[sanitizeReference(ref)] ?? sanitizeReference(ref);

  // Live-connection references, probed lazily and re-probed on a miss (a step
  // earlier in the sequence may have launched the browser a later step needs).
  let liveConnections: Set<string> | null = null;
  const stepConnectionExists = async (ref: string): Promise<{ known: boolean; live: string[] }> => {
    if (!liveConnections?.has(ref)) {
      liveConnections = await probeLiveConnectionReferences(executeToolCall);
    }
    // null = could not determine. Treat as "unknown", never as "absent": the
    // tool call itself still fails loudly (CONNECTION_NOT_FOUND) if the
    // reference really is missing, and it never silently falls back.
    if (liveConnections === null) return { known: true, live: [] };
    return { known: liveConnections.has(ref), live: [...liveConnections] };
  };

  // {{timestamp}} must be stable across every step of a run (including a
  // later step/finish call), not recomputed per-step - cache once on ctx.
  const runTimestamp = ctx.runTimestamp ?? (ctx.runTimestamp = Date.now());

  // Seed the captured-variable store ONCE, on the caller's own ctx, and use
  // this single object everywhere below (interpolation, per-step ctx clones,
  // captures). Creating it lazily at a capture site would attach it to
  // whichever ctx happened to be in hand - for a nested sequence that is the
  // child's clone, so the parent would silently never see the capture.
  const variableStore: Record<string, any> = (ctx.variableStore ??= {});

  // Track breakpoints set during this sequence run (url:line format)
  const expectedBreakpoints: Set<string> = new Set();

  // Auto-resume if debugger is paused from a previous run
  if (connectionReason && startStep === 0) {
    await resumeIfPaused(ctx);
  }

  // Timeout helper. On timeout the losing tool call is NOT cancelled (handlers
  // receive the RUN's signal, but the step timer is not wired to it), so it may
  // still settle in the background - swallow its eventual rejection so it can't
  // surface as an unhandled rejection after the run has already reported the
  // timeout. The run stops at the timed-out step, so no later step races
  // against the orphan.
  const executeWithTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> => {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        promise.catch(() => {});
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  };


  for (let i = startStep; i < targetEnd; i++) {
    const cmd = commands[i];

    // Check if aborted
    if (abortSignal?.aborted) {
      debugLog(logPrefix, `Replay aborted at step ${i + 1}`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: 'Replay aborted by user'
      });
      break;
    }

    // Check total timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= totalTimeout) {
      debugLog(logPrefix, `Total timeout exceeded after ${elapsed}ms`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: `Total timeout exceeded (${totalTimeout}ms)`
      });
      break;
    }

    // Wait for delay if specified (for recorded interactions)
    if (cmd.delay && cmd.delay > 0) {
      debugLog(logPrefix, `Waiting ${cmd.delay}ms before step ${i + 1}`);
      const wasAborted = await abortableDelayResult(cmd.delay, abortSignal);
      if (wasAborted) continue;
    }

    onProgress?.({ step: i + 1, totalSteps: commands.length, tool: cmd.tool });

    try {
      // Log comment if present
      if (cmd.comment) {
        debugLog(logPrefix, `Comment: ${cmd.comment}`);
      }
      debugLog(logPrefix, `Executing step ${i + 1}/${commands.length}: ${cmd.tool}`);

      // Build params
      let params = { ...cmd.params };

      // Resolve {{var:name.path}} / {{timestamp}} tokens against the run's
      // variable store. Throws InterpolationError on an unresolvable token -
      // caught by this step's try/catch below, same as any other step failure.
      params = interpolateParams(params, variableStore, runTimestamp, ctx.runEnv);

      // Apply variable substitutions. The substituted value is never logged:
      // these steps carry passwords and tokens, and debug.log outlives the run.
      if (activeVariables && cmd.tool === 'input' && params.action === 'type' && params.text) {
        const varName = `var_${i}_${params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
        if (activeVariables[varName] !== undefined) {
          params.text = activeVariables[varName];
          debugLog(logPrefix, `Substituted ${varName} (${String(params.text).length} chars)`);
        }
      }

      // A nested `replay run` STEP must block: `run` is background-by-default
      // for direct callers, but a sequence step that starts another sequence
      // needs its result (the parent's success depends on it). Without this a
      // nested run would register as its own top-level run and the step would
      // "succeed" instantly, fire-and-forget. An explicit wait:false on the
      // step is honoured for callers who genuinely want that.
      if (cmd.tool === 'replay' && params.action === 'run' && params.wait === undefined) {
        params.wait = true;
      }

      // A per-step connectionReason is a reference from the RECORDING session, so
      // rebind it onto this one before anything uses it, then require that it
      // actually exists here. There is deliberately no fallback to the run-level
      // connection: that is precisely how a two-browser sequence used to replay
      // green in one browser (bug-018).
      if (typeof params.connectionReason === 'string' && params.connectionReason.trim()) {
        const recorded = sanitizeReference(params.connectionReason);
        const resolved = mapConnection(recorded);
        params.connectionReason = resolved;

        // Checked for ANY step naming a connection other than the run's, not
        // just multi-connection sequences: a single-reference sequence pointed
        // at a browser that isn't here otherwise fails deep inside the tool
        // with a generic "Not connected to browser" and never names the
        // connection it wanted.
        if (resolved !== connectionReason) {
          const { known, live } = await stepConnectionExists(resolved);
          if (!known) {
            results.push({
              step: i + 1,
              tool: cmd.tool,
              success: false,
              error: formatMissingStepConnection({
                step: i + 1,
                tool: cmd.tool,
                recorded,
                resolved,
                mapped: resolved !== recorded,
                runConnection: connectionReason,
                live,
              }),
            });
            break;
          }
        }
      }

      // launchChrome/connectDebugger steps CREATE the reference, so a mapping has
      // to rename the launch too or the sequence would open the recorded name and
      // then drive a differently-named one.
      let launchRenamedByMap = false;
      if ((cmd.tool === 'launchChrome' || cmd.tool === 'connectDebugger') &&
          typeof params.reference === 'string' && connectionMap) {
        const mappedRef = connectionMap[sanitizeReference(params.reference)];
        if (mappedRef) {
          params.reference = mappedRef;
          launchRenamedByMap = true;
        }
      }

      // Inject the run-level connectionReason for tools that accept one, unless the
      // step names its own (per-step connection wins - multi-device sequences).
      if (connectionReason && TOOLS_ACCEPTING_CONNECTION.includes(cmd.tool) && !params.connectionReason) {
        params.connectionReason = connectionReason;
      }

      // request({ destination: 'browser' }) needs a connectionReason too, but request
      // is deliberately in neither list (destination:'node' sequences must not force a
      // Chrome auto-launch, and destination:'node' takes no connection at all)
      if (cmd.tool === 'request' && params.destination === 'browser' && !params.connectionReason && connectionReason) {
        params.connectionReason = connectionReason;
      }

      // The connection this step actually runs against: its own if it named one,
      // otherwise the run-level connection. Everything wrapped around the step -
      // pre/post-click state, navigation + typed-text validation, pause detection,
      // failure diagnostics - must observe THIS connection, not the run-level one.
      // Helpers keep reading ctx.connectionReason; we just hand them a ctx whose
      // connection is the step's (bug-009).
      const stepConnection: string | undefined = params.connectionReason || connectionReason;
      const stepCtx: ExecutionContext = stepConnection === connectionReason
        ? ctx
        : {
            ...ctx,
            connectionReason: stepConnection as string,
            // share the run's variable store with the clone, don't fork it
            variableStore,
          };

      // Override launchChrome reference if custom connectionReason provided.
      // Skipped for multi-connection sequences: stamping one reference onto every
      // launch would collapse them into a single browser (see recordedConnections).
      // An explicit `connections` entry for this launch is the more specific
      // instruction and must win - otherwise the map renames the launch and this
      // silently renames it back, with the two writers disagreeing and no signal.
      if (cmd.tool === 'launchChrome' && overrideConnectionReason) {
        if (recordedConnections.multiConnection) {
          debugLog(logPrefix, `Not overriding launchChrome reference "${params.reference}" with "${overrideConnectionReason}": sequence spans ${recordedConnections.references.length} connections`);
        } else if (launchRenamedByMap) {
          debugLog(logPrefix, `Not overriding launchChrome reference "${params.reference}" with "${overrideConnectionReason}": connections mapping already rebound this launch`);
        } else {
          params.reference = overrideConnectionReason;
        }
      }

      // Handle stale callFrameId for getVariables
      if (cmd.tool === 'inspect' && params.action === 'getVariables' && params.callFrameId && stepConnection) {
        debugLog(logPrefix, `Refreshing stale callFrameId`);
        try {
          const callStackResult = await executeToolCall('inspect', {
            action: 'getCallStack',
            connectionReason: stepConnection
          });
          const callStackText = callStackResult?.content?.[0]?.text || '';
          const callFrameIdMatch = callStackText.match(/"callFrameId":\s*"([^"]+)"/);
          if (callFrameIdMatch?.[1]) {
            params.callFrameId = callFrameIdMatch[1];
          }
        } catch (err: any) {
          debugLog(logPrefix, `Warning: Failed to get fresh callFrameId: ${err.message}`);
        }
      }

      // Check port before navigate goto (localhost only)
      if (cmd.tool === 'navigate' && params.action === 'goto' && params.url) {
        const portCheck = await checkPortBeforeNavigation(params.url, logPrefix);
        if (!portCheck.success) {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: portCheck.error
          });
          break;
        }
      }

      // Replay cursor visual feedback
      if (cmd.tool === 'input') {
        if (params.action === 'click' && typeof params.x === 'number' && typeof params.y === 'number') {
          // Coordinate-based click - show cursor effect
          if (replayCursorCallbacks.onClickBefore) {
            await replayCursorCallbacks.onClickBefore(params.x, params.y, false);
          }
        } else if (params.action === 'press' && params.key) {
          // Key press - show key indicator
          if (replayCursorCallbacks.onKeyPress) {
            await replayCursorCallbacks.onKeyPress(params.key);
          }
        }
      }

      // Handle conditional command specially
      if (cmd.tool === 'conditional') {
        // Validate required parameters
        if (!params.if || typeof params.if !== 'string') {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: 'Conditional command requires "if" parameter with a condition string. Expected format: {{selector:.class}}, {{url:contains:text}}, {{cookie:name}}, or {{localStorage:key}}'
          });
          break;
        }
        if (!params.then || typeof params.then !== 'string') {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: 'Conditional command requires "then" parameter with the sequence name to execute when condition is met'
          });
          break;
        }

        const condResult = await executeConditionalFlow(
          params.if,
          params.then,
          stepCtx,
          commandRecorder,
          // Remaining, not the original: nesting must not extend the total.
          { stepTimeout, totalTimeout: Math.max(0, totalTimeout - (Date.now() - startTime)) },
          // The run's signal, so cancel reaches the nested sequence too.
          abortSignal
        );

        // Build the step result with substeps
        const stepResult: StepResult = {
          step: i + 1,
          tool: cmd.tool,
          success: condResult.success,
          sequenceName: condResult.sequenceName,
          conditionMet: condResult.executed,
          substeps: condResult.substeps,
          error: condResult.error
        };

        results.push(stepResult);

        if (!condResult.success) {
          break;
        }

        const substepCount = condResult.substeps?.length || 0;
        debugLog(logPrefix, `Step ${i + 1} completed: conditional ${condResult.executed ? `ran ${substepCount} substeps` : 'skipped (condition not met)'}`);
        continue; // Skip the regular execution path
      }

      // Handle forEach the same way - a virtual step the executor runs itself.
      if (cmd.tool === 'forEach') {
        // `in` is checked for presence only, not for being a string: whole-string
        // {{var:}} interpolation has already turned it into the captured array.
        const missing = ['in', 'as', 'do'].filter(k =>
          k === 'in' ? params[k] === undefined || params[k] === '' : typeof params[k] !== 'string' || !params[k]
        );
        if (missing.length > 0) {
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: `forEach requires ${missing.map(m => `"${m}"`).join(', ')}. Expected { in: '{{var:rows}}' | '{{selectorAll:CSS}}', as: 'row', do: '<sequence name>' }`
          });
          break;
        }

        const loopResult = await executeForEachFlow(
          { in: params.in, as: params.as, do: params.do, where: params.where, maxItems: params.maxItems },
          stepCtx,
          commandRecorder,
          // Remaining, not the original: looping must not extend the total.
          { stepTimeout, totalTimeout: Math.max(0, totalTimeout - (Date.now() - startTime)) },
          abortSignal
        );

        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: loopResult.success,
          sequenceName: loopResult.sequenceName,
          itemsFound: loopResult.itemsFound,
          iterations: loopResult.iterations,
          substeps: loopResult.substeps,
          error: loopResult.error
        });

        if (!loopResult.success) {
          break;
        }

        debugLog(logPrefix, `Step ${i + 1} completed: forEach ran ${loopResult.iterations}/${loopResult.itemsFound} item(s) of "${loopResult.sequenceName}"`);
        continue; // Skip the regular execution path
      }

      // Capture pre-click state for validation
      let preClickState: PreClickState | null = null;
      const clickConfig = configManager.getClickValidationConfig();
      if (cmd.tool === 'input' && params.action === 'click' && stepConnection && clickConfig.enabled) {
        preClickState = await capturePreClickState(stepCtx);
      }

      // Execute with retry, raced against the per-step timeout so a hung tool
      // call fails its own step instead of hanging the whole run.
      //
      // The bound is min(stepTimeout, remaining totalTimeout), computed fresh
      // here (after any cmd.delay) so the delay doesn't inflate the budget.
      //
      // `wait` steps are exempt from stepTimeout: wait carries its own
      // documented timeoutMs bound (default 15000) and fails itself on expiry;
      // racing stepTimeout against it would silently override that parameter
      // for waits longer than 30s. They are still capped by remaining
      // totalTimeout as a backstop.
      //
      // Breakpoint pauses are NOT affected: input tools detect a pause and
      // return immediately (pausedAtBreakpoint / pausedDuringClick), so a
      // legitimate pause never blocks inside the tool call - it is handled by
      // checkIfPaused after the step. replay({action:'step'}) pauses between
      // steps, outside this race.
      const remainingTotal = Math.max(1, totalTimeout - (Date.now() - startTime));
      const boundedByTotal = cmd.tool === 'wait' || remainingTotal < stepTimeout;
      const stepBound = cmd.tool === 'wait' ? remainingTotal : Math.min(stepTimeout, remainingTotal);
      const execResult = await executeWithTimeout(
        executeCommandWithRetry(executeToolCall, cmd.tool, params, logPrefix, abortSignal),
        stepBound,
        getMessage('REPLAY_STEP_TIMEOUT', {
          step: i + 1,
          tool: cmd.tool,
          timeoutMs: stepBound,
          limitSource: boundedByTotal ? 'remaining totalTimeout' : 'stepTimeout',
        })
      );

      if (!execResult.success) {
        // A step that failed while the run signal is aborted is the CANCEL
        // surfacing (e.g. the wait handler throwing an abort mid-poll), not a
        // genuine failure: report the canonical abort message and skip
        // diagnostics - the user cancelled, don't interrogate a browser they
        // may already be tearing down.
        if (abortSignal?.aborted) {
          debugLog(logPrefix, `Replay aborted during step ${i + 1}`);
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: 'Replay aborted by user'
          });
          break;
        }
        const diagnostics = await gatherDiagnostics(stepCtx);
        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: false,
          error: `${execResult.error}${diagnostics}`
        });
        break;
      }

      // Note a browser this step created, so the run can close what it opened
      // and leave what it borrowed. The reference is read from the response
      // rather than the params: `reused: true` means the reference already
      // existed and the browser is someone else's (issue #103).
      if (cmd.tool === 'launchChrome' && ctx.launchedConnections) {
        const launchMeta = execResult.result?._meta?.launchChrome;
        if (launchMeta?.reference && launchMeta.reused === false) {
          ctx.launchedConnections.add(launchMeta.reference);
        }
      }

      // Track breakpoints set by this sequence
      // Due to CDP line number handling (0-based vs 1-based) and resolution to nearest valid line,
      // we track the requested line and ±1 variants to handle edge cases
      if (cmd.tool === 'breakpoint' && params.action === 'set' && params.url) {
        const requestedLine = params.lineNumber;

        // Try to get the actual resolved line from the response
        // Format: "Breakpoint set at URL:LINE" or "CDP resolved to line LINE"
        const responseText = execResult.result?.content?.[0]?.text || '';
        const setAtMatch = responseText.match(/Breakpoint set at [^:]+:(\d+)/);
        const resolvedMatch = responseText.match(/CDP resolved to line (\d+)/);
        const reportedLine = resolvedMatch
          ? parseInt(resolvedMatch[1], 10)
          : setAtMatch
            ? parseInt(setAtMatch[1], 10)
            : requestedLine;

        // Track the reported line
        expectedBreakpoints.add(`${params.url}:${reportedLine}`);
        debugLog(logPrefix, `Tracking expected breakpoint: ${params.url}:${reportedLine}`);

        // Also track ±1 to handle 0-based/1-based conversion edge cases
        expectedBreakpoints.add(`${params.url}:${reportedLine - 1}`);
        expectedBreakpoints.add(`${params.url}:${reportedLine + 1}`);

        // Track requested line if different
        if (requestedLine !== reportedLine) {
          expectedBreakpoints.add(`${params.url}:${requestedLine}`);
          expectedBreakpoints.add(`${params.url}:${requestedLine - 1}`);
          expectedBreakpoints.add(`${params.url}:${requestedLine + 1}`);
        }

        debugLog(logPrefix, `Expected breakpoints for ${params.url}: ${[...expectedBreakpoints].filter(k => k.startsWith(params.url)).map(k => k.split(':').pop()).join(', ')}`);
      }

      // Post-step validation (before marking as success)
      if (cmd.tool === 'navigate' && stepConnection) {
        // Validate navigation succeeded
        const expectedUrl = params.action === 'goto' ? params.url : undefined;
        const navValidation = await validateNavigation(stepCtx, expectedUrl);
        if (!navValidation.success) {
          throw new Error(navValidation.error || 'Navigation failed');
        }
      }

      // Click validation (after successful execution)
      if (cmd.tool === 'input' && params.action === 'click' && stepConnection && preClickState && clickConfig.enabled) {
        const clickValidation = await validateClickAction(stepCtx, preClickState, execResult.result, clickConfig);

        // Log info messages (console activity)
        for (const infoMsg of clickValidation.info) {
          debugLog(logPrefix, `Click info: ${infoMsg}`);
        }

        // Log warnings
        for (const warn of clickValidation.warnings) {
          debugLog(logPrefix, `Click warning: ${warn}`);
        }

        // Handle errors - pause sequence for inspection/retry instead of failing
        if (!clickValidation.valid) {
          debugLog(logPrefix, `Click validation failed at step ${i + 1}, pausing for inspection`);

          // Mark this step as failed but allow retry
          results.push({
            step: i + 1,
            tool: cmd.tool,
            success: false,
            error: `Click validation: ${clickValidation.errors.join('; ')}`
          });

          return {
            results,
            totalCommands: commands.length,
            durationMs: Date.now() - startTime,
            pausedAtStep: i + 1,
            clickValidationFailure: {
              step: i + 1,
              selector: params.selector || 'unknown',
              errors: clickValidation.errors,
              warnings: clickValidation.warnings,
              info: clickValidation.info,
            }
          };
        }
      }

      // Capture a { saveAs } step's result into the run's variable store.
      // Before the step is marked successful: a saveAs that cannot be honoured
      // is a step failure (throw -> the catch below records it and stops the
      // run), not a silent no-op that would surface later as a confusing
      // "no variable named ..." interpolation error.
      if (params.saveAs) {
        const captured = captureVariable(cmd.tool, params, execResult.result);
        if (!captured.ok) {
          throw new Error(captured.error);
        }
        variableStore[params.saveAs] = captured.value;
        debugLog(logPrefix, `Captured variable "${params.saveAs}" from step ${i + 1} (${cmd.tool})`);
      }

      // Record command if enabled (preserve delay and comment)
      if (record) {
        commandRecorder.recordCommand(cmd.tool, params, {
          delay: cmd.delay,
          comment: cmd.comment,
          result: execResult.result
        });
      }

      results.push({ step: i + 1, tool: cmd.tool, success: true });
      debugLog(logPrefix, `Step ${i + 1} completed successfully`);

      // Check if we hit a breakpoint after this step (on the step's own connection)
      if (stepConnection) {
        const breakpointInfo = await checkIfPaused(stepCtx);
        if (breakpointInfo) {
          const breakpointKey = `${breakpointInfo.url}:${breakpointInfo.lineNumber}`;
          const isExpected = expectedBreakpoints.has(breakpointKey);
          debugLog(logPrefix, `Breakpoint hit at ${breakpointKey} (expected: ${isExpected})`);

          if (isExpected) {
            // Expected breakpoint from this sequence - continue execution
            debugLog(logPrefix, `Expected breakpoint hit, continuing sequence`);
          } else {
            // Unexpected breakpoint - stop and return
            return {
              results,
              totalCommands: commands.length,
              durationMs: Date.now() - startTime,
              breakpointHit: breakpointInfo
            };
          }
        }
      }

      // Post-step async operations (after marking success)
      if (cmd.tool === 'input' && params.action === 'type' && params.selector && stepConnection) {
        await validateTypedText(stepCtx, params.selector, params.text || '', params.append === true);
      }

      // Pre-fetch next element after navigation/click. The wait happens where the
      // NEXT step will run, so it follows that step's connection, not this one's.
      const isNavigationAction = cmd.tool === 'navigate' ||
        (cmd.tool === 'input' && params.action === 'click');

      if (isNavigationAction && i + 1 < commands.length) {
        const nextCmd = commands[i + 1];
        // Rebind the same way the step itself will be, or this pre-emptive wait
        // polls a recorded reference that may not exist in this session - which
        // costs the step its whole settle budget before being swallowed.
        const nextConnection: string | undefined = nextCmd.params.connectionReason
          ? mapConnection(nextCmd.params.connectionReason)
          : connectionReason;
        if (nextCmd.tool === 'input' && nextCmd.params.selector && nextConnection) {
          const nextCtx: ExecutionContext = nextConnection === connectionReason
            ? ctx
            : { ...ctx, connectionReason: nextConnection, variableStore };
          await waitForElement(nextCtx, nextCmd.params.selector);
        }
      }

    } catch (error: any) {
      // Same classification as the resolved-failure path above: an exception
      // thrown while the run signal is aborted is the cancel surfacing.
      if (abortSignal?.aborted) {
        debugLog(logPrefix, `Replay aborted during step ${i + 1}`);
        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: false,
          error: 'Replay aborted by user'
        });
        break;
      }
      debugLog(logPrefix, `Error at step ${i + 1}: ${error.message}`);
      results.push({
        step: i + 1,
        tool: cmd.tool,
        success: false,
        error: error.message || 'Unknown error'
      });
      break;
    }
  }

  // The loop is over. Every path that reaches here is terminal for the MAIN
  // steps - success, a failed step, an abort, or the total timeout - EXCEPT a
  // clean stop at `endStep`, which is a stepTo pause with more steps to come.
  // The pause paths that return early above (breakpoint, click validation)
  // never reach here, which is what we want: the run is not over, so cleaning
  // up would destroy the state the user paused to look at.
  const stoppedShortOfEnd = targetEnd < commands.length;
  const anyFailed = results.some(r => !r.success);
  const isPaused = stoppedShortOfEnd && !anyFailed;

  const teardownOutcome = isPaused
    ? undefined
    : await runTeardown(sequence, {
        ctx,
        stepTimeout,
        teardownTimeout: options.teardownTimeout,
        overrideConnectionReason,
        variables,
        record,
      });

  return {
    results,
    totalCommands: commands.length,
    durationMs: Date.now() - startTime,
    ...(teardownOutcome ? { teardownResults: teardownOutcome.results, teardownFailed: teardownOutcome.failed } : {})
  };
}

/**
 * Run a sequence's `teardown` steps, if it has any.
 *
 * Three properties matter, and each one is a way this feature fails if it is
 * missed:
 *
 * - **Its own budget.** `teardownTimeout` is deliberately not drawn from the
 *   run's `totalTimeout`. The commonest reason a run needs cleaning up after is
 *   that it timed out, and sharing the budget would skip teardown exactly then.
 * - **No abort signal.** The run's signal is not passed down. `replay cancel`
 *   must stop the work, not the cleanup - a cancelled run is precisely one that
 *   has left something behind.
 * - **The variable store, shared.** Teardown reads `ctx.variableStore`, so it
 *   can revoke whatever setup minted, even though the step that captured it may
 *   have run long before the failure.
 *
 * Teardown is always best-effort. A killed process takes any pending teardown
 * with it, so it reduces accumulation and cannot guarantee a clean world -
 * assertions that depend on nothing being left over are still wrong.
 */
async function runTeardown(
  sequence: CommandSequence,
  opts: {
    ctx: ExecutionContext;
    stepTimeout: number;
    teardownTimeout?: number;
    overrideConnectionReason?: string;
    variables?: Record<string, string>;
    record?: boolean;
  }
): Promise<{ results: StepResult[]; failed: boolean } | undefined> {
  const teardown = sequence.teardown;
  if (!teardown || teardown.length === 0) return undefined;

  const logPrefix = opts.ctx.logPrefix ?? 'executor';
  await debugLog(logPrefix, `Running ${teardown.length} teardown step(s) for "${sequence.name}"`);

  // `teardown: undefined` on the synthetic sequence: without it the teardown
  // run would reach this same code and run the teardown again, forever.
  const result = await executeSteps({
    sequence: { ...sequence, commands: teardown, teardown: undefined },
    startStep: 0,
    ctx: opts.ctx,
    stepTimeout: opts.stepTimeout,
    totalTimeout: opts.teardownTimeout ?? DEFAULT_TEARDOWN_TIMEOUT,
    ...(opts.overrideConnectionReason ? { overrideConnectionReason: opts.overrideConnectionReason } : {}),
    ...(opts.variables ? { variables: opts.variables } : {}),
    ...(opts.record !== undefined ? { record: opts.record } : {}),
  });

  const failed = result.results.some(r => !r.success);
  if (failed) {
    await debugLog(logPrefix, `Teardown for "${sequence.name}" had failing steps - reported alongside, not folded into the run's verdict`);
  }
  return { results: result.results, failed };
}

/**
 * Execute a sequence with pause support (stepTo)
 */
export async function executeSequenceWithPause(
  options: ExecuteStepsOptions & { stepTo?: number }
): Promise<ExecutionResult> {
  const { sequence, ctx, stepTo } = options;
  const { commandRecorder, connectionReason } = ctx;

  const result = await executeSteps({
    ...options,
    endStep: stepTo
  });

  // If we stopped at stepTo and didn't fail, set up paused state
  if (stepTo !== undefined && result.results.length > 0) {
    const lastResult = result.results[result.results.length - 1];
    if (lastResult.success && lastResult.step >= stepTo) {
      const activeState: ActiveSequenceState = {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        connectionReason: connectionReason || '',
        currentStep: lastResult.step,
        totalSteps: sequence.commands.length,
        pausedAt: Date.now(),
        historyIndexAtPause: commandRecorder.getCurrentHistoryIndex(),
        capturedVariables: ctx.variableStore,
        runTimestamp: ctx.runTimestamp,
        // step/finish must resolve per-step connections the way this run did
        ...(ctx.connectionMap && { connectionMap: ctx.connectionMap }),
      };

      result.pausedAtStep = lastResult.step;
      result.activeSequenceState = activeState;
    }
  }

  return result;
}

// =============================================================================
// Debug State
// =============================================================================

export interface DebugState {
  isPaused: boolean;
  pauseLocation?: string;
  breakpointCount: number;
}

/**
 * Get current debug state (breakpoints, pause status)
 */
export async function getDebugState(ctx: ExecutionContext): Promise<DebugState | null> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;

  if (!connectionReason) return null;

  try {
    const breakpointResult = await executeToolCall('breakpoint', {
      action: 'list',
      connectionReason
    });
    const breakpointText = breakpointResult?.content?.[0]?.text || '';
    const totalMatch = breakpointText.match(/\*\*Total:\*\*\s*(\d+)/);
    const breakpointCount = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    // "Not paused" is the ANSWER, not a failure - but inspect.getCallStack
    // reports it as an error response, which the live executeToolCall rethrows.
    // Letting it reach the outer catch threw away the breakpoint count already
    // read and reported no debug state at all for the ordinary unpaused run,
    // which is the run this exists to describe.
    let callStackText = '';
    try {
      const callStackResult = await executeToolCall('inspect', {
        action: 'getCallStack',
        connectionReason
      });
      callStackText = callStackResult?.content?.[0]?.text || '';
    } catch (callStackError: any) {
      if (callStackError?.response?._errorId !== 'NOT_PAUSED') throw callStackError;
    }
    const isPaused = callStackText.includes('callFrameId');

    let pauseLocation: string | undefined;
    if (isPaused) {
      const pauseLocationMatch = callStackText.match(/Paused at:\s*([^\n]+)/);
      pauseLocation = pauseLocationMatch ? pauseLocationMatch[1] : 'unknown location';
    }

    return { isPaused, pauseLocation, breakpointCount };
  } catch (err: any) {
    debugLog(logPrefix, `Could not get debug state: ${err.message}`);
    return null;
  }
}
