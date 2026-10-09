/**
 * Editing a sequence in place: inserting steps from history, adding a check
 * step, and setting what the sequence declares.
 */
import { renumberSteps } from '../sequence-activity.js';
import type { CommandRecorder, CommandSequence, RecordedCommand } from '../command-recorder.js';
import { createErrorResponse } from '../messages.js';
import { sanitizeReference, validateReference } from '../reference-validator.js';
import { normalizeProfileName } from '../chrome-launcher.js';
import { loadSequence, normalizeStepConnections } from './replay-executor.js';
import { formatInsertPrompt, formatInsertResult, formatCheckAdded, formatDeclarations } from './replay-formatters.js';
import { checkSchema, checkSpecOf, type CheckOutcome } from './check-tools.js';
import { subjectOf as subjectOfCheck } from './check-engine.js';
import { rehydrateStepConnections, formatConnectionNote } from './replay-library.js';
import { type ReplayArgs } from './replay-schema.js';
import { handleLoadSequenceError, normalizeTags, declaredProfileConflict } from './replay-validation.js';
import { addressedConnection, isLaunchStep } from './connection-steps.js';
import { describeFingerprint } from '../element-fingerprint.js';

/**
 * Put commands from the history into a named sequence after one of its steps,
 * with no run: the sequence is read from memory, or from its file, changed,
 * and written back, and everything it names by step number is renumbered.
 */
async function insertIntoNamed(args: ReplayArgs, recorder: CommandRecorder) {
  const sequence = recorder.listSequences().find(one => one.name === args.name)
    ?? await recorder.loadSequenceFromDisk(args.name!);
  if (!sequence) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', { message: `No sequence named "${args.name}"` });
  }
  const indices = args.insertIndices ?? [];
  const commandsToInsert = indices.length ? recorder.buildCommandsFromHistory(indices) : null;
  if (!commandsToInsert) {
    return createErrorResponse('CREATE_FAILED', {
      message: indices.length
        ? 'One or more insertIndices are not in the history; replay({ action: \'history\' }) lists them'
        : 'insertIndices names the history commands to put in; replay({ action: \'history\' }) lists them',
    });
  }
  const insertAfter = args.insertAfterStep!;
  const existingCommands = rehydrateStepConnections(sequence);
  // A sequence whose steps name no browser runs against whichever one the run
  // is given; a step brought in naming the browser it was tried in would pin
  // itself there and split the run across two.
  const unpinned = !existingCommands.some(command => addressedConnection(command) !== undefined);
  const brought = unpinned
    ? commandsToInsert.map(command => {
        if (addressedConnection(command) === undefined) return command;
        const { connection: _pinned, ...params } = command.params ?? {};
        return { ...command, params };
      })
    : commandsToInsert;
  if (insertAfter < 0 || insertAfter > existingCommands.length) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'insertAfterStep', value: String(insertAfter),
      message: `insertAfterStep must be between 0 (before the first step) and ${existingCommands.length} (after the last)`,
    });
  }
  const normalized = normalizeStepConnections([
    ...existingCommands.slice(0, insertAfter),
    ...brought,
    ...existingCommands.slice(insertAfter),
  ]);
  renumberSteps(sequence as any, (old) => (old >= insertAfter ? old + brought.length : old));
  (sequence as any).commands = normalized.commands;
  if (normalized.hoisted) (sequence as any).recordedConnection = normalized.hoisted;
  else delete (sequence as any).recordedConnection;
  const saved = await recorder.saveSequenceToDisk(sequence.id, false, true);
  const where = saved?.success ? `Written to ${saved.filepath}.` : `Not written to disk: ${saved?.error ?? 'the sequence is not loaded'}.`;
  return {
    content: [{
      type: 'text' as const,
      text: `**${sequence.name}:** ${brought.length} step${brought.length === 1 ? '' : 's'} put in after step ${insertAfter}, `
        + `${normalized.commands.length} in all. ${where}` + formatConnectionNote(normalized),
    }],
  };
}

