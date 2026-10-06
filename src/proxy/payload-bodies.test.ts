/**
 * What the proxy keeps of a body: what a write sent, where it is structured,
 * and a response's class, with a binary response never decoded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { InterceptProxy } from './intercept-proxy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
let origin: Server;
let originPort = 0;

beforeAll(async () => {
  origin = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"saved":true}');
    });
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;
});

afterAll(async () => { await new Promise<void>(resolve => origin.close(() => resolve())); });

function call(proxyPort: number, method: string, path: string, body?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxyPort, method, path: `http://127.0.0.1:${originPort}${path}`,
      headers: { Host: `127.0.0.1:${originPort}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end(body);
  });
}

async function settled(proxy: InterceptProxy, count: number) {
  for (let i = 0; i < 100 && proxy.eventsIn().length < count; i++) await new Promise(r => setTimeout(r, 10));
  return proxy.eventsIn();
}

describe('the bodies the proxy keeps', () => {
  it('keeps what a JSON write sent beside its structured response', async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    await call(port, 'POST', '/prefs', '{"dark":true}');
    const [event] = await settled(proxy, 1);
    expect(event).toMatchObject({ method: 'POST', payloadClass: 'structured', sent: '{"dark":true}' });
    expect(proxy.bodyOf(event.id)).toBe('{"saved":true}');
    await proxy.stop();
  });

  it('classes an image as binary and keeps none of it as text', async () => {
    const proxy = new InterceptProxy();
    const { port } = await proxy.start();
    await call(port, 'GET', '/logo.png');
    const [event] = await settled(proxy, 1);
    expect(event).toMatchObject({ payloadClass: 'binary', size: PNG.length });
    expect(event.preview).toBeUndefined();
    expect(event).not.toHaveProperty('sent');
    expect(proxy.bodyOf(event.id)).toBeUndefined();
    await proxy.stop();
  });
});
