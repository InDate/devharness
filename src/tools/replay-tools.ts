/**
 * Command Replay Tools - Action router for sequence recording and playback
 */

import { z } from 'zod';
import { markOnProxies, getProxy } from '../proxy/registry.js';
import { tallyShapes } from '../proxy/intercept-proxy.js';

/** Bumped per repeat, so two in the same millisecond keep separate ids. */
let repeatSeq = 0;
import { announceSequenceSaved } from '../sequence-events.js';
import { selectSuiteFiles, sequenceFolders } from '../helpers/sequence-tree.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CommandRecorder, ActiveSequenceState, CommandSequence, RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { showReplayOverlay } from '../interaction-recorder.js';
import { getIssue } from '../issue-tracker.js';
import { deriveConnectionReference, sanitizeReference } from '../reference-validator.js';
import { normalizeProfileName } from '../chrome-launcher.js';
import { runRegistry, type RunRecord } from './replay-run-registry.js';

import {
  loadSequence,
  rebaseSequence,
  analyzeSequenceConnections,
  extractConnectionFromSequence,
  sequenceNeedsConnection,
  ensureConnection,
  navigateToStartUrl,
  executeSteps,
  executeSequenceWithPause,
  getDebugState,
  setReplayCursorCallbacks,
  injectReplayCursor,
  showClickEffect,
  showKeyPress,
  removeReplayCursor,
  autoLaunchChrome,
  commandNeedsBrowserConnection,
  analyzeRecordedStepConnections,
  commandTakesInjectedConnection,
  normalizeStepConnections,
  sanitizeConnectionMap,
  parseConnectionList,
  validateConditionSyntax,
  type ExecutionContext,
  type LoadSequenceResult,
} from './replay-executor.js';

// =============================================================================
// Step tool-name validation (bug-010)
// =============================================================================

/**
 * Step "tools" that the replay executor handles itself instead of dispatching
 * through the MCP tool map (see replay-executor.ts). These are always valid
 * step names even though they are not registered tools.
 */
const VIRTUAL_STEP_TOOLS = new Set(['conditional', 'forEach']);

/** Levenshtein distance, used only to suggest a likely intended tool name. */
function editDistance(a: string, b: string): number {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function suggestToolName(name: string, knownToolNames: string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const known of knownToolNames) {
    const distance = editDistance(lower, known.toLowerCase());
    if (distance <= 3 && (!best || distance < best.distance)) {
      best = { name: known, distance };
    }
  }
  return best?.name;
}

export interface UnknownStepTool {
  /** 1-based step number, matching the numbering used in run results */
  step: number;
  tool: string;
  suggestion?: string;
}

/**
 * Find sequence steps whose `tool` is not a registered tool name.
 *
 * Only NAMES are validated - step params are deliberately not checked against
 * the tools' zod schemas, because params legitimately contain interpolation
 * tokens ({{var:...}}, {{timestamp}}) that are only substituted at run time,
 * so a number-typed field can validly hold a string token at rest.
 */
export function findUnknownStepTools(
  commands: Array<{ tool?: unknown }>,
  knownToolNames: string[]
): UnknownStepTool[] {
  const known = new Set(knownToolNames);
  const unknown: UnknownStepTool[] = [];

  commands.forEach((cmd, i) => {
    const name = typeof cmd?.tool === 'string' ? cmd.tool : String(cmd?.tool);
    if (known.has(name) || VIRTUAL_STEP_TOOLS.has(name)) return;
    unknown.push({ step: i + 1, tool: name, suggestion: suggestToolName(name, knownToolNames) });
  });

  return unknown;
}

/**
 * Build the error response for a sequence containing unknown tool names.
 * Uses a plain response rather than a message template because there is no
 * template for this case yet (see report for the suggested SEQUENCE_UNKNOWN_TOOL entry).
 */