export async function handleInsert(args: ReplayArgs, recorder: CommandRecorder) {
  // A step is added to a sequence by naming it and the step to follow; it
  // needs no run, and a run to a pause cannot reach a page the bench holds.
  if (args.name && args.insertAfterStep !== undefined && !recorder.getActiveSequence()) {
    return insertIntoNamed(args, recorder);
  }
  const activeSeq = recorder.getActiveSequence();
  if (!activeSeq) {
    return createErrorResponse('NO_ACTIVE_SEQUENCE', {
      message: 'No active sequence. Use run with stepTo first to pause a sequence.'
    });
  }

  const sequence = recorder.getSequence(activeSeq.sequenceId);
  if (!sequence) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `Sequence ${activeSeq.sequenceId} no longer exists`
    });
  }

  const commandsSincePause = recorder.getCommandsSincePause();

  // If no insertIndices provided, show available commands
  if (!args.insertIndices || args.insertIndices.length === 0) {
    return { content: [{ type: 'text', text: formatInsertPrompt(sequence.name, commandsSincePause, activeSeq.currentStep, activeSeq.totalSteps) }] };
  }

  // Check if history was viewed first (required before insert with indices)
  if (!recorder.wasHistoryViewed()) {
    return {
      content: [{
        type: 'text',
        text: '**Run `replay({ action: \'history\' })` first** to see available commands and their indices before inserting.'
      }],
      isError: true
    };
  }

  // Validate indices
  const validIndices = args.insertIndices.filter(idx =>
    commandsSincePause.some(cmd => cmd.index === idx)
  );

  if (validIndices.length === 0) {
    let errorMsg = 'None of the provided indices are valid commands recorded since pause.\n\n';
    errorMsg += '**Run `replay({ action: \'history\' })` again** to see available commands and their indices.\n\n';
    if (commandsSincePause.length > 0) {
      errorMsg += `Valid indices since pause: ${commandsSincePause.map(c => c.index).join(', ')}`;
    } else {
      errorMsg += 'No commands have been recorded since the sequence was paused.';
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true };
  }

  // Get commands to insert, templatizing any literal that matches an earlier
  // inserted step's saveAs capture (same rewrite `create` does).
  const commandsToInsert = recorder.buildCommandsFromHistory(validIndices);
  if (!commandsToInsert) {
    return createErrorResponse('CREATE_FAILED', { message: 'One or more insertIndices no longer exist in history' });
  }

  // Determine insert position
  const insertAfter = args.insertAfterStep !== undefined ? args.insertAfterStep : activeSeq.currentStep;

  // Build new commands array. Inserted history commands carry the connection they
  // were driven against (bug-018), so re-run the create-time normalization: an
  // insert into a single-connection sequence must not quietly pin those steps to
  // this session's reference and make the sequence unportable.
  // The sequence's own steps are bare because `create` hoisted their connection
  // off; re-stamp it first. Merged without it, every insert reads as
  // "ambiguous" (one named reference + bare steps), which blocks the hoist and
  // leaves the sequence half-pinned to this session's reference - unportable,
  // and green on a run that splits it across two browsers.
  const existingCommands = rehydrateStepConnections(sequence);
  const normalized = normalizeStepConnections([
    ...existingCommands.slice(0, insertAfter),
    ...commandsToInsert,
    ...existingCommands.slice(insertAfter)
  ]);
  const newCommands = normalized.commands;
  const connectionNote = formatConnectionNote(normalized);

  if (args.overwrite) {
    // Update existing sequence in place. The inserted steps push every step
    // from `insertAfter` on down by their count, and what names those steps
    // by number moves with them.
    renumberSteps(sequence as any, (old) => (old >= insertAfter ? old + commandsToInsert.length : old));
    (sequence as any).commands = newCommands;
    if (normalized.hoisted) (sequence as any).recordedConnection = normalized.hoisted;
    else delete (sequence as any).recordedConnection;

    return { content: [{ type: 'text', text: formatInsertResult(sequence.name, sequence.id, commandsToInsert.length, insertAfter, newCommands.length, true) + connectionNote }] };
  } else {
    // Create new sequence
    const newName = args.newName || `${sequence.name}-modified`;
    const newSequence = await recorder.createSequence(
      newName,
      [],
      { description: sequence.description, expectedOutcome: sequence.expectedOutcome, startUrl: sequence.startUrl }
    );

    if (!newSequence) {
      return createErrorResponse('CREATE_FAILED', { message: 'Failed to create new sequence' });
    }

    const { id: _id, name: _name, createdAt: _createdAt, commands: _commands, ...fields } = JSON.parse(JSON.stringify(sequence));
    renumberSteps(fields, (old) => (old >= insertAfter ? old + commandsToInsert.length : old));
    Object.assign(newSequence, fields);
    (newSequence as any).commands = newCommands;
    if (normalized.hoisted) (newSequence as any).recordedConnection = normalized.hoisted;
    else delete (newSequence as any).recordedConnection;

    return { content: [{ type: 'text', text: formatInsertResult(newName, newSequence.id, commandsToInsert.length, insertAfter, newCommands.length, false) + connectionNote }] };
  }
}

/**
 * Add a `check` step to a sequence.
 *
 * A check from history comes in through `create` or `insert` as a recorded
 * assert or wait. This writes one from its parameters directly, which is the
 * only way to write one that runs another sequence.
 */
