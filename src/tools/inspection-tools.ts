/**
 * Inspection Tools
 */

import { z } from 'zod';
import { CDPManager, EvaluateExpressionExceptionError, EvaluateExpressionTimeoutError, EvaluateExpressionPendingPromiseError } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { isAbortError, raceAbort, throwIfAborted } from '../utils/abort.js';
import {
  getWorkerTargetRegistry,
  WorkerTargetRegistry,
  WorkerTargetAmbiguousError,
  WorkerTargetNotFoundError,
  WorkerEvaluateError,
} from '../worker-targets.js';

/**
 * Reverse CDPManager.formatValue()'s display shaping so a machine-readable
 * value can be published on _meta (and captured by a sequence's saveAs).
 *
 * formatValue() renders primitives as display text - a string comes back
 * wrapped in quotes, a number/boolean comes back as its String() form,
 * undefined/null as the words. Objects and arrays come back as real
 * objects/arrays whose leaves are those display strings.
 *
 * Best effort by design: values formatValue() collapsed to a description
 * (a DOM node -> "[HTMLDivElement]", a depth-limited object -> its class
 * name) cannot be recovered and are left as the string they arrived as.
 */
export function deformatEvaluatedValue(formatted: any): unknown {
  if (Array.isArray(formatted)) {
    return formatted.map(deformatEvaluatedValue);
  }
  if (formatted !== null && typeof formatted === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(formatted)) {
      out[key] = deformatEvaluatedValue(val);
    }
    return out;
  }
  if (typeof formatted !== 'string') {
    return formatted;
  }
  if (formatted === 'undefined') return undefined;
  if (formatted === 'null') return null;
  if (formatted === 'true') return true;
  if (formatted === 'false') return false;
  // A quoted string is unambiguous: formatValue only quotes real strings, so
  // '"42"' was the string "42" while '42' was the number 42.
  const quoted = formatted.match(/^"([\s\S]*)"$/);
  if (quoted) return quoted[1];
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(formatted)) {
    const asNumber = Number(formatted);
    if (!Number.isNaN(asNumber)) return asNumber;
  }
  return formatted;
}

/**
 * Format variables data as TOON (Token-Oriented Object Notation)
 * Each variable on its own line for readability
 */
function formatVariablesAsToon(data: any, responseType: string): string {
  const lines: string[] = [];

  if (responseType === 'counts_only') {
    // Format: scope:count
    for (const [scope, count] of Object.entries(data)) {
      lines.push(`${scope}:${count}`);
    }
  } else if (responseType === 'names_only') {
    // Format each name on its own line grouped by scope
    for (const [scope, names] of Object.entries(data)) {
      lines.push(`[${scope}]`);
      for (const name of names as string[]) {
        lines.push(`  ${name}`);
      }
    }
  } else {
    // full or depth_reduced - format each variable
    for (const [scope, vars] of Object.entries(data)) {
      lines.push(`[${scope}]`);
      for (const v of vars as any[]) {
        const valueStr = formatToonValue(v.value);
        lines.push(`  ${v.name}:${valueStr};type:${v.type}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format call stack as TOON
 */
function formatCallStackAsToon(stack: any[]): string {
  const lines: string[] = [];
  for (let i = 0; i < stack.length; i++) {
    const frame = stack[i];
    const loc = frame.location;
    lines.push(`${i}:${frame.functionName || '(anonymous)'};${loc.source}:${loc.line}:${loc.column};id:${frame.callFrameId}`);
  }
  return lines.join('\n');
}

/**
 * Format search results as TOON
 */
function formatSearchResultsAsToon(results: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }>): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.url}:${r.lineNumber}`);
    lines.push(`  ${r.lineContent}`);
  }
  return lines.join('\n');
}

/**
 * Format a value for TOON output
 */
function formatToonValue(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    // Check if it's already a formatted string like "[Function: ...]"
    if (value.startsWith('[') || value.startsWith('"')) return value;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => formatToonValue(v)).join('|');
    return `[${items}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${k}:${formatToonValue(v)}`);
    return `{${entries.join(';')}}`;
  }
  return String(value);
}

/**
 * Check if line content appears to be a webpack eval wrapper (truncated or not)
 */
function isWebpackEvalLine(lineContent: string): boolean {
  return lineContent.startsWith('eval(__webpack_require__.');
}

/**
 * Extract the actual source line from a full webpack eval wrapper.
 * Webpack bundles code like: eval(__webpack_require__.ts("actual\\nsource\\ncode"))
 * This function extracts the inner content and finds the matching line.
 */