function unknownStepToolsError(
  action: string,
  sequenceName: string,
  unknown: UnknownStepTool[],
  knownToolNames: string[]
) {
  const plural = unknown.length === 1 ? '' : 's';
  const lines: string[] = [
    `Error: Sequence "${sequenceName}" references ${unknown.length} unknown tool name${plural}`,
    `The "${action}" action was rejected before any step ran, so no browser state was changed.`,
    '',
  ];

  for (const u of unknown) {
    lines.push(
      `- Step ${u.step}: \`${u.tool}\` is not a known tool${u.suggestion ? ` - did you mean \`${u.suggestion}\`?` : ''}`
    );
  }

  lines.push('');
  lines.push('**Fix:** correct the `tool` field on the listed step(s).');
  lines.push(`**Known tools:** ${knownToolNames.slice().sort().join(', ')}`);

  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Validate every step's tool name in a sequence. Returns an error response when
 * any name is unknown, or null when the sequence is fine (including when no
 * tool-name provider was supplied, which keeps validation opt-in).
 */
function validateSequenceToolNames(
  sequence: CommandSequence,
  action: string,
  getKnownToolNames?: () => string[]
) {
  if (!getKnownToolNames) return null;

  const knownToolNames = getKnownToolNames();
  if (!knownToolNames || knownToolNames.length === 0) return null;

  const unknown = findUnknownStepTools(sequence.commands ?? [], knownToolNames);
  if (unknown.length === 0) return null;

  return unknownStepToolsError(action, sequence.name, unknown, knownToolNames);
}

/**
 * Handle loadSequence error result - creates proper error response with template variables
 */
function handleLoadSequenceError(result: Extract<LoadSequenceResult, { success: false }>, action: string) {
  return createErrorResponse(result.errorCode, {
    action,
    message: result.error,
    ...result.templateVars
  });
}

import {
  formatExecutionResults,
  formatPausedResponse,
  formatDebugState,
  formatBreakpointHit,
  formatClickValidationFailure,
  extractTextVariables,
  formatVariablePrompt,
  formatHistory,
  formatSequenceCreated,
  formatSequenceList,
  formatSequenceDetails,
  formatSavedSequencesList,
  formatActiveStatus,
  formatStepResults,
  formatInsertPrompt,
  formatInsertResult,
  formatConditionalAdded,
  formatDeclarations,
  formatEventsForReview,
} from './replay-formatters.js';

import { readHistoryLines, getHistoryFilePath } from '../debug-logger.js';
import {
  startRecording,
  eventsToCommands,
  generateCondensedTimeline,
  isCommentEvent,
  type CommentCategory,
  type CommentEvent,
} from '../interaction-recorder.js';

import {
  addIssue,
  initializeTracker,
  saveIssueSequence,
} from '../issue-tracker.js';

import { configManager } from '../config.js';
import { hasTemplateToken } from './interpolation.js';
import { parseEnvFile } from '../helpers/env-file.js';
import { getProjectDir } from '../helpers/paths.js';
import { isAbsolute } from 'path';

// =============================================================================
// Schema Definition
// =============================================================================

const replaySchema = z.object({
  action: z.enum([
    'history', 'create', 'list', 'get', 'delete',
    'export', 'load', 'listSaved', 'deleteSaved',
    'run', 'runAll', 'step', 'finish', 'insert', 'addConditional', 'declare', 'status', 'cancel',
    'repeat', 'runFromLog',
    'recordInteraction'
  ]),
  limit: z.number().optional().describe('Max items (default:50)'),
  name: z.string().optional(),
  description: z.string().optional(),
  expectedOutcome: z.string().optional(),
  startUrl: z.string().optional().describe('create: sequence start URL. run: replace the stored startUrl for this run only (e.g. a freshly minted link)'),
  envFile: z.string().optional().describe("run/runAll: a KEY=value file supplying the {{env:NAME}} tokens this run resolves. A relative path resolves against the project directory (the one holding .devharness); absolute is used as-is. Its values WIN over the server's own environment, and the server's environment is never modified - two runs may name different files. A missing file, or a line that is neither blank, a # comment, nor NAME=value, fails before anything runs. Keeps a credential out of the sequence file and out of this call, and changing it needs no client restart"),
  baseUrl: z.string().optional().describe('run/runAll: retarget at another deployment — every absolute URL (startUrl, command params, a declared connection\u2019s launch url) keeps its path/query but takes this origin, in the sequence itself and in every sequence it reaches through a conditional or forEach. On runAll it applies to every sequence in the suite. Not preserved across a mid-run pause/step resume'),
  indices: z.array(z.number()).optional().describe('Command indices'),
  lines: z.array(z.number()).optional().describe('Log line numbers'),
  sequenceId: z.string().optional(),
  runId: z.string().optional().describe('status/cancel: address a specific background run by the id that run returned'),
  wait: z.boolean().optional().describe('run: block until the run completes and return the full result (pre-0.7 behaviour). Default false: return a runId immediately and execute in the background'),
  global: z.boolean().optional().describe('Use ~/.devharness/'),
  format: z.enum(['sequence', 'playwright', 'puppeteer']).optional(),
  filename: z.string().optional(),
  intoHistory: z.boolean().optional(),
  connectionReason: z.string().optional(),
  requiredConnections: z.array(z.object({
    reference: z.string().describe('Reference the steps use, e.g. "duo-member-two"'),
    profile: z.string().optional().describe('Named persistent Chrome profile to come up on (launchChrome({ profile })). The durable identity: its storage survives between runs, so a device enrolled once stays enrolled'),
    url: z.string().optional().describe("Opened on launch (defaults to the sequence's startUrl)"),
    role: z.string().optional().describe('Why this browser exists, shown in the run summary'),
    forceNewInstance: z.boolean().optional().describe('A distinct process rather than a tab. Default true, but false when profile is set - only one live Chrome may hold a profile'),
  }).strict()).optional().describe('declare: the browsers this sequence needs. Replaces the whole list; [] clears it'),
  tags: z.array(z.string()).optional().describe("declare: what kind of sequence this is, e.g. ['ui'] or ['contract','slow'] - replaces the whole list, [] clears it. runAll: run only sequences carrying at least one of these tags; the summary reports the split either way"),
  requiredSockets: z.array(z.string()).optional().describe("declare: URL substrings of the WebSockets this sequence's assertions ride on, e.g. ['/api/sync/socket']. Match the app's own path, not the origin, so it survives baseUrl. Replaces the whole list; [] clears it"),
  connections: z.record(z.string()).optional().describe("run: rebind a multi-connection sequence's recorded references onto this session - { \"<recorded reference>\": \"<reference here>\" }. Only needed when steps carry their own connectionReason (replay({action:'get', outputFormat:'commands'}) shows which)"),
  record: z.boolean().optional(),
  variables: z.record(z.string()).optional().describe("run/runAll: replace the text of recorded input-type steps. Keys are BUILT from the selector - var_<0-based step index>_<selector, non-alphanumerics replaced by _> - so '#password' at step 3 is 'var_3__password', two underscores; read them off `get` or off the prompt a run returns rather than composing them. A key naming no typed-text step is rejected (runAll checks against the whole suite's union). Reaches sequences a conditional or forEach nests into. For a credential prefer {{env:NAME}} in the step itself, which keeps the value out of the sequence file and out of this call; an explicit value here still wins over the environment"),
  stepTimeout: z.number().optional().describe('Per-step ms (default 30000). A step exceeding min(stepTimeout, remaining totalTimeout) fails the run at that step. wait steps are exempt (own timeoutMs) but still capped by totalTimeout'),
  totalTimeout: z.number().optional().describe('Total ms'),
  startFrom: z.number().optional().describe('Start step (1-indexed)'),
  stepTo: z.number().optional().describe('Pause after step'),
  stepCount: z.number().optional().describe('Steps to run'),
  insertIndices: z.array(z.number()).optional(),
  insertAfterStep: z.number().optional(),
  condition: z.string().optional().describe("addConditional: the guard, e.g. '{{selector:.cookie-banner}}' or '{{!localStorage:token}}'"),
  thenSequence: z.string().optional().describe('addConditional: name of the sequence to run when the condition holds'),
  rejoinAt: z.number().int().optional().describe('addConditional: 0-based step of THIS sequence to resume at once the branch has run, for a branch that replaces the steps between. Forward only - must be after the conditional itself. Omitted, the run resumes at the step after the conditional'),
  comment: z.string().optional().describe('addConditional: note stored on the step'),
  overwrite: z.boolean().optional(),
  newName: z.string().optional(),
  showOverlay: z.boolean().optional(),
  closeTabOnDone: z.boolean().optional()
    .describe('recordInteraction: whether finishing closes the tab (default:true). False leaves a tab the person was already working in'),
  simplifyEvents: z.boolean().optional().describe('recordInteraction: collapse noisy raw events (default:true)'),
  includeHovers: z.boolean().optional().describe('recordInteraction: keep mousemove steps (default:false)'),
  outputFormat: z.enum(['events', 'commands', 'review', 'puppeteer', 'playwright']).optional()
    .describe('get: commands|playwright|puppeteer. recordInteraction: events|commands|review (JSON dump, or a human-readable event walkthrough, appended to the summary)'),
  preferCoordinates: z.boolean().optional().describe('recordInteraction: emit x,y clicks instead of selectors (default:false)'),
  preferSelectors: z.boolean().optional().describe('recordInteraction: emit selector clicks even for canvas; wins over preferCoordinates (default:false)'),
  issueId: z.number().optional(),
  issueType: z.enum(['bug', 'feature']).optional(),
  issueTitle: z.string().optional(),
  showReplayOverlay: z.boolean().optional(),
  showAll: z.boolean().optional().describe('Show all sequences including completed/fixed issues'),
  requireSockets: z.boolean().optional().describe("run/runAll: fail the run if any WebSocket CLOSED or hit frame errors while it executed. Diffed against the start, so a socket already down is not blamed on this sequence, and it catches a drop that recovered before the last step - which a final assertion cannot see. Usually unnecessary: a sequence that sets `requiredSockets` (URL substrings of the sockets its assertions ride on) is checked without asking, and that check also fails when a declared socket is missing or never opened, which no closure count can detect"),
  strict: z.enum(['errors', 'warnings']).optional().describe("run/runAll: fail the run when it PRODUCES console output - 'errors' fails on new console errors, 'warnings' also fails on new warnings. Counted per connection and diffed against the start of the run, so pre-existing noise is not blamed on this sequence. A sequence can be functionally correct and still be logging; strict is how you separate those questions"),
  folder: z.string().optional().describe("runAll: sequences subfolder to run, relative to the sequences dir (e.g. 'spine'). Omit to run every sequence outside folders whose name starts with '_'. The whole tree is always LOADED first so name references (a conditional's then, a forEach's do) resolve wherever the helper lives"),
  continueOnFailure: z.boolean().optional().describe('runAll: keep going after a sequence fails and report every result (default true). false stops at the first failure'),
  killChromeOnFinish: z.boolean().optional().describe("run/runAll: after finishing (skipped on pause/abort), kill the browsers this run owns - its own connection plus any a launchChrome step actually created. A step that reached an already-bound reference only borrowed that browser and it is left running, so an instance you launched yourself survives. Also skipped for any browser whose port another live connection shares (a launchChrome step usually opens a tab in the same instance), and the run reports which connection kept it alive. On runAll only the LAST sequence carries it, so a preamble's browser survives between sequences and a suite that stops early leaves the browsers up."),
}).strict();

// =============================================================================
// Action Handlers
// =============================================================================

type ReplayArgs = z.infer<typeof replaySchema>;

async function handleHistory(args: ReplayArgs, recorder: CommandRecorder) {
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
 * Decide whether an explicit batch-level `connectionReason` may replace the
 * connections the commands were recorded against (`repeat`, `runFromLog`).
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

async function handleRepeat(
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
    commandNeedsBrowserConnection(cmd) && !cmd.params.connectionReason
  );
  let connectionReason = args.connectionReason;

  // An explicitly passed connectionReason must still mean "run these against
  // that connection" - history now retains the recorded one for every browser
  // command, so honouring only bare commands turned this documented parameter
  // into a silent no-op. It can only be honoured when the batch is
  // single-connection; overriding a two-browser batch is the collapse bug-018
  // is about, so that combination is refused rather than silently picking one.
  const override = resolveBatchOverride(commands, args.connectionReason, 'repeat');
  if ('error' in override) return override.error;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    // Check if any command creates a connection (launchChrome, connectDebugger)
    const launchCmd = commands.find(c => c.tool === 'launchChrome' || c.tool === 'connectDebugger');
    if (launchCmd && launchCmd.params.reference) {
      connectionReason = launchCmd.params.reference;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'repeat',
      missing: 'connectionReason',
      message: 'These commands require a browser connection. Provide connectionReason parameter.'
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
      if (connectionReason && commandNeedsBrowserConnection(cmd) &&
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

async function handleRunFromLog(
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
    commandNeedsBrowserConnection(cmd) && !cmd.params.connectionReason
  );
  let connectionReason = args.connectionReason;

  // Same rule as repeat: an explicit connectionReason retargets a
  // single-connection batch, and is refused for a multi-connection one.
  const override = resolveBatchOverride(commands, args.connectionReason, 'runFromLog');
  if ('error' in override) return override.error;

  // Try to extract connection from commands if not provided
  if (!connectionReason && needsConnection) {
    const launchCmd = commands.find(c => c.tool === 'launchChrome' || c.tool === 'connectDebugger');
    if (launchCmd && launchCmd.params.reference) {
      connectionReason = launchCmd.params.reference;
    }
  }

  if (!connectionReason && needsConnection) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'runFromLog',
      missing: 'connectionReason',
      message: 'These commands require a browser connection. Provide connectionReason parameter.'
    });
  }

  // Execute commands
  const results: Array<{ line: number; tool: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (const cmd of commands) {
    try {
      const params = { ...cmd.params };
      if (connectionReason && commandNeedsBrowserConnection(cmd) &&
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

async function handleCreate(args: ReplayArgs, recorder: CommandRecorder, getKnownToolNames?: () => string[]) {
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
  // portable and a run-level connectionReason still retargets it; keep it
  // per-step only where the sequence genuinely spans connections.
  const normalized = normalizeStepConnections(sequence.commands);
  (sequence as any).commands = normalized.commands;
  // Remember what was hoisted - `insert` needs it to tell a same-browser insert
  // from a cross-browser one (see handleInsert).
  if (normalized.hoisted) (sequence as any).recordedConnection = normalized.hoisted;
  const recordingProxy = normalized.hoisted ? getProxy(normalized.hoisted) : undefined;
  if (recordingProxy) {
    (sequence as any).recordedThroughProxy = true;
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
      const tally = tallyShapes(recordingProxy.eventsForCommand(command.recordedAt), rules);
      const traffic = (command.traffic ??= { requests: 0, failed: 0, opened: 0, writes: 0, lines: [] });
      traffic.shapes = tally.weight;
      traffic.seen = tally.seen;
      // Held from this command until its boundary was released, which is the
      // span it owns. The next command's timestamp stands in for a command
      // whose release has not been recorded - one still settling, or one from
      // a session that predates the release - and `create`'s own clock for the
      // last of those, which carries the pause before saving and reads long.
      const entry = recorder.getCommand(command.recordedAt);
      const began = entry?.timestamp;
      const nextAt = recorder.getCommand(command.recordedAt + 1)?.timestamp;
      const ended = entry?.releasedAt ?? nextAt ?? Date.now();
      if (began) traffic.windowMs = ended - began;
    }
    if (unmeasured.length > 0) {
      (sequence as any).shapesUnmeasured = unmeasured;
    }
  }

  const dropped = (sequence as any).shapesUnmeasured as number[] | undefined;
  const note = dropped
    ? `\n\nStep(s) ${dropped.join(', ')} carry no boundary evidence: the proxy had already dropped their events. Those steps are left out of the traffic comparison rather than compared against nothing.`
    : '';
  return { content: [{ type: 'text', text: formatSequenceCreated(sequence) + formatConnectionNote(normalized) + note }] };
}

/**
 * Re-stamp the connection that `create` hoisted off the steps, so a merged
 * command array is fully explicit about which browser each step belongs to.
 * Without this a sequence's own bare steps read as "ambiguous" the moment
 * anything connection-bearing is spliced in.
 */
function rehydrateStepConnections(sequence: CommandSequence): RecordedCommand[] {
  const recorded = sequence.recordedConnection;
  if (!recorded) return sequence.commands;
  return sequence.commands.map(cmd =>
    commandTakesInjectedConnection(cmd) && !cmd.params.connectionReason
      ? { ...cmd, params: { ...cmd.params, connectionReason: recorded } }
      : cmd
  );
}

/**
 * What `create`/`insert` did with the recorded per-step connections, and what the
 * user has to do about it on `run`. A multi-connection sequence is only portable
 * if its references are rebound, and an ambiguous ("mixed") recording is worth
 * saying out loud rather than guessing at.
 */
function formatConnectionNote(normalized: ReturnType<typeof normalizeStepConnections>): string {
  const { analysis, hoisted } = normalized;
  const notes: string[] = [];

  if (hoisted) {
    return `\n\n**Connection:** every step ran against \`${hoisted}\`, so it was hoisted off the steps` +
      ` - the sequence is portable and \`replay({ action: 'run', connectionReason: '<other>' })\` retargets it.`;
  }

  if (analysis.multiConnection) {
    notes.push(`\n\n**Multi-connection sequence:** steps keep their own connections (${analysis.references.map(r => `\`${r}\``).join(', ')}),` +
      ` so the recorded interleaving is reproduced instead of collapsing into one browser.` +
      ` A run-level \`connectionReason\` does NOT override them; in another session rebind them with` +
      ` \`replay({ action: 'run', name: '...', connections: { ${analysis.references.map(r => `"${r}": "<reference here>"`).join(', ')} } })\`.` +
      ` A reference that doesn't exist at run time fails that step rather than falling back.`);
  }

  // NOT an else-if. A sequence can be both, and that combination is the most
  // dangerous one: bare steps in a two-browser sequence take whatever the
  // run-level connection happens to be, so the same sequence sends them to a
  // different browser depending on how it is run - silently, and green either
  // way. Returning early on multiConnection used to make this warning
  // unreachable in exactly the case that needs it.
  if (analysis.mixed) {
    notes.push(`\n\n**${analysis.multiConnection ? 'Some steps name no connection' : 'Mixed connections'}:** ` +
      `steps naming ${analysis.references.map(r => `\`${r}\``).join(', ')} are pinned, but other browser steps name none` +
      ` (they ran against whichever connection was active at record time, which is not recorded).` +
      ` Those bare steps take the run-level connection, so ${analysis.multiConnection
        ? `they land in a DIFFERENT browser depending on the run-level \`connectionReason\` - and the run still reports success either way.`
        : `a run-level \`connectionReason\` retargets them while the named steps stay put.`}` +
      ` Re-record passing \`connectionReason\` on every step to make this deterministic.`);
  }

  return notes.join('');
}

