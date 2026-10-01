/**
 * Editing a sequence in place: inserting steps from history, adding a check
 * step, and setting what the sequence declares.
 */
import { renumberSteps } from '../sequence-activity.js';
import type { CommandRecorder, RecordedCommand } from '../command-recorder.js';
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
import { addressedConnection } from './connection-steps.js';

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

    // Manually set commands
    (newSequence as any).commands = newCommands;
    if (normalized.hoisted) (newSequence as any).recordedConnection = normalized.hoisted;

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
  if (args.requiredConnections === undefined && args.requiredSockets === undefined && args.tags === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'declare',
      missing: 'requiredConnections, requiredSockets or tags',
      message: 'The "declare" action needs at least one of "requiredConnections" (browsers the sequence needs), ' +
        '"requiredSockets" (URL substrings of the WebSockets its assertions ride on), or "tags" (what kind of ' +
        'sequence this is, which runAll selects on). Pass [] to clear one.',
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

  // Write back to the file this came from; a memory-only sequence waits for
  // `export`, which is where it gets its filename.
  let persisted: string | undefined;
  const existingFile = (await recorder.listSavedSequencesOnDisk())
    .find(s => s.name === sequence.name);
  if (existingFile) {
    const saved = await recorder.saveSequenceToDisk(
      sequence.id,
      existingFile.location === 'global',
      true
    );
    if (saved?.success) persisted = saved.filepath;
  }

  return {
    content: [{
      type: 'text',
      text: formatDeclarations(sequence, persisted),
    }],
  };
}