function extractSourceFromFullEvalLine(
  fullLineContent: string,
  pattern: string,
  caseSensitive: boolean
): { lineContent: string; innerLineNumber?: number } | null {
  // Extract content between the first ("  and last ")
  // Pattern: eval(__webpack_require__.XX("CONTENT"))
  const startMatch = fullLineContent.match(/^eval\(__webpack_require__\.\w+\(["'`]/);
  if (!startMatch) {
    return null;
  }

  const startIdx = startMatch[0].length;
  // Find the closing quote and parentheses - handle escaped quotes
  let endIdx = fullLineContent.length - 3; // Assume "))" at end, quote before that

  // Extract the inner content
  let innerContent = fullLineContent.substring(startIdx, endIdx);

  try {
    // Unescape the string (handles \\n, \\t, etc.)
    innerContent = innerContent
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  } catch {
    return null;
  }

  // Split into lines and find the one containing the pattern
  const lines = innerContent.split('\n');
  const flags = caseSensitive ? 'g' : 'gi';

  try {
    const regex = new RegExp(pattern, flags);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        regex.lastIndex = 0; // Reset for next test
        return {
          lineContent: lines[i].trim(),
          innerLineNumber: i + 1, // 1-based line number within the eval content
        };
      }
      regex.lastIndex = 0; // Reset for next test
    }
  } catch {
    // If regex fails, try simple string match
    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (line.includes(searchPattern)) {
        return {
          lineContent: lines[i].trim(),
          innerLineNumber: i + 1,
        };
      }
    }
  }

  return null; // Pattern not found in inner content
}


/** Which registry serves a browser. Injected so a test can supply its own. */
export type WorkerRegistryResolver = (host: string, port: number) => WorkerTargetRegistry;

/**
 * A worker runs its own script in its own target, so evaluation there goes over
 * that target's own client rather than the page's debugger.
 */
async function evaluateInWorker(
  cdpManager: CDPManager,
  target: string,
  expression: string,
  awaitPromise: boolean,
  resolveRegistry: WorkerRegistryResolver
) {
  const endpoint = cdpManager.getEndpoint();
  if (!endpoint) return createErrorResponse('DEBUGGER_NOT_CONNECTED');
  const registry = resolveRegistry(endpoint.host, endpoint.port);
  try {
    const value = await registry.evaluate(target, expression, awaitPromise);
    const rendered = value === undefined ? 'undefined' : JSON.stringify(value);
    const meta: ToolResponseMeta = {
      tool: 'inspect',
      action: 'evaluateExpression',
      timestamp: Date.now(),
      inspect: {
        expression,
        value,
        valueType: value === null ? 'null' : typeof value,
        valueSource: 'exact',
        workerTarget: target,
      },
    };
    return {
      ...createSuccessResponse('WORKER_EVALUATED', {
        target,
        result: formatCodeBlock(rendered),
      }),
      _meta: meta,
    };
  } catch (error) {
    return workerErrorResponse(error, target);
  }
}

function workerErrorResponse(error: unknown, target: string) {
  if (error instanceof WorkerTargetNotFoundError) {
    return createErrorResponse('WORKER_TARGET_NOT_FOUND', {
      target,
      available: error.available.map((t) => `${t.type} ${t.url}`).join(', ') || 'none',
    });
  }
  if (error instanceof WorkerTargetAmbiguousError) {
    return createErrorResponse('WORKER_TARGET_AMBIGUOUS', {
      target,
      matches: error.matches.map((t) => `${t.targetId} ${t.url}`).join(', '),
    });
  }
  if (error instanceof WorkerEvaluateError) {
    return createErrorResponse('WORKER_EVALUATE_FAILED', { target, error: error.message });
  }
  return createErrorResponse('WORKER_EVALUATE_FAILED', { target, error: `${error}` });
}

// Consolidated inspection tool schema
const inspectionToolSchema = z.object({
  action: z.enum(['getCallStack', 'getVariables', 'evaluateExpression', 'searchCode', 'searchFunctions', 'listTargets'])
    .describe('Inspection action: getCallStack (get call stack when paused), getVariables (get variables in call frame), evaluateExpression (evaluate JavaScript), searchCode (search code by pattern), searchFunctions (find function definitions), listTargets (list worker targets)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),

  // getVariables and evaluateExpression parameters
  callFrameId: z.string().optional().describe('Call frame ID (required for getVariables, optional for evaluateExpression)'),
  includeGlobal: z.boolean().optional().describe('Include global scope (for getVariables action, default: false)'),
  filter: z.string().optional().describe('Regex filter for variable names (for getVariables action) - applies to ALL scopes. Required when too many variables exist'),
  expandObjects: z.boolean().optional().describe('Expand objects/arrays (for getVariables and evaluateExpression actions, default: true)'),
  maxDepth: z.number().optional().describe('Max expansion depth (for getVariables and evaluateExpression actions, default: 2). Auto-reduced if response too large'),
  maxTokens: z.number().optional().describe('Max tokens for getVariables response (default: 1000). Depth auto-reduced to fit, filter required if still exceeded'),

  // evaluateExpression parameters
  expression: z.string().optional().describe('JavaScript expression (required for evaluateExpression action). A returned Promise is awaited by default, so async IIFEs like (async () => await fetch(...))() resolve to their settled value'),
  awaitPromise: z.boolean().optional().describe('Await a Promise returned by the expression and use its settled value (for evaluateExpression action, default: true). Pass false to inspect the Promise object itself. While paused at a breakpoint, only already-settled promises can be resolved (the event loop is stopped); a pending one fails fast'),
  target: z.string().optional().describe('Worker target to evaluate inside - a target id from listTargets, or a substring of its URL. Omit to evaluate in the page'),
  saveAs: z.string().optional().describe('Sequence step only (evaluateExpression): captures the evaluated value into the run\'s variable store under this name, for later {{var:name}} / {{var:name.path}} use'),

  // searchCode parameters
  pattern: z.string().optional().describe('Regex pattern (required for searchCode action)'),
  caseSensitive: z.boolean().optional().describe('Case sensitive (for searchCode and searchFunctions actions, default: false)'),
  isRegex: z.boolean().optional().describe('Treat as regex (for searchCode action, default: true)'),
  urlFilter: z.string().optional().describe('URL filter regex (for searchCode and searchFunctions actions)'),
  limit: z.number().optional().describe('Max results (for searchCode action default: 100, for searchFunctions default: 50)'),

  // searchFunctions parameters
  functionName: z.string().optional().describe('Function name (required for searchFunctions action)'),
}).strict();

export function createInspectionTools(
  cdpManager: CDPManager,
  sourceMapHandler: SourceMapHandler,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>,
  resolveWorkerRegistry: WorkerRegistryResolver = getWorkerTargetRegistry
) {
  return {
    inspect: createTool(
      'Inspect and debug code. Actions: getCallStack (get call stack when paused), getVariables (get variables in call frame), evaluateExpression (evaluate JavaScript, in the page or inside a worker via `target`), searchCode (search code by pattern), searchFunctions (find function definitions), listTargets (list service/dedicated/shared worker targets)',
      inspectionToolSchema,
      // abortSignal (#110): INTERRUPTIBLE AT A CHECKPOINT, not genuinely
      // cancellable. `evaluateExpression` is the only action with a real wait
      // (the bounded round-trip to the execution context, up to its own
      // timeout), and CDP gives us no way to recall a Runtime.evaluate - so a
      // cancel stops WAITING for it while the expression keeps running in the
      // target. The other actions read already-captured state and only get the
      // entry checkpoint.
      async (args, abortSignal?: AbortSignal) => {
        const { action, connectionReason } = args;

        throwIfAborted(abortSignal);

        // Resolve connection if connectionReason is provided
        let targetCdpManager = cdpManager;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved) {
            return createErrorResponse('CONNECTION_NOT_FOUND');
          }
          targetCdpManager = resolved.cdpManager;
        }

        switch (action) {
          case 'getCallStack': {
            const callStack = targetCdpManager.getCallStack();

            if (!callStack) {
              return createErrorResponse('NOT_PAUSED');
            }

            // Try to map stack frames back to original sources
            const mappedStack = await Promise.all(
              callStack.map(async (frame) => {
                const original = await sourceMapHandler.mapToOriginal(
                  frame.url,
                  frame.location.lineNumber,
                  frame.location.columnNumber
                );

                return {
                  functionName: frame.functionName,
                  location: original || {
                    source: frame.url,
                    line: frame.location.lineNumber,
                    column: frame.location.columnNumber,
                  },
                  callFrameId: frame.callFrameId,
                };
              })
            );

            // Format paused location from first frame
            const pausedLocation = mappedStack.length > 0
              ? `${mappedStack[0].location.source}:${mappedStack[0].location.line}`
              : undefined;

            // Format as TOON
            const toonData = '```\n' + formatCallStackAsToon(mappedStack) + '\n```';

            return createSuccessResponse('CALL_STACK_SUCCESS', {
              pausedLocation,
              frameCount: mappedStack.length,
            }, toonData);
          }

          case 'getVariables': {
            const { callFrameId, includeGlobal = false, filter, expandObjects = true, maxDepth = 2, maxTokens = 1000 } = args;

            if (!callFrameId) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'getVariables',
                missing: 'callFrameId',
                message: 'Provide a valid call frame ID from the call stack'
              });
            }

            try {
              const result = await targetCdpManager.getVariables(callFrameId, includeGlobal, filter, expandObjects, maxDepth, maxTokens);
              const { data, totalCount, usedDepth, requestedDepth, responseType, filterInsufficient } = result;

              // Format data as TOON (Token-Oriented Object Notation)
              const toonData = '```\n' + formatVariablesAsToon(data, responseType) + '\n```';

              // Select message based on responseType and filterInsufficient
              switch (responseType) {
                case 'full':
                  return createSuccessResponse('VARIABLES_SUCCESS', {
                    callFrameId,
                    returnedCount: totalCount,
                    totalCount,
                    usedDepth,
                    filter: filter || undefined,
                    includeGlobal: includeGlobal || undefined,
                  }, toonData);

                case 'depth_reduced':
                  return createSuccessResponse('VARIABLES_DEPTH_REDUCED', {
                    callFrameId,
                    totalCount,
                    requestedDepth,
                    usedDepth,
                    filter: filter || undefined,
                    includeGlobal: includeGlobal || undefined,
                  }, toonData);

                case 'names_only':
                  if (filterInsufficient) {
                    return createSuccessResponse('VARIABLES_FILTER_INSUFFICIENT', {
                      callFrameId,
                      totalCount,
                      filter,
                    }, toonData);
                  }
                  return createSuccessResponse('VARIABLES_NAMES_ONLY', {
                    callFrameId,
                    totalCount,
                  }, toonData);

                case 'counts_only':
                  if (filterInsufficient) {
                    return createSuccessResponse('VARIABLES_FILTER_INSUFFICIENT', {
                      callFrameId,
                      totalCount,
                      filter,
                    }, toonData);
                  }
                  return createSuccessResponse('VARIABLES_COUNTS_ONLY', {
                    callFrameId,
                    totalCount,
                  }, toonData);
              }
            } catch (error) {
              const errorMsg = String(error);
              if (errorMsg.includes('Invalid filter regex')) {
                return createErrorResponse('INVALID_FILTER', {
                  filter,
                  error: errorMsg,
                });
              }
              return createErrorResponse('CALL_FRAME_NOT_FOUND', {
                callFrameId,
              });
            }
          }

          case 'evaluateExpression': {
            const { expression, callFrameId, expandObjects = true, maxDepth = 2, awaitPromise = true } = args;

            if (!expression) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'evaluateExpression',
                missing: 'expression',
                message: 'Provide a JavaScript expression to evaluate'
              });
            }

            if (args.target) {
              return await evaluateInWorker(
                targetCdpManager, args.target, expression, awaitPromise, resolveWorkerRegistry
              );
            }

            try {
              throwIfAborted(abortSignal);
              // raceAbort = stop waiting on cancel; the evaluation itself
              // continues in the target (no way to recall it).
              const detailed = await raceAbort(
                targetCdpManager.evaluateExpressionDetailed(
                  expression, callFrameId, expandObjects, maxDepth,
                  { awaitPromise, captureRaw: true }
                ),
                abortSignal
              );
              const result = detailed.formatted;

              // Format result as TOON
              let formattedResult: string;
              if (result === undefined || result === 'undefined') {
                formattedResult = '```\nundefined\n```';
              } else if (result === null || result === 'null') {
                formattedResult = '```\nnull\n```';
              } else if (typeof result === 'string') {
                formattedResult = `\`\`\`\n${result}\n\`\`\``;
              } else {
                // For objects/arrays, use TOON formatting
                formattedResult = `\`\`\`\n${formatToonValue(result)}\n\`\`\``;
              }

              // Machine-readable twin of the text above: this is what a
              // sequence step's saveAs captures into the variable store
              // (replay-executor's capture table reads _meta.inspect.value).
              // Prefer the exact by-value capture (bug-015); fall back to
              // reconstructing from the display formatting only when the
              // value is not serializable by value.
              const capturedValue = detailed.rawCaptured
                ? detailed.rawValue
                : deformatEvaluatedValue(result);
              const inspectMeta: ToolResponseMeta = {
                tool: 'inspect',
                action: 'evaluateExpression',
                timestamp: Date.now(),
                inspect: {
                  expression,
                  value: capturedValue,
                  valueType: capturedValue === null ? 'null' : typeof capturedValue,
                  valueSource: detailed.rawCaptured ? 'exact' : 'display',
                  ...(callFrameId ? { callFrameId } : {}),
                },
              };

              return {
                ...createSuccessResponse('EVALUATE_EXPRESSION_SUCCESS', {
                  expression,
                  context: callFrameId ? `Call frame ${callFrameId}` : 'Global context',
                  result: formattedResult
                }),
                _meta: inspectMeta,
              };
            } catch (error) {
              // The universal trap: this broad catch ends in a catch-all
              // EVALUATE_EXPRESSION_FAILED, which would turn the user's cancel
              // into a bogus evaluation failure. Rethrow aborts first.
              if (isAbortError(error)) throw error;
              // The evaluated expression itself threw (CDP exceptionDetails,
              // e.g. a stack-exhaustion RangeError) - report it as an
              // ordinary outcome, not a tool malfunction.
              if (error instanceof EvaluateExpressionExceptionError) {
                return createErrorResponse('EVALUATE_EXPRESSION_EXCEPTION', {
                  expression: error.expression,
                  errorType: error.exceptionType,
                  errorMessage: error.exceptionMessage,
                  stack: error.exceptionStack || '(no stack available)',
                });
              }
              // The expression returned a Promise that cannot settle while
              // the debugger is paused (event loop stopped) - fail fast with
              // an explanation instead of burning the full timeout.
              if (error instanceof EvaluateExpressionPendingPromiseError) {
                return createErrorResponse('EVALUATE_PROMISE_PENDING_WHILE_PAUSED', {
                  expression: error.expression,
                  connection: connectionReason ? `, connectionReason: '${connectionReason}'` : '',
                });
              }
              // The execution context never responded within the bounded
              // timeout - report explicitly instead of hanging forever.
              if (error instanceof EvaluateExpressionTimeoutError) {
                return createErrorResponse('EVALUATE_CONTEXT_UNRESPONSIVE', {
                  connectionReason: args.connectionReason || 'unknown',
                  expression: error.expression,
                  timeoutMs: error.timeoutMs,
                });
              }
              return createErrorResponse('EVALUATE_EXPRESSION_FAILED', {
                expression,
                error: String(error),
              });
            }
          }

          case 'searchCode': {
            const { pattern, caseSensitive = false, isRegex = true, urlFilter, limit = 100 } = args;

            if (!pattern) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'searchCode',
                missing: 'pattern',
                message: 'Provide a regex pattern to search for in the code'
              });
            }

            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const allScripts = targetCdpManager.getAllScripts();
              let scriptsToSearch = allScripts;

              // Filter by URL if provided
              if (urlFilter) {
                try {
                  const urlRegex = new RegExp(urlFilter);
                  scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
                } catch (error) {
                  return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
                }
              }

              const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

              for (const script of scriptsToSearch) {
                if (allResults.length >= limit) break;

                const matches = await targetCdpManager.searchInScript(
                  script.scriptId,
                  pattern,
                  caseSensitive,
                  isRegex
                );

                for (const match of matches) {
                  let lineContent: string;
                  let displayLineNumber = match.lineNumber + 1; // Convert to 1-based

                  // Check if this is a webpack eval line (truncated content starts with eval)
                  if (isWebpackEvalLine(match.lineContent)) {
                    // Fetch the full line content from the script
                    const fullLine = await targetCdpManager.getScriptLine(script.scriptId, match.lineNumber);
                    if (fullLine) {
                      const extracted = extractSourceFromFullEvalLine(fullLine, pattern, caseSensitive);
                      if (extracted) {
                        lineContent = extracted.lineContent;
                      } else {
                        // Couldn't extract, use truncated original
                        lineContent = match.lineContent;
                      }
                    } else {
                      lineContent = match.lineContent;
                    }
                  } else {
                    // Regular code, use as-is
                    lineContent = match.lineContent;
                  }

                  // Truncate line content to avoid huge responses from minified code
                  const MAX_LINE_LENGTH = 200;
                  if (lineContent.length > MAX_LINE_LENGTH) {
                    lineContent = lineContent.substring(0, MAX_LINE_LENGTH) + '...';
                  }

                  allResults.push({
                    url: script.url,
                    scriptId: script.scriptId,
                    lineNumber: displayLineNumber,
                    lineContent,
                  });

                  if (allResults.length >= limit) break;
                }
              }

              // Format as TOON
              const toonData = allResults.length > 0
                ? '```\n' + formatSearchResultsAsToon(allResults) + '\n```'
                : 'No matches found';

              return createSuccessResponse('CODE_SEARCH_RESULTS', {
                count: allResults.length.toString(),
                scriptsSearched: scriptsToSearch.length.toString(),
              }, toonData);
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
            }
          }

          case 'listTargets': {
            const endpoint = targetCdpManager.getEndpoint();
            if (!endpoint) return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            const targets = await resolveWorkerRegistry(endpoint.host, endpoint.port).list();
            const rows = targets.length
              ? targets.map((t) => `${t.type}\t${t.url}\t${t.targetId}`).join('\n')
              : 'none';
            const listMeta: ToolResponseMeta = {
              tool: 'inspect',
              action: 'listTargets',
              timestamp: Date.now(),
              workerTargets: targets,
            };
            return {
              ...createSuccessResponse('WORKER_TARGETS_LISTED', {
                count: targets.length.toString(),
                targets: formatCodeBlock(rows),
              }),
              _meta: listMeta,
            };
          }

          case 'searchFunctions': {
            const { functionName, caseSensitive = false, urlFilter, limit = 50 } = args;

            if (!functionName) {
              return createErrorResponse('MISSING_PARAMETER', {
                action: 'searchFunctions',
                missing: 'functionName',
                message: 'Provide a function name to search for'
              });
            }

            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const allScripts = targetCdpManager.getAllScripts();
              let scriptsToSearch = allScripts;

              // Filter by URL if provided
              if (urlFilter) {
                try {
                  const urlRegex = new RegExp(urlFilter);
                  scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
                } catch (error) {
                  return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
                }
              }

              // Build pattern to match: function name( or const name = or let name =
              const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pattern = caseSensitive
                ? `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`
                : `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`;

              const allResults: Array<{ url: string; scriptId: string; lineNumber: number; lineContent: string }> = [];

              for (const script of scriptsToSearch) {
                if (allResults.length >= limit) break;

                const matches = await targetCdpManager.searchInScript(
                  script.scriptId,
                  pattern,
                  caseSensitive,
                  true // always use regex
                );

                for (const match of matches) {
                  let lineContent: string;
                  let displayLineNumber = match.lineNumber + 1; // Convert to 1-based

                  // Check if this is a webpack eval line (truncated content starts with eval)
                  if (isWebpackEvalLine(match.lineContent)) {
                    // Fetch the full line content from the script
                    const fullLine = await targetCdpManager.getScriptLine(script.scriptId, match.lineNumber);
                    if (fullLine) {
                      const extracted = extractSourceFromFullEvalLine(fullLine, pattern, caseSensitive);
                      if (extracted) {
                        lineContent = extracted.lineContent;
                      } else {
                        // Couldn't extract, use truncated original
                        lineContent = match.lineContent.trim();
                      }
                    } else {
                      lineContent = match.lineContent.trim();
                    }
                  } else {
                    // Regular code, use as-is
                    lineContent = match.lineContent.trim();
                  }

                  // Truncate line content to avoid huge responses from minified code
                  const MAX_LINE_LENGTH = 200;
                  if (lineContent.length > MAX_LINE_LENGTH) {
                    lineContent = lineContent.substring(0, MAX_LINE_LENGTH) + '...';
                  }

                  allResults.push({
                    url: script.url,
                    scriptId: script.scriptId,
                    lineNumber: displayLineNumber,
                    lineContent,
                  });

                  if (allResults.length >= limit) break;
                }
              }

              // Format as TOON
              const toonData = allResults.length > 0
                ? '```\n' + formatSearchResultsAsToon(allResults) + '\n```'
                : 'No matches found';

              return createSuccessResponse('FUNCTION_SEARCH_RESULTS', {
                count: allResults.length.toString(),
                functionName,
                scriptsSearched: scriptsToSearch.length.toString(),
              }, toonData);
            } catch (error) {
              return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', {
              action,
              validActions: 'getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions',
            });
        }
      }
    ),
  };
}
