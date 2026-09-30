/**
 * Execution Control Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { ConnectionManager } from '../connection-manager.js';
import { hold, isHeld, release } from '../hold.js';

// Consolidated schema with action parameter
const executionSchema = z.object({
  action: z.enum(['pause', 'resume', 'stepOver', 'stepInto', 'stepOut', 'acknowledge']).describe('Execution control action to perform'),
  connectionReason: z.string().optional().describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
}).strict();

export function createExecutionTools(
  cdpManager: CDPManager,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>,
  connectionManager?: ConnectionManager,
  /** Give a watch-mode restart deferred by this connection's pause a chance to fire now that it's resuming. */
  retryPendingRestart?: (port: number) => void
) {
  return {
    execution: createTool(
      'Control execution flow when paused at breakpoints. Actions: pause (pause execution), resume (resume execution), stepOver (step to next line), stepInto (step into function call), stepOut (step out of current function), acknowledge (acknowledge breakpoint pause to allow other tools to run while paused)',
      executionSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        let resolvedConnection: any = null;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
          resolvedConnection = resolved.connection;
        }

        // Helper to clear acknowledged flag when execution moves
        const clearAcknowledgedFlag = () => {
          if (resolvedConnection) {
            resolvedConnection.breakpointPauseAcknowledged = false;
          } else if (connectionManager) {
            // Clear for all connections when no specific connection is specified
            for (const conn of connectionManager.getAllConnections()) {
              conn.breakpointPauseAcknowledged = false;
            }
          }
        };

        // Handle each action
        switch (action) {
          case 'pause':
            if (resolvedConnection?.reference) {
              await hold(resolvedConnection.reference, { source: 'tool', layers: ['code'] });
            } else {
              await targetCdpManager.pause();
            }
            return createSuccessResponse('EXECUTION_PAUSED');

          case 'resume': {
            // Check if execution was paused due to logpoint limit exceeded
            const logpointLimit = targetCdpManager.getLogpointLimitExceeded();

            if (logpointLimit) {
              // Format logs as a code block
              const logsFormatted = formatCodeBlock(logpointLimit.logs);

              return createErrorResponse('LOGPOINT_LIMIT_EXCEEDED', {
                url: logpointLimit.url,
                lineNumber: logpointLimit.lineNumber,
                executionCount: logpointLimit.executionCount,
                maxExecutions: logpointLimit.maxExecutions,
                breakpointId: logpointLimit.breakpointId,
                logs: logsFormatted,
              });
            }

            // Clear acknowledged flag when resuming (auto-unblock)
            clearAcknowledgedFlag();

            // Through the hold record, so a resume of the bench's hold releases
            // all of it - the animation clock and the step breakpoints with the JS.
            const reference: string | undefined = resolvedConnection?.reference;
            if (reference && isHeld(reference, 'code')) {
              await release(reference, { layers: ['code'] });
            }
            if (targetCdpManager.isPaused()) await targetCdpManager.resume();

            // A watch-mode restart may have been queued while this
            // connection was paused - give it a chance to fire now.
            if (retryPendingRestart) {
              if (resolvedConnection) {
                retryPendingRestart(resolvedConnection.port);
              } else if (connectionManager) {
                for (const conn of connectionManager.getAllConnections()) {
                  retryPendingRestart(conn.port);
                }
              }
            }

            return createSuccessResponse('EXECUTION_RESUMED');
          }

          case 'stepOver':
            clearAcknowledgedFlag();
            await targetCdpManager.stepOver();
            return createSuccessResponse('EXECUTION_STEP_OVER');

          case 'stepInto':
            clearAcknowledgedFlag();
            await targetCdpManager.stepInto();
            return createSuccessResponse('EXECUTION_STEP_INTO');

          case 'stepOut':
            clearAcknowledgedFlag();
            await targetCdpManager.stepOut();
            return createSuccessResponse('EXECUTION_STEP_OUT');

          case 'acknowledge': {
            const resumeCall = (reference?: string): string => reference
              ? `\`execution({ action: 'resume', connectionReason: '${reference}' })\``
              : `\`execution({ action: 'resume' })\``;
            const locationOf = (manager: CDPManager): string => {
              const pauseInfo = manager.getPausedInfo();
              return pauseInfo.location
                ? `${pauseInfo.location.url}:${pauseInfo.location.lineNumber}`
                : 'unknown location';
            };

            // With no connection named, every paused connection is the one the
            // pause guard blocks on, and the active connection may be running.
            if (!resolvedConnection && connectionManager) {
              const paused = connectionManager.getAllConnections().filter(conn => conn.cdpManager.isPaused());
              if (paused.length === 0) {
                return createErrorResponse('NOT_PAUSED');
              }
              for (const conn of paused) {
                conn.breakpointPauseAcknowledged = true;
              }
              return createSuccessResponse('BREAKPOINT_ACKNOWLEDGED', {
                resumeCalls: paused.map(conn => resumeCall(conn.reference)).join(' and '),
                location: paused.length === 1
                  ? locationOf(paused[0].cdpManager)
                  : paused.map(conn => `${conn.reference ?? conn.id} ${locationOf(conn.cdpManager)}`).join(', '),
              });
            }

            if (!targetCdpManager.isPaused()) {
              return createErrorResponse('NOT_PAUSED');
            }
            if (resolvedConnection) {
              resolvedConnection.breakpointPauseAcknowledged = true;
            }
            return createSuccessResponse('BREAKPOINT_ACKNOWLEDGED', {
              resumeCalls: resumeCall(resolvedConnection?.reference),
              location: locationOf(targetCdpManager),
            });
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
