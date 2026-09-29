/**
 * Connection tools: launching and attaching to Chrome or a Node.js debugger,
 * listing, switching and closing connections, and the launcher's own state.
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
import { debugLog, enableDebugLogging, disableDebugLogging, isDebugEnabled } from '../debug-logger.js';
import { validateReference, requireValidReference, UNNAMED_CONNECTION } from '../reference-validator.js';
import { startProxyFor } from '../proxy/registry.js';
import { sizeWindowToViewport } from '../window-sizing.js';
import type { ToolResponseMeta, PausedAtMeta } from '../tool-response.js';

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
    const original = await sourceMapHandler.mapToOriginal(top.url, top.location.lineNumber, top.location.columnNumber)
      .catch(() => null);
    return {
      url: original?.source ?? top.url,
      lineNumber: original?.line ?? top.location.lineNumber,
      ...((original?.column ?? top.location.columnNumber) !== undefined
        ? { columnNumber: original?.column ?? top.location.columnNumber } : {}),
      functionName: top.functionName,
      callFrameId: top.callFrameId,
    };
  }

  return {
    launchChrome: createTool(
      'Launch Chrome with debugging',
      z.object({
        url: z.string().optional().describe('URL to open (default: blank page)'),
        autoConnect: z.boolean().optional().default(true).describe('Automatically connect debugger after launch'),
        port: z.number().optional().describe('The debugging port (optional, defaults to this session\'s reserved port). Use this to launch multiple Chrome instances on different ports. Always honoured when given - with forceNewInstance the call errors if that exact port is already taken instead of moving to another port.'),
        forceNewInstance: z.boolean().optional().describe('Always spawn a fresh Chrome process instead of reusing/tabbing into an existing instance. Without `port`, a free port is chosen automatically; with `port`, that port is used and the call errors if it is already in use. Errors if `reference` is already bound to a live connection.'),
        bringToFront: z.boolean().optional().describe('Select this tab in its window and bring Chrome in front of other apps, which moves keyboard focus to Chrome. Default false: the tab opens in the background and focus stays in the app in front.'),
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
            activateConnection(existingConnection.id);

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
            // Registered under the sanitized reference, which is what every other
            // tool addresses the connection by. Under the raw one, the reference
            // launchChrome tells the caller to use resolved to no proxy.
            const proxyKey = userReference
              ? validateReference(userReference).sanitized!
              : `port-${port}`;
            const proxyArgs = args.proxy
              ? (await startProxyFor(proxyKey, url)).chromeArgs
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
            logpointTracker.handleConsoleMessage(message, cdpManager);
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

        const response: any = createSuccessResponse('CONNECTION_STATUS', {}, statusData);
        response._meta = {
          tool: 'getDebuggerStatus',
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

        const response: any = createSuccessResponse('CONNECTIONS_LIST', {
          totalConnections: connections.length.toString()
        }, {
          activeReference,
          connections: connectionList,
        });
        response._meta = {
          tool: 'listConnections',
          timestamp: Date.now(),
          connections: connectionList.map(({ createdAt: _createdAt, ...connection }) => connection),
        } satisfies ToolResponseMeta;
        return response;
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
          activateConnection(connection.id);
          return createSuccessResponse('CONNECTION_SWITCH_SUCCESS', { reference: args.reference });
        } else {
          return createErrorResponse('CONNECTION_SWITCH_FAILED', { reference: args.reference });
        }
      }
    ),

  };
}