async function handleList(args: ReplayArgs, recorder: CommandRecorder) {
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

async function handleGet(args: ReplayArgs, recorder: CommandRecorder) {
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

async function handleDelete(args: ReplayArgs, recorder: CommandRecorder) {
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

async function handleExport(args: ReplayArgs, recorder: CommandRecorder) {
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

async function handleLoad(args: ReplayArgs, recorder: CommandRecorder, getKnownToolNames?: () => string[]) {
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

async function handleListSaved(args: ReplayArgs, recorder: CommandRecorder) {
  const savedSequences = await recorder.listSavedSequencesOnDisk();
  const issueSequences = await listIssueSequencesOrEmpty(recorder);
  const showAll = args.showAll ?? false;
  return { content: [{ type: 'text', text: formatSavedSequencesList(savedSequences, issueSequences, showAll) }] };
}

async function handleDeleteSaved(args: ReplayArgs, recorder: CommandRecorder) {
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

type RunOutcome = 'completed' | 'failed' | 'paused' | 'cancelled';

interface PerformRunDeps {
  args: ReplayArgs;
  recorder: CommandRecorder;
  executeToolCall: ExecuteToolCall;
  getPageForConnection: (connectionReason: string) => Promise<any>;
  getConnectionPort?: (connectionReason: string) => Promise<number | null>;
  sequence: CommandSequence;
  analysis: ReturnType<typeof analyzeSequenceConnections>;
  connectionReason: string | undefined;
  needsConnection: boolean;
  /** Recorded-reference -> this-session-reference rebinding (args.connections). */
  connectionMap?: Record<string, string>;
  /** Filled in by the executor: references the run's own steps launched. */
  launchedConnections: Set<string>;
  /** Values read from args.envFile, resolved before process.env by {{env:NAME}}. */
  runEnv?: Record<string, string>;
}

/**
 * Live connection references sharing `port`, excluding `self`. Empty when the
 * session cannot be read - an unreadable list must not stop a requested kill,
 * only a KNOWN co-tenant does.
 */
async function connectionsSharingPort(
  executeToolCall: ExecuteToolCall,
  port: number,
  self: string
): Promise<string[]> {
  try {
    const result: any = await executeToolCall('listConnections', {});
    const parsed = parseConnectionList(result?.content?.[0]?.text || '');
    if (!parsed) return [];
    return parsed
      .filter(c => c.port === port
        && c.connected !== false
        && sanitizeReference(c.reference) !== sanitizeReference(self))
      .map(c => c.reference);
  } catch {
    return [];
  }
}

/**
 * References that sequences reached through `conditional` steps name, for
 * validating `connections`. Resolution is memory-only and best-effort: a
 * sequence that lives on disk isn't loaded here (that would register it as a
 * side effect of validation), so `complete: false` says "this list may be
 * short" and the caller must not treat a missing key as a typo.
 */
function collectNestedRebindableReferences(
  commands: RecordedCommand[],
  recorder: CommandRecorder,
  depth = 0,
  seen = new Set<string>()
): { references: string[]; complete: boolean } {
  // Must track the executor's own cap, not a hardcoded copy: with a raised
  // maxConditionalDepth, references at runtime-reachable depths would be
  // omitted while `complete` still claimed the list was exhaustive, and a valid
  // rebinding key would be rejected as a typo.
  if (depth >= configManager.getReplayConfig().maxConditionalDepth) {
    return { references: [], complete: false };
  }

  const references: string[] = [];
  let complete = true;

  for (const cmd of commands) {
    if (cmd.tool !== 'conditional') continue;
    const then = typeof cmd.params?.then === 'string' ? cmd.params.then : undefined;
    if (!then || seen.has(then)) continue;
    seen.add(then);

    const nested = recorder.listSequences().find(s => s.name === then);
    if (!nested) { complete = false; continue; }

    references.push(...analyzeRecordedStepConnections(nested.commands).references);
    for (const c of nested.commands) {
      if ((c.tool === 'launchChrome' || c.tool === 'connectDebugger') && typeof c.params.reference === 'string') {
        references.push(sanitizeReference(c.params.reference));
      }
    }

    const deeper = collectNestedRebindableReferences(nested.commands, recorder, depth + 1, seen);
    references.push(...deeper.references);
    complete = complete && deeper.complete;
  }

  return { references, complete };
}

/**
 * Read the run's `envFile` into the values {{env:NAME}} resolves against.
 *
 * Loaded here, before any side effects, so a missing file or a malformed line
 * fails the run as a parameter error rather than as a step failure halfway
 * through a flow that has already logged in. The values stay on the run's
 * context: writing them into process.env would leak one run's credentials into
 * every concurrent background run, which name their own files.
 */
async function loadRunEnv(
  envFile: string
): Promise<{ values: Record<string, string> } | { error: string }> {
  const path = isAbsolute(envFile) ? envFile : join(getProjectDir(), envFile);
  let text: string;
  try {
    text = await fs.readFile(path, 'utf-8');
  } catch (err: any) {
    return { error: `Could not read envFile "${envFile}" (resolved to ${path}): ${err?.code === 'ENOENT' ? 'no such file' : err?.message || String(err)}` };
  }

  const { values, problems } = parseEnvFile(text);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map(p => `line ${p.line}: ${p.text}`).join('; ');
    return { error: `envFile "${envFile}" (resolved to ${path}) has ${problems.length} line(s) that are neither blank, a # comment, nor NAME=value with a name matching [A-Za-z_][A-Za-z0-9_]* - ${shown}${problems.length > 3 ? ', ...' : ''}. A skipped line reads as a set variable, so the run stops here.` };
  }

  return { values };
}

/**
 * Every `variables` key a run could substitute on: this sequence's typed-text
 * steps plus those of every sequence it reaches through a `conditional`'s
 * `then` or a `forEach`'s `do`.
 *
 * Resolution is memory-only and best-effort, the same rule
 * collectNestedRebindableReferences follows: a helper that lives on disk and
 * has not been loaded is not loaded here (that would register it as a side
 * effect of validation), so `complete: false` says "this list may be short"
 * and the caller must not call a missing key a typo. `runAll` loads the whole
 * tree before it runs anything, so a suite run always gets a complete list.
 */
function collectVariableKeys(
  commands: RecordedCommand[],
  recorder: CommandRecorder,
  depth = 0,
  seen = new Set<string>()
): { keys: Set<string>; complete: boolean } {
  const keys = new Set(Object.keys(extractTextVariables(commands)));
  // Must track the executor's own cap: with a raised maxConditionalDepth, keys
  // at runtime-reachable depths would be omitted while `complete` still claimed
  // the list was exhaustive, and a valid key would be rejected as a typo.
  if (depth >= configManager.getReplayConfig().maxConditionalDepth) {
    return { keys, complete: false };
  }

  let complete = true;
  for (const cmd of commands) {
    const named = cmd.tool === 'conditional' ? cmd.params?.then
      : cmd.tool === 'forEach' ? cmd.params?.do
      : undefined;
    if (typeof named !== 'string' || !named || seen.has(named)) continue;
    seen.add(named);

    const nested = recorder.listSequences().find(sq => sq.name === named);
    if (!nested) { complete = false; continue; }

    const deeper = collectVariableKeys(nested.commands, recorder, depth + 1, seen);
    for (const key of deeper.keys) keys.add(key);
    complete = complete && deeper.complete;
  }

  return { keys, complete };
}

/**
 * Keys the caller supplied that name no typed-text step anywhere the run can
 * reach. Empty when the key list could not be resolved in full, because a key
 * valid for an unloaded helper is not a typo.
 *
 * A `variables` key is matched exactly and nothing else looks at it, so an
 * unmatched key used to be dropped in silence: the step ran on its RECORDED
 * text while the call read as an override. For a recorded credential that
 * means the old password reaching the live app with the run reporting success.
 * Same rule the `connections` rebinding already applies to a reference that
 * names no recorded step.
 */
function unmatchedVariableKeys(
  supplied: Record<string, string>,
  commands: RecordedCommand[],
  recorder: CommandRecorder
): { unmatched: string[]; known: string[] } {
  const { keys, complete } = collectVariableKeys(commands, recorder);
  if (!complete) return { unmatched: [], known: [...keys].sort() };
  return {
    unmatched: Object.keys(supplied).filter(k => !keys.has(k)),
    known: [...keys].sort(),
  };
}

/**
 * Run every sequence in a folder, in filename order, and report one line each.
 *
 * Two behaviours make this usable as a suite runner rather than a loop:
 *  - the ENTIRE tree is loaded before anything runs, so a sequence in spine/
 *    can still reference a helper in _helpers/ by name (conditional `then`,
 *    forEach `do`) — those resolve by sequence NAME, not by path;
 *  - a failure is recorded and the run continues (continueOnFailure, default
 *    true). A suite that stops at the first red tells you far less than one
 *    that finishes and shows you all of them.
 *
 * Folders whose name starts with '_' are loaded but never run on their own —
 * that is where preamble/helper sequences live, which are meaningless in
 * isolation and would fail if executed standalone.
 */
async function handleRunAll(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connectionReason: string) => Promise<any>,
  abortSignal?: AbortSignal,
  getConnectionPort?: (connectionReason: string) => Promise<number | null>
) {
  // Stay inside ONE root. listSavedSequencesOnDisk merges the project dir with
  // ~/.devharness/sequences, and a bare runAll that swept in the user's global
  // sequences would execute unrelated suites from other projects — and a name
  // colliding across the two roots would select twice.
  const wantLocation = args.global ? 'global' : 'working-dir';
  const onDisk = (await recorder.listSavedSequencesOnDisk())
    .filter(e => e.location === wantLocation);
  if (onDisk.length === 0) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'folder',
      value: String(args.folder ?? ''),
      message: `No sequences found in the ${args.global ? 'global (~/.devharness/sequences)' : 'project'} sequences directory. Export or record one first${args.global ? '' : ', or pass global:true to run the global ones'}.`
    });
  }

  // Load everything first so cross-folder name references resolve.
  for (const entry of onDisk) {
    await recorder.loadSequenceFromDisk(entry.fullPath);
  }

  const folder = (args.folder || '').replace(/^\/+|\/+$/g, '');
  const chosen = new Set(selectSuiteFiles(onDisk.map(e => e.filename), folder));
  const tagsOf = (name: string) => recorder.listSequences().find(s => s.name === name)?.tags ?? [];

  // Tag selection runs after the folder pick, so `folder` and `tags` compose:
  // "the ui sequences in spine/" is one call, not a choice between two axes.
  let wantTags: string[] = [];
  if (args.tags !== undefined) {
    const cleaned = normalizeTags(args.tags);
    if ('error' in cleaned) {
      return createErrorResponse('INVALID_PARAMETER', { parameter: 'tags', value: args.tags.join(', '), message: cleaned.error });
    }
    wantTags = cleaned.tags;
  }

  const inFolder = onDisk
    .filter(e => chosen.has(e.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const selected = wantTags.length === 0
    ? inFolder
    : inFolder.filter(e => tagsOf(e.name).some(t => wantTags.includes(t)));

  if (wantTags.length > 0 && selected.length === 0) {
    const available = [...new Set(inFolder.flatMap(e => tagsOf(e.name)))].sort();
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'tags',
      value: wantTags.join(', '),
      message: `No sequence ${folder ? `under "${folder}" ` : ''}carries ${wantTags.length > 1 ? 'any of those tags' : `the tag "${wantTags[0]}"`}. ` +
        (available.length
          ? `Tags in use here: ${available.join(', ')}.`
          : `No sequence here is tagged yet - set one with replay({ action: 'declare', name: '...', tags: ['ui'] }).`),
    });
  }

  if (selected.length === 0) {
    const folders = sequenceFolders(onDisk.map(e => e.filename));
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'folder',
      value: folder,
      message: `No sequences under "${folder}". ` +
        (folders.length ? `Available folders: ${folders.join(', ')}.` : 'No subfolders exist yet — sequences are all at the top level.')
    });
  }

  // One `variables` map covers the whole suite, so a key is a typo only when it
  // matches NO member. Checked once, before anything runs: a supplied key that
  // lands nowhere is dropped in silence by the executor and every sequence runs
  // on its recorded text, which for a credential means the recorded one reaching
  // the live app with the suite reporting green. The whole tree is in memory by
  // now, so the union is exhaustive.
  if (args.variables && Object.keys(args.variables).length > 0) {
    const suiteKeys = new Set<string>();
    for (const entry of selected) {
      const seq = recorder.listSequences().find(sq => sq.name === entry.name);
      if (!seq) continue;
      for (const key of collectVariableKeys(seq.commands, recorder).keys) suiteKeys.add(key);
    }
    const unmatched = Object.keys(args.variables).filter(k => !suiteKeys.has(k));
    if (unmatched.length > 0) {
      const known = [...suiteKeys].sort();
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'variables',
        value: unmatched.join(', '),
        message: `${unmatched.length > 1 ? 'Those keys name' : `"${unmatched[0]}" names`} no typed-text step in any sequence this run selects. ` +
          `The key is BUILT from the selector - var_<0-based step index>_<selector, non-alphanumerics replaced by _> - so "#password" at step 3 is "var_3__password", with two underscores. ` +
          (known.length
            ? `Substitutable across this suite: ${known.join(', ')}.`
            : `No sequence here has typed text to substitute.`),
      });
    }
  }

  const keepGoing = args.continueOnFailure !== false;
  const results: Array<{ filename: string; name: string; ok: boolean; detail: string }> = [];

  for (const [index, entry] of selected.entries()) {
    // killChromeOnFinish means the SUITE's finish here, not each sequence's: a
    // teardown between sequences destroys the state a _helpers preamble just
    // established. Only the last sequence carries it, so a suite that stops
    // early (continueOnFailure: false, a cancel) leaves the browsers up for
    // the failure to be read in.
    const isLast = index === selected.length - 1;
    if (abortSignal?.aborted) {
      results.push({ filename: entry.filename, name: entry.name, ok: false, detail: 'cancelled before it ran' });
      continue;
    }
    let ok = false;
    let detail = '';
    try {
      // Reuse handleRun so a suite run and a single run cannot drift apart.
      const res: any = await handleRun(
        {
          ...args,
          action: 'run',
          folder: undefined,
          continueOnFailure: undefined,
          name: undefined,
          sequenceId: entry.id,
          wait: true,
          // A suite has nobody to answer a prompt. Keeping the recorded values
          // is the only unattended behaviour that still runs the sequence;
          // leaving it undefined turns every parameterised sequence into a
          // no-op that a caller then has to notice.
          variables: args.variables ?? {},
          // Per-run args that are actively wrong when fanned across a suite:
          // startFrom/stepTo/stepCount/startUrl mean something only for one
          // specific sequence. baseUrl does carry - it retargets every
          // sequence at the same deployment, which is what a suite run of a
          // recorded set against another environment needs.
          killChromeOnFinish: isLast ? args.killChromeOnFinish : undefined,
          startFrom: undefined,
          stepTo: undefined,
          stepCount: undefined,
          startUrl: undefined,
        },
        recorder, executeToolCall, getPageForConnection, abortSignal, getConnectionPort,
        { validateVariableKeys: false }
      );
      const text = (res?.content || []).map((c: any) => c?.text || '').join('\n');
      // performRun stamps _meta.replay on every terminal response, so trust that
      // over the prose. Regexing for a line starting with "Error:" both misses
      // non-run outcomes (a variables prompt, a pause) and misfires on any step
      // output that happens to echo one.
      const meta = res?._meta?.replay;
      if (meta && typeof meta.success === 'boolean') {
        ok = meta.success === true && meta.paused !== true && meta.prompted !== true;
        detail = meta.prompted
          ? 'did not run: it has recorded variables and none were supplied — pass variables:{} to keep the recorded values'
          : meta.paused
            ? 'did not finish: the run PAUSED (stepTo, a breakpoint, or click validation) and is still open'
            : (text.match(/\*\*Socket health failed\*\*[\s\S]*?(?=\n\n\*\*|$)/)?.[0]?.replace(/\s+/g, ' ').slice(0, 200)
             || text.match(/\*\*Strict run failed\*\*[\s\S]*/)?.[0]?.replace(/\s+/g, ' ').slice(0, 200)
             || text.match(/^\s*Error:.*$/m)?.[0]
             || `failed at ${meta.failedSteps ?? '?'} step(s)`).trim();
      } else {
        // No _meta means this was not a terminal run response at all.
        ok = false;
        detail = (text.match(/^\s*Error:.*$/m)?.[0] || text.split('\n')[0] || 'no run result').trim();
      }
    } catch (err: any) {
      ok = false;
      detail = `threw: ${err?.message || String(err)}`;
    }
    results.push({ filename: entry.filename, name: entry.name, ok, detail });
    if (!ok && !keepGoing) break;
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  const scope = [
    folder ? `folder "${folder}"` : 'all sequences',
    wantTags.length ? `tagged ${wantTags.join(' or ')}` : '',
  ].filter(Boolean).join(', ');

  // What the suite actually covered, reported every run rather than needing an
  // audit to discover: "36 passed" reads as interface coverage whether or not
  // any of it drove the interface.
  const tagCounts = new Map<string, number>();
  let untagged = 0;
  for (const r of results) {
    const tags = tagsOf(r.name);
    if (tags.length === 0) untagged++;
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const split = [
    ...[...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => `${n} ${tag}`),
    ...(untagged > 0 ? [`${untagged} untagged`] : []),
  ].join(', ');
  const lines = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.filename}${r.ok ? '' : `  — ${r.detail}`}`);
  const skipped = selected.length - results.length;

  return {
    content: [{
      type: 'text',
      text: [
        `runAll ${scope}: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} not run (stopped at first failure)` : ''}` +
          (split ? ` (${split})` : ''),
        '',
        ...lines,
        '',
        `Loaded ${onDisk.length} sequence(s) from disk; ran ${results.length}.`,
      ].join('\n')
    }],
    ...(failed > 0 ? { isError: true } : {})
  };
}

