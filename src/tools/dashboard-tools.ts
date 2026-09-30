/**
 * Dashboard Tools
 * MCP tools for managing the devharness dashboard
 */

import { z } from 'zod';
import { livePids } from '../helpers/process-liveness.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import type { DuplicateSessionInfo } from '../tool-response.js';
import type { DashboardInstance } from '../dashboard/index.js';
import type { SessionInfo } from '../session-detector.js';

const dashboardSchema = z.object({
  action: z.enum(['open', 'status', 'stop']),
}).strict();

type DashboardArgs = z.infer<typeof dashboardSchema>;

// Lazy-bound dashboard instance (set after async initialization in main())
let dashboardInstanceRef: DashboardInstance | null = null;
let sessionInfoRef: SessionInfo | null = null;

export function setDashboardInstance(instance: DashboardInstance | null): void {
  dashboardInstanceRef = instance;
}

export function getDashboardInstance(): DashboardInstance | null {
  return dashboardInstanceRef;
}

export function setSessionInfo(info: SessionInfo | null): void {
  sessionInfoRef = info;
}

export function getSessionInfo(): SessionInfo | null {
  return sessionInfoRef;
}

/**
 * Get duplicate session info for blocking check
 */
export function getDuplicateSessionInfo(): DuplicateSessionInfo | null {
  const instance = dashboardInstanceRef;
  const session = sessionInfoRef;

  if (!session?.sessionId) {
    return null;
  }

  let allPids: number[] = [process.pid];
  let allPpids: number[] = [process.ppid];

  if (instance?.client) {
    allPids = instance.client.getAllPids();
    allPpids = instance.client.getAllPpids();
  } else if (instance?.hub) {
    allPids = instance.hub.getAllPids();
    allPpids = instance.hub.getAllPpids();
  }

  // The hub prunes a pid only on a clean websocket close, so a killed MCP stays
  // registered and every later session reads it as a duplicate. Drop the dead
  // ones before deciding: a stale pid should be reaped, not reported.
  return {
    sessionId: session.sessionId,
    shortId: session.shortId,
    allPids: livePids(allPids, process.pid),
    allPpids: livePids(allPpids, process.ppid),
    currentPid: process.pid,
    currentPpid: process.ppid,
  };
}

export function createDashboardTools() {
  return {
    dashboard: createTool(
      'Manage the devharness web dashboard. Actions: open (get URL to open in browser), status (show whether this session is hub or client), stop (stop the hub server if this session is the hub)',
      dashboardSchema,
      async (args: DashboardArgs) => {
        // Use lazy-bound instance
        const instance = dashboardInstanceRef;

        switch (args.action) {
          case 'open': {
            if (!instance) {
              return createErrorResponse('DASHBOARD_NOT_AVAILABLE', {
                reason: 'Dashboard is disabled or failed to initialize',
              });
            }

            const url = `http://localhost:${instance.port}`;
            return createSuccessResponse('DASHBOARD_OPEN', {
              url,
              type: instance.type,
              message: `Dashboard available at ${url}`,
            });
          }

          case 'status': {
            const session = sessionInfoRef;

            if (!instance) {
              return createSuccessResponse('DASHBOARD_INITIALIZING', {
                pid: process.pid,
                shortId: session?.shortId ?? '...',
              });
            }

            const isHub = instance.type === 'hub';
            return createSuccessResponse('DASHBOARD_STATUS', {
              enabled: true,
              type: instance.type,
              port: instance.port,
              isHub,
              sessionCount: isHub ? instance.hub?.getSessionCount() : 'N/A',
              url: `http://localhost:${instance.port}`,
              sessionId: session?.sessionId ?? 'Detecting...',
              shortId: session?.shortId ?? '...',
              pid: process.pid,
            });
          }

          case 'stop': {
            if (!instance) {
              return createErrorResponse('DASHBOARD_NOT_AVAILABLE', {
                reason: 'Dashboard is disabled or failed to initialize',
              });
            }

            if (instance.type !== 'hub') {
              return createErrorResponse('DASHBOARD_NOT_HUB', {
                reason: 'This session is a client, not the hub. Only the hub can be stopped.',
              });
            }

            await instance.hub?.stop();
            return createSuccessResponse('DASHBOARD_STOPPED', {
              message: 'Dashboard hub has been stopped',
            });
          }

          default:
            return createErrorResponse('DASHBOARD_UNKNOWN_ACTION', {
              action: args.action,
            });
        }
      }
    ),
  };
}
