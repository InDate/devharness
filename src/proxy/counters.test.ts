/**
 * What a traffic check reads: a counter in the proxy, matched as a pin
 * matches, counting from when it is set. Also the socket state a socket check
 * reads, and the headers an upgrade carries upstream.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { InterceptProxy, frameMatches, fieldOf, requestMatches } from './intercept-proxy.js';

let origin: Server;
let originPort = 0;
let sockets: WebSocketServer;
let lastUpgrade: IncomingHttpHeaders | undefined;
const started: InterceptProxy[] = [];

async function freshProxy(): Promise<{ proxy: InterceptProxy; port: number }> {
  const proxy = new InterceptProxy();
  const { port } = await proxy.start();
  started.push(proxy);
  return { proxy, port };
}

function through(proxyPort: number, path: string, method = 'GET'): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxyPort, method,
      path: `http://127.0.0.1:${originPort}${path}`,
      headers: { Host: `127.0.0.1:${originPort}` },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end();
  });
}

async function socketThrough(port: number, path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Host: `127.0.0.1:${originPort}`, ...headers } });
  await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
  return socket;
}

const settled = () => new Promise(resolve => setTimeout(resolve, 60));

beforeAll(async () => {
  origin = createServer((_req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;
  sockets = new WebSocketServer({ server: origin });
  sockets.on('connection', (socket, req) => {
    lastUpgrade = req.headers;
    socket.on('message', raw => socket.send(JSON.stringify({ tag: 'echo', of: JSON.parse(String(raw)) })));
  });
});

afterAll(async () => {
  for (const proxy of started) await proxy.stop();
  sockets.close();
  await new Promise<void>(resolve => origin.close(() => resolve()));
});

describe('the matching pins and counters share', () => {
  it('matches a request by method, then by a substring of its URL', () => {
    expect(requestMatches({ urlIncludes: '/items', method: 'get' }, 'http://x/api/items?page=2', 'GET')).toBe(true);
    expect(requestMatches({ urlIncludes: '/items', method: 'POST' }, 'http://x/api/items', 'GET')).toBe(false);
    expect(requestMatches({}, 'http://x/anything', 'DELETE')).toBe(true);
  });

  it('compares a lone "key":value by field, anything else by substring', () => {
    const field = fieldOf('"i":1');
    const read = (text: string) => frameMatches({ textIncludes: '"i":1' }, field, 'ws://x/live', 'received', text, () => JSON.parse(text)).matched;
    expect(read('{"i":1}')).toBe(true);
    expect(read('{"i":10}')).toBe(false);
    expect(frameMatches({ textIncludes: 'i":1' }, undefined, 'ws://x/live', 'received', '{"i":10}', () => undefined).matched).toBe(true);
  });

  it('never matches a binary frame', () => {
    expect(frameMatches({}, undefined, 'ws://x/live', 'received', undefined, () => undefined).matched).toBe(false);
  });
});

describe('proxy counters', () => {
  it('counts the requests that match, from when it is set', async () => {
    const { proxy, port } = await freshProxy();
    await through(port, '/api/items');
    const counter = proxy.count({ urlIncludes: '/api/items', method: 'GET' });
    await through(port, '/api/items');
    await through(port, '/api/items?page=2');
    await through(port, '/api/other');
    await through(port, '/api/items', 'POST');
    expect(proxy.hitsOf(counter)).toBe(2);
  });

  it('counts what is already on the record from a start given, then counts on', async () => {
    const { proxy, port } = await freshProxy();
    await through(port, '/api/items');
    // Times are in milliseconds, so a crossing in the same one as the start counts; kept apart either side.
    await new Promise(resolve => setTimeout(resolve, 5));
    const since = Date.now();
    await new Promise(resolve => setTimeout(resolve, 5));
    await through(port, '/api/items');
    await through(port, '/api/items');
    await settled();
    const counter = proxy.count({ urlIncludes: '/api/items' }, since);
    expect(proxy.hitsOf(counter)).toBe(2);
    await through(port, '/api/items');
    expect(proxy.hitsOf(counter)).toBe(3);
    expect(proxy.isPartial(counter)).toBe(false);
  });

  it('matches frames on the record by their full text, as it crossed', async () => {
    const { proxy, port } = await freshProxy();
    const since = Date.now();
    const socket = await socketThrough(port, '/live');
    const answered = new Promise<void>(resolve => socket.on('message', () => resolve()));
    socket.send(JSON.stringify({ pad: 'x'.repeat(300), cmd: 'ping' }));
    await answered;
    await settled();
    // The field sits past the 200-character preview; the record keeps the whole frame.
    const counter = proxy.count({ direction: 'sent', textIncludes: '"cmd":"ping"' }, since);
    expect(proxy.hitsOf(counter)).toBe(1);
    socket.close();
  });

  it('stops counting once released', async () => {
    const { proxy, port } = await freshProxy();
    const counter = proxy.count({ urlIncludes: '/api' });
    await through(port, '/api/a');
    proxy.release(counter);
    await through(port, '/api/b');
    expect(proxy.hitsOf(counter)).toBeUndefined();
  });

  it('counts frames by direction and payload, as a frame pin matches', async () => {
    const { proxy, port } = await freshProxy();
    const sent = proxy.count({ urlIncludes: '/live', direction: 'sent', textIncludes: '"cmd":"ping"' });
    const echoes = proxy.count({ direction: 'received', textIncludes: '"tag":"echo"' });
    const requests = proxy.count({ urlIncludes: '/live' });
    const socket = await socketThrough(port, '/live');
    const answered = new Promise<void>(resolve => {
      let n = 0;
      socket.on('message', () => { if (++n === 2) resolve(); });
    });
    socket.send('{"cmd":"ping"}');
    socket.send('{"cmd":"pong"}');
    await answered;
    await settled();
    expect(proxy.hitsOf(sent)).toBe(1);
    expect(proxy.hitsOf(echoes)).toBe(2);
    // A match naming no direction or payload counts requests: the socket's
    // opening is one, a GET, and its frames are not.
    expect(proxy.hitsOf(requests)).toBe(1);
    socket.close();
  });
});

describe('socket state and upgrade headers', () => {
  it('reads a socket open while it is, and closed once it is not', async () => {
    const { proxy, port } = await freshProxy();
    expect(proxy.socketOpen('/live')).toBe(false);
    const socket = await socketThrough(port, '/live');
    await settled();
    expect(proxy.socketOpen('/live')).toBe(true);
    socket.close();
    await settled();
    expect(proxy.socketOpen('/live')).toBe(false);
  });

  it('carries the page\'s cookie and authorization onto the upstream socket', async () => {
    const { port } = await freshProxy();
    const socket = await socketThrough(port, '/live', { Cookie: 'session=abc', Authorization: 'Bearer t' });
    await settled();
    expect(lastUpgrade?.cookie).toBe('session=abc');
    expect(lastUpgrade?.authorization).toBe('Bearer t');
    socket.close();
  });
});
