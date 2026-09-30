/**
 * The `replay` tool: records and replays command sequences. The actions live
 * in the replay-* modules beside this one; this routes a call to its action.
 */
import type { CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { handleInsert, handleAddCheck, handleDeclare } from './replay-edit.js';
import { handleHistory, handleRepeat, handleRunFromLog } from './replay-history.js';
import { handleCreate, handleList, handleGet, handleDelete, handleExport, handleLoad, handleListSaved, handleDeleteSaved } from './replay-library.js';
import { handleRecordInteraction } from './replay-record.js';
import { handleRun } from './replay-run.js';
import { handleRunAll } from './replay-run-all.js';
import { replaySchema } from './replay-schema.js';
import { handleStatus, handleCancel, handleStep, handleFinish } from './replay-session.js';

export { findUnknownStepTools, type UnknownStepTool } from './replay-validation.js';

export function createReplayTools(
  commandRecorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  getConnectionPort?: (connectionReason: string) => Promise<number | null>,
  /**
   * Lazy provider for the set of registered tool names, used to reject sequence
   * steps naming a nonexistent tool at create/load time (bug-010). Lazy because
   * the tool map is built after this factory runs. When omitted, tool names are
   * not validated (previous behaviour).
   */
  getKnownToolNames?: () => string[]
) {
  return {
    replay: createTool(
      'Record and replay command sequences for testing and automation. Actions: repeat (immediately re-execute commands by history index - use this to repeat recent actions), history (view command history), recordInteraction (record real mouse/keyboard/navigation via a browser overlay - BLOCKS until the person finishes, so do not call it unattended; tune the capture with simplifyEvents/includeHovers/preferCoordinates/preferSelectors, and add outputFormat: events|commands|review|playwright|puppeteer to dump the recording - review is a human-readable walkthrough of the captured events), create (create sequence from history indices), list (every sequence reachable: those in memory and those saved on disk), get (get sequence details; outputFormat: commands|playwright|puppeteer returns the raw command JSON or generated test code), delete (delete from memory), export (write a sequence to disk as sequence/playwright/puppeteer), load (load sequence from disk), listSaved (the saved files alone), deleteSaved (delete saved file), run (start executing a sequence in the background - returns a runId immediately; poll progress/results with status, stop it with cancel; wait: true blocks until completion and returns the full result), runAll (run every sequence in a folder of the sequences dir, or only those carrying a given tag - loads the whole tree first so cross-folder name references resolve, runs only the chosen folder, skips folders whose name starts with an underscore unless named explicitly, and reports a pass/fail line per sequence; continueOnFailure defaults true), runFromLog (execute commands from log lines), step (execute next N commands in a paused sequence), finish (complete remaining commands), insert (insert recorded commands into a sequence), addCheck (add a check step: check holds its parameters, optionally insertAfterStep - a guard is a check whose pass runs another sequence), declare (set what the sequence needs and what it is: requiredConnections - the browsers, optionally each on a persistent profile - requiredSockets - URL substrings of the WebSockets its assertions ride on - and tags, which runAll selects on; each list replaces the field, [] clears it, and the sequence is written back to its file), status (with runId: one run\'s progress or final result; without: paused session + recent runs), cancel (with runId: stop that run; without: drop the paused session, or the only executing run)',
      replaySchema,
      async (args, abortSignal) => {
        switch (args.action) {
          case 'history':
            return handleHistory(args, commandRecorder);
          case 'create':
            return handleCreate(args, commandRecorder, getKnownToolNames);
          case 'list':
            return handleList(args, commandRecorder);
          case 'get':
            return handleGet(args, commandRecorder);
          case 'delete':
            return handleDelete(args, commandRecorder);
          case 'export':
            return handleExport(args, commandRecorder);
          case 'load':
            return handleLoad(args, commandRecorder, getKnownToolNames);
          case 'listSaved':
            return handleListSaved(args, commandRecorder);
          case 'deleteSaved':
            return handleDeleteSaved(args, commandRecorder);
          case 'run':
            return handleRun(args, commandRecorder, executeToolCall, getPageForConnection!, abortSignal, getConnectionPort);
          case 'runAll':
            return handleRunAll(args, commandRecorder, executeToolCall, getPageForConnection!, abortSignal, getConnectionPort);
          case 'status':
            return handleStatus(args, commandRecorder);
          case 'step':
            return handleStep(args, commandRecorder, executeToolCall, abortSignal);
          case 'finish':
            return handleFinish(commandRecorder, executeToolCall);
          case 'insert':
            return handleInsert(args, commandRecorder);
          case 'addCheck':
            return handleAddCheck(args, commandRecorder);
          case 'declare':
            return handleDeclare(args, commandRecorder);
          case 'cancel':
            return handleCancel(args, commandRecorder);
          case 'repeat':
            return handleRepeat(args, commandRecorder, executeToolCall);
          case 'runFromLog':
            return handleRunFromLog(args, executeToolCall);
          case 'recordInteraction':
            return handleRecordInteraction(args, executeToolCall, getPageForConnection, commandRecorder, abortSignal);
          default:
            return createErrorResponse('INVALID_ACTION', { action: args.action });
        }
      }
    ),
  };
}
