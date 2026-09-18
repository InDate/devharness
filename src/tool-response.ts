/**
 * Tool Response Helpers
 * Functions for modifying tool responses with pre/post content
 */

import type { PortFailureInfo, PendingStartupFailureInfo, PendingRestartInfo } from './server-manager.js';
import type { Connection } from './connection-manager.js';
import { hasPendingBugs, getPendingBugs } from './issue-tracker.js';
import { createErrorResponse, getMessage } from './messages.js';
import type { BlockEventInfo } from './block-events.js';
import type { LaunchObservations } from './chrome-launcher.js';
import type { SessionMessage } from './session-messages.js';
import type { Annotation, AnnotateSessionState, TickResult } from './annotate-mode.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get MCP version from package.json
let MCP_VERSION = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  MCP_VERSION = pkg.version;
} catch {
  // Ignore errors
}

/**
 * Tool response content item
 */
export interface ContentItem {
  type: string;
  text?: string;
  [key: string]: unknown;
}

// =============================================================================
// Structured Metadata Types (for programmatic use, separate from text output)
// =============================================================================

/**
 * Click action metadata
 */
export interface ClickActionMeta {
  selector: string;
  preClickUrl: string;
  postClickUrl: string;
  navigationOccurred: boolean;
  hasClickHandler: boolean;
  domChanges: {
    mutationCount: number;
    added: number;
    removed: number;
    shown: number;
    hidden: number;
  } | null;
}

/**
 * Readings taken during a launch that failed. Behaviour reads this, never the
 * rendered text.
 */
export type LaunchObservationsMeta = LaunchObservations;

/**
 * Type action metadata
 */
export interface TypeActionMeta {
  selector: string;
  text: string;
  actualValue: string;
}

/**
 * Navigate action metadata
 */
export interface NavigateActionMeta {
  url: string;
  title: string;
  action: string;
}

/**
 * Console tool metadata
 */
export interface ConsoleToolMeta {
  totalCount: number;
  matchCount?: number;
  errorCount?: number;
  warnCount?: number;
  /** Number of messages that were truncated */
  truncatedCount?: number;
  /** Total estimated tokens for all full messages */
  totalTokens?: number;
  /** id/type/origin URL of each message in this response, for callers that need
   *  to identify WHICH messages are new (e.g. click validation diffing against
   *  a pre-click snapshot) rather than just a count. */
  entries?: Array<{ id: string; type: string; url?: string }>;
}

/**
 * Network tool metadata
 */
export interface NetworkToolMeta {
  totalCount: number;
  matchCount?: number;
  /** Requests started inside the requested window, before any limit. */
  inWindow?: number;
  /** The read clock, for bracketing the next action against this one. */
  at?: number;
  since?: number;
  until?: number;
}

/**
 * Content tool metadata (findInteractive)
 */
export interface ContentToolMeta {
  /** interactive elements on the page */
  totalCount: number;
  /** of those, not currently visible */
  hiddenCount?: number;
}

/**
 * Request tool metadata (HTTP request/response, capturable via saveAs)
 */
