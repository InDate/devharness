/**
 * Console Monitoring Tools
 */

import { z } from 'zod';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { ConsoleMonitor, StoredConsoleMessage } from '../console-monitor.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import {
  DEFAULT_SUMMARY_TOKEN_BUDGET,
  estimateTokens,
  createMessagePreview,
  createMessageSummary,
  formatPreviewsWithStats,
  buildListResponseText,
  generateSummaryHints,
  extractTextPortion,
  extractArgByIndex,
  formatSummaryAsToon,
  formatMessageDetailAsToon,
} from '../formatters/console-formatter.js';
import { formatCodeBlock } from '../messages.js';
import {
  getWorkerTargetRegistry,
  WorkerTargetAmbiguousError,
  WorkerTargetNotFoundError,
} from '../worker-targets.js';

/**
 * Console output recorded from a worker's own target. The page's listeners
 * never see it - a worker's console reaches no page context.
 */
async function handleWorkerConsole(connection: any, args: ConsoleArgs) {
  const target = args.target!;
  const host = connection?.host;
  const port = connection?.port;
  if (!host || !port) return createErrorResponse('DEBUGGER_NOT_CONNECTED');
  try {
    const all = await getWorkerTargetRegistry(host, port).messages(target);
    const limit = args.action === 'recent' ? (args.count ?? 50) : (args.limit ?? 100);
    const filtered = args.type ? all.filter((m) => m.type === args.type) : all;
    const shown = filtered.slice(-limit);
    const rows = shown.length
      ? shown.map((m) => `${m.type}\t${m.text}`).join('\n')
      : 'none';
    return createSuccessResponse('WORKER_CONSOLE_LISTED', {
      target,
      count: shown.length.toString(),
      messages: formatCodeBlock(rows),
    });
  } catch (error) {
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
    return createErrorResponse('WORKER_EVALUATE_FAILED', { target, error: `${error}` });
  }
}

// =============================================================================
// Schema
// =============================================================================

const consoleSchema = z.object({
  action: z.enum(['list', 'get', 'recent', 'search', 'clear', 'setObjectDepth'])
    .describe('Console action: list, get, recent, search, clear, setObjectDepth'),
  connectionReason: z.string()
    .describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),

  // Shared filters
  type: z.string().optional()
    .describe('Message type filter (log, error, warn, etc.)'),
  limit: z.number().optional()
    .describe('Max messages to return (list: default 100; search: default 50). recent takes count'),

  target: z.string().optional()
    .describe('Worker target whose console to read - a target id from inspect({action:"listTargets"}), or a substring of its URL. Recording starts at first attach, so output emitted before that is not held'),

  // list-specific
  offset: z.number().optional()
    .describe('Messages to skip (for list action, default: 0)'),

  // get-specific
  id: z.string().optional()
    .describe('Message ID (required for get)'),
  full: z.boolean().optional()
    .describe('Return full message without smart truncation (default: false)'),
  textOffset: z.number().optional()
    .describe('Character offset for text extraction'),
  textLimit: z.number().optional()
    .describe('Max characters to return from text'),
  argsIndex: z.number().optional()
    .describe('Specific args array index to return'),

  // search-specific
  pattern: z.string().optional()
    .describe('Regex pattern (required for search)'),
  flags: z.string().optional()
    .describe('Regex flags (default: "")'),

  // recent-specific
  count: z.number().optional()
    .describe('Number of recent messages (default: 50)'),

  // clear-specific
  reason: z.string().optional()
    .describe('Why console needs clearing (required for clear)'),

  // setObjectDepth-specific
  depth: z.number().optional()
    .describe('Object expansion depth 1-10 (default: 2)'),
}).strict();

type ConsoleArgs = z.infer<typeof consoleSchema>;

// =============================================================================
// Validation
// =============================================================================

const REQUIRED_PARAMS: Record<string, { param: keyof ConsoleArgs; message: string }> = {
  get: { param: 'id', message: 'The "get" action requires an "id" parameter' },
  search: { param: 'pattern', message: 'The "search" action requires a "pattern" parameter' },
  clear: { param: 'reason', message: 'The "clear" action requires a "reason" parameter' },
  setObjectDepth: { param: 'depth', message: 'The "setObjectDepth" action requires a "depth" parameter (1-10)' },
};

