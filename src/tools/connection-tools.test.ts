import { describe, it, expect, vi } from 'vitest';
import { createConnectionTools, type ConnectionToolDeps } from './connection-tools.js';

/** A connection whose page title never resolves while `paused` is true, as Puppeteer's does. */
function fakeConnection(reference: string, paused: boolean) {
  const title = vi.fn(() => (paused ? new Promise<string>(() => {}) : Promise.resolve(`${reference} title`)));
  const page = { url: () => `http://app/${reference}`, title, bringToFront: vi.fn() };
  return {
    title,
    connection: {
      id: `id-${reference}`,
      reference,
      type: 'chrome',
      host: 'localhost',
      port: 9222,
      createdAt: 0,
      pageIndex: 0,
      cdpManager: { isConnected: () => true, isPaused: () => paused },
      puppeteerManager: { isConnected: () => true, getPage: () => page, setPage: vi.fn(async () => {}) },
    },
  };
}

function makeTools(connections: any[]) {
  const connectionManager = {
    listConnections: () => connections,
    isConnectionAlive: vi.fn(async () => true),
    removeStaleConnection: vi.fn(async () => true),
    getActiveConnectionId: () => connections[0]?.id,
    getConnection: (id?: string) => connections.find(c => c.id === id),
    findConnectionByReferenceValidated: vi.fn(async (ref: string) => connections.find(c => c.reference === ref) ?? null),
  };
  const deps = { connectionManager, activateConnection: vi.fn() } as unknown as ConnectionToolDeps;
  return createConnectionTools(deps).connection;
}

/** Resolves with the call's result, or rejects when it takes longer than `ms`. */
const within = <T>(promise: Promise<T>, ms = 500) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms))]);

describe('a connection paused at a breakpoint', () => {
  it('is listed at once, with its URL and no title', async () => {
    const running = fakeConnection('running-app', false);
    const paused = fakeConnection('paused-app', true);
    const connection = makeTools([running.connection, paused.connection]);

    const result: any = await within(connection.handler({ action: 'list' }));

    expect(result._meta.connections).toEqual([
      expect.objectContaining({ reference: 'running-app', paused: false, url: 'http://app/running-app', title: 'running-app title' }),
      expect.objectContaining({ reference: 'paused-app', paused: true, url: 'http://app/paused-app' }),
    ]);
    expect(result._meta.connections[1]).not.toHaveProperty('title');
    expect(paused.title).not.toHaveBeenCalled();
  });

  it('is switched to at once, with its URL', async () => {
    const paused = fakeConnection('paused-app', true);
    const connection = makeTools([paused.connection]);

    const result: any = await within(connection.handler({ action: 'switch', connectionReason: 'paused-app' }));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('http://app/paused-app');
    expect(paused.title).not.toHaveBeenCalled();
  });
});
