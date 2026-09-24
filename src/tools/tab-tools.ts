/**
 * Tab Management Tools
 */

import { z } from 'zod';
import type { ConnectionManager } from '../connection-manager.js';
import { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor } from '../console-monitor.js';
import { NetworkMonitor } from '../network-monitor.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { requireValidReference, sanitizeReference, UNNAMED_CONNECTION } from '../reference-validator.js';
import type { LogpointExecutionTracker } from '../logpoint-execution-tracker.js';
import type { ServerManager } from '../server-manager.js';

// Consolidated schema for tab tools
const tabSchema = z.object({
  action: z.enum(['list', 'create', 'rename', 'switch', 'close']).describe('Tab action: list (list all tabs), create (create new tab), rename (rename tab reference), switch (switch to tab), close (close tab)'),
  // Parameters for create action
  reference: z.string().optional().describe('Tab reference (3 descriptive words) - required for create/rename/switch/close actions'),
  url: z.string().optional().describe('URL to navigate to (for create action)'),
  bringToFront: z.boolean().optional().describe('Select this tab in its window and bring Chrome in front of other apps, which moves keyboard focus to Chrome. Default false: create opens the tab in the background, switch leaves the window order unchanged, and focus stays in the app in front.'),
  // Parameters for rename action
  newReference: z.string().optional().describe('New reference for tab (3 descriptive words) - required for rename action'),
}).strict();

