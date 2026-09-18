/**
 * Network Analysis Tools
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { NetworkMonitor, StoredNetworkRequest } from '../network-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { Page } from 'puppeteer-core';
import { getOutputPath } from '../helpers/paths.js';
import type { ToolResponseMeta, NetworkToolMeta } from '../tool-response.js';

// Consolidated network tool schema
const networkToolSchema = z.object({
  action: z.enum(['list', 'get', 'search', 'enable', 'disable', 'setConditions', 'sockets', 'streams'])
    .describe('Network action: list (list network requests), get (get specific request details), search (search requests by pattern), enable (enable network monitoring), disable (disable network monitoring), setConditions (set network conditions), sockets (WebSocket lifecycle: what opened, what closed, what errored - puppeteer surfaces no page event for these, so they come from the CDP Network domain), streams (EventSource messages: an SSE response body never completes, so the HTTP record holds headers and nothing else)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // list action parameters
  resourceType: z.string().optional().describe('Filter by resource type (for list and search actions)'),
  limit: z.number().optional().describe('Max results to return (for list action default: 100, for search action default: 50)'),
  offset: z.number().optional().describe('Number of results to skip (for list action, default: 0)'),

  // get action parameters
  id: z.string().optional().describe('Request ID (required for get action)'),
  includeBody: z.boolean().optional().describe('If true, saves response body to disk and returns file path (for get action, default: false)'),

  // search action parameters
  pattern: z.string().optional().describe('Regex pattern to search for (required for search action)'),
  method: z.string().optional().describe('Filter by HTTP method (for search action)'),
  statusCode: z.string().optional().describe('Filter by status code (for search action)'),
  flags: z.string().optional().describe('Regex flags (for search action, default: "")'),

  // windowing, for attributing traffic to the action that caused it
  since: z.number().optional().describe('list/sockets: epoch ms. Only traffic that started at or after this. Read `at` off a previous response, act, then pass it back to get exactly what that action caused'),
  until: z.number().optional().describe('list/sockets: epoch ms. Only traffic that started before this. With `since`, brackets one action'),

  // sockets action parameters
  frames: z.boolean().optional().describe('sockets: include the frame log per socket - what crossed it, oldest first, with text and binary payloads truncated. Off by default: a sync transport carries thousands of frames and the lifecycle alone answers whether it stayed up'),
  socketUrl: z.string().optional().describe('sockets: with frames, only sockets whose URL contains this substring. Match the app\'s own path to leave dev-server transports out'),

  // setConditions action parameters
  preset: z.enum(['offline', 'slow-3g', 'fast-3g', 'fast-4g', 'online']).optional().describe('Network condition preset (required for setConditions action)'),
}).strict();

/**
 * Characters of frame payload carried in _meta across one response.
 *
 * The log ships whole payloads, and the socket count is not bounded by the
 * caller, so without a budget one call over an afternoon's sockets returns
 * megabytes. Newest frames are kept, since a log is read backwards from
 * whatever just happened.
 */
const FRAME_LOG_CHAR_BUDGET = 262144;

function frameLogBudget() {
  let left = FRAME_LOG_CHAR_BUDGET;
  return {
    take(frames: any[]): any[] {
      const kept: any[] = [];
      for (let i = frames.length - 1; i >= 0; i--) {
        const cost = (frames[i].payload?.length ?? 0) + 64;
        if (cost > left) break;
        left -= cost;
        kept.unshift(frames[i]);
      }
      return kept;
    },
  };
}

/**
 * Characters of a payload printed per frame. A push transport carries whole
 * state snapshots, and twenty of those fill a response with one socket's
 * traffic. The full stored payload stays in `_meta.frameLog`.
 */
const FRAME_LINE_CHARS = 180;

/** Stream messages inside the window, by the clock they were recorded on. */
function eventsIn(stream: any, since?: number, until?: number): any[] {
  if (since === undefined && until === undefined) return stream.events;
  return stream.events.filter((e: any) =>
    (since === undefined || e.at >= since) && (until === undefined || e.at < until));
}

/** One line per stream message, newest last, same shape as the frame log. */
function streamLines(stream: any, events: any[]): string[] {
  const shown = events.slice(-FRAME_LINES_PER_SOCKET);
  const earlier = events.length - shown.length;
  const head = earlier > 0 ? [`       … ${earlier} earlier event(s) held, not printed`] : [];
  return head.concat(shown.map((e: any) => {
    const age = ((e.at - stream.openedAt) / 1000).toFixed(2);
    const id = e.eventId ? ` #${e.eventId}` : '';
    const body = e.data.slice(0, FRAME_LINE_CHARS);
    const more = e.size > body.length ? ` … (${e.size} chars)` : '';
    return `       <- +${age}s ${e.name}${id} ${body}${more}`;
  }));
}

