/**
 * Refusing unmatched writes, and the bench's own control plane, which the
 * refusal leaves alone: refused, the `POST /boundary/refuse` that turns the
 * setting off would be refused too, a one-way switch with no escape from the
 * browser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { InterceptProxy } from './intercept-proxy.js';

let app: Server;
let bench: Server;
let appPort = 0;
let benchPort = 0;

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

beforeAll(async () => {
  app = createServer((_req, res) => { res.writeHead(200); res.end('app'); });
  bench = createServer((_req, res) => { res.writeHead(200); res.end('bench'); });
  appPort = await listen(app);
  benchPort = await listen(bench);
});

afterAll(async () => {
  await new Promise<void>(resolve => app.close(() => resolve()));
  await new Promise<void>(resolve => bench.close(() => resolve()));
});

function post(proxyPort: number, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxyPort, method: 'POST',
      path: `http://127.0.0.1:${port}${path}`, headers: { Host: `127.0.0.1:${port}` },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('refusing unmatched writes', () => {
  it("refuses the app's write and lets the bench's control plane through", async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    proxy.allowQuietly([`127.0.0.1:${benchPort}`]);
    proxy.refuseUnmatchedWrites(true);

    expect(await post(port, appPort, '/prefs')).toBe(403);
    expect(await post(port, benchPort, '/boundary/refuse')).toBe(200);
    expect(proxy.refusedWrites).toBe(1);
    await proxy.stop();
  });
});
