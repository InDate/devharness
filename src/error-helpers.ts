/**
 * The check every browser tool makes before it acts: that the Chrome behind
 * the connection is still running, that the debugger and Puppeteer are
 * connected, that the target is a browser and not Node.js, and, where the
 * tool needs one, that a page has been loaded.
 */

import { blankPageUrl } from './utils/blank-page.js';
import type { CDPManager } from './cdp-manager.js';
import type { PuppeteerManager } from './puppeteer-manager.js';
import type { ChromeLauncher } from './chrome-launcher.js';
import type { Connection } from './connection-manager.js';
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
  browser?: Pick<Connection, 'port' | 'createdAt'>,
  requirePageLoad?: boolean
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | null {
  // A Chrome devharness spawned is checked by its process; one it attached to
  // has no process here, so it reads as gone only once a Chrome devharness
  // spawned on that port has closed since the connection was made.
  if (chromeLauncherRef && browser) {
    const gone = chromeLauncherRef.spawnedOn(browser.port)
      ? !chromeLauncherRef.isRunning(browser.port)
      : chromeLauncherRef.closedSince(browser.port, browser.createdAt);
    if (gone) {
      return createErrorResponse('CHROME_NOT_RUNNING', {
        port: browser.port,
        message: `Chrome is not running on port ${browser.port}. Start one with \`connection({ action: 'launch' })\`.`
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
    if (blankPageUrl(url)) {
      return createErrorResponse('PAGE_NOT_LOADED', { toolName });
    }
  }

  return null;
}
