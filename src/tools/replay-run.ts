/**
 * Running a sequence: `run` in the background or blocking, `runAll` over a
 * folder or tag, and the run itself from connection setup to its result.
 */
import type { CommandRecorder, ActiveSequenceState, CommandSequence } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { showReplayOverlay } from '../interaction-recorder.js';
import { deriveConnectionReference, sanitizeReference } from '../reference-validator.js';
import { runRegistry, type RunRecord } from './replay-run-registry.js';
import {
  loadSequence,
  rebaseSequence,
  analyzeSequenceConnections,
  extractConnectionFromSequence,
  sequenceNeedsConnection,
  ensureConnection,
  navigateToStartUrl,
  executeSequenceWithPause,
  getDebugState,
  setReplayCursorCallbacks,
  injectReplayCursor,
  showClickEffect,
  showKeyPress,
  removeReplayCursor,
  checkIfPaused,
  analyzeRecordedStepConnections,
  sanitizeConnectionMap,
  type ExecutionContext,
} from './replay-executor.js';
import { addressedConnection, createdName } from './connection-steps.js';
import { sequenceNeedsProxy } from './replay-connections.js';
import { getProxy } from '../proxy/registry.js';
import { PROXIED_WORD } from '../reference-validator.js';
import {
  formatExecutionResults,
  formatPausedResponse,
  formatDebugState,
  formatBreakpointHit,
  formatClickValidationFailure,
  extractTextVariables,
  formatVariablePrompt,
} from './replay-formatters.js';
import { configManager } from '../config.js';
import { hasTemplateToken } from './interpolation.js';
import { snapshotConsole, strictConsoleFailures, snapshotSockets, socketFailures } from './replay-run-health.js';
import { collectNestedRebindableReferences, loadRunEnv, unmatchedVariableKeys } from './replay-run-inputs.js';
import { connectionsSharingPort, navigatedConnections, ensureDeclaredConnections, closeLaunchedConnections, pendingDeclaredCleanups, cleanupKey } from './replay-run-owned.js';
import { type ReplayArgs } from './replay-schema.js';
import { logRun } from './replay-session.js';
import { handleLoadSequenceError } from './replay-validation.js';

type RunOutcome = 'completed' | 'failed' | 'paused' | 'cancelled';

interface PerformRunDeps {
  args: ReplayArgs;
  recorder: CommandRecorder;
  executeToolCall: ExecuteToolCall;
  getPageForConnection: (connection: string) => Promise<any>;
  getConnectionPort?: (connection: string) => Promise<number | null>;
  sequence: CommandSequence;
  analysis: ReturnType<typeof analyzeSequenceConnections>;
  connection: string | undefined;
  needsConnection: boolean;
  /** Recorded-reference -> this-session-reference rebinding (args.connections). */
  connectionMap?: Record<string, string>;
  /** Filled in by the executor: references the run's own steps launched. */
  launchedConnections: Set<string>;
  /** Values read from args.envFile, resolved before process.env by {{env:NAME}}. */
  runEnv?: Record<string, string>;
}

/** The longest a `wait: true` run holds its call; see the bound in handleRun. */
const WAIT_BOUND_MS = 120_000;

/**
 * Play a sequence in the bench open on the connection, from step 1, as the
 * bench's own Replay button does: the rows, badges and check outcomes land in
 * the bench while it plays. The bench drives from the file alone, so a
 * run-time retarget or variable has nothing to reach it through and is refused.
 */
async function runInBench(args: ReplayArgs) {
  const bench = await import('../bench-mode.js');
  const connection = args.connection;
  if (!connection || !bench.isBenchOpen(connection)) {
    return createErrorResponse('REPLAY_BENCH_NOT_OPEN', { connection: connection ?? '(none given)' });
  }
  const carried = (['baseUrl', 'startUrl', 'variables', 'envFile', 'connections', 'startFrom', 'stepTo'] as const)
    .filter(key => args[key] !== undefined);
  if (carried.length) return createErrorResponse('REPLAY_BENCH_UNSUPPORTED', { params: carried.join(', ') });
  const name = String(args.name ?? '');
  await bench.selectSequence(connection, name);
  const play = (async () => {
    await bench.gotoSequenceStep(connection, 0);
    return bench.playSequence(connection);
  })();
  const benchUrl = bench.getBenchSession(connection)?.benchUrl ?? '';
  if (!args.wait) {
    play.catch(() => {});
    return createSuccessResponse('REPLAY_BENCH_PLAYING', { name, connection, benchUrl });
  }
  const state = await play;
  return createSuccessResponse('REPLAY_BENCH_PLAYED', {
    name, benchUrl,
    reached: state?.currentStep ?? 0, total: state?.total ?? 0,
    failure: state?.failure ? `\n\nStopped: ${state.failure}` : '',
  });
}

