/**
 * Sequences at rest: creating them from history, listing, reading, exporting,
 * loading and deleting them.
 */
import { getProxy } from '../proxy/registry.js';
import { tallyShapes } from '../proxy/intercept-proxy.js';
import { countStepTraffic } from '../step-traffic.js';
import type { ExecuteToolCall } from '../types.js';
import { announceSequenceSaved } from '../sequence-events.js';
import type { CommandRecorder, CommandSequence, RecordedCommand } from '../command-recorder.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { loadSequence, commandTakesInjectedConnection, normalizeStepConnections } from './replay-executor.js';
import { formatSequenceCreated, formatSequenceList, formatSequenceDetails, formatSavedSequencesList } from './replay-formatters.js';
import { configManager } from '../config.js';
import { generatePuppeteerCode, generatePlaywrightCode } from './replay-codegen.js';
import { type ReplayArgs } from './replay-schema.js';
import { validateSequenceToolNames, handleLoadSequenceError } from './replay-validation.js';

export async function handleCreate(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getKnownToolNames?: () => string[]
) {
  if (!args.name) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'create',
      missing: 'name',
      message: 'The "create" action requires a "name" parameter'
    });
  }

  if (!args.indices || args.indices.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'create',
      missing: 'indices',
      message: 'The "create" action requires an "indices" array with at least one command index'
    });
  }

  const replayEntries = args.indices.filter(index => recorder.getCommand(index)?.tool === 'replay');
  if (replayEntries.length === args.indices.length) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'indices', value: args.indices.join(', '),
      message: 'Every index names a replay call, and a replay call does not become a step. A sequence that runs another one gets it through addCheck or split.',
    });
  }

  // Reject unknown tool names up front rather than failing mid-run (bug-010).
  // The check runs inside createSequence, on the candidate, BEFORE it replaces any
  // same-named sequence in memory - otherwise a bad create would delete the user's
  // good sequence and then reject the new one, leaving them with neither.
  let invalid: ReturnType<typeof validateSequenceToolNames> = null;
  const sequence = await recorder.createSequence(args.name, args.indices, {
    description: args.description,
    expectedOutcome: args.expectedOutcome,
    startUrl: args.startUrl,
    validate: (candidate) => {
      invalid = validateSequenceToolNames(candidate, 'create', getKnownToolNames);
      return invalid === null;
    },
  });

  if (invalid) return invalid;

  if (!sequence) {
    return createErrorResponse('INVALID_INDICES', {
      message: 'One or more command indices are invalid. Use replay({ action: "history" }) to see available commands.'
    });
  }

  // Recorded steps keep the connection they were driven against (bug-018). Hoist
  // it back off when the whole sequence shares one, so the sequence stays
  // portable and a run-level connection still retargets it; keep it
  // per-step only where the sequence genuinely spans connections.
  const normalized = normalizeStepConnections(sequence.commands);
  (sequence as any).commands = normalized.commands;
  // What was hoisted is stored: `insert` reads it to separate a same-browser
  // insert from a cross-browser one (see handleInsert).
  if (normalized.hoisted) (sequence as any).recordedConnection = normalized.hoisted;
  const recordingProxy = normalized.hoisted ? getProxy(normalized.hoisted) : undefined;
  if (recordingProxy) {
    (sequence as any).proxy = true;
    const rules = recordingProxy.shapeRules();
    if (Object.keys(rules).length > 0) (sequence as any).shapeRules = rules;
    // Read now and stored on the step: the proxy holds its events in memory
    // for this session only, so a sequence replayed later has nothing to read.
    const unmeasured: number[] = [];
    for (const [position, command] of sequence.commands.entries()) {
      if (command.recordedAt === undefined) continue;
      // A step whose events the ring dropped is not a step that saw none.
      // Storing an empty set for it would read as "nothing crossed" against
      // every later replay, which is a drift report with no evidence in it.
      if (!recordingProxy.measurable(command.recordedAt)) {
        unmeasured.push(position + 1);
        continue;
      }
      // Held from this command until its boundary was released, which is the
      // span it owns. The next command's timestamp stands in for a command
      // whose release has not been recorded - one still settling, or one from
      // a session that predates the release - and `create`'s own clock for the
      // last of those, which carries the pause before saving and reads long.
      const entry = recorder.getCommand(command.recordedAt);
      const began = entry?.timestamp;
      const nextAt = recorder.getCommand(command.recordedAt + 1)?.timestamp;
      const ended = entry?.releasedAt ?? nextAt ?? Date.now();
      const counted = began
        ? await countStepTraffic(executeToolCall, normalized.hoisted!, began, ended)
        : undefined;
      if (!counted) {
        unmeasured.push(position + 1);
        continue;
      }
      const tally = tallyShapes(recordingProxy.eventsForCommand(command.recordedAt), rules);
      command.traffic = {
        ...command.traffic,
        ...counted,
        shapes: tally.weight,
        seen: tally.seen,
        windowMs: ended - began!,
      };
    }
    if (unmeasured.length > 0) {
      (sequence as any).shapesUnmeasured = unmeasured;
    }
  }

  const dropped = (sequence as any).shapesUnmeasured as number[] | undefined;
  const note = dropped
    ? `\n\nStep(s) ${dropped.join(', ')} carry no boundary evidence: the proxy had already dropped their events, or the network log for their window could not be read. Those steps are left out of the traffic comparison rather than compared against nothing.`
    : '';
  const skippedNote = replayEntries.length
    ? `\n\nIndex ${replayEntries.join(', ')} ${replayEntries.length === 1 ? 'is a replay call' : 'are replay calls'}, left out: a replay call does not become a step. A sequence that runs another one gets it through addCheck or split.`
    : '';
  return { content: [{ type: 'text', text: formatSequenceCreated(sequence) + formatConnectionNote(normalized) + note + skippedNote }] };
}

