/**
 * The `replay` tool's parameters, and the arguments type every action handler takes.
 */
import { z } from 'zod';
import { createErrorResponse } from '../messages.js';

/** Every field a replay handler reads, the ones `run` takes among them. */
const replayArgsSchema = z.object({
  action: z.enum([
    'history', 'create', 'list', 'get', 'delete',
    'export', 'load', 'listSaved', 'deleteSaved',
    'run', 'runAll', 'step', 'finish', 'insert', 'addCheck', 'declare', 'pause', 'repair', 'copy', 'split', 'adopt', 'search', 'status', 'cancel',
    'repeat', 'runFromLog',
    'recordInteraction'
  ]),
  limit: z.number().optional().describe('Max items (default:50)'),
  name: z.string().optional(),
  description: z.string().optional(),
  expectedOutcome: z.string().optional(),
  startUrl: z.string().optional().describe('create: sequence start URL. run: replaces the stored startUrl for this run only'),
  envFile: z.string().optional().describe('run/runAll: KEY=value file supplying the {{env:NAME}} tokens; its values win over the server environment'),
  baseUrl: z.string().optional().describe('run/runAll: origin every absolute URL in the run moves onto, path and query kept'),
  indices: z.array(z.number()).optional().describe('Command indices; history: the entries to read in full'),
  ids: z.array(z.string()).optional().describe('history: observations to read in full, by id (r31, m14)'),
  params: z.record(z.any()).optional().describe('repeat, one index: fields replacing the recorded ones; null removes one'),
  lines: z.array(z.number()).optional().describe('Log line numbers'),
  sequenceId: z.string().optional(),
  runId: z.string().optional().describe('status/cancel: the background run, by the id run returned'),
  bench: z.boolean().optional().describe('run: play in the bench open on connection, as its Replay button does, so it shows there'),
  wait: z.boolean().optional().describe('run: block until the run completes and return the full result. Default false: return a runId at once'),
  global: z.boolean().optional().describe('Use ~/.devharness/'),
  format: z.enum(['sequence', 'playwright', 'puppeteer']).optional(),
  filename: z.string().optional(),
  intoHistory: z.boolean().optional(),
  connection: z.string().optional().describe('history: that browser\'s calls only; recordInteraction: the browser recorded'),
  group: z.string().min(1).optional().describe('history: per-browser headline of the group since the last read; with connection or failed, the calls'),
  failed: z.boolean().optional().describe('history: failed calls only'),
  requiredConnections: z.array(z.object({
    connection: z.string().describe('The connection the steps use, e.g. "duo-member-two"'),
    profile: z.string().optional().describe('Named persistent Chrome profile to come up on'),
    url: z.string().optional().describe("Opened on launch (defaults to the sequence's startUrl)"),
    role: z.string().optional().describe('Why this browser exists, shown in the run summary'),
    forceNewInstance: z.boolean().optional().describe('A distinct process rather than a tab (default true; false with profile)'),
    proxy: z.boolean().optional().describe('Launched through the proxy'),
  }).strict()).optional().describe('declare: the browsers this sequence needs. Replaces the whole list; [] clears it'),
  proxy: z.boolean().optional().describe('declare: the run needs its connection to cross the proxy; a live one outside it plays in a proxied window the run opens'),
  tags: z.array(z.string()).optional().describe("declare: kinds of sequence, e.g. ['ui'], replacing the list. runAll: run only sequences carrying one of these"),
  holdThresholdMs: z.number().min(0).nullable().optional().describe('declare: press ms from which a recorded click or tap replays held (default 500); null resets'),
  requiredSockets: z.array(z.string()).optional().describe("declare: URL substrings of the WebSockets its assertions ride on, e.g. ['/api/sync/socket'], replacing the list"),
  connections: z.record(z.string()).optional().describe('run: { "<recorded connection>": "<connection here>" }, rebinding a multi-connection sequence onto this session'),
  record: z.boolean().optional(),
  variables: z.record(z.string()).optional().describe('run/runAll: replacement text for recorded typed-text steps, keyed var_<0-based step>_<selector with non-alphanumerics as _>'),
  stepTimeout: z.number().optional().describe('Per-step ms (default 30000)'),
  totalTimeout: z.number().optional().describe('Total ms'),
  startFrom: z.number().optional().describe('Start step (1-indexed)'),
  stepTo: z.number().optional().describe('Pause after step'),
  playing: z.boolean().optional()
    .describe('run with stepTo, step: a step of a play that carries straight on - the run does not stand paused after it, so it neither holds the page nor stamps a pause'),
  hold: z.array(z.enum(['code', 'ui', 'network'])).optional()
    .describe('run with stepTo, step: what is held while the run stands paused - code, ui (the screen), network; default all, [] none'),
  stepCount: z.number().optional().describe('Steps to run'),
  insertIndices: z.array(z.number()).optional(),
  insertAfterStep: z.number().optional(),
  check: z.record(z.any()).optional().describe("addCheck: the check step's parameters as the check tool takes them, holds/fails included"),
  comment: z.string().optional().describe('addCheck: note stored on the step'),
  step: z.number().int().positive().optional().describe('pause: the 1-based step the pause point stands before'),
  notify: z.boolean().optional().describe('pause: a run stopping there tells the session; false also removes the note'),
  note: z.string().optional().describe('pause: why the session is told, what it carries out there before resuming; implies notify; "" removes it'),
  remove: z.boolean().optional().describe('pause: take the pause point away'),
  overwrite: z.boolean().optional(),
  full: z.boolean().optional().describe('list/listSaved: every saved sequence again; after the first listing of a session, only the changes are listed. history with group: from the group\'s start'),
  query: z.string().optional().describe('search: a string matched literally in every saved step'),
  element: z.string().optional().describe('search: a selector resolved on the live page; the steps that reached that element'),
  throughStep: z.number().optional().describe('copy/split/adopt: the last step taken, 1-indexed'),
  sharedName: z.string().optional().describe('split: the shared sequence the steps move into. adopt: the shared sequence that replaces them'),
  accept: z.enum(['selector', 'element']).optional().describe("repair: 'selector' takes the recorded element's new selector, 'element' keeps the selector and records the element it hit"),
  newName: z.string().optional(),
  showOverlay: z.boolean().optional(),
  closeTabOnDone: z.boolean().optional()
    .describe('recordInteraction: whether finishing closes the tab (default:true). False leaves a tab the person was already working in'),
  simplifyEvents: z.boolean().optional().describe('recordInteraction: collapse noisy raw events (default:true)'),
  includeHovers: z.boolean().optional().describe('recordInteraction: keep mousemove steps (default:false)'),
  outputFormat: z.enum(['events', 'commands', 'review', 'puppeteer', 'playwright']).optional()
    .describe('get: commands|playwright|puppeteer. recordInteraction: events|commands (JSON) or review (readable walkthrough), appended to the summary'),
  preferCoordinates: z.boolean().optional().describe('recordInteraction: emit x,y clicks instead of selectors (default:false)'),
  preferSelectors: z.boolean().optional().describe('recordInteraction: emit selector clicks even for canvas; wins over preferCoordinates (default:false)'),
  issueId: z.number().optional(),
  issueType: z.enum(['bug', 'feature']).optional(),
  issueTitle: z.string().optional(),
  showReplayOverlay: z.boolean().optional(),
  showAll: z.boolean().optional().describe('Show all sequences including completed/fixed issues'),
  requireSockets: z.boolean().optional().describe('run/runAll: fail the run when a WebSocket closes or errors during it'),
  steps: z.enum(['all']).optional().describe("run/step/finish: 'all' lists every step's row; omitted, only the failed and mismatched ones"),
  strict: z.enum(['errors', 'warnings']).optional().describe("run/runAll: fail the run on console output it produces - 'errors', or 'warnings' for errors and warnings"),
  folder: z.string().optional().describe("runAll: sequences subfolder to run; omitted, every folder not starting with '_'"),
  continueOnFailure: z.boolean().optional().describe('runAll: keep going after a sequence fails (default true)'),
  killChromeOnFinish: z.boolean().optional().describe('run/runAll: kill the browsers this run launched once it finishes'),
  keepDeclared: z.boolean().optional().describe('run: leave the browsers the sequence declares open once it ends'),
}).strict();

