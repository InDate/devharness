/**
 * Frames of a page in motion, captured around a dispatch and tiled into one
 * contact sheet.
 *
 * A screenshot a call takes costs 30 to 60ms a frame and forces a frame of
 * its own, so a loop of them reads a 420ms settle as a handful of forced
 * frames at uneven gaps. Page.startScreencast hands over each frame the
 * compositor produced with the time it was swapped, at the page's own
 * cadence, and produces nothing while nothing on screen changes, so a gap in
 * the sheet is a gap in the motion. A tab in the background produces no
 * frames at all.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { cropPixels, decodePng, encodePng, type Pixels } from './png.js';
import { getOutputPath } from './helpers/paths.js';

export interface BurstOptions {
  /** Frames to keep; the capture ends at this many (default 60, the cap). */
  frames?: number;
  /** Capture window from the dispatch, ms (default 500). */
  forMs?: number;
  /** Region kept, in CSS px of the viewport. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Widest a tile on the sheet is drawn, px (default 320). */
  tileWidth?: number;
  /** Columns on the sheet (default 6). */
  columns?: number;
}

export interface BurstFrame {
  /** 0-based position in the burst. */
  index: number;
  /** ms from the dispatch to the compositor's swap of this frame; negative for a frame before it. */
  atMs: number;
  file: string;
  width: number;
  height: number;
}

export interface Burst {
  dir: string;
  sheet: string;
  frames: BurstFrame[];
  /** The capture window asked for and the moment the capture ended, ms from the dispatch. */
  forMs: number;
  endedAtMs: number;
  /** Why the capture ended: the window closed, the frame count was reached, or the hold the call took. */
  endedBy: 'window' | 'frames' | 'hold';
}

const MAX_FRAMES = 60;

interface RawFrame { data: Buffer; timestamp: number; deviceWidth: number; deviceHeight: number }

/**
 * Run `dispatch` while the screencast records, and keep recording for the
 * window after it. `until` resolves when something inside the call ends the
 * window early, as a hold taken on the page does: frames after it would all
 * read the same.
 */
export async function captureBurst<T>(
  client: { send(method: string, params?: any): Promise<any>; on(event: string, handler: (event: any) => void): void; off(event: string, handler: (event: any) => void): void },
  options: BurstOptions,
  dispatch: () => Promise<T>,
  until?: Promise<unknown>,
): Promise<{ result: T; burst: Burst }> {
  const wantFrames = Math.max(1, Math.min(MAX_FRAMES, Math.round(options.frames ?? MAX_FRAMES)));
  const forMs = Math.max(0, options.forMs ?? 500);
  const raw: RawFrame[] = [];
  let dispatchedAt = Date.now();
  let endedBy: Burst['endedBy'] = 'window';
  let endCapture: () => void = () => {};
  const windowClosed = new Promise<void>(resolve => { endCapture = resolve; });

  const onFrame = (event: any) => {
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    if (raw.length >= wantFrames) return;
    raw.push({
      data: Buffer.from(event.data, 'base64'),
      timestamp: event.metadata?.timestamp ? event.metadata.timestamp * 1000 : Date.now(),
      deviceWidth: event.metadata?.deviceWidth ?? 0,
      deviceHeight: event.metadata?.deviceHeight ?? 0,
    });
    if (raw.length >= wantFrames) { endedBy = 'frames'; endCapture(); }
  };
  client.on('Page.screencastFrame', onFrame);
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

  let result: T;
  try {
    dispatchedAt = Date.now();
    result = await dispatch();
    const timer = setTimeout(endCapture, Math.max(0, dispatchedAt + forMs - Date.now()));
    until?.then(() => { if (endedBy === 'window' && Date.now() < dispatchedAt + forMs) endedBy = 'hold'; endCapture(); }, () => endCapture());
    await windowClosed;
    clearTimeout(timer);
  } finally {
    client.off('Page.screencastFrame', onFrame);
    await client.send('Page.stopScreencast').catch(() => {});
  }
  const endedAtMs = Date.now() - dispatchedAt;

  const stamp = Date.now();
  const dir = getOutputPath('screenshots', new Date().toISOString().split('T')[0], `burst-${stamp}`);
  await fs.mkdir(dir, { recursive: true });
  const frames: BurstFrame[] = [];
  const tiles: { pixels: Pixels; caption: string }[] = [];
  for (const [index, frame] of raw.entries()) {
    let pixels = decodePng(frame.data);
    if (options.clip && frame.deviceWidth > 0) {
      const scale = pixels.width / frame.deviceWidth;
      pixels = cropPixels(pixels, {
        x: Math.round(options.clip.x * scale), y: Math.round(options.clip.y * scale),
        w: Math.round(options.clip.width * scale), h: Math.round(options.clip.height * scale),
      });
    }
    const atMs = Math.round(frame.timestamp - dispatchedAt);
    const file = path.join(dir, `frame-${String(index).padStart(2, '0')}.png`);
    await fs.writeFile(file, encodePng(pixels));
    frames.push({ index, atMs, file, width: pixels.width, height: pixels.height });
    tiles.push({ pixels, caption: `${atMs < 0 ? '-' : '+'}${Math.abs(atMs)}ms` });
  }
  const sheet = path.join(dir, 'sheet.png');
  await fs.writeFile(sheet, encodePng(contactSheet(tiles, options.tileWidth ?? 320, options.columns ?? 6)));
  return { result, burst: { dir, sheet, frames, forMs, endedAtMs, endedBy } };
}

