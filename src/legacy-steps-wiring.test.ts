// @vitest-environment node
/**
 * Calls to removed tools are rewritten where they enter. These cover two of
 * those places end to end: a sequence file read from disk, and a history.log
 * line read for runFromLog.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CommandRecorder } from './command-recorder.js';
import { readHistoryLines } from './debug-logger.js';
import { setWorkingDirOverride } from './helpers/paths.js';

let dir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'legacy-wiring-'));
  setWorkingDirOverride(dir);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('a sequence file written with removed tools', () => {
  it('loads with its steps and teardown in the new form', async () => {
    const file = join(dir, 'old-form.json');
    await fsp.writeFile(file, JSON.stringify({
      id: 'old-form', name: 'old-form', createdAt: 1,
      commands: [
        { tool: 'launchChrome', params: { reference: 'shop', url: 'http://shop.test/' } },
        { tool: 'getSourceCode', params: { url: 'app.js', connection: 'shop' } },
      ],
      teardown: [{ tool: 'killChrome', params: { reason: 'done' } }],
    }));

    const sequence = await new CommandRecorder().loadSequenceFromDisk(file);

    expect(sequence!.commands.map(c => [c.tool, c.params])).toEqual([
      ['connection', { action: 'launch', connection: 'shop', url: 'http://shop.test/' }],
      ['source', { action: 'get', url: 'app.js', connection: 'shop' }],
    ]);
    expect(sequence!.teardown!.map(c => [c.tool, c.params])).toEqual([
      ['browser', { action: 'kill', reason: 'done' }],
    ]);
  });
});

describe('a history.log line logged against a removed tool', () => {
  it('reads as the call that replaced it', async () => {
    const logs = join(dir, '.devharness', 'logs');
    await fsp.mkdir(logs, { recursive: true });
    await fsp.writeFile(join(logs, 'history.log'), [
      JSON.stringify({ tool: 'disconnectDebugger', params: { reference: 'shop', reason: 'done' } }),
      JSON.stringify({ tool: 'navigate', params: { action: 'reload', connection: 'shop' } }),
    ].join('\n') + '\n');

    const lines = await readHistoryLines([1, 2]);

    expect(lines).toEqual([
      { line: 1, tool: 'connection', params: { action: 'close', connection: 'shop', reason: 'done' } },
      { line: 2, tool: 'navigate', params: { action: 'reload', connection: 'shop' } },
    ]);
  });
});

describe('history.log', () => {
  it('keeps every entry when commands are logged at the same time', async () => {
    const { enableHistoryLogging, logToHistoryFile } = await import('./debug-logger.js');
    const logs = join(dir, '.devharness', 'logs');
    await fsp.mkdir(logs, { recursive: true });
    await fsp.writeFile(join(logs, 'history.log'), '');
    enableHistoryLogging();

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      logToHistoryFile(JSON.stringify({ tool: 'navigate', params: { action: 'reload', n: i } }))));

    const lines = (await fsp.readFile(join(logs, 'history.log'), 'utf-8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(20);
  });

  it('reports a line that is not a logged call rather than a call to no tool', async () => {
    const logs = join(dir, '.devharness', 'logs');
    await fsp.writeFile(join(logs, 'history.log'), '5\n{}\n');

    expect(await readHistoryLines([1, 2])).toEqual([
      { line: 1, error: expect.stringContaining('not a logged call') },
      { line: 2, error: expect.stringContaining('not a logged call') },
    ]);
  });
});
