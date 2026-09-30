/**
 * Breakpoint Management Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import type { LogpointExecutionTracker } from '../logpoint-execution-tracker.js';
import { createSuccessResponse, createErrorResponse, getErrorMessage } from '../messages.js';
import { abortErrorFor, isAbortError, throwIfAborted } from '../utils/abort.js';

/**
 * Helper to resolve TypeScript source maps for breakpoint locations.
 * Handles Vite-style serving (skip translation) vs traditional builds (translate).
 */
async function resolveBreakpointLocation(
  url: string,
  lineNumber: number,
  columnNumber: number | undefined,
  cdpManager: CDPManager,
  sourceMapHandler: SourceMapHandler
): Promise<{ url: string; line: number; column: number | undefined }> {
  let targetUrl = url;
  let targetLine = lineNumber;
  let targetColumn = columnNumber;

  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    // Check if this .ts/.tsx URL is already loaded as a script (Vite dev server)
    const tsScriptLoaded = cdpManager.isScriptLoaded(url);

    if (!tsScriptLoaded) {
      // Traditional build: .ts files compiled to .js, need source map translation
      const mapped = await sourceMapHandler.mapToGenerated(url, lineNumber, columnNumber || 0);
      if (mapped) {
        targetUrl = mapped.generatedFile;
        targetLine = mapped.line;
        targetColumn = mapped.column;
      }
    }
    // If tsScriptLoaded is true, use url and lineNumber directly
    // CDP will handle source map translation via inline source maps
  }

  return { url: targetUrl, line: targetLine, column: targetColumn };
}

// Schema definitions
const breakpointSchema = z.object({
  action: z.enum([
    'set', 'remove', 'list', 'setLogpoint', 'validate', 'resetCounter', 'waitForScript',
    'setDOMBreakpoint', 'setEventBreakpoint', 'setXHRBreakpoint', 'await'
  ]),
  connectionReason: z.string(),

  // Location
  url: z.string().optional(),
  lineNumber: z.number().optional(),
  columnNumber: z.number().optional(),
  condition: z.string().optional(),

  // Logpoint
  logMessage: z.string().optional().describe('Message with {expr} interpolation'),
  includeCallStack: z.boolean().optional(),
  includeVariables: z.boolean().optional(),
  maxExecutions: z.number().int().min(1).optional(),

  // Timing
  timeout: z.number().optional().describe('Timeout ms'),

  // Management
  breakpointId: z.string().optional(),

  // DOM breakpoint
  selector: z.string().optional(),
  domBreakpointType: z.enum(['subtree-modified', 'attribute-modified', 'node-removed']).optional(),

  // Event breakpoint
  eventName: z.string().optional().describe('Event: click, submit, input, keydown...'),
  targetName: z.string().optional().describe('Filter by element type'),

  // XHR breakpoint
  urlPattern: z.string().optional().describe('URL substring to match'),
}).strict();

