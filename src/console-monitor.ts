/**
 * Console Monitor
 * Tracks console messages from the browser or Node.js debugger
 */

import { Page, ConsoleMessage, JSHandle } from 'puppeteer-core';
import type { CDPConsoleMessage } from './types.js';

export interface StoredConsoleMessage {
  id: string;
  type: string;
  text: string;
  args: any[];
  location?: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  stackTrace?: any;
  timestamp: number;
}

/**
 * Function type for expanding CDP RemoteObject values
 * Used to get full object details via Runtime.getProperties
 * @param objectId - The CDP object ID to expand
 * @param maxDepth - Maximum depth for nested object expansion
 */
export type ValueExpander = (objectId: string, maxDepth: number) => Promise<any>;

export interface ConsoleLogStats {
  totalMessages: number;
  newMessages: number;
  newErrors: number;
  newWarnings: number;
}

export class ConsoleMonitor {
  private messages: StoredConsoleMessage[] = [];
  private messageIdCounter = 0;
  private maxMessages = 1000; // Keep last 1000 messages
  private isMonitoring = false;
  private messageCallbacks: Array<(message: StoredConsoleMessage) => void> = [];
  private valueExpander: ValueExpander | null = null;
  private consoleObjectDepth: number = 2; // Default depth for console object expansion
  private lastSeenCount = 0; // Cursor for tracking new messages since last check
  private lastActivityTime: number = Date.now();

  /**
   * Set a function to expand object values using Runtime.getProperties
   * This enables full object inspection for Node.js console messages
   */
  setValueExpander(expander: ValueExpander | null): void {
    this.valueExpander = expander;
  }

  /**
   * Set the maximum depth for expanding objects in console messages
   * @param depth - Maximum nesting depth (default: 2)
   */
  setConsoleObjectDepth(depth: number): void {
    this.consoleObjectDepth = Math.max(1, Math.min(depth, 10)); // Clamp between 1-10
  }

  /**
   * Get the current console object depth setting
   */
  getConsoleObjectDepth(): number {
    return this.consoleObjectDepth;
  }