export async function handleAddCheck(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.check) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'addCheck',
      missing: 'check',
      message: 'The "addCheck" action requires a "check" parameter: the check step\'s parameters, e.g. { selector: ".cookie-banner", condition: "present", holds: { run: "dismiss-cookies" }, fails: "continue" }'
    });
  }
  // The step's parameters are the check tool's, so the tool's own schema
  // refuses what a run would refuse, while the sequence is being written.
  const parsed = checkSchema.safeParse(args.check);
  if (!parsed.success) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'check',
      value: JSON.stringify(args.check),
      message: parsed.error.issues.map((issue: { path: (string | number)[]; message: string }) => `${issue.path.join('.') || 'check'}: ${issue.message}`).join('; ')
    });
  }
  const check = parsed.data;

  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'addCheck');
  }
  const sequence = loadResult.sequence;
  const commands = sequence.commands;
  const insertAfter = args.insertAfterStep !== undefined ? args.insertAfterStep : commands.length;
  if (insertAfter < 0 || insertAfter > commands.length) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'insertAfterStep',
      value: String(insertAfter),
      message: `insertAfterStep must be between 0 (before the first step) and ${commands.length} (after the last). Omit it to append.`
    });
  }

  const onDisk = await recorder.listSavedSequencesOnDisk();
  // Stored against the list this step goes into, so a resume point still
  // names the same step once every later one has shifted by one.
  const outcomes: Partial<Record<'holds' | 'fails', CheckOutcome>> = {};
  for (const answer of ['holds', 'fails'] as const) {
    const outcome = check[answer];
    if (outcome === undefined || typeof outcome === 'string') {
      if (outcome !== undefined) outcomes[answer] = outcome;
      continue;
    }
    // Self-reference recurses until the depth cap truncates it.
    if (outcome.run === sequence.name) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: `check.${answer}.run`,
        value: outcome.run,
        message: `A check cannot run its own sequence ("${sequence.name}") - that recurses until maxConditionalDepth stops it.`
      });
    }
    // The target resolves by name at run time, so an unchecked typo fails
    // halfway through a run.
    const inMemory = recorder.listSequences().some(one => one.name === outcome.run);
    if (!inMemory && !onDisk.some(one => one.name === outcome.run)) {
      // A disk sequence is in memory once loaded, so the lists overlap.
      const available = [...new Set([...recorder.listSequences().map(one => one.name), ...onDisk.map(one => one.name)])];
      return createErrorResponse('SEQUENCE_NOT_FOUND', {
        message: `No sequence named "${outcome.run}" to run on ${answer}. Available: ${available.join(', ') || 'none'}`
      });
    }
    if (outcome.resumeAt !== undefined) {
      const resumeAt = outcome.resumeAt >= insertAfter ? outcome.resumeAt + 1 : outcome.resumeAt;
      // Checked here as well as at run time: a resume point that cannot hold
      // is worth refusing while the sequence is written, not halfway through a run.
      // The run accepts a resume point up to the end of the list, which ends it.
      if (resumeAt <= insertAfter || resumeAt > commands.length + 1) {
        return createErrorResponse('INVALID_PARAMETER', {
          parameter: `check.${answer}.resumeAt`,
          value: String(outcome.resumeAt),
          message: `resumeAt counts from 0 in the sequence as it stands: a check inserted after step `
            + `${insertAfter} can resume at ${insertAfter} to ${commands.length}, and ${commands.length} ends the run. `
            + `Resuming at or before the check runs it again forever.`
        });
      }
      outcomes[answer] = { ...outcome, resumeAt };
    } else {
      outcomes[answer] = outcome;
    }
  }

  const step: RecordedCommand = {
    tool: 'check',
    params: { ...check, ...outcomes },
    ...(args.comment ? { comment: args.comment } : {})
  };

  renumberSteps(sequence as any, (old) => (old >= insertAfter ? old + 1 : old));
  (sequence as any).commands = [
    ...commands.slice(0, insertAfter),
    step,
    ...commands.slice(insertAfter)
  ];

  // Write back to the file this came from; a memory-only sequence waits for
  // `export`, which is where it gets its filename.
  let persisted: string | undefined;
  const existingFile = onDisk.find(one => one.name === sequence.name);
  if (existingFile) {
    const saved = await recorder.saveSequenceToDisk(sequence.id, existingFile.location === 'global', true);
    // The step is in the sequence in memory either way; a file that did not
    // take it is an error to report, not a sequence that was never saved.
    if (saved && !saved.success) {
      return {
        content: [{ type: 'text', text: `## Error\n\nThe check was added to "${sequence.name}" in memory, but writing the file failed: ${saved.error}` }],
        isError: true,
      };
    }
    if (saved?.success) persisted = saved.filepath;
  }

  return {
    content: [{
      type: 'text',
      text: formatCheckAdded({
        sequenceName: sequence.name,
        subject: subjectOfCheck(checkSpecOf(check)),
        holds: outcomes.holds,
        fails: outcomes.fails,
        position: insertAfter,
        totalSteps: sequence.commands.length,
        persistedTo: persisted
      })
    }]
  };
}

/** The sequence to cut and the step to cut it after, or the refusal for either. */
async function sequenceToCut(args: ReplayArgs, recorder: CommandRecorder, action: string) {
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) return { refused: handleLoadSequenceError(loadResult, action) };
  const sequence = loadResult.sequence;
  const through = args.throughStep;
  if (through === undefined || !Number.isInteger(through) || through < 1 || through >= sequence.commands.length) {
    return { refused: createErrorResponse('INVALID_PARAMETER', {
      parameter: 'throughStep',
      value: String(through),
      message: `throughStep is the last step taken, from 1 to ${sequence.commands.length - 1}: "${sequence.name}" has ${sequence.commands.length} steps, and a cut after the last takes the whole sequence.`,
    }) };
  }
  return { sequence, through };
}

/** Whether a sequence of this name already exists, in memory or on disk. */
async function nameTaken(recorder: CommandRecorder, name: string): Promise<boolean> {
  if (recorder.listSequences().some(one => one.name === name)) return true;
  return (await recorder.listSavedSequencesOnDisk()).some(one => one.name === name);
}

/** Writes a sequence to the same root as `beside`, where `beside` is on disk; undefined leaves it in memory. */
async function saveBeside(recorder: CommandRecorder, sequenceId: string, beside: string): Promise<string | { error: string } | undefined> {
  const besideFile = (await recorder.listSavedSequencesOnDisk()).find(one => one.name === beside);
  if (!besideFile) return undefined;
  const saved = await recorder.saveSequenceToDisk(sequenceId, besideFile.location === 'global', true);
  if (!saved) return { error: 'the sequence was not in memory to write' };
  return saved.success ? saved.filepath : { error: saved.error };
}

/** The declarations a sequence carries beside its steps, which a sequence built from it takes too. */
function declarationsOf(sequence: CommandSequence): Partial<CommandSequence> {
  const source = sequence as any;
  const kept: Record<string, unknown> = {};
  for (const key of ['requiredConnections', 'requiredSockets', 'proxy', 'tags', 'recordedConnection', 'shapeRules', 'boundaryRefuse']) {
    if (source[key] !== undefined) kept[key] = JSON.parse(JSON.stringify(source[key]));
  }
  return kept as Partial<CommandSequence>;
}

