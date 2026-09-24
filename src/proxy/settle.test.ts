/**
 * Holding a step boundary until the app goes quiet.
 *
 * The wait itself, apart from where it sits among the mechanisms that decide
 * what a command owns - `boundary.test.ts` covers that. Attribution by
 * position, used where the page reports no cause: a worker's first line, a
 * load that happened before the session attached, a page that has frozen
 * `WebSocket.prototype`. Off by default, since a reported root
 * accounts for the rest with no wait at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { InterceptProxy, levelOf } from './intercept-proxy.js';

let origin: Server;
let originPort = 0;
let sockets: WebSocketServer;
/** Sockets the test can push to on demand. */
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
  // Sockets from earlier cases stay in `open`, so wait for a NEW one rather
  // than taking the last, which would be a closed socket that sends nothing.
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

describe('a boundary held until the app goes quiet', () => {
  it('returns once nothing has crossed for the quiet window', async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const began = Date.now();
    await proxy.settle(60, 2000);
    // Nothing has ever crossed, so the window is already satisfied.
    expect(Date.now() - began).toBeLessThan(500);
    await proxy.stop();
  });

  it('gives up at the cap on an app that never goes quiet', async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const { socket, server } = await connected(proxy, port);
    const beating = setInterval(() => server.send('tick'), 20);
    // Let a tick cross first: with nothing recorded the boundary is already
    // quiet and settle returns at once, which is correct and not the case here.
    await new Promise<void>(resolve => socket.on('message', () => resolve()));

    const began = Date.now();
    await proxy.settle(200, 500);
    const waited = Date.now() - began;

    clearInterval(beating);
    socket.close();
    // The heartbeat keeps resetting the quiet window, so the cap ends it.
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(1500);
    await proxy.stop();
  });

  // The reason the wait holds the previous cursor rather than clearing first:
  // an earlier build marked idle before waiting, which stamped the tail this
  // exists to keep with no command and dropped it out of every step.
  it('leaves the tail with the command that caused it', async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    const { socket, server } = await connected(proxy, port);

    proxy.mark({ kind: 'command', index: 7 });
    // The boundary is held with command 7 still in place, which is the point:
    // a consequence arriving after 7 returned belongs to 7, and marking the
    // wait as something else dropped it out of every step.
    const settling = proxy.settle(80, 1000);
    const pushed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    server.send('arrived after the command returned');
    await pushed;
    await settling;
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(arrived!.commandIndex).toBe(7);
    await proxy.stop();
  });
});
