/**
 * Calls replayed from the session history (`repeat`) and from history.log
 * (`runFromLog`), and the history view itself.
 */
import { markOnProxies } from '../proxy/registry.js';
import type { CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createErrorResponse } from '../messages.js';
import { sanitizeReference } from '../reference-validator.js';
import { commandTakesInjectedConnection } from './replay-executor.js';
import { createdName } from './connection-steps.js';
import { formatHistory } from './replay-formatters.js';
import { readHistoryLines, getHistoryFilePath } from '../debug-logger.js';
import { type ReplayArgs } from './replay-schema.js';

/** Bumped per repeat, so two in the same millisecond keep separate ids. */
let repeatSeq = 0;

export async function handleHistory(args: ReplayArgs, recorder: CommandRecorder) {
  const limit = args.limit || 50;
  const history = recorder.getHistory(limit);
  const stats = recorder.getStats();

  // Mark history as viewed if we're in a paused sequence (enables insert)
  if (recorder.getActiveSequence()) {
    recorder.markHistoryViewed();
  }

  return { content: [{ type: 'text', text: formatHistory(history, stats.historyCount) }] };
}

/**
 * Whether an explicit batch-level `connectionReason` replaces the connections
 * the commands were recorded against (`repeat`, `runFromLog`).
 *
 * Yes for a single-connection batch - that is what the parameter has always
 * meant, and silently ignoring it (which is what "never overwrite a recorded
 * connection" amounted to once history started retaining them) breaks a
 * documented knob with no signal. No for a batch spanning several browsers:
 * there is no honest single answer, and picking one reproduces bug-018.
 */
function resolveBatchOverride(
  commands: Array<{ tool: string; params: Record<string, any> }>,
  requested: string | undefined,
  action: 'repeat' | 'runFromLog'
): { replaceRecorded: boolean } | { error: any } {
  if (!requested) return { replaceRecorded: false };

  const refs = new Set(
    commands
      .filter(c => typeof c.params.connectionReason === 'string' && c.params.connectionReason.trim())
      .map(c => sanitizeReference(c.params.connectionReason))
  );

  if (refs.size > 1) {
    return {
      error: createErrorResponse('INVALID_PARAMETER', {
        parameter: 'connectionReason',
        value: requested,
        message: `These commands were recorded against ${refs.size} different connections (${[...refs].join(', ')}), ` +
          `so a single connectionReason cannot apply to all of them - running them in one browser would report success without ever using the second. ` +
          `Omit connectionReason to replay each command against the connection it was recorded with, or ${action} the commands for one connection at a time.`
      })
    };
  }

  return { replaceRecorded: true };
}

export async function handleRepeat(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall
) {
  if (!args.indices || args.indices.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repeat',
      missing: 'indices',
      message: 'The "repeat" action requires an "indices" array with command indices to execute'
    });
  }

  // Get commands from history
  const commands: Array<{ tool: string; params: Record<string, any>; index: number }> = [];
  for (const idx of args.indices) {
    const cmd = recorder.getCommand(idx);
    if (!cmd) {
      return createErrorResponse('INVALID_INDICES', {
        message: `Command index ${idx} not found in history. Use replay({ action: "history" }) to see available commands.`
      });
    }
    commands.push({ tool: cmd.tool, params: cmd.params, index: idx });
  }

  // A command replays against the connection it was RECORDED with when it has one
  // (bug-018) - repeating a batch that spans two browsers used to resolve one
  // connection for the whole batch and stamp it onto every command, silently
  // running both browsers' steps in one. Only commands with no recorded
  // connection need a batch-level one. No `connections` mapping here: repeat
  // replays from this session's own history, so the recorded references are the
  // live ones by construction.
  const needsConnection = commands.some(cmd =>
    commandTakesInjectedConnection(cmd) && !cmd.params.connectionReason
  );
  let connectionReason = args.connectionReason;

  // An explicitly passed connectionReason must still mean "run these against
  // that connection" - history retains the recorded one for every command that
  // named a connection, so honouring only bare commands would turn this
  // documented parameter into a silent no-op. It can only be honoured when the batch is
  // single-connection; overriding a two-browser batch is the collapse bug-018
  // is about, so that combination is refused rather than silently picking one.
  const override = resolveBatchOverride(commands, args.connectionReason, 'repeat');
  if ('error' in override) return override.error;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    // A launch or attach among the commands names the connection they run on.
    const created = commands.map(createdName).find(Boolean);
    if (created) {
      connectionReason = created;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repeat',
      missing: 'connectionReason',
      message: 'These commands act on a connection and name none. Provide connectionReason parameter.'
    });
  }

  // Execute commands
  const results: Array<{ index: number; tool: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  const proxyRun = `repeat-${Date.now().toString(36)}-${(repeatSeq += 1)}`;
  let position = 0;

  for (const cmd of commands) {
    markOnProxies({ kind: 'replay', runId: proxyRun, step: position++ });
    try {
      // Fill in a batch-level connection where the command has none, and replace
      // the recorded one only when the caller explicitly asked to retarget a
      // single-connection batch (see resolveBatchOverride).
      const params = { ...cmd.params };
      if (connectionReason && commandTakesInjectedConnection(cmd) &&
          (override.replaceRecorded || !params.connectionReason)) {
        params.connectionReason = connectionReason;
      }

      await executeToolCall(cmd.tool, params);
      results.push({ index: cmd.index, tool: cmd.tool, success: true });
    } catch (error: any) {
      results.push({ index: cmd.index, tool: cmd.tool, success: false, error: error.message || String(error) });
      // Stop on first error
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  // Format response
  let response = failed > 0
    ? `**Repeat failed** at command #${results.find(r => !r.success)?.index}`
    : `**Repeated ${successful} command${successful !== 1 ? 's' : ''}** in ${(durationMs / 1000).toFixed(1)}s`;

  response += '\n';
  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    response += `\n#${r.index}. **${r.tool}** ${icon}`;
    if (r.error) {
      response += ` - ${r.error}`;
    }
  });

  return { content: [{ type: 'text', text: response }] };
}