/**
 * Launch the browsers a sequence declares it needs, if they are not live yet.
 *
 * Naming a connection on a step does not create it. Without this, a
 * multi-browser sequence runs only when someone has already opened those
 * browsers by hand — so an unattended suite run skips precisely the coverage
 * that a single browser cannot provide.
 *
 * A caller's `connections` rebinding wins: the declaration supplies a default
 * browser, it does not override where the caller wants the steps pointed.
 */
/**
 * Connections a sequence actually loads the app in - the ones a declared
 * WebSocket could plausibly belong to.
 *
 * A navigate step names its connection or takes the run's; either way the app
 * comes up there and its sockets open. Everything else (asserting a captured
 * value, waiting, inspecting) can take a connection without ever giving the
 * transport a page to live on, so counting those made an idle browser look
 * driven and failed the run for a socket nothing had asked it to open.
 *
 * Empty when the sequence never navigates - it is then driving a page someone
 * else loaded, and the caller falls back to the wider rule rather than
 * silently checking nothing.
 */
function navigatedConnections(commands: RecordedCommand[], runConnection: string | undefined): string[] {
  const refs: string[] = [];
  for (const cmd of commands) {
    if (cmd.tool !== 'navigate') continue;
    const raw = cmd.params?.connectionReason;
    const ref = typeof raw === 'string' && raw.trim() ? sanitizeReference(raw) : runConnection;
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * Reject a declaration set whose profiles cannot mean what it says, before
 * anything is launched.
 *
 * Two failures, both of which would otherwise surface later as something else:
 *
 * - **Two references on one profile.** Only one live Chrome may hold a profile,
 *   so the second launch fails - but the message would be about ports, not
 *   about a sequence asking two identities to be the same browser. Same shape
 *   as the `connections` rule that refuses collapsing two references into one.
 *
 * - **Rebinding a profile-bearing reference.** A rebind normally wins, because
 *   a declaration is only a default. A profile is not a default, it is an
 *   identity claim: pointing "device-a" at some other browser runs device-a's
 *   steps somewhere that is not device-a, and the run reports success. That is
 *   the class of lie the per-step connection rules exist to prevent.
 */
function declaredProfileConflict(
  declared: NonNullable<CommandSequence['requiredConnections']>,
  connectionMap: Record<string, string> | undefined
): string | null {
  const byProfile = new Map<string, string[]>();
  for (const decl of declared) {
    if (!decl.profile) continue;
    const reference = sanitizeReference(decl.reference);
    if (!reference) continue;

    const rebound = connectionMap?.[reference];
    if (rebound) {
      return `"${reference}" is declared on the persistent profile "${decl.profile}", so it names a specific browser identity, ` +
        `not a default - rebinding it onto "${rebound}" would run its steps in a browser that is not "${decl.profile}" and pass. ` +
        `Drop it from \`connections\`, or drop the profile from the declaration.`;
    }

    byProfile.set(decl.profile, [...(byProfile.get(decl.profile) || []), reference]);
  }

  for (const [profile, references] of byProfile) {
    if (references.length > 1) {
      return `${references.length} declared connections (${references.join(', ')}) name the same persistent profile "${profile}". ` +
        `Only one live Chrome may hold a profile, so they would be one browser - give each identity its own profile.`;
    }
  }
  return null;
}

async function ensureDeclaredConnections(
  sequence: CommandSequence,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connectionReason: string) => Promise<any>,
  connectionMap: Record<string, string> | undefined
): Promise<{ launched: string[]; error?: string; invalid?: boolean }> {
  const declared = sequence.requiredConnections;
  if (!Array.isArray(declared) || declared.length === 0) return { launched: [] };

  const conflict = declaredProfileConflict(declared, connectionMap);
  if (conflict) return { launched: [], error: `"${sequence.name}": ${conflict}`, invalid: true };

  const launched: string[] = [];
  for (const decl of declared) {
    const wanted = sanitizeReference(decl.reference);
    if (!wanted) continue;
    // Rebound onto an existing session connection: nothing to launch.
    const target = connectionMap?.[wanted] ?? wanted;
    if (connectionMap?.[wanted]) continue;

    // Probing first is not enough: a reference can still resolve to a page after
    // the browser was killed out of band, and skipping the launch then fails the
    // first step that uses it. Attempt the launch and treat "already bound" as a
    // live browser to reuse.
    try {
      await executeToolCall('launchChrome', {
        reference: target,
        url: decl.url ?? sequence.startUrl,
        // A profile IS the browser this declaration wants, so a live Chrome
        // already running it is the target rather than something to spawn
        // beside - and only one Chrome may hold a profile, so forcing a second
        // process fails against the browser it was asking for.
        forceNewInstance: decl.profile
          ? decl.forceNewInstance === true
          : decl.forceNewInstance !== false,
        ...(decl.profile && { profile: decl.profile }),
      });
      launched.push(target);
    } catch (err: any) {
      const message = String(err?.message || err);
      if (/already bound/i.test(message)) {
        try {
          if (await getPageForConnection(target)) continue;
        } catch { /* fall through to the error below */ }
      }
      return {
        launched,
        error: `"${sequence.name}" needs the browser "${target}"${decl.role ? ` (${decl.role})` : ''} and launching it failed: ${err?.message || String(err)}`,
      };
    }
  }
  return { launched };
}

/**
 * Close browsers this run launched from a sequence's requiredConnections.
 *
 * The run created them, so the run owns them. Anything the caller supplied is
 * left alone. Without this a suite leaves a browser behind per multi-browser
 * sequence, and the next run silently reuses one holding state from before —
 * which is worse than the clutter, because it looks like a fresh browser.
 */
async function closeLaunchedConnections(
  launched: string[],
  executeToolCall: ExecuteToolCall,
  getConnectionPort: ((connectionReason: string) => Promise<number | null>) | undefined,
  sequenceName: string,
  /** How the run came to own these, for the kill reason and the closing note. */
  origin: string = 'declared and launched'
): Promise<string> {
  if (launched.length === 0 || !getConnectionPort) return '';
  const closed: string[] = [];
  for (const ref of launched) {
    try {
      const port = await getConnectionPort(ref);
      if (port === null) continue;
      const sharers = await connectionsSharingPort(executeToolCall, port, ref);
      if (sharers.length > 0) continue; // someone else is on this browser
      await executeToolCall('killChrome', { reason: `sequence "${sequenceName}" ${origin} ${ref}`, port });
      // Release the reference as well. Killing the process leaves the name
      // bound, and the next sequence in a suite declaring the same reference
      // then fails to launch against a browser that no longer exists.
      await executeToolCall('disconnectDebugger', { reference: ref }).catch(() => {});
      closed.push(ref);
    } catch {
      // Best-effort: a browser that will not close is not a run failure.
    }
  }
  return closed.length ? `\n\n**Browsers closed** (${origin}): ${closed.join(', ')}` : '';
}

/**
 * Declared-browser cleanups owed by a run that PAUSED, keyed by run id (or by
 * sequence id for a `wait: true` pause, which registers no run record).
 *
 * A pause is the one outcome that deliberately keeps its browsers - they are
 * the state someone stopped to inspect. Every way out of a pause is terminal
 * though (cancel, step to the end, finish), and each used to drop the launched
 * references on the floor: the browsers stayed up and the next run reused one
 * carrying the previous run's state (issue #127).
 */
const pendingDeclaredCleanups = new Map<string, () => Promise<string>>();

const cleanupKey = (runId: string | undefined, sequenceId: string) => runId ?? `seq:${sequenceId}`;

/** Run and forget the cleanup a paused run left owing, if any. */
async function drainDeclaredCleanup(runId: string | undefined, sequenceId: string): Promise<string> {
  const key = cleanupKey(runId, sequenceId);
  const cleanup = pendingDeclaredCleanups.get(key);
  if (!cleanup) return '';
  pendingDeclaredCleanups.delete(key);
  return cleanup().catch(() => '');
}

/** Console error/warning counts per connection, for a strict run's before/after. */
async function snapshotConsole(
  refs: string[],
  executeToolCall: ExecuteToolCall
): Promise<Record<string, { errors: number; warnings: number }>> {
  const out: Record<string, { errors: number; warnings: number }> = {};
  for (const ref of refs) {
    try {
      const res: any = await executeToolCall('console', { action: 'list', limit: 1, connectionReason: ref });
      out[ref] = {
        errors: res?._meta?.console?.errorCount || 0,
        warnings: res?._meta?.console?.warnCount || 0,
      };
    } catch {
      // A connection that cannot be read yet contributes nothing to the diff.
    }
  }
  return out;
}

/**
 * What a strict run should fail on: console output the sequence PRODUCED.
 *
 * Counted per connection and diffed against the start of the run, so noise that
 * was already on the page is not blamed on this sequence. Warnings count only
 * when strict is 'warnings' — a sequence can be functionally correct and still
 * be logging, and those are different questions.
 */
function strictConsoleFailures(
  before: Record<string, { errors: number; warnings: number }>,
  after: Record<string, { errors: number; warnings: number }>,
  includeWarnings: boolean
): string[] {
  const out: string[] = [];
  for (const ref of Object.keys(after)) {
    const b = before[ref] || { errors: 0, warnings: 0 };
    const errs = after[ref].errors - b.errors;
    const warns = after[ref].warnings - b.warnings;
    if (errs > 0) out.push(`${ref}: ${errs} new console error(s)`);
    if (includeWarnings && warns > 0) out.push(`${ref}: ${warns} new console warning(s)`);
  }
  return out;
}

/** One socket as the health diff sees it. */
interface SocketSnapshot {
  id: string;
  url: string;
  target: string;
  closed: boolean;
  errors: number;
  /** Went away with its target rather than closing on its own. */
  closedWithTarget?: boolean;
  /** The page hung up on purpose, rather than losing the transport. */
  clientClosed?: boolean;
  closedWithDocument?: boolean;
}

/**
 * Every WebSocket per connection, for a run's before/after comparison.
 *
 * A connection that cannot be read is recorded as unreadable rather than
 * omitted. Omitting it silently disables the health check for that connection -
 * a run then passes because nothing was measured, which is the exact failure
 * the check exists to prevent.
 */
async function snapshotSockets(
  refs: string[],
  executeToolCall: ExecuteToolCall
): Promise<Record<string, SocketSnapshot[] | { unreadable: string }>> {
  const out: Record<string, SocketSnapshot[] | { unreadable: string }> = {};
  for (const ref of refs) {
    try {
      const res: any = await executeToolCall('network', { action: 'sockets', connectionReason: ref });
      const list = res?._meta?.socketList;
      out[ref] = Array.isArray(list)
        ? list
        : { unreadable: res?.isError ? firstLine(res) : 'socket health was not reported' };
    } catch (error: any) {
      out[ref] = { unreadable: error?.message || String(error) };
    }
  }
  return out;
}

/** First line of a tool response's text, for embedding in a failure message. */
function firstLine(res: any): string {
  const text = res?.content?.[0]?.text;
  return typeof text === 'string' ? text.split('\n')[0].slice(0, 120) : 'unreadable';
}

/** Shorten a socket URL for a failure message - the path is the identifying part. */
function socketLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 80) || url;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Socket problems a run CAUSED, per socket.
 *
 * Diffed against the start so a socket that was already dead is not blamed on
 * this sequence. Two failures, and the sequence's declaration decides which
 * sockets are in scope:
 *
 *  - one it depends on closed or hit frame errors mid-run. No assertion written
 *    as a final step can see this: the app keeps rendering its last synced
 *    snapshot after the socket dies, and a drop that recovered before the last
 *    step leaves no trace at all.
 *  - a declared socket is not open at the end. Absence and health are otherwise
 *    indistinguishable - a transport that never came up closes nothing, so
 *    counting closures alone passes an app that never connected.
 *
 * With no declaration (`requireSockets: true` on the run) every socket is in
 * scope for closures, but nothing can be required to exist - which socket ought
 * to be there is exactly what the declaration carries.
 *
 * Absence is returned separately because it is the one verdict worth waiting
 * on: sampled the instant the last step ends, it catches an app mid-reconnect
 * and calls a recovering transport a dead one. Closures and frame errors are
 * already-happened facts and never resolve by waiting.
 */
