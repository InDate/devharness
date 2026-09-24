/**
 * A proxy started mid-command inherits that command.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { startProxyFor, stopProxyFor, markOnProxies, forgetCursor } from './registry.js';

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
    // launchChrome is marked before it runs and creates its proxy during the
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