export async function handleRunFromLog(
  args: ReplayArgs,
  executeToolCall: ExecuteToolCall
) {
  if (!args.lines || args.lines.length === 0) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'runFromLog',
      missing: 'lines',
      message: `The "runFromLog" action requires a "lines" array with line numbers to execute from history.log (1-indexed, line 1 is most recent). File: ${getHistoryFilePath()}`
    });
  }

  // Read commands from history.log file
  const lineResults = await readHistoryLines(args.lines);

  // Check for errors
  const errors = lineResults.filter((r): r is { line: number; error: string } => 'error' in r);
  if (errors.length > 0) {
    return createErrorResponse('INVALID_LINES', {
      message: `Some lines could not be read from history.log:\n${errors.map(e => `  Line ${e.line}: ${e.error}`).join('\n')}`,
      file: getHistoryFilePath()
    });
  }

  const commands = lineResults as Array<{ line: number; tool: string; params: Record<string, any> }>;

  // As in repeat: a logged command keeps the connection it was recorded with, so
  // only the bare ones need a batch-level connection (bug-018).
  const needsConnection = commands.some(cmd =>
    commandTakesInjectedConnection(cmd) && !cmd.params.connectionReason
  );
  let connectionReason = args.connectionReason;

  // Same rule as repeat: an explicit connectionReason retargets a
  // single-connection batch, and is refused for a multi-connection one.
  const override = resolveBatchOverride(commands, args.connectionReason, 'runFromLog');
  if ('error' in override) return override.error;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    const created = commands.map(createdName).find(Boolean);
    if (created) {
      connectionReason = created;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'runFromLog',
      missing: 'connectionReason',
      message: 'These commands act on a connection and name none. Provide connectionReason parameter.'
    });
  }

  // Execute commands
  const results: Array<{ line: number; tool: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (const cmd of commands) {
    try {
      const params = { ...cmd.params };
      if (connectionReason && commandTakesInjectedConnection(cmd) &&
          (override.replaceRecorded || !params.connectionReason)) {
        params.connectionReason = connectionReason;
      }

      await executeToolCall(cmd.tool, params);
      results.push({ line: cmd.line, tool: cmd.tool, success: true });
    } catch (error: any) {
      results.push({ line: cmd.line, tool: cmd.tool, success: false, error: error.message || String(error) });
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  let response = failed > 0
    ? `**runFromLog failed** at line ${results.find(r => !r.success)?.line}`
    : `**Executed ${successful} command${successful !== 1 ? 's' : ''} from history.log** in ${(durationMs / 1000).toFixed(1)}s`;

  response += '\n';
  results.forEach(r => {
    const icon = r.success ? '✓' : '✗';
    response += `\nL${r.line}. **${r.tool}** ${icon}`;
    if (r.error) {
      response += ` - ${r.error}`;
    }
  });

  return { content: [{ type: 'text', text: response }] };
}