/** One step written into a `run steps` call, as a saved sequence stores it. */
const inlineStep = z.object({
  tool: z.string(),
  params: z.record(z.any()).optional(),
}).strict();

/** Each `run` action, and the `replay` action that carries it out. */
export const RUN_ACTIONS = {
  steps: 'run', sequence: 'run', all: 'runAll', repeat: 'repeat', fromLog: 'runFromLog',
  step: 'step', finish: 'finish', status: 'status', cancel: 'cancel',
} as const;

export const runSchema = replayArgsSchema.pick({
  name: true, sequenceId: true, runId: true, connection: true, connections: true,
  startUrl: true, baseUrl: true, envFile: true, variables: true, stepTimeout: true, totalTimeout: true,
  startFrom: true, stepTo: true, playing: true, hold: true, stepCount: true, wait: true, bench: true,
  steps: true, record: true, global: true, folder: true, tags: true, continueOnFailure: true,
  killChromeOnFinish: true, keepDeclared: true, requireSockets: true, strict: true, indices: true, params: true, lines: true,
}).extend({
  action: z.enum(Object.keys(RUN_ACTIONS) as [keyof typeof RUN_ACTIONS, ...Array<keyof typeof RUN_ACTIONS>]),
  // The fields below are replay's, described for the actions that take them here.
  wait: z.boolean().optional().describe('steps, sequence: block until the run ends; steps default true, sequence default false (returns a runId)'),
  startUrl: z.string().optional().describe('sequence: replaces the stored startUrl for this run only'),
  baseUrl: z.string().optional().describe('sequence, all: origin every absolute URL in the run moves onto, path and query kept'),
  envFile: z.string().optional().describe('sequence, all: KEY=value file supplying {{env:NAME}} tokens'),
  variables: z.record(z.string()).optional().describe('sequence, all: replacement text for recorded typed-text steps, keyed var_<0-based step>_<selector with non-alphanumerics as _>'),
  bench: z.boolean().optional().describe('sequence: play in the bench open on connection'),
  steps: z.enum(['all']).optional().describe("sequence, step, finish: 'all' lists every step's row; omitted, only the failed and mismatched ones"),
  connections: z.record(z.string()).optional().describe('sequence: { "<recorded connection>": "<connection here>" }'),
  tags: z.array(z.string()).optional().describe('all: run only sequences carrying one of these'),
  indices: z.array(z.number()).optional().describe('repeat: history indices, from the Replay: N footers'),
  params: z.record(z.any()).optional().describe('repeat, one index: fields replacing the recorded ones; null removes one'),
  lines: z.array(z.number()).optional().describe('fromLog: history.log line numbers, 1 the newest'),
  killChromeOnFinish: z.boolean().optional().describe('sequence, all: kill the browsers this run launched once it finishes'),
  keepDeclared: z.boolean().optional().describe('sequence: leave the browsers the sequence declares open once it ends, bench plays included'),
  requireSockets: z.boolean().optional().describe('sequence, all: fail the run when a WebSocket closes or errors during it'),
  strict: z.enum(['errors', 'warnings']).optional().describe("sequence, all: fail the run on console output it produces"),
  commands: z.array(inlineStep).min(1).optional()
    .describe('steps: the calls to run in order, [{ tool, params }]; a step naming no connection runs on `connection`'),
}).strict();