/** The step-indexed fields of `sequence`, cloned and renumbered by `map`. */
function stepFieldsOf(sequence: CommandSequence, map: (old: number) => number | undefined): Partial<CommandSequence> {
  const source = sequence as any;
  const fields: any = {};
  for (const key of ['boundaryRulesOn', 'boundaryNames', 'boundaryPlacements']) {
    if (source[key] !== undefined) fields[key] = JSON.parse(JSON.stringify(source[key]));
  }
  renumberSteps(fields, map);
  return fields;
}

/** The 1-based steps up to `through` that the recording holds no boundary evidence for. */
function unmeasuredWithin(sequence: CommandSequence, through: number): number[] {
  return ((sequence as any).shapesUnmeasured as number[] | undefined ?? []).filter(step => step <= through);
}

/** A step that confirms the page's state before the next one acts. */
function confirmsState(step: RecordedCommand | undefined): boolean {
  return step?.tool === 'check' || step?.tool === 'wait' || step?.tool === 'assert';
}

/**
 * A new sequence owning a copy of steps 1 to `throughStep`, with their stored
 * traffic and fingerprints, and the declarations of the one copied. It stands
 * on its own afterwards: an edit to either reaches only that one. Teardown is
 * not copied: it cleans up after the whole of the original's flow.
 */
export async function handleCopy(args: ReplayArgs, recorder: CommandRecorder) {
  const cut = await sequenceToCut(args, recorder, 'copy');
  if ('refused' in cut) return cut.refused;
  const { sequence, through } = cut;
  if (!args.newName) {
    return createErrorResponse('MISSING_PARAMETER', { action: 'copy', missing: 'newName', message: 'The "copy" action needs "newName", the name of the new sequence.' });
  }
  if (!args.overwrite && await nameTaken(recorder, args.newName)) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'newName', value: args.newName, message: `A sequence named "${args.newName}" exists. Pass overwrite: true to replace it, or choose another name.`,
    });
  }

  const steps: RecordedCommand[] = JSON.parse(JSON.stringify(sequence.commands.slice(0, through)));
  const copy = await recorder.createSequenceFromCommands(args.newName, steps, {
    description: `Steps 1-${through} of ${sequence.name}`,
    startUrl: sequence.startUrl,
  });
  Object.assign(copy, declarationsOf(sequence), stepFieldsOf(sequence, old => (old < through ? old : undefined)));
  const unmeasured = unmeasuredWithin(sequence, through);
  if (unmeasured.length) (copy as any).shapesUnmeasured = unmeasured;

  const written = await saveBeside(recorder, copy.id, sequence.name);
  if (typeof written === 'object') {
    return { content: [{ type: 'text', text: `## Error\n\n"${copy.name}" was made in memory, but writing the file failed: ${written.error}` }], isError: true };
  }
  return {
    content: [{
      type: 'text',
      text: `**Copied** steps 1-${through} of "${sequence.name}" into "${copy.name}" (${steps.length} steps).\n`
        + (written ? `Written to \`${written}\`.\n` : `In memory; \`export\` writes it to a file.\n`)
        + (sequence.teardown?.length ? `Its ${sequence.teardown.length} teardown step(s) are not copied: they clean up after the whole of "${sequence.name}", and steps it no longer runs.\n` : '')
        + `\nThe two stand apart: an edit to one reaches only that one. Continue it from where step ${through} leaves the page, then \`insert\` the new steps into "${copy.name}".`,
    }],
  };
}

/**
 * The refusal for a cut whose first `through` steps cannot run inside another
 * sequence, or undefined. A launch inside a nested sequence is skipped where
 * its browser exists and run where it does not, which splits the run across
 * two browsers; a check resuming past the cut would resume past the nested
 * sequence's end.
 */
function refuseCut(sequence: CommandSequence, through: number) {
  const launchAt = sequence.commands.slice(0, through).findIndex(isLaunchStep);
  if (launchAt >= 0) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'throughStep', value: String(through),
      message: launchAt === 0
        ? `Step 1 launches a browser. Inside a shared sequence it is skipped where that browser exists and run where it does not, which splits the run across two browsers, and every cut takes step 1.`
        : `Step ${launchAt + 1} launches a browser. Inside a shared sequence it is skipped where that browser exists and run where it does not, which splits the run across two browsers. throughStep ${launchAt} or less leaves it in the caller.`,
    });
  }
  const leaping = sequence.commands.slice(0, through).findIndex(step => step.tool === 'check'
    && (['holds', 'fails'] as const).some(answer => typeof step.params?.[answer]?.resumeAt === 'number' && step.params[answer].resumeAt >= through));
  if (leaping >= 0) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'throughStep', value: String(through),
      message: `Step ${leaping + 1} is a check that resumes past step ${through}. Inside the shared sequence it would resume past that sequence's end. Cut at or after the step it resumes at.`,
    });
  }
  return undefined;
}

/** A check that always holds and runs `sharedName`: the nesting that shares the caller's variables, connection and time budget. */
function runOf(sharedName: string, through: number): RecordedCommand {
  return { tool: 'check', params: { afterMs: 0, holds: { run: sharedName } }, comment: `steps 1-${through}, shared as ${sharedName}` };
}

/**
 * Replace steps 1 to `through` of `sequence` with a run of `sharedName`, and
 * move what names its steps by number with them. Returns the `variables` keys
 * whose step numbers moved, the captures of the shared steps the tail reads,
 * and how many steps the tail holds.
 */
