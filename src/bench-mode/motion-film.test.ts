import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths } from '../helpers/paths.js';
import { getEventStreamPath } from '../session-events.js';
import { resolveSessionName } from '../session-identity.js';
import { cropsBySize, shareFilm, type Sample } from './motion-film.js';
import type { FilmView } from '../bench/wire.js';

const frame = (wallMs: number, deviceWidth: number, deviceHeight: number) => ({ wallMs, deviceWidth, deviceHeight });
const sample = (wallMs: number, x: number, y: number, width = 200, height = 36): Sample => ({ wallMs, value: '', box: { x, y, width, height } });

describe('the crop a film takes at each viewport size', () => {
  it('crops each size where the element stood while the page was that size, so a resize mid-film keeps every frame on it', () => {
    // A heading centred in a 1021px page, then in a 1280px one once a later step sets the viewport.
    const raw = [frame(0, 1021, 1105), frame(16, 1021, 1105), frame(32, 1280, 800), frame(48, 1280, 800)];
    const samples = [sample(0, 406, 150), sample(16, 406, 148), sample(32, 536, 146), sample(48, 536, 144)];

    const { crops, outside } = cropsBySize(raw, samples);

    expect(crops.get('1021x1105')?.clip).toEqual({ x: 398, y: 140, width: 216, height: 54 });
    expect(crops.get('1280x800')?.clip).toEqual({ x: 528, y: 136, width: 216, height: 54 });
    expect(outside).toBeUndefined();
  });

  it('takes no crop and reads outside where the element stood below the visible page', () => {
    const { crops, outside } = cropsBySize([frame(0, 1021, 1105), frame(16, 1021, 1105)], [sample(0, 222, 1136), sample(16, 352, 1143)]);

    expect(crops.get('1021x1105')).toEqual({ outside: 'all' });
    expect(outside).toBe('all');
  });

  it('cuts the crop to the viewport and reads part where some of the element fell outside it', () => {
    const { crops, outside } = cropsBySize([frame(0, 1280, 800)], [sample(0, 100, 780, 200, 40)]);

    expect(crops.get('1280x800')).toEqual({ clip: { x: 92, y: 772, width: 216, height: 28 }, outside: 'part' });
    expect(outside).toBe('part');
  });
});

describe('sharing a range of a film with the session', () => {
  let workDir: string;
  let originalCwd: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'motion-film-test-'));
    process.chdir(workDir);
    originalGlobalDir = process.env.CDP_TOOLS_DIR;
    process.env.CDP_TOOLS_DIR = join(workDir, 'global');
    initializePaths();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
    else process.env.CDP_TOOLS_DIR = originalGlobalDir;
    initializePaths();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes one film event holding the frames picked, numbered from 1, with their files and details', async () => {
    const dir = join(workDir, 'film');
    mkdirSync(dir);
    const view: FilmView = {
      step: 0, kind: 'animation rise h2', dir, endedBy: 'quiet', durationMs: 800, cause: 'page load',
      frames: [0, 1, 2, 3].map(i => ({ file: join(dir, `frame-000${i}.jpg`), atMs: i * 16, viewport: { width: 1280, height: 800 }, value: `opacity: ${i / 3}`, near: [] })),
    };
    writeFileSync(join(dir, 'film.json'), JSON.stringify(view));

    await shareFilm(dir, 1, 2);

    const path = getEventStreamPath(resolveSessionName());
    expect(existsSync(path)).toBe(true);
    const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'film', motion: 'animation rise h2', step: 1, of: 4, cause: 'page load',
      frames: [
        { frame: 2, file: join(dir, 'frame-0001.jpg'), atMs: 16, value: 'opacity: 0.3333333333333333' },
        { frame: 3, file: join(dir, 'frame-0002.jpg'), atMs: 32, value: 'opacity: 0.6666666666666666' },
      ],
    });
  });
});