export type RunArgs = z.infer<typeof runSchema>;

/** Each `replay` action that runs calls, and the `run` action it is now. */
const RUN_ACTION_OF: Record<string, keyof typeof RUN_ACTIONS> = {
  run: 'sequence', runAll: 'all', repeat: 'repeat', runFromLog: 'fromLog',
  step: 'step', finish: 'finish', status: 'status', cancel: 'cancel',
};

/**
 * A call written as `replay` addressed to the tool that carries it: the
 * actions that run calls go to `run` under their `run` names, steps written
 * inline among them; every other action stays on `replay`.
 */
export function routedReplayCall(args: Record<string, unknown>): { tool: 'run' | 'replay'; args: Record<string, unknown> } {
  const action = String(args.action);
  if (!(action in RUN_ACTION_OF)) return { tool: 'replay', args };
  const runAction = action === 'run' && args.commands ? 'steps' : RUN_ACTION_OF[action];
  return { tool: 'run', args: { ...args, action: runAction } };
}

export type ReplayArgs = z.infer<typeof replayArgsSchema> & { commands?: Array<z.infer<typeof inlineStep>> };

/** The `replay` actions that moved to `run`, each with its `run` action. */
export const MOVED_TO_RUN: Readonly<Record<string, keyof typeof RUN_ACTIONS>> = {
  run: 'sequence', runAll: 'all', repeat: 'repeat', runFromLog: 'fromLog',
  step: 'step', finish: 'finish', status: 'status', cancel: 'cancel',
};

/** Fields only the actions that run calls take; `replay` offers none of them. */
const RUN_ONLY_FIELDS = {
  runId: true, baseUrl: true, envFile: true, variables: true, stepTimeout: true, totalTimeout: true,
  startFrom: true, stepTo: true, playing: true, stepCount: true, wait: true, bench: true,
  steps: true, folder: true, continueOnFailure: true, killChromeOnFinish: true, keepDeclared: true, requireSockets: true,
  strict: true, params: true, lines: true, connections: true,
} as const;

/** The `replay` tool's parameters: recording and keeping sequences; running them is `run`'s. */
export const replaySchema = replayArgsSchema.omit(RUN_ONLY_FIELDS).extend({
  action: z.enum([
    'history', 'create', 'list', 'get', 'delete', 'export', 'load', 'listSaved', 'deleteSaved',
    'insert', 'addCheck', 'declare', 'pause', 'repair', 'copy', 'split', 'adopt', 'search', 'recordInteraction',
  ]),
}).strict();

/**
 * The refusal for a `replay` call to an action that now runs through `run`,
 * carrying that `run` call with the same fields, so a session working from
 * older text recovers in one step; undefined for any other call.
 */
export function movedReplayRefusal(params: Record<string, unknown> | undefined): any | undefined {
  const moved = MOVED_TO_RUN[String(params?.action)];
  if (!moved) return undefined;
  const { action, ...rest } = params ?? {};
  return createErrorResponse('REPLAY_ACTION_MOVED', {
    action: String(action),
    call: `run(${JSON.stringify({ action: moved, ...rest })})`,
  });
}