export function createBreakpointTools(
  sourceMapHandler: SourceMapHandler,
  logpointTracker: LogpointExecutionTracker | undefined,
  resolveConnectionFromReason: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    breakpoint: createTool(
      'Manage breakpoints and logpoints. Actions: set (line breakpoint), remove (remove by ID), list (list all), setLogpoint (log without pausing), validate (test expressions), resetCounter (reset logpoint counter), waitForScript (wait for script load), setDOMBreakpoint (pause when element changes), setEventBreakpoint (pause when event fires), setXHRBreakpoint (pause on network requests), await (set breakpoint and wait for hit - user can abort)',
      breakpointSchema,
      async (args, abortSignal) => {
        const { action } = args;
        // Appended to every call a reply suggests, so the call reaches this connection.
        const on = `, connectionReason: '${args.connectionReason}'`;

        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND');
        }
        const targetCdpManager = resolved.cdpManager;

        switch (action) {
          case 'set': {
            if (!args.url || args.lineNumber === undefined) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url and lineNumber are required for set action' });
            }

            // Check connection and runtime type
            const runtimeType = targetCdpManager.getRuntimeType();
            const isConnected = targetCdpManager.isConnected();

            if (!isConnected) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            // Resolve source maps for TypeScript files
            const resolved = await resolveBreakpointLocation(
              args.url, args.lineNumber, args.columnNumber,
              targetCdpManager, sourceMapHandler
            );
            const targetUrl = resolved.url;
            const targetLine = resolved.line;
            const targetColumn = resolved.column;

            try {
              const breakpoint = await targetCdpManager.setBreakpoint(targetUrl, targetLine, targetColumn, args.condition);

              // Check if breakpoint is pending (script not loaded yet)
              if (breakpoint.status === 'pending') {
                // Don't inject console link for pending breakpoints (script not loaded)
                let markdown = `## Breakpoint Set (Pending)\n\n`;
                markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
                markdown += `**URL:** \`${targetUrl}\`\n`;
                markdown += `**Line:** ${targetLine}\n`;
                if (args.condition) {
                  markdown += `**Condition:** \`${args.condition}\`\n`;
                }
                markdown += `\n**Status:** ⏳ Pending - Script not loaded yet\n\n`;
                markdown += `**Note:** The breakpoint has been set and will activate automatically when the script loads. `;
                markdown += `Use \`navigate({ action: 'goto' })\` or \`navigate({ action: 'reload' })\` to load the page.\n\n`;
                markdown += `**TIP:** Use \`breakpoint({ action: 'waitForScript', url: '${targetUrl}' })\` to wait for the script to load.`;

                return {
                  content: [{
                    type: 'text',
                    text: markdown,
                  }],
                };
              }

              // Get actual resolved location (CDP returns 0-based, convert to 1-based)
              const resolvedLine = breakpoint.location.lineNumber + 1;
              const resolvedColumn = breakpoint.location.columnNumber !== undefined
                ? breakpoint.location.columnNumber + 1
                : undefined;

              // Check if location was adjusted (line or column)
              // targetColumn was set earlier (line 82) and may have been modified by source mapping
              const lineAdjusted = resolvedLine !== targetLine;
              const columnAdjusted = targetColumn !== undefined && resolvedColumn !== undefined && resolvedColumn !== targetColumn;
              const wasAdjusted = lineAdjusted || columnAdjusted;

              // Inject clickable console link at resolved location
              const icon = args.condition ? '🔶' : '🔴';
              const label = args.condition ? 'Conditional breakpoint set at' : 'Breakpoint set at';
              await targetCdpManager.injectConsoleLink(targetUrl, resolvedLine, `${icon} ${label}`);

              // Build location strings for message
              const resolvedLocation = resolvedColumn !== undefined
                ? `line ${resolvedLine}:${resolvedColumn}`
                : `line ${resolvedLine}`;
              const requestedLocation = targetColumn !== undefined
                ? `line ${targetLine}:${targetColumn}`
                : `line ${targetLine}`;

              // Return markdown-only success response with resolved location info
              return createSuccessResponse('BREAKPOINT_SET_SUCCESS', {
                url: targetUrl,
                resolvedLine: resolvedLine,
                resolvedLocation: resolvedLocation,
                requestedLocation: requestedLocation,
                wasAdjusted: wasAdjusted,
                breakpointId: breakpoint.breakpointId,
                condition: args.condition,
              });
            } catch (error: any) {
              // Build context-aware error message
              let markdown = getErrorMessage('BREAKPOINT_SET_FAILED', {
                url: targetUrl,
                lineNumber: targetLine,
                error: error.message,
              });

              // Add runtime-specific TIP if applicable
              if (runtimeType === 'chrome' && (args.url.includes('/dist/') || args.url.includes('index.js'))) {
                markdown += '\n\n**TIP:** You are connected to Chrome (browser) but trying to set a breakpoint on what looks like server code. ' +
                            'If this is Node.js server code, you need to connect to the Node.js debugger separately using `connection` action `attach` with port 9229.';
              } else if (runtimeType === 'node' && args.url.includes('/public/')) {
                markdown += '\n\n**TIP:** You are connected to Node.js but trying to set a breakpoint on what looks like browser code. ' +
                            'You may need to connect to Chrome using `connection` action `attach` with port 9222 for client-side debugging.';
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: markdown,
                  },
                ],
                isError: true,
              };
            }
          }

          case 'remove': {
            if (!args.breakpointId) {
              return createErrorResponse('INVALID_PARAMS', { message: 'breakpointId is required for remove action' });
            }

            const bpId = args.breakpointId;

            // Dispatch to appropriate remove method based on ID prefix
            if (bpId.startsWith('dom-bp-')) {
              await targetCdpManager.removeDOMBreakpoint(bpId);
            } else if (bpId.startsWith('event-bp-')) {
              await targetCdpManager.removeEventListenerBreakpoint(bpId);
            } else if (bpId.startsWith('xhr-bp-')) {
              await targetCdpManager.removeXHRBreakpoint(bpId);
            } else {
              // Line breakpoint or logpoint - unregister from tracker first
              if (logpointTracker) {
                logpointTracker.unregisterLogpoint(targetCdpManager, bpId);
              }
              await targetCdpManager.removeBreakpoint(bpId);
            }

            return createSuccessResponse('BREAKPOINT_REMOVE_SUCCESS', { breakpointId: bpId });
          }

          case 'list': {
            const breakpoints = targetCdpManager.getBreakpoints();
            const counts = targetCdpManager.getBreakpointCounts();
            const domBreakpoints = targetCdpManager.getDOMBreakpoints();
            const eventBreakpoints = targetCdpManager.getEventListenerBreakpoints();
            const xhrBreakpoints = targetCdpManager.getXHRBreakpoints();

            // Count pending breakpoints
            const pendingCount = breakpoints.filter(bp => bp.status === 'pending').length;

            // Calculate total across all types
            const totalAll = counts.total + domBreakpoints.length + eventBreakpoints.length + xhrBreakpoints.length;

            // Build markdown response
            let markdown = `## Active Breakpoints\n\n`;
            markdown += `**Total:** ${totalAll}`;
            if (totalAll > 0) {
              const parts: string[] = [];
              if (counts.breakpoints > 0) parts.push(`${counts.breakpoints} line`);
              if (counts.logpoints > 0) parts.push(`${counts.logpoints} logpoint`);
              if (domBreakpoints.length > 0) parts.push(`${domBreakpoints.length} DOM`);
              if (eventBreakpoints.length > 0) parts.push(`${eventBreakpoints.length} event`);
              if (xhrBreakpoints.length > 0) parts.push(`${xhrBreakpoints.length} XHR`);
              markdown += ` (${parts.join(', ')}`;
              if (pendingCount > 0) {
                markdown += `, ${pendingCount} pending`;
              }
              markdown += `)`;
            }
            markdown += `\n\n`;

            if (totalAll === 0) {
              markdown += 'No active breakpoints.\n\n';
              markdown += '**TIP:** Use `breakpoint({ action: \'set\' })` to set a line breakpoint, `breakpoint({ action: \'setDOMBreakpoint\' })` for DOM changes, or `breakpoint({ action: \'setEventBreakpoint\' })` for events.';
            } else {
              markdown += '| ID | Type | Status | Details |\n';
              markdown += '|---|---|---|---|\n';

              // Line breakpoints and logpoints
              breakpoints.forEach(bp => {
                const type = bp.isLogpoint ? 'logpoint' : 'line';
                const status = bp.status === 'pending' ? '⏳ pending' : '✓ resolved';
                let location: string;
                if (bp.originalLocation) {
                  location = `${bp.originalLocation.url}:${bp.originalLocation.lineNumber}${bp.originalLocation.columnNumber !== undefined ? `:${bp.originalLocation.columnNumber}` : ''}`;
                } else {
                  location = `scriptId:${bp.location.scriptId}:${bp.location.lineNumber + 1}${bp.location.columnNumber !== undefined ? `:${bp.location.columnNumber + 1}` : ''}`;
                }
                markdown += `| \`${bp.breakpointId}\` | ${type} | ${status} | \`${location}\` |\n`;
              });

              // DOM breakpoints
              domBreakpoints.forEach(bp => {
                markdown += `| \`${bp.breakpointId}\` | DOM | ✓ active | \`${bp.selector}\` (${bp.domBreakpointType}) |\n`;
              });

              // Event breakpoints
              eventBreakpoints.forEach(bp => {
                const target = bp.targetName ? ` on ${bp.targetName}` : '';
                markdown += `| \`${bp.breakpointId}\` | event | ✓ active | ${bp.eventName}${target} |\n`;
              });

              // XHR breakpoints
              xhrBreakpoints.forEach(bp => {
                markdown += `| \`${bp.breakpointId}\` | XHR | ✓ active | URL contains \`${bp.urlPattern}\` |\n`;
              });

              if (pendingCount > 0) {
                markdown += `\n**Note:** Pending breakpoints will activate when their scripts load.`;
              }
            }

            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'resetCounter': {
            if (!args.breakpointId) {
              return createErrorResponse('INVALID_PARAMS', { message: 'breakpointId is required for resetCounter action' });
            }

            // Reset the counter in the tracker
            if (!logpointTracker) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            const metadata = logpointTracker.getLogpoint(targetCdpManager, args.breakpointId);

            if (!metadata) {
              return createErrorResponse('BREAKPOINT_NOT_FOUND', { breakpointId: args.breakpointId });
            }

            // Reset the counter in the tracker
            const previousCount = metadata.executionCount;
            logpointTracker.resetCounter(targetCdpManager, args.breakpointId);

            // Reset the global counter in the page context
            const logpointKey = `${metadata.url}:${metadata.lineNumber}`;
            try {
              await targetCdpManager.evaluateExpression(`
                if (typeof globalThis.__llmCdpLogpointCounters !== 'undefined') {
                  globalThis.__llmCdpLogpointCounters['${logpointKey.replace(/'/g, "\\'")}'] = 0;
                }
              `);
            } catch (error) {
              // Ignore errors - counter may not exist yet
            }

            // Clear the logpoint limit exceeded state in CDPManager
            targetCdpManager.clearLogpointLimitExceeded();

            // Build markdown response with details
            let markdown = getErrorMessage('LOGPOINT_COUNTER_RESET', {
              breakpointId: args.breakpointId,
              maxExecutions: metadata.maxExecutions,
            });

            markdown += `\n\n**Logpoint Details:**\n`;
            markdown += `- **Location:** \`${metadata.url}:${metadata.lineNumber}\`\n`;
            markdown += `- **Log Message:** \`${metadata.logMessage}\`\n`;
            markdown += `- **Previous Count:** ${previousCount}\n`;
            markdown += `- **New Count:** 0\n`;
            markdown += `\n**Next Step:** Use \`execution({ action: 'resume'${on} })\` to continue execution.`;

            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'validate': {
            if (!args.url || args.lineNumber === undefined || !args.logMessage) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url, lineNumber, and logMessage are required for validate action' });
            }

            const timeout = args.timeout || 2000;

            // Parse logMessage to extract expressions
            const expressionMatches = args.logMessage.matchAll(/\{([^}]+)\}/g);
            const expressions: string[] = [];
            for (const match of expressionMatches) {
              expressions.push(match[1]);
            }

            if (expressions.length === 0) {
              const markdown = `## Logpoint Validation\n\n` +
                `**Status:** Valid\n` +
                `**Message:** No expressions to validate in log message\n` +
                `**Log Message:** \`${args.logMessage}\`\n\n` +
                `**Note:** This log message contains no variable interpolations. It will output as-is.`;

              return {
                content: [
                  {
                    type: 'text',
                    text: markdown,
                  },
                ],
              };
            }

            // Set a temporary breakpoint to test the expressions
            try {
              const tempBreakpoint = await targetCdpManager.setBreakpoint(args.url, args.lineNumber, args.columnNumber);

              // Get actual location from CDP (0-based)
              const actualCdpLine = tempBreakpoint.location.lineNumber;
              const actualCdpColumn = tempBreakpoint.location.columnNumber;

              // Convert to 1-based for user display
              const actualLineUser = actualCdpLine + 1;
              const actualColumnUser = actualCdpColumn !== undefined ? actualCdpColumn + 1 : undefined;

              // Check if location differs
              const lineDiffers = actualLineUser !== args.lineNumber;
              const columnDiffers = args.columnNumber !== undefined && actualColumnUser !== args.columnNumber;
              const locationDiffers = lineDiffers || columnDiffers;

              // Wait for the breakpoint to potentially be hit (configurable timeout)
              await new Promise(resolve => setTimeout(resolve, timeout));

              // Check if we're paused at the breakpoint
              if (!targetCdpManager.isPaused()) {
                // Remove temp breakpoint
                await targetCdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

                let markdown = `## Logpoint Validation\n\n`;
                markdown += `**Status:** Unknown\n`;
                markdown += `**Message:** Unable to validate - code at this location has not been executed yet\n\n`;
                markdown += `**Expressions:** ${expressions.map(e => `\`${e}\``).join(', ')}\n`;
                markdown += `**Log Message:** \`${args.logMessage}\`\n\n`;
                markdown += `**Location:**\n`;
                markdown += `- **Requested:** Line ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n`;
                markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
                markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

                if (locationDiffers) {
                  markdown += `**Warning:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
                }

                markdown += `**Suggestion:** Trigger the code path that contains this line, or set the logpoint and check console for errors`;

                return {
                  content: [
                    {
                      type: 'text',
                      text: markdown,
                    },
                  ],
                };
              }

              // Try to evaluate each expression and collect available variables
              const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];
              let availableVariables: string[] = [];

              const callFrame = targetCdpManager.getCallStack()?.[0];
              if (callFrame) {
                // Get available variables at this location
                try {
                  const result = await targetCdpManager.getVariables(callFrame.callFrameId, false);
                  // Extract variable names from grouped data structure
                  const { data, responseType } = result;
                  if (responseType === 'full' || responseType === 'depth_reduced') {
                    // data is Record<string, {name, value, type}[]>
                    for (const vars of Object.values(data as Record<string, any[]>)) {
                      for (const v of vars) {
                        availableVariables.push(v.name);
                      }
                    }
                  } else if (responseType === 'names_only') {
                    // data is Record<string, string[]>
                    for (const names of Object.values(data as Record<string, string[]>)) {
                      availableVariables.push(...names);
                    }
                  }
                  // For counts_only, we don't have names to suggest
                } catch (err) {
                  // Ignore errors getting variables
                }

                // Evaluate each expression
                for (const expr of expressions) {
                  try {
                    const value = await targetCdpManager.evaluateExpression(expr, callFrame.callFrameId);
                    results.push({
                      expression: expr,
                      valid: true,
                      value,
                    });
                  } catch (error) {
                    results.push({
                      expression: expr,
                      valid: false,
                      error: String(error),
                    });
                  }
                }
              } else {
                // No call frame available
                for (const expr of expressions) {
                  results.push({
                    expression: expr,
                    valid: false,
                    error: 'No call frame available',
                  });
                }
              }

              // Resume execution
              await targetCdpManager.resume();

              // Remove temp breakpoint
              await targetCdpManager.removeBreakpoint(tempBreakpoint.breakpointId);

              const allValid = results.every(r => r.valid);
              const invalidExpressions = results.filter(r => !r.valid);

              // Get code snippet (3 lines context around actual location)
              let codeContext: string | undefined;
              try {
                const startLine = Math.max(1, actualLineUser - 1);
                const endLine = actualLineUser + 1;
                const sourceResult = await targetCdpManager.getSourceCode(args.url, startLine, endLine);
                codeContext = sourceResult.code;
              } catch (err) {
                // Ignore errors getting code snippet
              }

              // Build markdown response
              let markdown = `## Logpoint Validation\n\n`;
              markdown += `**Status:** ${allValid ? 'Valid ✓' : 'Failed ✗'}\n`;
              markdown += `**Message:** ${allValid ? 'All expressions are valid at this location' : `${invalidExpressions.length} expression(s) failed to evaluate`}\n\n`;

              // Location info
              markdown += `**Location:**\n`;
              markdown += `- **Requested:** Line ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n`;
              markdown += `- **Actual:** Line ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
              markdown += `- **Matched:** ${!locationDiffers ? 'Yes' : 'No'}\n\n`;

              if (locationDiffers) {
                markdown += `**Warning:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
              }

              // Expression results
              markdown += `**Expression Results:**\n\n`;
              markdown += `| Expression | Valid | Value/Error |\n`;
              markdown += `|---|---|---|\n`;
              results.forEach(r => {
                const status = r.valid ? '✓' : '✗';
                const valueStr = r.valid ? JSON.stringify(r.value) : r.error;
                markdown += `| \`${r.expression}\` | ${status} | ${valueStr} |\n`;
              });
              markdown += `\n`;

              // Available variables
              if (availableVariables.length > 0) {
                markdown += `**Available Variables:** ${availableVariables.map(v => `\`${v}\``).join(', ')}\n\n`;
              }

              // Code context
              if (codeContext) {
                markdown += `**Code Context:**\n\`\`\`javascript\n${codeContext}\n\`\`\`\n\n`;
              }

              // If validation failed, search for better locations
              if (!allValid) {
                try {
                  const suggestions = await targetCdpManager.findBestLogpointLocation(
                    args.url,
                    args.lineNumber,
                    args.columnNumber,
                    expressions,
                    2,  // searchRadius ±2 lines
                    1000  // 1 second timeout per candidate
                  );

                  if (suggestions.length > 0) {
                    markdown += `**Suggestions:**\n`;
                    suggestions.slice(0, 3).forEach((s: any) => {
                      markdown += `- Line ${s.line}${s.column ? `:${s.column}` : ''} - ${s.score}% of expressions valid\n`;
                    });
                    markdown += `\n**Recommendation:** Consider using line ${suggestions[0].line} where ${suggestions[0].score}% of expressions are valid`;
                  } else {
                    markdown += `**Suggestion:** Check variable names and scopes. Variables must be in scope at the logpoint location.`;
                  }
                } catch (err) {
                  markdown += `**Suggestion:** Check variable names and scopes. Variables must be in scope at the logpoint location.`;
                }
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: markdown,
                  },
                ],
              };
            } catch (error) {
              return createErrorResponse('LOGPOINT_VALIDATE_FAILED', {
                error: String(error),
              });
            }
          }

          case 'setLogpoint': {
            if (!args.url || args.lineNumber === undefined || !args.logMessage) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url, lineNumber, and logMessage are required for setLogpoint action' });
            }

            const includeCallStack = args.includeCallStack || false;
            const includeVariables = args.includeVariables || false;
            const maxExecutions = args.maxExecutions || 20;

            // Resolve source maps for TypeScript files
            const resolved = await resolveBreakpointLocation(
              args.url, args.lineNumber, args.columnNumber,
              targetCdpManager, sourceMapHandler
            );
            const targetUrl = resolved.url;
            const targetLine = resolved.line;
            const targetColumn = resolved.column;

            // Parse logMessage to extract expressions in {}
            const expressionMatches = args.logMessage.matchAll(/\{([^}]+)\}/g);
            const expressions: string[] = [];
            for (const match of expressionMatches) {
              expressions.push(match[1]);
            }

            // Build the log expression in Chrome DevTools' own native logpoint format:
            // a `console.log(...)` call immediately preceded by the exact
            // `/** DEVTOOLS_LOGPOINT */` sentinel comment, with a trailing
            // `//# sourceURL=debugger://logpoint` marker - verified against
            // devtools-frontend's BreakpointManager.ts (LOGPOINT_PREFIX/LOGPOINT_SUFFIX
            // + addSourceUrl()). This is exactly how Chrome's Sources panel implements
            // logpoints, so the resulting console output is attributed/broadcast the
            // same way for any DevTools/CDP client attached to the page, not just this
            // tool's own connection.
            const logpointKey = `${targetUrl}:${targetLine}`;
            const escapedKey = logpointKey.replace(/'/g, "\\'");

            // Computes the formatted log message; always returns a string so the
            // outer console.log() call fires exactly once per (allowed) hit.
            const messageExpression = `(function() {
              try {
                const values = {};
                ${expressions.map(expr => {
                  const escapedExpr = expr.replace(/'/g, "\\'");
                  return `
                try {
                  values['${escapedExpr}'] = ${expr};
                } catch (e) {
                  values['${escapedExpr}'] = '[Error: ' + e.message + ']';
                }`;
                }).join('')}

                const safeStringify = (value) => {
                  if (value === null) return 'null';
                  if (value === undefined) return 'undefined';
                  if (typeof value === 'string') return value;
                  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
                  try {
                    return JSON.stringify(value, null, 2);
                  } catch (e) {
                    return String(value);
                  }
                };

                let message = ${JSON.stringify(args.logMessage)};
                ${expressions.map(expr => {
                  const escapedExpr = expr.replace(/'/g, "\\'");
                  return `message = message.replace('{${expr}}', safeStringify(values['${escapedExpr}']));`;
                }).join('\n                ')}

                ${includeCallStack ? `
                message += '\\n  Call stack: ' + new Error().stack.split('\\n').slice(2, 5).join(' | ');
                ` : ''}
                ${includeVariables ? `
                message += '\\n  Variables: ' + safeStringify(values);
                ` : ''}

                if (globalThis.__llmCdpLogpointCounters['${escapedKey}'] === ${maxExecutions}) {
                  message += '\\n  [Logpoint] Execution limit reached (${maxExecutions}/${maxExecutions}). Further hits will not be logged.';
                }

                return message;
              } catch (e) {
                if (typeof globalThis.__llmCdpLogpointErrors === 'undefined') {
                  globalThis.__llmCdpLogpointErrors = [];
                }
                globalThis.__llmCdpLogpointErrors.push({
                  type: 'logpoint-error',
                  location: '${targetUrl}:${targetLine}:${targetColumn || 'auto'}',
                  expressions: ${JSON.stringify(expressions)},
                  error: e.message,
                  stack: e.stack || e.toString(),
                  timestamp: new Date().toISOString()
                });
                if (globalThis.__llmCdpLogpointErrors.length > 50) {
                  globalThis.__llmCdpLogpointErrors.shift();
                }
                return '[Logpoint Error] ' + e.message;
              }
            })()`;

            // Counting/capping happens in a guard evaluated before the real
            // console.log call, so we stop logging once maxExecutions is hit
            // instead of spamming the console forever. The Node-side
            // LogpointExecutionTracker (see logpoint-execution-tracker.ts) still
            // detects the maxExecutions-th message and pauses the debuggee as a
            // safety net - this condition itself never returns true anymore,
            // since its overall value must stay falsy to match the native
            // never-pause logpoint semantics above.
            let logExpression = `(function() {
              if (typeof globalThis.__llmCdpLogpointCounters === 'undefined') {
                globalThis.__llmCdpLogpointCounters = {};
              }
              const key = '${escapedKey}';
              globalThis.__llmCdpLogpointCounters[key] = (globalThis.__llmCdpLogpointCounters[key] || 0) + 1;
              return globalThis.__llmCdpLogpointCounters[key] <= ${maxExecutions};
            })() && (/** DEVTOOLS_LOGPOINT */ console.log('[Logpoint] ${targetUrl}:${targetLine}:${targetColumn || 'auto'}:', ${messageExpression}))

//# sourceURL=debugger://logpoint`;

            // If a user condition is provided, only log/count when it's true
            if (args.condition) {
              logExpression = `(${args.condition}) && ${logExpression}`;
            }

            // Use targetCdpManager.setBreakpoint to ensure proper state management
            // This ensures state.breakpoints Map is updated immediately
            let breakpoint: any;
            try {
              breakpoint = await targetCdpManager.setBreakpoint(
                targetUrl,
                targetLine,  // targetCdpManager.setBreakpoint expects 1-based numbers
                targetColumn,
                logExpression
              );
            } catch (error: any) {
              let markdown = `## Failed to Set Logpoint\n\n`;
              markdown += `**Error:** ${error.message}\n\n`;
              markdown += `**Details:**\n`;
              markdown += `- **Requested:** \`${args.url}:${args.lineNumber}\`\n`;
              markdown += `- **Target:** \`${targetUrl}:${targetLine}\`\n\n`;

              if (error.message.includes('not loaded')) {
                markdown += `**Suggestion:** The script has not been loaded by the runtime yet. Try navigating to the page or reloading.`;
              } else {
                markdown += `**Suggestion:** Verify the file has been loaded and the line number is valid.`;
              }

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
                isError: true
              };
            }

            // Mark as logpoint in the breakpoint info (state is already updated by setBreakpoint)
            breakpoint.isLogpoint = true;

            // AUTOMATIC LINE/COLUMN MAPPING VALIDATION
            // Get actual location from CDP (0-based)
            const actualCdpLine = breakpoint.location.lineNumber;
            const actualCdpColumn = breakpoint.location.columnNumber;

            // Convert to 1-based for comparison with user input
            const actualLineUser = actualCdpLine + 1;
            const actualColumnUser = actualCdpColumn !== undefined ? actualCdpColumn + 1 : undefined;

            // Check if location differs from what user requested
            const lineDiffers = actualLineUser !== targetLine;
            const columnDiffers = targetColumn !== undefined && actualColumnUser !== targetColumn;
            const locationDiffers = lineDiffers || columnDiffers;

            // If location differs AND we have expressions to validate
            if (locationDiffers && expressions.length > 0) {
              // Validate expressions at actual location
              const validation = await targetCdpManager.validateLogpointAtActualLocation(
                targetUrl,
                actualLineUser,  // 1-based
                actualColumnUser, // 1-based
                expressions,
                2000  // 2 second timeout
              );

              // If validation failed (expressions not valid at actual location)
              if (!validation.allValid) {
                // Remove the breakpoint - don't keep a broken logpoint
                // Unregister from tracker first
                if (logpointTracker) {
                  logpointTracker.unregisterLogpoint(targetCdpManager, breakpoint.breakpointId);
                }

                try {
                  await targetCdpManager.removeBreakpoint(breakpoint.breakpointId);
                } catch (removeError: any) {
                  // Log but continue - state might already be cleaned up
                  console.error(`[devharness] Warning: Failed to remove invalid logpoint: ${removeError.message}`);
                }

                // Get code snippet at actual location (3 lines context)
                let codeContext = '';
                try {
                  const sourceCode = await targetCdpManager.getSourceCode(
                    targetUrl,
                    Math.max(1, actualLineUser - 1),  // 1 line before
                    actualLineUser + 1  // 1 line after
                  );
                  codeContext = sourceCode.code;
                } catch (e) {
                  codeContext = '(Could not fetch source code)';
                }

                // Search for better locations
                let suggestions: any[] = [];
                try {
                  suggestions = await targetCdpManager.findBestLogpointLocation(
                    targetUrl,
                    args.lineNumber,
                    args.columnNumber,
                    expressions,
                    2,  // Search ±2 lines
                    1000  // 1 second timeout per candidate
                  );
                } catch (e) {
                  // If search fails, provide a simple suggestion
                  suggestions = [{
                    line: actualLineUser - 1,
                    reason: 'Try the line before where variables might be in scope',
                    note: 'Use validateLogpoint first to test expressions'
                  }];
                }

                // Return detailed error response
                let errorMarkdown = `## Logpoint Validation Failed\n\n`;
                errorMarkdown += `**Error:** Logpoint expressions failed validation at actual CDP location\n\n`;

                errorMarkdown += `**Requested Location:**\n`;
                errorMarkdown += `- **URL:** \`${args.url}\`\n`;
                errorMarkdown += `- **Line:** ${args.lineNumber}${args.columnNumber ? `:${args.columnNumber}` : ''}\n\n`;

                errorMarkdown += `**Actual Location (CDP Mapped):**\n`;
                errorMarkdown += `- **Line:** ${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\n`;
                errorMarkdown += `- **Offset:** ${actualLineUser - args.lineNumber > 0 ? '+' : ''}${actualLineUser - args.lineNumber} lines\n`;
                errorMarkdown += `- **Reason:** V8 mapped to nearest valid breakpoint location\n\n`;

                const failedExprs = validation.results.filter((r: any) => !r.valid).map((r: any) => r.expression);
                errorMarkdown += `**Failed Expressions:** ${failedExprs.map((e: string) => `\`${e}\``).join(', ')}\n\n`;

                errorMarkdown += `**Code Context:**\n\`\`\`javascript\n${codeContext}\n\`\`\`\n\n`;

                if (validation.availableVariables && validation.availableVariables.length > 0) {
                  errorMarkdown += `**Available Variables:** ${validation.availableVariables.map((v: string) => `\`${v}\``).join(', ')}\n\n`;
                }

                if (suggestions.length > 0) {
                  errorMarkdown += `**Suggestions:**\n`;
                  suggestions.forEach((s: any) => {
                    errorMarkdown += `- Line ${s.line}${s.column ? `:${s.column}` : ''} - ${s.score}% of expressions valid\n`;
                  });
                  errorMarkdown += `\n`;

                  if (suggestions[0].score === 100) {
                    errorMarkdown += `**Recommendation:** Set logpoint at line ${suggestions[0].line}:${suggestions[0].column || 'auto'} instead where all expressions are in scope.`;
                  } else {
                    errorMarkdown += `**Recommendation:** Variables not in scope at actual location ${actualLineUser}:${actualColumnUser || 'auto'}. Try using validateLogpoint to find a better location.`;
                  }
                } else {
                  errorMarkdown += `**Recommendation:** Variables not in scope at actual location ${actualLineUser}:${actualColumnUser || 'auto'}. Try using validateLogpoint to find a better location.`;
                }

                return {
                  content: [{
                    type: 'text',
                    text: errorMarkdown,
                  }],
                  isError: true
                };
              }

              // Validation passed but location differs - will show warning in success response below
            }

            // Register with logpoint execution tracker
            if (logpointTracker) {
              logpointTracker.registerLogpoint(
                targetCdpManager,
                breakpoint.breakpointId,
                targetUrl,
                actualLineUser,  // Use the actual line where it was set (1-based)
                args.logMessage,
                maxExecutions
              );
            }

            // Inject console notification at resolved location
            await targetCdpManager.injectConsoleLink(targetUrl, actualLineUser, '📝 Logpoint set at');

            // Parse expressions to include in the response
            const expressionMatchesForResponse = args.logMessage.matchAll(/\{([^}]+)\}/g);
            const expressionsForResponse: string[] = [];
            for (const match of expressionMatchesForResponse) {
              expressionsForResponse.push(match[1]);
            }

            // Build markdown success response
            let markdown = `## Logpoint Set Successfully\n\n`;
            markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
            markdown += `**Location:** \`${targetUrl}:${actualLineUser}${actualColumnUser ? `:${actualColumnUser}` : ''}\`\n`;
            markdown += `**Log Message:** \`${args.logMessage}\`\n`;

            if (expressionsForResponse.length > 0) {
              markdown += `**Expressions:** ${expressionsForResponse.map(e => `\`${e}\``).join(', ')}\n`;
            }

            if (args.condition) {
              markdown += `**Condition:** \`${args.condition}\`\n`;
            }

            markdown += `**Max Executions:** ${maxExecutions}\n\n`;

            // If location differs, add warning and validation info
            if (locationDiffers && expressions.length > 0) {
              markdown += `**⚠️ Warning:** Logpoint was set at line ${actualLineUser}:${actualColumnUser || 'auto'} (not ${args.lineNumber}:${args.columnNumber || 'auto'}) due to V8 line mapping. All expressions validated successfully at this location.\n\n`;
            } else if (locationDiffers) {
              markdown += `**⚠️ Note:** CDP mapped your requested location ${args.lineNumber}:${args.columnNumber || 'auto'} to ${actualLineUser}:${actualColumnUser || 'auto'}\n\n`;
            }

            markdown += `**Note:** This logpoint will log to the browser console without pausing execution`;

            if (expressionsForResponse.length > 0) {
              markdown += `\n\n**TIP:** Each expression is wrapped in try-catch. If an expression fails, it will show \`[Error: message]\` in the log.`;
              markdown += `\nTo see logpoint errors, use: \`console({ action: 'search', pattern: "Logpoint Error" })\``;
            }

            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
            };
          }

          case 'waitForScript': {
            if (!args.url) {
              return createErrorResponse('INVALID_PARAMS', { message: 'url is required for waitForScript action' });
            }

            const timeout = args.timeout || 10000;

            // Check connection
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              // First check if script is already loaded
              const existingScript = targetCdpManager.findLoadedScript(args.url);
              if (existingScript) {
                let markdown = `## Script Already Loaded\n\n`;
                markdown += `**Pattern:** \`${args.url}\`\n`;
                markdown += `**Matched URL:** \`${existingScript}\`\n`;
                markdown += `**Status:** ✓ Script is already loaded\n\n`;
                markdown += `**Next Step:** You can now set breakpoints on this script using \`breakpoint({ action: 'set', url: '${existingScript}', lineNumber: <line> })\``;

                return {
                  content: [{
                    type: 'text',
                    text: markdown,
                  }],
                };
              }

              // Script not loaded, wait for it
              const matchedUrl = await targetCdpManager.waitForScript(args.url, timeout);

              let markdown = `## Script Loaded\n\n`;
              markdown += `**Pattern:** \`${args.url}\`\n`;
              markdown += `**Matched URL:** \`${matchedUrl}\`\n`;
              markdown += `**Status:** ✓ Script loaded successfully\n\n`;
              markdown += `**Next Step:** You can now set breakpoints on this script using \`breakpoint({ action: 'set', url: '${matchedUrl}', lineNumber: <line> })\``;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
              };
            } catch (error: any) {
              // Timeout or other error
              let markdown = `## Script Wait Timeout\n\n`;
              markdown += `**Pattern:** \`${args.url}\`\n`;
              markdown += `**Timeout:** ${timeout}ms\n`;
              markdown += `**Error:** ${error.message}\n\n`;

              // List some loaded scripts as hints
              const loadedScripts = targetCdpManager.getLoadedScripts();
              if (loadedScripts.length > 0) {
                markdown += `**Currently Loaded Scripts (first 10):**\n`;
                loadedScripts.slice(0, 10).forEach(url => {
                  markdown += `- \`${url}\`\n`;
                });
                if (loadedScripts.length > 10) {
                  markdown += `- ... and ${loadedScripts.length - 10} more\n`;
                }
                markdown += `\n`;
              }

              markdown += `**Suggestions:**\n`;
              markdown += `- Check that the URL pattern is correct\n`;
              markdown += `- Use \`navigate({ action: 'goto' })\` to load the page containing the script\n`;
              markdown += `- Increase the timeout if the script loads slowly`;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
                isError: true,
              };
            }
          }

          case 'setDOMBreakpoint': {
            if (!args.selector) {
              return createErrorResponse('INVALID_PARAMS', { message: 'selector is required for setDOMBreakpoint action' });
            }
            if (!args.domBreakpointType) {
              return createErrorResponse('INVALID_PARAMS', { message: 'domBreakpointType is required for setDOMBreakpoint action' });
            }

            // Check connection
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              // Resolve selector to nodeId
              const nodeId = await targetCdpManager.resolveSelector(args.selector);

              // Set the DOM breakpoint
              const breakpoint = await targetCdpManager.setDOMBreakpoint(nodeId, args.domBreakpointType, args.selector);

              // Build success response
              let markdown = `## DOM Breakpoint Set\n\n`;
              markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
              markdown += `**Selector:** \`${args.selector}\`\n`;
              markdown += `**Break on:** ${args.domBreakpointType}\n`;
              markdown += `**Node ID:** ${nodeId}\n\n`;

              const breakTypeDesc: Record<string, string> = {
                'subtree-modified': 'Execution will pause when children of this element are added, removed, or modified.',
                'attribute-modified': 'Execution will pause when any attribute of this element changes (class, style, data-*, etc.).',
                'node-removed': 'Execution will pause when this element is removed from the DOM.',
              };
              markdown += `**Note:** ${breakTypeDesc[args.domBreakpointType]}\n\n`;
              markdown += `**Warning:** DOM breakpoints use internal nodeIds which are invalidated on page reload. You'll need to re-set this breakpoint after navigating.`;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
              };
            } catch (error: any) {
              let markdown = `## Failed to Set DOM Breakpoint\n\n`;
              markdown += `**Error:** ${error.message}\n\n`;
              markdown += `**Selector:** \`${args.selector}\`\n`;
              markdown += `**Break Type:** ${args.domBreakpointType}\n\n`;

              if (error.message.includes('not found')) {
                markdown += `**Suggestion:** The element was not found. Verify the selector matches an element currently in the DOM.`;
              } else {
                markdown += `**Suggestion:** Ensure the page is loaded and the element exists in the DOM.`;
              }

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
                isError: true,
              };
            }
          }

          case 'setEventBreakpoint': {
            if (!args.eventName) {
              return createErrorResponse('INVALID_PARAMS', { message: 'eventName is required for setEventBreakpoint action' });
            }

            // Check connection
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const breakpoint = await targetCdpManager.setEventListenerBreakpoint(args.eventName, args.targetName);

              // Build success response
              let markdown = `## Event Listener Breakpoint Set\n\n`;
              markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
              markdown += `**Event:** \`${args.eventName}\`\n`;
              if (args.targetName) {
                markdown += `**Target:** ${args.targetName}\n`;
              } else {
                markdown += `**Target:** All elements\n`;
              }
              markdown += `\n**Note:** Execution will pause whenever a \`${args.eventName}\` event is dispatched.\n\n`;
              markdown += `**Common events:** click, submit, input, change, keydown, keyup, mousedown, touchstart, load, DOMContentLoaded`;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
              };
            } catch (error: any) {
              return {
                content: [{
                  type: 'text',
                  text: `## Failed to Set Event Breakpoint\n\n**Error:** ${error.message}\n\n**Event:** \`${args.eventName}\``,
                }],
                isError: true,
              };
            }
          }

          case 'setXHRBreakpoint': {
            if (!args.urlPattern) {
              return createErrorResponse('INVALID_PARAMS', { message: 'urlPattern is required for setXHRBreakpoint action' });
            }

            // Check connection
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            try {
              const breakpoint = await targetCdpManager.setXHRBreakpoint(args.urlPattern);

              // Build success response
              let markdown = `## XHR/Fetch Breakpoint Set\n\n`;
              markdown += `**Breakpoint ID:** \`${breakpoint.breakpointId}\`\n`;
              markdown += `**URL Pattern:** \`${args.urlPattern}\`\n\n`;
              markdown += `**Note:** Execution will pause when any XHR or Fetch request URL contains \`${args.urlPattern}\`.\n\n`;
              markdown += `**Examples:** If pattern is \`/api/users\`, it will match:\n`;
              markdown += `- \`https://example.com/api/users\`\n`;
              markdown += `- \`https://example.com/api/users/123\`\n`;
              markdown += `- \`/api/users?page=1\``;

              return {
                content: [{
                  type: 'text',
                  text: markdown,
                }],
              };
            } catch (error: any) {
              return {
                content: [{
                  type: 'text',
                  text: `## Failed to Set XHR Breakpoint\n\n**Error:** ${error.message}\n\n**URL Pattern:** \`${args.urlPattern}\``,
                }],
                isError: true,
              };
            }
          }

          case 'await': {
            // Wait for any breakpoint to be hit, or set one first if url/lineNumber provided
            if (!targetCdpManager.isConnected()) {
              return createErrorResponse('DEBUGGER_NOT_CONNECTED');
            }

            // Already cancelled: never start waiting. (An already-aborted
            // signal fires no 'abort' event, so the listener below would
            // never resolve and this would block until pause/timeout.)
            throwIfAborted(abortSignal);

            // Track if we created a breakpoint (for cleanup on abort/timeout)
            let createdBreakpoint: { breakpointId: string; url: string; line: number; column?: number } | null = null;

            const timeout = args.timeout || 300000; // Default 5 minutes

            // IMPORTANT: Start listening for pause BEFORE setting breakpoint
            // This prevents race condition where breakpoint triggers immediately
            // and pause event fires before we've registered the resolver
            let onAbort: (() => void) | undefined;
            const waitPromise = new Promise<{ type: 'paused' | 'aborted' | 'timeout' }>((resolve) => {
              // Set up abort handler (detached in the finally below - the
              // signal may be a long-lived run signal that outlives this step)
              if (abortSignal) {
                onAbort = () => resolve({ type: 'aborted' });
                abortSignal.addEventListener('abort', onAbort, { once: true });
              }

              // Wait for pause - registered before breakpoint is set
              targetCdpManager.waitForPause(timeout)
                .then(() => resolve({ type: 'paused' }))
                .catch(() => resolve({ type: 'timeout' }));
            });

            // Everything below runs inside a try/finally so the abort listener
            // is detached on EVERY exit (including the early return when
            // setBreakpoint fails): abortSignal is typically the replay run's
            // long-lived signal, and a leaked listener per step accumulates
            // for the whole run.
            try {
              // If url and lineNumber provided, set a breakpoint (after listener is registered)
              if (args.url && args.lineNumber !== undefined) {
                // Resolve source maps for TypeScript files
                const resolved = await resolveBreakpointLocation(
                  args.url, args.lineNumber, args.columnNumber,
                  targetCdpManager, sourceMapHandler
                );

                try {
                  const breakpoint = await targetCdpManager.setBreakpoint(resolved.url, resolved.line, resolved.column, args.condition);
                  const resolvedLine = breakpoint.location.lineNumber + 1;
                  const resolvedColumn = breakpoint.location.columnNumber !== undefined
                    ? breakpoint.location.columnNumber + 1
                    : undefined;
                  createdBreakpoint = {
                    breakpointId: breakpoint.breakpointId,
                    url: resolved.url,
                    line: resolvedLine,
                    column: resolvedColumn
                  };
                } catch (error: any) {
                  if (isAbortError(error)) throw error;
                  return {
                    content: [{
                      type: 'text',
                      text: `## Failed to Set Await Breakpoint\n\n**Error:** ${error.message}\n\n**Location:** \`${resolved.url}:${resolved.line}\``,
                    }],
                    isError: true,
                  };
                }
              }

              try {
                const result = await waitPromise;

                if (result.type === 'aborted') {
                  // Clean up breakpoint on abort (only if we created one) BEFORE
                  // throwing: a one-shot await breakpoint left behind would pause
                  // the target the next time that line runs, long after the user
                  // cancelled.
                  if (createdBreakpoint) {
                    try {
                      await targetCdpManager.removeBreakpoint(createdBreakpoint.breakpointId);
                    } catch {
                      // Ignore cleanup errors
                    }
                  }

                  // THROW, don't return (#110): this used to resolve a
                  // success-SHAPED response (no isError), so a cancelled
                  // `breakpoint.await` step was recorded `success: true` - a
                  // cancelled step reported as passed. Throwing abort-shaped is
                  // the same contract every other cancellable handler uses, and
                  // the replay executor classifies it as
                  // "Replay aborted by user".
                  throw abortErrorFor(abortSignal!);
                }

                if (result.type === 'timeout') {
                  let timeoutMsg = `## Breakpoint Await Timeout\n\n`;
                  timeoutMsg += `No breakpoint was hit within ${timeout / 1000} seconds.\n\n`;
                  if (createdBreakpoint) {
                    timeoutMsg += `**Note:** The breakpoint at \`${createdBreakpoint.url}:${createdBreakpoint.line}\` is still active.\n`;
                    timeoutMsg += `Use \`breakpoint({ action: 'remove', breakpointId: '${createdBreakpoint.breakpointId}' })\` to remove it.`;
                  }

                  return {
                    content: [{
                      type: 'text',
                      text: timeoutMsg,
                    }],
                    isError: true,
                  };
                }

                // Paused - get call stack info
                const pauseInfo = targetCdpManager.getPausedInfo();

                // If we created a breakpoint, remove it so it doesn't hit again on resume
                if (createdBreakpoint) {
                  try {
                    await targetCdpManager.removeBreakpoint(createdBreakpoint.breakpointId);
                  } catch {
                    // Ignore removal errors
                  }
                }

                let markdown = `## Breakpoint Hit!\n\n`;

                if (pauseInfo.paused && pauseInfo.callStack && pauseInfo.callStack.length > 0) {
                  const topFrame = pauseInfo.callStack[0];
                  const hitUrl = targetCdpManager.getScriptUrl(topFrame.location.scriptId) || 'unknown';
                  const hitLine = topFrame.location.lineNumber + 1;
                  const hitColumn = topFrame.location.columnNumber !== undefined ? topFrame.location.columnNumber + 1 : undefined;

                  markdown += `**Location:** \`${hitUrl}:${hitLine}${hitColumn ? `:${hitColumn}` : ''}\`\n`;
                  if (createdBreakpoint) {
                    markdown += `**Created breakpoint removed** (one-shot)\n\n`;
                  }
                  markdown += `**Paused at:** \`${topFrame.functionName || '(anonymous)'}\`\n`;
                  markdown += `**Call Frame ID:** \`${topFrame.callFrameId}\`\n\n`;
                  markdown += `**Next steps:**\n`;
                  markdown += `- \`inspect({ action: 'getVariables', callFrameId: '${topFrame.callFrameId}'${on} })\` - View variables\n`;
                  markdown += `- \`inspect({ action: 'evaluateExpression', expression: '...'${on} })\` - Evaluate code\n`;
                  markdown += `- \`execution({ action: 'stepOver'${on} })\` - Step to next line\n`;
                  markdown += `- \`execution({ action: 'resume'${on} })\` - Continue execution\n`;
                } else {
                  markdown += `Execution paused but no call stack available.\n`;
                }

                return {
                  content: [{
                    type: 'text',
                    text: markdown,
                  }],
                };
              } catch (error: any) {
                // The universal trap: this broad catch would otherwise swallow
                // the abort thrown just above and report it as an await
                // *failure*. A cancellation is not a failure of this tool.
                if (isAbortError(error)) throw error;
                return {
                  content: [{
                    type: 'text',
                    text: `## Await Breakpoint Error\n\n**Error:** ${error.message}`,
                  }],
                  isError: true,
                };
              }
            } finally {
              // Detach the abort listener. The waitForPause resolver it raced
              // stays registered inside cdp-manager until its own timeout
              // fires; that is harmless (resolving an already-settled promise
              // is a no-op and its rejection is caught) but it does mean the
              // 'await' step's timer outlives the cancel.
              if (abortSignal && onAbort) {
                abortSignal.removeEventListener('abort', onAbort);
              }
            }
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
