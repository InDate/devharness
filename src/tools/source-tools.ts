/**
 * `source` reads a script's code by line range and registers source maps
 * from a directory.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const sourceSchema = z.object({
  action: z.enum(['get', 'loadMaps']),
  url: z.string().optional().describe('get: file URL or path'),
  startLine: z.number().optional().describe('get: start line number'),
  endLine: z.number().optional().describe('get: end line number'),
  directory: z.string().optional().describe('loadMaps: the directory whose .js.map files, subdirectories included, are registered'),
  connectionReason: z.string().optional().describe('get: the connection, by the name connection launch or attach gave it'),
}).strict();

type SourceArgs = z.infer<typeof sourceSchema>;

export function createSourceTools(
  sourceMapHandler: SourceMapHandler,
  resolveConnectionFromReason: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  const get = async (args: SourceArgs): Promise<any> => {
    const { startLine, endLine } = args;
    const url = args.url!;

    const resolved = await resolveConnectionFromReason(args.connectionReason!);
    if (!resolved) {
      return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connectionReason });
    }
    const targetCdpManager = resolved.cdpManager;

    try {
      const sourceCode = await targetCdpManager.getSourceCode(url, startLine, endLine);

      // The code arrives numbered; a string is appended to the reply as it is,
      // where an object would be rendered as JSON.
      const metadata = `Total lines: ${sourceCode.totalLines}${sourceCode.hasSourceMap ? ' (source map available)' : ''}`;
      const codeBlock = '```javascript\n' + sourceCode.code + '\n```';

      return createSuccessResponse('SOURCE_CODE_SUCCESS', {
        url,
        startLine: sourceCode.startLine.toString(),
        endLine: sourceCode.endLine.toString(),
      }, metadata + '\n\n' + codeBlock);
    } catch (error) {
      return createErrorResponse('SOURCE_CODE_FAILED', { error: `${error}` });
    }
  };

  const loadMaps = async (args: SourceArgs): Promise<any> => {
    const directory = args.directory!;
    // The registration reads a missing directory as holding no maps, which
    // would report a mistyped path as a directory with none in it.
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat?.isDirectory()) {
      return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${directory} is not a directory` });
    }
    try {
      const registered = await sourceMapHandler.registerSourceMapsFromDirectory(directory);
      return createSuccessResponse('SOURCE_MAPS_LOADED', {
        count: registered.toString(),
        directory
      }, { registered });
    } catch (error) {
      return createErrorResponse('SOURCE_MAPS_FAILED', { error: `${error}` });
    }
  };

  /** Parameters each action cannot run without, checked before it runs. */
  const REQUIRED: Record<SourceArgs['action'], Array<keyof SourceArgs>> = {
    get: ['url', 'connectionReason'],
    loadMaps: ['directory'],
  };

  return {
    source: createTool(
      'Read source code and load source maps. Actions: get (a script\'s code over a line range, 10 lines from startLine when endLine is omitted), loadMaps (register the .js.map files in a directory and its subdirectories; each loads when first needed)',
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
