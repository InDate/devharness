/**
 * What the page reports about traffic, and the rules that read it.
 *
 * Every case here is one the wire alone cannot answer: which socket a send
 * belongs to when two share a URL, which send a report names when two are the
 * same size, and whether a request was caused by a gesture or by the app's own
 * clock. Each failure is named beside the case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { InterceptProxy, levelOf, ownershipWeight, causeOf } from './intercept-proxy.js';

let origin: Server;
let originPort = 0;
let sockets: WebSocketServer;
const open: import('ws').WebSocket[] = [];

beforeAll(async () => {
  origin = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;
  sockets = new WebSocketServer({ server: origin });
  sockets.on('connection', socket => { open.push(socket); });
});

afterAll(async () => {
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  origin.closeAllConnections();
  await new Promise<void>(resolve => origin.close(() => resolve()));
});

async function connected(proxy: InterceptProxy, port: number) {
  const before = open.length;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, {
    headers: { Host: `127.0.0.1:${originPort}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  while (open.length === before) await new Promise(r => setTimeout(r, 5));
  return { socket, server: open[open.length - 1] };
}

/** Wait until the proxy has recorded `count` frames leaving. */
async function sent(proxy: InterceptProxy, count: number) {
  for (let i = 0; i < 200; i++) {
    const out = proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'out');
    if (out.length >= count) return out;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`only ${proxy.eventsIn().length} events after waiting`);
}

function get(proxy: InterceptProxy, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxy.listenPort, method: 'GET',
      path: `http://127.0.0.1:${originPort}${path}`,
      headers: { Host: `127.0.0.1:${originPort}` },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end();
  });
}

describe('a send report and the socket it belongs to', () => {
  it('does not credit one socket for what another sent', async () => {
    // Two components subscribing to one endpoint are two sockets on one URL.
    // Routed by URL, a report lands on whichever was registered first: the
    // wrong socket's allowance is withdrawn, the right one keeps its own, and
    // the next push on it reads as an answer to a command.
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const url = `ws://127.0.0.1:${originPort}/live`;
    const first = await connected(proxy, port);
    const second = await connected(proxy, port);

    proxy.mark({ kind: 'command', index: 20 });
    second.socket.send('beat');
    await sent(proxy, 1);
    // The second socket's first send, reported after its frame.
    proxy.noteSend(url, 1, 1, 4, 'timer', Date.now());

    const shapes = proxy.socketShapes();
    const silent = shapes.find(s => s.sent === 0);
    const sender = shapes.find(s => s.sent === 1);
    expect(silent?.sentUnprompted).toBe(0);
    expect(sender?.sentUnprompted).toBe(1);

    first.socket.close();
    second.socket.close();
    await proxy.stop();
  });

  it('gives each same-size send its own report', async () => {
    // Matched by byte length, a heartbeat and a click-driven send of equal
    // size swap roots: the click drops out of its step as a timer, and the
    // orphaned report is taken by the next frame that happens to share a size.
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const url = `ws://127.0.0.1:${originPort}/live`;
    const { socket } = await connected(proxy, port);

    proxy.mark({ kind: 'command', index: 30 });
    socket.send('beat');
    socket.send('clik');
    const out = await sent(proxy, 2);
    proxy.noteSend(url, 1, 1, 4, 'timer', Date.now());
    proxy.noteSend(url, 1, 2, 4, 'input', Date.now());

    expect(out[0].evidence?.initiator).toBe('timer');
    expect(out[1].evidence?.initiator).toBe('input');
    expect(causeOf(out[0])).toBeUndefined();
    expect(causeOf(out[1])).toEqual({ kind: 'command', index: 30 });

    socket.close();
    await proxy.stop();
  });

  it('owns a gesture-driven send whose bytes left after the release', async () => {
    // The same rule a gesture-driven request gets. Without it the two disagree
    // for byte-identical work: the fetch is owned and the send is not.
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const url = `ws://127.0.0.1:${originPort}/live`;
    const { socket } = await connected(proxy, port);

    proxy.mark({ kind: 'command', index: 31 });
    proxy.mark(undefined);
    socket.send('late');
    const out = await sent(proxy, 1);
    proxy.noteSend(url, 1, 1, 4, 'input', Date.now());

    expect(causeOf(out[0])).toEqual({ kind: 'command', index: 31 });
    socket.close();
    await proxy.stop();
  });
});

describe('what a gesture buys a request', () => {
  it('reads above position, since position measures no cause', async () => {
    const proxy = new InterceptProxy();
    await proxy.start();
    proxy.mark({ kind: 'command', index: 40 });
    await get(proxy, '/clicked');
    proxy.noteInitiator('GET', `http://127.0.0.1:${originPort}/clicked`, 'input', Date.now());

    const event = proxy.eventsIn().find(e => e.url.includes('/clicked'))!;
    expect(levelOf(event)).toBe('likely');
    expect(ownershipWeight(event)).toBeGreaterThan(0.3);
    await proxy.stop();
  });

  it('stops reaching a command once the gesture is too old to be its', async () => {
    // A person's own click, minutes after the last command returned, would
    // otherwise be credited to that command for the rest of the session.
    const proxy = new InterceptProxy();
    await proxy.start();
    proxy.mark({ kind: 'command', index: 41 });
    proxy.mark(undefined);
    (proxy as unknown as { lastMarked: { cursor: unknown; at: number } })
      .lastMarked.at = Date.now() - 60_000;

    await get(proxy, '/much-later');
    proxy.noteInitiator('GET', `http://127.0.0.1:${originPort}/much-later`, 'input', Date.now());

    const event = proxy.eventsIn().find(e => e.url.includes('/much-later'))!;
    expect(event.evidence?.initiator).toBe('input');
    expect(causeOf(event)).toBeUndefined();
    await proxy.stop();
  });

  it('takes the report closest in time when two requests share a URL', async () => {
    // A click and a poll hitting one endpoint inside the join window. Taking
    // any gesture report in the window hands the poll the click's command.
    const proxy = new InterceptProxy();
    await proxy.start();
    proxy.mark({ kind: 'command', index: 42 });
    const url = `http://127.0.0.1:${originPort}/shared`;
    const now = Date.now();
    proxy.noteInitiator('GET', url, 'input', now - 3000);
    proxy.noteInitiator('GET', url, 'timer', now);
    await get(proxy, '/shared');

    const event = proxy.eventsIn().find(e => e.url.includes('/shared'))!;
    expect(event.evidence?.initiator).toBe('timer');
    await proxy.stop();
  });
});

describe('a transport that dies without a close frame', () => {
  it('still closes the browser side', async () => {
    // A server destroying its socket reports 1006, which is reserved and
    // cannot be sent in a close frame. Forwarded verbatim it throws inside the
    // proxy and closes nothing, so the page keeps a socket whose other half is
    // gone: its state reads open, and every frame it sends afterwards - a
    // disconnect included - goes nowhere.
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const { socket, server } = await connected(proxy, port);

    const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)));
    (server as unknown as { _socket: { destroy(): void } })._socket.destroy();

    const code = await Promise.race([
      closed,
      new Promise<number>(resolve => setTimeout(() => resolve(-1), 3000)),
    ]);
    expect(code).not.toBe(-1);
    await proxy.stop();
  });
});