/**
 * Re-stamp the connection that `create` hoisted off the steps, so a merged
 * command array is fully explicit about which browser each step belongs to.
 * Without this a sequence's own bare steps read as "ambiguous" the moment
 * anything connection-bearing is spliced in.
 */
export function rehydrateStepConnections(sequence: CommandSequence): RecordedCommand[] {
  const recorded = sequence.recordedConnection;
  if (!recorded) return sequence.commands;
  return sequence.commands.map(cmd =>
    commandTakesInjectedConnection(cmd) && !cmd.params.connection
      ? { ...cmd, params: { ...cmd.params, connection: recorded } }
      : cmd
  );
}

/**
 * What `create`/`insert` did with the recorded per-step connections, and what the
 * user has to do about it on `run`. A multi-connection sequence is only portable
 * if its references are rebound, and an ambiguous ("mixed") recording is
 * reported rather than pinned to one connection.
 */
export function formatConnectionNote(normalized: ReturnType<typeof normalizeStepConnections>): string {
  const { analysis, hoisted } = normalized;
  const notes: string[] = [];

  if (hoisted) {
    return `\n\n**Connection:** every step ran against \`${hoisted}\`, so it was hoisted off the steps` +
      ` - the sequence is portable and \`replay({ action: 'run', connection: '<other>' })\` retargets it.`;
  }

  if (analysis.multiConnection) {
    notes.push(`\n\n**Multi-connection sequence:** steps keep their own connections (${analysis.references.map(r => `\`${r}\``).join(', ')}),` +
      ` so the recorded interleaving is reproduced instead of collapsing into one browser.` +
      ` A run-level \`connection\` does NOT override them; in another session rebind them with` +
      ` \`replay({ action: 'run', name: '...', connections: { ${analysis.references.map(r => `"${r}": "<reference here>"`).join(', ')} } })\`.` +
      ` A reference that doesn't exist at run time fails that step rather than falling back.`);
  }

  // NOT an else-if. A sequence can be both, and that combination is the most
  // dangerous one: bare steps in a two-browser sequence take whatever the
  // run-level connection happens to be, so the same sequence sends them to a
  // different browser depending on how it is run - silently, and green either
  // way.
  if (analysis.mixed) {
    notes.push(`\n\n**${analysis.multiConnection ? 'Some steps name no connection' : 'Mixed connections'}:** ` +
      `steps naming ${analysis.references.map(r => `\`${r}\``).join(', ')} are pinned, but other browser steps name none` +
      ` (nothing records which connection they ran against).` +
      ` Those bare steps take the run-level connection, so ${analysis.multiConnection
        ? `they land in a DIFFERENT browser depending on the run-level \`connection\` - and the run still reports success either way.`
        : `a run-level \`connection\` retargets them while the named steps stay put.`}` +
      ` Re-record passing \`connection\` on every step to make this deterministic.`);
  }

  return notes.join('');
}

