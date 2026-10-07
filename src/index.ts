#!/usr/bin/env node

// Early stderr logging for debugging startup issues
// Any argument means a CLI invocation, which prints its own output and
// nothing else - this line would land in the middle of it.
if (process.argv[2] === undefined) {
  console.error(`[devharness] Process starting (PID: ${process.pid})`);
}

// Capture startup time immediately before any imports
const STARTUP_TIME = performance.now();

/**
 * devharness
 * MCP server providing Chrome DevTools Protocol debugging capabilities to AI assistants
 */

import { boundReply } from './reply-bound.js';
import { enableRunLog } from './run-log.js';
import { benchHold, isBenchOpen } from './bench-mode.js';
import { runAs, appendEvent } from './session-events.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { CDPManager } from './cdp-manager.js';
import { SourceMapHandler } from './sourcemap-handler.js';
import { ChromeLauncher } from './chrome-launcher.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import { ConnectionManager, type Connection } from './connection-manager.js';
import { createConnectionTools } from './tools/connection-tools.js';
import { callTarget, unknownToolResponse } from './tools/legacy-steps.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { PortReserver } from './port-reserver.js';
import { validateParams, describeRefusal } from './validation-helpers.js';
import { ClickableCache } from './clickable-cache.js';
import { CommandRecorder } from './command-recorder.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';
import { createExecutionTools } from './tools/execution-tools.js';
import { createInspectionTools } from './tools/inspection-tools.js';
import { createSourceTools } from './tools/source-tools.js';
import { createConsoleTools } from './tools/console-tools.js';
import { createNetworkTools } from './tools/network-tools.js';
import { createProxyTools } from './tools/proxy-tools.js';
import { createHoldTools } from './tools/hold-tools.js';
import { heldConnections, holdReading } from './hold.js';
import { createPageTools } from './tools/page-tools.js';
import { createDOMTools } from './tools/dom-tools.js';
import { createScreenshotTools } from './tools/screenshot-tools.js';
import { createInputTools } from './tools/input-tools.js';
import { createContentTools } from './tools/content-tools.js';
import { createStorageTools } from './tools/storage-tools.js';
import { createDownloadTools } from './tools/download-tools.js';
import { createRequestTools } from './tools/request-tools.js';
import { createAssertTools } from './tools/assert-tools.js';
import { createWaitTools } from './tools/wait-tools.js';
import { createCheckTools } from './tools/check-tools.js';
import { createModalTools } from './tools/modal-tools.js';
import { createBenchTools } from './tools/bench-tools.js';
import { createReplayTools } from './tools/replay-tools.js';
import { createServerTools } from './tools/server-tools.js';
import { createConfigTools } from './tools/config-tools.js';
import { createPluginTools } from './tools/plugin-tools.js';
import { createIssuesTools } from './tools/issues-tools.js';
import { createMessageTools } from './tools/message-tools.js';
import { startSessionEndpoint, type SessionEndpoint } from './session-endpoint.js';
import { runCli, isCliCommand, isVersionFlag, readPackageVersion } from './cli/index.js';
import { getClaudeSessionId, resolveSessionName, resolveRestartStableSessionName } from './session-identity.js';
import { createDashboardTools, setDashboardInstance, getDashboardInstance, setSessionInfo, getSessionInfo, getDuplicateSessionInfo } from './tools/dashboard-tools.js';
import { initializeDashboard, shutdownDashboard, type DashboardInstance, type ConnectionInfo as DashboardConnectionInfo } from './dashboard/index.js';
import { Orchestrator } from './log-processor/orchestrator.js';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, promises as fsPromises } from 'fs';
import { homedir } from 'os';
import { ServerManager } from './server-manager.js';
import { configManager } from './config.js';
import { ToolError } from './tool-error.js';
import type { ServerLog, ServerRow, ToolGroup, ToolValues } from './bench/wire.js';
import { arriveOn, unlisted, historyPlace, entryChannel, asInnerCall } from './call-origin.js';
import { markNextCommand, releaseCommand, noteCallStart, newlyIdleProxies, attachEntryToCursor } from './proxy/registry.js';
import { describePersonInput, recordPersonInputInto, takeUnreadPersonInput, watchPersonInput } from './person-watch.js';
import { activitySummary } from './activity-index.js';

/**
 * Tools that read the app without driving it.
 *
 * They take no proxy cursor, so a screenshot taken while a navigate is still
 * settling leaves the navigate's cursor in place rather than claiming the
 * traffic it caused. Most concurrency in a session is one driving command with
 * observers alongside, and this makes that case exact.
 *
 * A tool that can cause traffic belongs on the other side of this line however
 * much it also reads.
 */
const OBSERVING_TOOLS = new Set([
  'screenshot', 'content', 'inspect', 'proxy', 'network', 'console',
  'wait', 'assert', 'check', 'dashboard', 'issues', 'message', 'source', 'config',
]);
/** Actions that read without acting, in tools whose other actions act on a connection or page. */
const OBSERVING_ACTIONS: Record<string, ReadonlySet<string>> = {
  connection: new Set(['list', 'status', 'browsers']),
  modal: new Set(['detect']),
};

function observes(toolName: string, args: Record<string, unknown> | undefined): boolean {
  return OBSERVING_TOOLS.has(toolName)
    || (OBSERVING_ACTIONS[toolName]?.has(String(args?.action)) ?? false);
}

/**
 * The `replay` actions history holds: the ones that run, write or change a
 * sequence. Reads stay out, so looking at history does not move the indices
 * just read, and so does `repeat`, so a repeat of history never replays a
 * repeat.
 */
const RECORDED_REPLAY_ACTIONS = new Set([
  'run', 'runAll', 'step', 'finish', 'cancel', 'recordInteraction', 'runFromLog',
  'create', 'insert', 'addCheck', 'declare', 'repair', 'copy', 'split', 'adopt',
  'export', 'load', 'delete', 'deleteSaved',
]);

/** Whether history holds this call. */
function recordedInHistory(toolName: string, args: Record<string, unknown> | undefined): boolean {
  return toolName !== 'replay' || RECORDED_REPLAY_ACTIONS.has(String(args?.action));
}
import { checkPortFailures, checkBreakpointPause, checkBugBlocking, checkPendingStartups, checkDuplicateSession, prependToResponse, appendToResponse, buildStatusSuffix, type StatusLineItem } from './tool-response.js';
import { recordBlockEvent, clearBlockEvents } from './block-events.js';
import { createStartupGate } from './startup-gate.js';
import { createErrorResponse, getErrorMessage, messages, historyFooter, isParameterError } from './messages.js';
import { setChromeLauncher } from './error-helpers.js';
import { createServer } from 'net';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { debugLog, enableDebugLogging, enableHistoryLogging, setStartupMetrics } from './debug-logger.js';
import { deriveConnectionReference, sanitizeReference, InvalidReferenceError, UNNAMED_CONNECTION } from './reference-validator.js';
import { underDialogs, type DialogTarget } from './dialog-gate.js';
import { initializePaths, resolveStateDir, getOutputPath } from './helpers/paths.js';
import { cleanupStaleTempFiles, cleanupStaleTempFilesSync } from './atomic-write.js';
import { createSessionDetector, type SessionInfo, type SessionDetector } from './session-detector.js';
import { serverClaims } from './server-claims.js';

/** Tools that move a page, and would wait on one the bench holds still. */
const DRIVING_TOOLS = new Set(['input', 'navigate', 'wait']);
/** The replay actions that drive a page: a run or its steps, and a repeat of past calls. */
const DRIVING_REPLAY = new Set(['run', 'runAll', 'step', 'finish', 'runFromLog', 'repeat']);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * This package's version, read from package.json rather than duplicated here
 * so it cannot drift. Used to report the server version and to detect an
 * installed skill left behind by an older release (see getSkillInstallState).
 */
const SERVER_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Tool calls wait on this until serverManager.initialize() has restored state. */
const startupGate = createStartupGate({
  timeoutMs: 30_000,
  onTimeout: (ms) =>
    console.error(`[devharness] Startup recovery still running after ${ms}ms - serving tools anyway`),
});

/**
 * Which build is actually answering, reported by `config status` so a session
 * can compare the code it calls with the code it just compiled.
 *
 * A rebuild signals the supervisor named in this project's pidfile, which is
 * not necessarily the supervisor serving this session - when it isn't, the
 * build reports success and the old code keeps answering, and behaviour read
 * from it describes a stale build (issue #135).
 *
 * `buildMtime` is read once at startup, so it dates the running code rather
 * than whatever is on disk now - which is the whole point of the comparison.
 */
