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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';
import { CDPManager } from './cdp-manager.js';
import { SourceMapHandler } from './sourcemap-handler.js';
import { ChromeLauncher, ChromeBinaryAbsentError, ChromeLaunchFailure, InvalidProfileNameError, ProfileInUseError, ProfileLockedError, normalizeProfileName, resolveLaunchPort, decideProfileReuse } from './chrome-launcher.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import { ConnectionManager, type Connection } from './connection-manager.js';
import { LogpointExecutionTracker } from './logpoint-execution-tracker.js';
import { PortReserver } from './port-reserver.js';
import { validateParams, createTool } from './validation-helpers.js';
import { ClickableCache } from './clickable-cache.js';
import { CommandRecorder } from './command-recorder.js';
import { createBreakpointTools } from './tools/breakpoint-tools.js';
import { createExecutionTools } from './tools/execution-tools.js';
import { createInspectionTools } from './tools/inspection-tools.js';
import { createSourceTools } from './tools/source-tools.js';
import { createConsoleTools } from './tools/console-tools.js';
import { createNetworkTools } from './tools/network-tools.js';
import { createProxyTools } from './tools/proxy-tools.js';
import { createPageTools } from './tools/page-tools.js';
import { createDOMTools } from './tools/dom-tools.js';
import { createScreenshotTools } from './tools/screenshot-tools.js';
import { createInputTools } from './tools/input-tools.js';
import { createContentTools } from './tools/content-tools.js';
import { createStorageTools } from './tools/storage-tools.js';
import { createTabTools } from './tools/tab-tools.js';
import { createDownloadTools } from './tools/download-tools.js';
import { createRequestTools } from './tools/request-tools.js';
import { createAssertTools } from './tools/assert-tools.js';
import { createWaitTools } from './tools/wait-tools.js';
import { createModalTools } from './tools/modal-tools.js';
import { createAnnotateTools } from './tools/annotate-tools.js';
import { createReplayTools } from './tools/replay-tools.js';
import { createServerTools } from './tools/server-tools.js';
import { createConfigTools } from './tools/config-tools.js';
import { createPluginTools } from './tools/plugin-tools.js';
import { createIssuesTools } from './tools/issues-tools.js';
import { createMessageTools } from './tools/message-tools.js';
import { startSessionEndpoint, type SessionEndpoint } from './session-endpoint.js';
import { runCli, isCliCommand, isVersionFlag, readPackageVersion } from './cli/index.js';
import { getClaudeSessionId, resolveSessionName } from './session-identity.js';
import { createDashboardTools, setDashboardInstance, getDashboardInstance, setSessionInfo, getSessionInfo, getDuplicateSessionInfo } from './tools/dashboard-tools.js';
import { initializeDashboard, shutdownDashboard, type DashboardInstance, type ConnectionInfo as DashboardConnectionInfo } from './dashboard/index.js';
import { Orchestrator } from './log-processor/orchestrator.js';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { ServerManager, detectAutoRestartCommand } from './server-manager.js';
import { configManager } from './config.js';
import { ToolError } from './tool-error.js';
import { startProxyFor } from './proxy/registry.js';
import { checkPortFailures, checkBreakpointPause, checkBugBlocking, checkPendingStartups, checkDuplicateSession, prependToResponse, appendToResponse, buildStatusSuffix, type StatusLineItem } from './tool-response.js';
import { recordBlockEvent, clearBlockEvents } from './block-events.js';
import { createStartupGate } from './startup-gate.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock, getMessage, getFormattedResponse } from './messages.js';
import { setChromeLauncher } from './error-helpers.js';
import { createServer } from 'net';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { debugLog, enableDebugLogging, disableDebugLogging, isDebugEnabled, enableHistoryLogging, disableHistoryLogging, setStartupMetrics } from './debug-logger.js';
import { validateReference, requireValidReference, deriveConnectionReference, UNNAMED_CONNECTION, InvalidReferenceError } from './reference-validator.js';
import { initializePaths, getOutputPath, resolveStateDir } from './helpers/paths.js';
import { cleanupStaleTempFiles, cleanupStaleTempFilesSync } from './atomic-write.js';
import { createSessionDetector, type SessionInfo, type SessionDetector } from './session-detector.js';
import { serverClaims } from './server-claims.js';
import { sizeWindowToViewport } from './window-sizing.js';

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
 * Which build is actually answering, so a session can tell whether the code it
 * is calling is the code it just compiled.
 *
 * A rebuild signals the supervisor named in this project's pidfile, which is
 * not necessarily the supervisor serving this session - when it isn't, the
 * build reports success and the old code keeps answering. There was no way to
 * notice: behaviour was read from a stale build for several iterations and a
 * fix that already worked was called broken (issue #135).
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
 * user silently runs an old skill against a newer tool surface. That is not
 * hypothetical - this package shipped a catalog describing a pre-grouping API
 * long after those tools were consolidated away. Comparing the stamped version
 * catches the copy case without needing any install machinery of our own.
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
const portReserver = new PortReserver();
const serverManager = new ServerManager();

// Configure connection manager to kill Chrome when last connection closes
connectionManager.setChromeLauncher(chromeLauncher);

// Let ServerManager's watch mode check whether a connection at a given
// inspector port is paused at a breakpoint, so it can defer a file-change
// restart until the debugger resumes (see requestWatchRestart()). Watched
// processes are always local, so 'localhost' matches how connectDebugger
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

/**
 * Wait for Chrome debugging port to become ready
 * Polls the /json/version endpoint until Chrome is inspectable
 */
async function waitForChromeReady(port: number, maxAttempts: number = 10): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`http://localhost:${port}/json/version`, {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Chrome is ready and inspectable
        return;
      }
    } catch (error) {
      // Chrome not ready yet, continue polling
    }

    // Exponential backoff: 500ms + (attempt * 200ms)
    await new Promise(resolve => setTimeout(resolve, 500 + i * 200));
  }

  throw new Error(`Chrome debugging port ${port} failed to become inspectable within timeout. Try increasing the wait time or check if Chrome started correctly.`);
}

/**
 * Check if Chrome is running and accessible on the specified port
 * Returns true if Chrome is responding to debug protocol requests
 * Returns false if port is reserved (chrome-not-running) or connection fails
 */