export async function handleList(args: ReplayArgs, recorder: CommandRecorder) {
  const sequences = recorder.listSequences();
  const saved = await recorder.listSavedSequencesOnDisk();
  const issueSequences = await listIssueSequencesOrEmpty(recorder);
  return {
    content: [{
      type: 'text',
      text: formatSequenceList(sequences, saved, issueSequences, args.showAll ?? false)
    }]
  };
}

/**
 * Issue sequences, or an empty list when the issue store cannot be read. A
 * failure there must not take the sequence list with it - the sequences on
 * disk are what the caller asked for.
 */
async function listIssueSequencesOrEmpty(recorder: CommandRecorder) {
  try {
    return await recorder.listIssueSequencesOnDisk();
  } catch {
    return [];
  }
}

export async function handleGet(args: ReplayArgs, recorder: CommandRecorder) {
  // Use loadSequence to support both name (disk) and sequenceId (memory)
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'get');
  }

  const sequence = loadResult.sequence;

  // Raw input events are only ever held in memory during recordInteraction -
  // a stored sequence keeps the converted commands, not the events. Say so
  // instead of silently returning the detail view.
  if (args.outputFormat === 'events') {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'outputFormat',
      value: 'events',
      message: 'A stored sequence holds commands, not raw input events. Use outputFormat: "commands" here, or outputFormat: "events" on action "recordInteraction" to dump the raw events of a live recording.'
    });
  }

  // 'review' renders raw input events too, so it has the same problem as
  // 'events' - say so instead of silently returning the detail view.
  if (args.outputFormat === 'review') {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'outputFormat',
      value: 'review',
      message: 'The review walkthrough renders raw input events, and a stored sequence holds commands, not events. Use outputFormat: "commands" here, or outputFormat: "review" on action "recordInteraction" to review the events of a live recording.'
    });
  }

  if (args.outputFormat === 'commands') {
    let output = `**${sequence.name} - Commands (JSON)**\n\n`;
    output += '```json\n';
    output += JSON.stringify(sequence.commands, null, 2);
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  // Check if output format is specified for code export
  if (args.outputFormat === 'playwright') {
    const code = generatePlaywrightCode(sequence.commands, sequence.startUrl);
    let output = `**${sequence.name} - Playwright Code**\n\n`;
    output += '```typescript\n';
    output += code;
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  if (args.outputFormat === 'puppeteer') {
    const code = generatePuppeteerCode(sequence.commands, sequence.startUrl);
    let output = `**${sequence.name} - Puppeteer Code**\n\n`;
    output += '```javascript\n';
    output += code;
    output += '\n```';
    return { content: [{ type: 'text', text: output }] };
  }

  return { content: [{ type: 'text', text: formatSequenceDetails(sequence) }] };
}

export async function handleDelete(args: ReplayArgs, recorder: CommandRecorder) {
  // Use loadSequence to support both name and sequenceId
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'delete');
  }

  const sequence = loadResult.sequence;
  const deleted = recorder.deleteSequence(sequence.id);
  if (!deleted) {
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      sequenceId: sequence.id,
      message: `Sequence "${sequence.name}" not found.`
    });
  }

  return createSuccessResponse('SEQUENCE_DELETED', {
    sequenceId: sequence.id,
    name: sequence.name,
    message: `Sequence "${sequence.name}" deleted successfully.`
  });
}

