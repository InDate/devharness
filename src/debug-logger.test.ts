// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { disableHistoryLogging, enableHistoryLogging, logToHistoryFile, readHistoryLines } from './debug-logger.js';
import { setWorkingDirOverride } from './helpers/paths.js';

let dir: string;
let logs: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'history-log-'));
  setWorkingDirOverride(dir);
  logs = join(dir, '.devharness', 'logs');
  await fsp.mkdir(logs, { recursive: true });
});

afterEach(async () => {
  disableHistoryLogging();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('history.log', () => {
  it('keeps every entry when commands are logged at the same time', async () => {
    await fsp.writeFile(join(logs, 'history.log'), '');
    enableHistoryLogging();

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      logToHistoryFile(JSON.stringify({ tool: 'navigate', params: { action: 'reload', n: i } }))));

    const lines = (await fsp.readFile(join(logs, 'history.log'), 'utf-8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
  });

  it('reports a line that is not a logged call rather than a call to no tool', async () => {
    await fsp.writeFile(join(logs, 'history.log'), '5\n{}\n');

    expect(await readHistoryLines([1, 2])).toEqual([
      { line: 1, error: expect.stringContaining('not a logged call') },
      { line: 2, error: expect.stringContaining('not a logged call') },
    ]);
  });
});