function replacePathWithRun(sequence: CommandSequence, through: number, sharedName: string, captureNames: string[]) {
  const tail = sequence.commands.slice(through);
  const keyOf = (index: number, step: RecordedCommand) =>
    `var_${index}_${step.params?.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
  const movedKeys = tail
    .map((step, at) => ({ step, from: through + at, to: 1 + at }))
    .filter(({ step }) => step.tool === 'input' && step.params?.action === 'type')
    .map(({ step, from, to }) => `\`${keyOf(from, step)}\` → \`${keyOf(to, step)}\``);
  const read = captureNames.filter(name => JSON.stringify(tail).includes(`{{var:${name}`));

  renumberSteps(sequence as any, old => (old < through ? undefined : old - through + 1));
  (sequence as any).commands = [runOf(sharedName, through), ...tail];
  const tailUnmeasured = ((sequence as any).shapesUnmeasured as number[] | undefined ?? [])
    .filter(step => step > through).map(step => step - through + 1);
  if (tailUnmeasured.length) (sequence as any).shapesUnmeasured = tailUnmeasured;
  else delete (sequence as any).shapesUnmeasured;
  return { movedKeys, read, tailLength: tail.length };
}

/** What a step does, as compared between two sequences: its tool and params, without the browser it ran in. */
function stepIdentity(step: RecordedCommand): string {
  const { connection: _connection, expect: _expect, ...params } = step.params ?? {};
  return JSON.stringify({ tool: step.tool, params });
}

/**
 * Steps with each step that always runs another sequence - a check reading
 * only time, whose pass runs it - replaced by that sequence's own steps. A
 * caller whose step runs an older copy of a path then compares as the path it
 * runs, rather than as one check step against the path's first. A check that
 * reads anything else may not run its sequence, and stays as it is.
 */
async function unfoldRuns(commands: RecordedCommand[], recorder: CommandRecorder, depth = 0): Promise<RecordedCommand[]> {
  const unfolded: RecordedCommand[] = [];
  for (const command of commands) {
    const params = command.params ?? {};
    const runs = command.tool === 'check' && typeof params.holds === 'object' && params.holds?.run
      && Object.keys(params).every(key => ['afterMs', 'holds', 'fails', 'connection'].includes(key))
      ? String(params.holds.run) : undefined;
    const loaded = runs && depth < 5 ? await loadSequence({ name: runs }, recorder) : undefined;
    if (loaded?.success) unfolded.push(...await unfoldRuns(loaded.sequence.commands, recorder, depth + 1));
    else unfolded.push(command);
  }
  return unfolded;
}

/**
 * Steps 1 to `throughStep` of a sequence replaced with a run of an existing
 * shared sequence: the sequence that carried its own copy of a path takes the
 * shared one, and later edits to the path reach it.
 *
 * The replaced steps are compared with the shared sequence's first steps
 * first. Where they differ - the shared path was edited since, or it is
 * another path - the reply names the first difference and nothing is
 * written; `overwrite: true` replaces them regardless.
 */
