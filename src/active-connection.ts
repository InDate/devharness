/**
 * Managers that forward every property read to the active connection's own,
 * so a tool called without a connectionReason reaches the active connection.
 *
 * The active connection is read from the ConnectionManager on each access.
 * A copy held here drifted from it: a launch moved the copy and left the
 * manager's active id alone, and a close moved the id and left the copy on the
 * closed connection.
 */

import { CDPManager } from './cdp-manager.js';
import { PuppeteerManager } from './puppeteer-manager.js';
import { ConsoleMonitor } from './console-monitor.js';
import { NetworkMonitor } from './network-monitor.js';
import type { Connection, ConnectionManager } from './connection-manager.js';
import type { SourceMapHandler } from './sourcemap-handler.js';

export function createActiveManagers(connectionManager: ConnectionManager, sourceMapHandler: SourceMapHandler) {
  /** The active connection's manager where it has one, else the unconnected placeholder. */
  const forward = <T extends object>(placeholder: T, pick: (connection: Connection) => object | undefined): T =>
    new Proxy(placeholder, {
      get(target: any, prop: string) {
        const connection = connectionManager.getConnection();
        const live = connection ? pick(connection) : undefined;
        return live ? (live as any)[prop] : target[prop];
      },
    });

  return {
    cdpManager: forward(new CDPManager(sourceMapHandler), connection => connection.cdpManager),
    puppeteerManager: forward(new PuppeteerManager(), connection => connection.puppeteerManager),
    consoleMonitor: forward(new ConsoleMonitor(), connection => connection.consoleMonitor),
    networkMonitor: forward(new NetworkMonitor(), connection => connection.networkMonitor),
    activate(connectionId: string): void {
      if (connectionManager.setActiveConnection(connectionId)) {
        connectionManager.updateActivity(connectionId);
      }
    },
  };
}
