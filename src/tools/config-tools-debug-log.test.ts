// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { createConfigTools } from './config-tools.js';

let dir: string;
beforeAll(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'config-debug-log-')));
  setWorkingDirOverride(dir);
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe('config debugLoggingStatus', () => {
  it('names the file debug logging writes, under the state directory in use', async () => {
    const result: any = await createConfigTools().config.handler({ action: 'debugLoggingStatus' });

    expect(result.content[0].text).toContain(join(dir, '.devharness', 'logs', 'debug.log'));
  });
});
