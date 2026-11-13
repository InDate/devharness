/**
 * Tests for the per-session event stream.
 *
 * The property worth pinning is that every kind lands in one file: a session
 * arms one watch, and a kind added later arrives on it without a second one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths, setWorkingDirOverride, getOutputPath } from './helpers/paths.js';
import { spawn, spawnSync } from 'child_process';
import { createServer, type Server } from 'net';
import {
  appendEvent,
  deliverStream,
  getEventCursorPath,
  getEventStreamPath,
  getEventsDir,
  streamReaders,
} from './session-events.js';

let dir: string;
let previousDir: string | undefined;

const SESSION = 'aaaaaaaa';

function readStream(): Array<Record<string, unknown>> {
  const path = getEventStreamPath(SESSION);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-events-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

describe('appendEvent', () => {
  it('writes one stamped, kinded line per event, every kind in the one file a watch reads', async () => {
    await appendEvent(SESSION, 'block', { guard: 'port', tool: 'navigate' });
    await appendEvent(SESSION, 'annotation', { note: 'n' });

    const events = readStream();
    expect(getEventStreamPath(SESSION)).toBe(join(getEventsDir(), 'aaaaaaaa.jsonl'));
    expect(events.map(e => e.kind)).toEqual(['block', 'annotation']);
    expect(events[0]).toMatchObject({ kind: 'block', guard: 'port', tool: 'navigate' });
    expect(typeof events[0].ts).toBe('string');
  });
});

const hasLsof = spawnSync('lsof', ['-v']).error === undefined;

describe.skipIf(!hasLsof)('streamReaders', () => {
  it('counts none on a stream nothing holds open, written to or not', async () => {
    expect(await streamReaders(SESSION)).toBe(0);
    await appendEvent(SESSION, 'block', {});
    expect(await streamReaders(SESSION)).toBe(0);
  });

  it('counts a process holding the stream open, which is what a watch is', async () => {
    await appendEvent(SESSION, 'block', {});
    const tail = spawn('tail', ['-f', '-n0', getEventStreamPath(SESSION)]);
    try {
      await vi.waitFor(async () => expect(await streamReaders(SESSION)).toBeGreaterThan(0), { timeout: 5000 });
    } finally {
      tail.kill();
    }
  });
});

describe('delivery to the messaging socket of the session', () => {
  let server: Server;
  let frames: Array<{ type: string; message: { content: string } }>;
  let previousConfig: string | undefined;
  let previousSocket: string | undefined;

  beforeEach(async () => {
    previousConfig = process.env.CLAUDE_CONFIG_DIR;
    previousSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
    mkdirSync(join(dir, 'claude', 'sessions'), { recursive: true });
    frames = [];
    const socketPath = join(dir, 's.sock');
    server = createServer(conn => {
      let buffered = '';
      conn.on('data', chunk => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop()!;
        for (const line of lines) frames.push(JSON.parse(line));
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    writeFileSync(join(dir, 'claude', 'sessions', `${process.pid}.json`), JSON.stringify({
      sessionId: `${SESSION}-6a83-4c1e-9d2f-000000000000`, messagingSocketPath: socketPath, startedAt: Date.now(),
    }));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousSocket !== undefined) process.env.CLAUDE_CODE_MESSAGING_SOCKET = previousSocket;
  });

  it('sends a burst as one message and moves the cursor past it', async () => {
    await appendEvent(SESSION, 'block', { guard: 'port' });
    await appendEvent(SESSION, 'annotation', { note: 'flashes empty' });
    await appendEvent(SESSION, 'screenshot', { path: '/s.png' });

    await vi.waitFor(() => expect(existsSync(getEventCursorPath(SESSION))).toBe(true), { timeout: 8000, interval: 100 });
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('user');
    const body = frames[0].message.content;
    expect(body).toContain('"kind":"block"');
    expect(body).toContain('flashes empty');
    expect(body).toContain('/s.png');
    expect(Number(readFileSync(getEventCursorPath(SESSION), 'utf-8'))).toBe(readFileSync(getEventStreamPath(SESSION)).length);
  }, 10000);

  it('leaves the lines for a watch where the session has no socket', async () => {
    rmSync(join(dir, 'claude', 'sessions', `${process.pid}.json`));
    mkdirSync(getEventsDir(), { recursive: true });
    writeFileSync(getEventStreamPath(SESSION), JSON.stringify({ kind: 'block' }) + '\n');

    await deliverStream(SESSION);

    expect(frames).toHaveLength(0);
    expect(existsSync(getEventCursorPath(SESSION))).toBe(false);
  });
});