  /**
   * Start monitoring console messages on a page
   */
  startMonitoring(page: Page): void {
    // Remove any existing listeners first to avoid duplicates
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');

    // Attach console listener
    page.on('console', (msg: ConsoleMessage) => {
      this.addMessage(msg);
    });

    // Attach uncaught exception listener
    page.on('pageerror', (error: Error) => {
      this.addPageError(error);
    });

    this.isMonitoring = true;
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(page: Page): void {
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
    this.isMonitoring = false;
  }

  /**
   * Add a page error (uncaught exception)
   */
  private addPageError(error: Error): void {
    const id = `console-${this.messageIdCounter++}`;

    const storedMessage: StoredConsoleMessage = {
      id,
      type: 'error',
      text: `Uncaught ${error.message}`,
      args: [],
      stackTrace: error.stack ? error.stack.split('\n').map(line => ({ description: line })) : undefined,
      timestamp: Date.now(),
    };

    this.messages.push(storedMessage);
    this.lastActivityTime = Date.now();

    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(storedMessage);
      } catch (error) {
        // Silently ignore callback errors to prevent disruption
        console.error('[ConsoleMonitor] Error in message callback:', error);
      }
    }
  }

  /**
   * Add a console message from CDP Runtime.consoleAPICalled event
   * This is used for Node.js debugging where Puppeteer's page.on('console') isn't available
   */
  async addCDPConsoleMessage(cdpMessage: CDPConsoleMessage): Promise<void> {
    const id = `console-${this.messageIdCounter++}`;

    // Convert CDP args to serialized format
    const args = await Promise.all(cdpMessage.args.map(async arg => {
      // Primitives have direct value
      if (arg.value !== undefined) {
        return arg.value;
      }

      // Unserializable values (Infinity, NaN, -0, bigint)
      if (arg.unserializableValue) {
        return arg.unserializableValue;
      }

      // If we have a value expander and an objectId, expand the object fully
      if (this.valueExpander && arg.objectId) {
        try {
          return await this.valueExpander(arg.objectId, this.consoleObjectDepth);
        } catch {
          // Fall through to preview/description if expansion fails
        }
      }

      // Try to use preview for objects (if available)
      if (arg.preview?.properties) {
        const props: Record<string, any> = {};
        for (const prop of arg.preview.properties) {
          props[prop.name] = prop.value;
        }
        // Mark if there are more properties not shown
        if (arg.preview.overflow) {
          props['...'] = '(more properties)';
        }
        return props;
      }

      // Fall back to description (e.g., "Object", "Array(3)", "Map(2)")
      if (arg.description) {
        return arg.description;
      }

      return `[${arg.type}]`;
    }));

    // Build text from args (similar to how console.log joins arguments)
    const text = args.map(arg => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');

    // Extract location from stack trace if available
    const location = cdpMessage.stackTrace?.callFrames[0]
      ? {
          url: cdpMessage.stackTrace.callFrames[0].url,
          lineNumber: cdpMessage.stackTrace.callFrames[0].lineNumber,
          columnNumber: cdpMessage.stackTrace.callFrames[0].columnNumber,
        }
      : undefined;

    const storedMessage: StoredConsoleMessage = {
      id,
      type: cdpMessage.type,
      text,
      args,
      location,
      stackTrace: cdpMessage.stackTrace,
      timestamp: cdpMessage.timestamp,
    };

    this.messages.push(storedMessage);
    this.lastActivityTime = Date.now();

    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(storedMessage);
      } catch (error) {
        // Silently ignore callback errors to prevent disruption
        console.error('[ConsoleMonitor] Error in message callback:', error);
      }
    }
  }

  /**
   * Enable monitoring without a Puppeteer page (for Node.js/CDP-only connections)
   * Call this for Node.js debugging connections that will receive messages via addCDPConsoleMessage
   */
  enableWithoutPage(): void {
    this.isMonitoring = true;
  }

  /**
   * Serialize a JSHandle to a JSON-safe value with cycle detection
   */
  private async serializeJSHandle(handle: JSHandle, maxDepth: number = 3, seen: WeakSet<any> = new WeakSet()): Promise<any> {
    if (maxDepth <= 0) {
      return '[Max depth reached]';
    }

    try {
      // Try to get JSON value first
      const jsonValue = await handle.jsonValue();

      // Handle primitives
      if (jsonValue === null || typeof jsonValue !== 'object') {
        return jsonValue;
      }

      // Check for cycles
      if (seen.has(jsonValue)) {
        return '[Circular]';
      }
      seen.add(jsonValue);

      // Handle arrays
      if (Array.isArray(jsonValue)) {
        return await Promise.all(
          jsonValue.slice(0, 100).map(async (item) => {
            if (item && typeof item === 'object') {
              return await this.serializeValue(item, maxDepth - 1, seen);
            }
            return item;
          })
        );
      }

      // Handle objects
      const result: Record<string, any> = {};
      const keys = Object.keys(jsonValue).slice(0, 50); // Limit to 50 properties
      for (const key of keys) {
        const value = (jsonValue as any)[key];
        if (value && typeof value === 'object') {
          result[key] = await this.serializeValue(value, maxDepth - 1, seen);
        } else {
          result[key] = value;
        }
      }
      return result;
    } catch (error) {
      // If serialization fails, try to get a description
      try {
        const properties = await handle.getProperties();
        if (properties.size === 0) {
          return handle.toString();
        }

        const result: any = {};
        let count = 0;
        for (const [key, valueHandle] of properties) {
          if (count++ >= 10) break; // Limit properties for complex objects
          if (key.startsWith('Symbol(')) continue; // Skip symbols

          try {
            result[key] = await valueHandle.jsonValue();
          } catch {
            result[key] = valueHandle.toString();
          }
        }
        return result;
      } catch {
        return handle.toString();
      }
    }
  }

  /**
   * Helper to serialize nested values
   */
  private async serializeValue(value: any, maxDepth: number, seen: WeakSet<any>): Promise<any> {
    if (maxDepth <= 0) {
      return '[Max depth reached]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 100).map(item => {
        if (item && typeof item === 'object') {
          return this.serializeValue(item, maxDepth - 1, seen);
        }
        return item;
      });
    }

    const result: Record<string, any> = {};
    const keys = Object.keys(value).slice(0, 50);
    for (const key of keys) {
      const val = (value as any)[key];
      if (val && typeof val === 'object') {
        result[key] = await this.serializeValue(val, maxDepth - 1, seen);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Add a console message
   */
  private async addMessage(msg: ConsoleMessage): Promise<void> {
    const id = `console-${this.messageIdCounter++}`;

    // Get message arguments with deep serialization
    const args = await Promise.all(
      msg.args().map(async (arg) => {
        return await this.serializeJSHandle(arg);
      })
    );

    const location = msg.location();

    const storedMessage: StoredConsoleMessage = {
      id,
      type: msg.type(),
      text: msg.text(),
      args,
      location: location ? {
        url: location.url || '',
        lineNumber: location.lineNumber || 0,
        columnNumber: location.columnNumber || 0,
      } : undefined,
      stackTrace: msg.stackTrace(),
      timestamp: Date.now(),
    };

    this.messages.push(storedMessage);
    this.lastActivityTime = Date.now();

    // Keep only last N messages
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    // Notify callbacks
    for (const callback of this.messageCallbacks) {
      try {
        callback(storedMessage);
      } catch (error) {
        // Silently ignore callback errors to prevent disruption
        console.error('[ConsoleMonitor] Error in message callback:', error);
      }
    }
  }

  /**
   * Get all messages
   */
  getMessages(filter?: { type?: string; limit?: number; offset?: number }): StoredConsoleMessage[] {
    let filtered = this.messages;

    // Filter by type
    if (filter?.type) {
      filtered = filtered.filter(msg => msg.type === filter.type);
    }

    // Apply offset and limit
    const offset = filter?.offset || 0;
    const limit = filter?.limit || filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get a message by ID
   */
  getMessage(id: string): StoredConsoleMessage | undefined {
    return this.messages.find(msg => msg.id === id);
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
    this.lastSeenCount = 0; // Reset cursor when messages are cleared
    // Don't reset messageIdCounter - prevents ID collisions after clear
  }

  /**
   * Get message count
   */
  getCount(type?: string): number {
    if (type) {
      return this.messages.filter(msg => msg.type === type).length;
    }
    return this.messages.length;
  }

  /**
   * Get log stats with delta tracking (new messages since last check)
   * This updates the cursor so subsequent calls show only newer messages
   */
  getLogStats(): ConsoleLogStats {
    const totalMessages = this.messages.length;
    const newMessages = this.messages.slice(this.lastSeenCount);

    const stats: ConsoleLogStats = {
      totalMessages,
      newMessages: newMessages.length,
      newErrors: newMessages.filter(m => m.type === 'error').length,
      newWarnings: newMessages.filter(m => m.type === 'warn' || m.type === 'warning').length,
    };

    // Update cursor to current position
    this.lastSeenCount = totalMessages;

    return stats;
  }

  /** Does not move the cursor - call it before getLogStats(). */
  peekNewestError(): { text: string; where?: string } | undefined {
    const fresh = this.messages.slice(this.lastSeenCount);
    for (let i = fresh.length - 1; i >= 0; i--) {
      const message = fresh[i];
      if (message.type !== 'error') continue;
      const file = message.location?.url?.split('/').pop();
      return {
        text: (message.text || '').replace(/\s+/g, ' ').trim(),
        ...(file ? { where: `${file}:${message.location!.lineNumber}` } : {}),
      };
    }
    return undefined;
  }

  /**
   * Peek at log stats without updating the cursor
   */
  peekLogStats(): ConsoleLogStats {
    const totalMessages = this.messages.length;
    const newMessages = this.messages.slice(this.lastSeenCount);

    return {
      totalMessages,
      newMessages: newMessages.length,
      newErrors: newMessages.filter(m => m.type === 'error').length,
      newWarnings: newMessages.filter(m => m.type === 'warn' || m.type === 'warning').length,
    };
  }

  /**
   * Get the most recent N messages
   */
  getRecentMessages(count: number = 50, type?: string): StoredConsoleMessage[] {
    let filtered = this.messages;

    if (type) {
      filtered = filtered.filter(msg => msg.type === type);
    }

    return filtered.slice(-count); // Last N messages
  }

  /**
   * Get all messages without pagination
   */
  getAllMessages(type?: string): StoredConsoleMessage[] {
    if (type) {
      return this.messages.filter(msg => msg.type === type);
    }
    return [...this.messages];
  }

  /**
   * Check if monitoring
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Register a callback to be invoked when a console message is added
   */
  onMessage(callback: (message: StoredConsoleMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Remove a callback
   */
  removeMessageCallback(callback: (message: StoredConsoleMessage) => void): void {
    const index = this.messageCallbacks.indexOf(callback);
    if (index !== -1) {
      this.messageCallbacks.splice(index, 1);
    }
  }

  /**
   * Get the timestamp of the last console activity
   */
  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  /**
   * Check if there has been console activity within the specified duration
   * @param withinMs - Duration in milliseconds to check for activity
   */
  hasRecentActivity(withinMs: number): boolean {
    return Date.now() - this.lastActivityTime < withinMs;
  }
}
