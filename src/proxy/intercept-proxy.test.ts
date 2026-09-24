/**
 * The cursor a proxy event carries: which command, or which replayed step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { InterceptProxy, levelOf } from './intercept-proxy.js';

let origin: Server;
let originPort = 0;
/** Set while a /slow request is parked; calling it answers that request. */
let releaseSlow: (() => void) | null = null;
let sockets: WebSocketServer;
let muted: import('ws').WebSocket | null = null;

const started: InterceptProxy[] = [];

/** A proxy of its own per test, so no case depends on another having run. */
async function freshProxy(): Promise<{ proxy: InterceptProxy; port: number }> {
  const proxy = new InterceptProxy();
  const { port } = await proxy.start();
  started.push(proxy);
  return { proxy, port };
}

/** Issue an absolute-form request through the proxy and drain the response. */
function through(proxyPort: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://127.0.0.1:${originPort}${path}`,
      headers: { Host: `127.0.0.1:${originPort}` },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end();
  });
}

/** Resolves once the origin has parked a /slow request. */
function slowParked(): Promise<void> {
  return new Promise(resolve => {
    const poll = () => (releaseSlow ? resolve() : setTimeout(poll, 5));
    poll();
  });
}

beforeAll(async () => {
  origin = createServer((req, res) => {
    if (req.url === '/slow') {
      releaseSlow = () => { res.writeHead(200); res.end('ok'); releaseSlow = null; };
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;

  sockets = new WebSocketServer({ server: origin });
  sockets.on('connection', (socket, req) => {
    // /greets speaks first; /live answers once; /twice answers twice.
    if (req.url === '/greets') socket.send('hello, unasked');
    // /mute answers nothing; the test pushes to it on demand.
    if (req.url === '/mute') muted = socket;
    socket.on('message', raw => {
      // /slowecho holds its answer, so a command can be marked while the
      // answer is in flight and the send has already crossed the proxy.
      if (req.url === '/mute') return;
      // /rpc answers out of order and echoes the id, as JSON-RPC does.
      if (req.url === '/rpc') {
        let id: string | undefined;
        try { id = JSON.parse(String(raw)).id; } catch { /* not every frame carries one */ }
        if (id === undefined) {
          socket.send('plain answer');
          return;
        }
        setTimeout(() => socket.send(JSON.stringify({ id, result: 'ok' })), id === 'slow' ? 200 : 20);
        return;
      }
      if (req.url === '/slowecho') {
        setTimeout(() => socket.send(`echo:${raw}`), 150);
        return;
      }
      socket.send(`echo:${raw}`);
      if (req.url === '/twice') socket.send(`again:${raw}`);
    });
  });
});

afterAll(async () => {
  for (const proxy of started) await proxy.stop().catch(() => {});
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  origin.closeAllConnections();
  await new Promise<void>(resolve => origin.close(() => resolve()));
});

describe('what a request carries', () => {
  it('leaves the stamp off while nothing has been marked', async () => {
    const { proxy, port } = await freshProxy();
    await through(port, '/before');
    expect(proxy.eventsIn()[0].commandIndex).toBeUndefined();
  });

  it('carries the command in flight', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'command', index: 7 });
    await through(port, '/during');
    expect(proxy.eventsIn()[0].commandIndex).toBe(7);
  });

  it('keeps the command that issued it when the response completes under a later one', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'command', index: 9 });
    const slow = through(port, '/slow');
    await slowParked();
    proxy.mark({ kind: 'command', index: 10 });
    releaseSlow!();
    await slow;
    const event = proxy.eventsIn().find(e => e.url.endsWith('/slow'));
    expect(event!.commandIndex).toBe(9);
  });

  it('carries a replayed step instead of a command', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'replay', runId: 'run-x', step: 3 });
    await through(port, '/replayed');
    const event = proxy.eventsIn()[0];
    expect(event.commandIndex).toBeUndefined();
    expect({ runId: event.runId, step: event.step }).toEqual({ runId: 'run-x', step: 3 });
  });
});

