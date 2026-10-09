/**
 * Runs a sequence's steps: the step loop with its timeouts and captures,
 * sequences run inside a step (a check's `{ run }`, `forEach`), loading and
 * retargeting a sequence, teardown, and comparing a step's traffic with the
 * recording's.
 *
 * Re-exports replay-types, replay-connections, replay-conditions and
 * replay-step-checks, so callers import the replay machinery from here.
 */
import { appendEvent } from '../session-events.js';
import { resolveSessionName } from '../session-identity.js';

import type { StepTraffic } from '../annotation.js';
import type { CommandRecorder, RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import { markNextCommand, releaseCommand, boundarySettled, getProxy, recordCheckOutcome, noteCallStart, standPausedRun, settleProxies } from '../proxy/registry.js';
import type { ProxyEvent, ShapeRules } from '../proxy/intercept-proxy.js';
import { compareStep, placePass, type Crossing } from '../bench/step-compare.js';
import { writeEvents } from '../bench-mode/traffic.js';
import { sessions } from '../bench-mode/session.js';
import type { ExecuteToolCall } from '../types.js';
import { abortableDelayResult } from '../utils/abort.js';
import { debugLog } from '../debug-logger.js';
import { sanitizeReference } from '../reference-validator.js';
import { configManager } from '../config.js';
import { describePersonInput, personInputSince } from '../person-watch.js';
import { hold, type HoldLayer } from '../hold.js';
import { interpolateParams } from './interpolation.js';
import { getMessage, isElementNotFoundFailure } from '../messages.js';
import type { CheckOutcome as CheckAction } from './check-tools.js';
import { assertAsCheck, subjectOf as subjectOfCheck, waitAsCheck } from './check-engine.js';
import type { CheckOutcome as CheckOutcomeRecord, RanStep } from '../proxy/registry.js';
import { asStep, atRunStep, atRunStepEnv, originChannel, withinRun } from '../call-origin.js';
import { showingPickers } from '../dialog-monitor.js';
import { addressedConnection, addressesConnection, createsConnection, createdName, isLaunchStep } from './connection-steps.js';

// Re-export replay cursor functions
export { injectReplayCursor, showClickEffect, showKeyPress, removeReplayCursor } from '../replay-cursor.js';
export * from './replay-types.js';
export * from './replay-connections.js';
export * from './replay-conditions.js';
export * from './replay-step-checks.js';
import type { ExecutionContext, StepResult, BreakpointHitInfo, ExecutionResult } from './replay-types.js';
import { countStepTraffic } from '../step-traffic.js';
import {
  TOOLS_ACCEPTING_CONNECTION, actsWithoutConnection, analyzeSequenceConnections, extractConnectionFromSequence,
  analyzeRecordedStepConnections, probeLiveConnectionReferences, formatMissingStepConnection,
} from './replay-connections.js';
import {
  debuggerStatusOf, checkIfPaused, resumeIfPaused, checkPortBeforeNavigation, validateNavigation,
  waitForElement, validateTypedText, capturePreClickState, validateClickAction, gatherDiagnostics,
  type PreClickState,
} from './replay-step-checks.js';

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

export interface NestedRunResult {
  success: boolean;
  executed: boolean;
  sequenceName: string;
  substeps?: StepResult[];
  /** The steps of the sequence that ran, as it ran them, so a result can be named by what each step did. */
  ranCommands?: RecordedCommand[];
  error?: string;
  durationMs?: number;
  /** Where the nested sequence's steps differed from their own recording, labelled by path. */
  behaviourDrift?: ExecutionResult['behaviourDrift'];
}

/**
 * Shared preparation for any sequence run INSIDE another one (a check's
 * `{ run }`, `forEach`'s `do`): which of its launch and attach steps still
 * apply, and which connection its bare steps run on.
 *
 * A launch or attach whose name is already live is dropped - relaunching it
 * would throw the session away, and attaching again fails on a name in use.
 * One whose name is NOT live is kept: a setup sequence that spans two
 * browsers has to be able to create the second one, or it can only ever heal
 * identity in browsers that happened to be open already. Probed only when
 * there is a launch or attach to check, so the common nested call costs no
 * extra tool call.
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
  const liveRefs = sequence.commands.some(createsConnection)
    ? await probeLiveConnectionReferences(ctx.executeToolCall)
    : null;
  const keptLaunches: string[] = [];
  const filteredCommands = sequence.commands.filter(cmd => {
    if (!createsConnection(cmd)) return true;

    const name = createdName(cmd);
    const recorded = name ? sanitizeReference(name) : undefined;
    // A step naming no connection, or a connection list that could not be
    // read, is dropped: relaunching might replace a browser already live.
    if (!recorded || !liveRefs) return false;

    const resolved = ctx.connectionMap?.[recorded] ?? recorded;
    if (liveRefs.has(resolved)) return false;

    debugLog(logPrefix, `Keeping the ${cmd.params?.action} of "${resolved}" in nested sequence "${label}": no such connection in this session`);
    keptLaunches.push(resolved);
    return true;
  });

  // A launch or attach we KEPT created a connection that only this
  // sub-sequence knows about, and `create` hoists a uniform connection OFF the
  // steps - so the setup sequence is a launch or attach followed by BARE steps.
  // Left on the parent's connection, those steps run in the caller's browser:
  // the run creates a connection, does nothing in it, and reports success.
  // Bind the sub-run to the connection it just created, exactly as a top-level
  // run of that sequence would (extractConnectionFromSequence).
  //
  // Only for one we kept. One that was DROPPED means the connection already
  // existed, and re-pointing bare steps at it would hijack a nested
  // login/setup sequence that has always run in whatever browser called it.
  const nestedAnalysis = analyzeSequenceConnections(filteredCommands);
  const launchedConnection = extractConnectionFromSequence(filteredCommands, nestedAnalysis);
  const nestedConnection = launchedConnection && keptLaunches.includes(launchedConnection)
    ? launchedConnection
    : undefined;
  if (nestedConnection) {
    await debugLog(logPrefix, `Nested sequence "${label}" runs against the connection it created ("${nestedConnection}"), not the caller's "${ctx.connection}"`);
  }

  return { filteredSequence: { ...sequence, commands: filteredCommands }, filteredCommands, nestedConnection };
}

/**
 * Run a named sequence inside a step of another: a check's `{ run }`. Shares
 * the run's variables, remaining time and cancel; bounded by the nesting
 * depth, as any sequence one run reaches is.
 */
export async function runBranch(
  sequenceName: string,
  ctx: ExecutionContext,
  recorder: CommandRecorder,
  budget?: { stepTimeout?: number; totalTimeout?: number },
  abortSignal?: AbortSignal
): Promise<NestedRunResult> {
  const { logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();
  const currentDepth = ctx.nestingDepth ?? 0;
  const callStack = ctx.nestingCallStack ?? [];
  if (currentDepth >= replayConfig.maxConditionalDepth) {
    const chain = [...callStack, sequenceName].join(' → ');
    return {
      success: false,
      executed: false,
      sequenceName,
      error: `Nesting depth limit (${replayConfig.maxConditionalDepth}) reached: ${chain}. Increase maxConditionalDepth in config if this is intentional.`
    };
  }

  // Load the sequence
  const loadResult = await loadSequence({ name: sequenceName }, recorder);
  if (!loadResult.success) {
    return { success: false, executed: false, sequenceName, error: `Sequence "${sequenceName}" not found: ${loadResult.error}` };
  }

  const { filteredSequence, nestedConnection, filteredCommands } =
    await prepareNestedSequence(loadResult.sequence, ctx, sequenceName, logPrefix);

  await debugLog(logPrefix, `Executing nested sequence "${filteredSequence.name}" with ${filteredCommands.length} commands (depth: ${currentDepth + 1})`);

  // Execute the sequence with updated call stack and depth
  const execResult = await executeSteps({
    sequence: filteredSequence,
    startStep: 0,
    ctx: {
      ...ctx,
      ...(nestedConnection ? { connection: nestedConnection } : {}),
      nestingDepth: currentDepth + 1,
      nestingCallStack: [...callStack, sequenceName]
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
    // Don't wrap errors that are already from nested runs - just pass through
    const isNestedRunError = failedStep.tool === 'check' ||
      failedStep.error?.includes('Nesting depth limit') ||
      failedStep.error?.includes('Condition evaluation failed');

    const error = isNestedRunError
      ? failedStep.error
      : `Sequence "${sequenceName}" run by a check failed at step ${failedStep.step} (${failedStep.tool}): ${failedStep.error}`;

    return {
      success: false,
      executed: true,
      sequenceName,
      substeps: execResult.results,
      ranCommands: filteredCommands,
      error,
      durationMs: execResult.durationMs,
      ...(execResult.behaviourDrift ? { behaviourDrift: execResult.behaviourDrift } : {}),
    };
  }

  await debugLog(logPrefix, `Nested sequence completed successfully in ${execResult.durationMs}ms`);
  return {
    success: true,
    executed: true,
    sequenceName,
    substeps: execResult.results,
    ranCommands: filteredCommands,
    durationMs: execResult.durationMs,
    ...(execResult.behaviourDrift ? { behaviourDrift: execResult.behaviourDrift } : {}),
  };
}

/**
 * A branch's results as the steps it ran, each named by what it did, and a
 * step that was a check running a sequence of its own carrying that sequence
 * the same way - as deep as the run went.
 */
export function ranStepsOf(results: StepResult[], commands?: RecordedCommand[]): RanStep[] {
  return results.map(result => ({
    tool: result.tool,
    line: stepLine(commands?.[result.step - 1]),
    ...(result.check && commands?.[result.step - 1]?.params ? { params: commands[result.step - 1].params } : {}),
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.check ? { check: {
      outcome: result.check.outcome, action: result.check.action, subject: result.check.subject,
      ...(result.check.found !== undefined ? { found: result.check.found } : {}),
      ...(result.check.limitMs ? { waitedMs: result.check.waitedMs, limitMs: result.check.limitMs } : {}),
    } } : {}),
    ...(result.check?.action === 'run' && result.substeps
      ? { branch: { name: result.sequenceName ?? '', ranSteps: ranStepsOf(result.substeps, result.ranCommands) } }
      : {}),
  }));
}

/** One step in a line, by what it calls and on what, for naming a branch's steps where they are shown. */
function stepLine(command: RecordedCommand | undefined): string {
  if (!command) return '';
  const p = command.params ?? {};
  const head = p.action ? `${command.tool}.${p.action}` : command.tool;
  const subject = p.selector ?? p.url ?? p.text ?? p.key ?? p.expression ?? '';
  return `${head}${subject ? ` ${String(subject).slice(0, 80)}` : ''}`;
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
 * Note the asymmetry with a check: a check asks whether one thing holds, so
 * it can't express "give me every X". That gap is the
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
        ...(ctx.connection ? { connection: ctx.connection } : {}),
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
      ...(ctx.connection ? { connection: ctx.connection } : {}),
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
  const currentDepth = ctx.nestingDepth ?? 0;
  const callStack = ctx.nestingCallStack ?? [];

  // Shares the nesting depth budget: a loop body that loops is the same
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
  // A launch or attach the body kept creates its connection on the first
  // iteration; after that the name is live, and an attach again fails on it.
  const laterSequence = {
    ...filteredSequence,
    commands: filteredSequence.commands.filter(cmd => !createsConnection(cmd)),
  };

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
      sequence: iterations === 1 ? filteredSequence : laterSequence,
      startStep: 0,
      ctx: {
        ...ctx,
        ...(nestedConnection ? { connection: nestedConnection } : {}),
        nestingDepth: currentDepth + 1,
        nestingCallStack: [...callStack, sequenceName],
        trafficUncompared: true,
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
    // Disk wins when the file is newer, so a re-run executes an edited
    // sequence rather than the copy held in memory (issue #134).
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
// Command Execution
// =============================================================================

/** The signal one step's call runs under: the run's cancel, or the step's own timeout, whichever comes first. */
function stepSignalOf(run: AbortSignal | undefined, step: AbortController): AbortSignal {
  return run ? AbortSignal.any([run, step.signal]) : step.signal;
}

/**
 * A tool's error text as one line for a run's report: the headings and blank
 * lines dropped, the suggestions after it left out. The first line alone is a
 * bare `## Error` for every response that opens with a heading, which dropped
 * the reason from the report.
 */
export function failureLine(text: string): string {
  const said: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('**Suggestions:**') || line.startsWith('**Suggestion:**')) break;
    if (!line || /^#+\s/.test(line) || /^#+$/.test(line)) continue;
    said.push(line);
  }
  return said.join(' ') || 'Unknown error';
}

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
): Promise<{ success: boolean; result?: any; error?: string; errorId?: string; response?: any }> {
  const isRetryableAction = tool === 'input' && ['click', 'type', 'hover'].includes(params.action);
  const maxRetries = isRetryableAction ? 5 : 1;
  const retryDelayMs = 500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // A tool error arrives as an EXCEPTION: executeToolCall raises a ToolError
    // for any isError response. The catch is what drives element-not-found
    // retries (e.g. an async-rendered button that hasn't mounted yet).
    let result: any;
    try {
      result = await asStep(() => executeToolCall(tool, params, abortSignal));
    } catch (err: any) {
      const errorText = err?.response?.content?.[0]?.text || err?.message || '';
      // Only element-not-found is retried: a missing connection or sequence
      // fails the same way on every attempt.
      const isElementNotFound = isElementNotFoundFailure({
        errorId: err?.response?._errorId,
        text: errorText,
      });

      if (isRetryableAction && isElementNotFound && attempt < maxRetries) {
        debugLog(logPrefix, `Element not found, retrying... (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      return {
        success: false,
        error: failureLine(errorText),
        ...(err?.response?._errorId ? { errorId: err.response._errorId, response: err.response } : {}),
      };
    }

    return { success: true, result };
  }

  return { success: false, error: 'Max retries exceeded' };
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
   * (nested runs): substeps report through their parent step only.
   */
  onProgress?: (ev: { step: number; totalSteps: number; tool: string }) => void;
  /**
   * The step a breakpoint stopped the page inside, still open: the resume
   * waits for its quiet under its cursor, then closes it before the next step marks.
   */
  openStep?: { step: number; markedAt: number };
  /** Carries on a paused session (`step`, `finish`), whose abort leaves it paused rather than ended. */
  resumesSession?: boolean;
  /** What a pause at `endStep` holds on the page: every layer when absent, nothing for []. */
  holdWhilePaused?: HoldLayer[];
  /**
   * False for a play's own step, which carries straight on: stopping at
   * `endStep` there is no pause, so it neither stamps one nor holds the page.
   */
  standsPaused?: boolean;
}

/**
 * Execute a range of steps from a sequence
 */
export async function executeSteps(options: ExecuteStepsOptions): Promise<ExecutionResult> {
  const execution = await withinRun(options.sequence.name, () => executeStepsWithin(options));
  const last = execution.results[execution.results.length - 1];
  if (last && !last.success) options.ctx.commandRecorder?.markStepFailed?.(options.sequence.name, last.step);
  return execution;
}

async function executeStepsWithin(options: ExecuteStepsOptions): Promise<ExecutionResult> {
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

  const { executeToolCall, commandRecorder, connection, connectionMap, logPrefix = 'executor' } = ctx;
  // The option wins for a direct caller (teardown, tests); the context is what
  // carries the run's substitutions into every nesting depth.
  const activeVariables = variables ?? ctx.variables;
  const commands = sequence.commands;
  const targetEnd = endStep ?? commands.length;
  const results: StepResult[] = [];
  const startTime = Date.now();

  // A sequence whose steps name more than one connection can only be replayed
  // faithfully against those connections. `overrideConnectionReason` (the
  // run-level connection) must therefore NOT be stamped onto its
  // launch steps - that would point every launch at one reference and
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

  // Auto-resume if debugger is paused from a previous run. A nested run starts
  // inside its parent, so a pause it finds is the parent's to judge.
  if (connection && startStep === 0 && !ctx.nestingDepth) {
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
    timeoutMessage: string,
    /** Cancels the step's own call, so a handler that honours its signal stops rather than running on after the run has moved past it. */
    stepAbort?: AbortController
  ): Promise<T> => {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        promise.catch(() => {});
        stepAbort?.abort(new Error(timeoutMessage));
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  };


  // When each step began, for windowing the traffic it caused against the
  // baseline the recording stored on it. Only filled when there is a baseline.
  const comparesBehaviour = !ctx.trafficUncompared && commands.some(c => (c as any).traffic);
  const stepStartedAt = new Map<number, number>();
  // What the sequences this run's checks ran found, reported with this run's own.
  const nestedDrift: NonNullable<ExecutionResult['behaviourDrift']> = [];
  // When each step's boundary was released, which closes that step's span the
  // same way a recorded command's return closes its own. Without it a replayed
  // step runs to the next step's start while its recording ran to a release,
  // and the two spans are not comparable.
  const stepReleasedAt = new Map<number, number>();
  const stepMarkedAt = new Map<number, number>();
  const settleConfig = configManager.getReplayConfig();
  const releaseStep = async (step: number): Promise<void> => {
    const at = await releaseCommand(
      settleConfig.stepSettleMs, settleConfig.stepSettleCapMs,
      overrideConnectionReason ?? ctx.connection
    ).catch(() => Date.now());
    stepReleasedAt.set(step, at);
    const from = stepMarkedAt.get(step);
    if (from !== undefined) commandRecorder?.noteStepWindow?.(sequence.name, step, from, at);
  };
  let boundaryStep: number | undefined;

  // Derived from the pass's own clock rather than minted here: one pass
  // re-enters this function on resume, for a nested sequence, per forEach
  // iteration and for teardown, and an id minted per entry would split the
  // pass into several that no comparison could join.
  const proxyRun = `run-${runTimestamp.toString(36)}`;
  // The browser a check's outcome is kept against, for the bench to read.
  const checked = overrideConnectionReason ?? ctx.connection;
  // A run inside another step stamps that step, with its own position beside
  // it, so what it causes is kept apart from the parent's steps of the same
  // number and still lands under the step that ran it.
  const positionOf = (i: number): { step: number; within?: number[] } => ctx.stampUnder
    ? { step: ctx.stampUnder.step, within: [...ctx.stampUnder.within, i] }
    : { step: i };
  const cursorAt = (i: number) => ({ kind: 'replay' as const, runId: proxyRun, ...positionOf(i) });
  // A pause that returns from inside the loop - a breakpoint, a refused click -
  // closes the open step's window and stands the run's cursor before the step
  // it resumes at, as a pause at the loop's end does.
  //
  // A breakpoint stops the page inside the step whose window is open, and the
  // page finishes that step's work only once it resumes: that window stays
  // open, its cursor standing through the pause, and the resume closes it.
  // The steps already closed are compared here, as the end of a pass compares them.
  const pausedAt = async (result: ExecutionResult, next: number, insideStep = false): Promise<ExecutionResult> => {
    let openStep: ExecutionResult['openStep'];
    if (insideStep && boundaryStep !== undefined && !ctx.stampUnder) {
      const open = boundaryStep;
      openStep = { step: open, markedAt: stepMarkedAt.get(open) ?? Date.now() };
      // The step's cursor is built again with its History entry: the one in
      // flight can have been re-marked without it, and what the page sends on
      // resume would then count on no History row.
      const entry = ctx.commandRecorder?.getHistory?.(Number.MAX_SAFE_INTEGER)
        .find(command => command.run === sequence.name && command.runStep === open)?.index;
      const cursor = { ...cursorAt(open), ...(entry !== undefined ? { entry } : {}) };
      await markNextCommand(cursor);
      await standPausedRun(cursor);
    } else {
      if (boundaryStep !== undefined) {
        await releaseStep(boundaryStep);
        boundaryStep = undefined;
      }
      await boundarySettled();
      if (!ctx.stampUnder) await standPausedRun({ ...cursorAt(next), paused: true });
    }
    const closed = new Map([...stepStartedAt].filter(([step]) => step !== openStep?.step));
    const drift = comparesBehaviour && closed.size
      ? await compareBehaviour(
          sequence.name, commands, closed, stepReleasedAt, ctx, proxyRun,
          overrideConnectionReason ?? ctx.connection,
          (sequence as any).shapeRules, (sequence as any).boundaryPlacements)
      : undefined;
    const behaviourDrift = [...(drift ?? []), ...nestedDrift];
    return { ...result, ...(behaviourDrift.length ? { behaviourDrift } : {}), ...(openStep ? { openStep } : {}) };
  };
  const nestedUnder = (i: number) => {
    const at = positionOf(i);
    return { step: at.step, within: at.within ?? [] };
  };

  // A person's input on the run's page, read at each step boundary. Steps
  // after it run against a page the recording never had, so the setting
  // decides whether the run holds there, stops, or carries on naming it.
  const personMode = configManager.getReplayConfig().personInputDuringRun;
  // A run resumed from a breakpoint reopens the step the page stopped inside:
  // the page finishes its work now, under that step's still-standing cursor,
  // and the first boundary of the loop closes it once that work is quiet.
  if (options.openStep && !ctx.stampUnder) {
    boundaryStep = options.openStep.step;
    stepMarkedAt.set(options.openStep.step, options.openStep.markedAt);
    if (comparesBehaviour) stepStartedAt.set(options.openStep.step, options.openStep.markedAt);
    await settleProxies(settleConfig.breakpointResumeQuietMs, settleConfig.breakpointResumeCapMs, Date.now());
  }
  // A resumed run takes down the cursor its pause left standing; its steps mark their own.
  if (!ctx.stampUnder) await standPausedRun(undefined);
  const personLanded: NonNullable<ExecutionResult['personInput']>['landed'] = [];
  let pausedForPerson: number | undefined;
  let personSince = Date.now();
  // A pause point saved before a step: the run stops there as at stepTo. The
  // step it resumes at is the one it stopped before, so it does not stop again.
  let pausedAtMark: number | undefined;

  for (let i = startStep; i < targetEnd; i++) {
    const cmd = commands[i];
    if (i > startStep && (cmd as { pauseBefore?: boolean }).pauseBefore && !ctx.stampUnder) {
      pausedAtMark = i;
      break;
    }
    if (i > startStep && ctx.connection && !ctx.stampUnder) {
      const moved = personInputSince(sanitizeReference(ctx.connection), personSince);
      personSince = Date.now();
      if (moved.length) {
        personLanded.push({ before: i, inputs: moved });
        if (personMode === 'stop') {
          results.push({
            step: i + 1, tool: cmd.tool, success: false,
            error: `stopped before this step: a person's ${moved.map(describePersonInput).join(', ')} landed on ${ctx.connection}`,
          });
          break;
        }
        if (personMode === 'pause') {
          pausedForPerson = i;
          break;
        }
      }
    }
    // A traffic check counts what the step before it caused, so that step
    // stays marked while it waits: the crossings it counts are listed under
    // the step that caused them, not under the check.
    // Every step is a call a traffic check can count back to.
    noteCallStart();
    atRunStep(i);
    const holdsPrevious = cmd.tool === 'check' && cmd.params?.traffic !== undefined && boundaryStep !== undefined;
    if (!holdsPrevious) {
      // The previous step's boundary is released before this one marks, so a
      // step's tail is credited to the step that caused it on this side exactly
      // as it is while recording.
      if (boundaryStep !== undefined) await releaseStep(boundaryStep);
      if (comparesBehaviour) stepStartedAt.set(i, Date.now());
      stepMarkedAt.set(i, Date.now());
      await markNextCommand(cursorAt(i));
      boundaryStep = i;
    }

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
      if (wasAborted) {
        debugLog(logPrefix, `Replay aborted at step ${i + 1}`);
        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: false,
          error: 'Replay aborted by user'
        });
        break;
      }
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
      // Typed text from an {{env:}} token or a run's `variables` is a credential.
      let concealText = /\{\{env:/.test(String(cmd.params?.text ?? ''));

      // Resolve {{var:name.path}} / {{timestamp}} tokens against the run's
      // variable store. Throws InterpolationError on an unresolvable token -
      // caught by this step's try/catch below, same as any other step failure.
      // A stored variable with a value for the run's origin stores that one.
      const forOrigin = ctx.runOrigin !== undefined ? cmd.byOrigin?.[ctx.runOrigin] : undefined;
      if (forOrigin !== undefined) params.expression = JSON.stringify(forOrigin);
      params = interpolateParams(params, variableStore, runTimestamp, ctx.runEnv, ctx.runEnvFile, ctx.runOrigin);
      if (ctx.runEnv && ctx.runEnvFile) {
        const names = [...new Set([...JSON.stringify(cmd.params).matchAll(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
          .map(([, name]) => name).filter(name => name in ctx.runEnv!))].sort();
        if (names.length) atRunStepEnv({ file: ctx.runEnvFile, names });
      }

      // Apply variable substitutions. The substituted value is never logged:
      // these steps carry passwords and tokens, and debug.log outlives the run.
      if (activeVariables && cmd.tool === 'input' && params.action === 'type' && params.text) {
        const varName = `var_${i}_${params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
        if (activeVariables[varName] !== undefined) {
          params.text = activeVariables[varName];
          concealText = true;
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

      // The click is compared with the recorded element before it is sent:
      // compared after, a click on the wrong element has already changed the
      // app, and every step after a repair runs on what it changed.
      if (cmd.fingerprint && ((cmd.tool === 'input' && ['click', 'type', 'hover'].includes(params.action))
        || (['check', 'assert', 'wait'].includes(cmd.tool) && params.selector))) {
        params.expect = cmd.fingerprint;
      }

      // A per-step connection is a reference from the RECORDING session, so
      // rebind it onto this one before anything uses it, then require that it
      // actually exists here. There is deliberately no fallback to the run-level
      // connection: that is precisely how a two-browser sequence used to replay
      // green in one browser (bug-018).
      if (addressedConnection({ tool: cmd.tool, params }) !== undefined) {
        const recorded = sanitizeReference(params.connection);
        const resolved = mapConnection(recorded);
        params.connection = resolved;

        // Checked for ANY step naming a connection other than the run's, not
        // just multi-connection sequences: a single-reference sequence pointed
        // at a browser that isn't here otherwise fails deep inside the tool
        // with a generic "Not connected to browser" and never names the
        // connection it wanted.
        if (resolved !== connection) {
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
                runConnection: connection,
                live,
              }),
            });
            break;
          }
        }
      }

      // Launch and attach steps CREATE the name, so a mapping has to rename the
      // launch too or the sequence would open the recorded name and then drive a
      // differently-named one.
      let launchRenamedByMap = false;
      if (createsConnection(cmd) && typeof params.connection === 'string' && connectionMap) {
        const mappedRef = connectionMap[sanitizeReference(params.connection)];
        if (mappedRef) {
          params.connection = mappedRef;
          launchRenamedByMap = true;
        }
      }

      // Inject the run-level connection for tools that accept one, unless the
      // step names its own (per-step connection wins - multi-device sequences).
      if (connection && (TOOLS_ACCEPTING_CONNECTION.includes(cmd.tool) || addressesConnection(cmd))
          && !actsWithoutConnection(cmd) && !params.connection) {
        params.connection = connection;
      }

      // request({ destination: 'browser' }) needs a connection too, but request
      // is deliberately in neither list (destination:'node' sequences must not force a
      // Chrome auto-launch, and destination:'node' takes no connection at all)
      if (cmd.tool === 'request' && params.destination === 'browser' && !params.connection && connection) {
        params.connection = connection;
      }

      // The connection this step actually runs against: its own if it named one,
      // otherwise the run-level connection. Everything wrapped around the step -
      // pre/post-click state, navigation + typed-text validation, pause detection,
      // failure diagnostics - must observe THIS connection, not the run-level one.
      // Helpers keep reading ctx.connection; we just hand them a ctx whose
      // connection is the step's (bug-009).
      const stepConnection: string | undefined = addressedConnection({ tool: cmd.tool, params }) || connection;
      const stepCtx: ExecutionContext = stepConnection === connection
        ? ctx
        : {
            ...ctx,
            connection: stepConnection as string,
            // share the run's variable store with the clone, don't fork it
            variableStore,
          };
      /**
       * Where the step's connection is paused, when that pause is not at a
       * breakpoint this sequence set; null while it runs or when it is.
       */
      const unexpectedPause = async (): Promise<BreakpointHitInfo | null> => {
        if (!stepConnection) return null;
        const at = await checkIfPaused(stepCtx);
        if (!at) return null;
        const key = `${at.url}:${at.lineNumber}`;
        const expected = expectedBreakpoints.has(key);
        debugLog(logPrefix, `Breakpoint hit at ${key} (expected: ${expected})`);
        return expected ? null : at;
      };

      // Override the launched name if a custom connection was provided.
      // Skipped for multi-connection sequences: stamping one reference onto every
      // launch would collapse them into a single browser (see recordedConnections).
      // An explicit `connections` entry for this launch is the more specific
      // instruction and must win - otherwise the map renames the launch and this
      // silently renames it back, with the two writers disagreeing and no signal.
      if (isLaunchStep(cmd) && overrideConnectionReason) {
        if (recordedConnections.multiConnection) {
          debugLog(logPrefix, `Not overriding launched name "${params.connection}" with "${overrideConnectionReason}": sequence spans ${recordedConnections.references.length} connections`);
        } else if (launchRenamedByMap) {
          debugLog(logPrefix, `Not overriding launched name "${params.connection}" with "${overrideConnectionReason}": connections mapping already rebound this launch`);
        } else {
          params.connection = overrideConnectionReason;
        }
      }

      // Handle stale callFrameId for getVariables
      if (cmd.tool === 'inspect' && params.action === 'getVariables' && params.callFrameId && stepConnection) {
        debugLog(logPrefix, `Refreshing stale callFrameId`);
        const fresh = (await debuggerStatusOf({ ...ctx, connection: stepConnection }))?.pausedAt?.callFrameId;
        if (fresh) params.callFrameId = fresh;
        else debugLog(logPrefix, `Warning: no paused frame on ${stepConnection} to refresh the callFrameId from`);
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

      // A check reads through the check tool; what it does on the answer is
      // the executor's, because stopping, carrying on and running another
      // sequence are all moves through the run.
      if (cmd.tool === 'check') {
        const { holds, fails } = params as { holds?: CheckAction; fails?: CheckAction };
        // Exempt from stepTimeout, as a wait is: its own withinMs bounds it,
        // and the run's remaining total bounds that.
        const remaining = Math.max(1, totalTimeout - (Date.now() - startTime));
        const checkAbort = new AbortController();
        const read = await executeWithTimeout(
          executeCommandWithRetry(executeToolCall, 'check', params, logPrefix, stepSignalOf(abortSignal, checkAbort)),
          remaining,
          getMessage('REPLAY_STEP_TIMEOUT', { step: i + 1, tool: cmd.tool, timeoutMs: remaining, limitSource: 'remaining totalTimeout' }),
          checkAbort
        );
        await markNextCommand(cursorAt(boundaryStep ?? i));
        if (!read.success) {
          results.push({ step: i + 1, tool: cmd.tool, success: false, error: abortSignal?.aborted ? 'Replay aborted by user' : read.error });
          break;
        }
        const reading = read.result?._meta?.check ?? {};
        const held = reading.outcome === 'held';
        const action: CheckAction = held ? (holds ?? 'continue') : (fails ?? 'stop');
        const kind: 'continue' | 'stop' | 'run' = typeof action === 'string' ? action : 'run';
        const limitMs = (Number(params.afterMs) || 0) + (Number(params.withinMs) || 0);
        const check = {
          outcome: held ? 'held' as const : 'failed' as const, subject: String(reading.subject ?? ''),
          ...(reading.found !== undefined ? { found: String(reading.found) } : {}), action: kind,
          ...(limitMs ? { waitedMs: Number(reading.elapsedMs) || 0, limitMs } : {}),
        };
        const outcomeFor = (extra: Partial<CheckOutcomeRecord> = {}) => {
          if (!ctx.stampUnder && checked) recordCheckOutcome(checked, { runId: proxyRun, step: i, ...check, ...extra });
        };

        if (action === 'stop') {
          const error = params.message
            ?? `check ${held ? 'held' : 'failed'}: ${check.subject}${check.found ? ` - found ${check.found}` : ''}`;
          outcomeFor();
          results.push({ step: i + 1, tool: cmd.tool, success: false, check, error });
          break;
        }
        // A pause that landed while the check read or waited stops the run
        // here, as it would after any other step.
        const pausedHere = action === 'continue' || typeof action === 'object' ? await unexpectedPause() : null;
        if (action === 'continue') {
          outcomeFor();
          results.push({ step: i + 1, tool: cmd.tool, success: true, check });
          if (pausedHere) return pausedAt({ results, totalCommands: commands.length, durationMs: Date.now() - startTime, breakpointHit: pausedHere }, i + 1, true);
          continue;
        }
        if (pausedHere) {
          outcomeFor();
          results.push({ step: i + 1, tool: cmd.tool, success: true, check });
          return pausedAt({ results, totalCommands: commands.length, durationMs: Date.now() - startTime, breakpointHit: pausedHere }, i + 1, true);
        }
        const branch = await runBranch(
          action.run, { ...stepCtx, variableStore, stampUnder: nestedUnder(i) }, commandRecorder,
          { stepTimeout, totalTimeout: Math.max(0, totalTimeout - (Date.now() - startTime)) }, abortSignal);
        await markNextCommand(cursorAt(boundaryStep ?? i));
        if (branch.behaviourDrift) nestedDrift.push(...branch.behaviourDrift);
        outcomeFor({
          ran: action.run, steps: branch.substeps?.length ?? 0,
          ranSteps: ranStepsOf(branch.substeps ?? [], branch.ranCommands),
          ...(branch.error ? { error: branch.error } : {}),
        });
        results.push({
          step: i + 1, tool: cmd.tool, success: branch.success, check,
          sequenceName: action.run, substeps: branch.substeps, ranCommands: branch.ranCommands,
          ...(branch.error ? { error: branch.error } : {}),
        });
        if (!branch.success) break;
        if (action.resumeAt !== undefined) {
          const resume = Number(action.resumeAt);
          // Forward only: resuming at or before this step runs it again, forever.
          if (!Number.isInteger(resume) || resume <= i || resume > targetEnd) {
            results.push({
              step: i + 1, tool: cmd.tool, success: false,
              error: `Check at step ${i + 1} cannot resume at ${resume}: resumeAt counts from 0 and must be after the check, ${i + 1} to ${targetEnd}, where ${targetEnd} ends the run.`,
            });
            break;
          }
          i = resume - 1;
        }
        continue;
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
          { ...stepCtx, variableStore, stampUnder: nestedUnder(i) },
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

        if (loopResult.iterations > 0) await markNextCommand(cursorAt(i));

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
      const stepStarted = Date.now();
      const stepAbort = new AbortController();
      // A dialog this step opens is answered by the step after it, when that
      // step is a `modal answer`. Otherwise a run the bench started has a
      // person watching, who answers it: a picker opens on screen for them
      // rather than held with no window, and the run waits on their answer.
      const next = commands[i + 1];
      const nextAnswers = next?.tool === 'modal' && next.params?.action === 'answer';
      const personAnswers = !nextAnswers && originChannel() === 'bench';
      debugLog(logPrefix, `Step ${i + 1}: a dialog it opens is answered by ${nextAnswers ? 'the next step' : personAnswers ? 'a person' : 'nobody'} (origin ${originChannel() ?? 'none'})`);
      const call = () => executeCommandWithRetry(executeToolCall, cmd.tool, params, logPrefix, stepSignalOf(abortSignal, stepAbort));
      const execResult = await executeWithTimeout(
        personAnswers ? showingPickers(call) : call(),
        stepBound,
        getMessage('REPLAY_STEP_TIMEOUT', {
          step: i + 1,
          tool: cmd.tool,
          timeoutMs: stepBound,
          limitSource: boundedByTotal ? 'remaining totalTimeout' : 'stepTimeout',
        }),
        stepAbort
      );

      // Restored after the step: a step that ran a nested sequence left the
      // cursor cleared by that run's last release, and the traffic this step
      // causes after that call returns belongs to this step.
      await markNextCommand(cursorAt(i));

      // assert and wait are faces of a check: their answer, how long they read
      // for and the most they could, recorded as a check step's are, so the
      // bench reads every check the same way.
      const waitedMs = Date.now() - stepStarted;
      const faceOf = (held: boolean) => {
        if (cmd.tool !== 'assert' && cmd.tool !== 'wait') return undefined;
        const spec = cmd.tool === 'assert' ? assertAsCheck(params as any) : waitAsCheck(params);
        const limitMs = (spec.afterMs ?? 0) + (spec.withinMs ?? 0);
        const check = {
          outcome: held ? 'held' as const : 'failed' as const, subject: subjectOfCheck(spec),
          action: held ? 'continue' as const : 'stop' as const,
          ...(limitMs ? { waitedMs, limitMs } : {}),
        };
        if (!ctx.stampUnder && checked) recordCheckOutcome(checked, { runId: proxyRun, step: i, ...check });
        return check;
      };

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
        if (execResult.errorId === 'INPUT_ELEMENT_MISMATCH') {
          const refused = execResult.response?._meta?.element;
          results.push({ step: i + 1, tool: cmd.tool, success: false, error: execResult.error });
          return pausedAt({
            results,
            totalCommands: commands.length,
            durationMs: Date.now() - startTime,
            pausedAtStep: i + 1,
            clickValidationFailure: {
              step: i + 1,
              selector: params.selector || (params.x !== undefined ? `${params.x}, ${params.y}` : 'unknown'),
              errors: [execResult.error ?? 'reached another element'],
              warnings: [],
              info: ['nothing sent: the element was compared before the input was'],
              ...(refused?.repair ? { repair: refused.repair } : {}),
            },
          }, i);
        }
        if (execResult.errorId === 'DIALOG_OPENED' && nextAnswers) {
          const dialog = execResult.response?._meta?.dialog;
          results.push({ step: i + 1, tool: cmd.tool, success: true, ...(dialog ? { dialog } : {}) });
          debugLog(logPrefix, `Step ${i + 1} opened a dialog, answered by step ${i + 2}`);
          continue;
        }
        if (execResult.errorId === 'DIALOG_OPENED' && personAnswers && stepConnection) {
          debugLog(logPrefix, `Step ${i + 1} opened a dialog; waiting for a person to answer it`);
          const waited = await executeToolCall('modal', {
            action: 'wait', connection: stepConnection,
            timeoutMs: Math.max(1, totalTimeout - (Date.now() - startTime)),
          }, abortSignal).catch((error: any) => error?.response ?? { isError: true });
          if (abortSignal?.aborted) {
            results.push({ step: i + 1, tool: cmd.tool, success: false, error: 'Replay aborted by user' });
            break;
          }
          const dialog = waited?._meta?.dialog ?? execResult.response?._meta?.dialog;
          const dialogAnswer = waited?._meta?.dialogAnswer;
          if (!waited?.isError && dialogAnswer?.kind === 'fileChooser' && !dialogAnswer.picked && cmd.onCancel !== 'continue') {
            results.push({
              step: i + 1, tool: cmd.tool, success: false,
              error: 'File picker cancelled',
              ...(dialog ? { dialog } : {}), dialogAnswer,
            });
            break;
          }
          if (!waited?.isError) {
            results.push({
              step: i + 1, tool: cmd.tool, success: true,
              ...(dialog ? { dialog } : {}), ...(dialogAnswer ? { dialogAnswer } : {}),
            });
            await markNextCommand(cursorAt(i));
            continue;
          }
          results.push({
            step: i + 1, tool: cmd.tool, success: false,
            error: failureLine(waited?.content?.[0]?.text ?? 'The dialog stayed open'),
            ...(dialog ? { dialog } : {}),
          });
          break;
        }
        const diagnostics = await gatherDiagnostics(stepCtx);
        const failedCheck = faceOf(false);
        results.push({
          step: i + 1,
          tool: cmd.tool,
          success: false,
          error: `${execResult.error}${diagnostics}`,
          ...(failedCheck ? { check: failedCheck } : {}),
        });
        break;
      }

      // Note a browser this step created, so the run can close what it opened
      // and leave what it borrowed. The reference is read from the response
      // rather than the params: `reused: true` means the reference already
      // existed and the browser is someone else's (issue #103).
      if (isLaunchStep(cmd) && ctx.launchedConnections) {
        const launchMeta = execResult.result?._meta?.launch;
        if (launchMeta?.name && launchMeta.reused === false) {
          ctx.launchedConnections.add(launchMeta.name);
        }
      }

      // Track breakpoints set by this sequence
      // Due to CDP line number handling (0-based vs 1-based) and resolution to nearest valid line,
      // we track the requested line and ±1 variants to handle edge cases
      if (cmd.tool === 'breakpoint' && params.action === 'set' && params.url) {
        const requestedLine = params.lineNumber;

        // The line CDP moved the breakpoint to, from `_meta`.
        const reportedLine: number = execResult.result?._meta?.breakpoint?.line ?? requestedLine;

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
        const clickValidation = await validateClickAction(
          stepCtx, preClickState, execResult.result, clickConfig, (cmd as { traffic?: StepTraffic }).traffic, cmd.fingerprint);

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

          return pausedAt({
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
              ...(clickValidation.repair ? { repair: clickValidation.repair } : {}),
            }
          }, i);
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

      const heldCheck = faceOf(true);
      results.push({ step: i + 1, tool: cmd.tool, success: true, ...(heldCheck ? { check: heldCheck } : {}) });
      debugLog(logPrefix, `Step ${i + 1} completed successfully`);

      // Check if we hit a breakpoint after this step (on the step's own connection)
      const breakpointHit = await unexpectedPause();
      if (breakpointHit) {
        return pausedAt({ results, totalCommands: commands.length, durationMs: Date.now() - startTime, breakpointHit }, i + 1, true);
      }

      // Post-step async operations (after marking success)
      if (cmd.tool === 'input' && params.action === 'type' && params.selector && stepConnection) {
        await validateTypedText(stepCtx, params.selector, params.text || '', params.append === true, concealText);
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
        const nextConnection: string | undefined = addressedConnection(nextCmd)
          ? mapConnection(nextCmd.params.connection)
          : connection;
        if (nextCmd.tool === 'input' && nextCmd.params.selector && nextConnection) {
          const nextCtx: ExecutionContext = nextConnection === connection
            ? ctx
            : { ...ctx, connection: nextConnection, variableStore };
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
  // An abort part-way through is a pause, not an end. The aborted step is
  // recorded as a failure, so without this the run would tear down the
  // sequence - running its declared teardown commands - in the middle of a
  // session somebody stopped to look at.
  // A paused session carried on by `step` or `finish` and cut short is a pause
  // wherever it stops: the session stays open on the step it cut short, where
  // a fresh run cancelled is over and runs its teardown.
  const isPaused = (stoppedShortOfEnd && (!anyFailed || abortSignal?.aborted === true))
    || (options.resumesSession === true && abortSignal?.aborted === true)
    || pausedForPerson !== undefined || pausedAtMark !== undefined;

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

  // The last step's boundary closes before anything is compared, so its span
  // ends at a release like every other step's rather than at the comparison.
  if (boundaryStep !== undefined) await releaseStep(boundaryStep);
  await boundarySettled();

  // A paused run leaves its cursor standing before the step it resumes at, so
  // what crosses in the pause is stamped as the pause's. A run that ended
  // leaves none: its finish line is the last step's release, and what crosses
  // after it belongs to no run.
  const stands = isPaused && options.standsPaused !== false;
  if (stands && !ctx.stampUnder) {
    const next = pausedForPerson ?? pausedAtMark
      ?? (abortSignal?.aborted ? (results.at(-1)?.step ?? startStep + 1) - 1 : targetEnd);
    await standPausedRun({ ...cursorAt(next), paused: true });
  }

  // A paused run stops the page and its traffic as well as its steps: a page
  // left running produces timers and frames no step caused. A person's input
  // holds every layer; a stop at `endStep` holds what the run asked for, all
  // by default. A refused click and an abort hold nothing: the repair reads
  // the live page, and an abort hands the page back to whoever stopped it.
  let pauseHeld: HoldLayer[] | undefined;
  const stoppedAtEnd = (stoppedShortOfEnd || pausedAtMark !== undefined) && !anyFailed && pausedForPerson === undefined && !abortSignal?.aborted;
  const markHolds = pausedAtMark !== undefined ? (commands[pausedAtMark] as { pauseHolds?: HoldLayer[] }).pauseHolds : undefined;
  const layers = pausedForPerson !== undefined ? undefined : stoppedAtEnd ? markHolds ?? options.holdWhilePaused : [];
  if (stands && (pausedForPerson !== undefined || stoppedAtEnd) && layers?.length !== 0 && ctx.connection && !ctx.stampUnder) {
    const reading = await hold(sanitizeReference(ctx.connection), { source: 'sequence', ...(layers ? { layers } : {}) }).catch(() => undefined);
    pauseHeld = reading?.held.filter(held => held.source === 'sequence').map(held => held.layer);
  }

  const marked = pausedAtMark !== undefined ? (commands[pausedAtMark] as { pauseNote?: string; pauseNotify?: true }) : undefined;
  const pauseNote = marked?.pauseNote;
  const pauseNotify = Boolean(marked?.pauseNotify || pauseNote);
  if (pauseNotify && !ctx.stampUnder) {
    await appendEvent(resolveSessionName(), 'instruction', {
      sequence: sequence.name,
      step: pausedAtMark! + 1,
      ...(pauseNote ? { note: pauseNote } : {}),
      resolve: "replay({ action: 'finish' })",
    });
  }

  const ownDrift = comparesBehaviour
    ? await compareBehaviour(
        sequence.name, commands, stepStartedAt, stepReleasedAt, ctx, proxyRun,
        overrideConnectionReason ?? ctx.connection,
        (sequence as any).shapeRules, (sequence as any).boundaryPlacements)
    : undefined;
  const behaviourDrift = [...(ownDrift ?? []), ...nestedDrift];

  return {
    results,
    totalCommands: commands.length,
    durationMs: Date.now() - startTime,
    ...(behaviourDrift && behaviourDrift.length > 0 ? { behaviourDrift } : {}),
    ...(teardownOutcome ? { teardownResults: teardownOutcome.results, teardownFailed: teardownOutcome.failed } : {}),
    ...(pauseHeld?.length ? { pauseHeld } : {}),
    ...(pausedAtMark !== undefined ? { pausedAtMark } : {}),
    ...(pauseNotify ? { pauseNotify: true as const } : {}),
    ...(pauseNote ? { pauseNote } : {}),
    ...(personLanded.length ? {
      personInput: { mode: personMode, landed: personLanded, ...(pausedForPerson !== undefined ? { pausedBefore: pausedForPerson } : {}), ...(pauseHeld?.length && pausedForPerson !== undefined ? { held: pauseHeld } : {}) },
    } : {}),
  };
}

/**
 * Compare each step's boundary traffic against what the recording stored.
 *
 * Windowed the way recording windows it: a step owns everything from when it
 * began until the next one did, and the last step owns everything after it.
 * Run after the steps rather than between them, so the comparison never delays
 * a run or changes its timing.
 *
 * Frames are counted and not compared. A background stream delivers on its own
 * schedule, so its count moves with how long a step happened to take and a
 * difference there says nothing about the step.
 */
async function compareBehaviour(
  /** The run whose History entries each step's match is attached to. */
  run: string,
  commands: RecordedCommand[],
  stepStartedAt: Map<number, number>,
  /** When each step's boundary closed, which ends that step's span. */
  stepReleasedAt: Map<number, number>,
  ctx: ExecutionContext,
  /** The pass whose stamps name this run's traffic. */
  proxyRun: string,
  /** The browser whose proxy holds it. */
  reference: string,
  /** What a person ruled about each payload shape when this was recorded. */
  rules?: ShapeRules,
  /** Where the sequence lists a kind that crossed at another step. */
  placements?: Record<string, number>
): Promise<ExecutionResult['behaviourDrift']> {
  const indices = [...stepStartedAt.keys()].sort((a, b) => a - b);
  // The rules, placement and comparison the bench's rows use, so a step reads
  // the same here as on its rows.
  const { rulesForRun } = await import('./run-rules.js');
  const ignores = rulesForRun(reference).ignores.map(one => one.kind);
  const proxy = getProxy(reference);
  const writes = writeEvents(reference);
  const values = new Map((sessions.get(reference)?.writeWatch?.writes ?? []).map(write => [write.id, write.value]));
  const events: Crossing[] = [...(proxy?.eventsIn() ?? []), ...writes]
    .filter(event => event.runId === proxyRun || event.runId === undefined)
    .sort((a, b) => a.at - b.at);
  const under = ctx.stampUnder;
  const ran = under ? undefined : placePass(events, placements, commands.length);
  const path = (index: number) => [...(under?.within ?? []), index].join('.');
  const ranAt = (index: number) => (under
    ? events.filter(event => event.runId === proxyRun && event.step === under.step && (event.within ?? []).join('.') === path(index))
    : ran?.get(index) ?? []);
  const bodyOf = (event: Crossing) => (event.kind === 'write' ? values.get(event.id) : proxy?.bodyOf(event.id));
  const ruledOut = (event: Crossing) => {
    const shape = (event as ProxyEvent).evidence?.shape;
    const ruled = shape ? rules?.[shape] : undefined;
    return ruled === 'background' || ruled === 'unknown';
  };
  const drift: NonNullable<ExecutionResult['behaviourDrift']> = [];

  for (const [position, index] of indices.entries()) {
    const traffic = commands[index].traffic;
    if (!traffic) continue;
    const from = stepStartedAt.get(index)!;
    const to = stepReleasedAt.get(index) ?? stepStartedAt.get(indices[position + 1]) ?? Date.now();
    const heldMs = traffic.windowMs !== undefined ? { heldMs: { recorded: traffic.windowMs, replayed: to - from } } : {};
    if (!traffic.kinds) {
      ctx.commandRecorder?.noteStepMatch?.(run, index, { matched: 0, kinds: 0, unmatched: [], noBaseline: true, ...heldMs });
      continue;
    }
    const compared = compareStep({
      recorded: traffic.kinds, ran: ranAt(index), step: index, ignores, bodyOf, ruledOut,
      ...(commands[index].expected ? { expected: commands[index].expected } : {}),
    });
    const unmatched = [
      ...compared.kinds.filter(one => one.verdict !== 'match').map(one => ({
        kind: one.kind,
        reasons: one.verdict === 'unexpected' ? ['new'] : one.verdict === undefined ? ['payload not held'] : one.reasons,
      })),
      ...compared.missing.map(one => ({ kind: one.kind, reasons: ['missing'] })),
    ];
    ctx.commandRecorder?.noteStepMatch?.(run, index, {
      matched: compared.kinds.length - compared.kinds.filter(one => one.verdict !== 'match').length,
      kinds: compared.kinds.length + compared.missing.length,
      unmatched, ...heldMs,
    });
    if (unmatched.length) {
      drift.push({
        step: index + 1,
        ...(under ? { path: [under.step, ...under.within, index].map(n => n + 1).join('.') } : {}),
        label: `${commands[index].tool}.${commands[index].params?.action ?? ''}`.replace(/\.$/, ''),
        unmatched,
      });
    }
  }
  return drift;
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
  const { commandRecorder, connection } = ctx;

  const result = await executeSteps({
    ...options,
    endStep: stepTo
  });

  // Held before a step for a person's input or at a saved pause point, as a stepTo pause holds.
  const pausedBefore = result.personInput?.pausedBefore ?? result.pausedAtMark;
  if (pausedBefore !== undefined) {
    result.pausedAtStep = pausedBefore;
    result.activeSequenceState = {
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      connection: connection || '',
      currentStep: pausedBefore,
      totalSteps: sequence.commands.length,
      pausedAt: Date.now(),
      historyIndexAtPause: commandRecorder.getCurrentHistoryIndex(),
      capturedVariables: ctx.variableStore,
      runTimestamp: ctx.runTimestamp,
      ...(ctx.connectionMap && { connectionMap: ctx.connectionMap }),
      ...(ctx.runEnv && { runEnv: ctx.runEnv, runEnvFile: ctx.runEnvFile }),
      ...(ctx.runOrigin && { runOrigin: ctx.runOrigin }),
    };
    return result;
  }

  // If we stopped at stepTo and didn't fail, set up paused state
  if (stepTo !== undefined && result.results.length > 0) {
    const lastResult = result.results[result.results.length - 1];
    if (lastResult.success && lastResult.step >= stepTo) {
      const activeState: ActiveSequenceState = {
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        connection: connection || '',
        currentStep: lastResult.step,
        totalSteps: sequence.commands.length,
        pausedAt: Date.now(),
        historyIndexAtPause: commandRecorder.getCurrentHistoryIndex(),
        capturedVariables: ctx.variableStore,
        runTimestamp: ctx.runTimestamp,
        // step/finish must resolve per-step connections the way this run did
        ...(ctx.connectionMap && { connectionMap: ctx.connectionMap }),
        ...(ctx.runEnv && { runEnv: ctx.runEnv, runEnvFile: ctx.runEnvFile }),
      ...(ctx.runOrigin && { runOrigin: ctx.runOrigin }),
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
  const status = await debuggerStatusOf(ctx);
  if (!status) return null;
  return {
    isPaused: status.paused,
    pauseLocation: status.paused
      ? (status.pausedAt ? `${status.pausedAt.url}:${status.pausedAt.lineNumber}` : 'unknown location')
      : undefined,
    breakpointCount: status.totalBreakpoints,
  };
}
