/**
 * Logpoint Execution Tracker
 * Monitors logpoint executions and enforces execution limits
 *
 * Each logpoint belongs to the debugger of the connection it was set on. CDP
 * builds a breakpoint id from its line, column and URL, so two tabs logging
 * the same line hold the same id, and a message from one tab carries the same
 * location text as the other's: both are told apart by that owner.
 */

import type { StoredConsoleMessage } from './console-monitor.js';

export interface LogpointMetadata {
  breakpointId: string;
  url: string;
  lineNumber: number;
  logMessage: string;
  maxExecutions: number;
  executionCount: number;
  logs: StoredConsoleMessage[];
}

/** The debugger a logpoint was set on, which pauses when the logpoint reaches its limit. */
export interface LogpointOwner {
  handleLogpointLimitExceeded(metadata: LogpointMetadata): Promise<void>;
}

export class LogpointExecutionTracker {
  private logpoints: Map<LogpointOwner, Map<string, LogpointMetadata>> = new Map();

  /**
   * Register a new logpoint for tracking
   */
  registerLogpoint(
    owner: LogpointOwner,
    breakpointId: string,
    url: string,
    lineNumber: number,
    logMessage: string,
    maxExecutions: number
  ): void {
    const owned = this.logpoints.get(owner) ?? new Map<string, LogpointMetadata>();
    owned.set(breakpointId, {
      breakpointId,
      url,
      lineNumber,
      logMessage,
      maxExecutions,
      executionCount: 0,
      logs: [],
    });
    this.logpoints.set(owner, owned);
  }

  /**
   * Unregister a logpoint
   */
  unregisterLogpoint(owner: LogpointOwner, breakpointId: string): void {
    this.logpoints.get(owner)?.delete(breakpointId);
  }

  /**
   * Reset the execution counter for a logpoint
   */
  resetCounter(owner: LogpointOwner, breakpointId: string): void {
    const metadata = this.getLogpoint(owner, breakpointId);
    if (metadata) {
      metadata.executionCount = 0;
      metadata.logs = [];
    }
  }

  /**
   * Get metadata for a specific logpoint
   */
  getLogpoint(owner: LogpointOwner, breakpointId: string): LogpointMetadata | undefined {
    return this.logpoints.get(owner)?.get(breakpointId);
  }

  /**
   * Get all registered logpoints
   */
  getAllLogpoints(): LogpointMetadata[] {
    return [...this.logpoints.values()].flatMap(owned => [...owned.values()]);
  }

  /**
   * Handle a console message from the connection whose debugger is `source`,
   * counting it toward that connection's logpoint at the message's location.
   */
  handleConsoleMessage(message: StoredConsoleMessage, source: LogpointOwner): void {
    // Check if this is a logpoint message
    if (!message.text.startsWith('[Logpoint]')) {
      return;
    }

    // Parse location from message text since console messages from breakpoint conditions
    // don't preserve the original source location
    // Format: "[Logpoint] file:///path/to/file.js:12:auto: message..."
    const locationMatch = message.text.match(/\[Logpoint\]\s+(.+?):(\d+)(?::(?:auto|\d+))?:/);
    if (!locationMatch) {
      return;
    }

    const messageUrl = locationMatch[1];
    const messageLine = parseInt(locationMatch[2], 10);

    for (const metadata of this.logpoints.get(source)?.values() ?? []) {
      if (
        this.urlsMatch(messageUrl, metadata.url) &&
        messageLine === metadata.lineNumber
      ) {
        metadata.executionCount++;
        metadata.logs.push(message);

        if (metadata.executionCount >= metadata.maxExecutions) {
          void source.handleLogpointLimitExceeded(metadata).catch(() => {
            // A connection that closed as its limit landed has nothing left to pause.
          });
        }

        break; // Only match to one logpoint
      }
    }
  }

  /**
   * Helper to match URLs (handle file:// vs http:// and normalization)
   */
  private urlsMatch(url1: string, url2: string): boolean {
    // Normalize URLs for comparison
    const normalize = (url: string) => {
      // Remove trailing slashes
      return url.replace(/\/$/, '');
    };

    return normalize(url1) === normalize(url2);
  }

  /**
   * Clear all tracked logpoints
   */
  clear(): void {
    this.logpoints.clear();
  }
}
