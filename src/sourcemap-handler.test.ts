// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SourceMapGenerator } from 'source-map';
import { SourceMapHandler } from './sourcemap-handler.js';

/**
 * A built app on disk: dist/assets/app.js.map maps generated line 3 of
 * assets/app.js back to line 10 of src/app.ts.
 */
let dist: string;

beforeAll(async () => {
  dist = await fsp.mkdtemp(join(tmpdir(), 'dist-'));
  await fsp.mkdir(join(dist, 'assets'));
  const generator = new SourceMapGenerator({ file: 'app.js' });
  generator.addMapping({ source: '../../src/app.ts', original: { line: 10, column: 2 }, generated: { line: 3, column: 0 } });
  generator.setSourceContent('../../src/app.ts', 'const original = true;');
  await fsp.writeFile(join(dist, 'assets', 'app.js.map'), generator.toString());
  await fsp.writeFile(join(dist, 'assets', 'app.js'), '\n\nrun();\n');
});

afterAll(async () => {
  await fsp.rm(dist, { recursive: true, force: true });
});

describe('source maps registered from a directory', () => {
  it('map a location in the served script back to its original source', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    const original = await handler.mapToOriginal('http://localhost:3000/assets/app.js?v=7', 3, 0);

    expect(original).toMatchObject({ line: 10, column: 2 });
    expect(original!.source).toContain('src/app.ts');
  });

  it('map an original location to the served script, by a path the page can resolve', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    const generated = await handler.mapToGenerated('src/app.ts', 10, 2);

    expect(generated).toEqual({ generatedFile: 'assets/app.js', line: 3, column: 0 });
  });

  it('map an indented original line asked for at column 0, as a breakpoint asks', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    expect(await handler.mapToGenerated('src/app.ts', 10)).toEqual({ generatedFile: 'assets/app.js', line: 3, column: 0 });
  });

  it('give the original text of a source whose compiled script has another extension', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    expect(await handler.getOriginalContent('src/app.ts')).toBe('const original = true;');
  });

  it('are reported for the served script, and forgotten on clear', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    expect(handler.hasSourceMap('http://localhost:3000/assets/app.js')).toBe(true);
    expect(handler.hasSourceMap('http://localhost:3000/assets/other.js')).toBe(false);

    handler.clear();

    expect(handler.hasSourceMap('http://localhost:3000/assets/app.js')).toBe(false);
  });
});

describe('a paused frame in a script a directory map covers', () => {
  it('is reported by inspect getCallStack at its original line', async () => {
    const { createInspectionTools } = await import('./tools/inspection-tools.js');
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);
    // Chrome reports call frame lines 0-based: generated line 3 arrives as 2.
    const cdpManager = {
      getCallStack: () => [{
        callFrameId: 'frame-1', functionName: 'tick', url: 'http://localhost:3000/assets/app.js',
        location: { scriptId: '7', lineNumber: 2, columnNumber: 0 },
      }],
    };
    const { inspect } = createInspectionTools(handler, async () => ({ cdpManager }) as any);

    const result: any = await inspect.handler({ action: 'getCallStack', connectionReason: 'my-web-app' });

    expect(result.content[0].text).toContain('Paused at: ../../src/app.ts:10');
    expect(result.content[0].text).toContain('../../src/app.ts:10:3');
  });
});

describe('a breakpoint set on an original line a directory map covers', () => {
  it('is set at the served script, in the 1-based line and column breakpoint calls take', async () => {
    const { createBreakpointTools } = await import('./tools/breakpoint-tools.js');
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);
    const setBreakpoint = vi.fn(async () => { throw new Error('stop after recording the call'); });
    const cdpManager = { getRuntimeType: () => 'chrome', isConnected: () => true, isScriptLoaded: () => false, setBreakpoint };
    const { breakpoint } = createBreakpointTools(handler, undefined, async () => ({ cdpManager }) as any);

    await breakpoint.handler({ action: 'set', connectionReason: 'my-web-app', url: 'src/app.ts', lineNumber: 10 } as any);
    await breakpoint.handler({ action: 'set', connectionReason: 'my-web-app', url: 'src/app.ts', lineNumber: 10, columnNumber: 3 } as any);

    expect(setBreakpoint.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['assets/app.js', 3, 1],
      ['assets/app.js', 3, 1],
    ]);
  });
});

describe('a paused frame no source map covers', () => {
  it('is reported by inspect getCallStack in 1-based line and column', async () => {
    const { createInspectionTools } = await import('./tools/inspection-tools.js');
    const cdpManager = {
      getCallStack: () => [{
        callFrameId: 'frame-1', functionName: 'tick', url: 'http://localhost:3000/plain.js',
        location: { scriptId: '8', lineNumber: 18, columnNumber: 29 },
      }],
    };
    const { inspect } = createInspectionTools(new SourceMapHandler(), async () => ({ cdpManager }) as any);

    const result: any = await inspect.handler({ action: 'getCallStack', connectionReason: 'my-web-app' });

    expect(result.content[0].text).toContain('http://localhost:3000/plain.js:19:30');
  });
});

describe('clear while a map is loading', () => {
  it('leaves no map behind from the load that was in flight', async () => {
    const handler = new SourceMapHandler();
    await handler.registerSourceMapsFromDirectory(dist);

    const inFlight = handler.mapToOriginal('http://localhost:3000/assets/app.js', 3, 0);
    handler.clear();
    await inFlight;

    expect(handler.getLoadedSourceMaps()).toEqual([]);
  });
});