export async function handleAdopt(args: ReplayArgs, recorder: CommandRecorder) {
  const cut = await sequenceToCut(args, recorder, 'adopt');
  if ('refused' in cut) return cut.refused;
  const { sequence, through } = cut;
  if (!args.sharedName) {
    return createErrorResponse('MISSING_PARAMETER', { action: 'adopt', missing: 'sharedName', message: 'The "adopt" action needs "sharedName", the shared sequence that replaces steps 1 to throughStep.' });
  }
  if (args.sharedName === sequence.name) {
    return createErrorResponse('INVALID_PARAMETER', { parameter: 'sharedName', value: args.sharedName, message: 'A sequence cannot run itself in place of its own steps.' });
  }
  const sharedLoad = await loadSequence({ name: args.sharedName }, recorder);
  if (!sharedLoad.success) return handleLoadSequenceError(sharedLoad, 'adopt');
  const shared = sharedLoad.sequence;
  const refusal = refuseCut(sequence, through);
  if (refusal) return refusal;

  const own = await unfoldRuns(sequence.commands.slice(0, through), recorder);
  const theirs = await unfoldRuns(shared.commands, recorder);
  const differsAt = Array.from({ length: Math.max(own.length, theirs.length) }, (_, i) => i)
    .find(i => !own[i] || !theirs[i] || stepIdentity(own[i]) !== stepIdentity(theirs[i]));
  if (differsAt !== undefined && !args.overwrite) {
    const describe = (step: RecordedCommand | undefined) => step
      ? `${step.tool}${step.params?.action ? ` ${step.params.action}` : ''}${step.params?.selector ? ` \`${step.params.selector}\`` : ''}`
      : 'nothing';
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'sharedName', value: args.sharedName,
      message: `Steps 1-${through} of "${sequence.name}" differ from "${shared.name}" at step ${differsAt + 1}: `
        + `"${sequence.name}" has ${describe(own[differsAt])}, "${shared.name}" has ${describe(theirs[differsAt])}. `
        + `Nothing was written. Where "${shared.name}" holds the path as it now is, overwrite: true replaces steps 1-${through} with it.`,
    });
  }

  const captureNames = theirs.map(step => step.params?.saveAs).filter((name): name is string => typeof name === 'string');
  const { movedKeys, read, tailLength } = replacePathWithRun(sequence, through, shared.name, captureNames);
  const written = await saveBeside(recorder, sequence.id, sequence.name);
  if (typeof written === 'object') {
    return { content: [{ type: 'text', text: `## Error\n\n"${sequence.name}" now runs "${shared.name}" in memory, but writing the file failed: ${written.error}` }], isError: true };
  }

  const lines = [
    `**Adopted** "${shared.name}" in place of steps 1-${through} of "${sequence.name}".`,
    `- "${sequence.name}": runs "${shared.name}", then its old steps ${through + 1}-${through + tailLength} (${1 + tailLength} steps)`,
    ...(differsAt !== undefined ? [`- Its own steps differed from "${shared.name}" at step ${differsAt + 1}, and were replaced as overwrite asked`] : []),
    `- An edit to the path goes to "${shared.name}" and reaches "${sequence.name}" too`,
    ...(movedKeys.length ? [`- \`variables\` keys for "${sequence.name}" moved: ${movedKeys.join(', ')}`] : []),
    ...(read.length ? [`- The tail reads ${read.map(n => `\`{{var:${n}}}\``).join(', ')} from "${shared.name}": renaming that capture there breaks every caller`] : []),
    `- Written: ${written ? `\`${written}\`` : `"${sequence.name}" in memory`}`,
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * Steps 1 to `throughStep` moved into a shared sequence, which the original
 * then runs in their place, and so does `newName` where given. An edit to the
 * path goes to the shared sequence and reaches every caller; an edit to a
 * tail reaches that caller alone.
 *
 * The run step is a check that always holds and runs the shared sequence, the
 * one nesting that shares the caller's variables, connection and time budget.
 * Teardown and declarations stay on the callers: a nested sequence's
 * teardown runs between it and the caller's tail, and its declarations are
 * never launched. A launch step inside the cut is refused: inside a nested
 * sequence it is skipped where its browser exists and run where it does not,
 * which splits the run across two browsers.
 */
export async function handleSplit(args: ReplayArgs, recorder: CommandRecorder) {
  const cut = await sequenceToCut(args, recorder, 'split');
  if ('refused' in cut) return cut.refused;
  const { sequence, through } = cut;
  if (!args.sharedName) {
    return createErrorResponse('MISSING_PARAMETER', { action: 'split', missing: 'sharedName', message: 'The "split" action needs "sharedName", the name of the shared sequence steps 1 to throughStep move into.' });
  }
  for (const name of [args.sharedName, args.newName].filter((n): n is string => Boolean(n))) {
    if (await nameTaken(recorder, name)) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: name === args.sharedName ? 'sharedName' : 'newName',
        value: name,
        message: `A sequence named "${name}" exists.${name === args.sharedName ? ` Where it already holds this path, adopt it in place of steps 1-${through}: replay({ action: 'adopt', name: '${sequence.name}', throughStep: ${through}, sharedName: '${name}' }).` : ''}`,
      });
    }
  }
  const refusal = refuseCut(sequence, through);
  if (refusal) return refusal;

  const sharedSteps: RecordedCommand[] = JSON.parse(JSON.stringify(sequence.commands.slice(0, through)));
  const shared = await recorder.createSequenceFromCommands(args.sharedName, sharedSteps, {
    description: `Steps 1-${through} of ${sequence.name}, run by each sequence that walks this path`,
    startUrl: sequence.startUrl,
  });
  Object.assign(shared, declarationsOf(sequence), stepFieldsOf(sequence, old => (old < through ? old : undefined)));
  for (const key of ['requiredConnections', 'requiredSockets', 'tags']) delete (shared as any)[key];
  const sharedUnmeasured = unmeasuredWithin(sequence, through);
  if (sharedUnmeasured.length) (shared as any).shapesUnmeasured = sharedUnmeasured;

  const captureNames = sharedSteps.map(step => step.params?.saveAs).filter((name): name is string => typeof name === 'string');
  const { movedKeys, read, tailLength } = replacePathWithRun(sequence, through, args.sharedName, captureNames);

  let caller: CommandSequence | undefined;
  if (args.newName) {
    caller = await recorder.createSequenceFromCommands(args.newName, [runOf(args.sharedName, through)], { startUrl: sequence.startUrl });
    Object.assign(caller, declarationsOf(sequence));
  }

  const failures: string[] = [];
  const places: string[] = [];
  for (const one of [shared, sequence, caller].filter((s): s is CommandSequence => Boolean(s))) {
    const written = await saveBeside(recorder, one.id, sequence.name);
    if (typeof written === 'object') failures.push(`"${one.name}": ${written.error}`);
    else places.push(written ? `\`${written}\`` : `"${one.name}" in memory`);
  }

  const lines = [
    `**Split** steps 1-${through} of "${sequence.name}" into "${shared.name}".`,
    `- "${sequence.name}": runs "${shared.name}", then its old steps ${through + 1}-${through + tailLength} (${1 + tailLength} steps)`,
    ...(caller ? [`- "${caller.name}": runs "${shared.name}"; continue it from where step ${through} leaves the page, then \`insert\` the new steps`] : []),
    `- An edit to the path goes to "${shared.name}" and reaches every caller; an edit to a tail reaches that caller alone`,
    ...(confirmsState(sharedSteps[through - 1]) ? [] : [`- **Step ${through} is ${sharedSteps[through - 1].tool}${sharedSteps[through - 1].params?.action ? ` ${sharedSteps[through - 1].params.action}` : ''}, not a check or wait:** "${shared.name}" ends without confirming the state its callers start from, so a caller's next step can act before it settles. \`addCheck\` with \`name: '${shared.name}'\` appends one`]),
    ...(movedKeys.length ? [`- \`variables\` keys for "${sequence.name}" moved: ${movedKeys.join(', ')}`] : []),
    ...(read.length ? [`- The tail reads ${read.map(n => `\`{{var:${n}}}\``).join(', ')} from "${shared.name}": renaming that capture there breaks every caller`] : []),
    `- Written: ${places.join(', ')}`,
    ...(failures.length ? [`\n**Not written:** ${failures.join('; ')}`] : []),
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }], ...(failures.length ? { isError: true } : {}) };
}

/**
 * Repair the step a run paused on after it clicked another element than the
 * one recorded.
 *
 * `selector` points the step at where the recorded element is now, which the
 * pause found by its fingerprint: the element moved. `element` keeps the
 * selector and records the element it hit as the step's fingerprint: the
 * element changed on purpose. The sequence file is rewritten, and `step` runs
 * the repaired step again.
 */
export async function handleRepair(args: ReplayArgs, recorder: CommandRecorder) {
  const paused = recorder.getActiveSequence();
  const repair = paused?.repair;
  if (!paused || !repair) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'action',
      value: 'repair',
      message: 'No paused run is waiting on a repair: repair applies to a run paused on a click that hit another element than the one recorded.',
    });
  }
  if (args.accept !== 'selector' && args.accept !== 'element') {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repair',
      missing: 'accept',
      message: `"accept" is 'selector' (the element moved${repair.selector ? `, to \`${repair.selector}\`` : ''}) or 'element' (it changed on purpose: keep the selector, record what it hit).`,
    });
  }
  if (args.accept === 'selector' && !repair.selector) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'accept',
      value: 'selector',
      message: repair.matches > 1
        ? `${repair.matches} elements carry the recorded element's identity, so there is no one selector to take. Accept 'element', or edit the step.`
        : `The recorded element is not on the page, so there is no selector to take. Accept 'element', or edit the step.`,
    });
  }

  const loadResult = await loadSequence({ sequenceId: paused.sequenceId }, recorder);
  if (!loadResult.success) return handleLoadSequenceError(loadResult, 'repair');
  const sequence = loadResult.sequence;
  const step = sequence.commands[paused.currentStep];
  if (!step) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'action', value: 'repair', message: `"${sequence.name}" has no step ${paused.currentStep + 1}.`,
    });
  }

  const before = step.params.selector ?? (step.params.x !== undefined ? `(${step.params.x}, ${step.params.y})` : undefined);
  if (args.accept === 'selector') {
    // A point the selector replaces would be read first, and miss again.
    const { x: _x, y: _y, ...rest } = step.params;
    step.params = { ...rest, selector: repair.selector };
  } else {
    step.fingerprint = repair.hit;
  }
  recorder.setActiveSequence({ ...paused, repair: undefined });

  const onDisk = await recorder.listSavedSequencesOnDisk();
  const existingFile = onDisk.find(one => one.name === sequence.name);
  let persisted: string | undefined;
  if (existingFile) {
    const saved = await recorder.saveSequenceToDisk(sequence.id, existingFile.location === 'global', true);
    if (saved && !saved.success) {
      return {
        content: [{ type: 'text', text: `## Error\n\nStep ${paused.currentStep + 1} of "${sequence.name}" was repaired in memory, but writing the file failed: ${saved.error}` }],
        isError: true,
      };
    }
    if (saved?.success) persisted = saved.filepath;
  }

  const what = args.accept === 'selector'
    ? `selector \`${before}\` → \`${repair.selector}\``
    : `recorded element → ${describeFingerprint(repair.hit)}`;
  return {
    content: [{
      type: 'text',
      text: `**Repaired step ${paused.currentStep + 1}** of "${sequence.name}": ${what}\n`
        + (persisted ? `Written to \`${persisted}\`.\n` : `In memory; \`export\` writes it to a file.\n`)
        + `\nRun it again: \`replay({ action: 'step' })\``,
    }],
  };
}

