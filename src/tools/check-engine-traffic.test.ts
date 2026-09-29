/**
 * The check engine's traffic and socket reads, against a stand-in proxy: a
 * least-count holds as soon as it is met, a count that must not be exceeded
 * holds only once its time is up and fails as soon as it is exceeded, and the
 * counter is released however the check ends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const proxies = new Map<string, any>();
vi.mock('../proxy/registry.js', async (original) => ({
  ...(await original<typeof import('../proxy/registry.js')>()),
  getProxy: (reference: string) => proxies.get(reference),
}));

const { runCheck } = await import('./check-engine.js');

/** A proxy whose counter reads `hits()` at each read, and records its releases. */
function standIn(hits: () => number, open = true) {
  const proxy = {
    released: [] as string[],
    count: vi.fn((_match: unknown, _since?: number) => 'count-1'),
    hitsOf: vi.fn(() => hits()),
    isPartial: vi.fn(() => false),
    release: vi.fn((id: string) => { proxy.released.push(id); }),
    socketOpen: vi.fn(() => open),
  };
  proxies.set('tab', proxy);
  return proxy;
}

beforeEach(() => proxies.clear());

describe('traffic checks', () => {
  it('answers error when the connection has no proxy', async () => {
    const reading = await runCheck({ traffic: { urlIncludes: '/api' } }, { connectionReason: 'tab' });
    expect(reading).toMatchObject({ outcome: 'error', errorKind: 'no-proxy' });
    expect(reading.detail).toContain('proxy: true');
  });

  it('counts with the matcher it is given, and holds a least-count as soon as it is met', async () => {
    let n = 0;
    const proxy = standIn(() => (n += 1));
    const started = Date.now();
    const reading = await runCheck({ traffic: { urlIncludes: '/api/items', method: 'GET' }, count: 3, withinMs: 5000, pollMs: 25 }, { connectionReason: 'tab' });
    expect(proxy.count).toHaveBeenCalledWith({ urlIncludes: '/api/items', method: 'GET' }, expect.any(Number));
    expect(reading).toMatchObject({ outcome: 'held', found: '3 crossed', polls: 3 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('holds a count of none only once its time is up', async () => {
    standIn(() => 0);
    const started = Date.now();
    const reading = await runCheck({ traffic: { urlIncludes: '/analytics' }, count: 0, operator: 'equals', withinMs: 150, pollMs: 25 }, { connectionReason: 'tab' });
    expect(reading.outcome).toBe('held');
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('fails a count that must not be exceeded as soon as it is', async () => {
    standIn(() => 1);
    const started = Date.now();
    const reading = await runCheck({ traffic: { urlIncludes: '/analytics' }, count: 0, operator: 'equals', withinMs: 5000, pollMs: 25 }, { connectionReason: 'tab' });
    expect(reading).toMatchObject({ outcome: 'failed', found: '1 crossed', polls: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('holds exactly 4 only if no fifth crosses before its time is up', async () => {
    let n = 3;
    standIn(() => Math.min(5, (n += 1)));
    const reading = await runCheck({ traffic: { method: 'GET' }, count: 4, operator: 'equals', withinMs: 2000, pollMs: 25 }, { connectionReason: 'tab' });
    expect(reading).toMatchObject({ outcome: 'failed', found: '5 crossed' });
  });

  it('releases its counter when it holds, when it fails, and when it is cancelled', async () => {
    const held = standIn(() => 1);
    await runCheck({ traffic: {} }, { connectionReason: 'tab' });
    expect(held.released).toEqual(['count-1']);

    const failed = standIn(() => 0);
    await runCheck({ traffic: {}, withinMs: 60, pollMs: 25 }, { connectionReason: 'tab' });
    expect(failed.released).toEqual(['count-1']);

    const cancelled = standIn(() => 0);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 40);
    await expect(runCheck({ traffic: {}, withinMs: 10_000, pollMs: 25 }, { connectionReason: 'tab', abortSignal: abort.signal })).rejects.toThrow();
    expect(cancelled.released).toEqual(['count-1']);
  });
});

describe('where a traffic count starts', () => {
  it('starts at the call stepsBack before the check, every call counting', async () => {
    const proxy = standIn(() => 1);
    const { noteCallStart } = await import('../proxy/registry.js');
    noteCallStart(1000);   // the click
    noteCallStart(2000);   // a screenshot after it
    noteCallStart(3000);   // the check itself
    await runCheck({ traffic: {} }, { connectionReason: 'tab' });
    expect(proxy.count.mock.calls.at(-1)?.[1]).toBe(2000);
    await runCheck({ traffic: {}, stepsBack: 2 }, { connectionReason: 'tab' });
    expect(proxy.count.mock.calls.at(-1)?.[1]).toBe(1000);
  });

  it('says the count may be short when the record was trimmed past its start', async () => {
    const proxy = standIn(() => 1);
    proxy.isPartial.mockReturnValue(true);
    const reading = await runCheck({ traffic: {} }, { connectionReason: 'tab' });
    expect(reading.detail).toContain('may be short');
  });
});

describe('socket checks', () => {
  it('holds open while the socket is open, and waits for it to close', async () => {
    standIn(() => 0, true);
    expect(await runCheck({ socket: '/live' }, { connectionReason: 'tab' })).toMatchObject({ outcome: 'held', found: 'open' });

    let reads = 0;
    const proxy = standIn(() => 0);
    proxy.socketOpen.mockImplementation(() => (reads += 1) < 3);
    const reading = await runCheck({ socket: '/live', condition: 'closed', withinMs: 2000, pollMs: 25 }, { connectionReason: 'tab' });
    expect(reading).toMatchObject({ outcome: 'held', found: 'closed', polls: 3 });
  });

  it('refuses a socket\'s condition on an element', async () => {
    expect(await runCheck({ selector: '#a', condition: 'open' }, {})).toMatchObject({ outcome: 'error', errorKind: 'invalid' });
  });
});