describe('an id no protocol has named', () => {
  it('pairs a fresh one and leaves the socket answerable by allowance', async () => {
    const { proxy, port } = await freshProxy();
    // No subprotocol requested, so `id` is a field name rather than a
    // protocol's. One match must not make the socket id-authoritative.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const answered = new Promise<void>(resolve => socket.on('message', () => resolve()));
    proxy.mark({ kind: 'command', index: 2 });
    socket.send(JSON.stringify({ id: 'fast' }));
    await answered;

    // A frame carrying no id at all still settles against an allowance here,
    // where an id-authoritative socket would call it unprompted.
    const echoed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send('no id on this one');
    await echoed;
    socket.close();

    const arrived = proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'in');
    expect(levelOf(arrived[0])).toBe('observed');
    expect(levelOf(arrived[1])).not.toBe('unprompted');
  });
});

describe('how much a stamp claims', () => {
  it('claims only position for a request, which names no cause', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'command', index: 1 });
    await through(port, '/paired');
    // The pairing observed is request to response. Nothing measures what made
    // the command issue it, so a timer-driven poll reads the same as a click.
    expect(levelOf(proxy.eventsIn()[0])).toBe('positional');
  });

  it('names a frame arriving with nothing sent as unprompted, and the socket as push', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/greets`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    const greeted = new Promise<void>(resolve => socket.on('message', () => resolve()));
    await greeted;
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(levelOf(arrived!)).toBe('unprompted');
    expect(proxy.socketShapes()[0].shape).toBe('push');
  });

  it('names a frame following a send on an answer-only socket as likely, and the socket as reply', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const echoed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send('ask');
    await echoed;
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(levelOf(arrived!)).toBe('likely');
    expect(proxy.socketShapes()[0].shape).toBe('reply');
  });
});

describe('an arrival with no send to account for it', () => {
  it('is unprompted once the send it followed is spent', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/twice`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    let seen = 0;
    const both = new Promise<void>(resolve => {
      socket.on('message', () => { if (++seen === 2) resolve(); });
    });
    socket.send('ask once');
    await both;
    socket.close();

    const arrived = proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'in');
    expect(arrived.map(e => levelOf(e))).toEqual(['likely', 'unprompted']);
    // One send, many arrivals is the same shape as a stream after a subscribe,
    // so the socket reads as push rather than crediting both to the send.
    expect(proxy.socketShapes()[0].shape).toBe('push');
  });

  it('carries the send\'s command, not the one it landed under', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/slowecho`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    proxy.mark({ kind: 'command', index: 12 });
    const echoed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send('ask');
    // Wait for the send to actually cross, so 12 is what it was sent under.
    await new Promise<void>(resolve => {
      const poll = () => (proxy.eventsIn().some(e => e.kind === 'frame' && e.direction === 'out')
        ? resolve()
        : setTimeout(poll, 5));
      poll();
    });
    // A read-only command runs while the answer is still in flight.
    proxy.mark({ kind: 'command', index: 13 });
    await echoed;
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(levelOf(arrived!)).toBe('likely');
    // The event keeps where it crossed; the send it settles is the evidence.
    expect(arrived!.commandIndex).toBe(13);
    expect(arrived!.evidence?.pairing).toMatchObject({
      how: 'allowance', sentUnder: { kind: 'command', index: 12 },
    });
  });
});

describe('two sends outstanding at once', () => {
  it('settle in order, each answer carrying its own send\'s command', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/slowecho`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const sentCount = () =>
      proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'out').length;
    const crossed = (n: number) => new Promise<void>(resolve => {
      const poll = () => (sentCount() >= n ? resolve() : setTimeout(poll, 5));
      poll();
    });

    let seen = 0;
    const both = new Promise<void>(resolve => {
      socket.on('message', () => { if (++seen === 2) resolve(); });
    });

    proxy.mark({ kind: 'command', index: 12 });
    socket.send('first');
    await crossed(1);
    proxy.mark({ kind: 'command', index: 13 });
    socket.send('second');
    await crossed(2);
    await both;
    socket.close();

    const arrived = proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'in');
    expect(arrived.map(e => e.evidence?.pairing?.sentUnder))
      .toEqual([{ kind: 'command', index: 12 }, { kind: 'command', index: 13 }]);
  });

  it('stops accounting for an answer once the send has aged out', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mute`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const real = Date.now;
    proxy.mark({ kind: 'command', index: 4 });
    socket.send('fire and forget');
    await new Promise<void>(resolve => {
      const poll = () => (proxy.eventsIn().some(e => e.kind === 'frame' && e.direction === 'out')
        ? resolve()
        : setTimeout(poll, 5));
      poll();
    });

    // The server pushes long after the send could still be answering it.
    Date.now = () => real() + 60_000;
    try {
      const pushed = new Promise<void>(resolve => socket.on('message', () => resolve()));
      muted!.send('an hour later');
      await pushed;
    } finally {
      Date.now = real;
    }
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    // A send was made and aged out. Whether this answers it is not measurable,
    // so the frame claims nothing rather than asserting no send existed.
    expect(levelOf(arrived!)).toBe('positional');
    // And one slow answer does not make a reply-only socket a pushing one.
    expect(proxy.socketShapes()[0].shape).not.toBe('push');
  });
});

describe('an id both frames carry', () => {
  it('pairs an answer to its send whatever order the answers return in', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const sentCount = () =>
      proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'out').length;
    const crossed = (n: number) => new Promise<void>(resolve => {
      const poll = () => (sentCount() >= n ? resolve() : setTimeout(poll, 5));
      poll();
    });
    let seen = 0;
    const both = new Promise<void>(resolve => {
      socket.on('message', () => { if (++seen === 2) resolve(); });
    });

    proxy.mark({ kind: 'command', index: 12 });
    socket.send(JSON.stringify({ id: 'slow' }));
    await crossed(1);
    proxy.mark({ kind: 'command', index: 13 });
    socket.send(JSON.stringify({ id: 'fast' }));
    await crossed(2);
    await both;
    socket.close();

    const arrived = proxy.eventsIn().filter(e => e.kind === 'frame' && e.direction === 'in');
    // The fast answer returns first. A queue would hand it cmd 12; the id
    // hands it cmd 13, which is the send it actually answers.
    expect(arrived.map(e => levelOf(e))).toEqual(['observed', 'observed']);
    // The fast answer returns first; the id points each at its own send.
    expect(arrived.map(e => e.evidence?.pairing?.sentUnder))
      .toEqual([{ kind: 'command', index: 13 }, { kind: 'command', index: 12 }]);
    expect(proxy.socketShapes()[0].paired).toBe(2);
  });
});

describe('the evidence a frame carries', () => {
  it('groups frames of one kind under a payload shape', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const echoed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send(JSON.stringify({ cmd: 'push', n: 1 }));
    await echoed;
    socket.close();

    const sent = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'out');
    expect(sent!.evidence?.shape).toBe('json:cmd,n');
    // The echo is a text frame, not an object, so it bands by size instead.
    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(arrived!.evidence?.shape).toMatch(/^text:/);
  });

  it('records the socket counts standing when it crossed', async () => {
    const { proxy, port } = await freshProxy();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/greets`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    const greeted = new Promise<void>(resolve => socket.on('message', () => resolve()));
    await greeted;
    socket.close();

    const arrived = proxy.eventsIn().find(e => e.kind === 'frame' && e.direction === 'in');
    expect(arrived!.evidence?.socket).toMatchObject({ sent: 0, received: 1, unprompted: 1 });
    expect(levelOf(arrived!)).toBe('unprompted');
  });

  it('says of a request only that the protocol paired it', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'command', index: 3 });
    await through(port, '/paired');
    const event = proxy.eventsIn()[0];
    expect(event.evidence?.protocolPaired).toBe(true);
    expect(event.evidence?.pairing).toBeUndefined();
    expect(levelOf(event)).toBe('positional');
  });
});

describe('what a frame carries', () => {
  it('takes the cursor it arrived under, not the one the socket opened under', async () => {
    const { proxy, port } = await freshProxy();
    proxy.mark({ kind: 'command', index: 20 });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`, {
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    // The socket opened under 20; the exchange happens under 21.
    proxy.mark({ kind: 'command', index: 21 });
    const echoed = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send('hello');
    await echoed;
    socket.close();

    const frames = proxy.eventsIn().filter(e => e.kind === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(f => f.commandIndex === 21)).toBe(true);
  });
});
