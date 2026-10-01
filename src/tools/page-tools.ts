/**
 * Page Navigation Tools
 */

import { z } from 'zod';
import { ConsoleMonitor } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import { executeWithPauseDetection, type ActionResult } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { autoLaunchChrome } from './replay-executor.js';
import type { ClickableCache } from '../clickable-cache.js';
import { collectInteractiveElements } from '../element-collector.js';
import type { ExecuteToolCall } from '../types.js';
import { raceAbort, throwIfAborted } from '../utils/abort.js';

// =============================================================================
// Types
// =============================================================================

export interface PageContext {
  url: string;
  title: string;
  clickableElements: {
    total: number;
    inViewport: number;
  };
  console: {
    errors: number;
    warnings: number;
    total: number;
  };
  network: {
    failed: number;
    total: number;
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gather page context including console errors and failed network requests
 */
export async function gatherPageContext(
  page: any,
  consoleMonitor: ConsoleMonitor,
  networkMonitor: NetworkMonitor,
  clickableCache: ClickableCache
): Promise<PageContext> {
  const url = page.url();
  const title = await page.title();

  // Get clickable elements stats
  const result = await collectInteractiveElements(page);
  clickableCache.set(url, result.elements, result.viewportHeight, result.viewportWidth);
  const inViewportCount = result.elements.filter((el) => el.inViewport).length;

  // Get console stats
  const consoleErrors = consoleMonitor.getCount('error');
  const consoleWarnings = consoleMonitor.getCount('warning');
  const consoleTotal = consoleMonitor.getCount();

  // Get network stats
  const allRequests = networkMonitor.getRequests();
  const failedRequests = allRequests.filter(r =>
    r.failed || (r.response && r.response.status >= 400)
  ).length;

  return {
    url,
    title,
    clickableElements: {
      total: result.elements.length,
      inViewport: inViewportCount,
    },
    console: {
      errors: consoleErrors,
      warnings: consoleWarnings,
      total: consoleTotal,
    },
    network: {
      failed: failedRequests,
      total: allRequests.length,
    },
  };
}

/**
 * Format page context for response. Each hint names `connection`,
 * since a call that acts on a connection without naming one is refused.
 */
export function formatPageContextForResponse(context: PageContext, connection: string): Record<string, any> {
  const on = `connection: '${connection}'`;
  const response: Record<string, any> = {
    url: context.url,
    title: context.title,
    clickableElements: {
      total: context.clickableElements.total,
      inViewport: context.clickableElements.inViewport,
      hint: `Use content({ action: 'findInteractive', ${on} }) to explore interactive elements`,
    },
  };

  // Add console status if there are errors or warnings
  if (context.console.errors > 0 || context.console.warnings > 0) {
    response.console = {
      errors: context.console.errors,
      warnings: context.console.warnings,
      hint: context.console.errors > 0
        ? `Use console({ action: 'list', ${on}, type: 'error' }) to view errors`
        : undefined,
    };
  }

  // Add network status if there are failed requests
  if (context.network.failed > 0) {
    response.network = {
      failed: context.network.failed,
      total: context.network.total,
      hint: `Use network({ action: 'list', ${on} }) to see each request with its status or failure`,
    };
  }

  return response;
}

/**
 * A navigation that stopped at a breakpoint or threw, answered as that;
 * undefined when it returned the page. Answered as success, a navigation to
 * an unreachable host read as having arrived.
 */
function navigationOutcome(result: ActionResult<unknown>, action: string, target: string): any | undefined {
  if (result.pausedAtBreakpoint && result.success) {
    return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', { action, selector: target, ...result.pauseInfo });
  }
  if (!result.success) {
    return createErrorResponse('NAVIGATION_FAILED', { message: result.error ?? `${action} failed` });
  }
  return undefined;
}

// Consolidated schema for page navigation tools
const navigateSchema = z.object({
  action: z.enum(['goto', 'reload', 'back', 'forward', 'info']),
  connection: z.string().describe('The connection, by the name connection launch or attach gave it'),
  // Parameters for goto action
  url: z.string().optional().describe('URL to navigate to (required for goto action)'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional().describe('goto/reload: when navigation counts as complete (default load)'),
  // Parameters for reload action
  ignoreCache: z.boolean().optional().describe('reload: clear the cache first (default false)'),
  timeout: z.number().optional().describe('reload: max wait ms (default 30000)'),
}).strict();

export function createPageTools(
  resolveConnectionByName: (connection: string) => Promise<any>,
  clickableCache: ClickableCache,
  executeToolCall?: ExecuteToolCall
) {
  /**
   * Auto-restart console and network monitoring after navigation
   */
  const restartMonitoring = (page: any, monitor: ConsoleMonitor, netMonitor: NetworkMonitor) => {
    if (monitor.isActive()) {
      monitor.startMonitoring(page);
    }
    if (netMonitor.isActive()) {
      netMonitor.startMonitoring(page);
    }
  };


  return {
    navigate: createTool(
      'Navigate and control browser pages. Actions: goto (navigate to URL), reload (reload page), back (navigate back), forward (navigate forward), info (get page information)',
      navigateSchema,
      // abortSignal (#110): a cancelled navigation STOPS WAITING only (D4).
      // We deliberately do NOT call Page.stopLoading - a half-loaded page
      // that later steps act on is worse than a fully loaded one - so on
      // abort the handler throws promptly while the page keeps loading in
      // the background.
      async (args, abortSignal?: AbortSignal) => {
        const { action, connection } = args;

        throwIfAborted(abortSignal);

        // Validate required parameters for each action
        if (action === 'goto' && !args.url) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'goto',
            missing: 'url',
            message: 'The "goto" action requires a "url" parameter'
          });
        }

        // Resolve connection from reason
        let resolved = await resolveConnectionByName(connection);

        // Auto-launch Chrome for 'goto' action if no connection found
        if (!resolved && action === 'goto' && executeToolCall) {
          const launchResult = await autoLaunchChrome(executeToolCall, connection, 'navigate.goto');
          if (!launchResult.success) {
            return createErrorResponse(launchResult.errorType, {
              reference: connection,
              error: launchResult.error
            });
          }
          // Try resolving again after launch
          resolved = await resolveConnectionByName(connection);
        }

        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Start one with `connection` action `launch`.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetConsoleMonitor = resolved.consoleMonitor;
        const targetNetworkMonitor = resolved.networkMonitor;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, `navigate.${action}`, resolved.connection.port);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        // Resolving the connection can itself launch Chrome (seconds) - don't
        // start navigating if the user cancelled while that happened.
        throwIfAborted(abortSignal);

        // Handle each action
        switch (action) {
          case 'goto': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // raceAbort = stop waiting on cancel; the navigation itself
                // continues in the browser (no Page.stopLoading - see above).
                await raceAbort(page.goto(args.url!, { waitUntil: args.waitUntil ?? 'load' }), abortSignal);

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'navigateTo'
            );

            const stopped = navigationOutcome(result, 'navigate goto', args.url!);
            if (stopped) return stopped;
            if (!result.result) {
              return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', { url: args.url });
            }

            return createSuccessResponse('PAGE_NAVIGATE_SUCCESS', formatPageContextForResponse(result.result, connection));
          }

          case 'reload': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Clear cache before reload if requested
                if (args.ignoreCache) {
                  const client = await page.createCDPSession();
                  await client.send('Network.clearBrowserCache');
                }

                // Reload with specified waitUntil condition and timeout
                // (raceAbort: cancel stops waiting; the reload continues)
                await raceAbort(page.reload({
                  waitUntil: args.waitUntil ?? 'load',
                  timeout: args.timeout ?? 30000
                }), abortSignal);

                // Auto-restart monitoring after reload
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'reloadPage'
            );