export interface RequestToolMeta {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

/**
 * Inspect tool metadata (evaluateExpression result, capturable via saveAs).
 *
 * `value` is a best-effort de-formatted view of the evaluated result: the
 * CDP layer returns values already shaped for display (strings arrive quoted,
 * numbers/booleans arrive as strings), so this reverses that so a captured
 * variable holds the real type rather than its display text.
 */
export interface InspectToolMeta {
  expression: string;
  value: unknown;
  /** typeof `value` ('undefined' when the expression evaluated to undefined) */
  valueType: string;
  /**
   * How `value` was obtained: 'exact' = by-value CDP capture (faithful
   * machine-readable value); 'display' = reconstructed from the rendered
   * display text (best effort - non-serializable values only).
   */
  valueSource?: 'exact' | 'display';
  /** Set when the expression was evaluated against a paused call frame */
  callFrameId?: string;
  /** Set when the expression was evaluated inside a worker target */
  workerTarget?: string;
}

/**
 * Storage tool metadata (IndexedDB reads).
 *
 * Exists so a caller can ask "is this record there?" without grepping the
 * rendered markdown: a stored value that happens to contain the tool's own
 * "No record found for this key." text made a present record read as absent.
 */
export interface StorageToolMeta {
  /** IndexedDB only */
  database?: string;
  /** IndexedDB only */
  store?: string;
  /** idbGet / getLocalStorage / getSessionStorage: whether the key resolved */
  found?: boolean;
  /** the key that was probed, where the call named one */
  key?: string;
  /** getCookies: the names present, so a caller can test for one without reading the rendered text */
  cookieNames?: string[];
  /** idbGetAll: records returned (bounded by `limit`). getCookies / whole-store reads: entries present */
  count?: number;
  /** idbGetAll: records in the store, ignoring `limit` */
  total?: number;
}

/**
 * Assert tool metadata
 */
export interface AssertToolMeta {
  left: unknown;
  operator: string;
  right?: unknown;
  passed: boolean;
}

/**
 * Wait tool metadata
 */
export interface WaitToolMeta {
  /** Which form ran */
  form: 'selector' | 'selectorGone' | 'expression' | 'ms';
  /** The selector/expression waited on (or "Nms" for the sleep form) */
  condition: string;
  /** True when the condition was met (always true for the sleep form) */
  satisfied: boolean;
  elapsedMs: number;
  /** Number of MCP-side evaluations performed (0 for the sleep form) */
  polls: number;
}

/**
 * Replay run metadata - structured completion signal, since a "run" can
 * finish with failed steps or pause (stepTo/breakpoint/click-validation)
 * while still returning a non-isError response (a caller has to read this
 * to tell those apart from a clean run instead of text-scraping the reply).
 */
export interface ReplayRunMeta {
  /** Not set on a background-start response (runId + background instead). */
  success?: boolean;
  totalSteps: number;
  failedSteps?: number;
  paused?: boolean;
  /** Id of the registered background run (background start / status replies). */
  runId?: string;
  /** True on the immediate response of a background `run` start. */
  background?: boolean;
  /** Registry status of the run (status action replies). */
  runStatus?: string;
  /** 1-based step currently executing (status action replies). */
  currentStep?: number;
  /** recordInteraction: the person closed the recorder without saving. */
  cancelled?: boolean;
}

/**
 * Root metadata structure for tool responses
 * This provides structured data for programmatic use (validation, replay)
 * while keeping text content free to evolve for human/LLM display
 */
/** One worker target: service worker, dedicated worker, or shared worker. */
export interface WorkerTargetMeta {
  targetId: string;
  type: string;
  url: string;
  attached: boolean;
}

export interface ToolResponseMeta {
  tool: string;
  action?: string;
  timestamp: number;
  /** Worker targets on this browser, from inspect({ action: 'listTargets' }). */
  workerTargets?: WorkerTargetMeta[];
  // Action-specific structured data
  click?: ClickActionMeta;
  type?: TypeActionMeta;
  navigate?: NavigateActionMeta;
  console?: ConsoleToolMeta;
  network?: NetworkToolMeta;
  content?: ContentToolMeta;
  request?: RequestToolMeta;
  inspect?: InspectToolMeta;
  assert?: AssertToolMeta;
  wait?: WaitToolMeta;
  storage?: StorageToolMeta;
  replay?: ReplayRunMeta;
  github?: GithubToolMeta;
  message?: MessageToolMeta;
  annotate?: AnnotateToolMeta;
  /** launchChrome: the readings taken during a launch that failed. */
  launchObservations?: LaunchObservationsMeta;
}

/** Structured result of an annotate action. Behaviour reads this, never the
 *  rendered text. */
export interface AnnotateToolMeta {
  action: 'start' | 'stop' | 'tick' | 'freeze' | 'unfreeze' | 'picker' | 'list' | 'status'
    | 'keepStep' | 'dropStep' | 'flagStep';
  /** Whether the page is frozen with the picker armed, after this call. */
  active?: boolean;
  connection?: string;
  state?: AnnotateSessionState;
  /** tick: what the step asked for, and what it actually did. */
  tick?: TickResult;
  /** list: the annotations returned, oldest first. */
  annotations?: Annotation[];
  /** list: how many exist in total, before any limit. */
  total?: number;
  /** The sequence card's state, after a call that changed it. */
  sequence?: unknown;
}

/** Structured result of a cross-session message action. Behaviour reads this,
 *  never the rendered text. */
export interface MessageToolMeta {
  action: 'sessions' | 'send' | 'read' | 'reply';
  /** Mailbox id this session is reachable at. */
  self: string;
  /** sessions: every mailbox known, with hub liveness where the hub is up. */
  sessions?: Array<{
    id: string;
    pid?: number;
    cwd?: string;
    live: boolean;
    self: boolean;
  }>;
  /** send/reply: the message appended to the recipient's mailbox. */
  sent?: SessionMessage;
  /** send: whether a session was listening under that id at the time. False
   *  for a suspended peer and for a mistyped id alike. */
  targetListening?: boolean;
  /** send/reply/read: messages taken from this session's own mailbox. */
  received?: SessionMessage[];
  /** send/reply with waitForReplyMs: true when the wait returned nothing. */
  waitTimedOut?: boolean;
  /** send/reply with waitForReplyMs: milliseconds spent inside the wait. */
  waitElapsedMs?: number;
}

/** Structured result of a GitHub action on the issues tool. Behaviour reads
 *  this, never the rendered text. */
export interface GithubToolMeta {
  action: 'publish' | 'sync' | 'import' | 'link' | 'pullSequence';
  repo?: string;
  /** Upstream issue number, once one exists. */
  number?: number;
  url?: string;
  /** publish: false for a draft, true once it is really on GitHub. */
  posted?: boolean;
  changed?: Array<{ id: number; number: number; action: string }>;
  conflicts?: Array<{ id: number; number: number }>;
  sequence?: { steps: number; tools: string[]; privileged: string[] };
}

/**
 * Tool response structure
 */
export interface ToolResponse {
  content: ContentItem[];
  isError?: boolean;
  /** Structured metadata for programmatic use (validation, replay). Decoupled from text output. */
  _meta?: ToolResponseMeta;
}

/**
 * Blocking response - prevents tool execution
 */
export interface BlockingResponse {
  blocked: true;
  response: ToolResponse;
  /** Identity/summary for the session's event stream. */
  block?: BlockEventInfo;
}

/**
 * Non-blocking response - allows tool execution with optional modifications
 */
export interface NonBlockingResponse {
  blocked: false;
  prefix: string;
  markAsError: boolean;
}

export type PreExecutionResult = BlockingResponse | NonBlockingResponse;

/**
 * Check for port failures and determine pre-execution behavior
 */
export function checkPortFailures(
  failedPorts: PortFailureInfo[],
  toolName: string
): PreExecutionResult {
  // Check for blocking failures (block level ports that haven't been acknowledged)
  const blockingPorts = failedPorts.filter(p => p.level === 'block');

  // Tools that should not be blocked by port failures
  // - server: needed to acknowledge/manage ports
  // - execution: needed to resume from breakpoints (otherwise deadlock with breakpoint blocking)
  // - breakpoint: needed to manage breakpoints while debugging
  // - issues: logging/tracking bugs shouldn't be gated on unrelated server health
  const portFailureExemptTools = new Set(['server', 'execution', 'breakpoint', 'issues']);

  if (blockingPorts.length > 0 && !portFailureExemptTools.has(toolName)) {
    // Block all tools except exempt tools
    const portList = blockingPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''} - down since ${p.failedAt.toISOString()}`
    ).join('\n');

    return {
      blocked: true,
      response: {
        content: [
          {
            type: 'text',
            text: `**BLOCKED: Monitored port(s) failed**\n\nThe following monitored port(s) have failed and require acknowledgment before tools can be used:\n\n${portList}\n\nUse \`server({ action: 'acknowledgePort', port: <port> })\` to acknowledge each failure and continue.`,
          },
        ],
        isError: true
      },
      block: {
        guard: 'port',
        key: blockingPorts.map(p => p.port).sort((a, b) => a - b).join(','),
        detail: `Monitored port(s) down: ${blockingPorts.map(p => p.description ? `${p.port} (${p.description})` : `${p.port}`).join(', ')}`,
        resolve: `server({ action: 'acknowledgePort', port: ${blockingPorts[0].port} })`,
      }
    };
  }

  // Build prefix for error/inform level failures
  let prefix = '';
  const errorPorts = failedPorts.filter(p => p.level === 'error');
  const informPorts = failedPorts.filter(p => p.level === 'inform');

  if (errorPorts.length > 0) {
    const portList = errorPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''}`
    ).join(', ');
    prefix += `**ERROR: Monitored port(s) failed:** ${portList}\n\n`;
  }

  if (informPorts.length > 0) {
    const portList = informPorts.map(p =>
      `Port ${p.port}${p.description ? ` (${p.description})` : ''}`
    ).join(', ');
    prefix += `**INFO: Monitored port(s) down:** ${portList}\n\n`;
  }

  return {
    blocked: false,
    prefix,
    markAsError: errorPorts.length > 0
  };
}

/**
 * Check for blocking bugs from recordings
 * Only allows the 'acknowledge' action in the issues tool
 */
export async function checkBugBlocking(toolName: string, toolArgs?: Record<string, unknown>): Promise<PreExecutionResult> {
  const hasBugs = await hasPendingBugs();
  if (!hasBugs) {
    return { blocked: false, prefix: '', markAsError: false };
  }

  // Only allow issues tool with acknowledge action
  if (toolName === 'issues' && toolArgs?.action === 'acknowledge') {
    return { blocked: false, prefix: '', markAsError: false };
  }

  // Also allow issues tool with list action (to see what's blocking)
  if (toolName === 'issues' && toolArgs?.action === 'list') {
    return { blocked: false, prefix: '', markAsError: false };
  }

  const pendingBugs = await getPendingBugs();
  const bugList = pendingBugs.map(b => `- [#${b.id}] "${b.title}" (from ${b.recordingName})`).join('\n');

  return {
    blocked: true,
    response: createErrorResponse('BUGS_BLOCKING', { bugList }),
    block: {
      guard: 'bug',
      key: pendingBugs.map(b => b.id).sort((a, b) => a - b).join(','),
      detail: `Pending bug(s): ${pendingBugs.map(b => `#${b.id} "${b.title}"`).join(', ')}`,
      resolve: `issues({ action: 'acknowledge', id: ${pendingBugs[0].id} })`,
    }
  };
}


