/**
 * Tests for `devharness watch`.
 *
 * Each case runs the CLI as its own process with stdout on a pipe, the way a
 * background task runs it: output to a pipe is asynchronous, and a watch that
 * exits before its output drains loses lines its cursor has already passed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { build } from 'esbuild';

const SESSION = 'aaaa1111';

let bundleDir: string;
let cli: string;
let dir: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'devharness-watch-bundle-'));
  cli = join(bundleDir, 'cli.mjs');
  await build({
    stdin: {
      contents: `import { runCli } from ${JSON.stringify(join(process.cwd(), 'src', 'cli', 'index.ts'))};\nprocess.exit(await runCli(process.argv.slice(2)));`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: cli,
    logLevel: 'silent',
  });
}, 30000);

afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devharness-watch-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stream = () => join(dir, 'events', `${SESSION}.jsonl`);
const cursor = () => Number(readFileSync(join(dir, 'events', `${SESSION}.cursor`), 'utf-8'));
const append = (text: string) => appendFileSync(stream(), text);

function start(args: string[], env: Record<string, string | undefined> = {}): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const childEnv: Record<string, string | undefined> = { ...process.env, DEVHARNESS_DIR: dir };
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [cli, 'watch', ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', chunk => { out += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, output: () => out, exited };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const eventLines = (text: string) => text.split('\n').filter(line => line.startsWith('{'));

/** Long enough for the child to start and read its starting offset. */
const running = () => sleep(800);

describe('devharness watch', () => {
  it('reads a line appended while no watch ran, and none twice', async () => {
    writeFileSync(stream(), '');
    writeFileSync(join(dir, 'events', `${SESSION}.cursor`), '0');

    const first = start([`--session=${SESSION}`]);
    await running();
    append('{"n":1}\n');
    expect(await first.exited).toBe(0);
    expect(eventLines(first.output())).toEqual(['{"n":1}']);

    append('{"n":2}\n');
    const second = start([`--session=${SESSION}`]);
    expect(await second.exited).toBe(0);
    expect(eventLines(second.output())).toEqual(['{"n":2}']);
    expect(cursor()).toBe(statSync(stream()).size);
  }, 15000);

  it('delivers a backlog whole through a pipe before moving the cursor past it', async () => {
    const backlog = Array.from({ length: 3000 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(100)}"}\n`).join('');
    writeFileSync(stream(), backlog);
    writeFileSync(join(dir, 'events', `${SESSION}.cursor`), '0');

    const watch = start([`--session=${SESSION}`]);
    expect(await watch.exited).toBe(0);
    expect(eventLines(watch.output())).toHaveLength(3000);
    expect(cursor()).toBe(statSync(stream()).size);
  }, 15000);

  it('holds a line caught mid-write for the next watch', async () => {
    writeFileSync(stream(), '');
    writeFileSync(join(dir, 'events', `${SESSION}.cursor`), '0');
    append('{"n":1}\n{"n":');

    const watch = start([`--session=${SESSION}`]);
    expect(await watch.exited).toBe(0);
    expect(eventLines(watch.output())).toEqual(['{"n":1}']);
    expect(cursor()).toBe('{"n":1}\n'.length);
  }, 15000);

  it('--follow moves the cursor, so a one-off after it repeats nothing', async () => {
    writeFileSync(stream(), '');
    writeFileSync(join(dir, 'events', `${SESSION}.cursor`), '0');

    const follow = start([`--session=${SESSION}`, '--follow']);
    await running();
    append('{"n":1}\n');
    await sleep(1500);
    follow.child.kill();
    await follow.exited;
    expect(eventLines(follow.output())).toEqual(['{"n":1}']);

    append('{"n":2}\n');
    const once = start([`--session=${SESSION}`]);
    await once.exited;
    expect(eventLines(once.output())).toEqual(['{"n":2}']);
  }, 15000);

  it('refuses a session name that leaves the events directory', async () => {
    const watch = start(['--session=../escape']);
    expect(await watch.exited).toBe(1);
    expect(existsSync(join(dir, 'escape.jsonl'))).toBe(false);
  });

  it('refuses to run with no session named and none in the environment', async () => {
    const watch = start([]);
    expect(await watch.exited).toBe(1);
  });

  it('exits on start while a watch from the same Claude process reads the stream', async () => {
    writeFileSync(stream(), '');
    const client = { CLAUDE_CODE_MESSAGING_SOCKET: '/claude/4242.sock' };

    const first = start([`--session=${SESSION}`], client);
    await running();
    const second = start([`--session=${SESSION}`], client);
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain(`pid ${first.child.pid} already reads stream ${SESSION}`);

    append('{"n":1}\n');
    expect(await first.exited).toBe(0);
    expect(eventLines(first.output())).toEqual(['{"n":1}']);
    expect(eventLines(second.output())).toEqual([]);
  }, 15000);

  it('runs beside a watch from another Claude process', async () => {
    writeFileSync(stream(), '');

    const first = start([`--session=${SESSION}`], { CLAUDE_CODE_MESSAGING_SOCKET: '/claude/4242.sock' });
    await running();
    const second = start([`--session=${SESSION}`], { CLAUDE_CODE_MESSAGING_SOCKET: '/claude/5353.sock' });
    await running();
    append('{"n":1}\n');
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(eventLines(second.output())).toEqual(['{"n":1}']);
  }, 15000);

  it('runs when the recorded pid does not hold the stream open', async () => {
    writeFileSync(stream(), '');
    writeFileSync(join(dir, 'events', `${SESSION}.4242.watch`), JSON.stringify({ pid: process.pid }));

    const watch = start([`--session=${SESSION}`], { CLAUDE_CODE_MESSAGING_SOCKET: '/claude/4242.sock' });
    await running();
    append('{"n":1}\n');
    expect(await watch.exited).toBe(0);
    expect(eventLines(watch.output())).toEqual(['{"n":1}']);
  }, 15000);

  it('reads a full session id as its short form', async () => {
    writeFileSync(stream(), '{"n":1}\n');
    writeFileSync(join(dir, 'events', `${SESSION}.cursor`), '0');
    const watch = start([`--session=${SESSION}-2222-3333-4444-555555555555`]);
    expect(await watch.exited).toBe(0);
    expect(eventLines(watch.output())).toEqual(['{"n":1}']);
  }, 15000);
});