            const stopped = navigationOutcome(result, 'navigate reload', page.url());
            if (stopped) return stopped;
            if (!result.result) {
              return createSuccessResponse('PAGE_RELOAD_SUCCESS');
            }

            return createSuccessResponse('PAGE_RELOAD_SUCCESS', formatPageContextForResponse(result.result, connection));
          }

          case 'back': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await raceAbort(page.goBack({ waitUntil: 'load' }), abortSignal);

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'goBack'
            );

            const stopped = navigationOutcome(result, 'navigate back', page.url());
            if (stopped) return stopped;
            if (!result.result) {
              return createSuccessResponse('PAGE_GO_BACK_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_BACK_SUCCESS', formatPageContextForResponse(result.result, connection));
          }

          case 'forward': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                await raceAbort(page.goForward({ waitUntil: 'load' }), abortSignal);

                // Auto-restart monitoring after navigation
                restartMonitoring(page, targetConsoleMonitor, targetNetworkMonitor);

                // Gather full page context
                return gatherPageContext(page, targetConsoleMonitor, targetNetworkMonitor, clickableCache);
              },
              'goForward'
            );

            const stopped = navigationOutcome(result, 'navigate forward', page.url());
            if (stopped) return stopped;
            if (!result.result) {
              return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS');
            }

            return createSuccessResponse('PAGE_GO_FORWARD_SUCCESS', formatPageContextForResponse(result.result, connection));
          }

          case 'info': {
            // A paused page still has its address, which needs no page JS;
            // the title does, and a paused page never answers it. Reported as
            // not loaded, a paused page read as a dead connection, and a
            // replay then tried to launch a second browser under its name.
            if (targetCdpManager.isPaused()) {
              const url = page.url();
              const response = createSuccessResponse('PAGE_INFO_PAUSED', { url });
              response._meta = {
                tool: 'navigate',
                action: 'info',
                timestamp: Date.now(),
                navigate: { url, action: 'info', paused: true },
              };
              return response;
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const url = page.url();
                const title = await page.title();
                const viewport = page.viewport();
                return { url, title, viewport };
              },
              'getPageInfo'
            );

            if (!result.result) {
              return createErrorResponse('PAGE_NOT_LOADED', { toolName: 'navigate.info' });
            }

            const pageInfo = result.result;
            const response = createSuccessResponse('PAGE_INFO_SUCCESS', {
              url: pageInfo.url,
              title: pageInfo.title
            });

            // Add structured metadata for programmatic use
            response._meta = {
              tool: 'navigate',
              action: 'info',
              timestamp: Date.now(),
              navigate: {
                url: pageInfo.url,
                title: pageInfo.title,
                action: 'info',
              },
            };

            return response;
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
