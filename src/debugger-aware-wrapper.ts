/**
 * Debugger-Aware Action Wrapper
 * Wraps Puppeteer/CDP actions to detect and handle breakpoint pauses
 */

import type { CDPManager } from './cdp-manager.js';
import { isAbortError } from './utils/abort.js';
import { createErrorResponse } from './messages.js';

export interface ActionResult<T = any> {
  success: boolean;
  pausedAtBreakpoint?: boolean;
  pauseInfo?: {
    url: string;
    lineNumber: number;
    columnNumber?: number;
    functionName: string;
    callStackDepth: number;
  };
  result?: T;
  error?: string;
}

/**
 * Execute an action with pause detection
 *
 * If the debugger is already paused, returns immediately with error.
 * Otherwise, races the action against pause detection.
 * If a breakpoint is hit during execution, returns pause info immediately.
 *
 * @param cdpManager - The CDP manager instance
 * @param action - The async action to execute
 * @param actionName - Name of the action (for error messages)
 * @param timeout - Timeout in ms (default: 5000)
 * @returns ActionResult with either success/result or pause info
 */
export async function executeWithPauseDetection<T = any>(
  cdpManager: CDPManager,
  action: () => Promise<T>,
  actionName: string,
  timeout: number = 5000
): Promise<ActionResult<T>> {
  // Pre-check: If already paused, return immediately
  if (cdpManager.isPaused()) {
    const pauseInfo = cdpManager.getPausedInfo();
    return {
      success: false,
      pausedAtBreakpoint: true,
      error: `Cannot perform ${actionName} while execution is paused at a breakpoint`,
      pauseInfo: pauseInfo.location ? {
        url: pauseInfo.location.url,
        lineNumber: pauseInfo.location.lineNumber,
        columnNumber: pauseInfo.location.columnNumber,
        functionName: pauseInfo.location.functionName,
        callStackDepth: pauseInfo.callStack?.length || 0,
      } : undefined,
    };
  }

  try {
    // Race the action against pause detection
    const result = await Promise.race([
      // The actual action
      action().then(res => ({ type: 'success' as const, result: res })),

      // waitForPause rejects on timeout, and a rejection settles the race -
      // failing an action still in flight. This arm stays pending instead.
      cdpManager.waitForPause(timeout).then(
        () => ({ type: 'paused' as const }),
        () => new Promise<never>(() => {})
      ),
    ]);

    if (result.type === 'paused') {
      // Breakpoint was hit during execution
      const pauseInfo = cdpManager.getPausedInfo();
      return {
        success: true,
        pausedAtBreakpoint: true,
        pauseInfo: pauseInfo.location ? {
          url: pauseInfo.location.url,
          lineNumber: pauseInfo.location.lineNumber,
          columnNumber: pauseInfo.location.columnNumber,
          functionName: pauseInfo.location.functionName,
          callStackDepth: pauseInfo.callStack?.length || 0,
        } : undefined,
      };
    } else {
      // Action completed successfully without hitting breakpoint
      return {
        success: true,
        pausedAtBreakpoint: false,
        result: result.result,
      };
    }
  } catch (error: any) {
    // A cancellation is not an action failure - swallowing it here would
    // convert the user's cancel into an "ELEMENT_NOT_FOUND"-style error result
    // and let the caller carry on (#110). Rethrow; the tool handler/executor
    // classifies it.
    if (isAbortError(error)) {
      throw error;
    }
    // Action failed - report the actual error
    // Note: Even if we're paused, the action still failed with an error
    const isPaused = cdpManager.isPaused();
    const pauseInfo = isPaused ? cdpManager.getPausedInfo() : null;

    return {
      success: false,
      pausedAtBreakpoint: isPaused,
      error: `${actionName} failed: ${error.message || error}`,
      pauseInfo: pauseInfo?.location ? {
        url: pauseInfo.location.url,
        lineNumber: pauseInfo.location.lineNumber,
        columnNumber: pauseInfo.location.columnNumber,
        functionName: pauseInfo.location.functionName,
        callStackDepth: pauseInfo.callStack?.length || 0,
      } : undefined,
    };
  }
}

/**
 * An absent `result` means the page was paused or the action threw - neither
 * of which is a missing element. Returns undefined when a result came back.
 */
export function actionFailureResponse(
  result: ActionResult,
  actionName: string,
  selector: string
): any | undefined {
  if (result.result !== undefined) return undefined;
  const detail = result.error
    || (result.pausedAtBreakpoint ? `execution is paused at a breakpoint` : 'the action returned nothing');
  return createErrorResponse('ACTION_FAILED', {
    action: actionName,
    selector,
    error: detail,
  });
}

/**
 * Format action result for MCP tool response
 */
export function formatActionResult(result: ActionResult, actionName: string, details?: any): any {
  if (result.pausedAtBreakpoint && result.pauseInfo) {
    return {
      action: actionName,
      pausedAtBreakpoint: true,
      message: `Execution paused at breakpoint during ${actionName}`,
      location: {
        url: result.pauseInfo.url,
        line: result.pauseInfo.lineNumber,
        column: result.pauseInfo.columnNumber,
        function: result.pauseInfo.functionName,
      },
      callStackDepth: result.pauseInfo.callStackDepth,
      hint: 'Use getCallStack() to inspect, stepOver()/stepInto() to continue debugging, or resume() to continue execution',
      ...details,
    };
  }

  if (!result.success) {
    return {
      action: actionName,
      error: result.error,
      ...details,
    };
  }

  return {
    action: actionName,
    success: true,
    ...details,
    ...(result.result ? { result: result.result } : {}),
  };
}