/**
 * Information about a paused breakpoint
 */
export interface BreakpointPauseInfo {
  reference: string;
  location?: {
    url: string;
    lineNumber: number;
  };
  callFrameId?: string;
  /** Set when a watch-mode restart is queued behind this pause - see server-manager's WatchRestartState. */
  pendingRestart?: PendingRestartInfo;
}

/**
 * Tools that are allowed to execute when blocked due to breakpoint pause
 * These are tools needed to inspect the paused state or resume execution
 */
const BREAKPOINT_ALLOWED_TOOLS = new Set([
  'execution',    // Resume, step, pause operations
  'inspect',      // Get call stack, variables, evaluate expression
  'breakpoint',   // Manage breakpoints
  'console',      // View console logs
  'annotate',     // Owns the pause it would otherwise be blocked by
]);

/**
 * Specific tool+action combos allowed even when otherwise blocked - narrower
 * than BREAKPOINT_ALLOWED_TOOLS, for actions that need to run precisely
 * because a pause is blocking things (e.g. discarding a restart that's
 * queued behind this very pause - blocking it would make it uncancellable).
 */
const BREAKPOINT_ALLOWED_TOOL_ACTIONS: Record<string, Set<string>> = {
  server: new Set(['cancelPendingRestart']),
};

/**
 * Check for breakpoint pauses and determine pre-execution behavior
 * Similar to checkPortFailures, but for breakpoint blocking
 */