const BUILD_IDENTITY: { entryPath: string; buildMtime: string } = (() => {
  const entryPath = __filename;
  try {
    return { entryPath, buildMtime: statSync(entryPath).mtime.toISOString() };
  } catch {
    return { entryPath, buildMtime: 'unknown' };
  }
})();

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    // Explicitly bind to IPv4 localhost to match Chrome's behavior
    server.listen(startPort, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      console.error(`[devharness] findAvailablePort: Port ${port} is available`);
      server.close(() => resolve(port));
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Port in use, try next one
        console.error(`[devharness] findAvailablePort: Port ${startPort} is in use, trying ${startPort + 1}`);
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Find starting port from environment variable or auto-assign
 */
async function findStartingPort(): Promise<number> {
  const envPort = process.env.MCP_DEBUG_PORT;
  const startingPort = configManager.getChromeConfig().startingDebugPort;

  if (envPort) {
    const port = parseInt(envPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error(`Invalid MCP_DEBUG_PORT: ${envPort}. Using auto-assigned port.`);
      return findAvailablePort(startingPort);
    }
    return port;
  }

  return findAvailablePort(startingPort);
}

/**
 * Locations a skills-aware client (Claude Code and others following the
 * agentskills.io convention) would scan for the bundled devharness skill.
 * Checked at both project- and user-level, and both the client-native
 * `.claude/skills/` path and the cross-client `.agents/skills/` convention.
 */
function findSkillInstallCandidates(): string[] {
  const scanned = [
    join(process.cwd(), '.claude', 'skills', 'devharness'),
    join(process.cwd(), '.agents', 'skills', 'devharness'),
    join(homedir(), '.claude', 'skills', 'devharness'),
    join(homedir(), '.agents', 'skills', 'devharness'),
  ];
  return [...scanned, ...findPluginSkillDirs()];
}

/**
 * Skill directories belonging to an installed Claude Code plugin.
 *
 * A plugin ships the skill itself, so the client already has a current copy and
 * the nudge would be telling the user to hand-install something they have.
 * These live at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/
 * which is not a path this package controls, so it is discovered rather than
 * assumed, and any failure just yields no candidates.
 */
function findPluginSkillDirs(): string[] {
  const root = join(homedir(), '.claude', 'plugins', 'cache');
  const found: string[] = [];
  try {
    for (const marketplace of readdirSync(root, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const pluginDir = join(root, marketplace.name, 'devharness');
      if (!existsSync(pluginDir)) continue;
      for (const version of readdirSync(pluginDir, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        found.push(join(pluginDir, version.name, 'skills', 'devharness'));
      }
    }
  } catch {
    // No plugin cache, or unreadable: nothing to add.
  }
  return found;
}

/** Version stamped into a SKILL.md frontmatter, if it has one. */
function readSkillVersion(skillFile: string): string | null {
  try {
    const head = readFileSync(skillFile, 'utf-8').slice(0, 2000);
    return head.match(/^version:\s*(.+)$/m)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

type SkillInstallState =
  | { status: 'absent' }
  | { status: 'current' }
  | { status: 'stale'; path: string; installedVersion: string | null };

/**
 * Whether an installed copy of the skill exists and whether it matches this
 * package.
 *
 * Presence alone is not enough. The documented install is a symlink into the
 * package, which tracks upgrades for free - but nothing stops a client or user
 * from *copying* the directory instead, and a copy is frozen forever: the file
 * exists, so a presence-only check suppresses the nudge permanently and the
 * user silently runs an old skill against a newer tool surface. Comparing the
 * stamped version catches the copy case without needing any install machinery
 * of our own.
 */
function getSkillInstallState(): SkillInstallState {
  let stale: { path: string; installedVersion: string | null } | null = null;

  for (const dir of findSkillInstallCandidates()) {
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    const installedVersion = readSkillVersion(skillFile);
    // A symlink into this package reads back our own file, so this matches and
    // we stop. Any installed copy that predates the version stamp reports null,
    // which is itself evidence of staleness.
    if (installedVersion === SERVER_VERSION) return { status: 'current' };

    stale ??= { path: skillFile, installedVersion };
  }

  return stale ? { status: 'stale', ...stale } : { status: 'absent' };
}

/**
 * Load the MCP `instructions` payload from docs/mcp-instructions.md.
 *
 * Kept short and separate from docs/instructions.md (the full human-readable
 * reference): many MCP clients inject this field into the model's context
 * unconditionally at session start, so it shouldn't carry the full tool
 * catalog. The full reference is instead shipped as a progressive-disclosure
 * Agent Skill (skills/devharness/) that skills-aware clients load on demand.
 *
 * If that skill isn't installed anywhere a client would scan for it - or an
 * installed copy is stamped with an older version of this package - append a
 * nudge asking the model to offer setting it up, but only ask, never symlink
 * it in unprompted. Once a matching version is installed this stops appearing.
 */
async function loadInstructions(): Promise<string | undefined> {
  try {
    const instructionsPath = join(__dirname, '..', 'docs', 'mcp-instructions.md');
    const instructions = await readFile(instructionsPath, 'utf-8');

    const skillState = getSkillInstallState();
    if (skillState.status === 'current') {
      return instructions;
    }

    const skillSourcePath = join(__dirname, '..', 'plugin', 'skills', 'devharness');
    const install = `\`\`\`bash\nmkdir -p .claude/skills\nrm -rf .claude/skills/devharness\nln -s "${skillSourcePath}" .claude/skills/devharness\n\`\`\``;

    const nudge = skillState.status === 'absent'
      ? `\n\n---\n\n**Setup nudge (one-time):** No devharness Agent Skill was found in this project or your home directory (checked \`.claude/skills/\`, \`.agents/skills/\`, and installed plugins). Ask the user if they'd like it installed - if they agree, run:\n\n${install}\n\nDo not create the symlink without asking first. This message stops appearing once the skill is installed anywhere it would be scanned.\n`
      : `\n\n---\n\n**Stale skill:** The devharness Agent Skill at \`${skillState.path}\` is from version ${skillState.installedVersion ?? 'an unstamped release'}, but this server is ${SERVER_VERSION}. It was copied rather than symlinked, so it no longer tracks upgrades and may describe tools or actions that have since changed. Ask the user whether to replace it with a symlink that stays current:\n\n${install}\n\nDo not delete or replace their file without asking first - and note the skill is read by the client at session start, so it only takes effect in a new session.\n`;

    return instructions + nudge;
  } catch (error) {
    console.error('[devharness] Failed to load instructions file:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

// Initialize global managers
const sourceMapHandler = new SourceMapHandler();

const chromeLauncher = new ChromeLauncher({
  // Resolved lazily so a live config reload of chrome.persistentProfileRoot
  // (global ~/.devharness/profiles by default, or a project-local override)
  // is picked up without restarting the server.
  persistentProfileRoot: () => configManager.getPersistentProfileRoot(),
});
const connectionManager = new ConnectionManager();
const logpointTracker = new LogpointExecutionTracker();
const clickableCache = new ClickableCache();
const commandRecorder = new CommandRecorder();
recordPersonInputInto(commandRecorder);
const portReserver = new PortReserver();
const serverManager = new ServerManager();

// Configure connection manager to kill Chrome when last connection closes
connectionManager.setChromeLauncher(chromeLauncher);

// Let ServerManager's watch mode check whether a connection at a given
// inspector port is paused at a breakpoint, so it can defer a file-change
// restart until the debugger resumes (see requestWatchRestart()). Watched
// processes are always local, so 'localhost' matches how connection attach
// registers them by default.
serverManager.setPauseChecker((port) => {
  return connectionManager.findConnectionByPort('localhost', port)?.cdpManager.isPaused() ?? false;
});

// Set ChromeLauncher reference for error-helpers (used to verify Chrome is running)
setChromeLauncher(chromeLauncher);

// Set up Chrome exit callback to clean up connections and reserve a new port
chromeLauncher.setOnExitCallback(async (event) => {
  const { port } = event;
  await debugLog('index', `Chrome exited on port ${port} (reason: ${event.reason})`);

  // Clean up all connections for the dead Chrome instance
  // Note: ChromeLauncher only launches on localhost, so this is always correct
  const connectionsToClose = connectionManager.getConnectionsForBrowser('localhost', port);
  for (const conn of connectionsToClose) {
    try {
      await connectionManager.closeConnection(conn.id);
      await debugLog('index', `Closed connection ${conn.id} after Chrome exit`);
    } catch (closeError) {
      await debugLog('index', `Failed to close connection ${conn.id}: ${closeError}`);
    }
  }

  // Reserve a new port for future launches
  try {
    const startingPort = configManager.getChromeConfig().startingDebugPort;
    const newPort = await findAvailablePort(startingPort);
    await portReserver.reserve(newPort);
    configManager.setCurrentPort(newPort);
    await debugLog('index', `Reserved new port ${newPort}`);
  } catch (error) {
    await debugLog('index', `Failed to reserve new port after Chrome exit: ${error}`);
  }
});

/**
 * Create and configure the MCP server with instructions
 */
async function createMCPServer(): Promise<Server> {
  const instructions = await loadInstructions();

  return new Server(
    {
      name: 'devharness-debugger',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        // listChanged: true so mcp-supervisor.ts's notifications/tools/list_changed
        // (sent after a hot-restart) is spec-compliant to send.
        tools: { listChanged: true },
      },
      instructions,
    }
  );
}

// Session detection state (set in main, used in tool handler)
let sessionDetectorInstance: SessionDetector | null = null;
let sessionVerifyStarted = false;

// Log processor orchestrator (set in main for hub instances)
let orchestratorInstance: Orchestrator | null = null;

/**
 * The connection called `name`, with its managers, or null when no
 * connection has that name. Every tool that acts on a connection reaches it
 * here, and each reach counts as activity against the inactivity timeout.
 */
/**
 * Watch the page a call named for a person's input, once the call has run: a
 * launch has made the page by then, and every later call on it finds it watched.
 */
async function watchNamedPage(params: Record<string, unknown> | undefined): Promise<void> {
  const named = params?.connection;
  if (typeof named !== 'string' || !configManager.getReplayConfig().watchPersonInput) return;
  const resolved = await resolveConnectionByName(named).catch(() => null);
  const page = resolved?.puppeteerManager ? await Promise.resolve(resolved.puppeteerManager.getPage()).catch(() => null) : null;
  if (page) await watchPersonInput(sanitizeReference(named), page).catch(() => {});
}

async function resolveConnectionByName(name: string): Promise<{
  connection: Connection;
  cdpManager: CDPManager;
  puppeteerManager: PuppeteerManager | null;
  consoleMonitor: ConsoleMonitor | null;
  networkMonitor: NetworkMonitor | null;
} | null> {
  const connection = connectionManager.findConnectionByReference(name);
  if (!connection) {
    return null;
  }
  connectionManager.updateActivity(connection.id);

  return {
    connection,
    cdpManager: connection.cdpManager,
    puppeteerManager: connection.puppeteerManager || null,
    consoleMonitor: connection.consoleMonitor || null,
    networkMonitor: connection.networkMonitor || null,
  };
}

/** Marks a connection active, which `connection list` reports and `switch` sets. */
function activateConnection(connectionId: string): void {
  if (connectionManager.setActiveConnection(connectionId)) {
    connectionManager.updateActivity(connectionId);
  }
}
const connectionTools = createConnectionTools({
  chromeLauncher,
  connectionManager,
  portReserver,
  serverManager,
  sourceMapHandler,
  logpointTracker,
  activateConnection,
  findAvailablePort,
});

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}

let pidAnnounced = false;
let statusLegendShown = false;

/** A call the schema refused, as an error response carrying the fields it names. */
function validationFailure(toolName: string, error: any): any {
  return {
    content: [{ type: 'text', text: getErrorMessage('PARAMETERS_REFUSED', { tool: toolName, issues: describeRefusal(error) }) }],
    isError: true,
    _errorId: error.code,
    _parameters: error.parameters,
  };
}

/**
 * The refusal for a tool that would drive a page the bench holds - held,
 * running a sequence, recording. The page cannot move, so the call would
 * wait on it to its timeout and hold the caller with it; refused at once,
 * naming what holds it. A check read once answers from the page as it is;
 * one read again until it holds waits on the page moving, as a wait does.
 */
function pageHeldRefusal(toolName: string, args: Record<string, any>): any {
  const drives = DRIVING_TOOLS.has(toolName)
    || (toolName === 'check' && Number(args.withinMs) > 0)
    || (toolName === 'replay' && DRIVING_REPLAY.has(String(args.action)));
  if (!drives) return undefined;
  const resumesRun = toolName === 'replay' && RESUMES_HELD_RUN.has(String(args.action));
  const hold = benchHold(args.connection, resumesRun);
  if (hold) return createErrorResponse('PAGE_HELD_BY_BENCH', { ...hold, toolName });
  const held = heldPage(args.connection, resumesRun);
  return held ? createErrorResponse('PAGE_HELD', { ...held, toolName }) : undefined;
}

/** The replay actions that release the hold a paused run placed before they drive the page. */
const RESUMES_HELD_RUN = new Set(['step', 'finish']);

/**
 * A page whose JS a hold stops, with no bench open on it: the hold tool's, a
 * paused run's, a trigger's. A click or a step on it waits until its timeout.
 * A breakpoint's stop is left to the paused-execution guard. With no
 * connection named, the first held page.
 */
function heldPage(connection: string | undefined, resumesRun: boolean): { connection: string; why: string; release: string } | undefined {
  const names = connection !== undefined ? [sanitizeReference(connection)] : heldConnections();
  for (const name of names) {
    const held = holdReading(name).held.filter(layer => !layer.via && layer.layer !== 'network' && layer.source !== 'breakpoint'
      && !(resumesRun && layer.source === 'sequence'));
    if (!held.length) continue;
    return {
      connection: name,
      why: `its ${held.map(layer => layer.layer).join(' and ')} ${held.length > 1 ? 'are' : 'is'} held by the ${held[0].source}`,
      release: held.every(layer => layer.source === 'sequence')
        ? `replay({ action: 'finish' }) or replay({ action: 'step' }) carries the paused run on and releases it; replay({ action: 'cancel' }) releases it and ends the run`
        : `hold({ action: 'release', connection: '${name}' })`,
    };
  }
  return undefined;
}

/** The page a call names, with the monitor on its dialogs; undefined for a call that names none. */
function dialogTargetOf(args: Record<string, any>): DialogTarget | undefined {
  const connection = typeof args.connection === 'string'
    ? connectionManager.findConnectionByReference(args.connection)
    : null;
  return connection?.dialogMonitor
    ? { reference: connection.reference || UNNAMED_CONNECTION, monitor: connection.dialogMonitor }
    : undefined;
}

/**
 * Run a tool call that did not arrive over MCP: a replay step, a bench action,
 * a CLI call, or a call one tool makes to another. An isError answer is thrown
 * as a ToolError.
 */
async function executeToolCall(calledName: string, calledParams: Record<string, any>, abortSignal?: AbortSignal): Promise<any> {
  const { toolName, params, tool } = callTarget<any>(allTools, calledName, calledParams);

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // The MCP handler refuses before it gets here; a CLI call arrives here first.
  // A run's step meets the same refusal, so a step on a held page fails naming
  // the hold rather than waiting out its step timeout.
  const cliEntry = entryChannel() === 'cli';
  if (cliEntry) {
    const held = pageHeldRefusal(toolName, params);
    if (held) throw new ToolError(held);
  } else if (historyPlace()?.run !== undefined && DRIVING_TOOLS.has(toolName)) {
    // A run's own step: the bench's guard against a second driver beside a run
    // it plays would refuse the step that run is taking. Only a hold that
    // stops the page refuses it. The refused step is recorded first, so the
    // run lists the step it failed on rather than ending with no row for it.
    const held = heldPage(params.connection, false);
    if (held) {
      const refused = createErrorResponse('PAGE_HELD', { ...held, toolName });
      const stepPlace = historyPlace();
      if (stepPlace) {
        await commandRecorder.recordCommand(toolName, params, stepPlace);
        commandRecorder.attachResult(commandRecorder.getCurrentHistoryIndex(), refused);
      }
      throw new ToolError(refused);
    }
  }

  const validation = validateParams(params, (tool as any).zodSchema, toolName);

  // A call from the CLI, the bench or a run's step is a command as much as
  // one over MCP, so history holds it with where it came in. A call the schema
  // refused is held too, so a repeat can replace the fields it named.
  const place = recordedInHistory(toolName, params) ? historyPlace() : undefined;

  if (!validation.success) {
    const refused = validationFailure(toolName, validation.error);
    if (place) {
      await commandRecorder.recordCommand(toolName, params, place);
      commandRecorder.attachResult(commandRecorder.getCurrentHistoryIndex(), refused);
    }
    throw new ToolError(refused);
  }

  let index: number | null = null;
  if (place) {
    await commandRecorder.recordCommand(toolName, validation.data, place);
    index = commandRecorder.getCurrentHistoryIndex();
    // A run's step was already counted as a call by the executor that ran it,
    // and a replay call walks steps counted on their own; a second start
    // would stand between a traffic check and the step it counts back to.
    if (toolName !== 'replay' && !place.run) noteCallStart();
    // A run marked this step before its call was recorded; the entry joins
    // what the step causes to the call that caused it.
    if (place.run) attachEntryToCursor(index);
  }

  // The proxy credits what crosses to the entry just recorded, as the MCP
  // path does: without the mark, a repeated or CLI call's traffic lands under
  // no entry and `create` stores nothing for it. A run's step is marked by
  // the run with its own position instead.
  const marksBoundary = index !== null && toolName !== 'replay' && !place?.run && !observes(toolName, validation.data);
  if (marksBoundary) await markNextCommand({ kind: 'command', index: index! });

  // A recorded call's own tool calls are made on its behalf and stay out; a
  // run's steps list themselves (withinRun), so a run reads as its call and
  // then its steps.
  const run = () => underDialogs(dialogTargetOf(validation.data), toolName, validation.data, abortSignal, signal => index === null
    ? tool.handler(validation.data, signal)
    : unlisted(() => tool.handler(validation.data, signal)));
  let result: any;
  try {
    result = await (cliEntry ? run() : asInnerCall(run));
    await watchNamedPage(validation.data);
  } catch (error) {
    if (index !== null) {
      commandRecorder.attachResult(index, error instanceof ToolError || error instanceof InvalidReferenceError
        ? error.response
        : { content: [{ type: 'text', text: error instanceof Error ? error.message : `${error}` }], isError: true });
    }
    throw error;
  } finally {
    if (marksBoundary) {
      const settle = configManager.getReplayConfig();
      const reference = typeof validation.data?.connection === 'string'
        ? sanitizeReference(validation.data.connection)
        : undefined;
      void releaseCommand(settle.stepSettleMs, settle.stepSettleCapMs, reference)
        .then(at => commandRecorder.attachRelease(index!, at))
        .catch(() => { /* a boundary that failed to settle still clears */ });
    }
  }
  if (index !== null) commandRecorder.attachResult(index, result);

  // If tool returned an error, throw it as a ToolError so it propagates correctly
  if (result?.isError) {
    throw new ToolError(result);
  }

  return result;
}

/** The toolset that built each tool, keyed by tool name, in the order `allTools` lists them. */
const toolsetOf = new Map<string, string>();

function toolset<T extends object>(name: string, tools: T): T {
  for (const tool of Object.keys(tools)) toolsetOf.set(tool, name);
  return tools;
}

// Combine all tools (conditionally based on config)
const allTools = {
  // Connection tools (Chrome/debugger)
  ...(configManager.isToolEnabled('connection') ? toolset('connection', connectionTools) : {}),
  // CDP Debugging tools
  ...(configManager.isToolEnabled('breakpoint') ? toolset('breakpoint', createBreakpointTools(sourceMapHandler, logpointTracker, resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('execution') ? toolset('execution', createExecutionTools(resolveConnectionByName, connectionManager, (port) => serverManager.retryPendingRestartByInspectorPort(port))) : {}),
  ...(configManager.isToolEnabled('inspection') ? toolset('inspection', createInspectionTools(sourceMapHandler, resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('source') ? toolset('source', createSourceTools(sourceMapHandler, resolveConnectionByName)) : {}),
  // Browser Automation tools
  ...(configManager.isToolEnabled('console') ? toolset('console', createConsoleTools(resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('network') ? toolset('network', createNetworkTools(resolveConnectionByName)) : {}),
  ...toolset('proxy', createProxyTools()),
  ...toolset('hold', createHoldTools()),
  ...(configManager.isToolEnabled('page') ? toolset('page', createPageTools(resolveConnectionByName, clickableCache, executeToolCall)) : {}),
  ...(configManager.isToolEnabled('dom') ? toolset('dom', createDOMTools(resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('screenshot') ? toolset('screenshot', createScreenshotTools(resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('input') ? toolset('input', createInputTools(resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('content') ? toolset('content', createContentTools(resolveConnectionByName, clickableCache)) : {}),
  ...(configManager.isToolEnabled('modal') ? toolset('modal', createModalTools(resolveConnectionByName)) : {}),
  ...(configManager.isToolEnabled('bench') ? toolset('bench', createBenchTools(sourceMapHandler, commandRecorder, executeToolCall, resolveConnectionByName, toolCatalogue, toolValues, serverRows, serverLog)) : {}),
  ...(configManager.isToolEnabled('storage') ? toolset('storage', createStorageTools(resolveConnectionByName)) : {}),
  // Download tools
  ...(configManager.isToolEnabled('download') ? toolset('download', createDownloadTools()) : {}),
  // Request tools (HTTP requests as sequence steps, node or browser destination)
  ...(configManager.isToolEnabled('request') ? toolset('request', createRequestTools(resolveConnectionByName)) : {}),
  // Assert tool (inline assertions as sequence steps)
  ...(configManager.isToolEnabled('assert') ? toolset('assert', createAssertTools(resolveConnectionByName)) : {}),
  // Wait tool (wait primitive for sequences - MCP-side condition polling / sleep)
  ...(configManager.isToolEnabled('wait') ? toolset('wait', createWaitTools(resolveConnectionByName)) : {}),
  // Check tool (one reading, held or failed; assert and wait are faces of it)
  ...(configManager.isToolEnabled('check') ? toolset('check', createCheckTools(resolveConnectionByName, executeToolCall)) : {}),
  // Replay tools
  ...(configManager.isToolEnabled('replay') ? toolset('replay', createReplayTools(commandRecorder, executeToolCall, async (connection: string) => {
    const resolved = await resolveConnectionByName(connection);
    if (!resolved?.puppeteerManager) return null;
    return resolved.puppeteerManager.getPage();
  }, async (connection: string) => {
    const resolved = await resolveConnectionByName(connection);
    return resolved?.connection.port ?? null;
    // Lazy: allTools is defined below this object literal, so the set of valid
    // tool names can only be read at call time (bug-010). The explicit return
    // type is required - without it, allTools appears in its own initializer
    // and TypeScript cannot infer it (TS7022).
  }, (): string[] => Object.keys(allTools))) : {}),
  // Server management tools
  ...(configManager.isToolEnabled('server') ? toolset('server', createServerTools(serverManager)) : {}),
  // Config management tools (always enabled - not toggleable)
  ...toolset('config', createConfigTools(chromeLauncher, { version: SERVER_VERSION, ...BUILD_IDENTITY })),
  // Plugin management tools (always enabled - not toggleable)
  ...toolset('plugin', createPluginTools(() => orchestratorInstance)),
  // Issues tracking tools
  ...(configManager.isToolEnabled('issues') ? toolset('issues', createIssuesTools(
    executeToolCall,
    async (name: string) => {
      // Helper to get sequence path by name
      const sequences = commandRecorder.listSequences();
      const sequence = sequences.find(s => s.name === name || s.id === name);
      if (!sequence) return null;
      // Try to find saved file
      const sequencesDir = commandRecorder.getSequencesDir();
      const filename = name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase() + '.json';
      const { join } = await import('path');
      const { existsSync } = await import('fs');
      const filepath = join(sequencesDir, filename);
      if (existsSync(filepath)) return filepath;
      return null;
    },
    async (connection: string) => {
      const resolved = await resolveConnectionByName(connection);
      if (!resolved?.puppeteerManager) return null;
      return resolved.puppeteerManager.getPage();
    },
    // Lazy: allTools is defined below. Lets a pulled sequence be checked
    // against the live tool list before it is written to disk.
    (): string[] => Object.keys(allTools)
  )) : {}),
  // Dashboard tools (lazy-initialized in main())
  ...(configManager.isToolEnabled('dashboard') ? toolset('dashboard', createDashboardTools()) : {}),
  // Cross-session message tools
  ...(configManager.isToolEnabled('message') ? toolset('message', createMessageTools()) : {}),
};

/** Every served tool, grouped by the toolset that built it, in the order `listTools` gives them. */
function toolCatalogue(): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const [name, tool] of Object.entries(allTools)) {
    const set = toolsetOf.get(name) ?? 'other';
    const group = groups.get(set) ?? { name: set, tools: [] };
    group.tools.push({ name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
    groups.set(set, group);
  }
  return [...groups.values()];
}

/** The names the tools tab offers as values: live connections, servers, sequences and profiles. */
async function toolValues(): Promise<ToolValues> {
  const sorted = (names: Array<string | undefined>) => [...new Set(names.filter((n): n is string => !!n))].sort();
  const saved = await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as Array<{ name: string }>);
  return {
    connections: sorted(connectionManager.listConnections().map(connection => connection.reference)),
    servers: sorted((await serverManager.getStatus().catch(() => [])).map(server => server.id)),
    sequences: sorted([...commandRecorder.listSequences().map(sequence => sequence.name), ...saved.map(entry => entry.name)]),
    profiles: await chromeLauncher.listPersistentProfiles().catch(() => []),
  };
}

/** The managed dev servers, for the Servers section of the bench's Running tab. */
async function serverRows(): Promise<ServerRow[]> {
  return (await serverManager.getStatus().catch(() => [])).map(server => ({
    id: server.id,
    command: server.command,
    cwd: server.cwd,
    running: server.running,
    pid: server.pid,
    ...(server.port !== undefined && { port: server.port }),
    uptime: server.uptime,
    runnerType: server.runnerType,
    autoRun: server.autoRun,
    ...(server.watchPaths && { watchPaths: server.watchPaths }),
  }));
}

/** Bytes read from the end of a log for the bench: a screen of recent lines, not the whole file. */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * The end of one managed server's log file. The path comes from the server
 * manager by id, never from the page, so the route reads only log files.
 */
async function serverLog(id: string, stream: 'stdout' | 'stderr'): Promise<ServerLog> {
  let access: ReturnType<ServerManager['getLogAccess']>;
  try {
    access = serverManager.getLogAccess(id);
  } catch {
    return { unavailable: `no server "${id}"` };
  }
  if (!access) return { unavailable: 'this runner keeps no log' };
  if (access.type === 'command') return { command: access.command };
  const path = stream === 'stderr' ? access.stderrPath : access.stdoutPath;
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(path, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf-8');
    // A read that starts mid-file starts mid-line; the partial first line goes.
    return { path, size, text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text };
  } catch {
    return { path, size: 0, text: '' };
  } finally {
    await handle?.close();
  }
}

/**
 * Register tool handlers on the server
 */
function registerToolHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.entries(allTools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Anything a tool call causes is the agent's own doing, and its events say so.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => runAs('agent', async () => {
    const toolName = request.params.name;
    const tool = Object.prototype.hasOwnProperty.call(allTools, toolName)
      ? allTools[toolName as keyof typeof allTools]
      : undefined;

    if (!tool) {
      return unknownToolResponse(toolName, Object.keys(allTools));
    }

    const held = pageHeldRefusal(toolName, (request.params.arguments ?? {}) as Record<string, any>);
    if (held) return held;

    // The transport starts serving before serverManager.initialize() has
    // restored state, so a call landing in that window sees an empty world: a
    // dead server's guard silently passes, and `acknowledgeStartup` in there
    // acknowledges nothing and reverts as soon as recovery lands. Wait for it.
    // `config` is exempt: it reads no server state, and `config restart` is the
    // escape hatch you want available precisely when recovery is what's stuck.
    if (toolName !== 'config') {
      await startupGate.wait();
    }

    // Check for tool dependency conflicts (blocks ALL tools except config)
    if (toolName !== 'config' && configManager.hasDependencyConflicts()) {
      const conflicts = configManager.getDependencyConflicts();
      const configPath = configManager.getStatus().loadedFrom || '.devharness/config.json';
      return {
        content: [
          {
            type: 'text',
            text: `Tool dependency conflict - all tools blocked.

${conflicts.join('\n\n')}

Edit ${configPath} to resolve, then restart the MCP server.`,
          },
        ],
        isError: true
      };
    }

    // All tools now use Zod validation
    const validation = validateParams(
      request.params.arguments || {},
      (tool as any).zodSchema,
      toolName
    );

    if (!validation.success) {
      const refused = validationFailure(toolName, validation.error);
      if (recordedInHistory(toolName, request.params.arguments)) {
        await commandRecorder.recordCommand(toolName, request.params.arguments || {});
        const index = commandRecorder.getCurrentHistoryIndex();
        commandRecorder.attachResult(index, refused);
        appendToResponse(refused, `\n\n${historyFooter(index, refused)}`);
      }
      return refused;
    }

    // Record command if recording is active (but don't record replay tool calls)
    // Capture the command index for the repeat hint
    let commandIndex: number | null = null;
    if (recordedInHistory(toolName, validation.data)) {
      await commandRecorder.recordCommand(toolName, validation.data);
      commandIndex = commandRecorder.getCurrentHistoryIndex();
      // A replay call walks steps that each start a call of their own; counted
      // too, it would stand between a traffic check and the step it counts back to.
      if (toolName !== 'replay') noteCallStart();
    }

    // Check for failed monitored ports
    const portMonitor = serverManager.getPortMonitor();
    const failedPorts = portMonitor.getFailedPorts();
    const portCheck = checkPortFailures(failedPorts, toolName);

    if (portCheck.blocked) {
      await recordBlockEvent(portCheck.block, toolName);
      return portCheck.response;
    }

    // Check for breakpoint pauses (block tools until acknowledged or resumed)
    const allConnections = connectionManager.getAllConnections();
    const breakpointCheck = checkBreakpointPause(
      allConnections,
      toolName,
      (port) => serverManager.getPendingRestartByInspectorPort(port),
      (validation.data as Record<string, unknown>)?.action as string | undefined
    );

    if (breakpointCheck.blocked) {
      await recordBlockEvent(breakpointCheck.block, toolName);
      return breakpointCheck.response;
    }

    // Check for pending startup failures (block tools until acknowledged)
    const pendingStartupFailures = serverManager.getPendingStartupFailures();
    const pendingStartupCheck = checkPendingStartups(pendingStartupFailures, toolName);

    if (pendingStartupCheck.blocked) {
      await recordBlockEvent(pendingStartupCheck.block, toolName);
      return pendingStartupCheck.response;
    }

    // Check for blocking bugs from recordings
    const bugCheck = await checkBugBlocking(toolName, validation.data as Record<string, unknown>);
    if (bugCheck.blocked) {
      await recordBlockEvent(bugCheck.block, toolName);
      return bugCheck.response;
    }

    // Check for duplicate session (multiple MCPs for same Claude session)
    const duplicateInfo = getDuplicateSessionInfo();
    const duplicateCheck = checkDuplicateSession(duplicateInfo, toolName);
    if (duplicateCheck.blocked) {
      await recordBlockEvent(duplicateCheck.block, toolName);
      return duplicateCheck.response;
    }

    // Every guard passed - a block that recurs later is a new event
    clearBlockEvents();

    // Marked here rather than beside recordCommand above: a command a guard
    // refused never reaches the app, and stamping its index would hand later
    // traffic to a command that did nothing.
    // A replay run marks the proxy with its own steps; a mark here would be
    // released under the run's first step.
    const marksBoundary = commandIndex !== null && toolName !== 'replay' && !observes(toolName, validation.data as Record<string, unknown>);
    if (marksBoundary) {
      // Queued behind the previous command's release, so this command claims
      // nothing that command is still being credited with.
      await markNextCommand({ kind: 'command', index: commandIndex! });
    }

    // Pass validated data to handler
    try {
      const result = await arriveOn('mcp', () => underDialogs(dialogTargetOf(validation.data), toolName, validation.data, extra?.signal, signal => (commandIndex !== null
        ? unlisted(() => tool.handler(validation.data, signal))
        : tool.handler(validation.data, signal))));

      if (commandIndex !== null) {
        commandRecorder.attachResult(commandIndex, result);
      }
      await watchNamedPage(validation.data);

      // Prepend port failure prefix if any
      if (portCheck.prefix) {
        prependToResponse(result, portCheck.prefix);
        if (portCheck.markAsError) {
          result.isError = true;
        }
      }

      // Re-read after the handler: a resume or step changes the pause the banner reports.
      if (breakpointCheck.prefix) {
        const afterCheck = checkBreakpointPause(
          connectionManager.getAllConnections(),
          toolName,
          (port) => serverManager.getPendingRestartByInspectorPort(port),
          (validation.data as Record<string, unknown>)?.action as string | undefined
        );
        if (!afterCheck.blocked && afterCheck.prefix) {
          prependToResponse(result, afterCheck.prefix);
        }
      }

      // Collect status lines to append to response
      const statusItems: StatusLineItem[] = [];

      // What this call caused that crossed or was written by the time it
      // returned; what arrives after is in the index and in History.
      const activity = commandIndex !== null ? activitySummary(commandIndex) : undefined;
      if (activity) statusItems.push({ label: 'Activity', value: activity });

      // What a person did on this page since the last call here read it, so
      // a reading is not taken for the state the agent drove to.
      if (typeof validation.data?.connection === 'string') {
        const moved = takeUnreadPersonInput(sanitizeReference(validation.data.connection));
        if (moved.length) {
          statusItems.push({
            label: 'Person',
            value: `${moved.map(describePersonInput).join(', ')} in ${validation.data.connection} since your last call`
              + ` (History ${moved.map(input => `#${input.index}`).join(', ')})`,
          });
        }
      }


      // Append server log status to all tool responses
      const serverLogStats = serverManager.getLogStats();
      if (serverLogStats.length > 0) {
        const parts = serverLogStats
          .filter(s => s.newStderr > 0 || s.newStdout > 0)
          .map(s => `${s.serverId} (${s.newStderr} err/${s.newStdout} out)`);

        if (parts.length > 0) {
          statusItems.push({ label: 'Logs', value: parts.join(' ') });
        }
      }

      // Append console log status if tool used a connection
      const named = validation.data?.connection;
      if (named) {
        const connection = connectionManager.findConnectionByReference(named);
        if (connection?.consoleMonitor) {
          // Read before getLogStats, which advances the cursor past it.
          const newestError = connection.consoleMonitor.peekNewestError();
          const logStats = connection.consoleMonitor.getLogStats();
          if (logStats.newMessages > 0) {
            const details: string[] = [];
            if (logStats.newErrors > 0) details.push(`${logStats.newErrors} err`);
            if (logStats.newWarnings > 0) details.push(`${logStats.newWarnings} warn`);
            const otherCount = logStats.newMessages - logStats.newErrors - logStats.newWarnings;
            if (otherCount > 0) details.push(`${otherCount} log`);
            const cause = newestError
              ? ` - ${truncate(newestError.text, 140)}${newestError.where ? ` (${newestError.where})` : ''}`
              : '';
            statusItems.push({ label: 'Console', value: `${details.join('/')}${cause}` });
          }
        }
      }

      // A parameter error's footer names the entry itself, with the fields to replace.
      if (commandIndex !== null && !isParameterError(result)) {
        statusItems.push({ label: 'Replay', value: String(commandIndex) });
      }

      const statusSuffix = buildStatusSuffix(statusItems, !statusLegendShown);
      if (statusSuffix) {
        statusLegendShown = true;
        appendToResponse(result, statusSuffix);
      }
      if (commandIndex !== null && isParameterError(result)) appendToResponse(result, `\n\n${historyFooter(commandIndex, result)}`);

      // One occurrence in the transcript is what session-detector.ts matches on.
      if (!pidAnnounced) {
        pidAnnounced = true;
        appendToResponse(result, `\npid:${process.pid}`);
      }

      // Report action to dashboard (if enabled)
      const dashboardInst = getDashboardInstance();
      if (dashboardInst) {
        if (dashboardInst.hub) {
          // We're the hub - update our own state
          const connections = connectionManager.getAllConnections().map(conn => ({
            reference: conn.reference || conn.id,
            type: conn.type,
            state: conn.cdpManager.isPaused() ? 'paused' as const :
                   (Date.now() - conn.lastActivityAt < 30000) ? 'active' as const : 'idle' as const,
            createdAt: conn.createdAt,
            lastActivityAt: conn.lastActivityAt,
          }));
          dashboardInst.hub.updateSelf(connections, {
            tool: toolName,
            timestamp: Date.now(),
            connectionReference: named,
          });
        } else if (dashboardInst.client) {
          // We're a client - report to hub
          dashboardInst.client.reportAction(toolName, named);
        }
      }

      // Start session verification after first tool use
      // The PID we just appended to the response will be logged by Claude.
      // Now we watch session files and look for that PID to identify our session.
      if (sessionDetectorInstance && !sessionVerifyStarted) {
        sessionVerifyStarted = true;
        sessionDetectorInstance.verify(process.pid);
      }

      return boundReply(result);
    } catch (error) {
      const response = error instanceof ToolError || error instanceof InvalidReferenceError
        ? error.response
        : {
            content: [
              {
                type: 'text',
                text: error instanceof Error ? error.message : `${error}`,
              },
            ],
            isError: true
          };
      if (commandIndex !== null) {
        commandRecorder.attachResult(commandIndex, response);
        appendToResponse(response, `\n\n${historyFooter(commandIndex, response)}`);
      }
      return response;
    } finally {
      if (marksBoundary) {
        // Scheduled and not awaited: the wait for the boundary to go quiet is
        // paid out of the gap before the next command rather than out of this
        // command's response. What crosses after the release carries no
        // command and belongs to no step, which is what makes a gap readable
        // as the app's own traffic.
        const settle = configManager.getReplayConfig();
        const reference = typeof validation.data?.connection === 'string'
          ? sanitizeReference(validation.data.connection)
          : undefined;
        void releaseCommand(settle.stepSettleMs, settle.stepSettleCapMs, reference)
          .then(at => commandRecorder.attachRelease(commandIndex!, at))
          .catch(() => { /* a boundary that failed to settle still clears */ });
      }
    }
  }));
}

// Start the server
/**
 * CLI mode: `devharness run <sequenceName> [--connection=X] [--headed] [--keep-chrome]`
 * Runs a saved sequence directly from the shell, no MCP client needed.
 * Pre-launches Chrome itself (headless by default, forceNewInstance) so
 * replay run's own auto-launch (always headed) never triggers.
 */
async function runCliSequence(argv: string[]): Promise<void> {
  const sequenceName = argv[0];
  if (!sequenceName || sequenceName.startsWith('--')) {
    console.error('Usage: devharness run <sequenceName> [--connection=X] [--base-url=URL] [--headed] [--keep-chrome]');
    process.exit(1);
  }

  const flags = new Set(
    argv.slice(1)
      .filter(a => a.startsWith('--') && !a.includes('='))
      .map(a => a.slice(2))
  );
  const kv: Record<string, string> = {};
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, ...rest] = arg.slice(2).split('=');
      kv[key] = rest.join('=');
    }
  }
  const headed = flags.has('headed');
  const keepChrome = flags.has('keep-chrome');
  const connection = kv.connection || deriveConnectionReference(sequenceName);

  initializePaths();
  await configManager.load();

  // Reserve a Chrome debug port (same retry loop the MCP server bootstrap uses)
  let reservationSucceeded = false;
  let attempts = 0;
  const maxAttempts = 10;
  while (!reservationSucceeded && attempts < maxAttempts) {
    const port = await findStartingPort();
    configManager.setCurrentPort(port);
    try {
      await portReserver.reserve(port);
      reservationSucceeded = true;
    } catch {
      attempts++;
      if (attempts >= maxAttempts) {
        console.error(`[devharness] Failed to reserve a port after ${maxAttempts} attempts`);
        process.exit(1);
      }
      process.env.MCP_DEBUG_PORT = String(port + 1);
    }
  }

  try {
    await executeToolCall('connection', {
      action: 'launch',
      connection: connection,
      headless: !headed,
      forceNewInstance: true,
    });
    const runResult = await executeToolCall('replay', {
      action: 'run',
      // Blocking: the CLI's exit code comes from the run result, and the
      // process exits right after - a background run would die mid-flight.
      wait: true,
      name: sequenceName,
      connection,
      killChromeOnFinish: !keepChrome,
      ...(kv['base-url'] ? { baseUrl: kv['base-url'] } : {}),
      // A CLI run has nobody to answer a prompt, so a parameterised sequence
      // keeps its recorded values. Left undefined, every such sequence would
      // exit 1 having executed nothing - the run asking a question into a
      // pipe. Same reason runAll passes it.
      variables: {},
    });

    console.log(runResult?.content?.[0]?.text || '');
    process.exit(runResult?._meta?.replay?.success === true ? 0 : 1);
  } catch (error: any) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

async function main() {
  enableRunLog();
  // CLI mode bypasses the MCP stdio server entirely - session detection, the
  // dashboard hub, and the log-processor orchestrator are all multi-session-
  // coordination features irrelevant to a one-shot process.
  if (process.argv[2] === 'run') {
    await runCliSequence(process.argv.slice(3));
    return;
  }

  if (isVersionFlag(process.argv[2])) {
    console.log(readPackageVersion());
    return;
  }

  // The other CLI shape: run a tool inside an already-running session, reached
  // over that session's socket rather than started here.
  if (isCliCommand(process.argv[2])) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  console.error(`[devharness] main() called (PID: ${process.pid})`);

  // Initialize path configuration early (before any file operations)
  const pathConfig = initializePaths();
  console.error(`[devharness] Path config: global=${pathConfig.globalBase}, workingDir=${pathConfig.workingDirBase ?? 'none (using global fallback)'}`);

  // A rebuild restarts this process within the same session; the once-block
  // record kept under the session's name holds each block to one showing.
  messages.setOnceRecordPath(() => {
    const sessionName = resolveRestartStableSessionName(getSessionInfo()?.shortId);
    return sessionName ? getOutputPath('once', `${sessionName}.json`, { global: true }) : undefined;
  });

  // Clean up stale temp files from previous crashed/killed processes
  // Run in background - don't block startup
  Promise.all([
    cleanupStaleTempFiles(pathConfig.globalBase),
    pathConfig.workingDirBase ? cleanupStaleTempFiles(pathConfig.workingDirBase) : Promise.resolve({ cleaned: [], errors: [] })
  ]).then(([globalResult, localResult]) => {
    const totalCleaned = globalResult.cleaned.length + localResult.cleaned.length;
    if (totalCleaned > 0) {
      console.error(`[devharness] Cleaned ${totalCleaned} stale temp file(s)`);
    }
  }).catch(() => {
    // Ignore cleanup errors - best effort only
  });

  // Pick up sequences edited on disk mid-session, the way a managed dev server
  // picks up its own sources. Attaches only to directories that already exist;
  // a later save or load starts it.
  commandRecorder.startSequenceWatch();

  // Start non-blocking session detection (polls for file modified after MCP start)
  const cwd = process.cwd();
  // SessionInfo detected asynchronously - may be undefined until callback fires
  let detectedSessionInfo: SessionInfo | undefined;
  // Dashboard instance - initialized after session is detected
  let dashboardInstance: DashboardInstance | null = null;
  // Socket a `devharness <command>` process calls tools through
  let sessionEndpoint: SessionEndpoint | null = null;

  // Set up session detector (starts monitoring immediately)
  sessionDetectorInstance = createSessionDetector(cwd);

  // Helper to convert connections to dashboard format
  const getConnectionsForDashboard = (): DashboardConnectionInfo[] => {
    return connectionManager.getAllConnections().map(conn => ({
      reference: conn.reference || conn.id,
      type: conn.type,
      state: conn.cdpManager.isPaused() ? 'paused' as const :
             (Date.now() - conn.lastActivityAt < 30000) ? 'active' as const : 'idle' as const,
      createdAt: conn.createdAt,
      lastActivityAt: conn.lastActivityAt,
    }));
  };

  const sessionStartTime = Date.now() - (performance.now() - STARTUP_TIME);

  // Helper to start orchestrator when becoming hub
  const startOrchestrator = async (hub: NonNullable<DashboardInstance['hub']>) => {
    if (orchestratorInstance || !sessionDetectorInstance) return;

    try {
      const configDir = join(resolveStateDir(cwd), 'config');
      mkdirSync(join(configDir, 'classifiers'), { recursive: true });
      mkdirSync(join(configDir, 'extractors'), { recursive: true });
      mkdirSync(join(configDir, 'state-machines'), { recursive: true });
      mkdirSync(join(configDir, 'dashboard'), { recursive: true });

      orchestratorInstance = new Orchestrator({
        source: {
          mode: 'live',
          sessionDetector: sessionDetectorInstance
        },
        configDir
      });

      await orchestratorInstance.start();
      hub.connectLogProcessor(orchestratorInstance);

      // Start custom dashboard route loader
      const dashboardConfigDir = join(configDir, 'dashboard');
      await hub.startRouteLoader(dashboardConfigDir);

      await debugLog('log-processor', 'Orchestrator started and connected to dashboard hub');
    } catch (error) {
      await debugLog('log-processor', `Failed to start orchestrator: ${error}`);
    }
  };

  // Failover callback - when hub dies, try to become the new hub
  const handleHubDown = async () => {
    await debugLog('dashboard', 'Attempting to become new hub...');
    const currentSession = detectedSessionInfo;
    const newInstance = await initializeDashboard(
      process.cwd(),
      sessionStartTime,
      getConnectionsForDashboard,
      currentSession?.sessionId || getClaudeSessionId() || `pid-${process.pid}`,
      currentSession?.shortId || resolveSessionName(),
      handleHubDown  // Pass callback again for the new client
    );
    if (newInstance) {
      dashboardInstance = newInstance;
      setDashboardInstance(newInstance);
      await debugLog('dashboard', `Failover: now ${newInstance.type} on port ${newInstance.port}`);

      // If we became the hub, start the orchestrator
      if (newInstance.hub) {
        await startOrchestrator(newInstance.hub);
      }
    }
  };

  // Initialize dashboard immediately (don't wait for session detection)
  if (configManager.isToolEnabled('dashboard')) {
    dashboardInstance = await initializeDashboard(
      process.cwd(),
      sessionStartTime,
      getConnectionsForDashboard,
      // Named before the detector runs. A hub entry keyed on the pid would
      // list this session a second time, beside the one its mailbox is named
      // after.
      resolveSessionName(),
      resolveSessionName(),
      handleHubDown
    );

    if (dashboardInstance) {
      setDashboardInstance(dashboardInstance);
      await debugLog('dashboard', `Initialized as ${dashboardInstance.type} on port ${dashboardInstance.port}`);
    } else {
      await debugLog('dashboard', `Initialization failed`);
    }
  }

  // Subscribe to session changes - update session info when detected
  sessionDetectorInstance.session$.subscribe(async (sessionInfo) => {
    await debugLog('session-detector', `Session ID: ${sessionInfo.shortId} (${sessionInfo.sessionId})`);
    detectedSessionInfo = sessionInfo;
    setSessionInfo(sessionInfo);

    // The presence record is what a CLI matches --session against. It takes
    // the same name the mailbox and the event stream take, or a peer would
    // address a record whose mailbox this session never reads.
    if (sessionEndpoint) {
      await sessionEndpoint.refresh({
        sessionId: getClaudeSessionId() ?? sessionInfo.sessionId,
        shortId: resolveSessionName(sessionInfo.shortId),
      });
    }

    // Update dashboard with real session info
    await debugLog('dashboard', `Updating session info: instance=${!!dashboardInstance}, hub=${!!dashboardInstance?.hub}, client=${!!dashboardInstance?.client}`);
    if (dashboardInstance?.hub) {
      dashboardInstance.hub.updateSessionInfo(sessionInfo.sessionId, sessionInfo.shortId);
      await debugLog('dashboard', `Hub session info updated to ${sessionInfo.shortId}`);
    } else if (dashboardInstance?.client) {
      dashboardInstance.client.updateSessionInfo(sessionInfo.sessionId, sessionInfo.shortId);
      await debugLog('dashboard', `Client session info updated to ${sessionInfo.shortId}`);
    }
  });

  // Subscribe to entry count changes - update dashboard
  sessionDetectorInstance.entryCount$.subscribe(async (count) => {
    if (dashboardInstance?.hub) {
      dashboardInstance.hub.updateSessionEntryCount(count);
    } else if (dashboardInstance?.client) {
      dashboardInstance.client.updateSessionEntryCount(count);
    }
  });

  // Load configuration early so debug logging is available for orchestrator startup
  await configManager.load();
  const debugConfig = configManager.getDebugConfig();
  if (debugConfig.enabled) {
    await enableDebugLogging({ clearOnStartup: true });
  }
  if (debugConfig.historyLogEnabled) {
    enableHistoryLogging();
  }
  // Hot-reload config.json edits made after startup (see config.ts reload()
  // for what can/can't apply live - tool enable/disable still needs a restart).
  configManager.startWatching();

  // Initialize log processor orchestrator (hub only)
  if (dashboardInstance?.hub) {
    await startOrchestrator(dashboardInstance.hub);
  }

  // Capture import time (time from script start to main() being called)
  const importTime = performance.now() - STARTUP_TIME;

  // Initialize and reserve debug port with retry logic
  const portReservationStart = performance.now();
  let reservationSucceeded = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!reservationSucceeded && attempts < maxAttempts) {
    const port = await findStartingPort();
    configManager.setCurrentPort(port);

    // Reserve the port by binding a socket to it
    try {
      await portReserver.reserve(port);
      console.error(`[devharness] Reserved debug port: ${port}`);
      reservationSucceeded = true;
    } catch (error) {
      attempts++;
      console.error(`[devharness] Port ${port} reservation failed (attempt ${attempts}/${maxAttempts}), trying next port...`);

      if (attempts >= maxAttempts) {
        console.error(`[devharness] Failed to reserve a port after ${maxAttempts} attempts`);
        process.exit(1);
      }

      // Try the next port
      process.env.MCP_DEBUG_PORT = String(port + 1);
    }
  }

  const portReservationTime = performance.now() - portReservationStart;

  // Create server with instructions
  const serverCreationStart = performance.now();
  const server = await createMCPServer();
  const serverCreationTime = performance.now() - serverCreationStart;

  // Register tool handlers
  const toolRegistrationStart = performance.now();
  registerToolHandlers(server);
  const toolRegistrationTime = performance.now() - toolRegistrationStart;

  // Connect to transport
  console.error(`[devharness] Connecting to transport (PID: ${process.pid})`);
  const transportStart = performance.now();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const transportTime = performance.now() - transportStart;
  console.error(`[devharness] Transport connected (PID: ${process.pid})`);

  // Reachable by CLI only once the tools can actually run.
  sessionEndpoint = await startSessionEndpoint({
    executeToolCall: (tool, args, signal) => arriveOn('cli', () => executeToolCall(tool, args, signal)),
    awaitReady: () => startupGate.wait(),
    identity: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      // Named before the detector runs, so `--session=<shortId>` resolves on
      // the first CLI call after a restart rather than the second.
      sessionId: getClaudeSessionId(),
      shortId: resolveSessionName(),
    },
  });
  if (sessionEndpoint) {
    console.error(`[devharness] Session endpoint listening on ${sessionEndpoint.address}`);
  }

  // Note: Config was already loaded earlier (before orchestrator startup) for debug logging

  // Announced BEFORE the manager starts: collection counts the live sessions
  // working in a server's directory, and a session that has not registered yet
  // is not counted.
  serverClaims.collectDeadSessions();
  await serverClaims.registerSession(process.cwd());

  // Initialize server manager - recover running servers and start auto-run servers.
  // Tool calls queue behind this (startupGate); release the gate
  // even if recovery throws, or every later call would wait out the timeout.
  let serverInitResult: Awaited<ReturnType<typeof serverManager.initialize>>;
  try {
    serverInitResult = await serverManager.initialize();
  } finally {
    startupGate.markComplete();
  }
  if (serverInitResult.recovered.length > 0) {
    console.error(`[devharness] Recovered ${serverInitResult.recovered.length} running server(s): ${serverInitResult.recovered.join(', ')}`);
  }
  if (serverInitResult.started.length > 0) {
    console.error(`[devharness] Auto-started ${serverInitResult.started.length} server(s): ${serverInitResult.started.join(', ')}`);
  }
  if (serverInitResult.failed.length > 0) {
    console.error(`[devharness] Failed to auto-start ${serverInitResult.failed.length} server(s): ${serverInitResult.failed.join(', ')}`);
  }

  console.error(`[devharness] Server ready (PID: ${process.pid})`);

  // Calculate total startup time and store metrics for later logging
  const totalStartupTime = performance.now() - STARTUP_TIME;
  setStartupMetrics({
    totalMs: Math.round(totalStartupTime),
    importMs: Math.round(importTime),
    portReservationMs: Math.round(portReservationTime),
    portAttempts: attempts + 1,
    serverCreationMs: Math.round(serverCreationTime),
    toolRegistrationMs: Math.round(toolRegistrationTime),
    transportMs: Math.round(transportTime),
    capturedAt: new Date().toISOString(),
  });

  // Start periodic cleanup of inactive connections
  const chromeConfig = configManager.getChromeConfig();
  const CLEANUP_INTERVAL = chromeConfig.inactivityPollingMinutes * 60 * 1000;
  const INACTIVITY_THRESHOLD = chromeConfig.inactivityTimeoutMinutes * 60 * 1000;

  // Only start cleanup interval if inactivity timeout is enabled (> 0)
  const cleanupInterval = INACTIVITY_THRESHOLD > 0 ? setInterval(async () => {
    try {
      const inactiveConnections = connectionManager.getInactiveConnections(INACTIVITY_THRESHOLD);
      if (inactiveConnections.length > 0) {
        await debugLog('index', `Found ${inactiveConnections.length} inactive connection(s) to close`);
        for (const conn of inactiveConnections) {
          await debugLog('index', `Closing inactive connection: ${conn.id} (inactive for ${Math.round(conn.inactiveForMs / 1000)}s)`);
        }
      }

      // closeInactiveConnections() re-checks activity and kills Chrome itself,
      // per connection, before tearing down its monitors, tagged 'inactivity'
      // (see ConnectionManager.closeConnection). This loop is the backstop for a
      // Chrome with no tracked connection at all (launched with autoConnect:
      // false and never connected, or orphaned by another cleanup path).
      const closedCount = await connectionManager.closeInactiveConnections(INACTIVITY_THRESHOLD);
      if (closedCount > 0) {
        console.error(`[devharness] Closed ${closedCount} inactive connection(s)`);
        await debugLog('index', `Closed ${closedCount} inactive connection(s)`);
      }

      for (const port of chromeLauncher.getRunningPorts()) {
        if (!connectionManager.hasBrowser('localhost', port)) {
          console.error(`[devharness] Killing orphaned Chrome on port ${port} (no tracked connections)`);
          await debugLog('index', `Killing orphaned Chrome on port ${port} (no tracked connections) due to inactivity`);
          chromeLauncher.setPendingCloseReason(port, 'inactivity');
          await chromeLauncher.kill(port);
        }
      }
    } catch (error) {
      console.error(`[devharness] Error during cleanup: ${error}`);
      await debugLog('index', `Error during inactivity cleanup: ${error}`);
    }
  }, CLEANUP_INTERVAL) : null;

  // A proxy outlives its browser. One that no connection and no open bench
  // uses keeps its port and its recording; the session hears of it once per
  // idle spell, with the call that stops it.
  const idleProxyCheck = setInterval(() => {
    const inUse = (name: string) => !!connectionManager.findConnectionByReference(name) || isBenchOpen(name);
    for (const { names } of newlyIdleProxies(inUse)) {
      void appendEvent(resolveSessionName(), 'proxy', {
        idle: true,
        names,
        detail: `the proxy for ${names.map(n => `"${n}"`).join(', ')} has no live connection and no open bench`,
        resolve: `proxy({ action: 'stop', connection: '${names[0]}' })`,
      });
    }
  }, 60_000);
  idleProxyCheck.unref();

  // Cleanup function for graceful shutdown
  let isCleaningUp = false;
  /**
   * Releases what this session privately holds: CDP connections, the Chrome
   * instances it launched, source maps, its reserved debug port, and the
   * in-process monitors. All of that dies with this process anyway.
   *
   * @param releaseOwnedServers - also stop the managed dev servers this
   *   session owns, meaning the ones no other live session claims (see
   *   server-claims.ts). Only for teardowns where the session is going away -
   *   an idle suspend, or a client that closed. A rebuild restart passes
   *   false: the child is coming straight back and will reattach.
   */
  const cleanup = async (signal: string, releaseOwnedServers = false) => {
    if (isCleaningUp) {
      return; // Prevent multiple cleanup calls
    }
    isCleaningUp = true;

    console.error(`[devharness] Received ${signal}, cleaning up...`);

    try {
      if (cleanupInterval) clearInterval(cleanupInterval); // Stop periodic cleanup
      clearInterval(idleProxyCheck);

      // Dev servers go first: they are detached, so if anything below hangs
      // (closing a CDP connection to a dead socket is the usual suspect) and
      // the supervisor's grace period runs out, the SIGKILL that follows would
      // leave them running with nobody managing them.
      if (releaseOwnedServers) {
        try {
          const { stopped, keptForOthers } = await serverManager.stopOwnedServers();
          if (stopped.length > 0) {
            console.error(`[devharness] Stopped ${stopped.length} owned dev server(s): ${stopped.join(', ')}`);
          }
          if (keptForOthers.length > 0) {
            console.error(`[devharness] Left ${keptForOthers.length} dev server(s) for other sessions: ${keptForOthers.join(', ')}`);
          }
          await serverManager.getPortMonitor().stopAll();
        } catch (error) {
          console.error(`[devharness] Error releasing dev servers: ${error}`);
        }
        // This session is over: nothing of ours may keep pinning a server that
        // the next session would otherwise collect.
        serverClaims.releaseAllOwn();
        serverClaims.unregisterSession();
      } else {
        // A rebuild restart: the child is coming straight back, so its claims
        // stay. Presence is withdrawn and re-announced by the next child.
        serverClaims.unregisterSession();
      }

      await connectionManager.closeAll();
      sourceMapHandler.clear();
      await chromeLauncher.kill();
      await portReserver.release();
      // Stop session detector if running
      if (sessionDetectorInstance) {
        sessionDetectorInstance.stop();
      }
      // Stop log processor orchestrator if running
      if (orchestratorInstance) {
        orchestratorInstance.stop();
      }
      // Stop file watcher if running
      if ((dashboardInstance as any)?._stopFileWatcher) {
        (dashboardInstance as any)._stopFileWatcher();
      }
      await shutdownDashboard(dashboardInstance);
      if (sessionEndpoint) {
        await sessionEndpoint.close();
      }

      // Final sync cleanup of temp files before exit
      const globalCleaned = cleanupStaleTempFilesSync(pathConfig.globalBase, 0);
      const localCleaned = pathConfig.workingDirBase
        ? cleanupStaleTempFilesSync(pathConfig.workingDirBase, 0)
        : { cleaned: [] };
      const totalCleaned = globalCleaned.cleaned.length + localCleaned.cleaned.length;
      if (totalCleaned > 0) {
        console.error(`[devharness] Cleaned ${totalCleaned} temp file(s) on shutdown`);
      }

      console.error('[devharness] Cleanup complete');
    } catch (error) {
      console.error(`[devharness] Cleanup error: ${error}`);
    }

    process.exit(0);
  };

  // Handle various termination signals
  process.on('SIGINT', () => cleanup('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanup('SIGTERM')); // Graceful shutdown (systemd, Docker, etc.)
  process.on('SIGHUP', () => cleanup('SIGHUP'));   // Terminal hangup

  // The supervisor's release signal: this session is going away (idle
  // suspend, or its client closed), so the dev servers it owns go with it.
  // SIGTERM stays the shallow teardown, because a rebuild restart uses it and
  // must leave servers running for the next child to reattach to. (SIGUSR2
  // rather than SIGUSR1, which Node reserves for its own inspector.)
  process.on('SIGUSR2', () => cleanup('SIGUSR2 (session release)', true));

  // Handle stdin close - this catches when the parent process (Claude Code) terminates
  // without sending a signal. MCP uses stdin/stdout for communication, so if stdin closes,
  // the parent is gone and we should clean up.
  process.stdin.on('close', () => cleanup('stdin-close'));
  process.stdin.on('end', () => cleanup('stdin-end'));

  // Handle normal exit (catch-all)
  process.on('exit', () => {
    if (!isCleaningUp) {
      console.error('[devharness] Process exiting');
    }
  });

  // Catch uncaught exceptions and unhandled rejections for debugging.
  //
  // This handler must NOT re-enter the V8 inspector console path that can itself
  // throw (issue #74): a page emitting frequent `console.error` could make a
  // `console.error(error)` here re-trigger `uncaughtException` in a tight ~1ms
  // loop that saturates a CPU core forever. So we:
  //   1. write raw to stderr (no `console` / inspector hook),
  //   2. wrap all logging in try/catch (touching `error.stack` can itself throw
  //      via a custom Error.prepareStackTrace / inspector wrapper),
  //   3. dedupe and hard-exit if the SAME exception storms, as a last-resort
  //      circuit breaker.
  const writeErr = (line: string) => { try { process.stderr.write(line + '\n'); } catch { /* never crash the handler */ } };
  let lastUncaughtMsg = '';
  let lastUncaughtAt = 0;
  let uncaughtCount = 0;
  process.on('uncaughtException', (error, origin) => {
    const now = Date.now();
    const msg = (error && (error as Error).message) ? (error as Error).message : String(error);
    if (msg === lastUncaughtMsg && now - lastUncaughtAt < 1000) {
      if (++uncaughtCount > 50) {
        writeErr('[devharness] Same uncaught exception >50x in <1s — exiting to break the loop.');
        process.exit(1);
      }
      return;
    }
    lastUncaughtMsg = msg;
    lastUncaughtAt = now;
    uncaughtCount = 0;
    writeErr(`[devharness] UNCAUGHT EXCEPTION (${origin}): ${msg}`);
    try { const s = (error as Error)?.stack; if (s) writeErr(`[devharness] Stack: ${s}`); } catch { /* stack getter can throw */ }
  });

  process.on('unhandledRejection', (reason) => {
    const msg = (reason && (reason as Error).message) ? (reason as Error).message : String(reason);
    writeErr(`[devharness] UNHANDLED REJECTION: ${msg}`);
    try { const s = (reason as Error)?.stack; if (s) writeErr(`[devharness] Stack: ${s}`); } catch { /* stack getter can throw */ }
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
