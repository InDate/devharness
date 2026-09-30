/**
 * `connection` launches, attaches to, lists, switches, renames and closes
 * debugger connections; `browser` kills the Chrome processes behind them and
 * resets the launcher, kept apart so allowing `connection` allows no kill.
 */

import { z } from 'zod';
import { createServer } from 'net';
import { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import type { ConnectionManager } from '../connection-manager.js';
import type { SourceMapHandler } from '../sourcemap-handler.js';
import type { LogpointExecutionTracker } from '../logpoint-execution-tracker.js';
import type { PortReserver } from '../port-reserver.js';
import type { ServerManager } from '../server-manager.js';
import { detectAutoRestartCommand } from '../server-manager.js';
import { ChromeLauncher, ChromeBinaryAbsentError, ChromeLaunchFailure, InvalidProfileNameError, ProfileInUseError, ProfileLockedError, normalizeProfileName, resolveLaunchPort, decideProfileReuse } from '../chrome-launcher.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { configManager } from '../config.js';
import { debugLog } from '../debug-logger.js';
import { validateReference, requireValidReference, sanitizeReference, UNNAMED_CONNECTION } from '../reference-validator.js';
import { startProxyFor, shareProxy, getProxy } from '../proxy/registry.js';
import { sizeWindowToViewport } from '../window-sizing.js';
import type { ToolResponseMeta, PausedAtMeta } from '../tool-response.js';

/**
 * Whether a debugger answers on `port`: Chrome and a Node.js inspector both
 * serve /json/version. False when the port reserver holds it (it answers
 * "chrome-not-running") or nothing answers within a second.
 */
async function isDebuggerListening(port: number): Promise<boolean> {
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
 * Stamp a launch response with who owns the resulting connection.
 *
 * The text of a launch response does not show whether the run CREATED a
 * browser or was handed one that already existed, and guessing either way is
 * destructive: kill
 * a borrowed browser and the user loses state they cannot recover, keep an
 * owned one and every run leaks a process (issue #103).
 */
function withLaunchMeta(response: any, name: string, reused: boolean): any {
  response._meta = { ...(response._meta || {}), tool: 'connection', action: 'launch', launch: { name, reused } };
  return response;
}

/**
 * Register `reference` against the proxy another tab of the Chrome on `port`
 * runs through: its launching name, or `port-<port>` for a launch that named
 * none. Every tab of that browser sends its traffic through that one proxy.
 */
export function shareBrowserProxy(
  connections: Array<{ port: number; reference?: string }>,
  port: number,
  reference: string
): void {
  if (getProxy(reference)) return;
  const holders = [
    `port-${port}`,
    ...connections.filter(c => c.port === port && c.reference && c.reference !== reference).map(c => c.reference!),
  ];
  for (const holder of holders) {
    if (shareProxy(holder, reference)) return;
  }
}

const connectionSchema = z.object({
  action: z.enum(['launch', 'attach', 'list', 'switch', 'rename', 'close', 'status', 'browsers']),
  name: z.string().optional().describe('launch/attach: the name later calls address this connection by, as connectionReason (3 descriptive words; launch defaults to "unnamed-connection-default"). rename: the new name'),
  connectionReason: z.string().optional().describe('switch/rename/close/status: the connection to act on'),
  reason: z.string().optional().describe('close: why the connection is closed'),
  url: z.string().optional().describe('launch: URL to open (default: blank page)'),
  port: z.number().optional().describe('launch: the debugging port (default: this session\'s reserved port); a port that already has a Chrome opens a tab in it. Always honoured when given - with forceNewInstance the call errors if that exact port is already taken. attach: the debugger port (default: the reserved port; Node.js is usually 9229)'),
  host: z.string().optional().describe('attach: the debugger host (default: localhost)'),
  autoConnect: z.boolean().optional().describe('launch: connect the debugger after launch (default: true)'),
  forceNewInstance: z.boolean().optional().describe('launch: always spawn a fresh Chrome process instead of reusing or tabbing into an existing one. Without `port`, a free port is chosen; with `port`, the call errors if it is in use. Errors if `name` is already bound to a live connection.'),
  bringToFront: z.boolean().optional().describe('launch/switch: select this tab and bring Chrome in front of other apps, which moves keyboard focus to Chrome (default: false)'),
  headless: z.boolean().optional().describe('launch: no visible window (default: false)'),
  width: z.number().optional().describe('launch: viewport width in CSS px. Sizes the real OS window, so the page keeps tracking window resizes; larger than the display is clamped and reported. Headless emulates instead.'),
  height: z.number().optional().describe('launch: viewport height in CSS px, sized like `width`'),
  profile: z.string().optional().describe('launch: named persistent Chrome profile, e.g. "device-a". It maps to a stable user-data-dir under ~/.devharness/profiles (per project with chrome.persistentProfileRoot) and is never deleted, so cookies, localStorage and IndexedDB survive across runs. Created on first use; does not pin a port. Wipe it with config({action:"resetProfile", profile:"device-a"}). One live Chrome per profile.'),
  proxy: z.boolean().optional().describe('launch: route this browser through an intercepting proxy, so a response or a socket frame can be held and served in its place. Off by default: Chrome shows its unsupported-flag banner and HTTP/1.1 is forced.'),
  chromeArgs: z.array(z.string()).optional().describe('launch: extra Chrome command-line flags, merged after the managed defaults. The CDP_TOOLS_EXTRA_CHROME_ARGS env var (space-separated) is always merged too. Ignored when an existing Chrome on the port is reused.'),
}).strict();

type ConnectionArgs = z.infer<typeof connectionSchema>;

const browserSchema = z.object({
  action: z.enum(['kill', 'resetLauncher']),
  reason: z.string().describe('Why the browser is killed or the launcher reset'),
  port: z.number().optional().describe('kill: the Chrome to kill (default: every Chrome this session launched)'),
}).strict();

type BrowserArgs = z.infer<typeof browserSchema>;

export interface ConnectionToolDeps {
  chromeLauncher: ChromeLauncher;
  connectionManager: ConnectionManager;
  portReserver: PortReserver;
  serverManager: ServerManager;
  sourceMapHandler: SourceMapHandler;
  logpointTracker: LogpointExecutionTracker;
  activateConnection: (connectionId: string) => void;
  findAvailablePort: (startPort: number) => Promise<number>;
}

export function createConnectionTools(deps: ConnectionToolDeps) {
  const {
    chromeLauncher, connectionManager, portReserver, serverManager,
    sourceMapHandler, logpointTracker, activateConnection, findAvailablePort,
  } = deps;

  /**
   * The top frame of a paused debugger, mapped to its original source the way
   * `inspect getCallStack` maps it, so a breakpoint a sequence set by source line
   * matches the place it paused. Undefined when the pause carries no frames.
   */
  async function pausedAtOf(cdpManager: CDPManager): Promise<PausedAtMeta | undefined> {
    const top = cdpManager.getCallStack()?.[0];
    if (!top) return undefined;
    // Chrome's frame lines are 0-based; source map lines are 1-based.
    const original = await sourceMapHandler.mapToOriginal(top.url, top.location.lineNumber + 1, top.location.columnNumber)
      .catch(() => null);
    // 1-based, as a breakpoint's line and column are. Source map lines are
    // 1-based already; its columns, and Chrome's lines and columns, are 0-based.
    const column = original ? original.column + 1 : (top.location.columnNumber !== undefined ? top.location.columnNumber + 1 : undefined);
    return {
      url: original?.source ?? top.url,
      lineNumber: original?.line ?? top.location.lineNumber + 1,
      ...(column !== undefined ? { columnNumber: column } : {}),
      functionName: top.functionName,
      callFrameId: top.callFrameId,
    };
  }

  const launch = async (args: ConnectionArgs): Promise<any> => {
      // Validate the name FIRST, before launching Chrome
      const userReference = args.name;
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
        // down (profileGate), where this call is known to have to spawn a
        // second Chrome. Checking here broke the standard idempotent call pattern
        // `connection({ action: 'launch', profile, name })`: re-calling it to make sure
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
          await debugLog('index', `launch: profile "${profileName}" already held by Chrome on port ${decision.port}`);
          return createErrorResponse('CHROME_PROFILE_IN_USE', {
            profile: profileName,
            port: decision.port.toString(),
          });
        }
        if (decision.decision === 'mismatch') {
          await debugLog('index', `launch: port ${decision.port} already runs profile ${decision.actualProfile ?? 'unknown'}, not "${profileName}"`);
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
        await debugLog('index', `launch: forceNewInstance requested port ${decision.port} but it is already in use`);
        return createErrorResponse('CHROME_FORCED_PORT_IN_USE', { port: decision.port.toString() });
      }
      // A named profile is an identity, and the Chrome already holding it IS
      // that identity - so go to its port rather than the session's reserved
      // one. Without this, a launch with `profile` for a profile that is up
      // under some other reference resolves to a free port, finds nothing
      // there, and refuses to spawn because the profile is held elsewhere:
      // "already running" reported as a conflict. An explicit port or
      // forceNewInstance is a deliberate override and still wins.
      const profileHolderPort = profileName && !args.port && !args.forceNewInstance
        ? chromeLauncher.findPortForProfile(profileName)
        : undefined;
      const port = profileHolderPort ?? decision.port;
      await debugLog('index', `launch called: port=${port}, requested=${args.port}, reserved=${configManager.getCurrentPort()}, profileHolder=${profileHolderPort ?? 'none'}, forceNewInstance=${args.forceNewInstance}, url=${args.url}, autoConnect=${args.autoConnect}, name=${args.name}`);
      const url = args.url;
      const autoConnect = args.autoConnect ?? true;

      // A live connection under this name is reused rather than a new tab opened
      // Use validated lookup to auto-cleanup dead connections (e.g., if Chrome was killed externally)
      // Under forceNewInstance we still run this lookup, but a live match is an
      // error rather than a reuse: a fresh process bound to an already-bound
      // reference would leave two Chromes answering to the same name (bug-005).
      if (userReference) {
        const existingConnection = await connectionManager.findConnectionByReferenceValidated(userReference);
        if (existingConnection) {
          const sanitizedRef = validateReference(userReference).sanitized!;

          if (args.forceNewInstance) {
            await debugLog('index', `launch: forceNewInstance with name "${sanitizedRef}" already bound to a live connection - refusing to double-bind`);
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

          activateConnection(existingConnection.id);
          const page = await pageOf(existingConnection);
          const title = page?.title ?? 'Unknown';
          const pageUrl = page?.url ?? 'about:blank';

          // `reused: true` separates a browser a replay run BORROWED from one
          // it created: the reference already existed, so it belongs to
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
          // Registered under the sanitized reference, which is what every other
          // tool addresses the connection by. Under the raw one, the reference
          // the launch tells the caller to use resolved to no proxy.
          const proxyKey = userReference
            ? validateReference(userReference).sanitized!
            : `port-${port}`;
          const proxyArgs = args.proxy
            ? (await startProxyFor(proxyKey, url)).chromeArgs
            : [];
          const result = await chromeLauncher.launch(port, launchUrl, portReserver, args.headless ?? false, [...proxyArgs, ...(args.chromeArgs ?? [])], profileName);
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

            // In a browser that already runs, Puppeteer connects first and opens a
            // new tab, which gives CDP a target to connect to even when every
            // earlier tab was closed
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
                logpointTracker.handleConsoleMessage(message, cdpManager);
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

              if (args.bringToFront) {
                await page.bringToFront();
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

            // Registered under the name given, validated at the start of the
            // handler, or under the default
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
            shareBrowserProxy(connectionManager.listConnections(), port, connectionReference);

            activateConnection(connectionId);

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
              suggestion: 'Chrome launched but auto-connect failed. Try connecting with `connection` action `attach`.'
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
            tool: 'connection',
            action: 'launch',
            timestamp: Date.now(),
            launchObservations: o,
          };
          return response;
        }
        return createErrorResponse('CHROME_SPAWN_FAILED', { error: `${error}` });
      }
  };

  const attach = async (args: ConnectionArgs): Promise<any> => {
      // The name in its stored form; throws when it is not three words
      const reference = requireValidReference(args.name!);

      // A name held by a live connection is refused; one held by a dead connection is freed by the lookup
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

      await debugLog('index', `attach called: host=${host}, port=${port}, defaultPort=${defaultPort}`);

      try {
        await debugLog('index', `Checking for a debugger on port ${port}...`);
        const isRunning = await isDebuggerListening(port);
        await debugLog('index', `debugger listening on port ${port}: ${isRunning}`);

        if (!isRunning) {
          // Provide clear error message based on port type
          if (isDefaultPort && host === 'localhost') {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `Chrome is not running on port ${port}. Start Chrome with \`connection({ action: 'launch' })\` first.`
            });
          } else {
            return createErrorResponse('DEBUGGER_NOT_RUNNING', {
              port: port.toString(),
              message: `No debugger found on ${host}:${port}. For Chrome, use \`connection({ action: 'launch', port: ${port} })\`. For Node.js, start with \`node --inspect=${port} app.js\``
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
          logpointTracker.handleConsoleMessage(message, cdpManager);
        });

        // Get page index for tracking
        let pageIndex: number | undefined;
        if (runtimeType === 'chrome') {
          const pages = await puppeteerManager.getPages();
          const currentPage = puppeteerManager.getPage();
          pageIndex = pages.findIndex(p => p === currentPage);
        }

        // The console monitor is passed for both runtimes: Chrome's reads the page
        // through Puppeteer, Node's reads Runtime.consoleAPICalled over CDP
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
        if (runtimeType === 'chrome') shareBrowserProxy(connectionManager.listConnections(), port, reference);

        activateConnection(connectionId);

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
  };

  const status = async (args: ConnectionArgs): Promise<any> => {
      // Find connection by reference
      const connection = connectionManager.findConnectionByReference(args.connectionReason!);

      if (!connection) {
        return createErrorResponse('CONNECTION_NOT_FOUND', {
          reference: args.connectionReason!
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

      const response: any = createSuccessResponse('CONNECTION_STATUS', {}, statusData);
      response._meta = {
        tool: 'connection',
        action: 'status',
        timestamp: Date.now(),
        debugger: {
          reference: statusData.reference,
          connected,
          paused,
          totalBreakpoints: breakpointCounts.total,
          ...(paused ? { pausedAt: await pausedAtOf(cdpManager) } : {}),
        },
      } satisfies ToolResponseMeta;
      return response;
  };

  /**
   * The page a connection drives, or undefined for one without a page (a
   * Node.js target) or mid-navigation. `page.title()` waits while the debugger
   * is paused, so a paused connection reports its URL alone.
   */
  const pageOf = async (conn: ReturnType<ConnectionManager['listConnections']>[number]): Promise<{ url: string; title?: string } | undefined> => {
    if (!conn.puppeteerManager?.isConnected()) return undefined;
    try {
      const page = conn.puppeteerManager.getPage();
      if (conn.cdpManager.isPaused()) return { url: page.url() };
      return { url: page.url(), title: await page.title() };
    } catch {
      return undefined;
    }
  };

  const list = async (): Promise<any> => {
      const all = connectionManager.listConnections();
      const alive = await Promise.all(all.map(conn => connectionManager.isConnectionAlive(conn)));
      const live = all.filter((_, i) => alive[i]);
      for (const conn of all.filter((_, i) => !alive[i])) {
        await connectionManager.removeStaleConnection(conn.id);
      }
      const activeId = connectionManager.getActiveConnectionId();
      const activeConnection = activeId ? connectionManager.getConnection(activeId) : null;
      const activeReference = activeConnection?.reference || UNNAMED_CONNECTION;

      const connectionList = await Promise.all(live.map(async conn => ({
        reference: conn.reference || UNNAMED_CONNECTION,
        type: conn.type,
        host: conn.host,
        port: conn.port,
        active: conn.id === activeId,
        connected: conn.cdpManager.isConnected(),
        paused: conn.cdpManager.isPaused(),
        ...(await pageOf(conn)),
        createdAt: new Date(conn.createdAt).toISOString(),
      })));

      const response: any = createSuccessResponse('CONNECTIONS_LIST', {
        totalConnections: live.length.toString()
      }, {
        activeReference,
        connections: connectionList,
      });
      response._meta = {
        tool: 'connection',
        action: 'list',
        timestamp: Date.now(),
        connections: connectionList.map(({ createdAt: _createdAt, ...connection }) => connection),
      } satisfies ToolResponseMeta;
      return response;
  };

  const browsers = async (): Promise<any> => {
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
  };

  const kill = async (args: BrowserArgs): Promise<any> => {
      try {
        const port = args.port;
        await debugLog('index', `browser kill - reason: ${args.reason}, port: ${port ?? 'all'}`);

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
  };

  const resetLauncher = async (args: BrowserArgs): Promise<any> => {
      // Log the reason for audit purposes
      console.error(`[devharness] browser resetLauncher - Reason: ${args.reason}`);
      chromeLauncher.reset();
      return createSuccessResponse('CHROME_LAUNCHER_RESET');
  };

  /** The live connection `connectionReason` names; a dead one is removed and reads as absent. */
  const addressed = (args: ConnectionArgs) =>
    connectionManager.findConnectionByReferenceValidated(sanitizeReference(args.connectionReason!));

  const switchTo = async (args: ConnectionArgs): Promise<any> => {
    const connection = await addressed(args);
    if (!connection) {
      return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connectionReason });
    }
    activateConnection(connection.id);

    // Puppeteer holds one selected page per browser; later calls reach the connection's own.
    if (connection.puppeteerManager?.isConnected() && connection.pageIndex !== undefined) {
      try {
        await connection.puppeteerManager.setPage(connection.pageIndex);
      } catch {
        // A page that no longer exists leaves the current one selected.
      }
    }
    if (args.bringToFront && connection.puppeteerManager?.isConnected()) {
      await connection.puppeteerManager.getPage().bringToFront();
    }

    const page = await pageOf(connection);
    return createSuccessResponse('CONNECTION_SWITCHED', {
      reference: connection.reference || UNNAMED_CONNECTION,
      url: page?.url ?? 'Unknown',
      title: page?.title ?? (connection.cdpManager.isPaused() ? 'unread while paused' : 'Unknown'),
    });
  };

  const rename = async (args: ConnectionArgs): Promise<any> => {
    const newName = requireValidReference(args.name!);
    if (await connectionManager.findConnectionByReferenceValidated(newName)) {
      return createErrorResponse('REFERENCE_IN_USE', { reference: newName });
    }
    const connection = await addressed(args);
    if (!connection || !connectionManager.updateReference(connection.id, newName)) {
      return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connectionReason });
    }
    return createSuccessResponse('CONNECTION_RENAMED', {
      oldName: args.connectionReason,
      newName,
    });
  };

  const close = async (args: ConnectionArgs): Promise<any> => {
    console.error(`[devharness] connection close - Reason: ${args.reason}, Connection: ${args.connectionReason}`);
    const connection = await addressed(args);
    if (!connection) {
      return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connectionReason });
    }
    const reference = connection.reference || UNNAMED_CONNECTION;
    if (!(await connectionManager.closeConnection(connection.id))) {
      return createErrorResponse('CONNECTION_CLOSE_FAILED', { reference });
    }
    return createSuccessResponse('CONNECTION_CLOSED', {
      reference,
      newActiveReference: connectionManager.getConnection()?.reference || 'none',
    });
  };

  /** Parameters each action cannot run without, checked before it runs. */
  const REQUIRED: Record<ConnectionArgs['action'], Array<keyof ConnectionArgs>> = {
    launch: [],
    attach: ['name'],
    list: [],
    switch: ['connectionReason'],
    rename: ['connectionReason', 'name'],
    close: ['connectionReason', 'reason'],
    status: ['connectionReason'],
    browsers: [],
  };

  return {
    connection: createTool(
      'Launch, attach to, list, switch, rename and close debugger connections. Actions: launch (start Chrome, or open a tab in the Chrome already on `port`, and connect), attach (connect to a running Chrome or Node.js debugger), list (every connection, with its page), switch (make a connection active and select its page), rename, close (the last connection to a Chrome kills that Chrome), status (one connection\'s debugger state), browsers (the Chrome processes this session launched)',
      connectionSchema,
      async (args) => {
        const missing = REQUIRED[args.action].filter(key => args[key] === undefined);
        if (missing.length > 0) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: args.action,
            missing: missing.join(', '),
            message: `The "${args.action}" action requires ${missing.map(key => `"${String(key)}"`).join(' and ')}`,
          });
        }
        switch (args.action) {
          case 'launch': return launch(args);
          case 'attach': return attach(args);
          case 'list': return list();
          case 'switch': return switchTo(args);
          case 'rename': return rename(args);
          case 'close': return close(args);
          case 'status': return status(args);
          case 'browsers': return browsers();
        }
      }
    ),

    browser: createTool(
      'The Chrome processes this session launched. Actions: kill (end a Chrome process and every connection in it; every one this session launched when no port is given), resetLauncher (forget every Chrome this session launched)',
      browserSchema,
      async (args) => (args.action === 'kill' ? kill(args) : resetLauncher(args))
    ),
  };
}
