/**
 * A proxy started mid-command inherits that command.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { startProxyFor, stopProxyFor, markOnProxies, forgetCursor, getProxy, shareProxy, listProxies, namesSharing, newlyIdleProxies, standPausedRun, markNextCommand, releaseCommand, currentCursor } from './registry.js';

let origin: Server;
let originPort = 0;

beforeAll(async () => {
  origin = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;
});

afterAll(async () => {
  forgetCursor();
  await stopProxyFor('seeded');
  await new Promise<void>(resolve => origin.close(() => resolve()));
});

describe('a proxy started while a command runs', () => {
  it('stamps that command onto the traffic the command causes', async () => {
    // A launch is marked before it runs and creates its proxy during the
    // run, so without the seed its own page load would carry no command.
    markOnProxies({ kind: 'command', index: 4 });
    const { proxy } = await startProxyFor('seeded', `http://127.0.0.1:${originPort}`);
    const port = proxy.listenPort;

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `http://127.0.0.1:${originPort}/launched`,
        headers: { Host: `127.0.0.1:${originPort}` },
      }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
      req.on('error', reject);
      req.end();
    });

    const event = proxy.eventsIn().find(e => e.url.endsWith('/launched'));
    expect(event?.commandIndex).toBe(4);
  });
});

describe('a second tab opened in a proxied browser', () => {
  it('resolves to the proxy the browser was launched through', async () => {
    const { proxy } = await startProxyFor('first shop tab');

    expect(shareProxy('first shop tab', 'second shop tab')).toBe(true);

    expect(getProxy('second shop tab')).toBe(proxy);
    expect(listProxies()).toEqual(expect.arrayContaining(['first shop tab', 'second shop tab']));
    await stopProxyFor('first shop tab');
    await stopProxyFor('second shop tab');
  });

  it('keeps the proxy running for one name while the other name is stopped', async () => {
    const { proxy } = await startProxyFor('first cart tab');
    shareProxy('first cart tab', 'second cart tab');

    await stopProxyFor('second cart tab');

    expect(getProxy('second cart tab')).toBeUndefined();
    expect(getProxy('first cart tab')).toBe(proxy);
    expect((proxy as any).front.listening).toBe(true);
    await stopProxyFor('first cart tab');
  });

  it('shares nothing when the first name has no proxy', () => {
    expect(shareProxy('no such tab', 'another new tab')).toBe(false);
    expect(getProxy('another new tab')).toBeUndefined();
  });
});

describe('a proxy no name in use holds', () => {
  it('is reported once when it goes idle, and again only after it was in use', async () => {
    await startProxyFor('idle shop tab');
    shareProxy('idle shop tab', 'idle cart tab');
    let inUse = new Set(['idle-cart-tab-unrelated']);
    const reported = () => newlyIdleProxies(name => inUse.has(name)).filter(g => g.names.includes('idle shop tab'));

    expect(reported()).toEqual([{ names: ['idle shop tab', 'idle cart tab'] }]);
    expect(reported()).toEqual([]);

    inUse = new Set(['idle cart tab']);
    expect(reported()).toEqual([]);
    inUse = new Set();
    expect(reported()).toEqual([{ names: ['idle shop tab', 'idle cart tab'] }]);

    expect(namesSharing('idle cart tab')).toEqual(['idle shop tab', 'idle cart tab']);
    await stopProxyFor('idle shop tab');
    await stopProxyFor('idle cart tab');
  });
});

describe("a paused run's standing cursor", () => {
  const pause = { kind: 'replay' as const, runId: 'run-paused', step: 2, paused: true as const };

  it('is what a call made in the pause hands back to on release', async () => {
    forgetCursor();
    await standPausedRun(pause);
    expect(currentCursor()).toEqual(pause);
    await markNextCommand({ kind: 'command', index: 9 });
    expect(currentCursor()).toEqual({ kind: 'command', index: 9 });
    await releaseCommand(0, 0);
    expect(currentCursor()).toEqual(pause);
    await standPausedRun(undefined);
  });

  it('comes down with nothing in its place when the run resumes', async () => {
    forgetCursor();
    await standPausedRun(pause);
    await standPausedRun(undefined);
    expect(currentCursor()).toBeUndefined();
    await markNextCommand({ kind: 'command', index: 10 });
    await releaseCommand(0, 0);
    expect(currentCursor()).toBeUndefined();
  });

  it('leaves a call in flight marked when it comes down', async () => {
    forgetCursor();
    await standPausedRun(pause);
    await markNextCommand({ kind: 'command', index: 11 });
    await standPausedRun(undefined);
    expect(currentCursor()).toEqual({ kind: 'command', index: 11 });
    await releaseCommand(0, 0);
    expect(currentCursor()).toBeUndefined();
  });
});
