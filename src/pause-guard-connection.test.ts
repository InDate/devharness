// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkBreakpointPause } from './tool-response.js';
import { ConnectionManager } from './connection-manager.js';

function pausedConnections() {
  const connectionManager = new ConnectionManager();
  const cdp = {
    getRuntimeType: () => 'node',
    isConnected: () => true,
    disconnect: async () => {},
    isPaused: () => true,
    getPausedInfo: () => ({ paused: true, location: { url: 'app.js', lineNumber: 4 } }),
    getCallStack: () => [],
    watchPause: () => () => {},
  } as any;
  connectionManager.createConnection(cdp, undefined, undefined, undefined, 'localhost', 9229, 'api-server');
  return connectionManager.getAllConnections();
}

describe('the pause guard and the connection tool', () => {
  it('lets the actions that only read connections run while a pause is unacknowledged', () => {
    for (const action of ['list', 'status', 'browsers']) {
      expect(checkBreakpointPause(pausedConnections(), 'connection', undefined, action).blocked, action).toBe(false);
    }
  });

  it('blocks the actions that launch, attach, switch or close', () => {
    for (const action of ['launch', 'attach', 'switch', 'close']) {
      expect(checkBreakpointPause(pausedConnections(), 'connection', undefined, action).blocked, action).toBe(true);
    }
  });
});