function socketFailures(
  before: Record<string, SocketSnapshot[] | { unreadable: string }>,
  after: Record<string, SocketSnapshot[] | { unreadable: string }>,
  required: string[],
  requiredOn: string[]
): { settled: string[]; absent: string[] } {
  const out: string[] = [];
  const absent: string[] = [];
  const inScope = (url: string) => required.length === 0 || required.some(m => url.includes(m));
  const list = (v: SocketSnapshot[] | { unreadable: string } | undefined): SocketSnapshot[] =>
    Array.isArray(v) ? v : [];

  for (const ref of Object.keys(after)) {
    const afterEntry = after[ref];
    if (!Array.isArray(afterEntry)) {
      out.push(`${ref}: could not read socket health - ${afterEntry.unreadable}`);
      continue;
    }
    const was = new Map(list(before[ref]).map(s => [s.id, s]));
    const now = afterEntry;

    for (const sock of now) {
      if (!inScope(sock.url)) continue;
      const prev = was.get(sock.id);
      // Three closes this run did not cause, all of them normal:
      //  - already closed before the run started;
      //  - torn down with its target, since a `navigate` replaces the page's
      //    workers and takes their sockets with it;
      //  - taken with its document by a main-frame navigation the run drove;
      //  - hung up by the page itself. Chrome delivers no signal for a close()
      //    on a live document, so that one is caught only where the document
      //    went with it, and a sign-out mid-run still reports here.
      // Whether a socket came back afterwards is the end-state check's
      // question, not this one's.
      const deliberate = sock.closedWithTarget || sock.closedWithDocument || sock.clientClosed;
      if (sock.closed && !deliberate && !prev?.closed) {
        out.push(`${ref}: ${socketLabel(sock.url)} [${sock.target}] closed during the run`);
      }
      const newErrors = sock.errors - (prev?.errors || 0);
      if (newErrors > 0) {
        out.push(`${ref}: ${socketLabel(sock.url)} [${sock.target}] hit ${newErrors} frame error(s)`);
      }
    }

    for (const match of requiredOn.includes(ref) ? required : []) {
      const matching = now.filter(s => s.url.includes(match));
      if (!matching.some(s => !s.closed)) {
        absent.push(matching.length === 0
          ? `${ref}: no WebSocket matching "${match}" was ever seen - the transport this sequence asserts on never opened`
          : `${ref}: no open WebSocket matching "${match}" at the end of the run (${matching.length} seen, all closed)`);
      }
    }
  }
  return { settled: out, absent };
}