/** Frames in a grid, each over its caption, the sheet sized by the frames. */
export function contactSheet(tiles: { pixels: Pixels; caption: string }[], tileWidth: number, columns: number): Pixels {
  const gap = 8;
  const captionHeight = GLYPH_H * TEXT_SCALE + 6;
  const scaled = tiles.map(tile => ({ pixels: fitWidth(tile.pixels, tileWidth), caption: tile.caption }));
  const cellW = Math.max(1, ...scaled.map(tile => tile.pixels.width));
  const cellH = Math.max(1, ...scaled.map(tile => tile.pixels.height)) + captionHeight;
  const cols = Math.max(1, Math.min(columns, scaled.length));
  const rows = Math.max(1, Math.ceil(scaled.length / cols));
  const width = cols * cellW + (cols + 1) * gap;
  const height = rows * cellH + (rows + 1) * gap;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 32; data[i + 3] = 255; }
  const sheet: Pixels = { width, height, data };
  scaled.forEach((tile, n) => {
    const col = n % cols;
    const row = Math.floor(n / cols);
    const left = gap + col * (cellW + gap);
    const top = gap + row * (cellH + gap);
    blit(sheet, tile.pixels, left, top);
    drawText(sheet, tile.caption, left, top + tile.pixels.height + 3, [235, 235, 235]);
  });
  return sheet;
}

/** The picture no wider than `maxWidth`, each output pixel the mean of the source box under it. */
export function fitWidth(pixels: Pixels, maxWidth: number): Pixels {
  if (pixels.width <= maxWidth) return pixels;
  const factor = pixels.width / maxWidth;
  const width = maxWidth;
  const height = Math.max(1, Math.round(pixels.height / factor));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * factor);
    const y1 = Math.min(pixels.height, Math.max(y0 + 1, Math.floor((y + 1) * factor)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * factor);
      const x1 = Math.min(pixels.width, Math.max(x0 + 1, Math.floor((x + 1) * factor)));
      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * pixels.width + sx) * 4;
          r += pixels.data[i]; g += pixels.data[i + 1]; b += pixels.data[i + 2]; count++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(r / count); data[o + 1] = Math.round(g / count); data[o + 2] = Math.round(b / count); data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

function blit(into: Pixels, from: Pixels, left: number, top: number): void {
  for (let y = 0; y < from.height; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= into.height) continue;
    const w = Math.min(from.width, into.width - left);
    if (w <= 0) continue;
    from.data.copy(into.data, (ty * into.width + left) * 4, y * from.width * 4, (y * from.width + w) * 4);
  }
}

const GLYPH_W = 5;
const GLYPH_H = 7;
const TEXT_SCALE = 2;

/** 5x7 glyphs for the captions: digits, the sign and the unit. */
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  'm': ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  's': ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(into: Pixels, text: string, left: number, top: number, colour: [number, number, number]): void {
  let x = left;
  for (const char of text) {
    const glyph = GLYPHS[char] ?? GLYPHS[' '];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < TEXT_SCALE; sy++) {
          for (let sx = 0; sx < TEXT_SCALE; sx++) {
            const px = x + gx * TEXT_SCALE + sx;
            const py = top + gy * TEXT_SCALE + sy;
            if (px < 0 || py < 0 || px >= into.width || py >= into.height) continue;
            const i = (py * into.width + px) * 4;
            into.data[i] = colour[0]; into.data[i + 1] = colour[1]; into.data[i + 2] = colour[2]; into.data[i + 3] = 255;
          }
        }
      }
    }
    x += (GLYPH_W + 1) * TEXT_SCALE;
  }
}

/** The frames as one line each, for a reply. */
export function describeBurst(burst: Burst): string {
  const ended = burst.endedBy === 'hold' ? `ended by the hold at +${burst.endedAtMs}ms`
    : burst.endedBy === 'frames' ? `ended at ${burst.frames.length} frames, +${burst.endedAtMs}ms`
    : `window ${burst.forMs}ms`;
  const times = burst.frames.map(frame => `${frame.atMs < 0 ? '' : '+'}${frame.atMs}`).join(', ');
  return `**Burst:** ${burst.frames.length} frame${burst.frames.length === 1 ? '' : 's'} (${ended}), swapped at ${times} ms from the dispatch\n`
    + `**Sheet:** ${burst.sheet}\n**Frames:** ${burst.dir}/frame-NN.png`;
}