function validateRequiredParams(args: ConsoleArgs): ReturnType<typeof createErrorResponse> | null {
  const requirement = REQUIRED_PARAMS[args.action];
  if (requirement && args[requirement.param] === undefined) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: args.action,
      missing: requirement.param,
      message: requirement.message,
    });
  }
  return null;
}

// =============================================================================
// Helpers
// =============================================================================

function ensureMonitoring(monitor: ConsoleMonitor, manager: PuppeteerManager | null): void {
  if (!monitor.isActive() && manager?.isConnected()) {
    monitor.startMonitoring(manager.getPage());
  }
}

function buildListResponse(
  messages: StoredConsoleMessage[],
  headerText: string,
  action: string,
  monitor: ConsoleMonitor
) {
  const previews = messages.map(createMessagePreview);
  const { csv, truncatedCount, totalTokens } = formatPreviewsWithStats(previews);

  return {
    content: [{ type: 'text' as const, text: buildListResponseText(headerText, csv, truncatedCount, totalTokens) }],
    _meta: {
      tool: 'console',
      action,
      timestamp: Date.now(),
      console: {
        totalCount: monitor.getCount(),
        matchCount: messages.length,
        errorCount: monitor.getCount('error'),
        warnCount: monitor.getCount('warn'),
        truncatedCount,
        totalTokens,
        entries: messages.map(m => ({
          id: m.id, type: m.type,
          ...(m.location?.url && { url: m.location.url }),
          // Read by click validation to tell a failed request from a script error.
          ...(typeof m.text === 'string' ? { text: m.text.slice(0, 200) } : {}),
        })),
      },
    },
  };
}

// =============================================================================
// Action Handlers
// =============================================================================

function handleList(monitor: ConsoleMonitor, manager: PuppeteerManager | null, args: ConsoleArgs) {
  ensureMonitoring(monitor, manager);

  const messages = monitor.getMessages({
    type: args.type,
    limit: args.limit ?? 100,
    offset: args.offset ?? 0,
  });

  const totalCount = monitor.getCount(args.type);
  const typeInfo = args.type ? ` (type: ${args.type})` : '';
  const header = `Console Messages: ${messages.length} of ${totalCount}${typeInfo}`;

  return buildListResponse(messages, header, 'list', monitor);
}

function handleRecent(monitor: ConsoleMonitor, manager: PuppeteerManager | null, args: ConsoleArgs) {
  ensureMonitoring(monitor, manager);

  const requestedCount = args.count ?? 50;
  const messages = monitor.getRecentMessages(requestedCount, args.type);

  const totalCount = monitor.getCount(args.type);
  const typeInfo = args.type ? ` (type: ${args.type})` : '';
  const header = `Recent Console Messages: ${messages.length} of ${requestedCount} requested (${totalCount} total)${typeInfo}`;

  return buildListResponse(messages, header, 'recent', monitor);
}

function handleSearch(monitor: ConsoleMonitor, manager: PuppeteerManager | null, args: ConsoleArgs) {
  ensureMonitoring(monitor, manager);

  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern!, args.flags ?? '');
  } catch (error) {
    return createErrorResponse('INVALID_PATTERN', { message: `Invalid regex: ${error}` });
  }

  const allMessages = monitor.getMessages({ type: args.type });
  const matches = allMessages
    .filter((msg: StoredConsoleMessage) => regex.test(msg.text))
    .slice(0, args.limit ?? 50);

  const typeInfo = args.type ? ` (type: ${args.type})` : '';
  const header = `Console Search: ${matches.length} matches for /${args.pattern}/${args.flags ?? ''} (searched ${allMessages.length})${typeInfo}`;

  return buildListResponse(matches, header, 'search', monitor);
}

