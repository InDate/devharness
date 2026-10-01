// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ConnectionManager } from '../connection-manager.js';
import { createExecutionTools } from './execution-tools.js';

function fakeCdpManager(pausedAt?: { url: string; lineNumber: number }) {
  return {
    getRuntimeType: () => 'node',
    isConnected: () => true,
    disconnect: async () => {},
    isPaused: () => pausedAt !== undefined,
    getPausedInfo: () => (pausedAt ? { paused: true, location: pausedAt } : { paused: false }),
  } as any;
}

function twoConnections(opts: { secondPaused: boolean }) {
  const connectionManager = new ConnectionManager();
  const running = fakeCdpManager();
  const paused = fakeCdpManager(opts.secondPaused ? { url: 'server.js', lineNumber: 12 } : undefined);
  const first = connectionManager.createConnection(running, undefined, undefined, undefined, 'localhost', 9229);
  const second = connectionManager.createConnection(paused, undefined, undefined, undefined, 'localhost', 9230);
  connectionManager.setActiveConnection(first);
  const { execution } = createExecutionTools(async () => null, connectionManager);
  return { connectionManager, execution, first, second };
}

describe('execution acknowledge with no connection', () => {
  it('acknowledges a pause on a connection other than the active one', async () => {
    const { connectionManager, execution, first, second } = twoConnections({ secondPaused: true });

    const result: any = await execution.handler({ action: 'acknowledge' } as any);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('server.js:12');
    expect(connectionManager.getConnection(second)!.breakpointPauseAcknowledged).toBe(true);
    expect(connectionManager.getConnection(first)!.breakpointPauseAcknowledged).toBeUndefined();
  });

  it('answers not paused when no connection is paused', async () => {
    const { execution } = twoConnections({ secondPaused: false });

    const result: any = await execution.handler({ action: 'acknowledge' } as any);

    expect(result.isError).toBe(true);
    expect(result._errorId ?? result.content[0].text).toMatch(/NOT_PAUSED|Not currently paused/);
  });
});

describe('execution actions other than acknowledge', () => {
  it('refuse a call with no connection rather than act on the active connection', async () => {
    const { execution } = twoConnections({ secondPaused: true });

    for (const action of ['pause', 'resume', 'stepOver', 'stepInto', 'stepOut'] as const) {
      const result: any = await execution.handler({ action } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('connection');
    }
  });
});
