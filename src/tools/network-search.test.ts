import { describe, it, expect } from 'vitest';
import { createNetworkTools } from './network-tools.js';

function request(id: string, url: string, method: string, status?: number) {
  return {
    id, url, method, resourceType: 'fetch',
    ...(status !== undefined ? { response: { status, statusText: '' } } : {}),
    timing: { startTime: 0 },
  };
}

function networkWith(requests: any[]) {
  const monitor = {
    isActive: () => true,
    getRequests: () => requests,
    getCount: () => requests.length,
  };
  const resolve = async (reason: string) => reason === 'shop-web-app'
    ? { connection: {}, cdpManager: {}, puppeteerManager: { isConnected: () => true }, networkMonitor: monitor }
    : null;
  return createNetworkTools(resolve).network;
}

const search = (network: any, params: Record<string, unknown>) =>
  network.handler({ action: 'search', connectionReason: 'shop-web-app', ...params });

describe('network search', () => {
  it('finds every matching URL when the pattern carries the g flag', async () => {
    const network = networkWith([
      request('1', 'http://shop/api/a', 'GET', 200),
      request('2', 'http://shop/api/b', 'GET', 200),
      request('3', 'http://shop/api/c', 'GET', 200),
    ]);

    const result: any = await search(network, { pattern: 'api', flags: 'g' });

    expect(result._meta.network.matchCount).toBe(3);
  });

  it('leaves out a request with no response when a status is asked for', async () => {
    const network = networkWith([
      request('1', 'http://shop/api/a', 'POST', 500),
      request('2', 'http://shop/api/b', 'POST'),
    ]);

    const result: any = await search(network, { pattern: 'api', statusCode: '5xx' });

    expect(result._meta.network.matchCount).toBe(1);
  });

  it('counts every match, not only the ones the limit shows', async () => {
    const network = networkWith(Array.from({ length: 80 }, (_, i) => request(String(i), `http://shop/api/${i}`, 'GET', 200)));

    const result: any = await search(network, { pattern: 'api' });

    expect(result._meta.network.matchCount).toBe(80);
    expect(result.content[0].text).toContain('80 matches');
    expect(result.content[0].text).toContain('first 50 shown');
  });
});

describe('a network call naming no connection that exists', () => {
  it('names the connection it looked for', async () => {
    const network = networkWith([]);

    for (const action of ['list', 'get', 'search', 'enable', 'setConditions', 'sockets', 'streams']) {
      const result: any = await network.handler({ action, connectionReason: 'no-such-tab', id: '1', pattern: '.', preset: 'online' } as any);
      expect(result.isError, action).toBe(true);
      expect(result.content[0].text, action).toContain('"no-such-tab"');
    }
  });
});
