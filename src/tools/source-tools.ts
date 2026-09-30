/**
 * Source Code Tools
 */

import { z } from 'zod';
import { CDPManager } from '../cdp-manager.js';
import { SourceMapHandler } from '../sourcemap-handler.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

// Schema for getSourceCode
const getSourceCodeSchema = z.object({
  url: z.string().describe('File URL or path'),
  startLine: z.number().optional().describe('Start line number'),
  endLine: z.number().optional().describe('End line number'),
  connectionReason: z.string().optional().describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
}).strict();

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
  return {
    getSourceCode: createTool(
      'Get source code at line range',
      getSourceCodeSchema,
      async (args) => {
        const { url, startLine, endLine, connectionReason } = args;

        // Resolve connection if connectionReason is provided
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
      }
    ),
  };
}