export function createTabTools(
  connectionManager: ConnectionManager,
  sourceMapHandler: SourceMapHandler,
  updateActiveManagers: (connectionId: string) => void,
  logpointTracker: LogpointExecutionTracker,
  serverManager: ServerManager
) {
  return {
    tab: createTool(
      'Manage browser tabs. Actions: list (show all open tabs), create (open new tab with reference), rename (change tab reference), switch (switch active tab), close (close a tab)',
      tabSchema,
      async (args) => {
        const { action } = args;

        // Validate required parameters for each action
        if (action !== 'list' && !args.reference) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'reference',
            message: `The "${action}" action requires a "reference" parameter`
          });
        }
        if (action === 'rename' && !args.newReference) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'rename',
            missing: 'newReference',
            message: 'The "rename" action requires a "newReference" parameter'
          });
        }

        // Handle each action
        switch (action) {
          case 'list': {
            const connections = connectionManager.listConnections();
            const activeId = connectionManager.getActiveConnectionId();

            // Filter to only Chrome connections (tabs)
            const chromeTabs = connections.filter(conn => conn.type === 'chrome');

            if (chromeTabs.length === 0) {
              return createSuccessResponse('TAB_LIST_EMPTY');
            }

            // Validate each connection and remove dead ones
            const aliveTabs: typeof chromeTabs = [];
            for (const conn of chromeTabs) {
              const isAlive = await connectionManager.isConnectionAlive(conn);
              if (isAlive) {
                aliveTabs.push(conn);
              } else {
                // Clean up dead connection
                await connectionManager.removeStaleConnection(conn.id);
              }
            }

            if (aliveTabs.length === 0) {
              return createSuccessResponse('TAB_LIST_EMPTY');
            }

            // Build tab list, active tab first
            const tabLines: string[] = [];

            // Sort so active tab is first
            const sortedTabs = [...aliveTabs].sort((a, b) => {
              if (a.id === activeId) return -1;
              if (b.id === activeId) return 1;
              return 0;
            });

            for (const conn of sortedTabs) {
              const isActive = conn.id === activeId;
              const reference = conn.reference || '(no reference)';

              // Get page info if available
              let url = 'Unknown';
              let title = 'Unknown';
              try {
                if (conn.puppeteerManager?.isConnected()) {
                  const page = conn.puppeteerManager.getPage();
                  url = page.url();
                  title = await page.title();
                }
              } catch (error) {
                // Ignore errors getting page info
              }

              const activeMarker = isActive ? '*' : '-';
              tabLines.push(`${activeMarker} ${reference}: ${title} (${url})`);
            }

            return createSuccessResponse('TAB_LIST_SUCCESS', {
              count: aliveTabs.length,
              tabList: tabLines.join('\n')
            });
          }

          case 'create': {
            // Validate and get sanitized reference (throws if invalid)
            const sanitizedReference = requireValidReference(args.reference!);

            // Check for duplicate reference - use validated lookup to auto-cleanup dead connections
            const existingConnection = await connectionManager.findConnectionByReferenceValidated(sanitizedReference);
            if (existingConnection) {
              return createErrorResponse('REFERENCE_IN_USE', {
                reference: sanitizedReference
              });
            }

            // Find an existing Chrome connection to get the browser
            const connections = connectionManager.listConnections();
            const chromeConnection = connections.find(conn => conn.type === 'chrome' && conn.puppeteerManager?.isConnected());

            if (!chromeConnection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser connected. Use `launchChrome` first to start a browser.'
              });
            }

            try {
              // Create new managers for this tab
              const cdpManager = new CDPManager(sourceMapHandler);
              const puppeteerManager = new PuppeteerManager();
              const consoleMonitor = new ConsoleMonitor();
              const networkMonitor = new NetworkMonitor();

              // Connect Puppeteer to the same browser first
              const host = chromeConnection.host;
              const port = chromeConnection.port;

              await puppeteerManager.connect(host, port);

              // Create new page/tab BEFORE connecting CDP
              const page = await puppeteerManager.newPage();

              // Get the target ID of the new page so we can connect CDP to it specifically
              const target = page.target();
              const targetId = (target as any)._targetId || (target as any)._targetInfo?.targetId;

              // Connect CDPManager to the specific page target
              await cdpManager.connect(host, port, targetId);

              // Set up pause/resume callbacks to control port monitoring
              const portMonitor = serverManager.getPortMonitor();
              cdpManager.setPauseCallback(() => portMonitor.pauseMonitoring());
              cdpManager.setResumeCallback(() => portMonitor.resumeMonitoring());

              // Start monitoring
              consoleMonitor.startMonitoring(page);
              networkMonitor.startMonitoring(page);

              // Register logpoint tracker callback on this connection's console monitor
              consoleMonitor.onMessage((message) => {
                logpointTracker.handleConsoleMessage(message);
              });

              // Navigate if URL provided
              if (args.url) {
                await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
              }

              if (args.bringToFront) {
                await page.bringToFront();
              }

              // Get page index
              const pages = await puppeteerManager.getPages();
              const pageIndex = pages.findIndex(p => p === page);

              // Register connection with reference
              const connectionId = connectionManager.createConnection(
                cdpManager,
                puppeteerManager,
                consoleMonitor,
                networkMonitor,
                host,
                port,
                sanitizedReference,
                pageIndex
              );

              // Switch to this new tab as active
              updateActiveManagers(connectionId);

              const url = page.url();
              const title = await page.title();

              // Get console log stats and update cursor
              const logStats = consoleMonitor.getLogStats();
              let consoleStats: string | undefined;
              if (logStats.totalMessages > 0) {
                const details: string[] = [];
                if (logStats.newErrors > 0) details.push(`${logStats.newErrors} err`);
                if (logStats.newWarnings > 0) details.push(`${logStats.newWarnings} warn`);
                const otherCount = logStats.totalMessages - logStats.newErrors - logStats.newWarnings;
                if (otherCount > 0) details.push(`${otherCount} log`);
                consoleStats = details.join('/');
              }

              return createSuccessResponse('TAB_CREATE_SUCCESS', {
                reference: sanitizedReference,
                title,
                url,
                consoleStats
              });
            } catch (error) {
              return createErrorResponse('TAB_CREATE_FAILED', {
                error: `${error}`
              });
            }
          }

          case 'rename': {
            // Validate and get sanitized new reference (throws if invalid)
            const newSanitized = requireValidReference(args.newReference!);

            // Check if new reference is already in use - use validated lookup to auto-cleanup dead connections
            const existingWithNewRef = await connectionManager.findConnectionByReferenceValidated(newSanitized);
            if (existingWithNewRef) {
              return createErrorResponse('REFERENCE_IN_USE', {
                reference: newSanitized
              });
            }

            // Find connection by reference (sanitize input)
            const sanitizedOldRef = sanitizeReference(args.reference!);
            const connection = await connectionManager.findConnectionByReferenceValidated(sanitizedOldRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const success = connectionManager.updateReference(connection.id, newSanitized);

            if (success) {
              return createSuccessResponse('TAB_RENAME_SUCCESS', {
                oldReference: args.reference,
                newReference: args.newReference
              });
            } else {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }
          }

          case 'switch': {
            // Find connection by reference (sanitize input) - validate to auto-cleanup dead connections
            const sanitizedRef = sanitizeReference(args.reference!);
            const connection = await connectionManager.findConnectionByReferenceValidated(sanitizedRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const success = connectionManager.setActiveConnection(connection.id);

            if (success) {
              updateActiveManagers(connection.id);

              // Sync Puppeteer page reference to match the connection's page index
              if (connection?.puppeteerManager?.isConnected() && connection.pageIndex !== undefined) {
                try {
                  await connection.puppeteerManager.setPage(connection.pageIndex);
                } catch (error) {
                  // Ignore errors - page might not exist
                }
              }

              if (args.bringToFront && connection?.puppeteerManager?.isConnected()) {
                await connection.puppeteerManager.getPage().bringToFront();
              }

              // Get current page info
              let url = 'Unknown';
              let title = 'Unknown';
              const reference = connection?.reference || UNNAMED_CONNECTION;

              if (connection?.puppeteerManager?.isConnected()) {
                try {
                  const page = connection.puppeteerManager.getPage();
                  url = page.url();
                  title = await page.title();
                } catch (error) {
                  // Ignore errors
                }
              }

              return createSuccessResponse('TAB_SWITCH_SUCCESS', {
                reference,
                url,
                title
              });
            } else {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }
          }

          case 'close': {
            // Find connection by reference (sanitize input) - validate to auto-cleanup dead connections
            const sanitizedRef = sanitizeReference(args.reference!);
            const connection = await connectionManager.findConnectionByReferenceValidated(sanitizedRef);

            if (!connection) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                reference: args.reference
              });
            }

            const reference = connection.reference || UNNAMED_CONNECTION;
            const success = await connectionManager.closeConnection(connection.id);

            if (success) {
              // Get info about new active tab
              const newActiveId = connectionManager.getActiveConnectionId();
              const newActive = newActiveId ? connectionManager.getConnection(newActiveId) : null;
              const newActiveReference = newActive?.reference || UNNAMED_CONNECTION;

              return createSuccessResponse('TAB_CLOSE_SUCCESS', {
                closedReference: reference,
                newActiveReference
              });
            } else {
              return createErrorResponse('TAB_CLOSE_FAILED', {
                reference: args.reference
              });
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