async function isChromeRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);

    const response = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Check if this is the port reserver responding
    const text = await response.text();
    if (text.trim() === 'chrome-not-running') {
      return false;
    }

    // Otherwise, check if we got a valid Chrome response
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stamp a launchChrome response with who owns the resulting connection.
 *
 * A replay run cannot tell from the text whether it CREATED a browser or was
 * handed one that already existed, and guessing either way is destructive: kill
 * a borrowed browser and the user loses state they cannot recover, keep an
 * owned one and every run leaks a process (issue #103).
 */
function withLaunchMeta(response: any, reference: string, reused: boolean): any {
  response._meta = { ...(response._meta || {}), launchChrome: { reference, reused } };
  return response;
}

// Connection management tools
const connectionTools = {
  launchChrome: createTool(
    'Launch Chrome with debugging',
    z.object({
      url: z.string().optional().describe('URL to open (default: blank page)'),
      autoConnect: z.boolean().optional().default(true).describe('Automatically connect debugger after launch'),
      port: z.number().optional().describe('The debugging port (optional, defaults to this session\'s reserved port). Use this to launch multiple Chrome instances on different ports. Always honoured when given - with forceNewInstance the call errors if that exact port is already taken instead of moving to another port.'),
      forceNewInstance: z.boolean().optional().describe('Always spawn a fresh Chrome process instead of reusing/tabbing into an existing instance. Without `port`, a free port is chosen automatically; with `port`, that port is used and the call errors if it is already in use. Errors if `reference` is already bound to a live connection.'),
      headless: z.boolean().optional().default(false).describe('Launch in headless mode (no visible window, prevents focus stealing). Default: false'),
      reference: z.string().optional().describe('Connection reference name (3 descriptive words). If not provided, defaults to "unnamed-connection-default". Use this to identify the connection when calling other tools.'),
      width: z.number().optional().describe('Viewport width in CSS px. Sizes the real OS window, not an emulated viewport, so the page keeps tracking window resizes. Bigger than the display is clamped and reported. Headless emulates instead.'),
      height: z.number().optional().describe('Viewport height in CSS px. Sized like `width`.'),
      profile: z.string().optional().describe('Named persistent Chrome profile, e.g. "device-a". Naming a profile makes it persistent: it maps to a stable user-data-dir under ~/.devharness/profiles (override per project with chrome.persistentProfileRoot) and is never deleted, so cookies, localStorage and IndexedDB - including non-extractable CryptoKeys - survive across runs. Created on first use. Does NOT pin a port; port selection is unchanged. Wipe it with config({action:"resetProfile", profile:"device-a"}). Only one live Chrome may hold a given profile at a time.'),
      proxy: z.boolean().optional().describe('Launch this browser through an intercepting proxy, so a response or a socket frame can be held and served in its place. Off by default: it makes Chrome show its unsupported-flag banner and forces HTTP/1.1. Only this browser is affected'),
      chromeArgs: z.array(z.string()).optional().describe('Extra Chrome command-line flags to pass through at launch, e.g. ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]. Merged after the managed defaults. The CDP_TOOLS_EXTRA_CHROME_ARGS env var (space-separated) is also always merged. Only applies when this call actually launches Chrome (ignored when an existing instance on the port is reused).'),
    }).strict(),
    async (args) => {
      // Validate reference FIRST, before launching Chrome
      const userReference = args.reference;
      if (userReference) {
        requireValidReference(userReference); // Throws InvalidReferenceError if invalid
      }

      // Validate the profile name before anything else - an invalid name must
      // not reach the filesystem, and naming a profile implies persistence
      // (there is no separate persist flag).
      let profileName: string | undefined;
      if (args.profile !== undefined) {
        try {
          profileName = normalizeProfileName(args.profile);
        } catch (error) {
          if (error instanceof InvalidProfileNameError) {
            return createErrorResponse('CHROME_PROFILE_INVALID_NAME', { profile: args.profile });
          }
          throw error;
        }
        // NOTE: the "profile already held" check deliberately happens further
        // down, once we know this call would actually have to spawn a second
        // Chrome. Checking here broke the standard idempotent call pattern
        // `launchChrome({ profile, reference })`: re-calling it to make sure
        // the browser is up always errored instead of reusing the very
        // connection that holds the profile.
      }

      /**
       * Profile gate for every point where we may hand back an existing Chrome
       * or spawn a new one. `existingPort` is the instance we would reuse
       * (omit when this call would spawn). Returns an error response, or null
       * to carry on. The decision itself is decideProfileReuse() in
       * chrome-launcher.ts so its ordering is unit-testable.
       */
      const profileGate = async (existingPort?: number) => {
        if (!profileName) {
          return null;
        }
        const decision = decideProfileReuse({
          wantedProfileDir: chromeLauncher.getPersistentProfilePath(profileName),
          existing: existingPort !== undefined
            ? { port: existingPort, profileDir: chromeLauncher.getProfileDir(existingPort) }
            : undefined,
          holderPort: chromeLauncher.findPortForProfile(profileName),
        });

        if (decision.decision === 'in-use') {
          await debugLog('index', `launchChrome: profile "${profileName}" already held by Chrome on port ${decision.port}`);
          return createErrorResponse('CHROME_PROFILE_IN_USE', {
            profile: profileName,
            port: decision.port.toString(),
          });
        }
        if (decision.decision === 'mismatch') {
          await debugLog('index', `launchChrome: port ${decision.port} already runs profile ${decision.actualProfile ?? 'unknown'}, not "${profileName}"`);
          return createErrorResponse('CHROME_PROFILE_PORT_MISMATCH', {
            profile: profileName,
            port: decision.port.toString(),
            actualProfile: decision.actualProfile ?? 'unknown (Chrome not launched by devharness)',
          });
        }
        return null;
      };

      // Is the port occupied by anything other than our own reservation?
      // Our port reserver holds a listening socket on the reserved port and
      // releases it as part of launching, so it must not count as "occupied".
      const isPortHeldByOther = async (candidate: number): Promise<boolean> => {
        if (portReserver.isReserved() && portReserver.getPort() === candidate) {
          return false;
        }
        return new Promise<boolean>((resolve) => {
          const probe = createServer();
          probe.once('error', () => resolve(true));
          probe.once('listening', () => probe.close(() => resolve(false)));
          // Bind IPv4 localhost to match Chrome's binding behaviour
          probe.listen(candidate, '127.0.0.1');
        });
      };

      // Use reserved port unless explicitly specified. The decision itself lives
      // in resolveLaunchPort() (chrome-launcher.ts) so it can be unit tested.
      const decision = await resolveLaunchPort({
        explicitPort: args.port,
        forceNewInstance: args.forceNewInstance,
        reservedPort: configManager.getCurrentPort(),
        isPortOccupied: async (candidate) =>
          connectionManager.hasBrowser('localhost', candidate) ||
          chromeLauncher.isRunning(candidate) ||
          await isPortHeldByOther(candidate),
        findFreePort: () => findAvailablePort(configManager.getChromeConfig().startingDebugPort),
      });
      if (decision.decision === 'forced-port-in-use') {
        await debugLog('index', `launchChrome: forceNewInstance requested port ${decision.port} but it is already in use`);
        return createErrorResponse('CHROME_FORCED_PORT_IN_USE', { port: decision.port.toString() });
      }
      // A named profile is an identity, and the Chrome already holding it IS
      // that identity - so go to its port rather than the session's reserved
      // one. Without this, `launchChrome({ profile })` for a profile that is up
      // under some other reference resolves to a free port, finds nothing
      // there, and refuses to spawn because the profile is held elsewhere:
      // "already running" reported as a conflict. An explicit port or
      // forceNewInstance is a deliberate override and still wins.
      const profileHolderPort = profileName && !args.port && !args.forceNewInstance
        ? chromeLauncher.findPortForProfile(profileName)
        : undefined;
      const port = profileHolderPort ?? decision.port;
      await debugLog('index', `launchChrome called: port=${port}, requested=${args.port}, reserved=${configManager.getCurrentPort()}, profileHolder=${profileHolderPort ?? 'none'}, forceNewInstance=${args.forceNewInstance}, url=${args.url}, autoConnect=${args.autoConnect}, reference=${args.reference}`);
      const url = args.url;
      const autoConnect = args.autoConnect ?? true;

      // Check if a connection with this reference already exists - reuse it instead of creating a new tab
      // Use validated lookup to auto-cleanup dead connections (e.g., if Chrome was killed externally)
      // Under forceNewInstance we still run this lookup, but a live match is an
      // error rather than a reuse: a fresh process bound to an already-bound
      // reference would leave two Chromes answering to the same name (bug-005).
      if (userReference) {
        const existingConnection = await connectionManager.findConnectionByReferenceValidated(userReference);
        if (existingConnection) {
          const sanitizedRef = validateReference(userReference).sanitized!;

          if (args.forceNewInstance) {
            await debugLog('index', `launchChrome: forceNewInstance with reference "${sanitizedRef}" already bound to a live connection - refusing to double-bind`);
            return createErrorResponse('CHROME_REFERENCE_ALREADY_BOUND', { reference: sanitizedRef });
          }

          // Reuse is only correct when that connection is running the profile
          // the caller asked for - otherwise we would hand back a different
          // browser identity under the same reference.
          const profileBlocked = await profileGate(existingConnection.port);
          if (profileBlocked) {
            return profileBlocked;
          }

          await debugLog('index', `Connection with reference "${sanitizedRef}" already exists, reusing`);

          // Set as active connection
          connectionManager.setActiveConnection(existingConnection.id);
          updateActiveManagers(existingConnection.id);

          // Get current page info
          let title = 'Unknown';
          let pageUrl = 'about:blank';
          if (existingConnection.puppeteerManager) {
            const page = existingConnection.puppeteerManager.getPage();
            pageUrl = page.url();
            title = await page.title();
          }

          // `reused: true` is how a replay run tells a browser it BORROWED from
          // one it created: the reference already existed, so it belongs to
          // whoever made it and must survive killChromeOnFinish.
          return withLaunchMeta(
            createSuccessResponse('CHROME_CONNECTION_REUSED', {
              reference: sanitizedRef,
              title,
              url: pageUrl
            }),
            sanitizedRef,
            true
          );
        }
      }

      try {
        // Check if Chrome is already running on this port
        // We check both connectionManager (tracked connections) and chromeLauncher (actual process)
        // This handles the case where a tab was closed but Chrome is still running
        const browserAlreadyExists = connectionManager.hasBrowser('localhost', port) || chromeLauncher.isRunning(port);
        await debugLog('index', `browserAlreadyExists: ${browserAlreadyExists} (hasBrowser: ${connectionManager.hasBrowser('localhost', port)}, isRunning: ${chromeLauncher.isRunning(port)})`);
        let isNewBrowser = false;

        // Reusing the Chrome already on this port would silently hand back a
        // different profile than the caller asked for, so only allow it when
        // that instance is genuinely running the requested profile. When there
        // is nothing on the port we would spawn, so a profile held by another
        // live instance is the real conflict (a second Chrome on one
        // user-data-dir is handed off to the first process and ours dies).
        const profileBlocked = await profileGate(browserAlreadyExists ? port : undefined);
        if (profileBlocked) {
          return profileBlocked;
        }

        if (!browserAlreadyExists) {
          await debugLog('index', `Launching new Chrome instance on port ${port}...`);
          // Launch new Chrome instance (will release port reservation)
          // Don't pass URL to launch if auto-connect is enabled - let Puppeteer handle navigation
          // This prevents race condition where Chrome starts loading before monitors are set up
          const launchUrl = autoConnect ? undefined : url;
          const proxyArgs = args.proxy
            ? (await startProxyFor(userReference ?? `port-${port}`, url)).chromeArgs
            : [];
          const result = await chromeLauncher.launch(port, launchUrl, portReserver, args.headless, [...proxyArgs, ...(args.chromeArgs ?? [])], profileName);
          await debugLog('index', `Chrome launched successfully: ${JSON.stringify(result)}`);
          isNewBrowser = true;
        }

        // Auto-connect if requested
        let connectionId: string | undefined;
        let runtimeType: string | undefined;
        let title = 'New Tab';
        let pageUrl = 'about:blank';
        let consoleStats = '';
        let viewportSet: { width: number; height: number } | undefined;
        let viewportClamped: { width: number; height: number } | undefined;

        if (autoConnect) {
          try {
            // Chrome is already ready (launch() waits for port binding)
            // Add small delay for new browser to ensure full initialization
            if (isNewBrowser) {
              await debugLog('index', `Waiting 500ms for new Chrome browser to stabilize...`);
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Create connection managers for this tab
            const cdpManager = new CDPManager(sourceMapHandler);
            const puppeteerManager = new PuppeteerManager();
            const consoleMonitor = new ConsoleMonitor();
            const networkMonitor = new NetworkMonitor();

            // For existing browser, connect Puppeteer first and create/reuse a tab
            // This ensures we have a target to connect CDP to (handles case where all tabs were closed)
            let targetId: string | undefined;
            if (browserAlreadyExists) {
              await debugLog('index', `Browser exists, connecting Puppeteer and creating new tab first...`);
              await puppeteerManager.connect('localhost', port);

              // Get all existing pages
              const existingPages = await puppeteerManager.getPages();
              await debugLog('index', `Found ${existingPages.length} existing pages`);

              // Create a new page for this connection
              const page = await puppeteerManager.newPage();

              // Close any existing blank pages to avoid clutter
              for (const existingPage of existingPages) {
                try {
                  const pageUrl = existingPage.url();
                  if (pageUrl === 'about:blank' || pageUrl === 'chrome://newtab/') {
                    await debugLog('index', `Closing blank page: ${pageUrl}`);
                    await existingPage.close();
                  }
                } catch (e) {
                  // Page might already be closed, ignore
                }
              }

              // Get the target ID of the new page so we can connect CDP to it specifically
              const target = page.target();
              targetId = (target as any)._targetId || (target as any)._targetInfo?.targetId;
              await debugLog('index', `Created new tab with targetId: ${targetId}`);
            }

            // Connect to CDP (with specific target if we created a new tab)
            await cdpManager.connect('localhost', port, targetId);
            runtimeType = cdpManager.getRuntimeType();

            // Set up pause/resume callbacks to control port monitoring
            const portMonitor = serverManager.getPortMonitor();
            cdpManager.setPauseCallback(() => portMonitor.pauseMonitoring());
            cdpManager.setResumeCallback(() => portMonitor.resumeMonitoring());

            // Connect Puppeteer for Chrome (if not already connected)
            if (runtimeType === 'chrome' && !browserAlreadyExists) {
              await puppeteerManager.connect('localhost', port);
            }

            if (runtimeType === 'chrome') {

              // Start monitoring console and network
              const page = puppeteerManager.getPage();
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Register logpoint tracker callback on this connection's console monitor
              consoleMonitor.onMessage((message) => {
                logpointTracker.handleConsoleMessage(message);
              });

              if (args.width !== undefined || args.height !== undefined) {
                const current = await page.evaluate(() => {
                  const w = (globalThis as any).window;
                  return { width: w.innerWidth, height: w.innerHeight };
                });
                const target = {
                  width: args.width ?? current.width,
                  height: args.height ?? current.height,
                };
                const sized = await sizeWindowToViewport(page, target, args.headless === true);
                viewportSet = sized.viewport;
                viewportClamped = sized.clampedTo;
                await debugLog(
                  'index',
                  `Sized ${sized.mode} to ${sized.viewport.width}x${sized.viewport.height}` +
                    (sized.clampedTo ? ` (clamped from ${target.width}x${target.height})` : '')
                );
              }

              // Navigate to URL if provided
              if (url) {
                await debugLog('index', `Navigating to URL: ${url}`);
                await page.goto(url, { waitUntil: 'load', timeout: 30000 });
                await debugLog('index', `Navigation to ${url} completed`);
              }

              // Auto-reload page to capture initial console logs (only if not navigating and has content)
              const currentUrl = page.url();
              if (!url && currentUrl && currentUrl !== 'about:blank') {
                try {
                  await page.reload({ waitUntil: 'load', timeout: 5000 });
                  await new Promise(resolve => setTimeout(resolve, 500));
                } catch (reloadError: any) {
                  console.error(`[devharness] Warning: Page reload failed: ${reloadError.message}`);
                }
              }
            }

            // Get page index for tracking
            const pages = await puppeteerManager.getPages();
            const currentPage = puppeteerManager.getPage();
            const pageIndex = pages.findIndex(p => p === currentPage);

            // Register connection with user-provided reference or default
            // Reference was already validated at the start of the handler
            let connectionReference = UNNAMED_CONNECTION;
            if (userReference) {
              // Use the sanitized version (lowercase with hyphens)
              const validation = validateReference(userReference);
              connectionReference = validation.sanitized!;
            }

            connectionId = connectionManager.createConnection(
              cdpManager,
              puppeteerManager,
              consoleMonitor,
              networkMonitor,
              'localhost',
              port,
              connectionReference,
              pageIndex
            );

            // Update active manager references
            updateActiveManagers(connectionId);

            // Get page info for Chrome connections
            if (runtimeType === 'chrome') {
              const page = puppeteerManager.getPage();
              pageUrl = page.url();
              title = await page.title();

              // Get console stats and update cursor so first tool call doesn't re-report these
              const logStats = consoleMonitor.getLogStats();
              if (logStats.totalMessages > 0) {
                const details: string[] = [];
                const errorCount = logStats.newErrors;
                const warnCount = logStats.newWarnings;
                const otherCount = logStats.totalMessages - errorCount - warnCount;
                if (errorCount > 0) details.push(`${errorCount} err`);
                if (warnCount > 0) details.push(`${warnCount} warn`);
                if (otherCount > 0) details.push(`${otherCount} log`);
                consoleStats = `\n**Console:** ${details.join('/')}`;
              }
            }
          } catch (connectError) {
            // Log the auto-connect failure
            await debugLog('index', `Auto-connect failed: ${connectError}`);

            // If auto-connect fails, return detailed error
            const errorMessage = connectError instanceof Error ? connectError.message : String(connectError);
            return createSuccessResponse('CHROME_LAUNCH_AUTO_CONNECT_FAILED', {
              port: port.toString(),
              error: errorMessage,
              suggestion: 'Chrome launched but auto-connect failed. Try manually connecting with connectDebugger().'
            }, {
              port: port,
              isNewBrowser,
            });
          }
        }

        // Format response based on whether auto-connect was used
        if (autoConnect) {
          const connection = connectionManager.getConnection(connectionId);
          const reference = connection?.reference || UNNAMED_CONNECTION;
          const inactivityTimeoutMinutes = configManager.getChromeConfig().inactivityTimeoutMinutes;
          const inactivityNote = inactivityTimeoutMinutes > 0
            ? `\n\nNote: This connection auto-closes after ${inactivityTimeoutMinutes} min of no tool activity against it. Any tool call using this connectionReason resets the timer.`
            : '';

          return withLaunchMeta(
            createSuccessResponse('CHROME_LAUNCH_SUCCESS', {
              reference,
              title: title || '(no title)',
              url: pageUrl,
              consoleStats: consoleStats || undefined,
              hasUserReference: !!userReference,
              viewport: viewportSet,
              viewportClamped: viewportClamped ? true : undefined,
              inactivityNote,
            }),
            reference,
            false
          );
        } else {
          return createSuccessResponse('CHROME_LAUNCH_NO_CONNECT', { port: port.toString() }, { port, isNewBrowser });
        }
      } catch (error) {
        // Lost a race for the profile between the pre-check above and the
        // launcher's own guard - report it as the profile conflict it is.
        if (error instanceof ProfileInUseError) {
          return createErrorResponse('CHROME_PROFILE_IN_USE', {
            profile: error.profile,
            port: error.port.toString(),
          });
        }
        // Held by a Chrome from ANOTHER process (the persistent profile root is
        // global) - we know the PID but not its debug port, so CHROME_PROFILE_IN_USE
        // (which talks in ports) does not fit. Reported with the launcher's own
        // explanation until a dedicated template exists.
        if (error instanceof ProfileLockedError) {
          return createErrorResponse('CHROME_SPAWN_FAILED', { error: error.message });
        }
        // No file at the resolved path - reported as the two facts it is, with
        // no statement about what should be installed or where.
        if (error instanceof ChromeBinaryAbsentError) {
          return createErrorResponse('CHROME_BINARY_ABSENT', {
            chromePath: error.chromePath,
            platform: error.platform,
          });
        }
        // Chrome started and the port never answered. The readings go in _meta;
        // the text names them without naming a cause.
        if (error instanceof ChromeLaunchFailure) {
          const o = error.observations;
          const exited = o.exitCode !== null || o.exitSignal !== null;
          // A spawn that produced no process leaves no probe reading that
          // describes the failure; the spawn error itself is the observation.
          const response = o.spawnFailure !== null
            ? createErrorResponse('CHROME_SPAWN_FAILED', { error: o.spawnFailure })
            : exited
            ? createErrorResponse('CHROME_LAUNCH_PROCESS_EXITED', {
                port: o.port.toString(),
                exitCode: o.exitCode === null ? 'none' : o.exitCode.toString(),
                exitSignal: o.exitSignal ?? 'none',
                elapsedMs: o.elapsedMs.toString(),
                stderrTail: o.stderrTail,
                probeAttempts: o.probeAttempts.toString(),
                probeFailures: o.probeFailures.join('\n'),
                profileDir: o.profileDir ?? '',
                chromePath: o.chromePath,
              })
            : createErrorResponse('CHROME_LAUNCH_TIMEOUT', {
                port: o.port.toString(),
                elapsedMs: o.elapsedMs.toString(),
                stderrTail: o.stderrTail,
                probeAttempts: o.probeAttempts.toString(),
                probeFailures: o.probeFailures.join('\n'),
                profileDir: o.profileDir ?? '',
                chromePath: o.chromePath,
              });
          response._meta = {
            tool: 'launchChrome',
            timestamp: Date.now(),
            launchObservations: o,
          };
          return response;
        }
        return createErrorResponse('CHROME_SPAWN_FAILED', { error: `${error}` });
      }
    }
  ),

  killChrome: createTool(
    'Kill Chrome process',
    z.object({
      reason: z.string().describe('Why Chrome needs to be killed'),
      port: z.number().optional().describe('Port of specific Chrome instance to kill. If not provided, kills all Chrome instances.'),
    }).strict(),
    async (args) => {
      try {
        const port = args.port;
        await debugLog('index', `killChrome called - reason: ${args.reason}, port: ${port ?? 'all'}`);

        // Set the close reason before killing (used for close event tracking)
        if (port !== undefined) {
          chromeLauncher.setPendingCloseReason(port, 'manual');
        } else {
          for (const p of chromeLauncher.getRunningPorts()) {
            chromeLauncher.setPendingCloseReason(p, 'manual');
          }
        }

        // Kill Chrome - the exit callback handles connection cleanup and port re-reservation
        await chromeLauncher.kill(port);

        return createSuccessResponse('CHROME_KILLED', {
          port: port ?? 'all',
          reason: args.reason
        });
      } catch (error) {
        return createErrorResponse('CHROME_KILL_FAILED', { error: `${error}` });
      }
    }
  ),

  resetChromeLauncher: createTool(
    'Reset Chrome launcher',
    z.object({
      reason: z.string().describe('Why Chrome launcher needs to be reset'),
    }).strict(),
    async (args) => {
      // Log the reason for audit purposes
      console.error(`[devharness] resetChromeLauncher called - Reason: ${args.reason}`);
      chromeLauncher.reset();
      return createSuccessResponse('CHROME_LAUNCHER_RESET');
    }
  ),

  getChromeStatus: createTool(
    'Get Chrome status',
    z.object({}).strict(),
    async () => {
      const status = chromeLauncher.getStatus();
      // Format for template rendering
      const formattedStatus = {
        ...status,
        lastCloseEvents: status.lastCloseEvents.map(event => ({
          ...event,
          timestamp: event.timestamp.toISOString(),
          hasExitCode: event.exitCode !== null && event.exitCode !== undefined,
        })),
      };
      return createSuccessResponse('CHROME_STATUS', formattedStatus, status);
    }
  ),

  setDebugLogging: createTool(
    'Toggle debug logging',
    z.object({
      enabled: z.boolean().describe('Set to true to enable debug logging, false to disable'),
    }).strict(),
    async (args) => {
      if (args.enabled) {
        await enableDebugLogging(); // Now async to log startup metrics
        return createSuccessResponse('DEBUG_LOGGING_ENABLED', {
          message: 'Debug logging enabled. Logs will be written to .devharness/logs/debug.log'
        }, {
          enabled: true,
          message: 'Debug logging enabled. Logs will be written to .devharness/logs/debug.log'
        });
      } else {
        disableDebugLogging();
        return createSuccessResponse('DEBUG_LOGGING_DISABLED', {
          message: 'Debug logging disabled'
        }, {
          enabled: false,
          message: 'Debug logging disabled'
        });
      }
    }
  ),

  getDebugLoggingStatus: createTool(
    'Check debug logging status',
    z.object({}).strict(),
    async () => {
      const enabled = isDebugEnabled();
      return createSuccessResponse('DEBUG_LOGGING_STATUS', {
        status: enabled ? 'enabled' : 'disabled',
        enabled,  // Pass boolean for conditionals
        logFile: '.devharness/logs/debug.log'
      }, {
        enabled,
        logFile: '.devharness/logs/debug.log'
      });
    }
  ),

  connectDebugger: createTool(
    'Connect to debugger',
    z.object({
      reference: z.string().describe('3 descriptive words describing this debugging activity'),
      host: z.string().optional().default('localhost').describe('The debugger host (default: localhost)'),
      port: z.number().optional().describe('The debugger port (optional, defaults to this session\'s auto-assigned port). Use this to connect to debuggers on different ports (e.g., Node.js on 9229, Chrome on 9222).'),
    }).strict(),
    async (args) => {
      // Validate reference
      // Validate and get sanitized reference (throws if invalid)
      const reference = requireValidReference(args.reference);

      // Check for duplicate reference - use validated lookup to auto-cleanup dead connections
      const existingConnection = await connectionManager.findConnectionByReferenceValidated(reference);
      if (existingConnection) {
        return createErrorResponse('REFERENCE_IN_USE', {
          reference
        });
      }

      const host = args.host || 'localhost';
      const port = args.port || configManager.getCurrentPort();
      const defaultPort = configManager.getCurrentPort();
      const isDefaultPort = port === defaultPort;

      await debugLog('index', `connectDebugger called: host=${host}, port=${port}, defaultPort=${defaultPort}`);

      try {
        // Check if Chrome/debugger is running before attempting connection
        await debugLog('index', `Checking if Chrome is running on port ${port}...`);
        const isRunning = await isChromeRunning(port);
        await debugLog('index', `isChromeRunning result: ${isRunning}`);

        if (!isRunning) {
          await debugLog('index', `Chrome not running on port ${port}, returning error`);
          // Provide clear error message based on port type
          if (isDefaultPort && host === 'localhost') {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `Chrome is not running on port ${port}. Use \`launchChrome()\` to start Chrome first.`
            });
          } else {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `No debugger found on ${host}:${port}. For Chrome, use \`launchChrome({ port: ${port} })\`. For Node.js, start with \`node --inspect=${port} app.js\``
            });
          }
        }

        // Check if browser already exists on this port
        const browserAlreadyExists = connectionManager.hasBrowser(host, port);

        // Create new managers for this tab/connection
        const cdpManager = new CDPManager(sourceMapHandler);
        const puppeteerManager = new PuppeteerManager();
        const consoleMonitor = new ConsoleMonitor();
        const networkMonitor = new NetworkMonitor();

        // Connect CDP first to detect runtime type
        await cdpManager.connect(host, port);
        const runtimeType = cdpManager.getRuntimeType();

        // If this port belongs to a server devharness is managing, and its start
        // command looks auto-restarting (--watch, nodemon, etc.), warn: pausing
        // at a breakpoint on that process while it can self-restart on file
        // changes is a known-bad combination.
        let autoRestartWarning = '';
        if (runtimeType === 'node') {
          const managedServer = await serverManager.getManagedServerByInspectorPort(port);
          const autoRestartMatch = managedServer ? detectAutoRestartCommand(managedServer.command) : null;
          if (autoRestartMatch) {
            autoRestartWarning = `\n\n**Warning:** Server "${managedServer!.id}" on this port matches "${autoRestartMatch}", which auto-restarts its own process on file changes. Pausing at a breakpoint here while it can self-restart is a known-bad combination (can cause EADDRINUSE crash-loops and ambiguous failed-but-still-listening states). Prefer disabling auto-restart while breakpoint debugging and calling server({ action: 'restart' }) explicitly instead.`;
          }
        }

        // Set up pause/resume callbacks to control port monitoring
        const portMonitor = serverManager.getPortMonitor();
        cdpManager.setPauseCallback(() => portMonitor.pauseMonitoring());
        cdpManager.setResumeCallback(() => portMonitor.resumeMonitoring());

        const features = ['debugging'];

        // Only connect Puppeteer for Chrome (browser automation)
        if (runtimeType === 'chrome') {
          await puppeteerManager.connect(host, port);

          // Create new tab if browser already existed
          if (browserAlreadyExists) {
            await puppeteerManager.newPage();
          }

          // Start monitoring console and network
          const page = puppeteerManager.getPage();
          consoleMonitor.startMonitoring(page);
          networkMonitor.startMonitoring(page);

          // Auto-reload page to capture initial console logs
          // Skip reload for blank pages (nothing to reload)
          const currentUrl = page.url();
          if (currentUrl && currentUrl !== 'about:blank') {
            try {
              // Use 'load' instead of 'networkidle0' for compatibility with file:// URLs
              await page.reload({ waitUntil: 'load', timeout: 5000 });
              // Wait a bit more for all scripts to execute and errors to fire
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (reloadError: any) {
              // Log warning but don't fail - page might already be loaded
              console.error(`[devharness] Warning: Page reload failed: ${reloadError.message}`);
            }
          }

          features.push('browser-automation', 'console-monitoring', 'network-monitoring');
        } else {
          // For Node.js debugging, set up console monitoring via CDP Runtime.consoleAPICalled
          // Set up value expander to get full object details (passes maxDepth from consoleMonitor)
          consoleMonitor.setValueExpander((objectId, maxDepth) => cdpManager.expandObjectById(objectId, maxDepth));
          cdpManager.setConsoleMessageCallback((message) => {
            consoleMonitor.addCDPConsoleMessage(message);
          });
          consoleMonitor.enableWithoutPage();
          features.push('console-monitoring');
        }

        // Register logpoint tracker callback on this connection's console monitor
        // This ensures logpoint executions are tracked for both Chrome and Node.js connections
        consoleMonitor.onMessage((message) => {
          logpointTracker.handleConsoleMessage(message);
        });

        // Get page index for tracking
        let pageIndex: number | undefined;
        if (runtimeType === 'chrome') {
          const pages = await puppeteerManager.getPages();
          const currentPage = puppeteerManager.getPage();
          pageIndex = pages.findIndex(p => p === currentPage);
        }

        // Register connection with ConnectionManager
        // Note: consoleMonitor is always passed now (works for both Chrome and Node.js)
        const connectionId = connectionManager.createConnection(
          cdpManager,
          runtimeType === 'chrome' ? puppeteerManager : undefined,
          consoleMonitor, // Always include - works for both Chrome (via Puppeteer) and Node.js (via CDP)
          runtimeType === 'chrome' ? networkMonitor : undefined,
          host,
          port,
          reference, // Set reference from parameter
          pageIndex
        );

        // Update active manager references
        updateActiveManagers(connectionId);

        // Build console stats for Chrome connections
        let consoleStats: string | undefined;
        if (runtimeType === 'chrome') {
          const connection = connectionManager.getConnection(connectionId);
          if (connection?.consoleMonitor) {
            // Get console stats and update cursor so first tool call doesn't re-report these
            const logStats = connection.consoleMonitor.getLogStats();
            if (logStats.totalMessages > 0) {
              const details: string[] = [];
              if (logStats.newErrors > 0) details.push(`${logStats.newErrors} err`);
              if (logStats.newWarnings > 0) details.push(`${logStats.newWarnings} warn`);
              const otherCount = logStats.totalMessages - logStats.newErrors - logStats.newWarnings;
              if (otherCount > 0) details.push(`${otherCount} log`);
              consoleStats = details.join('/');
            }
          }
        }

        return createSuccessResponse('DEBUGGER_CONNECT_SUCCESS', {
          runtimeType,
          host,
          port: port.toString(),
          reference,
          features: features.join(', '),
          consoleStats,
          isChrome: runtimeType === 'chrome',
          isNode: runtimeType === 'node',
          autoRestartWarning,
        });
      } catch (error) {
        return createErrorResponse('DEBUGGER_CONNECT_FAILED', {
          host,
          port: port.toString(),
          error: `${error}`
        });
      }
    }
  ),

  disconnectDebugger: createTool(
    'Disconnect debugger',
    z.object({
      reason: z.string().describe('Why the connection needs to be disconnected'),
      reference: z.string().describe('3 descriptive words of the connection to disconnect'),
    }).strict(),
    async (args) => {
      // Log the reason for audit purposes
      console.error(`[devharness] disconnectDebugger called - Reason: ${args.reason}, Reference: ${args.reference}`);

      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
      }

      const success = await connectionManager.closeConnection(connection.id);

      if (success) {
        return createSuccessResponse('DEBUGGER_DISCONNECT_SUCCESS', { reference: args.reference });
      } else {
        return createErrorResponse('CONNECTION_SWITCH_FAILED', { reference: args.reference });
      }
    }
  ),

  loadSourceMaps: createTool(
    'Load source maps',
    z.object({
      directory: z.string().describe('The directory containing .js.map files'),
    }).strict(),
    async (args) => {
      const { directory } = args;

      try {
        const registered = await sourceMapHandler.registerSourceMapsFromDirectory(directory);

        return createSuccessResponse('SOURCE_MAPS_LOADED', {
          count: registered.toString(),
          directory
        }, { registered, note: 'Source maps registered for lazy loading (will be loaded on demand)' });
      } catch (error) {
        return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${error}` });
      }
    }
  ),

  getDebuggerStatus: createTool(
    'Get debugger status',
    z.object({
      reference: z.string().describe('3 descriptive words of the connection to check'),
    }).strict(),
    async (args) => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
      }

      const cdpManager = connection.cdpManager;
      const puppeteerManager = connection.puppeteerManager;
      const consoleMonitor = connection.consoleMonitor;
      const networkMonitor = connection.networkMonitor;
      const connected = cdpManager.isConnected();
      const runtimeType = cdpManager.getRuntimeType();
      const paused = cdpManager.isPaused();
      const breakpointCounts = cdpManager.getBreakpointCounts();
      const sourceMaps = sourceMapHandler.getLoadedSourceMaps();
      const puppeteerConnected = puppeteerManager?.isConnected() || false;

      const statusData = {
        reference: connection.reference || UNNAMED_CONNECTION,
        connected,
        runtimeType,
        puppeteerConnected,
        paused,
        breakpoints: breakpointCounts.breakpoints,
        logpoints: breakpointCounts.logpoints,
        totalBreakpoints: breakpointCounts.total,
        sourceMapCount: sourceMaps.length,
        consoleMonitoring: consoleMonitor?.isActive() ? 'active' : 'inactive',
        networkMonitoring: networkMonitor?.isActive() ? 'active' : 'inactive',
        totalConnections: connectionManager.getConnectionCount(),
      };

      return createSuccessResponse('CONNECTION_STATUS', {}, statusData);
    }
  ),

  listConnections: createTool(
    'List debugger connections',
    z.object({}).strict(),
    async () => {
      const connections = connectionManager.listConnections();
      const activeId = connectionManager.getActiveConnectionId();
      const activeConnection = activeId ? connectionManager.getConnection(activeId) : null;
      const activeReference = activeConnection?.reference || UNNAMED_CONNECTION;

      const connectionList = connections.map(conn => ({
        reference: conn.reference || UNNAMED_CONNECTION,
        type: conn.type,
        host: conn.host,
        port: conn.port,
        active: conn.id === activeId,
        connected: conn.cdpManager.isConnected(),
        paused: conn.cdpManager.isPaused(),
        createdAt: new Date(conn.createdAt).toISOString(),
      }));

      return createSuccessResponse('CONNECTIONS_LIST', {
        totalConnections: connections.length.toString()
      }, {
        activeReference,
        connections: connectionList,
      });
    }
  ),

  switchConnection: createTool(
    'Switch debugger connection',
    z.object({
      reference: z.string().describe('3 descriptive words of the connection to switch to'),
    }).strict(),
    async (args) => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.reference);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.reference
        });
      }

      const success = connectionManager.setActiveConnection(connection.id);

      if (success) {
        // Update active manager references
        updateActiveManagers(connection.id);
        return createSuccessResponse('CONNECTION_SWITCH_SUCCESS', { reference: args.reference });
      } else {
        return createErrorResponse('CONNECTION_SWITCH_FAILED', { reference: args.reference });
      }
    }
  ),
};

// Active connection manager references (updated when connection is made/switched)
let activeCdpManager: CDPManager | null = null;
let activePuppeteerManager: PuppeteerManager | null = null;
let activeConsoleMonitor: ConsoleMonitor | null = null;
let activeNetworkMonitor: NetworkMonitor | null = null;

// Session detection state (set in main, used in tool handler)
let sessionDetectorInstance: SessionDetector | null = null;
let sessionVerifyStarted = false;

// Log processor orchestrator (set in main for hub instances)
let orchestratorInstance: Orchestrator | null = null;

// Helper to update active manager references
const updateActiveManagers = (connectionId?: string) => {
  const connection = connectionManager.getConnection(connectionId);
  if (connection) {
    activeCdpManager = connection.cdpManager;
    activePuppeteerManager = connection.puppeteerManager || null;
    activeConsoleMonitor = connection.consoleMonitor || null;
    activeNetworkMonitor = connection.networkMonitor || null;
    // Update activity timestamp whenever connection is accessed
    connectionManager.updateActivity(connection.id);
  }
};

/**
 * Resolve a connection from a connectionReason (task description)
 * Sanitizes the reason, looks for existing tab, or creates new one
 */
async function resolveConnectionFromReason(connectionReason: string): Promise<{
  connection: Connection;
  cdpManager: CDPManager;
  puppeteerManager: PuppeteerManager | null;
  consoleMonitor: ConsoleMonitor | null;
  networkMonitor: NetworkMonitor | null;
} | null> {
  // Sanitize: lowercase, trim, spaces to hyphens
  const reference = connectionReason.toLowerCase().trim().replace(/\s+/g, '-');

  // Find connection by reference only
  const connection = connectionManager.findConnectionByReference(reference);

  // If not found, return null to show error
  if (!connection) {
    return null;
  }

  // Update activity timestamp when connection is accessed
  connectionManager.updateActivity(connection.id);

  return {
    connection,
    cdpManager: connection.cdpManager,
    puppeteerManager: connection.puppeteerManager || null,
    consoleMonitor: connection.consoleMonitor || null,
    networkMonitor: connection.networkMonitor || null,
  };
}

// Create proxy managers that delegate to active connection
const proxyHandlerForManager = {
  get(target: any, prop: string) {
    // For CDPManager
    if (target.constructor.name === 'CDPManager' && activeCdpManager) {
      return (activeCdpManager as any)[prop];
    }
    // For PuppeteerManager
    if (target.constructor.name === 'PuppeteerManager' && activePuppeteerManager) {
      return (activePuppeteerManager as any)[prop];
    }
    // For ConsoleMonitor
    if (target.constructor.name === 'ConsoleMonitor' && activeConsoleMonitor) {
      return (activeConsoleMonitor as any)[prop];
    }
    // For NetworkMonitor
    if (target.constructor.name === 'NetworkMonitor' && activeNetworkMonitor) {
      return (activeNetworkMonitor as any)[prop];
    }
    return target[prop];
  },
};

// Create proxy managers
const proxyCdpManager = new Proxy(new CDPManager(sourceMapHandler), proxyHandlerForManager);
const proxyPuppeteerManager = new Proxy(new PuppeteerManager(), proxyHandlerForManager);
const proxyConsoleMonitor = new Proxy(new ConsoleMonitor(), proxyHandlerForManager);
const proxyNetworkMonitor = new Proxy(new NetworkMonitor(), proxyHandlerForManager);

// Register logpoint tracker callbacks
proxyConsoleMonitor.onMessage((message: any) => {
  logpointTracker.handleConsoleMessage(message);
});

logpointTracker.setLimitExceededCallback((metadata) => {
  proxyCdpManager.handleLogpointLimitExceeded({
    breakpointId: metadata.breakpointId,
    url: metadata.url,
    lineNumber: metadata.lineNumber,
    logMessage: metadata.logMessage,
    executionCount: metadata.executionCount,
    maxExecutions: metadata.maxExecutions,
    logs: metadata.logs,
  });
});

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}

let pidAnnounced = false;
let statusLegendShown = false;

/**
 * Execute a tool call - used by replay system
 */
async function executeToolCall(toolName: string, params: Record<string, any>, abortSignal?: AbortSignal): Promise<any> {
  const tool = allTools[toolName as keyof typeof allTools];

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const validation = validateParams(params, (tool as any).zodSchema, toolName);

  if (!validation.success) {
    throw new Error(`Validation failed: ${JSON.stringify(validation.error)}`);
  }

  const result = await tool.handler(validation.data, abortSignal);

  // If tool returned an error, throw it as a ToolError so it propagates correctly
  if (result?.isError) {
    throw new ToolError(result);
  }

  return result;
}

// Combine all tools (conditionally based on config)
const allTools = {
  // Connection tools (Chrome/debugger)
  ...(configManager.isToolEnabled('connection') ? connectionTools : {}),
  // Tab Management tools
  ...(configManager.isToolEnabled('tab') ? createTabTools(connectionManager, sourceMapHandler, updateActiveManagers, logpointTracker, serverManager) : {}),
  // CDP Debugging tools
  ...(configManager.isToolEnabled('breakpoint') ? createBreakpointTools(proxyCdpManager, sourceMapHandler, logpointTracker, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('execution') ? createExecutionTools(proxyCdpManager, resolveConnectionFromReason, connectionManager, (port) => serverManager.retryPendingRestartByInspectorPort(port)) : {}),
  ...(configManager.isToolEnabled('inspection') ? createInspectionTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('source') ? createSourceTools(proxyCdpManager, sourceMapHandler, resolveConnectionFromReason) : {}),
  // Browser Automation tools
  ...(configManager.isToolEnabled('console') ? createConsoleTools(proxyPuppeteerManager, proxyConsoleMonitor, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('network') ? createNetworkTools(proxyPuppeteerManager, proxyNetworkMonitor, resolveConnectionFromReason) : {}),
  ...createProxyTools(),
  ...(configManager.isToolEnabled('page') ? createPageTools(proxyPuppeteerManager, proxyCdpManager, proxyConsoleMonitor, proxyNetworkMonitor, connectionManager, resolveConnectionFromReason, clickableCache, executeToolCall) : {}),
  ...(configManager.isToolEnabled('dom') ? createDOMTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('screenshot') ? createScreenshotTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('input') ? createInputTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('content') ? createContentTools(proxyPuppeteerManager, proxyCdpManager, connectionManager, resolveConnectionFromReason, clickableCache) : {}),
  ...(configManager.isToolEnabled('modal') ? createModalTools(resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('annotate') ? createAnnotateTools(proxyPuppeteerManager, sourceMapHandler, commandRecorder, executeToolCall, resolveConnectionFromReason) : {}),
  ...(configManager.isToolEnabled('storage') ? createStorageTools(proxyPuppeteerManager, proxyCdpManager, resolveConnectionFromReason) : {}),
  // Download tools
  ...(configManager.isToolEnabled('download') ? createDownloadTools() : {}),
  // Request tools (HTTP requests as sequence steps, node or browser destination)
  ...(configManager.isToolEnabled('request') ? createRequestTools(resolveConnectionFromReason) : {}),
  // Assert tool (inline assertions as sequence steps)
  ...(configManager.isToolEnabled('assert') ? createAssertTools(resolveConnectionFromReason) : {}),
  // Wait tool (wait primitive for sequences - MCP-side condition polling / sleep)
  ...(configManager.isToolEnabled('wait') ? createWaitTools(resolveConnectionFromReason) : {}),
  // Replay tools
  ...(configManager.isToolEnabled('replay') ? createReplayTools(commandRecorder, executeToolCall, async (connectionReason: string) => {
    const resolved = await resolveConnectionFromReason(connectionReason);
    if (!resolved?.puppeteerManager) return null;
    return resolved.puppeteerManager.getPage();
  }, async (connectionReason: string) => {
    const resolved = await resolveConnectionFromReason(connectionReason);
    return resolved?.connection.port ?? null;
    // Lazy: allTools is defined below this object literal, so the set of valid
    // tool names can only be read at call time (bug-010). The explicit return
    // type is required - without it, allTools appears in its own initializer
    // and TypeScript cannot infer it (TS7022).
  }, (): string[] => Object.keys(allTools)) : {}),
  // Server management tools
  ...(configManager.isToolEnabled('server') ? createServerTools(serverManager) : {}),
  // Config management tools (always enabled - not toggleable)
  ...createConfigTools(chromeLauncher, { version: SERVER_VERSION, ...BUILD_IDENTITY }),
  // Plugin management tools (always enabled - not toggleable)
  ...createPluginTools(() => orchestratorInstance),
  // Issues tracking tools
  ...(configManager.isToolEnabled('issues') ? createIssuesTools(
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
    async (connectionReason: string) => {
      const resolved = await resolveConnectionFromReason(connectionReason);
      if (!resolved?.puppeteerManager) return null;
      return resolved.puppeteerManager.getPage();
    },
    // Lazy: allTools is defined below. Lets a pulled sequence be checked
    // against the live tool list before it is written to disk.
    (): string[] => Object.keys(allTools)
  ) : {}),
  // Dashboard tools (lazy-initialized in main())
  ...(configManager.isToolEnabled('dashboard') ? createDashboardTools() : {}),
  // Cross-session message tools
  ...(configManager.isToolEnabled('message') ? createMessageTools() : {}),
};

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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const tool = allTools[toolName as keyof typeof allTools];

    if (!tool) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Unknown tool: ${toolName}`,
              code: 'UNKNOWN_TOOL',
              availableTools: Object.keys(allTools).sort()
            }, null, 2),
          },
        ],
        isError: true
      };
    }

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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(validation.error, null, 2),
          },
        ],
        isError: true
      };
    }

    // Record command if recording is active (but don't record replay tool calls)
    // Capture the command index for the repeat hint
    let commandIndex: number | null = null;
    if (toolName !== 'replay') {
      await commandRecorder.recordCommand(toolName, validation.data);
      commandIndex = commandRecorder.getCurrentHistoryIndex();
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

    // Pass validated data to handler
    try {
      const result = await tool.handler(validation.data, extra?.signal);

      if (commandIndex !== null) {
        commandRecorder.attachResult(commandIndex, result);
      }

      // Prepend port failure prefix if any
      if (portCheck.prefix) {
        prependToResponse(result, portCheck.prefix);
        if (portCheck.markAsError) {
          result.isError = true;
        }
      }

      // Prepend breakpoint pause prefix if any (for allowed tools when paused)
      if (breakpointCheck.prefix) {
        prependToResponse(result, breakpointCheck.prefix);
      }

      // Collect status lines to append to response
      const statusItems: StatusLineItem[] = [];


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

      // Append console log status if tool used a connectionReason
      const connectionReason = validation.data?.connectionReason;
      if (connectionReason) {
        const connection = connectionManager.findConnectionByReference(connectionReason);
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

      if (commandIndex !== null) {
        statusItems.push({ label: 'Replay', value: String(commandIndex) });
      }

      const statusSuffix = buildStatusSuffix(statusItems, !statusLegendShown);
      if (statusSuffix) {
        statusLegendShown = true;
        appendToResponse(result, statusSuffix);
      }

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
            connectionReference: connectionReason,
          });
        } else if (dashboardInst.client) {
          // We're a client - report to hub
          dashboardInst.client.reportAction(toolName, connectionReason);
        }
      }

      // Start session verification after first tool use
      // The PID we just appended to the response will be logged by Claude.
      // Now we watch session files and look for that PID to identify our session.
      if (sessionDetectorInstance && !sessionVerifyStarted) {
        sessionVerifyStarted = true;
        sessionDetectorInstance.verify(process.pid);
      }

      return result;
    } catch (error) {
      // Check for ToolError and return its response directly
      if (error instanceof ToolError) {
        return error.response;
      }

      // Check for InvalidReferenceError and return its formatted response
      if (error instanceof InvalidReferenceError) {
        return error.response;
      }

      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : `${error}`,
          },
        ],
        isError: true
      };
    }
  });
}

