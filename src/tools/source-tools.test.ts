import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSourceTools } from './source-tools.js';
import { CDPManager } from '../cdp-manager.js';

/** A connected CDPManager holding one script of `lines` lines at `url`. */
function managerWithScript(url: string, lines: number) {
  const cdpManager = new CDPManager();
  (cdpManager as any).state.connected = true;
  (cdpManager as any).findScriptIds = () => ({ scriptIds: ['1'] });
  (cdpManager as any).client = {
    Debugger: { getScriptSource: async () => ({ scriptSource: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') }) },
  };
  return cdpManager;
}

function sourceTool(cdpManager: CDPManager, sourceMapHandler: any = {}) {
  return createSourceTools(sourceMapHandler, async () => ({ cdpManager }) as any).source;
}

const text = (result: any) => result.content[0].text as string;

describe('source get', () => {
  it('reports the range it returned, clamped to the end of the script', async () => {
    const source = sourceTool(managerWithScript('http://app/app.js', 12));

    const result: any = await source.handler({ action: 'get', url: 'http://app/app.js', startLine: 5, endLine: 500, connection: 'my-web-app' });

    expect(text(result)).toContain('(lines 5-12)');
    expect(text(result)).toContain('  12 | line 12');
  });

  it('refuses a start line past the end of the script', async () => {
    const source = sourceTool(managerWithScript('http://app/app.js', 12));

    const result: any = await source.handler({ action: 'get', url: 'http://app/app.js', startLine: 40, connection: 'my-web-app' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('12 lines');
  });
});

describe('source get on a name no connection has', () => {
  it('names the connection it could not find', async () => {
    const source = createSourceTools({} as any, async () => null).source;

    const result: any = await source.handler({ action: 'get', url: 'app.js', connection: 'no-such-tab' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No connection is named "no-such-tab"');
  });
});

describe('source loadMaps', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'source-maps-'));
    await fsp.mkdir(join(dir, 'nested'));
    await fsp.writeFile(join(dir, 'app.js.map'), '{}');
    await fsp.writeFile(join(dir, 'nested', 'chunk.js.map'), '{}');
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('registers the maps in the directory and its subdirectories', async () => {
    const registerSourceMapsFromDirectory = vi.fn(async () => 2);
    const source = sourceTool(new CDPManager(), { registerSourceMapsFromDirectory });

    const result: any = await source.handler({ action: 'loadMaps', directory: dir });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Registered 2 source maps');
  });

  it('fails on a directory that does not exist, rather than reporting none found', async () => {
    const registerSourceMapsFromDirectory = vi.fn(async () => 0);
    const source = sourceTool(new CDPManager(), { registerSourceMapsFromDirectory });

    const result: any = await source.handler({ action: 'loadMaps', directory: join(dir, 'no-such-dir') });

    expect(result.isError).toBe(true);
    expect(registerSourceMapsFromDirectory).not.toHaveBeenCalled();
  });
});