async function handleRun(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connectionReason: string) => Promise<any>,
  abortSignal?: AbortSignal,
  getConnectionPort?: (connectionReason: string) => Promise<number | null>,
  /**
   * `validateVariableKeys: false` for a sequence running as part of a suite:
   * `runAll` validates the one map it holds against the whole suite's keys and
   * a per-sequence check would reject a key meant for a different member.
   */
  opts?: { validateVariableKeys?: boolean }
) {
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
  let connectionReason = args.connectionReason || extractConnectionFromSequence(commands, analysis);

  // Validate connection requirement - fall back to a reason derived from the
  // sequence name so we can auto-launch Chrome instead of erroring out
  const needsConnection = sequenceNeedsConnection(commands);
  if (!connectionReason && !analysis.hasLaunchBeforeConnection && needsConnection) {
    connectionReason = deriveConnectionReference(sequence.name);
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
    // Tag it: this response is a PROMPT, not a run. runAll has to be able to
    // tell "asked you a question" from "executed and passed", or a suite goes
    // green for a sequence that ran zero steps.
    return {
      content: [{ type: 'text', text: formatVariablePrompt(sequence.name, idParam, extractedVariables, connectionReason) }],
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
    // A `conditional` step's sequence inherits this map, and a setup sequence
    // normally lives BEHIND the conditional - so its references have to count as
    // rebindable too, or the only rebindable ones are those needing no rebind.
    const nested = collectNestedRebindableReferences(commands, recorder);
    const launchRefs = commands
      .filter(c => (c.tool === 'launchChrome' || c.tool === 'connectDebugger') && typeof c.params.reference === 'string')
      .map(c => sanitizeReference(c.params.reference));
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
            : `No step in this sequence names a connection at all, so there is nothing to rebind - use connectionReason to set the run connection. `) +
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
  // connectionReason reaches no step at all. The steps then drive the recorded
  // reference - live but stale in the same session - and fail as "element not
  // found" against the wrong window. Refused before any side effects, with the
  // mapping that retargets them. A `{{...}}` reference resolves only at run time
  // and is left to the per-step existence check.
  if (args.connectionReason) {
    const runRef = sanitizeReference(args.connectionReason);
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
        .map((c, i) => sanitizeReference(String(c.params?.connectionReason ?? '')) === unreached ? i + 1 : 0)
        .filter(Boolean);
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'connectionReason',
        value: args.connectionReason,
        message: `Step${steps.length > 1 ? 's' : ''} ${steps.join(', ')} of "${sequence.name}" name the connection "${unreached}", ` +
          `and a run-level connectionReason does not reach a step that names its own connection - ` +
          `those steps would drive "${unreached}" instead of "${runRef}". ` +
          `Retarget them with connections: { "${unreached}": "${runRef}" }, ` +
          `or run with connectionReason: "${unreached}" to drive the recorded connection.`
      });
    }
  }

  // The run-level connection may itself have been DERIVED from the sequence (a
  // launchChrome reference), in which case it is a recorded name and needs the
  // same rebinding as the steps - otherwise it points at a reference that does
  // not exist here, and the startUrl navigation and cursor injection silently
  // no-op against it. An explicitly passed connectionReason is already a live
  // reference and is left alone.
  if (connectionMap && !args.connectionReason && connectionReason) {
    connectionReason = connectionMap[sanitizeReference(connectionReason)] ?? connectionReason;
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
      // browser connection" and drops the message, so every failed declaration
      // reported the same thing and never said which browser, which role, or
      // why the launch failed.
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
    sequence, analysis, connectionReason, needsConnection,
    launchedConnections: new Set<string>(),
    ...(connectionMap && { connectionMap }),
    ...(runEnv && { runEnv }),
  };

  // wait: true - pre-0.7 blocking behaviour, driven by the MCP request signal.
  // Also what nested `replay run` STEPS use (the executor injects wait: true),
  // so a run started from inside a sequence never registers as its own
  // top-level run and its caller keeps the result.
  // Connections a strict run watches: the run's own, plus every browser the
  // sequence declared.
  const watchedRefs = [...new Set([
    ...(connectionReason ? [connectionReason] : []),
    ...(sequence.requiredConnections || []).map(d => connectionMap?.[sanitizeReference(d.reference)] ?? sanitizeReference(d.reference)),
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
  // transport to belong to. Inferring it from connection injection instead
  // failed a healthy three-browser run - its 3 bare steps were `assert`s over
  // values already captured, which take a connection but load nothing, and
  // that was enough to demand a sync socket on the run's own idle browser.
  const stepRefs = analyzeRecordedStepConnections(commands);
  const navigatedRefs = navigatedConnections(commands, connectionReason);
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
   * CREATED. Runs AFTER the health verdicts, because both of them interrogate
   * the browser - a run with `killChromeOnFinish` and declared sockets used to
   * kill Chrome first and then report "could not read socket health -
   * Connection not found" as a socket FAILURE. Every such run failed, for a
   * reason that was an artefact of its own cleanup.
   *
   * Ownership is not guessed from the sequence text: a `launchChrome` step
   * hands back an existing browser when the reference is already bound, which
   * is the multi-device case where killing would destroy state the user cannot
   * get back. The launch response says which it was, and only the ones this run
   * created are killed (issue #103).
   *
   * The kill is by PORT, and other connections can share one - a `launchChrome`
   * step usually opens a TAB in the same instance - so the port is checked for
   * other tenants first.
   */
  const killOwnedChrome = async (): Promise<string> => {
    if (!args.killChromeOnFinish) return '';
    let note = '';
    if (connectionReason && getConnectionPort) {
      const port = await getConnectionPort(connectionReason);
      const sharers = port === null ? [] : await connectionsSharingPort(executeToolCall, port, connectionReason);
      if (sharers.length > 0) {
        note += `\n\n**Chrome left running** (port ${port} also serves ${sharers.join(', ')}, killChromeOnFinish)` +
          ` - killing it would take those connections with it.`;
      } else if (port !== null) {
        const killResult = await executeToolCall('killChrome', {
          reason: `killChromeOnFinish: sequence "${sequence.name}" completed`,
          port,
        }).catch((error: any) => ({ isError: true, error }));
        note += killResult?.isError
          ? `\n\n**Chrome kill failed** (${connectionReason}, port ${port}, killChromeOnFinish)`
          : `\n\n**Chrome killed** (${connectionReason}, port ${port}, killChromeOnFinish)`;
      }
    }
    // The run-level connection is handled above; everything else here is a
    // browser a step of this run opened and nobody else asked for.
    const stepOwned = [...deps.launchedConnections].filter(ref => ref !== connectionReason);
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

  if (args.wait === true) {
    const { response, outcome } = await performRun(deps, abortSignal);
    await settle(response, outcome);
    if (outcome === 'paused') {
      pendingDeclaredCleanups.set(cleanupKey(undefined, sequence.id), closeDeclared);
    }
    return response;
  }

  // Background (default): register a run and return a handle immediately.
  const runId = runRegistry.newRunId();
  const controller = new AbortController();
  const record: RunRecord = {
    runId,
    sequenceId: sequence.id,
    sequenceName: sequence.name,
    connectionReason,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: commands.length,
    currentStep: 0,
    results: [],
    controller,
  };
  runRegistry.register(record);

  performRun(deps, controller.signal, runId, (ev) => {
    record.currentStep = ev.step;
    record.currentTool = ev.tool;
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
    // Still not derived by parsing the response: the check reports its own
    // verdict, and a run whose transport died did not complete successfully.
    record.status = !healthy && outcome === 'completed' ? 'failed' : outcome;
  }).catch(async (error: any) => {
    // A run that blew up still launched what it launched.
    await closeDeclared().catch(() => '');
    record.error = error?.message || String(error);
    record.endedAt = Date.now();
    record.status = 'failed';
  });

  const started = createSuccessResponse('REPLAY_RUN_STARTED', {
    runId,
    name: sequence.name,
    totalSteps: commands.length,
    connectionReason: connectionReason || 'none',
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
async function performRun(
  deps: PerformRunDeps,
  abortSignal?: AbortSignal,
  runId?: string,
  onProgress?: (ev: { step: number; totalSteps: number; tool: string }) => void
): Promise<{ response: any; outcome: RunOutcome; results?: any[] }> {
  const { args, recorder, executeToolCall, getPageForConnection, getConnectionPort,
    sequence, analysis, connectionReason, needsConnection, connectionMap,
    launchedConnections, runEnv } = deps;

  // Build execution context
  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: connectionReason!,
    logPrefix: 'run',
    variableStore: {},
    launchedConnections,
    ...(connectionMap && { connectionMap }),
    // Carried on the context so nested sequences inherit the retarget; the
    // top-level sequence was already rebased in handleRun.
    ...(args.baseUrl && { rebaseOrigin: args.baseUrl }),
    // Same reason: a shared login helper reached by a conditional is exactly
    // where a supplied credential has to land.
    ...(args.variables && { variables: args.variables }),
    // Held on the context rather than written into process.env: concurrent
    // background runs may name different files, and a global write would let
    // one run's credentials resolve inside the other.
    ...(runEnv && { runEnv })
  };

  // Ensure connection is ready
  let didAutoLaunch = false;
  if (needsConnection && !analysis.hasLaunchBeforeConnection) {
    const connResult = await ensureConnection(
      ctx, needsConnection, analysis.hasLaunchBeforeConnection, sequence.recordedThroughProxy === true);
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

  // Navigate to startUrl if needed
  const navResult = await navigateToStartUrl(ctx, sequence, analysis);
  if (!navResult.success) {
    // Close the tab if we auto-launched it
    if (didAutoLaunch && connectionReason) {
      await executeToolCall('tab', { action: 'close', reference: connectionReason }).catch(() => {});
    }
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
  if (configManager.getReplayConfig().showCursor && connectionReason) {
    cursorPage = await getPageForConnection(connectionReason);
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
  if (args.showReplayOverlay && args.issueId && args.issueType && connectionReason) {
    const overlayPage = cursorPage || await getPageForConnection(connectionReason);
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
    if (cursorPage) {
      await removeReplayCursor(cursorPage).catch(() => {});
      setReplayCursorCallbacks({});
    }
    if (cleanupReplayOverlay) {
      await cleanupReplayOverlay().catch(() => {});
    }
    if (closeTab && didAutoLaunch && connectionReason) {
      await executeToolCall('tab', { action: 'close', reference: connectionReason }).catch(() => {});
    }
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
    overrideConnectionReason: args.connectionReason,
    abortSignal,
    onProgress
  });

  // Handle abort - return early (cleanup already handled by abort signal listener)
  if (abortSignal?.aborted) {
    // results holds every step ATTEMPTED - failures and the abort marker
    // included - so its length is not a count of completed work. A run that
    // aborted while a step was failing reported that step as completed.
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
      replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
    };
    return { response: abortedResponse, outcome: 'cancelled', results: execResult.results };
  }

  // Handle breakpoint hit
  if (execResult.breakpointHit && connectionReason) {
    return { outcome: 'paused', results: execResult.results, response: { content: [{ type: 'text', text: formatBreakpointHit(
      sequence.name,
      execResult.results,
      execResult.totalCommands,
      execResult.durationMs,
      execResult.breakpointHit,
      connectionReason
    ) }],
      _meta: {
        tool: 'replay', action: 'run', timestamp: Date.now(),
        replay: { success: false, totalSteps: sequence.commands.length, failedSteps: execResult.results.filter(r => !r.success).length, paused: true }
      }
    } };
  }

  // Handle click validation failure (pause for inspection/retry)
  if (execResult.clickValidationFailure && connectionReason) {
    // Set active sequence state so user can retry/continue
    const activeState: ActiveSequenceState = {
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      currentStep: execResult.pausedAtStep! - 1, // Back to failed step for retry
      totalSteps: sequence.commands.length,
      pausedAt: Date.now(),
      historyIndexAtPause: recorder.getHistory().length,
      connectionReason,
      runId,
      // step/finish must resolve per-step connections the way this run did
      ...(connectionMap && { connectionMap }),
    };
    recorder.setActiveSequence(activeState);

    return { outcome: 'paused', results: execResult.results, response: { content: [{ type: 'text', text: formatClickValidationFailure(
      sequence,
      execResult.results,
      execResult.pausedAtStep!,
      execResult.durationMs,
      execResult.clickValidationFailure,
      connectionReason
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

  if (execResult.behaviourDrift?.length) {
    // Reported, never a verdict: what a step should do at the boundary is the
    // person's call, and a run that differs is as often a fixed bug as a broken
    // one.
    response += `\n\n**Boundary behaviour differs from the recording**`;
    for (const d of execResult.behaviourDrift) {
      const moved = (['requests', 'failed', 'events', 'writes'] as const)
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
  if (connectionReason && failed === 0) {
    const debugState = await getDebugState(ctx);
    if (debugState) {
      response += formatDebugState(debugState, connectionReason);
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

async function handleStatus(args: ReplayArgs, recorder: CommandRecorder) {
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
    record.status = 'cancelled';
    record.endedAt = record.endedAt ?? Date.now();
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

async function handleCancel(args: ReplayArgs, recorder: CommandRecorder) {
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
    if (activeSeq.runId) {
      const record = runRegistry.get(activeSeq.runId);
      if (record && record.status === 'paused') {
        record.status = 'cancelled';
        record.endedAt = record.endedAt ?? Date.now();
      }
    }
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

async function handleStep(
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
    const closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
    return { content: [{ type: 'text', text: `**Sequence complete.** All ${commands.length} steps executed.${closedNote}` }] };
  }

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: activeSeq.connectionReason,
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
  } else if (failed || lastExecuted >= commands.length) {
    recorder.setActiveSequence(null);
    // Stepping off the end (or onto a failure) ends the run: same cleanup a
    // straight-through run gets.
    closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
  } else {
    recorder.updateActiveSequenceStep(lastExecuted);
  }

  return { content: [{ type: 'text', text: formatStepResults(sequence.name, execResult.results, startStep, commands.length, failed) + closedNote }] };
}

async function handleFinish(
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
    const alreadyDone = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);
    return { content: [{ type: 'text', text: `**Sequence already complete.** All ${commands.length} steps executed.${alreadyDone}` }] };
  }

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: recorder,
    connectionReason: activeSeq.connectionReason,
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

  // Clear active sequence
  recorder.setActiveSequence(null);
  const closedNote = await drainDeclaredCleanup(activeSeq.runId, activeSeq.sequenceId);

  return { content: [{ type: 'text', text: formatExecutionResults(sequence.name, execResult.results, commands.length, execResult.durationMs) + closedNote }] };
}

async function handleInsert(args: ReplayArgs, recorder: CommandRecorder) {
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
  // off; re-stamp it first. Merging without that made every insert look
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
    // Update existing sequence in place
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
 * Add a `conditional` step to a sequence.
 *
 * `conditional` is a virtual step, never a registered tool, so it cannot be
 * recorded and cannot come out of `create`/`insert`. This is its only
 * authoring route.
 */
async function handleAddConditional(args: ReplayArgs, recorder: CommandRecorder) {
  if (!args.condition) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'addConditional',
      missing: 'condition',
      message: 'The "addConditional" action requires a "condition" parameter, e.g. "{{selector:.cookie-banner}}"'
    });
  }
  if (!args.thenSequence) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'addConditional',
      missing: 'thenSequence',
      message: 'The "addConditional" action requires a "thenSequence" parameter naming the sequence to run when the condition holds'
    });
  }

  const loadResult = await loadSequence({ name: args.name, sequenceId: args.sequenceId }, recorder);
  if (!loadResult.success) {
    return handleLoadSequenceError(loadResult, 'addConditional');
  }
  const sequence = loadResult.sequence;

  const syntax = validateConditionSyntax(args.condition);
  if (!syntax.ok) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'condition',
      value: args.condition,
      message: syntax.reason
    });
  }

  // Self-reference recurses until the depth cap truncates it.
  if (args.thenSequence === sequence.name) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'thenSequence',
      value: args.thenSequence,
      message: `A conditional cannot branch to its own sequence ("${sequence.name}") - that recurses until maxConditionalDepth stops it.`
    });
  }

  // The target resolves by name at run time, so an unchecked typo fails
  // halfway through a run.
  const inMemory = recorder.listSequences().some(s => s.name === args.thenSequence);
  const onDisk = await recorder.listSavedSequencesOnDisk();
  if (!inMemory && !onDisk.some(s => s.name === args.thenSequence)) {
    // A disk sequence is in memory once loaded, so the lists overlap.
    const available = [...new Set([
      ...recorder.listSequences().map(s => s.name),
      ...onDisk.map(s => s.name)
    ])];
    return createErrorResponse('SEQUENCE_NOT_FOUND', {
      message: `No sequence named "${args.thenSequence}" to branch to. Available: ${available.join(', ') || 'none'}`
    });
  }

  const commands = sequence.commands;
  const insertAfter = args.insertAfterStep !== undefined ? args.insertAfterStep : commands.length;
  // Checked here as well as at run time: a rejoin that cannot hold is worth
  // refusing while the person is writing it, not halfway through a later run.
  if (args.rejoinAt !== undefined) {
    // The conditional lands at `insertAfter`, so every later step shifts by one.
    const landsAt = insertAfter;
    const after = args.rejoinAt >= landsAt ? args.rejoinAt + 1 : args.rejoinAt;
    if (after <= landsAt || after > commands.length) {
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'rejoinAt',
        value: String(args.rejoinAt),
        message: `A conditional inserted at step ${landsAt + 1} can rejoin at a step after it, `
          + `up to ${commands.length + 1}. Rejoining at or before itself re-runs it forever.`
      });
    }
  }
  if (insertAfter < 0 || insertAfter > commands.length) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'insertAfterStep',
      value: String(insertAfter),
      message: `insertAfterStep must be between 0 (before the first step) and ${commands.length} (after the last). Omit it to append.`
    });
  }

  const step: RecordedCommand = {
    tool: 'conditional',
    params: {
      if: args.condition,
      then: args.thenSequence,
      // Stored against the list this step is being inserted into, so it still
      // names the same step once every later one has shifted by one.
      ...(args.rejoinAt !== undefined
        ? { rejoinAt: args.rejoinAt >= insertAfter ? args.rejoinAt + 1 : args.rejoinAt }
        : {}),
    },
    ...(args.comment ? { comment: args.comment } : {})
  };

  (sequence as any).commands = [
    ...commands.slice(0, insertAfter),
    step,
    ...commands.slice(insertAfter)
  ];

  // Write back to the file this came from; a memory-only sequence waits for
  // `export`, which is where it gets its filename.
  let persisted: string | undefined;
  const existingFile = onDisk.find(s => s.name === sequence.name);
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
      text: formatConditionalAdded({
        sequenceName: sequence.name,
        condition: args.condition,
        thenSequence: args.thenSequence,
        position: insertAfter,
        totalSteps: sequence.commands.length,
        persistedTo: persisted
      })
    }]
  };
}

