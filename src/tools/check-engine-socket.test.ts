/**
 * The check engine's socket reads, against a stand-in proxy: open while the
 * socket is, closed once it is not, and refused on an element.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const proxies = new Map<string, any>();
vi.mock('../proxy/registry.js', async (original) => ({
  ...(await original<typeof import('../proxy/registry.js')>()),
  getProxy: (reference: string) => proxies.get(reference),
}));

const { runCheck } = await import('./check-engine.js');

/** A proxy reporting a socket open or closed. */
function standIn(open = true) {
  const proxy = {
    socketOpen: vi.fn(() => open),
  };
  proxies.set('tab', proxy);
  return proxy;
}

beforeEach(() => proxies.clear());

describe('socket checks', () => {
  it('holds open while the socket is open, and waits for it to close', async () => {
    standIn(true);
    expect(await runCheck({ socket: '/live' }, { connection: 'tab' })).toMatchObject({ outcome: 'held', found: 'open' });

    let reads = 0;
    const proxy = standIn();
    proxy.socketOpen.mockImplementation(() => (reads += 1) < 3);
    const reading = await runCheck({ socket: '/live', condition: 'closed', withinMs: 2000, pollMs: 25 }, { connection: 'tab' });
    expect(reading).toMatchObject({ outcome: 'held', found: 'closed', polls: 3 });
  });

  it('refuses a socket\'s condition on an element', async () => {
    expect(await runCheck({ selector: '#a', condition: 'open' }, {})).toMatchObject({ outcome: 'error', errorKind: 'invalid' });
  });
});
