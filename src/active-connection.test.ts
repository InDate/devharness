// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ConnectionManager } from './connection-manager.js';
import { SourceMapHandler } from './sourcemap-handler.js';
import { createActiveManagers } from './active-connection.js';

function fakeCdpManager(label: string) {
  return {
    label,
    getRuntimeType: () => 'node',
    isConnected: () => true,
    disconnect: async () => {},
  } as any;
}

function twoConnections() {
  const connectionManager = new ConnectionManager();
  const active = createActiveManagers(connectionManager, new SourceMapHandler());
  const first = connectionManager.createConnection(fakeCdpManager('first'), undefined, undefined, undefined, 'localhost', 9229);
  active.activate(first);
  const second = connectionManager.createConnection(fakeCdpManager('second'), undefined, undefined, undefined, 'localhost', 9230);
  active.activate(second);
  return { connectionManager, active, first, second };
}

describe('the active connection', () => {
  it('after a second connection is activated, listConnections and bare calls both name the second', () => {
    const { connectionManager, active, second } = twoConnections();

    expect(connectionManager.getActiveConnectionId()).toBe(second);
    expect((active.cdpManager as any).label).toBe('second');
  });

  it('after the active connection closes, bare calls reach the connection that became active', async () => {
    const { connectionManager, active, first, second } = twoConnections();

    await connectionManager.closeConnection(second);

    expect(connectionManager.getActiveConnectionId()).toBe(first);
    expect((active.cdpManager as any).label).toBe('first');
  });
});