export async function handleRun(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connection: string) => Promise<any>,
  abortSignal?: AbortSignal,
  getConnectionPort?: (connection: string) => Promise<number | null>,
  /**
   * `validateVariableKeys: false` for a sequence running as part of a suite:
   * `runAll` validates the one map it holds against the whole suite's keys and
   * a per-sequence check would reject a key meant for a different member.
   */
  opts?: { validateVariableKeys?: boolean; suite?: { id: string; label: string } }
) {
  if (args.bench) return runInBench(args);

  // Load sequence
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'run');
  }

  // Run-time retarget: baseUrl swaps the origin of every absolute URL in the
  // sequence (startUrl + command params); startUrl replaces the entry URL
  // wholesale. Lets one recorded sequence run against any deployment.
  const sequence = (args.baseUrl || args.startUrl)
    ? rebaseSequence(loadResult.sequence, { baseUrl: args.baseUrl, startUrl: args.startUrl })
    : loadResult.sequence;
  const commands = sequence.commands;
  const analysis = analyzeSequenceConnections(commands);

  // Determine connection reason
  let connection = args.connection || extractConnectionFromSequence(commands, analysis);

  // Validate connection requirement - fall back to a reason derived from the
  // sequence name so we can auto-launch Chrome instead of erroring out
  const needsConnection = sequenceNeedsConnection(commands);
  if (!connection && !analysis.createsBeforeUse && needsConnection) {
    connection = deriveConnectionReference(sequence.name);
  }

  // Handle variable extraction and prompting. A step whose recorded text
  // carries an interpolation token ({{env:NAME}}, {{var:...}}) is already
  // parameterised - its value arrives at run time by definition - so it does
  // not hold the run open for an answer. It stays in the extracted list, so a
  // caller can still override it and the key validation still accepts it.
  const extractedVariables = extractTextVariables(commands);
  const needsAnswer = Object.values(extractedVariables)
    .some(v => !hasTemplateToken(v.value));
  if (needsAnswer && args.variables === undefined) {
    const idParam = args.sequenceId || args.name!;
    // Tagged as a PROMPT, not a run: runAll reads `prompted` to separate
    // "asked a question" from "executed and passed", or a suite goes green for
    // a sequence that ran zero steps.
    return {
      content: [{ type: 'text', text: formatVariablePrompt(sequence.name, idParam, extractedVariables, connection) }],
      _meta: { tool: 'replay', action: 'run', timestamp: Date.now(), replay: { success: false, prompted: true } }
    };
  }

  // The envFile is read before any side effects: a missing file or a malformed
  // line is a parameter error, not a step failure halfway through a flow that
  // has already logged in.
  let runEnv: Record<string, string> | undefined;
  if (args.envFile) {
    const loaded = await loadRunEnv(args.envFile);
    if ('error' in loaded) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'envFile',
        value: args.envFile,
        message: loaded.error,
      });
    }
    runEnv = loaded.values;
  }

  // Same rule for the typed-text substitutions, before any side effects. A key
  // matching no step is dropped in silence by the executor and the step runs on
  // its RECORDED text, so a mistyped key reads as an override while the recorded
  // value - a password among them - reaches the live app.
  //
  // Skipped for a suite member: `runAll` hands ONE map to every sequence and
  // checks it against the union of the whole suite, so a key valid for another
  // sequence must not fail this one.
  if (args.variables && opts?.validateVariableKeys !== false) {
    const { unmatched, known } = unmatchedVariableKeys(args.variables, commands, recorder);
    if (unmatched.length > 0) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'variables',
        value: unmatched.join(', '),
        message: `${unmatched.length > 1 ? 'Those keys name' : `"${unmatched[0]}" names`} no typed-text step in "${sequence.name}" or any sequence it reaches. ` +
          `The key is BUILT from the selector - var_<0-based step index>_<selector, non-alphanumerics replaced by _> - so "#password" at step 3 is "var_3__password", with two underscores. ` +
          (known.length
            ? `Substitutable here: ${known.join(', ')}.`
            : `This sequence has no typed text to substitute.`),
      });
    }
  }

  // Validate the connection rebinding before any side effects. A key that names
  // no recorded reference is a typo the user needs to hear about now: silently
  // ignoring it would leave the step on its recorded reference and, in the worst
  // case, replay a cross-browser sequence in one browser (bug-018).
  const connectionMap = sanitizeConnectionMap(args.connections);
  if (connectionMap) {
    const recorded = analyzeRecordedStepConnections(commands);
    // A sequence a check runs, or a forEach's body, inherits this map, and a
    // setup sequence normally lives BEHIND the check - so its references have
    // to count as rebindable too, or the only rebindable ones are those
    // needing no rebind.
    const nested = collectNestedRebindableReferences(commands, recorder);
    const launchRefs = commands
      .map(createdName)
      .filter((name): name is string => name !== undefined)
      .map(name => sanitizeReference(name));
    const known = new Set([...recorded.references, ...launchRefs, ...nested.references]);
    // An unresolvable nested sequence (on disk, or created later) means we
    // cannot prove a key is a typo - and refusing a run over an unprovable
    // typo is worse than letting an unused mapping through.
    const unknown = nested.complete
      ? Object.keys(connectionMap).filter(k => !known.has(k))
      : [];
    if (unknown.length > 0) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'connections',
        value: unknown.join(', '),
        message: `No step in "${sequence.name}" is recorded against ${unknown.map(u => `"${u}"`).join(', ')}. ` +
          (known.size > 0
            ? `Recorded references: ${[...known].join(', ')}. `
            : `No step in this sequence names a connection at all, so there is nothing to rebind - use connection to set the run connection. `) +
          `Check replay({ action: 'get', name: '${sequence.name}', outputFormat: 'commands' }).`
      });
    }

    // Two recorded connections rebound onto ONE live reference replays the whole
    // multi-browser sequence in a single browser and reports success - bug-018
    // exactly, re-entered through the API that exists to prevent it. Refuse.
    const byTarget = new Map<string, string[]>();
    for (const [from, to] of Object.entries(connectionMap)) {
      if (!recorded.references.includes(from)) continue;  // launch-only rename, harmless
      byTarget.set(to, [...(byTarget.get(to) ?? []), from]);
    }
    const collapsed = [...byTarget.entries()].filter(([, froms]) => froms.length > 1);
    if (collapsed.length > 0) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'connections',
        value: collapsed.map(([to, froms]) => `${froms.join(' + ')} -> ${to}`).join('; '),
        message: `That mapping would run ${collapsed.map(([to, froms]) => `${froms.length} recorded connections (${froms.join(', ')}) in the single browser "${to}"`).join('; ')}. ` +
          `"${sequence.name}" spans more than one browser precisely to test what crosses between them; collapsing it would make the run pass without ever involving a second browser. ` +
          `Give each recorded reference its own live reference, or launch another browser first.`
      });
    }
  }

  // A step naming its own connection resolves through `connections` alone, so
  // where every connection-taking step names one reference, a run-level
  // connection reaches no step at all. The steps then drive the recorded
  // reference - live but stale in the same session - and fail as "element not
  // found" against the wrong window. Refused before any side effects, with the
  // mapping that retargets them. A `{{...}}` reference resolves only at run time
  // and is left to the per-step existence check.
  if (args.connection) {
    const runRef = sanitizeReference(args.connection);
    const recorded = analyzeRecordedStepConnections(commands);
    const unreached = recorded.uniform !== undefined &&
      !recorded.mixed &&
      !hasTemplateToken(recorded.uniform) &&
      recorded.uniform !== runRef &&
      !connectionMap?.[recorded.uniform]
      ? recorded.uniform
      : undefined;
    if (unreached) {
      const steps = commands
        .map((c, i) => sanitizeReference(addressedConnection(c) ?? '') === unreached ? i + 1 : 0)
        .filter(Boolean);
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'connection',
        value: args.connection,
        message: `Step${steps.length > 1 ? 's' : ''} ${steps.join(', ')} of "${sequence.name}" name the connection "${unreached}", ` +
          `and a run-level connection does not reach a step that names its own connection - ` +
          `those steps would drive "${unreached}" instead of "${runRef}". ` +
          `Retarget them with connections: { "${unreached}": "${runRef}" }, ` +
          `or run with connection: "${unreached}" to drive the recorded connection.`
      });
    }
  }

  // The run-level connection may itself have been DERIVED from the sequence (a
  // launched name), in which case it is a recorded name and needs the
  // same rebinding as the steps - otherwise it points at a reference that does
  // not exist here, and the startUrl navigation and cursor injection silently
  // no-op against it. An explicitly passed connection is already a live
  // reference and is left alone.
  if (connectionMap && !args.connection && connection) {
    connection = connectionMap[sanitizeReference(connection)] ?? connection;
  }

  // Bring up any browser the sequence declares before the first step.
  const declaredConns = await ensureDeclaredConnections(sequence, executeToolCall, getPageForConnection, connectionMap);
  if (declaredConns.error) {
    // A declaration that contradicts itself is a bad sequence, not a missing
    // browser - saying "connection not found" would send you looking for one.
    return declaredConns.invalid
      ? createErrorResponse('INVALID_PARAMETER', {
          parameter: 'requiredConnections',
          value: sequence.name,
          message: declaredConns.error,
        })
      // Not CONNECTION_NOT_FOUND: that template renders a generic "no active
      // browser connection" and drops the message, which names the browser,
      // its role and why the launch failed.
      : createErrorResponse('DECLARED_CONNECTION_FAILED', { message: declaredConns.error });
  }

  // Validate startFrom before any side effects, so both modes reject immediately
  if (args.startFrom && args.startFrom > sequence.commands.length) {
    return createErrorResponse('INVALID_START_FROM', {
      message: `startFrom (${args.startFrom}) exceeds sequence length (${sequence.commands.length})`
    });
  }

  const deps: PerformRunDeps = {
    args, recorder, executeToolCall, getPageForConnection, getConnectionPort,
    sequence, analysis, connection, needsConnection,
    launchedConnections: new Set<string>(),
    ...(connectionMap && { connectionMap }),
    ...(runEnv && { runEnv }),
  };

  // Connections a strict run watches: the run's own, plus every browser the
  // sequence declared.
  const watchedRefs = [...new Set([
    ...(connection ? [connection] : []),
    ...(sequence.requiredConnections || []).map(d => connectionMap?.[sanitizeReference(d.connection)] ?? sanitizeReference(d.connection)),
  ])].filter(Boolean) as string[];
  // A sequence that declares the sockets its assertions ride on is checked
  // whether or not the caller asked - that is the point of declaring it.
  const requiredSockets = sequence.requiredSockets || [];
  const checkSockets = args.requireSockets === true || requiredSockets.length > 0;
  // Requiring a declared socket to EXIST only makes sense on the browsers this
  // sequence drives. A multi-browser sequence names its connections per step and
  // leaves the run's own connection idle - demanding a transport there fails a
  // healthy run for a browser that was never asked to do anything.
  //
  // "Drives" is read from the NAVIGATE steps, because a socket rides on a
  // loaded app: a connection that never navigated has no page for the
  // transport to belong to. Connection injection is the wrong reading: an
  // `assert` over a captured value takes a connection and loads nothing, and
  // counting it demands a socket on an idle browser.
  const stepRefs = analyzeRecordedStepConnections(commands);
  const navigatedRefs = navigatedConnections(commands, connection);
  const namedRefs = navigatedRefs.length > 0
    ? navigatedRefs.map(r => connectionMap?.[sanitizeReference(r)] ?? sanitizeReference(r))
    : stepRefs.references.length > 0 && !stepRefs.mixed
      ? stepRefs.references.map(r => connectionMap?.[sanitizeReference(r)] ?? sanitizeReference(r))
      : watchedRefs;
  // Absence is only checked on connections that are BOTH driven and watched, so
  // a driven ref nobody snapshots would quietly drop out of the check - the
  // declaration silently stops being enforced, which is the failure this whole
  // check exists to prevent. Widen the watch list instead of narrowing the
  // verdict.
  const unwatchedDriven = namedRefs.filter(r => !watchedRefs.includes(r));
  if (unwatchedDriven.length > 0) watchedRefs.push(...unwatchedDriven);
  const drivenRefs = namedRefs;
  const consoleBefore = args.strict ? await snapshotConsole(watchedRefs, executeToolCall) : {};
  const socketsBefore = checkSockets ? await snapshotSockets(watchedRefs, executeToolCall) : {};

  /**
   * Post-run health verdicts, applied to whichever response the caller will
   * read. Same rule as a sequence's own teardown: a paused run is not over, and
   * its browsers are the state someone stopped to look at.
   */
  const applyHealthChecks = async (response: any, outcome: string): Promise<boolean> => {
    if (outcome === 'paused') return true;
    let healthy = true;
    const fail = (heading: string, failures: string[]) => {
      if (failures.length === 0) return;
      healthy = false;
      if (response?.content?.[0]?.text === undefined) return;
      response.content[0].text += `\n\n${heading}\n${failures.map(f => `- ${f}`).join('\n')}`;
      response.isError = true;
      if (response._meta?.replay) response._meta.replay.success = false;
    };
    if (checkSockets) {
      // A declared socket missing at the last step may just be reconnecting, so
      // give it the same order of grace an in-page liveness assertion gets
      // rather than calling a recovering transport dead. Closures and frame
      // errors are settled facts - only absence is worth re-reading.
      let verdict = socketFailures(
        socketsBefore, await snapshotSockets(watchedRefs, executeToolCall), requiredSockets, drivenRefs
      );
      for (let attempt = 0; verdict.absent.length > 0 && attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        verdict = socketFailures(
          socketsBefore, await snapshotSockets(watchedRefs, executeToolCall), requiredSockets, drivenRefs
        );
      }
      fail(
        '**Socket health failed** - the transport did not stay up:',
        [...verdict.settled, ...verdict.absent]
      );
    }
    if (args.strict) {
      fail(
        '**Strict run failed** - the sequence produced console output:',
        strictConsoleFailures(
          consoleBefore,
          await snapshotConsole(watchedRefs, executeToolCall),
          args.strict === 'warnings'
        )
      );
    }
    return healthy;
  };

  // Closing the browsers the sequence declared, deferred so that every terminal
  // outcome uses one path: a pause hands the debt to `pendingDeclaredCleanups`
  // and whatever ends the pause pays it (issues #127, #137).
  const closeDeclared = () => closeLaunchedConnections(
    declaredConns.launched, executeToolCall, getConnectionPort, sequence.name
  );

  /**
   * Tear down the browsers this run owns: its own connection, plus any a step
   * CREATED. Runs AFTER the health verdicts, because both of them read the
   * browser: killing first leaves the verdict reading "could not read socket
   * health - Connection not found" as a socket FAILURE, an artefact of the
   * run's own cleanup.
   *
   * Ownership is not guessed from the sequence text: a launch step
   * hands back an existing browser when the reference is already bound, which
   * is the multi-device case where killing would destroy state the user cannot
   * get back. The launch response says which it was, and only the ones this run
   * created are killed (issue #103).
   *
   * The kill is by PORT, and other connections can share one - a launch
   * step usually opens a TAB in the same instance - so the port is checked for
   * other tenants first.
   */
  const killOwnedChrome = async (): Promise<string> => {
    if (!args.killChromeOnFinish) return '';
    let note = '';
    if (connection && getConnectionPort) {
      const port = await getConnectionPort(connection);
      const sharers = port === null ? [] : await connectionsSharingPort(executeToolCall, port, connection);
      if (sharers.length > 0) {
        note += `\n\n**Chrome left running** (port ${port} also serves ${sharers.join(', ')}, killChromeOnFinish)` +
          ` - killing it would take those connections with it.`;
      } else if (port !== null) {
        const killResult = await executeToolCall('browser', {
          action: 'kill',
          reason: `killChromeOnFinish: sequence "${sequence.name}" completed`,
          port,
        }).catch((error: any) => ({ isError: true, error }));
        note += killResult?.isError
          ? `\n\n**Chrome kill failed** (${connection}, port ${port}, killChromeOnFinish)`
          : `\n\n**Chrome killed** (${connection}, port ${port}, killChromeOnFinish)`;
      }
    }
    // The run-level connection is handled above; everything else here is a
    // browser a step of this run opened and nobody else asked for.
    const stepOwned = [...deps.launchedConnections].filter(ref => ref !== connection);
    note += await closeLaunchedConnections(
      stepOwned, executeToolCall, getConnectionPort, sequence.name, 'launched in a step'
    );
    return note;
  };

  /** Everything a terminal run owes: verdicts first, then teardown. */
  const settle = async (response: any, outcome: string): Promise<boolean> => {
    const healthy = await applyHealthChecks(response, outcome);
    if (outcome === 'paused') return healthy;
    const notes = (await killOwnedChrome()) + (await closeDeclared());
    if (notes && response?.content?.[0]?.text !== undefined) {
      response.content[0].text += notes;
    }
    return healthy;
  };

  // Registered whether or not the caller waits: a wait that runs out hands
  // back this handle, so the run can still be read and stopped.
  const runId = runRegistry.newRunId();
  const controller = new AbortController();
  const record: RunRecord = {
    runId,
    sequenceId: sequence.id,
    sequenceName: sequence.name,
    connection,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: commands.length,
    currentStep: 0,
    results: [],
    controller,
    ...(opts?.suite ? { suite: opts.suite } : {}),
  };
  runRegistry.register(record);

  // wait: true blocks the call on the run, driven by the MCP request signal. A
  // nested `replay run` STEP runs this way too (the executor sets wait: true),
  // so its caller keeps the result. An abort from the caller's own request
  // reaches the run it waits on.
  if (args.wait === true) abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });

  const finished = performRun(deps, controller.signal, runId, (ev) => {
    record.currentStep = ev.step;
    record.currentTool = ev.tool;
    (record.stepStarts ??= [])[ev.step - 1] ??= Date.now();
  }).then(async ({ response, outcome, results }) => {
    // A background run is read through its record, so the verdicts have to land
    // there too - otherwise the same sequence passes or fails on `wait` alone.
    const healthy = await settle(response, outcome).catch(() => true);
    if (outcome === 'paused') {
      pendingDeclaredCleanups.set(cleanupKey(runId, sequence.id), closeDeclared);
    }
    record.finalResponse = response;
    if (results) record.results = results;
    record.endedAt = Date.now();
    // Read from the health verdict, not parsed from the response: a run whose
    // transport died did not complete successfully.
    record.status = !healthy && outcome === 'completed' ? 'failed' : outcome;
    if (outcome !== 'paused') logRun(record);
  }).catch(async (error: any) => {
    // A run that blew up still launched what it launched.
    await closeDeclared().catch(() => '');
    record.error = error?.message || String(error);
    record.endedAt = Date.now();
    record.status = 'failed';
    logRun(record);
  });

  // A wait is bounded: a step that never finishes - a page held frozen, an
  // element that never appears - would otherwise hold the call, and the
  // caller with it, for as long as the run lasts. Past the bound the run goes
  // on, and the answer is its handle and where it stands.
  if (args.wait === true) {
    const bound = Math.min(WAIT_BOUND_MS, args.totalTimeout ?? WAIT_BOUND_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outran = await Promise.race([
      finished.then(() => false),
      new Promise<boolean>(done => { timer = setTimeout(() => done(true), bound); }),
    ]);
    clearTimeout(timer);
    // Answered in full within the bound: the caller holds the result, and a
    // handle nobody needs to read is not left in the list of runs.
    if (!outran) runRegistry.forget(runId);
    if (!outran && record.finalResponse) return record.finalResponse;
    if (!outran) {
      return createErrorResponse('REPLAY_RUN_ERRORED', { name: sequence.name, error: record.error ?? 'it ended without a result' });
    }
    const running = createSuccessResponse('REPLAY_RUN_STILL_RUNNING', {
      name: sequence.name, seconds: Math.round(bound / 1000), runId,
      currentStep: record.currentStep, totalSteps: commands.length, tool: record.currentTool ?? '',
    });
    running._meta = {
      tool: 'replay', action: 'run', timestamp: Date.now(),
      replay: { runId, background: true, totalSteps: commands.length },
    };
    return running;
  }

  const started = createSuccessResponse('REPLAY_RUN_STARTED', {
    runId,
    name: sequence.name,
    totalSteps: commands.length,
    connection: connection || 'none',
  });
  started._meta = {
    tool: 'replay', action: 'run', timestamp: Date.now(),
    replay: { runId, background: true, totalSteps: commands.length },
  };
  return started;
}

