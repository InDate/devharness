/**
 * Error Helper Functions
 * Provides structured error responses with helpful suggestions
 */

import type { CDPManager } from './cdp-manager.js';
import type { PuppeteerManager } from './puppeteer-manager.js';
import type { ChromeLauncher } from './chrome-launcher.js';
import { createErrorResponse } from './messages.js';

// Module-level reference to ChromeLauncher (set via setChromeLauncher)
let chromeLauncherRef: ChromeLauncher | null = null;

/**
 * Set the ChromeLauncher reference for process liveness checks
 * Called once during initialization from index.ts
 */
export function setChromeLauncher(launcher: ChromeLauncher): void {
  chromeLauncherRef = launcher;
}

/**
 * Check if browser automation is available and return error if not
 * Returns an MCP error response or null if browser automation is available
 */
export function checkBrowserAutomation(
  cdpManager: CDPManager,
  puppeteerManager: PuppeteerManager | null,
  toolName: string,
  debugPort?: number,
  requirePageLoad?: boolean
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null {
  // First, verify Chrome process is actually running (handles external kills)
  if (chromeLauncherRef && debugPort !== undefined) {
    if (!chromeLauncherRef.isRunning(debugPort)) {
      return createErrorResponse('CHROME_NOT_RUNNING', {
        port: debugPort,
        message: `Chrome is not running on port ${debugPort}. Start one with \`connection({ action: 'launch' })\`.`
      });
    }
  }

  if (!cdpManager.isConnected()) {
    return createErrorResponse('DEBUGGER_NOT_CONNECTED');
  }

  const runtimeType = cdpManager.getRuntimeType();

  if (runtimeType === 'node') {
    return createErrorResponse('NODEJS_NOT_SUPPORTED', { feature: toolName });
  }

  if (!puppeteerManager?.isConnected()) {
    return createErrorResponse('PUPPETEER_NOT_CONNECTED');
  }

  // Check if a page has been loaded (optional)
  if (requirePageLoad) {
    const page = puppeteerManager.getPage();
    const url = page?.url();
    if (!url || url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/') {
      return createErrorResponse('PAGE_NOT_LOADED', { toolName });
    }
  }

  return null;
}

/**
 * Error category for automatic error handling
 */
export interface ErrorCategory {
  category: 'connection' | 'execution' | 'validation' | 'unknown';
  suggestion: string;
}

/**
 * Enhance error messages with helpful context and suggestions
 */
export function enhanceErrorMessage(error: any, context: string): string {
  const errorStr = String(error?.message || error);

  // Detect common error patterns and provide helpful guidance
  if (errorStr.includes('Breakpoint at specified location already exists')) {
    return `${context}: A breakpoint already exists at this location. Remove it first with removeBreakpoint(), or use listBreakpoints() to see all active breakpoints.`;
  }

  if (errorStr.includes('No inspectable targets')) {
    return `${context}: Chrome debugging port is not ready yet. This can happen if Chrome hasn't fully started. Wait 2-3 seconds and try again, or use connection({ action: 'launch' }), which waits for the port itself.`;
  }

  if (errorStr.includes('Cannot find context with specified id')) {
    return `${context}: The execution context is no longer valid. This happens after page navigation or reload. Get a fresh callFrameId with getCallStack().`;
  }

  if (errorStr.includes('Execution context was destroyed')) {
    return `${context}: The page was reloaded or navigated away. Breakpoints may need to be re-set. Check connection({ action: 'status' }) and reconnect if needed.`;
  }

  if (errorStr.includes('Script not found')) {
    return `${context}: The script hasn't been loaded by the runtime yet. Make sure the page has loaded and the script has executed. Use navigateTo() or reloadPage() to trigger script loading.`;
  }

  if (errorStr.includes('Session closed') || errorStr.includes('WebSocket')) {
    return `${context}: The debugging session was closed. Reconnect with connection({ action: 'attach' }) or check whether Chrome crashed with connection({ action: 'browsers' }).`;
  }

  if (errorStr.includes('Not connected to debugger')) {
    return `${context}: No active debugger connection. Use connection({ action: 'launch' }) or connection({ action: 'attach' }) to establish a connection first.`;
  }

  if (errorStr.includes('No active page')) {
    return `${context}: No Puppeteer page is available. This feature requires Chrome (not Node.js). Ensure you're connected to Chrome and not a Node.js runtime.`;
  }

  if (errorStr.includes('Protocol error') && errorStr.includes('Target closed')) {
    return `${context}: The browser tab was closed. Navigate to a new page or reconnect to Chrome.`;
  }

  if (errorStr.includes('timeout') || errorStr.includes('timed out')) {
    return `${context}: Operation timed out. The page may be unresponsive or taking too long to load. Try increasing timeout values or checking page status.`;
  }

  // Generic fallback with context
  return `${context}: ${errorStr}`;
}

/**
 * Categorize errors to help determine appropriate recovery actions
 */
export function categorizeError(error: any): ErrorCategory {
  const errorStr = String(error?.message || error);

  // Connection-related errors
  if (
    errorStr.includes('No inspectable') ||
    errorStr.includes('Session closed') ||
    errorStr.includes('Not connected') ||
    errorStr.includes('WebSocket') ||
    errorStr.includes('Target closed')
  ) {
    return {
      category: 'connection',
      suggestion: "Check connection({ action: 'status' }) or connection({ action: 'browsers' }) and reconnect if needed",
    };
  }

  // Execution context errors (state changed)
  if (
    errorStr.includes('context') ||
    errorStr.includes('destroyed') ||
    errorStr.includes('No active page')
  ) {
    return {
      category: 'execution',
      suggestion: 'The page state has changed. Refresh breakpoints and get new call frames with getCallStack()',
    };
  }

  // Validation errors (bad input or state)
  if (
    errorStr.includes('Script not found') ||
    errorStr.includes('already exists') ||
    errorStr.includes('Invalid') ||
    errorStr.includes('timeout')
  ) {
    return {
      category: 'validation',
      suggestion: "Validate your input parameters and check the current debugger state with connection({ action: 'status' })",
    };
  }

  // Unknown error
  return {
    category: 'unknown',
    suggestion: 'Check the error message for details and verify your debugger connection',
  };
}

/**
 * Create a detailed error response object for MCP tools
 */
export function createDetailedErrorResponse(error: any, context: string): object {
  const enhanced = enhanceErrorMessage(error, context);
  const category = categorizeError(error);

  return {
    success: false,
    error: enhanced,
    errorCategory: category.category,
    suggestion: category.suggestion,
    originalError: String(error?.message || error),
  };
}
