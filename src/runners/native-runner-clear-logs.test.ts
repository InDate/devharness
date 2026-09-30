// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NativeRunner } from './native-runner.js';
import { setWorkingDirOverride } from '../helpers/paths.js';

let dir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'native-runner-clear-'));
  setWorkingDirOverride(dir);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function startWith(clearLogs: boolean | undefined): Promise<string> {
  const logDir = join(dir, '.devharness', 'logs', 'quiet-server');
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(join(logDir, 'stdout.log'), 'line from the run before\n');
  const runner = new NativeRunner('quiet-server');
  await runner.start({ command: 'node -e "setTimeout(() => {}, 5000)"', cwd: dir, id: 'quiet-server', clearLogs });
  await runner.stop({ reason: 'test finished' } as any).catch(() => {});
  return fsp.readFile(join(logDir, 'stdout.log'), 'utf-8');
}

describe('starting a native server', () => {
  it('keeps the earlier run in its log by default', async () => {
    expect(await startWith(undefined)).toContain('line from the run before');
  });

  it('empties its log first with clearLogs', async () => {
    const log = await startWith(true);
    expect(log).not.toContain('line from the run before');
    expect(log).toContain('--- Server quiet-server started at');
  });
});