/** Frames that arrived inside the window, by the clock they were recorded on. */
function framesIn(sock: any, since?: number, until?: number): any[] {
  if (since === undefined && until === undefined) return sock.frames;
  return sock.frames.filter((f: any) =>
    (since === undefined || f.at >= since) && (until === undefined || f.at < until));
}

/**
 * Frame lines printed per socket, newest last.
 *
 * A full buffer is 200 frames, and one burst socket fills a response with them
 * on its own. A log is read backwards from what just happened, so the newest
 * are the ones kept and the count of the rest is stated.
 */
const FRAME_LINES_PER_SOCKET = 30;

/** Frame ages in seconds, so a heartbeat cadence reads off the log directly. */
function frameLines(sock: any, frames: any[]): string[] {
  const opcodes: Record<number, string> = { 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };
  const shownFrames = frames.slice(-FRAME_LINES_PER_SOCKET);
  const earlier = frames.length - shownFrames.length;
  const head = earlier > 0
    ? [`       … ${earlier} earlier frame(s) held, not printed`]
    : [];
  return head.concat(shownFrames.map((frame: any) => {
    const arrow = frame.direction === 'received' ? '<-' : '->';
    const kind = opcodes[frame.opcode] ?? `opcode ${frame.opcode}`;
    const age = ((frame.at - sock.openedAt) / 1000).toFixed(2);
    const shown = frame.payload === undefined ? '' : frame.payload.slice(0, FRAME_LINE_CHARS);
    const body = frame.payload === undefined
      ? ''
      : ` ${shown}${frame.size > shown.length ? ` … (${frame.size} chars)` : ''}`;
    return `       ${arrow} +${age}s ${kind}${body}`;
  }));
}