/**
 * Tidy a tag list into the form selection can rely on: trimmed, lowercased,
 * de-duplicated, order preserved.
 *
 * Case and stray whitespace are normalised rather than rejected because a tag
 * is matched, not displayed - `runAll({ tags: ['UI'] })` skipping a sequence
 * tagged `ui` would be a silent miss, which for a suite means quietly running
 * less than you asked for.
 */
function normalizeTags(tags: string[]): { tags: string[] } | { error: string } {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag) {
      return { error: 'An empty tag cannot select anything - drop it, or pass [] to clear the list.' };
    }
    if (/\s/.test(tag)) {
      return { error: `"${raw.trim()}" contains a space. Tags are single words so they stay unambiguous in a filter - use a hyphen ("${tag.replace(/\s+/g, '-')}").` };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return { tags: out };
}

/**
 * Set what a sequence DECLARES: the browsers it needs, the sockets its
 * assertions ride on, and what kind of sequence it is.
 *
 * Declarations cannot be recorded - they are statements about a run, not steps
 * in it - so before this the only way to add them was to open the JSON and
 * type them in, against advice that otherwise says to keep sequences inside
 * the tools. That also put them squarely in the path of the bug where an
 * edited file was shadowed by the copy in memory.
 *
 * Each list REPLACES its field, and `[]` clears it: a declaration set is a
 * whole statement about the run, and merging would make "remove the second
 * browser" unexpressible.
 */
async function handleDeclare(args: ReplayArgs, recorder: CommandRecorder) {
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
      const reference = sanitizeReference(decl.reference);
      if (!reference) {
        return createErrorResponse('INVALID_PARAMETER', {
          parameter: 'requiredConnections',
          value: decl.reference,
          message: `"${decl.reference}" is not a usable connection reference.`,
        });
      }
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
      ? args.requiredConnections.map(d => ({ ...d, reference: sanitizeReference(d.reference) }))
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

// =============================================================================
// Interaction Recording Handlers
// =============================================================================

async function handleRecordInteraction(
  args: ReplayArgs,
  executeToolCall: ExecuteToolCall,
  getPageForConnection?: (connectionReason: string) => Promise<any>,
  recorder?: CommandRecorder,
  abortSignal?: AbortSignal
) {
  if (!args.connectionReason) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'recordInteraction',
      missing: 'connectionReason',
      message: 'The "recordInteraction" action requires a "connectionReason" to identify the browser tab'
    });
  }

  /**
   * The failure text, or null when the navigation worked. A failed goto THROWS
   * in production (executeToolCall rethrows isError), so the NAVIGATION_FAILED
   * responses below never fired and the recorder went on to record against
   * whatever page happened to be open - the same try/catch shape
   * navigateToStartUrl already uses.
   */
  const navigateTo = async (url: string): Promise<string | null> => {
    try {
      const navResult = await executeToolCall('navigate', {
        action: 'goto',
        connectionReason: args.connectionReason!,
        url
      });
      return navResult?.isError ? (navResult?.content?.[0]?.text || 'Unknown error') : null;
    } catch (navError: any) {
      return navError?.response?.content?.[0]?.text || navError?.message || 'Unknown error';
    }
  };

  if (!getPageForConnection) {
    return createErrorResponse('NOT_SUPPORTED', {
      message: 'Interaction recording is not supported in this context'
    });
  }

  // If issueId is provided, look up the issue and use its details
  let issueId = args.issueId;
  let issueType = args.issueType;
  let issueTitle = args.issueTitle;
  let startUrl = args.startUrl;

  if (issueId) {
    const issue = await getIssue(issueId);
    if (!issue) {
      return createErrorResponse('ISSUES_NOT_FOUND', {
        id: issueId,
        message: `Issue #${issueId} not found`
      });
    }
    // Use issue details (override any provided args)
    issueType = issue.type;
    issueTitle = issue.title;
    startUrl = startUrl || issue.startUrl;  // Use provided startUrl or fall back to issue's startUrl
  }

  let page = await getPageForConnection(args.connectionReason);

  // Auto-launch Chrome if no connection found (requires startUrl)
  if (!page) {
    if (!startUrl) {
      return createErrorResponse('MISSING_PARAMETER', {
        action: 'recordInteraction',
        missing: 'startUrl',
        message: 'Chrome is not running. Provide a "startUrl" or "issueId" (with startUrl) to auto-launch Chrome and navigate before recording.'
      });
    }

    const launchResult = await autoLaunchChrome(executeToolCall, args.connectionReason, 'recordInteraction');
    if (!launchResult.success) {
      return createErrorResponse(launchResult.errorType, {
        reference: args.connectionReason,
        error: launchResult.error
      });
    }

    // Navigate to the startUrl
    const navFailure = await navigateTo(startUrl);
    if (navFailure) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navFailure}`
      });
    }

    // Try getting the page again after launch
    page = await getPageForConnection(args.connectionReason);
    if (!page) {
      return createErrorResponse('CONNECTION_NOT_FOUND', {
        connectionReason: args.connectionReason,
        message: 'Failed to connect to Chrome after auto-launch'
      });
    }
  } else if (startUrl) {
    // Page already exists but startUrl provided - navigate to it
    const navFailure = await navigateTo(startUrl);
    if (navFailure) {
      return createErrorResponse('NAVIGATION_FAILED', {
        url: startUrl,
        message: `Failed to navigate to startUrl: ${navFailure}`
      });
    }
  }

  const showOverlay = args.showOverlay !== false;
  const sequenceName = args.name || (issueId ? `${issueType}-${issueId}-repro` : args.connectionReason);

  // startRecording now blocks until recording completes
  // If issueId is provided, startRecording will show a fullscreen overlay with issue details
  const result = await startRecording(page, args.connectionReason, {
    showOverlay,
    closeTabOnDone: args.closeTabOnDone,
    abortSignal,
    issueId
  });

  // Close the tab if requested by the recording result
  if (result.closeTab) {
    try {
      await executeToolCall('tab', {
        action: 'close',
        reference: args.connectionReason,
      });
    } catch {
      // Non-fatal - tab may already be closed
    }
  }

  if (!result.success) {
    if (result.cancelled) {
      return {
        content: [{
          type: 'text',
          text: '**Recording cancelled** - no sequence created.'
        }],
        // Structurally too: callers were deciding this by searching the
        // sentence for "cancelled", which any recorded page title could also
        // have contained.
        _meta: {
          tool: 'replay',
          action: 'recordInteraction',
          timestamp: Date.now(),
          replay: { totalSteps: 0, cancelled: true },
        },
      };
    }
    return createErrorResponse('RECORDING_FAILED', { message: result.error });
  }

  // Recording completed - create the sequence
  const recording = result.recording!;
  const summary = recording.summary;

  const replayConfig = configManager.getReplayConfig();
  // Recording options come from args; the defaults are the values that used to
  // be hardcoded here, so omitting them keeps the previous behaviour.
  // preferSelectors wins over preferCoordinates when both are set.
  const commands = eventsToCommands(recording.events, {
    simplify: args.simplifyEvents ?? true,
    includeDelays: true,
    includeHovers: args.includeHovers ?? false,
    preferCoordinates: args.preferCoordinates ?? false,
    preferSelectors: args.preferSelectors ?? false,
    maxDelayMs: replayConfig.maxDelayMs,
  });

  // Generate condensed timeline
  const timeline = generateCondensedTimeline(recording.events);

  // Check for BUG and FEATURE comments
  const bugComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'bug');
  const featureComments = recording.events
    .filter((e): e is CommentEvent => isCommentEvent(e) && e.category === 'feature');

  const hasIssues = bugComments.length > 0 || featureComments.length > 0;

  // Build sequence data for saving
  const sequenceData: CommandSequence = {
    id: `seq-${Date.now()}`,
    name: sequenceName,
    commands,
    createdAt: Date.now(),
    startUrl: recording.startUrl,
    description: `Recorded from ${args.connectionReason}`,
  };

  // Only create in-memory sequence if no issues (issues go to issues folder only)
  let sequence: CommandSequence | null = null;
  if (!hasIssues && recorder) {
    // Delete existing sequence if overwriting
    if (args.overwrite && recorder.sequenceNameExists(sequenceName)) {
      const existingSeq = recorder.listSequences().find(s => s.name === sequenceName);
      if (existingSeq) {
        recorder.deleteSequence(existingSeq.id);
      }
    }

    // Check for name conflict
    if (recorder.sequenceNameExists(sequenceName) && !args.overwrite) {
      return createSuccessResponse('RECORDING_NAME_CONFLICT', {
        sequenceName,
        connectionReason: args.connectionReason
      });
    }

    sequence = await recorder.createSequenceFromCommands(sequenceName, commands, {
      startUrl: recording.startUrl,
      description: `Recorded from ${args.connectionReason}`,
    });
  }

  const createdIssues: Array<{ id: number; type: string; title: string }> = [];

  // Initialize issue tracker
  await initializeTracker();

  // Create issues and save sequences for each bug/feature comment
  // Each issue gets its own sequence with a unique ID
  for (const comment of [...bugComments, ...featureComments]) {
    const issueType = comment.category as 'bug' | 'feature';

    // Create the issue first (with temp filename, will be updated by saveIssueSequence)
    const issue = await addIssue({
      type: issueType,
      title: comment.text,
      sequenceFile: '',
      recordingName: sequenceName,
      initialStatus: 'pending',
      startUrl: recording.startUrl || '',
    });

    // Create a unique sequence for this issue (each issue gets its own copy)
    const issueSequenceData: CommandSequence = {
      ...sequenceData,
      id: `seq-${Date.now()}-${issue.id}`,
      name: `${issueType}-${issue.id}-repro`,
    };

    // Save sequence and link to issue
    await saveIssueSequence(issue.id, issueType, comment.text, issueSequenceData);

    createdIssues.push({
      id: issue.id,
      type: issueType,
      title: comment.text,
    });
  }

  // If issueId provided, save sequence to issues folder and link to existing issue
  if (issueId && issueType && issueTitle) {
    await saveIssueSequence(
      issueId,
      issueType,
      issueTitle,
      sequenceData,
      `CDP Tools verification sequence for ${issueType} #${issueId}: ${issueTitle}`
    );
  }

  const response = createSuccessResponse('RECORDING_STOPPED', {
    name: sequence?.name || sequenceData.name,
    sequenceId: sequence?.id || sequenceData.id,
    duration: (recording.duration / 1000).toFixed(1),
    startUrl: recording.startUrl,
    commandCount: commands.length,
    clicks: summary.clicks,
    drags: summary.drags,
    scrolls: summary.scrolls,
    keyPresses: summary.keyPresses,
    navigations: summary.navigations > 0 ? summary.navigations : null,
    comments: summary.comments > 0 ? summary.comments : null,
    // Selector coverage. Only surfaced when some click fell back to raw
    // coordinates, because that is the only case the user can act on - a
    // fully selector-based recording needs no warning, and a warning that
    // fires every time stops being read.
    coordinateClicks: summary.coordinatesOnly > 0 ? summary.coordinatesOnly : null,
    coverageNote: summary.coordinatesOnly > 0
      ? `${summary.selectorsAvailable}/${summary.clicks} clicks captured a selector; ${summary.coordinatesOnly} fell back to coordinates${summary.canvasInteractions > 0 ? ` (${summary.canvasInteractions} on canvas, where that is expected)` : ''}. Coordinate clicks break on re-render or layout change.`
      : null,
    timeline: timeline || null,
    bugCount: bugComments.length > 0 ? bugComments.length : null,
    featureCount: featureComments.length > 0 ? featureComments.length : null,
    hasIssues: createdIssues.length > 0,
    issuesCreatedList: createdIssues.length > 0
      ? createdIssues.map(i => `#${i.id} (${i.type})`).join(', ')
      : null,
  });

  // outputFormat dumps the underlying data alongside the summary. The raw
  // events only exist here - a saved sequence keeps commands, not events.
  if (args.outputFormat === 'events') {
    response.content[0].text += `\n\n**Raw recorded events (${recording.events.length})**\n\n\`\`\`json\n${JSON.stringify(recording.events, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'commands') {
    response.content[0].text += `\n\n**Commands (JSON)**\n\n\`\`\`json\n${JSON.stringify(commands, null, 2)}\n\`\`\``;
  } else if (args.outputFormat === 'review') {
    response.content[0].text += `\n\n**Event Review (${recording.events.length} raw events)**\n\n${formatEventsForReview(recording.events)}`;
  } else if (args.outputFormat === 'playwright') {
    response.content[0].text += `\n\n**Playwright Code**\n\n\`\`\`typescript\n${generatePlaywrightCode(commands, recording.startUrl)}\n\`\`\``;
  } else if (args.outputFormat === 'puppeteer') {
    response.content[0].text += `\n\n**Puppeteer Code**\n\n\`\`\`javascript\n${generatePuppeteerCode(commands, recording.startUrl)}\n\`\`\``;
  }

  return response;
}


