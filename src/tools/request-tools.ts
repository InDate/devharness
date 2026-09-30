/**
 * Request Tools - HTTP requests as a sequence step
 * destination "node" sends directly from the MCP server process (no browser).
 * destination "browser" runs fetch() inside a connected tab (shares its cookies/session/origin).
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse, getFormattedResponse } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { abortErrorFor, isAbortError, linkSignals, throwIfAborted } from '../utils/abort.js';

const MAX_RESPONSE_BODY_CHARS = 100_000;

const requestSchema = z.object({
  url: z.string().describe('URL to request'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET'),
  headers: z.record(z.string()).optional().describe('Request headers'),
  body: z.string().optional().describe('Raw request body (e.g. JSON.stringify it yourself)'),
  destination: z.enum(['browser', 'node']).describe('browser: fetch inside the connected tab (shares cookies/session/origin). node: fetch directly from the MCP server process'),
  connectionReason: z.string().optional().describe('Required when destination is "browser" - which tab runs the fetch'),
  timeoutMs: z.number().optional().describe('Request timeout in ms (default 30000)'),
  saveAs: z.string().optional().describe('Sequence step only: captures {ok,status,statusText,headers,body,durationMs} into the run\'s variable store under this name, for later {{var:name.path}} use'),
}).strict();

type RequestArgs = z.infer<typeof requestSchema>;

interface RawResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export function createRequestTools(resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  return {
    request: createTool(
      'Make an HTTP request as a sequence step. destination "node" sends it from the MCP server process directly (no browser, no CORS/cookies). destination "browser" runs fetch() inside a connected tab (uses that page\'s cookies/session/origin).',
      requestSchema,
      // abortSignal (#110): for destination "node" this is GENUINE
      // cancellation - the external signal is composed into the fetch's
      // controller, so aborting closes the socket, not just the await. For
      // destination "browser" the fetch runs inside the page and is
      // unreachable from out here: checkpoints only, the in-page fetch runs
      // to its own timeout.
      async (args: RequestArgs, abortSignal?: AbortSignal) => {
        const timeoutMs = args.timeoutMs ?? 30000;
        const startedAt = Date.now();

        throwIfAborted(abortSignal);

        if (args.destination === 'browser') {
          if (!args.connectionReason) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'request',
              missing: 'connectionReason',
              message: 'destination "browser" requires connectionReason to identify which tab runs the fetch'
            });
          }

          const resolved = await resolveConnectionFromReason(args.connectionReason);
          if (!resolved?.puppeteerManager) {
            return createErrorResponse('CONNECTION_NOT_FOUND', {
              message: `No active browser connection "${args.connectionReason}". Start one with connection({ action: 'launch' }).`
            });
          }

          try {
            const page = resolved.puppeteerManager.getPage();
            // Last exit before the fetch is handed to the page - once
            // page.evaluate is in flight, cancellation cannot reach it.
            throwIfAborted(abortSignal);
            const result: RawResponse = await page.evaluate(
              async (url: string, method: string, headers: Record<string, string> | undefined, body: string | undefined, timeout: number) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);
                try {
                  const res = await fetch(url, { method, headers, body, signal: controller.signal });
                  const text = await res.text();
                  const responseHeaders: Record<string, string> = {};
                  res.headers.forEach((value, key) => { responseHeaders[key] = value; });
                  return { ok: res.ok, status: res.status, statusText: res.statusText, headers: responseHeaders, body: text };
                } finally {
                  clearTimeout(timer);
                }
              },
              args.url, args.method!, args.headers, args.body, timeoutMs
            );
            return formatRequestResult(args, result, Date.now() - startedAt, 'browser');
          } catch (error: any) {
            // A cancellation (checkpoint above, or the page torn down under
            // us) is not a request failure - rethrow for classification.
            if (isAbortError(error)) throw error;
            return createErrorResponse('REQUEST_FAILED', {
              url: args.url,
              destination: 'browser',
              error: error.message || String(error)
            });
          }
        }

        // destination === 'node'
        // Two controllers with different meanings: timeoutController fires on
        // this request's own timeoutMs; the external abortSignal is the
        // caller's cancel (e.g. `replay cancel`). Both are composed into the
        // signal handed to fetch, so EITHER genuinely closes the socket - and
        // the catch below tells them apart by which one fired, never by
        // parsing the error.
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
        const linked = linkSignals(abortSignal, timeoutController.signal);
        try {
          const res = await fetch(args.url, {
            method: args.method,
            headers: args.headers,
            body: args.body,
            signal: linked.signal,
          });
          const text = await res.text();
          const responseHeaders: Record<string, string> = {};
          res.headers.forEach((value, key) => { responseHeaders[key] = value; });
          return formatRequestResult(
            args,
            { ok: res.ok, status: res.status, statusText: res.statusText, headers: responseHeaders, body: text },
            Date.now() - startedAt,
            'node'
          );
        } catch (error: any) {
          // isAbortError covers the DOMException fetch throws (name
          // 'AbortError'); TimeoutError is what some runtimes raise instead.
          if (isAbortError(error) || error?.name === 'TimeoutError') {
            // External cancel wins: the user aborted, the socket is closed -
            // throw abort-shaped so the executor reports a cancel, not a
            // request failure (and never "Timed out", which would be a lie).
            if (abortSignal?.aborted) throw abortErrorFor(abortSignal);
            if (timeoutController.signal.aborted) {
              return createErrorResponse('REQUEST_FAILED', {
                url: args.url,
                destination: 'node',
                error: `Timed out after ${timeoutMs}ms`
              });
            }
          }
          return createErrorResponse('REQUEST_FAILED', {
            url: args.url,
            destination: 'node',
            error: error.message || String(error)
          });
        } finally {
          clearTimeout(timer);
          linked.dispose();
        }
      }
    ),
  };
}

/**
 * HTTP-level status (4xx/5xx) is not a tool error - curl-style, the request
 * completed, so the caller inspects `status`/`ok` itself. Only network-level
 * failures (unreachable, timeout, abort) are tool errors.
 */
function formatRequestResult(
  args: RequestArgs,
  result: RawResponse,
  durationMs: number,
  destination: 'browser' | 'node'
) {
  const truncated = result.body.length > MAX_RESPONSE_BODY_CHARS;
  const body = truncated ? result.body.slice(0, MAX_RESPONSE_BODY_CHARS) : result.body;

  const requestMeta: ToolResponseMeta = {
    tool: 'request',
    action: destination,
    timestamp: Date.now(),
    request: {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body,
      durationMs,
    },
  };

  return {
    content: [
      {
        type: 'text',
        text: getFormattedResponse('REQUEST_SUCCESS', {
          url: args.url,
          method: args.method,
          destination,
          ok: result.ok ? 'yes' : 'no',
          status: result.status.toString(),
          statusText: result.statusText,
          durationMs: durationMs.toString(),
          body,
          truncated,
        }),
      },
    ],
    _meta: requestMeta,
  };
}
