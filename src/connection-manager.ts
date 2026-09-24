/**
 * Connection Manager
 * Manages multiple debugger connections (Chrome, Node.js, etc.)
 */

import { CDPManager } from './cdp-manager.js';
import { getProxy } from './proxy/registry.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import type { RuntimeType } from './types.js';
import type { ChromeLauncher } from './chrome-launcher.js';
import { disposeWorkerTargetRegistry } from './worker-targets.js';

export interface Connection {
  id: string;
  type: RuntimeType;
  cdpManager: CDPManager;
  puppeteerManager?: PuppeteerManager;
  consoleMonitor?: ConsoleMonitor;
  networkMonitor?: NetworkMonitor;
  host: string;
  port: number;
  createdAt: number;
  lastActivityAt: number; // Last time this connection was used
  reference?: string; // User-provided tab reference (e.g., "agent1-wikipedia")
  pageIndex?: number; // Index of the page/tab in the browser
  breakpointPauseAcknowledged?: boolean; // Whether the current breakpoint pause has been acknowledged
}

// Browser instance tracking (multiple connections can share one browser)
interface BrowserInstance {
  host: string;
  port: number;
  connectionIds: string[]; // Connections using this browser
}

export class ConnectionManager {
  private connections: Map<string, Connection> = new Map();
  private browsers: Map<string, BrowserInstance> = new Map(); // Key: "host:port"
  private activeConnectionId: string | null = null;
  private connectionCounter = 0;
  private chromeLauncher?: ChromeLauncher;

  /**
   * Set the Chrome launcher instance for automatic cleanup
   */
  setChromeLauncher(launcher: ChromeLauncher): void {
    this.chromeLauncher = launcher;
  }

  /**
   * Create a new connection (tab)
   */
  createConnection(
    cdpManager: CDPManager,
    puppeteerManager?: PuppeteerManager,
    consoleMonitor?: ConsoleMonitor,
    networkMonitor?: NetworkMonitor,
    host: string = 'localhost',
    port: number = 9222,
    reference?: string,
    pageIndex?: number
  ): string {
    const id = `conn-${++this.connectionCounter}`;
    const type = cdpManager.getRuntimeType();

    const now = Date.now();
    const connection: Connection = {
      id,
      type,
      cdpManager,
      puppeteerManager,
      consoleMonitor,
      networkMonitor,
      host,
      port,
      createdAt: now,
      lastActivityAt: now,
      reference,
      pageIndex,
    };

    this.connections.set(id, connection);

    // A request's initiator is read on this connection's CDP session and the
    // bytes cross a proxy keyed by the same reference, so this is where the
    // two meet. A connection with no proxy reports into nothing.
    if (networkMonitor && reference) {
      networkMonitor.onRequestInitiator = report => {
        getProxy(reference)?.noteInitiator(
          report.method, report.url, report.root, report.at, report.document);
      };
      networkMonitor.onSocketSend = report => {
        getProxy(reference)?.noteSend(
          report.url, report.socket, report.sequence, report.size, report.root, report.at);
      };
      networkMonitor.onRequestOrigin = report => {
        getProxy(reference)?.noteInitiator(report.method, report.url, 'input', report.at);
      };
    }

    // Track browser instance
    const browserKey = `${host}:${port}`;
    if (!this.browsers.has(browserKey)) {
      this.browsers.set(browserKey, {
        host,
        port,
        connectionIds: [id],
      });
    } else {
      this.browsers.get(browserKey)!.connectionIds.push(id);
    }

    // Set as active if it's the first connection
    if (this.connections.size === 1) {
      this.activeConnectionId = id;
    }

    return id;
  }

  /**
   * Check if a browser instance exists at this host:port
   */
  hasBrowser(host: string, port: number): boolean {
    const browserKey = `${host}:${port}`;
    return this.browsers.has(browserKey);
  }

