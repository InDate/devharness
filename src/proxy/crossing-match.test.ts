/**
 * What a traffic check reads: a counter in the proxy, matched as a pin
 * matches, counting from when it is set. Also the socket state a socket check
 * reads, and the headers an upgrade carries upstream.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

describe('the matching pins and owns checks share', () => {
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

describe('socket state and upgrade headers', () => {
  it('reads a socket open while it is, and closed once it is not', async () => {
    const { proxy, port } = await freshProxy();
    expect(proxy.socketOpen('/live')).toBe(false);
    const socket = await socketThrough(port, '/live');
    await vi.waitFor(() => expect(proxy.socketOpen('/live')).toBe(true));
    socket.close();
    await vi.waitFor(() => expect(proxy.socketOpen('/live')).toBe(false));
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