/**
 * Set, change or remove the pause point before a saved step, and the note a
 * session carries out there.
 *
 * The bench sets pause points through its own route; a session reaches the
 * same field only through this action. A pause point with a note is how a
 * sequence holds an action that cannot be a step, such as a bench play: the
 * run stops, the note reaches the event stream and the paused reply, and
 * `replay finish` resumes once it is done.
 */
export async function handlePause(args: ReplayArgs, recorder: CommandRecorder) {
  if (args.step === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'pause',
      missing: 'step',
      message: 'The "pause" action needs "step": the 1-based step the pause point stands before.',
    });
  }
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'pause');
  }
  const sequence = loadResult.sequence;
  const command = sequence.commands[args.step - 1];
  if (!command) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'step',
      value: String(args.step),
      message: `"${sequence.name}" has ${sequence.commands.length} step${sequence.commands.length === 1 ? '' : 's'}; step ${args.step} is not one of them.`,
    });
  }
  if (args.step === 1) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'step',
      value: '1',
      message: 'A run starts at step 1, so there is nothing before it to pause at.',
    });
  }

  if (args.remove) {
    delete command.pauseBefore;
    delete command.pauseHolds;
    delete command.pauseNotify;
    delete command.pauseNote;
  } else {
    command.pauseBefore = true;
    // Every layer is the default and is stored as no list at all, as the bench stores it.
    if (args.hold !== undefined) {
      if (args.hold.length < 3) command.pauseHolds = args.hold;
      else delete command.pauseHolds;
    }
    if (args.notify === false) {
      delete command.pauseNotify;
      delete command.pauseNote;
    } else if (args.notify === true) {
      command.pauseNotify = true;
    }
    if (args.note !== undefined && args.notify !== false) {
      const note = args.note.trim();
      if (note) {
        command.pauseNote = note;
        command.pauseNotify = true;
      } else delete command.pauseNote;
    }
  }

  const persisted = await writeBack(sequence, recorder);
  const where = persisted ? `Written to \`${persisted}\`.` : `In memory only - save with \`replay({ action: 'export', name: '${sequence.name}' })\`.`;
  const text = args.remove
    ? `**Pause point removed** before step ${args.step} of "${sequence.name}".\n\n${where}`
    : [
        `**Pause point before step ${args.step}** of "${sequence.name}", holding ${command.pauseHolds ? command.pauseHolds.join(', ') || 'nothing' : 'everything'}.`,
        command.pauseNote
          ? `**Notifies the session:** ${command.pauseNote}\n\nA run stopping here writes the note to the event stream as an \`instruction\` and prints it in its reply; \`replay({ action: 'finish' })\` resumes once it is carried out.`
          : command.pauseNotify
            ? '**Notifies the session**, with no reason: a run stopping here sends an `instruction` event and its reply asks the session to find out why from the person.'
            : 'Does not notify: a run stops here silently, as at `stepTo`.',
        where,
      ].join('\n\n');
  return { content: [{ type: 'text', text }] };
}

