/**
 * A run after it starts: its status, cancelling it, stepping and finishing a
 * paused session, and its line in the run log when it ends.
 */
import type { ActiveSequenceState, CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { runRegistry, type RunRecord } from './replay-run-registry.js';
import { appendRun } from '../run-log.js';
import type { StepResult } from './replay-executor.js';
import type { StepCheck } from '../bench/wire.js';
import { executeSteps, type ExecutionContext } from './replay-executor.js';
import { formatExecutionResults, formatActiveStatus, formatStepResults, formatClickValidationFailure } from './replay-formatters.js';
import type { ExecutionResult } from './replay-types.js';
import { drainDeclaredCleanup } from './replay-run-owned.js';
import { type ReplayArgs } from './replay-schema.js';
import { release } from '../hold.js';

/**
 * How a check, assert or wait step read, from the run's own result: a check's
 * reading and the steps of any sequence it ran; an assert or wait held, or
 * failed and stopped the run.
 */
function checkReadingOf(result: StepResult): StepCheck | undefined {
  if (result.check) {
    const ran = result.sequenceName && result.substeps
      ? { name: result.sequenceName, steps: result.substeps.length, failed: result.substeps.filter(step => !step.success).length }
      : undefined;
    return {
      outcome: result.check.outcome, action: result.check.action, subject: result.check.subject,
      ...(result.check.found !== undefined ? { found: result.check.found } : {}),
      ...(result.check.waitedMs !== undefined ? { waitedMs: result.check.waitedMs } : {}),
      ...(result.check.limitMs !== undefined ? { limitMs: result.check.limitMs } : {}),
      ...(ran ? { ran } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
  if (result.tool !== 'assert' && result.tool !== 'wait') return undefined;
  return {
    outcome: result.success ? 'held' : 'failed',
    action: result.success ? 'continue' : 'stop',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** A run that ended, into the run log, with what each step did. A paused run is logged when it ends. */
export function logRun(record: RunRecord): void {
  const failed = record.results.find(result => !result.success);
  void (async () => {
    const bench = await import('../bench-mode.js');
    const readings: Array<StepCheck | undefined> = [];
    for (const result of record.results) readings[result.step - 1] = checkReadingOf(result);
    const steps = record.connection
      ? bench.stepTallies(record.connection, record.startedAt, record.endedAt ?? Date.now(), record.totalSteps, readings,
          bench.stepTimes(record.stepStarts ?? [], record.endedAt ?? Date.now()))
      : undefined;
    await appendRun({
      runId: record.runId,
      sequence: record.sequenceName,
      ...(record.connection ? { connection: record.connection } : {}),
      via: 'replay',
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? Date.now(),
      step: failed?.step ?? record.currentStep,
      total: record.totalSteps,
      ...(record.currentTool ? { tool: record.currentTool } : {}),
      ...(failed?.error || record.error ? { failure: failed?.error ?? record.error } : {}),
      ...(record.suite ? { suite: record.suite } : {}),
      ...(steps ? { steps } : {}),
    });
  })();
}

/** One line per known run, newest first, for the no-runId status overview. */
function formatRunsOverview(records: RunRecord[]): string {
  const lines = records.map(r => {
    const progress = r.status === 'running' || r.status === 'cancelling'
      ? ` - step ${r.currentStep}/${r.totalSteps}${r.currentTool ? ` (${r.currentTool})` : ''}`
      : ` - ${r.results.filter(s => s.success).length}/${r.totalSteps} steps ok`;
    return `- \`${r.runId}\` ${r.sequenceName}: **${r.status}**${progress}`;
  });
  return `**Runs** (details: \`replay({ action: 'status', runId: '...' })\`)\n${lines.join('\n')}`;
}

/** Full status for one run. For a settled run this includes the final result. */
function formatRunRecord(record: RunRecord): any {
  const elapsed = ((record.endedAt ?? Date.now()) - record.startedAt) / 1000;
  let text = `**Run \`${record.runId}\`** - ${record.sequenceName}: **${record.status}** (${elapsed.toFixed(1)}s)`;

  if (record.status === 'running' || record.status === 'cancelling') {
    text += record.currentStep > 0
      ? `\n\nExecuting step ${record.currentStep}/${record.totalSteps}${record.currentTool ? ` (${record.currentTool})` : ''}.`
      : `\n\nSetting up (connection/navigation), no step started yet.`;
    text += `\n\nPoll again with \`replay({ action: 'status', runId: '${record.runId}' })\``;
    if (record.status === 'running') {
      text += ` or stop it with \`replay({ action: 'cancel', runId: '${record.runId}' })\`.`;
    } else {
      text += `. Cancel was requested; steps that support cancellation stop promptly, others at the next step boundary.`;
    }
  } else if (record.finalResponse?.content?.[0]?.text) {
    text += `\n\n${record.finalResponse.content[0].text}`;
    if (record.status === 'paused') {
      text += `\n\nDrive the paused session with \`replay({ action: 'step' })\` / \`finish\`, or drop it with \`replay({ action: 'cancel', runId: '${record.runId}' })\`.`;
    }
  } else if (record.error) {
    text += `\n\nRun failed before producing a result: ${record.error}`;
  }

  return {
    content: [{ type: 'text', text }],
    _meta: {
      tool: 'replay', action: 'status', timestamp: Date.now(),
      replay: {
        runId: record.runId,
        runStatus: record.status,
        currentStep: record.currentStep,
        totalSteps: record.totalSteps,
        ...(record.finalResponse?._meta?.replay ?? {}),
      },
    },
  };
}

export async function handleStatus(args: ReplayArgs, recorder: CommandRecorder) {
  if (args.runId) {
    const record = runRegistry.get(args.runId);
    if (!record) {
      return createErrorResponse('REPLAY_RUN_NOT_FOUND', { runId: args.runId });
    }
    return formatRunRecord(record);
  }

  const activeSeq = recorder.getActiveSequence();
  const runs = runRegistry.list();

  let text: string;
  if (activeSeq) {
    text = formatActiveStatus(activeSeq, recorder.getCommandsSincePause());
  } else {
    text = '**No active sequence.** Use `replay({ action: \'run\', name: \'...\', stepTo: N })` to start a step-through session.';
  }
  if (runs.length > 0) {
    text += `\n\n${formatRunsOverview(runs)}`;
  }
  return { content: [{ type: 'text', text }] };
}

/**
 * End the registered run a paused session belongs to: its status, its end, and
 * its line in the run log, which a paused run gets only when it ends. A
 * `wait: true` pause registers no record, and nothing is done for it.
 */
function endPausedRun(runId: string | undefined, status: 'completed' | 'failed' | 'cancelled'): void {
  const record = runId ? runRegistry.get(runId) : undefined;
  if (!record || record.status !== 'paused') return;
  record.status = status;
  record.endedAt = Date.now();
  logRun(record);
}

/** Cancel one specific registered run, whatever state it is in. */
async function cancelRunRecord(record: RunRecord, recorder: CommandRecorder) {
  if (record.status === 'running' || record.status === 'cancelling') {
    record.status = 'cancelling';
    record.controller.abort();
    return createSuccessResponse('REPLAY_RUN_CANCELLING', {
      runId: record.runId,
      name: record.sequenceName,
    });
  }

  if (record.status === 'paused') {
    const activeSeq = recorder.getActiveSequence();
    if (activeSeq?.runId === record.runId) {
      recorder.setActiveSequence(null);
    }
    endPausedRun(record.runId, 'cancelled');
    // Cancelling ends the run, so it cleans up like any other terminal outcome.
    const closedNote = await drainDeclaredCleanup(record.runId, record.sequenceId);
    const response = createSuccessResponse('REPLAY_RUN_CANCELLED', {
      runId: record.runId,
      name: record.sequenceName,
    });
    if (closedNote) response.content[0].text += closedNote;
    return response;
  }

  return createSuccessResponse('REPLAY_RUN_ALREADY_FINISHED', {
    runId: record.runId,
    name: record.sequenceName,
    status: record.status,
  });
}

export async function handleCancel(args: ReplayArgs, recorder: CommandRecorder) {
  // Explicit runId wins: cancel exactly that run.
  if (args.runId) {
    const record = runRegistry.get(args.runId);
    if (!record) {
      return createErrorResponse('REPLAY_RUN_NOT_FOUND', { runId: args.runId });
    }
    return cancelRunRecord(record, recorder);
  }

  // No runId: a paused step-through session takes precedence (pre-0.7
  // behaviour - `cancel` always meant "drop the paused session").
  const activeSeq = recorder.getActiveSequence();
  if (activeSeq) {
    endPausedRun(activeSeq.runId, 'cancelled');
    const name = activeSeq.sequenceName;
    recorder.setActiveSequence(null);
    // Terminal: close what the paused run launched, whichever way it paused
    // (a `wait: true` pause registers no run record, hence the sequence key).
    const closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
    return { content: [{ type: 'text', text: `**Cancelled:** ${name}${closedNote}` }] };
  }

  // No paused session: fall through to background runs. Unambiguous only if
  // exactly one is still executing.
  const active = runRegistry.active();
  if (active.length === 1) {
    return cancelRunRecord(active[0], recorder);
  }
  if (active.length > 1) {
    return createErrorResponse('REPLAY_RUN_AMBIGUOUS', {
      count: active.length,
      runList: active.map(r => `\`${r.runId}\` (${r.sequenceName}, step ${r.currentStep}/${r.totalSteps})`).join(', '),
    });
  }

  return { content: [{ type: 'text', text: '**No active sequence to cancel.**' }] };
}

/**
 * Resume a page a breakpoint stopped the run at. The run's next step expects a
 * running page, and the code layer's release resumes it whichever surface
 * holds the pause, the logpoint limit's included.
 */
async function resumeBreakpointHold(activeSeq: ActiveSequenceState): Promise<void> {
  if (!activeSeq.breakpointHit) return;
  await release(activeSeq.connection, { layers: ['code'] });
  delete activeSeq.breakpointHit;
}

/**
 * A step that paused on its click - a click validation failure, or an input
 * refused for reaching another element - keeps the session standing on that
 * step, as a run that paused there does: the step can be repaired or run
 * again. Ended instead, a refusal reached through `step` could be repaired
 * nowhere.
 */
function holdAtClickPause(
  recorder: CommandRecorder,
  activeSeq: ActiveSequenceState,
  sequence: { name: string; commands: unknown[] } & Record<string, any>,
  execResult: ExecutionResult,
  action: 'step' | 'finish',
) {
  const failure = execResult.clickValidationFailure!;
  recorder.updateActiveSequenceStep(execResult.pausedAtStep! - 1);
  if (failure.repair) activeSeq.repair = failure.repair;
  else delete activeSeq.repair;
  return {
    content: [{ type: 'text', text: formatClickValidationFailure(
      sequence as any, execResult.results, execResult.pausedAtStep!, execResult.durationMs, failure, activeSeq.connection,
    ) }],
    _meta: {
      tool: 'replay', action, timestamp: Date.now(),
      replay: {
        success: false, paused: true, pausedAtStep: execResult.pausedAtStep,
        refused: failure.errors[0], ...(failure.repair ? { repair: failure.repair } : {}),
      },
    },
  };
}

export async function handleStep(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  /** Stops the step part-way. Without it a caller that gives up still waits
   *  out the step's own settle before the call returns. */
  abortSignal?: AbortSignal
) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence to step through. Use run with stepTo first.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    recorder.setActiveSequence(null);
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commands = sequence.commands;
  const stepCount = args.stepCount || 1;
  const startStep = activeSeq.currentStep;
  const endStep = Math.min(startStep + stepCount, commands.length);

  if (startStep >= commands.length) {
    recorder.setActiveSequence(null);
    endPausedRun(activeSeq.runId, 'completed');
    const closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
    return { content: [{ type: 'text', text: `**Sequence complete.** All ${commands.length} steps executed.${closedNote}` }] };
  }

  await resumeBreakpointHold(activeSeq);

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connection: activeSeq.connection,
    logPrefix: 'step',
    variableStore: activeSeq.capturedVariables ?? (activeSeq.capturedVariables = {}),
    runTimestamp: activeSeq.runTimestamp ?? (activeSeq.runTimestamp = Date.now()),
    // per-step connections resolve exactly as they did in the run that paused
    ...(activeSeq.connectionMap && { connectionMap: activeSeq.connectionMap })
  };

  const execResult = await executeSteps({
    sequence,
    startStep,
    endStep,
    ctx,
    ...(abortSignal ? { abortSignal } : {})
  });

  if (execResult.clickValidationFailure && !abortSignal?.aborted) {
    return holdAtClickPause(recorder, activeSeq, sequence, execResult, 'step');
  }

  const lastExecuted = execResult.results.length > 0 ? execResult.results[execResult.results.length - 1].step : startStep;
  const failed = execResult.results.some(r => !r.success);

  // Update active sequence state
  let closedNote = '';
  if (abortSignal?.aborted) {
    // Stopped part-way: not finished, not failed. The session stays open so a
    // later step or finish carries on rather than starting from the first
    // command, and it is moved to the last step that actually succeeded.
    //
    // Not left where it started: a call for several steps can abort on its
    // third, and an abort can also land after a step's own tool returned but
    // while the settle around it is still running. Both would otherwise take
    // work that had completed and do it again.
    //
    // Not `lastExecuted` either - that counts the aborted step, which is the
    // one whose input may never have reached the page.
    const lastDone = [...execResult.results].reverse().find(r => r.success)?.step;
    recorder.updateActiveSequenceStep(lastDone ?? startStep);
  } else if (!failed && execResult.breakpointHit && lastExecuted < commands.length) {
    recorder.updateActiveSequenceStep(lastExecuted);
    activeSeq.breakpointHit = { url: execResult.breakpointHit.url, lineNumber: execResult.breakpointHit.lineNumber };
    return { content: [{ type: 'text', text: formatStepResults(sequence.name, execResult.results, startStep, commands.length, failed)
      + `\n\n**Held at step ${lastExecuted}:** a breakpoint the sequence did not set stopped the page at \`${execResult.breakpointHit.url}:${execResult.breakpointHit.lineNumber}\`. \`replay({ action: 'step' })\` or \`finish\` resumes it and carries on.` }] };
  } else if (failed || lastExecuted >= commands.length) {
    recorder.setActiveSequence(null);
    endPausedRun(activeSeq.runId, failed ? 'failed' : 'completed');
    // Stepping off the end (or onto a failure) ends the run: same cleanup a
    // straight-through run gets.
    closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
  } else {
    recorder.updateActiveSequenceStep(lastExecuted);
  }

  return { content: [{ type: 'text', text: formatStepResults(sequence.name, execResult.results, startStep, commands.length, failed) + closedNote }] };
}

export async function handleFinish(
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall
) {
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence to finish. Use run with stepTo first.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    recorder.setActiveSequence(null);
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commands = sequence.commands;
  const startStep = activeSeq.currentStep;

  if (startStep >= commands.length) {
    recorder.setActiveSequence(null);
    endPausedRun(activeSeq.runId, 'completed');
    const alreadyDone = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
    return { content: [{ type: 'text', text: `**Sequence already complete.** All ${commands.length} steps executed.${alreadyDone}` }] };
  }

  await resumeBreakpointHold(activeSeq);

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connection: activeSeq.connection,
    logPrefix: 'finish',
    variableStore: activeSeq.capturedVariables ?? (activeSeq.capturedVariables = {}),
    runTimestamp: activeSeq.runTimestamp ?? (activeSeq.runTimestamp = Date.now()),
    ...(activeSeq.connectionMap && { connectionMap: activeSeq.connectionMap })
  };

  const execResult = await executeSteps({
    sequence,
    startStep,
    ctx
  });

  if (execResult.clickValidationFailure) {
    return holdAtClickPause(recorder, activeSeq, sequence, execResult, 'finish');
  }

  recorder.setActiveSequence(null);
  endPausedRun(activeSeq.runId, execResult.results.some(r => !r.success) ? 'failed' : 'completed');
  const closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);

  return { content: [{ type: 'text', text: formatExecutionResults(sequence.name, execResult.results, commands.length, execResult.durationMs) + closedNote }] };
}