function handleGet(monitor: ConsoleMonitor, args: ConsoleArgs) {
  const message = monitor.getMessage(args.id!);
  if (!message) {
    return createErrorResponse('NOT_FOUND', {
      message: `Console message ${args.id} not found. Use action "list" to see available messages.`,
    });
  }

  const hasExtractionParams = args.textOffset !== undefined || args.textLimit !== undefined || args.argsIndex !== undefined;
  const wantsFull = args.full === true;
  const fullTokens = estimateTokens({ text: message.text, args: message.args, stackTrace: message.stackTrace });

  // Smart summary mode: large message without explicit extraction or full flag
  if (!hasExtractionParams && !wantsFull && fullTokens > DEFAULT_SUMMARY_TOKEN_BUDGET) {
    const summary = createMessageSummary(message, DEFAULT_SUMMARY_TOKEN_BUDGET);
    const hints = generateSummaryHints(summary);
    const toon = formatSummaryAsToon(summary);

    return {
      content: [{
        type: 'text' as const,
        text: `Console [${message.id}] ${message.type} - ${summary._tokens.returned}/${summary._tokens.full} tokens${hints}\n\n\`\`\`toon\n${toon}\n\`\`\``,
      }],
    };
  }

  // Full/extraction mode
  const textResult = extractTextPortion(message.text, args.textOffset, args.textLimit);

  let argsData = message.args;
  let argsExtraction: { index: number; total: number } | undefined;

  if (args.argsIndex !== undefined) {
    const argResult = extractArgByIndex(message.args, args.argsIndex);
    if ('error' in argResult) {
      return createErrorResponse('INVALID_PARAMETER', { message: argResult.error });
    }
    argsData = argResult.args;
    argsExtraction = argResult.extraction;
  }

  const data = {
    id: message.id,
    type: message.type,
    text: textResult.text,
    args: argsData,
    location: message.location,
    stackTrace: message.stackTrace,
    timestamp: message.timestamp,
    _tokens: { full: fullTokens, returned: estimateTokens({ text: textResult.text, args: argsData }) },
    _textExtraction: textResult.extraction,
    _argsExtraction: argsExtraction,
  };

  const toon = formatMessageDetailAsToon(data);

  return {
    content: [{
      type: 'text' as const,
      text: `Console [${message.id}] ${message.type} - ${data._tokens.returned}/${data._tokens.full} tokens\n\n\`\`\`toon\n${toon}\n\`\`\``,
    }],
  };
}

function handleClear(monitor: ConsoleMonitor, connectionReason: string, reason: string) {
  console.error(`[devharness] console clear - Reason: ${reason}, Connection: ${connectionReason}`);
  const count = monitor.getCount();
  monitor.clear();
  return createSuccessResponse('CONSOLE_CLEARED', { count });
}

function handleSetObjectDepth(monitor: ConsoleMonitor, depth: number) {
  const oldDepth = monitor.getConsoleObjectDepth();
  monitor.setConsoleObjectDepth(depth);
  return {
    content: [{
      type: 'text' as const,
      text: `Console object depth: ${oldDepth} → ${monitor.getConsoleObjectDepth()}`,
    }],
  };
}

// =============================================================================
// Tool Export
// =============================================================================

export function createConsoleTools(
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    console: createTool(
      'Monitor and manage console messages, from the page or from a worker via `target`. Actions: list, get, recent, search, clear, setObjectDepth',
      consoleSchema,
      async (args: ConsoleArgs) => {
        // Validate required params
        const validationError = validateRequiredParams(args);
        if (validationError) return validationError;

        // Resolve connection
        const resolved = await resolveConnectionFromReason(args.connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: `No connection named "${args.connectionReason}". \`connection({ action: 'list' })\` lists the connections this session holds.`,
          });
        }

        const monitor = resolved.consoleMonitor;
        const manager = resolved.puppeteerManager;

        // A worker's console belongs to its own target and reaches no page
        // listener, so it comes from that target's own client.
        if (args.target) {
          if (args.action !== 'list' && args.action !== 'recent') {
            return createErrorResponse('INVALID_ACTION', {
              action: `${args.action} with target`,
            });
          }
          return await handleWorkerConsole(resolved.connection, args);
        }

        // Dispatch
        switch (args.action) {
          case 'list': return handleList(monitor, manager, args);
          case 'recent': return handleRecent(monitor, manager, args);
          case 'search': return handleSearch(monitor, manager, args);
          case 'get': return handleGet(monitor, args);
          case 'clear': return handleClear(monitor, args.connectionReason, args.reason!);
          case 'setObjectDepth': return handleSetObjectDepth(monitor, args.depth!);
          default: return createErrorResponse('INVALID_ACTION', { action: args.action });
        }
      }
    ),
  };
}