/** Write a sequence back to the file it came from; a memory-only one waits for `export`. */
async function writeBack(sequence: CommandSequence, recorder: CommandRecorder): Promise<string | undefined> {
  const existingFile = (await recorder.listSavedSequencesOnDisk()).find(s => s.name === sequence.name);
  if (!existingFile) return undefined;
  const saved = await recorder.saveSequenceToDisk(sequence.id, existingFile.location === 'global', true);
  return saved?.success ? saved.filepath : undefined;
}

/**
 * Set what a sequence DECLARES: the browsers it needs, the sockets its
 * assertions ride on, and what kind of sequence it is.
 *
 * Declarations cannot be recorded - they are statements about a run, not steps
 * in it - so without this the only way to add them is to edit the JSON by
 * hand, where the copy in memory can shadow the edited file.
 *
 * Each list REPLACES its field, and `[]` clears it: a declaration set is a
 * whole statement about the run, and merging would make "remove the second
 * browser" unexpressible.
 */
export async function handleDeclare(args: ReplayArgs, recorder: CommandRecorder) {
  if (args.requiredConnections === undefined && args.requiredSockets === undefined && args.tags === undefined && args.proxy === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'declare',
      missing: 'requiredConnections, requiredSockets, tags or proxy',
      message: 'The "declare" action needs at least one of "requiredConnections" (browsers the sequence needs), ' +
        '"requiredSockets" (URL substrings of the WebSockets its assertions ride on), "tags" (what kind of ' +
        'sequence this is, which runAll selects on), or "proxy" (the run crosses the proxy). Pass [] to clear a list.',
    });
  }

  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'declare');
  }
  const sequence = loadResult.sequence;

  if (args.requiredConnections !== undefined) {
    const seen = new Map<string, string>();
    for (const decl of args.requiredConnections) {
      // The run launches each declared reference by name, and a launch refuses
      // a name that is not three words - refused here, while it is written.
      const validation = validateReference(decl.connection);
      if (!validation.valid) {
        return createErrorResponse('INVALID_PARAMETER', {
          parameter: 'requiredConnections',
          value: decl.connection,
          message: `"${decl.connection}" is not a usable connection name: ${validation.error}.`,
        });
      }
      const reference = validation.sanitized!;
      if (seen.has(reference)) {
        return createErrorResponse('INVALID_PARAMETER', {
          parameter: 'requiredConnections',
          value: reference,
          message: `"${reference}" is declared twice. One entry per browser - a second entry cannot mean anything the first does not.`,
        });
      }
      seen.set(reference, decl.profile ?? '');
      if (decl.profile) {
        try {
          normalizeProfileName(decl.profile);
        } catch (err: any) {
          return createErrorResponse('INVALID_PARAMETER', {
            parameter: 'requiredConnections',
            value: decl.profile,
            message: err?.message || String(err),
          });
        }
      }
    }
    // Same rule the run enforces, applied at authoring time so it fails while
    // you are writing the declaration rather than on the next run.
    const conflict = declaredProfileConflict(args.requiredConnections, undefined);
    if (conflict) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'requiredConnections',
        value: sequence.name,
        message: conflict,
      });
    }
    (sequence as any).requiredConnections = args.requiredConnections.length > 0
      ? args.requiredConnections.map(d => ({ ...d, connection: sanitizeReference(d.connection) }))
      : undefined;
  }

  if (args.proxy !== undefined) {
    (sequence as any).proxy = args.proxy || undefined;
  }

  if (args.requiredSockets !== undefined) {
    const blank = args.requiredSockets.find(s => s.trim().length === 0);
    if (blank !== undefined) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'requiredSockets',
        value: '(empty string)',
        message: 'An empty socket pattern matches every socket, including the dev server\'s own - name the path your app uses, e.g. "/api/sync/socket".',
      });
    }
    (sequence as any).requiredSockets = args.requiredSockets.length > 0 ? args.requiredSockets : undefined;
  }

  if (args.tags !== undefined) {
    const cleaned = normalizeTags(args.tags);
    if ('error' in cleaned) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'tags',
        value: args.tags.join(', '),
        message: cleaned.error,
      });
    }
    (sequence as any).tags = cleaned.tags.length > 0 ? cleaned.tags : undefined;
  }

  const persisted = await writeBack(sequence, recorder);

  return {
    content: [{
      type: 'text',
      text: formatDeclarations(sequence, persisted),
    }],
  };
}