/**
 * Escape a string for use in JavaScript code generation
 * Handles newlines, quotes, backslashes, and other special characters
 */
function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')   // Backslashes first
    .replace(/'/g, "\\'")      // Single quotes
    .replace(/\n/g, '\\n')     // Newlines
    .replace(/\r/g, '\\r')     // Carriage returns
    .replace(/\t/g, '\\t');    // Tabs
}

/**
 * Generate Puppeteer test code from sequence commands
 */
/**
 * One page variable per recorded connection, for the code generators.
 *
 * A sequence that drove two browsers has to generate two pages: emitting every
 * step against a single `page` is the bug-018 collapse relocated into the
 * exported test, and it is silent - the generated file looks perfectly
 * reasonable and passes while never involving the second browser. The first
 * recorded reference keeps the name `page` so single-connection output is
 * byte-identical to before.
 */
function buildPageVars(commands: Array<{ tool: string; params: Record<string, any> }>) {
  const { references, mixed } = analyzeRecordedStepConnections(commands);
  const vars = new Map<string, string>();
  references.forEach((ref, i) => {
    vars.set(ref, i === 0
      ? 'page'
      : 'page' + ref.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(''));
  });
  return {
    references,
    mixed,
    multi: references.length > 1,
    /** The page a step runs against; bare steps fall back to the first page. */
    varFor: (cmd: { params: Record<string, any> }) =>
      (typeof cmd.params.connectionReason === 'string' && vars.get(sanitizeReference(cmd.params.connectionReason))) || 'page',
    /** `page` is declared by the caller's preamble; these are the extras. */
    extras: references.slice(1).map(ref => ({ ref, name: vars.get(ref)! })),
  };
}

/**
 * Retarget the lines a single command emitted onto its own page variable.
 * Done as a post-pass over the emitted slice so the (long, per-tool) generator
 * bodies stay untouched and keep emitting the plain `page`.
 */
function rewritePage(lines: string[], from: number, pageVar: string): void {
  if (pageVar === 'page') return;
  for (let i = from; i < lines.length; i++) {
    lines[i] = lines[i].replace(/\bpage\b/g, pageVar);
  }
}

/** Header explaining a multi-browser export, so the collapse can't happen quietly. */
function generatedCodeHeader(pages: ReturnType<typeof buildPageVars>): string[] {
  if (!pages.multi) return [];
  const out = [
    `// This sequence drove ${pages.references.length} browsers (${pages.references.join(', ')}).`,
    `// Each gets its own page below - do NOT merge them, the recording exists to`,
    `// test what crosses between them.`,
  ];
  if (pages.mixed) {
    out.push(`// WARNING: some steps named no connection and are emitted against '${'page'}';`);
    out.push(`// check them by hand - which browser they belonged to was not recorded.`);
  }
  return out;
}

function generatePuppeteerCode(commands: Array<{ tool: string; params: Record<string, any> }>, startUrl?: string): string {
  const pages = buildPageVars(commands);
  const lines: string[] = [
    '// Generated from devharness interaction recording',
    ...generatedCodeHeader(pages),
    'const puppeteer = require(\'puppeteer\');',
    '',
    'async function runTest() {',
    '  const browser = await puppeteer.launch({ headless: false });',
    '  const page = await browser.newPage();',
    ...pages.extras.map(e => `  const ${e.name} = await browser.newPage();  // ${e.ref}`),
    '',
  ];

  if (startUrl) {
    lines.push(`  await page.goto('${startUrl}');`);
    lines.push('');
  }

  let generatedSteps = 0;

  for (const cmd of commands) {
    // Everything this command emits is rewritten onto its own page below.
    const emittedFrom = lines.length;
    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto('${params.url}');`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x}, ${params.y})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel({ deltaX: ${params.deltaX || 0}, deltaY: ${params.deltaY || 0} });`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click('${params.selector}');`);
          }
          lines.push('');
          break;

        case 'type':
          lines.push(`  await page.keyboard.type('${escapeJsString(params.text)}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${escapeJsString(params.key)}');`);
          lines.push('');
          break;
      }
    }

    // Same rule as the Playwright generator: a dropped step leaves a hole.
    if (lines.length === emittedFrom) {
      lines.push(`  // [not generated] ${describeUngeneratedStep(cmd)}`);
    } else {
      generatedSteps++;
    }

    rewritePage(lines, emittedFrom, pages.varFor(cmd));
  }

  lines.push(...ungeneratedTestGuard(generatedSteps, commands.length, Boolean(startUrl)));
  lines.push('  await browser.close();');
  lines.push('}');
  lines.push('');
  lines.push('runTest().catch(console.error);');

  return lines.join('\n');
}

function generatePlaywrightCode(commands: Array<{ tool: string; params: Record<string, any>; delay?: number; comment?: string }>, startUrl?: string): string {
  const pages = buildPageVars(commands);
  const lines: string[] = [
    '// Generated from devharness interaction recording',
    ...generatedCodeHeader(pages),
    "import { test, expect } from '@playwright/test';",
    '',
    // A second browser needs its own context, so the multi-connection form takes
    // the `browser` fixture instead of `page` and opens the pages itself.
    pages.multi
      ? "test('recorded interaction', async ({ browser }) => {"
      : "test('recorded interaction', async ({ page }) => {",
    ...(pages.multi ? ['  const page = await (await browser.newContext()).newPage();'] : []),
    ...pages.extras.map(e => `  const ${e.name} = await (await browser.newContext()).newPage();  // ${e.ref}`),
  ];

  if (startUrl) {
    lines.push(`  await page.goto('${startUrl}');`);
    lines.push('');
  }

  let generatedSteps = 0;

  for (const cmd of commands) {
    const emittedFrom = lines.length;
    // Add comment if present
    if (cmd.comment) {
      lines.push(`  // ${cmd.comment}`);
    }

    // Add delay if present
    if (cmd.delay && cmd.delay > 100) {
      lines.push(`  await page.waitForTimeout(${cmd.delay});`);
    }

    const bodyFrom = lines.length;

    if (cmd.tool === 'navigate') {
      const { action, ...params } = cmd.params;
      if (action === 'goto' && params.url) {
        lines.push(`  await page.goto('${params.url}');`);
        lines.push('');
      } else if (action === 'reload') {
        lines.push(`  await page.reload();`);
        lines.push('');
      } else if (action === 'back') {
        lines.push(`  await page.goBack();`);
        lines.push('');
      } else if (action === 'forward') {
        lines.push(`  await page.goForward();`);
        lines.push('');
      }
    } else if (cmd.tool === 'input') {
      const { action, ...params } = cmd.params;

      switch (action) {
        case 'drag':
          lines.push(`  // Drag from (${params.from.x}, ${params.from.y}) to (${params.to.x}, ${params.to.y})`);
          lines.push(`  await page.mouse.move(${params.from.x}, ${params.from.y});`);
          lines.push(`  await page.mouse.down();`);
          lines.push(`  await page.mouse.move(${params.to.x}, ${params.to.y});`);
          lines.push(`  await page.mouse.up();`);
          lines.push('');
          break;

        case 'scroll':
          lines.push(`  // Scroll at (${params.x || 0}, ${params.y || 0})`);
          if (params.x !== undefined && params.y !== undefined) {
            lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          }
          lines.push(`  await page.mouse.wheel(${params.deltaX || 0}, ${params.deltaY || 0});`);
          lines.push('');
          break;

        case 'mousemove':
          lines.push(`  await page.mouse.move(${params.x}, ${params.y});`);
          break;

        case 'click':
          if (typeof params.x === 'number' && typeof params.y === 'number') {
            lines.push(`  await page.mouse.click(${params.x}, ${params.y});`);
          } else if (params.selector) {
            lines.push(`  await page.click('${params.selector}');`);
          }
          lines.push('');
          break;

        case 'type':
          // Playwright uses type() for key-by-key typing, fill() for setting value directly
          lines.push(`  await page.keyboard.type('${escapeJsString(params.text)}');`);
          lines.push('');
          break;

        case 'press':
          lines.push(`  await page.keyboard.press('${escapeJsString(params.key)}');`);
          lines.push('');
          break;

        case 'hover':
          if (params.selector) {
            lines.push(`  await page.hover('${params.selector}');`);
          }
          lines.push('');
          break;
      }
    }

    // A step with no Playwright equivalent (conditional, launchChrome, inspect,
    // storage, wait, breakpoint...) must leave a visible hole. Dropping it
    // silently is how a sequence turns into a test that passes without doing
    // anything it was recorded to do.
    if (lines.length === bodyFrom) {
      lines.push(`  // [not generated] ${describeUngeneratedStep(cmd)}`);
    } else {
      generatedSteps++;
    }

    rewritePage(lines, emittedFrom, pages.varFor(cmd));
  }

  lines.push(...ungeneratedTestGuard(generatedSteps, commands.length, Boolean(startUrl)));
  lines.push('});');

  return lines.join('\n');
}

/** Names a step the generators have no equivalent for, for the emitted comment. */
function describeUngeneratedStep(cmd: { tool: string; params: Record<string, any> }): string {
  const action = typeof cmd.params?.action === 'string' ? `({ action: '${cmd.params.action}' })` : '';
  const extra = cmd.tool === 'conditional' && cmd.params?.then
    ? ` — runs the sequence "${cmd.params.then}" when ${cmd.params.if}`
    : '';
  return `${cmd.tool}${action}${extra}`;
}

/**
 * Body for a generated test that ended up with nothing to run. Returning an
 * empty test would export a permanently GREEN file - the failure mode this
 * whole tool exists to avoid - so the generated test fails and says why.
 */
function ungeneratedTestGuard(generatedSteps: number, totalSteps: number, hasStartUrl: boolean): string[] {
  if (generatedSteps > 0 || hasStartUrl) return [];
  return [
    '',
    `  throw new Error('devharness: none of the ${totalSteps} recorded step(s) have a generated equivalent`
      + ` (see the "[not generated]" comments above) - this exported test would otherwise pass without doing anything.`
      + ` Run it with replay({ action: "run" }) instead.');`,
  ];
}

// =============================================================================
// Tool Export
// =============================================================================

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
      'Record and replay command sequences for testing and automation. Actions: repeat (immediately re-execute commands by history index - use this to repeat recent actions), history (view command history), recordInteraction (record real mouse/keyboard/navigation via a browser overlay - BLOCKS until the person finishes, so do not call it unattended; tune the capture with simplifyEvents/includeHovers/preferCoordinates/preferSelectors, and add outputFormat: events|commands|review|playwright|puppeteer to dump the recording - review is a human-readable walkthrough of the captured events), create (create sequence from history indices), list (every sequence reachable: those in memory and those saved on disk), get (get sequence details; outputFormat: commands|playwright|puppeteer returns the raw command JSON or generated test code), delete (delete from memory), export (write a sequence to disk as sequence/playwright/puppeteer), load (load sequence from disk), listSaved (the saved files alone), deleteSaved (delete saved file), run (start executing a sequence in the background - returns a runId immediately; poll progress/results with status, stop it with cancel; wait: true blocks until completion and returns the full result), runAll (run every sequence in a folder of the sequences dir, or only those carrying a given tag - loads the whole tree first so cross-folder name references resolve, runs only the chosen folder, skips folders whose name starts with an underscore unless named explicitly, and reports a pass/fail line per sequence; continueOnFailure defaults true), runFromLog (execute commands from log lines), step (execute next N commands in a paused sequence), finish (complete remaining commands), insert (insert recorded commands into a sequence), addConditional (add a guarded branch step: condition + thenSequence, optionally insertAfterStep), declare (set what the sequence needs and what it is: requiredConnections - the browsers, optionally each on a persistent profile - requiredSockets - URL substrings of the WebSockets its assertions ride on - and tags, which runAll selects on; each list replaces the field, [] clears it, and the sequence is written back to its file), status (with runId: one run\'s progress or final result; without: paused session + recent runs), cancel (with runId: stop that run; without: drop the paused session, or the only executing run)',
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
          case 'addConditional':
            return handleAddConditional(args, commandRecorder);
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