  /**
   * Get all connections for a specific browser
   */
  getConnectionsForBrowser(host: string, port: number): Connection[] {
    const browserKey = `${host}:${port}`;
    const browser = this.browsers.get(browserKey);
    if (!browser) {
      return [];
    }
    return browser.connectionIds
      .map(id => this.connections.get(id))
      .filter((conn): conn is Connection => conn !== undefined);
  }

  /**
   * Find a connection by host/port (e.g. a Node --inspect port). Returns the
   * first match if more than one connection somehow shares the same port.
   */
  findConnectionByPort(host: string, port: number): Connection | null {
    return this.getConnectionsForBrowser(host, port)[0] ?? null;
  }

  /**
   * Get all connections
   */
  getAllConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Update tab reference for a connection
   */
  updateReference(connectionId: string, reference: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }
    connection.reference = reference;
    return true;
  }

  /**
   * Get a connection by ID (or active if not specified)
   */
  getConnection(id?: string): Connection | null {
    if (id) {
      return this.connections.get(id) || null;
    }

    if (this.activeConnectionId) {
      return this.connections.get(this.activeConnectionId) || null;
    }

    return null;
  }

  /**
   * Find a connection by reference name
   * Sanitizes input to match stored references (lowercase, trimmed, spaces to hyphens)
   */
  findConnectionByReference(reference: string): Connection | null {
    // Sanitize: lowercase, trim, spaces to hyphens
    const sanitized = reference.toLowerCase().trim().replace(/\s+/g, '-');
    for (const connection of this.connections.values()) {
      if (connection.reference === sanitized) {
        return connection;
      }
    }
    return null;
  }

  /**
   * Check if a connection is still alive by attempting a lightweight CDP call
   * Returns false if the connection is dead or the CDP client is not responding
   * Uses a short timeout to avoid hanging when Chrome is killed or page is stuck
   *
   * This checks at the TARGET level (specific tab), not browser level.
   * When a tab is closed, the CDP connection to that target becomes invalid
   * even if the browser is still running.
   */
  async isConnectionAlive(connection: Connection): Promise<boolean> {
    try {
      // Quick check: if cdpManager says not connected, it's definitely dead
      if (!connection.cdpManager.isConnected()) {
        return false;
      }

      const client = (connection.cdpManager as any).client;
      if (!client) {
        return false;
      }

      // Check WebSocket state first - this is instant and doesn't require a round-trip
      // The CDP client uses a WebSocket internally
      const ws = client._ws;
      if (ws && ws.readyState !== 1) { // 1 = WebSocket.OPEN
        return false;
      }

      // Use a short timeout to avoid hanging on dead/stuck connections
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1500);
      });

      const healthCheckPromise = (async () => {
        try {
          // IMPORTANT: Use Runtime.evaluate instead of Browser.getVersion
          // Browser.getVersion is browser-level and works even when the tab is closed
          // Runtime.evaluate is target-level and will fail if the tab is closed
          // This properly detects closed tabs, not just killed Chrome processes
          await client.Runtime.evaluate({ expression: '1', silent: true });
          return true;
        } catch {
          return false;
        }
      })();

      return await Promise.race([healthCheckPromise, timeoutPromise]);
    } catch {
      return false;
    }
  }

  /**
   * Remove a stale/dead connection from the registry without attempting cleanup operations
   * Use this when the connection is known to be dead (e.g., Chrome was killed externally)
   */
  async removeStaleConnection(connectionId: string): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }

    console.error(`[ConnectionManager] Removing stale connection: ${connection.reference || connectionId}`);

    // Best-effort: let the CDP manager release its state and fire any pending
    // resume callback (e.g. to un-pause port monitoring) even though the
    // underlying connection is already dead - this is the more common path a
    // paused-then-killed process actually gets cleaned up through (discovered
    // as dead on the next tool call, rather than an explicit disconnect).
    try {
      await connection.cdpManager.disconnect();
    } catch (error) {
      console.error(`[ConnectionManager] Error disconnecting stale cdpManager: ${error}`);
    }

    // Remove from browser tracking
    const browserKey = `${connection.host}:${connection.port}`;
    const browser = this.browsers.get(browserKey);
    if (browser) {
      browser.connectionIds = browser.connectionIds.filter(connId => connId !== connectionId);
      if (browser.connectionIds.length === 0) {
        this.browsers.delete(browserKey);
        // A worker client left open holds its worker alive past the browser
        // that owned it.
        void disposeWorkerTargetRegistry(connection.host, connection.port);
      }
    }

    // Remove from registry
    this.connections.delete(connectionId);

    // Update active connection if we just removed it
    if (this.activeConnectionId === connectionId) {
      const remaining = Array.from(this.connections.keys());
      this.activeConnectionId = remaining.length > 0 ? remaining[0] : null;
    }

    return true;
  }

  /**
   * Find a connection by reference and validate it's still alive
   * If the connection is dead, automatically removes it and returns null
   * Use this instead of findConnectionByReference when you need to verify the connection is usable
   */
  async findConnectionByReferenceValidated(reference: string): Promise<Connection | null> {
    const connection = this.findConnectionByReference(reference);
    if (!connection) {
      return null;
    }

    const alive = await this.isConnectionAlive(connection);
    if (!alive) {
      console.error(`[ConnectionManager] Connection "${connection.reference}" is dead, removing stale reference`);
      await this.removeStaleConnection(connection.id);
      return null;
    }

    return connection;
  }

  /**
   * Get all connections
   */
  listConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Set the active connection
   */
  setActiveConnection(id: string): boolean {
    if (this.connections.has(id)) {
      this.activeConnectionId = id;
      return true;
    }
    return false;
  }

  /**
   * Get the active connection ID
   */
  getActiveConnectionId(): string | null {
    return this.activeConnectionId;
  }

  /**
   * Close a connection (tab)
   * @param options.reason - Why this connection is being closed. 'inactivity' triggers a
   *   last-chance activity check (see below) and tags the resulting Chrome kill correctly
   *   instead of it being misreported as an 'external' close.
   * @param options.inactivityThresholdMs - Required when reason is 'inactivity'; used for
   *   the last-chance activity check.
   */
  async closeConnection(
    id: string,
    options?: { reason?: 'manual' | 'inactivity'; inactivityThresholdMs?: number }
  ): Promise<boolean> {
    const connection = this.connections.get(id);
    if (!connection) {
      return false;
    }

    // Last-chance check for automatic inactivity sweeps only: lastActivityAt only tracks
    // explicit tool calls, but the browser can still be genuinely in use via background
    // console/network traffic (e.g. a logpoint firing on an interval) with no tool call in
    // between. Check the monitors - which are still alive at this point - before tearing
    // anything down, instead of after (by which point they'd already be destroyed below).
    if (options?.reason === 'inactivity' && options.inactivityThresholdMs !== undefined) {
      const stillActive =
        connection.networkMonitor?.hasRecentActivity(options.inactivityThresholdMs) ||
        connection.consoleMonitor?.hasRecentActivity(options.inactivityThresholdMs);
      if (stillActive) {
        connection.lastActivityAt = Date.now();
        return false;
      }
    }

    // Stop monitoring if applicable
    if (connection.puppeteerManager?.isConnected()) {
      const page = connection.puppeteerManager.getPage();
      connection.consoleMonitor?.stopMonitoring(page);
      await connection.networkMonitor?.stopMonitoring(page);

      // Close the page/tab
      try {
        await page.close();
      } catch (error) {
        console.error(`[ConnectionManager] Error closing page: ${error}`);
      }
    }

    // Disconnect managers only for this connection. Best-effort: the underlying
    // connection may already be dead (e.g. the process was killed), and we
    // still need the rest of this cleanup (browser tracking, Chrome kill,
    // registry removal below) to run either way.
    try {
      await connection.cdpManager.disconnect();
    } catch (error) {
      console.error(`[ConnectionManager] Error disconnecting cdpManager for ${id}: ${error}`);
    }
    // Note: Don't disconnect puppeteerManager as it's shared across tabs

    // Remove from browser tracking
    const browserKey = `${connection.host}:${connection.port}`;
    const browser = this.browsers.get(browserKey);
    if (browser) {
      browser.connectionIds = browser.connectionIds.filter(connId => connId !== id);
      // If no more connections, remove browser entry and kill Chrome
      if (browser.connectionIds.length === 0) {
        this.browsers.delete(browserKey);
        void disposeWorkerTargetRegistry(connection.host, connection.port);

        // Kill Chrome instance if this was the last connection to it
        if (this.chromeLauncher && connection.type === 'chrome') {
          try {
            if (options?.reason === 'inactivity') {
              this.chromeLauncher.setPendingCloseReason(connection.port, 'inactivity');
            }
            await this.chromeLauncher.kill(connection.port);
            console.error(`[ConnectionManager] Killed Chrome on port ${connection.port} (last connection closed)`);
          } catch (error) {
            console.error(`[ConnectionManager] Error killing Chrome on port ${connection.port}: ${error}`);
          }
        }
      }
    }

    // Remove from registry
    this.connections.delete(id);

    // Update active connection if we just closed it
    if (this.activeConnectionId === id) {
      const remaining = Array.from(this.connections.keys());
      this.activeConnectionId = remaining.length > 0 ? remaining[0] : null;
    }

    return true;
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    for (const id of ids) {
      await this.closeConnection(id);
    }
  }

  /**
   * Check if there are any connections
   */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Update the lastActivityAt timestamp for a connection
   */
  updateActivity(id: string): void {
    const connection = this.connections.get(id);
    if (connection) {
      connection.lastActivityAt = Date.now();
    }
  }

  /**
   * Close connections that have been inactive for longer than the specified duration
   * @param inactivityMs - Inactivity duration in milliseconds (default: 5 minutes)
   * @returns Number of connections closed
   */
  async closeInactiveConnections(inactivityMs: number = 5 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const connectionsToClose: string[] = [];

    for (const [id, connection] of this.connections.entries()) {
      const inactiveDuration = now - connection.lastActivityAt;
      if (inactiveDuration > inactivityMs) {
        connectionsToClose.push(id);
      }
    }

    let closedCount = 0;
    for (const id of connectionsToClose) {
      const closed = await this.closeConnection(id, { reason: 'inactivity', inactivityThresholdMs: inactivityMs });
      if (closed) {
        closedCount++;
      }
    }

    return closedCount;
  }

  /**
   * Get list of inactive connections
   * @param inactivityMs - Inactivity duration in milliseconds (default: 5 minutes)
   * @returns Array of inactive connections with their info
   */
  getInactiveConnections(inactivityMs: number = 5 * 60 * 1000): Array<{
    id: string;
    reference?: string;
    inactiveForMs: number;
    createdAt: number;
  }> {
    const now = Date.now();
    const inactive: Array<{
      id: string;
      reference?: string;
      inactiveForMs: number;
      createdAt: number;
    }> = [];

    for (const connection of this.connections.values()) {
      const inactiveDuration = now - connection.lastActivityAt;
      if (inactiveDuration > inactivityMs) {
        inactive.push({
          id: connection.id,
          reference: connection.reference,
          inactiveForMs: inactiveDuration,
          createdAt: connection.createdAt,
        });
      }
    }

    return inactive;
  }

  /**
   * Get console log stats from all connections
   * Returns an array of stats per connection that has new messages
   */
  getConsoleLogStats(): Array<{
    reference: string;
    newMessages: number;
    newErrors: number;
    newWarnings: number;
  }> {
    const stats: Array<{
      reference: string;
      newMessages: number;
      newErrors: number;
      newWarnings: number;
    }> = [];

    for (const connection of this.connections.values()) {
      if (connection.consoleMonitor) {
        const logStats = connection.consoleMonitor.getLogStats();
        if (logStats.newMessages > 0) {
          stats.push({
            reference: connection.reference || connection.id,
            newMessages: logStats.newMessages,
            newErrors: logStats.newErrors,
            newWarnings: logStats.newWarnings,
          });
        }
      }
    }

    return stats;
  }
}