export async function handleExport(args: ReplayArgs, recorder: CommandRecorder) {
  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'export');
  }

  const sequence = loadResult.sequence;
  const format = args.format || 'sequence';
  const overwrite = args.overwrite ?? false;

  // Always save sequence file first (for all formats)
  const sequenceResult = await recorder.saveSequenceToDisk(sequence.id, args.global ?? false, overwrite);
  if (!sequenceResult) {
    return createErrorResponse('EXPORT_FAILED', { message: 'Sequence not found.' });
  }
  if (!sequenceResult.success) {
    if (sequenceResult.conflict) {
      return createSuccessResponse('EXPORT_CONFLICT', {
        filepath: sequenceResult.filepath,
        sequenceName: sequence.name,
        format
      });
    }
    return createErrorResponse('EXPORT_FAILED', { message: sequenceResult.error });
  }

  await announceSequenceSaved(sequence, sequenceResult.filepath);

  // If only exporting sequence JSON, we're done
  if (format === 'sequence') {
    const location = args.global ? 'global (~/.devharness/sequences/)' : 'working directory';
    return createSuccessResponse('EXPORT_SEQUENCE_SUCCESS', {
      filename: sequenceResult.filepath,
      location
    });
  }

  // Export as Playwright or Puppeteer test
  const replayConfig = configManager.getReplayConfig();
  const isPlaywright = format === 'playwright';
  const code = isPlaywright
    ? generatePlaywrightCode(sequence.commands, sequence.startUrl)
    : generatePuppeteerCode(sequence.commands, sequence.startUrl);
  const exportPath = isPlaywright ? replayConfig.playwrightExportPath : replayConfig.puppeteerExportPath;
  const extension = isPlaywright ? '.spec.ts' : '.test.js';

  const fs = await import('fs');
  const path = await import('path');
  const sanitizedName = sequence.name.replace(/[^a-zA-Z0-9-_]/g, '-');
  const fullPath = path.resolve(exportPath, `${sanitizedName}${extension}`);

  // Check for test file conflict
  if (fs.existsSync(fullPath) && !overwrite) {
    return createSuccessResponse('EXPORT_CONFLICT', {
      filepath: fullPath,
      sequenceName: sequence.name,
      format
    });
  }

  // Write the test file
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, code, 'utf-8');

  return createSuccessResponse('EXPORT_SUCCESS', {
    testFile: fullPath,
    sequenceFile: sequenceResult.filepath,
    format
  });
}

export async function handleLoad(args: ReplayArgs, recorder: CommandRecorder, getKnownToolNames?: () => string[]) {
  if (!args.filename) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'load',
      missing: 'filename',
      message: 'The "load" action requires a "filename" parameter. Use listSaved to see available files.'
    });
  }

  // Reject unknown tool names up front rather than failing mid-run (bug-010).
  // Validation runs on the parsed candidate BEFORE it replaces any same-named
  // sequence in memory, so a bad file can't evict a good in-memory sequence.
  let invalid: ReturnType<typeof validateSequenceToolNames> = null;
  const sequence = await recorder.loadSequenceFromDisk(args.filename, {
    validate: (candidate) => {
      invalid = validateSequenceToolNames(candidate, 'load', getKnownToolNames);
      return invalid === null;
    },
  });

  if (invalid) return invalid;

  if (!sequence) {
    return createErrorResponse('LOAD_FAILED', {
      filename: args.filename,
      error: 'File may not exist or be invalid.'
    });
  }

  // If intoHistory is true, load commands into history without executing
  if (args.intoHistory) {
    let loadedCount = 0;
    for (const cmd of sequence.commands) {
      recorder.recordCommand(cmd.tool, cmd.params);
      loadedCount++;
    }

    return createSuccessResponse('SEQUENCE_LOADED_INTO_HISTORY', {
      sequenceId: sequence.id,
      name: sequence.name,
      commandCount: loadedCount,
      message: `Loaded ${loadedCount} commands from "${sequence.name}" into history. Use replay({ action: 'history' }) to view.`
    });
  }

  return createSuccessResponse('SEQUENCE_LOADED_FROM_DISK', {
    sequenceId: sequence.id,
    name: sequence.name,
    commandCount: sequence.commands.length,
    message: `Sequence "${sequence.name}" loaded successfully. Use replay({ action: 'run', sequenceId: '${sequence.id}' }) to execute.`
  });
}

export async function handleListSaved(args: ReplayArgs, recorder: CommandRecorder) {
  const savedSequences = await recorder.listSavedSequencesOnDisk();
  const issueSequences = await listIssueSequencesOrEmpty(recorder);
  const showAll = args.showAll ?? false;
  return { content: [{ type: 'text', text: formatSavedSequencesList(savedSequences, issueSequences, showAll) }] };
}

export async function handleDeleteSaved(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.filename) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'deleteSaved',
      missing: 'filename',
      message: 'The "deleteSaved" action requires a "filename" parameter'
    });
  }

  const deleted = await recorder.deleteSequenceFromDisk(args.filename);
  if (!deleted) {
    return createErrorResponse('DELETE_FAILED', {
      filename: args.filename,
      message: `Failed to delete file "${args.filename}". File may not exist.`
    });
  }

  return createSuccessResponse('SAVED_SEQUENCE_DELETED', {
    filename: args.filename,
    message: `Sequence file "${args.filename}" deleted successfully.`
  });
}