// Start the server
/**
 * CLI mode: `devharness run <sequenceName> [--connectionReason=X] [--headed] [--keep-chrome]`
 * Runs a saved sequence directly from the shell, no MCP client needed.
 * Pre-launches Chrome itself (headless by default, forceNewInstance) so
 * replay run's own auto-launch (always headed) never triggers.
 */
async function runCliSequence(argv: string[]): Promise<void> {
  const sequenceName = argv[0];
  if (!sequenceName || sequenceName.startsWith('--')) {
    console.error('Usage: devharness run <sequenceName> [--connectionReason=X] [--headed] [--keep-chrome]');
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
  const connectionReason = kv.connectionReason || deriveConnectionReference(sequenceName);

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
    const launchResult = await executeToolCall('launchChrome', {
      reference: connectionReason,
      headless: !headed,
      forceNewInstance: true,
    });
    if (launchResult?.isError) {
      console.error(launchResult.content?.[0]?.text || 'Failed to launch Chrome');
      process.exit(1);
    }

    const runResult = await executeToolCall('replay', {
      action: 'run',
      // Blocking: the CLI's exit code comes from the run result, and the
      // process exits right after - a background run would die mid-flight.
      wait: true,
      name: sequenceName,
      connectionReason,
      killChromeOnFinish: !keepChrome,
      // A CLI run has nobody to answer a prompt, so a parameterised sequence
      // must keep its recorded values. Leaving this undefined made every such
      // sequence exit 1 having executed nothing - a "failure" that is really
      // the run asking a question into a pipe. Same reason runAll passes it.
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
  const mcpStartTime = Date.now();
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
    executeToolCall,
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

  // Announce this session BEFORE the manager decides anything: collection asks
  // whether another live session is working in a server's directory, and a
  // session that has not registered yet is invisible to that question.
  serverClaims.collectDeadSessions();
  await serverClaims.registerSession(process.cwd());

  // Initialize server manager - recover running servers and start auto-run servers.
  // Tool calls queue behind this (see waitForStartupRecovery); release the gate
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

  // Dashboard is initialized in session detection callback after sessionId is known

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

      // closeInactiveConnections() now does the activity re-check and Chrome kill itself
      // (per-connection, before tearing down its monitors, and correctly tagged as
      // 'inactivity' - see ConnectionManager.closeConnection). What's left here is just a
      // backstop for Chrome instances with no tracked connection at all (e.g. launched with
      // autoConnect: false and never connected, or orphaned by some other cleanup path).
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
