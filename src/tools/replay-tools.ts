/**
 * The `replay` tool records and keeps command sequences; the `run` tool runs
 * them, or steps written into the call. The actions live in the replay-*
 * modules beside this one; this routes a call to its action.
 */
import type { CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse, responseWithOnce } from '../messages.js';
import { handleInsert, handleAddCheck, handleDeclare, handlePause, handleRepair, handleCopy, handleSplit, handleAdopt } from './replay-edit.js';
import { handleHistory, handleRepeat, handleRunFromLog } from './replay-history.js';
import { handleCreate, handleList, handleGet, handleDelete, handleExport, handleLoad, handleListSaved, handleDeleteSaved } from './replay-library.js';
import { handleRecordInteraction } from './replay-record.js';
import { handleRun } from './replay-run.js';
import { handleRunAll } from './replay-run-all.js';
import { handleSearch } from './replay-search.js';
import { replaySchema, runSchema, RUN_ACTIONS, type ReplayArgs, type RunArgs } from './replay-schema.js';
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
  const dispatch = async (args: ReplayArgs, abortSignal?: AbortSignal): Promise<any> => {
        switch (args.action) {
          case 'history':
            return handleHistory(args, commandRecorder);
          case 'create':
            return handleCreate(args, commandRecorder, executeToolCall, getKnownToolNames);
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
            return handleFinish(args, commandRecorder, executeToolCall, abortSignal);
          case 'insert':
            return handleInsert(args, commandRecorder);
          case 'addCheck':
            return responseWithOnce(await handleAddCheck(args, commandRecorder), 'REPLAY_ADD_CHECK_REPLY');
          case 'declare':
            return responseWithOnce(await handleDeclare(args, commandRecorder), 'REPLAY_DECLARE_REPLY');
          case 'pause':
            return handlePause(args, commandRecorder);
          case 'repair':
            return handleRepair(args, commandRecorder);
          case 'copy':
            return handleCopy(args, commandRecorder);
          case 'split':
            return handleSplit(args, commandRecorder);
          case 'adopt':
            return handleAdopt(args, commandRecorder);
          case 'search':
            return handleSearch(args, commandRecorder, executeToolCall);
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
  };

  return {
    replay: createTool(
      'Record and keep tool-call sequences; run executes them.',
      replaySchema,
      (args, abortSignal) => dispatch(args, abortSignal)
    ),
    run: createTool(
      'Run tool calls: steps written into this call, in one request, each step\'s reading returned; a saved sequence; a folder of them; or earlier calls again by history index.',
      runSchema,
      (args: RunArgs, abortSignal) => runAction(args, abortSignal)
    ),
  };

  /** A `run` call carried out by the `replay` action it names; `steps` without commands is refused before anything runs. */
  async function runAction(args: RunArgs, abortSignal?: AbortSignal): Promise<any> {
    if (args.action === 'steps' && !args.commands) {
      return createErrorResponse('MISSING_PARAMETER', {
        action: 'steps', missing: 'commands',
        message: 'The "steps" action requires "commands": the calls to run, [{ tool, params }].',
      });
    }
    if (args.action !== 'steps' && args.commands) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'commands', value: args.action,
        message: '"commands" belongs to the "steps" action; a saved sequence runs with "sequence" and its name.',
      });
    }
    return dispatch({ ...args, action: RUN_ACTIONS[args.action] } as ReplayArgs, abortSignal);
  }
}
