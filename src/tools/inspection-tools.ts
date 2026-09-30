/**
 * `inspect` reads a paused debugger's call stack and variables, evaluates
 * JavaScript in the page or inside a worker target, searches the scripts a
 * connection has loaded, and lists its worker targets.
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
  if (typeof value === 'string') return value;
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
): { lineContent: string } | null {
  // eval(__webpack_require__.XX("CONTENT")): the content starts after the
  // opening quote and ends before the closing quote and "))", the last three
  // characters. An escaped quote inside the content is not looked for.
  const startMatch = fullLineContent.match(/^eval\(__webpack_require__\.\w+\(["'`]/);
  if (!startMatch) {
    return null;
  }

  const startIdx = startMatch[0].length;
  const endIdx = fullLineContent.length - 3;

  // The content is a string literal, with \n, \t, \r, \\ and quotes escaped
  // in it. Each escape is read in one pass, so an escaped backslash followed by
  // `n` stays a backslash and an `n`.
  const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };
  const innerContent = fullLineContent
    .substring(startIdx, endIdx)
    .replace(/\\(.)/g, (_escape, char: string) => ESCAPES[char] ?? char);

  const lines = innerContent.split('\n');
  const flags = caseSensitive ? 'g' : 'gi';

  try {
    const regex = new RegExp(pattern, flags);
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        regex.lastIndex = 0; // Reset for next test
        return { lineContent: lines[i].trim() };
      }
      regex.lastIndex = 0; // Reset for next test
    }
  } catch {
    // A pattern that is not a valid regex is matched as plain text.
    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (line.includes(searchPattern)) {
        return { lineContent: lines[i].trim() };
      }
    }
  }

  return null;
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

const inspectionToolSchema = z.object({
  action: z.enum(['getCallStack', 'getVariables', 'evaluateExpression', 'searchCode', 'searchFunctions', 'listTargets']),
  connectionReason: z.string().describe('The connection, by the name connection launch or attach gave it'),

  // getVariables and evaluateExpression parameters
  callFrameId: z.string().optional().describe('Call frame ID (getVariables: required; evaluateExpression: the frame to evaluate in)'),
  includeGlobal: z.boolean().optional().describe('getVariables: include global scope (default: false)'),
  filter: z.string().optional().describe('getVariables: regex on variable names, across all scopes'),
  expandObjects: z.boolean().optional().describe('getVariables/evaluateExpression: expand objects/arrays (default: true)'),
  maxDepth: z.number().optional().describe('getVariables/evaluateExpression: max expansion depth (default: 2)'),
  maxTokens: z.number().optional().describe('getVariables: response token budget (default: 1000)'),

  // evaluateExpression parameters
  expression: z.string().optional().describe('evaluateExpression: the JavaScript; a returned Promise is awaited'),
  awaitPromise: z.boolean().optional().describe('evaluateExpression: await a returned Promise (default: true); false returns the Promise itself'),
  target: z.string().optional().describe('evaluateExpression: worker target id from listTargets, or a substring of its URL; omitted, the page'),
  saveAs: z.string().optional().describe('Sequence step only (evaluateExpression): stores the value for later {{var:name}} / {{var:name.path}} use'),

  // searchCode parameters
  pattern: z.string().optional().describe('searchCode: pattern'),
  caseSensitive: z.boolean().optional().describe('searchCode/searchFunctions: case sensitive (default: false)'),
  isRegex: z.boolean().optional().describe('searchCode: pattern is a regex (default: true)'),
  urlFilter: z.string().optional().describe('searchCode/searchFunctions: script URL regex'),
  limit: z.number().optional().describe('Max results (searchCode default 100, searchFunctions 50)'),

  // searchFunctions parameters
  functionName: z.string().optional().describe('searchFunctions: function name'),
}).strict();

export function createInspectionTools(
  sourceMapHandler: SourceMapHandler,
  resolveConnectionFromReason: (connectionReason: string) => Promise<{
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
      // abortSignal (#110): a cancel stops the wait, not the work. An
      // evaluation, in the page or in a worker, is raced against it: CDP cannot
      // recall a Runtime.evaluate, so the expression keeps running in the target
      // while the call returns. The searches and the variable and call-stack
      // reads check the cancel once on entry and run their CDP round-trips to
      // completion.
      async (args, abortSignal?: AbortSignal) => {
        const { action, connectionReason } = args;

        throwIfAborted(abortSignal);

        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND');
        }
        const targetCdpManager = resolved.cdpManager;

        switch (action) {
          case 'getCallStack': {
            const callStack = targetCdpManager.getCallStack();

            if (!callStack) {
              return createErrorResponse('NOT_PAUSED');
            }

            // A frame a source map covers is reported at its original source.
            const mappedStack = await Promise.all(
              callStack.map(async (frame) => {
                // Chrome's frame lines are 0-based; source map lines are 1-based.
                const original = await sourceMapHandler.mapToOriginal(
                  frame.url,
                  frame.location.lineNumber + 1,
                  frame.location.columnNumber
                );

                return {
                  functionName: frame.functionName,
                  location: original ? { ...original, column: original.column + 1 } : {
                    source: frame.url,
                    line: frame.location.lineNumber + 1,
                    column: frame.location.columnNumber !== undefined ? frame.location.columnNumber + 1 : undefined,
                  },
                  callFrameId: frame.callFrameId,
                };
              })
            );

            const pausedLocation = mappedStack.length > 0
              ? `${mappedStack[0].location.source}:${mappedStack[0].location.line}`
              : undefined;

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

              const toonData = '```\n' + formatVariablesAsToon(data, responseType) + '\n```';

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
              return await raceAbort(
                evaluateInWorker(targetCdpManager, args.target, expression, awaitPromise, resolveWorkerRegistry),
                abortSignal
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

              let formattedResult: string;
              if (result === undefined || result === 'undefined') {
                formattedResult = '```\nundefined\n```';
              } else if (result === null || result === 'null') {
                formattedResult = '```\nnull\n```';
              } else if (typeof result === 'string') {
                formattedResult = `\`\`\`\n${result}\n\`\`\``;
              } else {
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
              // A cancel rethrows before the catch-all below, which would report
              // it as EVALUATE_EXPRESSION_FAILED.
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
              // The expression returned a Promise that cannot settle while the
              // debugger is paused (the event loop is stopped); answered at once
              // rather than after the timeout.
              if (error instanceof EvaluateExpressionPendingPromiseError) {
                return createErrorResponse('EVALUATE_PROMISE_PENDING_WHILE_PAUSED', {
                  expression: error.expression,
                  connection: `, connectionReason: '${connectionReason}'`,
                });
              }
              // The execution context did not answer within the timeout.
              if (error instanceof EvaluateExpressionTimeoutError) {
                return createErrorResponse('EVALUATE_CONTEXT_UNRESPONSIVE', {
                  connectionReason,
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

                  // A webpack eval line arrives truncated; the match is read from
                  // the source inside the full line.
                  if (isWebpackEvalLine(match.lineContent)) {
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

              if (urlFilter) {
                try {
                  const urlRegex = new RegExp(urlFilter);
                  scriptsToSearch = allScripts.filter(s => urlRegex.test(s.url));
                } catch (error) {
                  return createErrorResponse('SOURCE_CODE_FAILED', { error: `Invalid URL filter regex: ${error}` });
                }
              }

              // `function name(`, `const name =`, `let name =`, `name: function`,
              // `name: (` and `name = (`; case is the search's own flag.
              const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const pattern = `(function\\s+${escapedName}\\s*\\(|const\\s+${escapedName}\\s*=|let\\s+${escapedName}\\s*=|${escapedName}\\s*:\\s*function|${escapedName}\\s*:\\s*\\(|${escapedName}\\s*=\\s*\\()`;

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

                  // A webpack eval line arrives truncated; the match is read from
                  // the source inside the full line.
                  if (isWebpackEvalLine(match.lineContent)) {
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
              validActions: 'getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions, listTargets',
            });
        }
      }
    ),
  };
}
