/**
 * `source` reads a script's code by line range and registers source maps
 * from a directory.
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const sourceSchema = z.object({
  action: z.enum(['get', 'loadMaps']),
  url: z.string().optional().describe('get: file URL or path'),
  startLine: z.number().optional().describe('get: start line number'),
  endLine: z.number().optional().describe('get: end line number'),
  directory: z.string().optional().describe('loadMaps: the directory containing .js.map files'),
  connectionReason: z.string().optional().describe('get: the connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
}).strict();

type SourceArgs = z.infer<typeof sourceSchema>;

export function createSourceTools(
  cdpManager: CDPManager,
  sourceMapHandler: SourceMapHandler,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  const get = async (args: SourceArgs): Promise<any> => {
    const { startLine, endLine, connectionReason } = args;
    const url = args.url!;

    let targetCdpManager = cdpManager;
    if (connectionReason && resolveConnectionFromReason) {
      const resolved = await resolveConnectionFromReason(connectionReason);
      if (!resolved) {
        return createErrorResponse('CONNECTION_NOT_FOUND');
      }
      targetCdpManager = resolved.cdpManager;
    }

    try {
      const sourceCode = await targetCdpManager.getSourceCode(url, startLine, endLine);

      // Build response with code directly (already formatted with line numbers)
      const actualStart = startLine || 1;
      const actualEnd = endLine || (startLine ? Math.min(sourceCode.totalLines, startLine + 9) : sourceCode.totalLines);

      // Pass code as string, not wrapped in object, to avoid JSON stringification
      const metadata = `Total lines: ${sourceCode.totalLines}${sourceCode.hasSourceMap ? ' (source map available)' : ''}`;
      const codeBlock = '```javascript\n' + sourceCode.code + '\n```';

      return createSuccessResponse('SOURCE_CODE_SUCCESS', {
        url,
        startLine: actualStart.toString(),
        endLine: actualEnd.toString(),
      }, metadata + '\n\n' + codeBlock);
    } catch (error) {
      return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
    }
  };

  const loadMaps = async (args: SourceArgs): Promise<any> => {
    const directory = args.directory!;
    try {
      const registered = await sourceMapHandler.registerSourceMapsFromDirectory(directory);
      return createSuccessResponse('SOURCE_MAPS_LOADED', {
        count: registered.toString(),
        directory
      }, { registered, note: 'Source maps registered for lazy loading (will be loaded on demand)' });
    } catch (error) {
      return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${error}` });
    }
  };

  /** Parameters each action cannot run without, checked before it runs. */
  const REQUIRED: Record<SourceArgs['action'], Array<keyof SourceArgs>> = {
    get: ['url'],
    loadMaps: ['directory'],
  };

  return {
    source: createTool(
      'Read source code and load source maps. Actions: get (a script\'s code over a line range), loadMaps (register the .js.map files in a directory)',
      sourceSchema,
      async (args) => {
        const missing = REQUIRED[args.action].filter(key => args[key] === undefined);
        if (missing.length > 0) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: args.action,
            missing: missing.join(', '),
            message: `The "${args.action}" action requires ${missing.map(key => `"${String(key)}"`).join(' and ')}`,
          });
        }
        return args.action === 'get' ? get(args) : loadMaps(args);
      }
    ),
  };
}