/**
 * Execute a run to completion: connection setup, cursor/overlay, step
 * execution, post-run cleanup (cursor/overlay/tab, debug state,
 * killChromeOnFinish). Everything after the fast validation in handleRun.
 *
 * Used by both modes: awaited directly for wait: true, spawned in the
 * background otherwise. The returned outcome is authoritative for the run
 * record's terminal status - never derived by parsing the response.
 */
export async function performRun(
  deps: PerformRunDeps,
  abortSignal?: AbortSignal,
  runId?: string,
  onProgress?: (ev: { step: number; totalSteps: number; tool: string }) => void
): Promise<{ response: any; outcome: RunOutcome; results?: any[] }> {
  const { args, recorder, executeToolCall, getPageForConnection,
    sequence, analysis, needsConnection, connectionMap,
    launchedConnections, runEnv } = deps;
  let connection = deps.connection;

  // Build execution context
  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connection: connection!,
    logPrefix: 'run',
    variableStore: {},
    launchedConnections,
    ...(connectionMap && { connectionMap }),
    // Carried on the context so nested sequences inherit the retarget; the
    // top-level sequence was already rebased in handleRun.
    ...(args.baseUrl && { rebaseOrigin: args.baseUrl }),
    // Same reason: a shared login helper a check runs is exactly
    // where a supplied credential has to land.
    ...(args.variables && { variables: args.variables }),
    // Held on the context rather than written into process.env: concurrent
    // background runs may name different files, and a global write would let
    // one run's credentials resolve inside the other.
    ...(runEnv && { runEnv })
  };

  // Ensure connection is ready
  let didAutoLaunch = false;
  const needsProxy = sequenceNeedsProxy(sequence);
  if (needsConnection && !analysis.createsBeforeUse) {
    const connResult = await ensureConnection(
      ctx, needsConnection, analysis.createsBeforeUse, needsProxy);
    if (!connResult.success) {
      return {
        outcome: 'failed',
        response: createErrorResponse('LAUNCH_FAILED', {
          message: connResult.error,
          suggestion: 'Launch Chrome manually first'
        })
      };
    }
    didAutoLaunch = connResult.didAutoLaunch;
  }

  // A live connection outside the proxy is played in a proxied window of its
  // own Chrome, opened for this run and closed when it ends; the connection
  // given stays as it was.
  let ownedWindow: string | undefined;
  let proxiedNote = '';
  if (needsProxy && needsConnection && !analysis.createsBeforeUse && connection
      && !getProxy(sanitizeReference(connection))) {
    const given = sanitizeReference(connection);
    const window = `${given}-${PROXIED_WORD}`;
    if (getProxy(window)) {
      proxiedNote = `\n\n**Proxied window:** played in "${window}", the proxied window already open beside "${given}", which runs outside the proxy.`;
    } else {
      const listed: any = await executeToolCall('connection', { action: 'list' }).catch(() => null);
      const port = listed?._meta?.connections?.find((row: any) => row.reference === given)?.port;
      try {
        await executeToolCall('connection', {
          action: 'launch', connection: window, newContextWindow: true, proxy: true,
          copyCookiesFrom: given, ...(port !== undefined && { port }),
        });
      } catch (launchError: any) {
        return {
          outcome: 'failed',
          response: createErrorResponse('LAUNCH_FAILED', {
            message: `"${sequence.name}" crosses the proxy and "${given}" runs outside it; opening a proxied window "${window}" in its Chrome failed: ${launchError?.response?.content?.[0]?.text || launchError?.message || launchError}`,
          }),
        };
      }
      ownedWindow = window;
      proxiedNote = `\n\n**Proxied window:** played in "${window}", opened in the Chrome of "${given}" because that connection runs outside the proxy, with its cookies; closed when the run ended.`;
    }
    connection = window;
    ctx.connection = window;
  }
  const closeOwnedWindow = async () => {
    if (!ownedWindow) return;
    const closing = ownedWindow;
    ownedWindow = undefined;
    await executeToolCall('connection', { action: 'close', connection: closing, reason: `sequence "${sequence.name}" opened it for its run` }).catch(() => {});
  };

  // Navigate to startUrl if needed
  const navResult = await navigateToStartUrl(ctx, sequence, analysis);
  if (!navResult.success) {
    // Close the tab if we auto-launched it
    if (didAutoLaunch && connection) {
      await executeToolCall('connection', { action: 'close', reason: `sequence "${sequence.name}" auto-launched it`, connection }).catch(() => {});
    }
    await closeOwnedWindow();
    return {
      outcome: 'failed',
      response: createErrorResponse('NAVIGATION_FAILED', {
        message: navResult.error,
        startUrl: sequence.startUrl
      })
    };
  }

  // Inject cursor if enabled in config
  let cursorPage: any = null;
  if (configManager.getReplayConfig().showCursor && connection) {
    cursorPage = await getPageForConnection(connection);
    if (cursorPage) {
      await injectReplayCursor(cursorPage);
      setReplayCursorCallbacks({
        onClickBefore: async (x: number, y: number, isRightClick: boolean) => {
          await showClickEffect(cursorPage, x, y, isRightClick);
        },
        onKeyPress: async (key: string) => {
          await showKeyPress(cursorPage, key);
        }
      });
    }
  }

  // Show replay overlay if requested (for issue verification)
  let cleanupReplayOverlay: (() => Promise<void>) | undefined;
  if (args.showReplayOverlay && args.issueId && args.issueType && connection) {
    const overlayPage = cursorPage || await getPageForConnection(connection);
    if (overlayPage) {
      cleanupReplayOverlay = await showReplayOverlay(
        overlayPage,
        args.issueType,
        args.issueTitle || 'Verifying issue...',
        args.issueId
      );
    }
  }

  // Helper to clean up cursor, overlay, and optionally close tab
  const cleanup = async (closeTab = false) => {
    // Removing the cursor and the overlay runs page JS, which a page held at a
    // breakpoint never answers, and the run's report would wait on it. Both
    // stay until the next run on a running page replaces them.
    const paused = !!(cursorPage || cleanupReplayOverlay) && !!(await checkIfPaused(ctx));
    if (cursorPage) {
      if (!paused) await removeReplayCursor(cursorPage).catch(() => {});
      setReplayCursorCallbacks({});
    }
    if (cleanupReplayOverlay && !paused) {
      await cleanupReplayOverlay().catch(() => {});
    }
    if (closeTab && didAutoLaunch && connection) {
      await executeToolCall('connection', { action: 'close', reason: `sequence "${sequence.name}" auto-launched it`, connection }).catch(() => {});
    }
    if (closeTab) await closeOwnedWindow();
  };

  // Calculate start step (convert 1-indexed to 0-indexed).
  // startFrom itself was validated in handleRun, before any side effects.
  const startStep = args.startFrom ? Math.max(0, args.startFrom - 1) : 0;

  // Register cleanup handler on abort signal BEFORE execution starts
  // This ensures cleanup runs even if the tool call is interrupted mid-execution
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => { cleanup(true); }, { once: true });
  }

  // Execute the sequence
  const execResult = await executeSequenceWithPause({
    sequence,
    startStep,
    ctx,
    variables: args.variables,
    record: args.record,
    stepTimeout: args.stepTimeout,
    totalTimeout: args.totalTimeout,
    stepTo: args.stepTo,
    overrideConnectionReason: args.connection,
    abortSignal,
    onProgress
  });

  // Handle abort - return early (cleanup already handled by abort signal listener)
  if (abortSignal?.aborted) {
    // results holds every step ATTEMPTED - failures and the abort marker
    // included - so its length is not a count of completed work, and a step
    // failing when the abort came is counted as failed.
    const succeeded = execResult.results.filter(r => r.success).length;
    const failed = execResult.results.filter(r => !r.success).length;
    const abortedResponse = createSuccessResponse('REPLAY_ABORTED', {
      name: sequence.name,
      completedSteps: succeeded,
      totalSteps: sequence.commands.length,
      failedSteps: failed > 0 ? failed : null,
      message: 'Replay aborted by user'
    });
    abortedResponse._meta = {
      tool: 'replay', action: 'run', timestamp: Date.now(),
      replay: { success: false, totalSteps: sequence.commands.length, failedSteps: failed, paused: false, cancelled: true }
    };
    return { response: abortedResponse, outcome: 'cancelled', results: execResult.results };
  }

  // Handle breakpoint hit
  if (execResult.breakpointHit && connection) {
    recorder.setActiveSequence({
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      currentStep: execResult.results.at(-1)?.step ?? 0,
      totalSteps: sequence.commands.length,
      pausedAt: Date.now(),
      historyIndexAtPause: recorder.getHistory().length,
      connection,
      runId,
      ...(connectionMap && { connectionMap }),
      breakpointHit: { url: execResult.breakpointHit.url, lineNumber: execResult.breakpointHit.lineNumber },
    });
    return { outcome: 'paused', results: execResult.results, response: { content: [{ type: 'text', text: formatBreakpointHit(
      sequence.name,
      execResult.results,
      execResult.totalCommands,
      execResult.durationMs,
      execResult.breakpointHit,
      connection
    ) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    } };
  }

  // Handle click validation failure (pause for inspection/retry)
  if (execResult.clickValidationFailure && connection) {
    // Set active sequence state so user can retry/continue
    const activeState: ActiveSequenceState = {
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      currentStep: execResult.pausedAtStep! - 1, // Back to failed step for retry
      totalSteps: sequence.commands.length,
      pausedAt: Date.now(),
      historyIndexAtPause: recorder.getHistory().length,
      connection,
      runId,
      // step/finish must resolve per-step connections the way this run did
      ...(connectionMap && { connectionMap }),
      ...(execResult.clickValidationFailure.repair && { repair: execResult.clickValidationFailure.repair }),
    };
    recorder.setActiveSequence(activeState);

    return { outcome: 'paused', results: execResult.results, response: { content: [{ type: 'text', text: formatClickValidationFailure(
      sequence,
      execResult.results,
      execResult.pausedAtStep!,
      execResult.durationMs,
      execResult.clickValidationFailure,
      connection
    ) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    } };
  }

  // Handle paused state (stepTo)
  if (execResult.pausedAtStep && execResult.activeSequenceState) {
    recorder.setActiveSequence({ ...execResult.activeSequenceState, runId });
    return { outcome: 'paused', results: execResult.results, response: { content: [{ type: 'text', text: formatPausedResponse(sequence, execResult.results, execResult.pausedAtStep, execResult.durationMs) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    } };
  }

  // Clean up cursor and overlay
  await cleanup();
  await closeOwnedWindow();

  // Format results
  let response = formatExecutionResults(
    sequence.name,
    execResult.results,
    execResult.totalCommands,
    execResult.durationMs,
    execResult.teardownResults
      ? { results: execResult.teardownResults, ...(execResult.teardownFailed !== undefined ? { failed: execResult.teardownFailed } : {}) }
      : undefined
  );
  response += proxiedNote;

  if (execResult.behaviourDrift?.length) {
    // Reported, never a verdict: what a step should do at the boundary is the
    // person's call, and a run that differs is as often a fixed bug as a broken
    // one.
    response += `\n\n**Boundary behaviour differs from the recording**`;
    for (const d of execResult.behaviourDrift) {
      const moved = (['requests', 'failed', 'opened', 'writes'] as const)
        .filter(f => d.recorded[f] !== d.observed[f])
        .map(f => `${f} ${d.recorded[f]} → ${d.observed[f]}`)
        .join(', ');
      const shapes = d.shapes
        ? [...new Set([...Object.keys(d.shapes.recorded), ...Object.keys(d.shapes.observed)])]
            .filter(k => (d.shapes!.recorded[k] ?? 0) !== (d.shapes!.observed[k] ?? 0))
            .map(k => `${k} ${d.shapes!.recorded[k] ?? 0} → ${d.shapes!.observed[k] ?? 0}`)
        : [];
      const parts = [moved, ...shapes].filter(Boolean).join(', ');
      response += `\n- step ${d.step} \`${d.label}\`: ${parts}`;
      // The hold times sit beside the difference rather than under it: a step
      // held far longer while recording collected traffic that arrives on the
      // app's own schedule, and that reads as drift before anything changed.
      if (d.window) {
        const secs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        response += ` (held ${secs(d.window.recorded)} recording, ${secs(d.window.observed)} replaying)`;
      }
    }
  }

  // Add debug state if successful
  const failed = execResult.results.filter(r => !r.success).length;
  if (connection && failed === 0) {
    const debugState = await getDebugState(ctx);
    if (debugState) {
      response += formatDebugState(debugState, connection);
    }
  }

  return {
    outcome: failed === 0 ? 'completed' : 'failed',
    results: execResult.results,
    response: { content: [{ type: 'text', text: response }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: failed === 0, totalSteps: execResult.totalCommands, failedSteps: failed, paused: false }
      }
    }
  };
}