export function createNetworkTools(
  puppeteerManager: PuppeteerManager,
  networkMonitor: NetworkMonitor,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    network: createTool(
      'Monitor and manage network requests. Actions: list (list requests with optional type filter and pagination), get (get specific request by ID), search (search requests by regex pattern), enable (enable network monitoring), disable (disable network monitoring), setConditions (set network throttling conditions)',
      networkToolSchema,
      async (args) => {
        const { action, connectionReason } = args;

        switch (action) {
          case 'streams': {
            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }
            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              targetNetworkMonitor.startMonitoring(targetPuppeteerManager.getPage());
            }

            const seen = targetNetworkMonitor.getStreams();
            const streams = args.socketUrl
              ? seen.filter((s: any) => s.url.includes(args.socketUrl!))
              : seen;
            const budget = frameLogBudget();

            const lines = streams.map((stream: any) => {
              const events = eventsIn(stream, args.since, args.until);
              const dropped = stream.eventsDropped ? ` +${stream.eventsDropped} dropped` : '';
              const head = `STREAM [${stream.target || 'page'}] ${stream.url} - ${events.length} event(s)${dropped}`;
              return args.frames ? [head, ...streamLines(stream, events)].join('\n') : head;
            });

            const text = streams.length === 0
              ? (args.socketUrl && seen.length > 0
                ? `No EventSource stream here has "${args.socketUrl}" in its URL. ${seen.length} stream(s) were seen on this connection.`
                : 'No EventSource streams seen on this connection. A stream is recorded when its first message arrives, so one that has delivered nothing yet is not listed.')
              : `${streams.length} stream(s)\n\n${lines.join('\n')}`;

            return {
              content: [{ type: 'text', text }],
              _meta: {
                tool: 'network', action: 'streams', timestamp: Date.now(),
                streamList: streams.map((s: any) => ({
                  id: `${s.sessionId}:${s.id}`, url: s.url, target: s.target,
                  events: eventsIn(s, args.since, args.until).length,
                  dropped: s.eventsDropped,
                  ...(args.frames ? { eventLog: budget.take(eventsIn(s, args.since, args.until)) } : {}),
                })),
              },
            };
          }

          case 'sockets': {
            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }
            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              targetNetworkMonitor.startMonitoring(targetPuppeteerManager.getPage());
            }

            const seen = targetNetworkMonitor.getSockets();
            // Matched on a substring of the URL, the way requiredSockets is, so
            // an app's own path selects its transport and leaves dev-server
            // sockets (Vite HMR and friends) out of the log.
            const sockets = args.socketUrl
              ? seen.filter((s: any) => s.url.includes(args.socketUrl!))
              : seen;
            const budget = frameLogBudget();
            // Counted over the same set that is listed. Read off the monitor it
            // would describe every socket seen, so a filter that matched one of
            // ten reported nine closures the caller had just excluded.
            const health = {
              total: sockets.length,
              open: sockets.filter((s: any) => !s.closedAt).length,
              closed: sockets.filter((s: any) => s.closedAt).length,
              errored: sockets.filter((s: any) => s.errors.length > 0).length,
            };
            const lines = sockets.map((sock: any) => {
              const how = sock.closedWithTarget ? ' with its target'
                : sock.closedWithDocument ? ' with its document'
                : sock.clientClosed ? ' by the page' : '';
              const state = sock.closedAt ? `closed${how} after ${sock.closedAt - sock.openedAt}ms` : 'open';
              const errs = sock.errors.length ? ` - ${sock.errors.length} frame error(s): ${sock.errors.slice(0, 2).join('; ')}` : '';
              const windowed = framesIn(sock, args.since, args.until);
              const sent = windowed.filter((f: any) => f.direction === 'sent').length;
              const got = windowed.filter((f: any) => f.direction === 'received').length;
              const dropped = sock.framesDropped ? ` +${sock.framesDropped} dropped` : '';
              const traffic = windowed.length ? ` - ${got} in / ${sent} out${dropped}` : '';
              const head = `${sock.closedAt ? 'CLOSED' : 'OPEN  '} [${sock.target || 'page'}] ${sock.url} (${state})${traffic}${errs}`;
              return args.frames ? [head, ...frameLines(sock, windowed)].join('\n') : head;
            });
            const seenCount = seen.length;
            const text = sockets.length === 0
              ? (args.socketUrl && seenCount > 0
                ? `No WebSocket here has "${args.socketUrl}" in its URL. ${seenCount} socket(s) were seen on this connection; drop socketUrl to list them.`
                : 'No WebSockets seen on this connection. Monitoring starts when the connection does, so a socket opened before then is not counted.')
              : `${health.total} WebSocket(s): ${health.open} open, ${health.closed} closed, ${health.errored} with frame errors\n\n${lines.join('\n')}`;

            return {
              content: [{ type: 'text', text }],
              _meta: {
                tool: 'network', action: 'sockets', timestamp: Date.now(), sockets: health,
                // Per-socket, so a run's health diff can name the socket that
                // died and tell a declared transport from dev-server noise.
                socketList: sockets.map((s: any) => ({
                  id: `${s.sessionId}:${s.id}`, url: s.url, target: s.target,
                  closed: !!s.closedAt, errors: s.errors.length,
                  closedWithTarget: !!s.closedWithTarget,
                  clientClosed: !!s.clientClosed,
                  closedWithDocument: !!s.closedWithDocument,
                  frames: {
                    received: framesIn(s, args.since, args.until).filter((f: any) => f.direction === 'received').length,
                    sent: framesIn(s, args.since, args.until).filter((f: any) => f.direction === 'sent').length,
                    dropped: s.framesDropped,
                  },
                  ...(args.frames ? { frameLog: budget.take(framesIn(s, args.since, args.until)) } : {}),
                })),
              },
            };
          }

          case 'list': {
            const { resourceType, limit = 100, offset = 0, since, until } = args;

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

            // Start monitoring if not already active
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetNetworkMonitor.startMonitoring(page);
            }

            const requests = targetNetworkMonitor.getRequests({
              resourceType,
              limit,
              offset,
              since,
              until,
            });

            const requestList = requests.map((req: StoredNetworkRequest) => ({
              id: req.id,
              url: req.url,
              method: req.method,
              resourceType: req.resourceType,
              status: req.response?.status,
              statusText: req.response?.statusText,
              duration: req.timing?.duration,
              failed: req.failed,
              errorText: req.errorText,
            }));

            const totalCount = targetNetworkMonitor.getCount(resourceType);
            // The read clock, returned so a caller can bracket the next action
            // without keeping one of its own.
            const at = Date.now();
            const inWindow = since !== undefined || until !== undefined
              ? targetNetworkMonitor.countRequestsIn(since, until)
              : totalCount;

            const response = createSuccessResponse('NETWORK_REQUESTS_LIST', {
              count: requests.length,
              totalCount,
              resourceType,
              at,
              window: since !== undefined || until !== undefined,
              inWindow,
            }, requestList);

            // Add structured metadata for programmatic use
            response._meta = {
              tool: 'network',
              action: 'list',
              timestamp: Date.now(),
              network: {
                totalCount,
                matchCount: requests.length,
                inWindow,
                at,
                requests: requestList.map((r: any) => ({
                  id: r.id, url: r.url, method: r.method,
                  ...(r.status !== undefined ? { status: r.status } : {}),
                  failed: r.failed,
                })),
                ...(since !== undefined ? { since } : {}),
                ...(until !== undefined ? { until } : {}),
              },
            };

            return response;
          }

          case 'get': {
            const { id, includeBody = false } = args;

            if (!id) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`id\`\n\n**Action:** get\n\n**Suggestion:** Provide a request ID from the network requests list.`,
                  },
                ],
                isError: true,
              };
            }

            // If connectionReason is provided, resolve connection
            let targetNetworkMonitor = networkMonitor;
            if (connectionReason) {
              const resolved = await resolveConnectionFromReason(connectionReason);
              if (!resolved) {
                return createErrorResponse('CONNECTION_NOT_FOUND', {
                  message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
                });
              }
              targetNetworkMonitor = resolved.networkMonitor || networkMonitor;
            }

            const request = targetNetworkMonitor.getRequest(id);

            if (!request) {
              return createErrorResponse('NETWORK_REQUEST_NOT_FOUND', { id });
            }

            // Prepare response object, potentially saving body to disk
            let responseData = request.response;
            let bodyPath: string | undefined;

            if (includeBody && request.response?.body) {
              // Save body to disk and return path instead of inline body
              const networkBodiesDir = getOutputPath('network-bodies');
              await fs.mkdir(networkBodiesDir, { recursive: true });

              // Create filename based on request ID and sanitized URL
              const urlParts = new URL(request.url);
              const sanitizedPath = urlParts.pathname.replace(/[^a-zA-Z0-9]/g, '_');
              const filename = `${request.id}_${sanitizedPath}.txt`;
              bodyPath = join(networkBodiesDir, filename);

              await fs.writeFile(bodyPath, request.response.body, 'utf-8');

              // Create response object without the body
              responseData = {
                status: request.response.status,
                statusText: request.response.statusText,
                headers: request.response.headers,
                bodySize: request.response.bodySize,
                bodyTokens: request.response.bodyTokens,
                bodyPath,
              };
            } else if (!includeBody && request.response) {
              // Don't include body in response by default
              responseData = {
                status: request.response.status,
                statusText: request.response.statusText,
                headers: request.response.headers,
                bodySize: request.response.bodySize,
                bodyTokens: request.response.bodyTokens,
              };
            }

            const data = {
              id: request.id,
              url: request.url,
              method: request.method,
              resourceType: request.resourceType,
              requestHeaders: request.requestHeaders,
              postData: request.postData,
              response: responseData,
              timing: request.timing,
              failed: request.failed,
              errorText: request.errorText,
            };

            const metadata: any = {
              id: request.id,
              url: request.url,
              method: request.method,
              resourceType: request.resourceType,
              status: request.response?.status || 'N/A',
              failed: request.failed,
              errorText: request.errorText,
            };

            if (request.response?.bodySize !== undefined) {
              metadata.bodySize = `${request.response.bodySize} characters`;
            }
            if (request.response?.bodyTokens !== undefined) {
              metadata.bodyTokens = `~${request.response.bodyTokens} tokens`;
            }
            if (bodyPath) {
              metadata.bodyPath = bodyPath;
            }

            return createSuccessResponse('NETWORK_REQUEST_DETAIL', metadata, data);
          }

          case 'enable':
          case 'disable': {
            // connectionReason is part of this tool's schema, so it has to
            // steer which connection gets (un)monitored - not just the
            // default/active one the proxy managers point at.
            let targetPuppeteerManager = puppeteerManager;
            let targetNetworkMonitor = networkMonitor;
            if (connectionReason) {
              const resolved = await resolveConnectionFromReason(connectionReason);
              if (!resolved) {
                return createErrorResponse('CONNECTION_NOT_FOUND', {
                  message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
                });
              }
              // No silent fallback to the default managers. A connection can
              // resolve without a puppeteerManager - a Node.js connectDebugger
              // target has no page - and falling back would start monitoring
              // the DEFAULT connection while reporting success for the named
              // one, which is the misrouting this whole change set out to fix.
              if (!resolved.puppeteerManager || !resolved.networkMonitor) {
                return createErrorResponse('CONNECTION_NOT_FOUND', {
                  message: `Connection "${args.connectionReason}" has no browser page to monitor (a Node.js debugger target has no page). Network monitoring requires a browser connection.`
                });
              }
              targetPuppeteerManager = resolved.puppeteerManager;
              targetNetworkMonitor = resolved.networkMonitor;
            }

            if (!targetPuppeteerManager.isConnected()) {
              return createErrorResponse('PUPPETEER_NOT_CONNECTED');
            }

            const page = targetPuppeteerManager.getPage();

            if (action === 'enable') {
              targetNetworkMonitor.startMonitoring(page);
              return createSuccessResponse('NETWORK_MONITORING_ENABLED');
            }

            await targetNetworkMonitor.stopMonitoring(page);
            return createSuccessResponse('NETWORK_MONITORING_DISABLED');
          }

          case 'search': {
            const { pattern, resourceType, method, statusCode, flags = '', limit = 50 } = args;

            if (!pattern) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`pattern\`\n\n**Action:** search\n\n**Suggestion:** Provide a regex pattern to search network requests.`,
                  },
                ],
                isError: true,
              };
            }

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
            const targetNetworkMonitor = resolved.networkMonitor || networkMonitor;

            // Start monitoring if not already active
            if (!targetNetworkMonitor.isActive() && targetPuppeteerManager.isConnected()) {
              const page = targetPuppeteerManager.getPage();
              targetNetworkMonitor.startMonitoring(page);
            }

            let regex: RegExp;
            try {
              regex = new RegExp(pattern, flags);
            } catch (error) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nInvalid regex pattern: ${error}\n\n**Suggestion:** Check your regex syntax and try again.`,
                  },
                ],
                isError: true,
              };
            }

            // Get all requests and filter
            const allRequests = targetNetworkMonitor.getRequests({ resourceType });

            const matchingRequests = allRequests
              .filter((req: StoredNetworkRequest) => {
                // Filter by URL pattern
                if (!regex.test(req.url)) return false;

                // Filter by method if specified
                if (method && req.method !== method.toUpperCase()) return false;

                // Filter by status code if specified
                if (statusCode && req.response) {
                  const status = req.response.status;
                  if (statusCode.endsWith('xx')) {
                    const prefix = statusCode.charAt(0);
                    if (!String(status).startsWith(prefix)) return false;
                  } else if (String(status) !== statusCode) {
                    return false;
                  }
                }

                return true;
              })
              .slice(0, limit);

            const matches = matchingRequests.map((req: StoredNetworkRequest) => ({
              id: req.id,
              url: req.url,
              method: req.method,
              resourceType: req.resourceType,
              status: req.response?.status,
              statusText: req.response?.statusText,
              duration: req.timing?.duration,
              failed: req.failed,
              errorText: req.errorText,
            }));

            const filters = [];
            if (resourceType) filters.push(`Resource Type: ${resourceType}`);
            if (method) filters.push(`Method: ${method}`);
            if (statusCode) filters.push(`Status: ${statusCode}`);

            const response = createSuccessResponse('NETWORK_SEARCH_RESULTS', {
              pattern,
              flags,
              filtersText: filters.length > 0 ? filters.join(', ') : undefined,
              matchCount: matchingRequests.length,
              totalSearched: allRequests.length
            }, matches);

            // Add structured metadata for programmatic use
            response._meta = {
              tool: 'network',
              action: 'search',
              timestamp: Date.now(),
              network: {
                totalCount: allRequests.length,
                matchCount: matchingRequests.length,
              },
            };

            return response;
          }

          case 'setConditions': {
            const { preset } = args;

            if (!preset) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`preset\`\n\n**Action:** setConditions\n\n**Suggestion:** Provide a network condition preset (offline, slow-3g, fast-3g, fast-4g, online).`,
                  },
                ],
                isError: true,
              };
            }

            if (!connectionReason) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            // Resolve connection from reason
            const resolved = await resolveConnectionFromReason(connectionReason);
            if (!resolved) {
              return createErrorResponse('CONNECTION_NOT_FOUND', {
                message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
              });
            }

            const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;

            if (!targetPuppeteerManager.isConnected()) {
              return createErrorResponse('PUPPETEER_NOT_CONNECTED');
            }

            const page = targetPuppeteerManager.getPage() as Page;
            const cdpSession = await page.createCDPSession();

            const presets: Record<string, any> = {
              'offline': { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
              'slow-3g': { offline: false, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8, latency: 2000 },
              'fast-3g': { offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 562.5 },
              'fast-4g': { offline: false, downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8, latency: 170 },
              'online': { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
            };

            const conditions = presets[preset];
            await cdpSession.send('Network.emulateNetworkConditions', conditions);

            return createSuccessResponse('NETWORK_CONDITIONS_SET', {
              preset
            }, conditions);
          }

          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `## Error\n\nInvalid action: ${action}\n\n**Valid actions:** list, get, search, enable, disable, setConditions`,
                },
              ],
              isError: true,
            };
        }
      }
    ),
  };
}