export function checkBreakpointPause(
  connections: Connection[],
  toolName: string,
  getPendingRestart?: (port: number) => PendingRestartInfo | null,
  action?: string
): PreExecutionResult {
  // Find connections that are paused and not acknowledged
  const pausedConnections: BreakpointPauseInfo[] = [];

  for (const conn of connections) {
    if (conn.cdpManager.isPaused() && !conn.breakpointPauseAcknowledged) {
      const pauseInfo = conn.cdpManager.getPausedInfo();
      const topFrame = pauseInfo.callStack?.[0];
      pausedConnections.push({
        reference: conn.reference || conn.id,
        location: pauseInfo.location,
        callFrameId: topFrame?.callFrameId,
        pendingRestart: getPendingRestart?.(conn.port) ?? undefined,
      });
    }
  }

  // No paused connections, allow execution
  if (pausedConnections.length === 0) {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Check if tool is allowed when paused
  if (BREAKPOINT_ALLOWED_TOOLS.has(toolName) || (action !== undefined && BREAKPOINT_ALLOWED_TOOL_ACTIONS[toolName]?.has(action))) {
    // Allow but prepend info about paused state
    const pauseList = pausedConnections.map(p => {
      const loc = p.location
        ? ` at ${p.location.url}:${p.location.lineNumber}`
        : '';
      return `"${p.reference}"${loc}`;
    }).join(', ');

    const restartNotes = pausedConnections
      .filter(p => p.pendingRestart)
      .map(p => `⚠️ A file change was detected for "${p.reference}" - its watch-mode restart is queued and will run as soon as you resume. Use \`server({ action: 'cancelPendingRestart', serverId: '${p.pendingRestart!.serverId}' })\` to discard it and keep debugging.`)
      .join('\n');

    return {
      blocked: false,
      prefix: `**Paused at breakpoint:** ${pauseList}\n\n${restartNotes ? restartNotes + '\n\n' : ''}`,
      markAsError: false
    };
  }

  // Block other tools
  const pauseDetails = pausedConnections.map(p => {
    const loc = p.location
      ? `\n  Location: ${p.location.url}:${p.location.lineNumber}`
      : '';
    const frameId = p.callFrameId
      ? `\n  callFrameId: "${p.callFrameId}"`
      : '';
    const restart = p.pendingRestart
      ? `\n  ⚠️ Watch-mode restart queued (server "${p.pendingRestart.serverId}") - will run once resumed`
      : '';
    return `- "${p.reference}"${loc}${frameId}${restart}`;
  }).join('\n');

  // Build getVariables hint with callFrameId if available
  const firstCallFrameId = pausedConnections[0]?.callFrameId;
  const getVariablesHint = firstCallFrameId
    ? `\`inspect({ action: 'getVariables', callFrameId: '${firstCallFrameId}' })\``
    : `\`inspect({ action: 'getVariables' })\``;

  const firstPendingRestart = pausedConnections.find(p => p.pendingRestart)?.pendingRestart;
  const cancelRestartHint = firstPendingRestart
    ? `\n- A watch-mode restart is queued for server "${firstPendingRestart.serverId}" - use \`server({ action: 'cancelPendingRestart', serverId: '${firstPendingRestart.serverId}' })\` to discard it and keep debugging, instead of resuming into a restart`
    : '';

  return {
    blocked: true,
    response: {
      content: [
        {
          type: 'text',
          text: `**BLOCKED: Execution paused at breakpoint**

The following connection(s) are paused at a breakpoint:
${pauseDetails}

**To continue:**
- Use \`execution({ action: 'resume' })\` to resume execution
- Use \`execution({ action: 'acknowledge' })\` to acknowledge and continue using other tools while paused
- Use \`inspect({ action: 'getCallStack' })\` or ${getVariablesHint} to examine state${cancelRestartHint}

Other tools are blocked until execution is resumed or acknowledged.`,
        },
      ],
      isError: true
    },
    block: {
      guard: 'breakpoint',
      key: pausedConnections.map(p => {
        const loc = p.location ? `@${p.location.url}:${p.location.lineNumber}` : '';
        return `${p.reference}${loc}`;
      }).sort().join(','),
      detail: `Paused at breakpoint: ${pausedConnections.map(p => {
        const loc = p.location ? ` at ${p.location.url}:${p.location.lineNumber}` : '';
        return `"${p.reference}"${loc}`;
      }).join(', ')}`,
      resolve: `execution({ action: 'resume' }) or execution({ action: 'acknowledge' })`,
    }
  };
}

/**
 * Check for pending startup failures and determine pre-execution behavior
 * Blocks tools when servers have failed to start (timeout or died) and not acknowledged
 */
export function checkPendingStartups(
  failures: PendingStartupFailureInfo[],
  toolName: string
): PreExecutionResult {
  // No failures, allow execution
  if (failures.length === 0) {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Server tool is always allowed (needed to acknowledge/manage servers)
  // Issues tool is always allowed (logging/tracking bugs shouldn't be gated on unrelated server health)
  if (toolName === 'server' || toolName === 'issues') {
    return {
      blocked: false,
      prefix: '',
      markAsError: false
    };
  }

  // Build blocking message based on failure reasons
  const timeoutFailures = failures.filter(f => f.reason === 'timeout');
  const diedFailures = failures.filter(f => f.reason === 'died');

  let message = 'BLOCKED: Server startup issue(s)\n\n';

  if (timeoutFailures.length > 0) {
    message += `Startup timeout - The following server(s) started but no port was detected within 30 seconds:\n`;
    for (const f of timeoutFailures) {
      const elapsed = Math.round((Date.now() - f.startedAt.getTime()) / 1000);
      message += `- "${f.serverId}" (started ${elapsed}s ago)\n`;
    }
    message += '\n';
  }

  if (diedFailures.length > 0) {
    message += `Server died - The following server(s) died before port was detected:\n`;
    for (const f of diedFailures) {
      message += `- "${f.serverId}"\n`;
    }
    message += '\n';
  }

  message += `Options:\n`;
  message += `- Check logs: server({ action: 'logs', serverId: '<id>' })\n`;
  message += `- Acknowledge and continue: server({ action: 'acknowledgeStartup', serverId: '<id>' })\n`;

  if (timeoutFailures.length > 0) {
    message += `- Extend timeout 30s: server({ action: 'extendStartup', serverId: '<id>' })\n`;
  }

  if (diedFailures.length > 0) {
    message += `- Restart server: server({ action: 'restart', serverId: '<id>' })\n`;
  }

  message += `- Stop server: server({ action: 'stop', serverId: '<id>' })`;

  return {
    blocked: true,
    response: {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true
    },
    block: {
      guard: 'pendingStartup',
      key: failures.map(f => `${f.serverId}:${f.reason}`).sort().join(','),
      detail: [
        timeoutFailures.length > 0 ? `startup timeout: ${timeoutFailures.map(f => `"${f.serverId}"`).join(', ')}` : '',
        diedFailures.length > 0 ? `died before port detected: ${diedFailures.map(f => `"${f.serverId}"`).join(', ')}` : '',
      ].filter(Boolean).join('; '),
      resolve: `server({ action: 'acknowledgeStartup', serverId: '${failures[0].serverId}' })`,
    }
  };
}

/**
 * Duplicate session info for blocking check
 */
export interface DuplicateSessionInfo {
  sessionId: string;
  shortId: string;
  allPids: number[];      // MCP process IDs
  allPpids: number[];     // Claude session process IDs (parents)
  currentPid: number;     // This MCP process ID
  currentPpid: number;    // This Claude session process ID
}

/**
 * Check for duplicate session (multiple MCPs sharing same Claude session)
 * Both original and duplicate sessions are blocked with appropriate messages
 */
export function checkDuplicateSession(
  info: DuplicateSessionInfo | null,
  toolName: string
): PreExecutionResult {
  // No session info or not a duplicate - allow
  if (!info || info.allPids.length <= 1) {
    return { blocked: false, prefix: '', markAsError: false };
  }

  const firstPid = info.allPids[0];
  const isOriginal = info.currentPid === firstPid;
  const duplicatePids = info.allPids.filter(p => p !== firstPid);
  const duplicatePpids = info.allPpids.filter(p => p !== info.allPpids[0]);

  if (isOriginal) {
    // Original session - tell them about the duplicate and how to kill it
    return {
      blocked: true,
      response: {
        content: [
          {
            type: 'text',
            text: `**BLOCKED: Duplicate MCP session detected**

**To fix:** Kill the duplicate Claude session:
\`\`\`
kill ${duplicatePpids.length > 0 ? duplicatePpids.join(' ') : duplicatePids.join(' ')}
\`\`\`

Another Claude session has connected with the same session ID:

- Session ID: ${info.shortId} (${info.sessionId})
- This Claude PID: ${info.currentPpid} (original)
- Duplicate Claude PID(s): ${duplicatePpids.join(', ') || duplicatePids.join(', ')}
- MCP Version: ${MCP_VERSION}`,
          },
        ],
        isError: true
      },
      block: {
        guard: 'duplicateSession',
        key: `original:${info.sessionId}`,
        detail: `Duplicate MCP session for ${info.shortId} - this session is the original, duplicate Claude PID(s) ${duplicatePpids.join(', ') || duplicatePids.join(', ')}`,
        resolve: `kill ${duplicatePpids.length > 0 ? duplicatePpids.join(' ') : duplicatePids.join(' ')}`,
      }
    };
  } else {
    // Duplicate session - tell them to fork
    const firstPpid = info.allPpids[0] || firstPid;
    return {
      blocked: true,
      response: {
        content: [
          {
            type: 'text',
            text: `**BLOCKED: Duplicate MCP session detected**

**To fix:** Exit this session and run:
\`\`\`
claude --resume ${info.sessionId} --fork-session
\`\`\`

Another Claude session is already running with this session ID:

- Session ID: ${info.shortId} (${info.sessionId})
- Original Claude PID: ${firstPpid}
- This Claude PID: ${info.currentPpid} (duplicate)
- MCP Version: ${MCP_VERSION}`,
          },
        ],
        isError: true
      },
      block: {
        guard: 'duplicateSession',
        key: `duplicate:${info.sessionId}`,
        detail: `Duplicate MCP session for ${info.shortId} - this session is the duplicate, original Claude PID ${firstPpid}`,
        resolve: `claude --resume ${info.sessionId} --fork-session`,
      }
    };
  }
}

/**
 * Prepend text to the first text content item in a response
 */
export function prependToResponse(response: ToolResponse, prefix: string): void {
  if (!prefix || !response.content || response.content.length === 0) return;

  const firstContent = response.content[0];
  if (firstContent && firstContent.type === 'text' && firstContent.text) {
    firstContent.text = prefix + firstContent.text;
  }
}

/**
 * Append text to the last text content item in a response
 */
export function appendToResponse(response: ToolResponse, suffix: string): void {
  if (!suffix || !response.content || response.content.length === 0) return;

  const lastContent = response.content[response.content.length - 1];
  if (lastContent && lastContent.type === 'text' && lastContent.text) {
    lastContent.text += suffix;
  }
}

/**
 * Status line item for post-response status
 */
export interface StatusLineItem {
  label: string;
  value: string;
}

/**
 * Build status lines suffix from items
 */
export function buildStatusSuffix(items: StatusLineItem[], legend = false): string {
  if (items.length === 0) return '';

  const lines = items.map(item => `${item.label}: ${item.value}`);
  return `\n\n${lines.join('\n')}${legend ? `\n${getMessage('STATUS_LEGEND')}` : ''}`;
}


