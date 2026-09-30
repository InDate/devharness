// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { createDownloadTools, readLimited } from './download-tools.js';

let dir: string;
let server: Server;
let origin = '';

beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'download-tools-'));
  setWorkingDirOverride(dir);
  server = createServer((req, res) => {
    if (req.url === '/endless') {
      // No content-length: the size is known only by reading.
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = 'x'.repeat(64 * 1024);
      const timer = setInterval(() => res.write(chunk), 1);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('download with overwriteIfExists', () => {
  it('saves a file that does not exist yet', async () => {
    const { download } = createDownloadTools();

    const result: any = await download.handler({ url: `${origin}/hello.txt`, filename: 'first-run.txt', overwriteIfExists: true });

    expect(result.isError).toBeFalsy();
    expect(await fsp.readFile(join(dir, '.devharness', 'downloads', 'first-run.txt'), 'utf-8')).toBe('hello');
  });
});

describe('readLimited', () => {
  it('stops reading a body with no content-length once it passes the limit', async () => {
    const response = await fetch(`${origin}/endless`);

    const read = await readLimited(response, 256 * 1024);

    expect(read).toEqual({ tooLarge: true, bytes: expect.any(Number) });
  });

  it('returns a body within the limit whole', async () => {
    const response = await fetch(`${origin}/hello.txt`);

    const read = await readLimited(response, 1024);

    expect(read).toMatchObject({ tooLarge: false });
    expect((read as { buffer: Buffer }).buffer.toString()).toBe('hello');
  });
});
