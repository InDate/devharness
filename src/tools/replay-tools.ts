/**
 * The `replay` tool: records and replays command sequences. The actions live
 * in the replay-* modules beside this one; this routes a call to its action.
 */
import type { CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse, responseWithOnce } from '../messages.js';
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
  getPageForConnection?: (connection: string) => Promise<any>,
  getConnectionPort?: (connection: string) => Promise<number | null>,
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
      'Record and replay tool-call sequences. Actions: history, repeat (re-run history indices), create (sequence from history indices), insert, addCheck, declare (the browsers, sockets and tags a sequence carries), list (memory and disk), get, delete (from memory), export (to disk as sequence/playwright/puppeteer), load, listSaved, deleteSaved, run (in the background, returning a runId; wait: true blocks), runAll (every sequence in a folder, or carrying a tag, one pass/fail line each), status, cancel, step/finish (a paused run), runFromLog (log line numbers), recordInteraction (a person\'s mouse, keyboard and navigation through a browser overlay; blocks until that person finishes)',
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
            return responseWithOnce(await handleRun(args, commandRecorder, executeToolCall, getPageForConnection!, abortSignal, getConnectionPort), 'REPLAY_RUN_REPLY');
          case 'runAll':
            return responseWithOnce(
              responseWithOnce(await handleRunAll(args, commandRecorder, executeToolCall, getPageForConnection!, abortSignal, getConnectionPort), 'REPLAY_RUN_ALL_REPLY'),
              'REPLAY_RUN_REPLY'
            );
          case 'status':
            return handleStatus(args, commandRecorder);
          case 'step':
            return handleStep(args, commandRecorder, executeToolCall, abortSignal);
          case 'finish':
            return handleFinish(commandRecorder, executeToolCall);
          case 'insert':
            return handleInsert(args, commandRecorder);
          case 'addCheck':
            return responseWithOnce(await handleAddCheck(args, commandRecorder), 'REPLAY_ADD_CHECK_REPLY');
          case 'declare':
            return responseWithOnce(await handleDeclare(args, commandRecorder), 'REPLAY_DECLARE_REPLY');
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
