/**
 * What the screen shows, read from Chrome's screencast.
 *
 * `Page.captureScreenshot` waits on a frame from the renderer, and a page whose
 * main thread a hold has stopped produces none: measured on 26 Oct, raw and
 * through Puppeteer, it gave no answer in 10s on a held page. The screencast
 * hands over the compositor's frame instead, and starting one delivers the
 * frame on screen at once, held or not: 1ms after the start, at the window's
 * full size, showing a smooth scroll the main thread still read as unmoved
 * (`screencast-reads-held-screen`). Each frame carries the compositor's own
 * scroll offset, so a box measured in the document is placed on the frame by
 * where the screen stands, not by the main thread's last `scrollY`.
 *
 * A tab in the background paints no frames, so a capture there fails at its
 * bound rather than waiting.
 */

import { cropPixels, decodePng, encodePng } from './png.js';

interface ScreencastClient {
  send(method: string, params?: any): Promise<any>;
  on(event: string, handler: (event: any) => void): void;
  off(event: string, handler: (event: any) => void): void;
}

export interface ScreenRegion { x: number; y: number; width: number; height: number }

export interface ScreenShot {
  data: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** The compositor's scroll under the frame, CSS px. */
  scroll: { x: number; y: number };
  /** Part of the region asked for lay off screen and is not in the image. */
  clipped: boolean;
}

/** A region asked for that the screen's frame does not cover at all. */
export class OffScreenError extends Error {}

/** Longest a capture waits for the screen's frame. */
const FRAME_MS = 3000;

/**
 * The frame on screen now. `clip` keeps one region of it, measured in `of`:
 * the window's own CSS px, or the document's, which the frame's scroll offset
 * places on screen. A clipped capture is a PNG.
 */
export async function captureScreen(
  client: ScreencastClient,
  options: { clip?: ScreenRegion; of?: 'viewport' | 'document'; format?: 'png' | 'jpeg'; quality?: number; boundMs?: number } = {},
): Promise<ScreenShot> {
  const format = options.clip ? 'png' : options.format ?? 'png';
  let take: (event: any) => void = () => {};
  const frame = new Promise<any>(resolve => { take = resolve; });
  const onFrame = (event: any) => {
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    take(event);
  };
  client.on('Page.screencastFrame', onFrame);
  let event: any;
  try {
    await client.send('Page.startScreencast', {
      format, everyNthFrame: 1,
      ...(format === 'jpeg' && options.quality !== undefined ? { quality: options.quality } : {}),
    });
    const boundMs = options.boundMs ?? FRAME_MS;
    event = await Promise.race([frame, new Promise(resolve => setTimeout(() => resolve(undefined), boundMs))]);
    if (!event) throw new Error(`The screen produced no frame in ${boundMs}ms: a tab in the background paints none`);
  } finally {
    client.off('Page.screencastFrame', onFrame);
    await client.send('Page.stopScreencast').catch(() => {});
  }

  const meta = event.metadata ?? {};
  const scroll = { x: Number(meta.scrollOffsetX) || 0, y: Number(meta.scrollOffsetY) || 0 };
  const data = Buffer.from(event.data, 'base64');
  if (!options.clip) {
    const pixels = format === 'png' ? decodePng(data) : undefined;
    return { data, format, width: pixels?.width ?? (Number(meta.deviceWidth) || 0), height: pixels?.height ?? (Number(meta.deviceHeight) || 0), scroll, clipped: false };
  }

  const pixels = decodePng(data);
  const zoom = Number(meta.pageScaleFactor) || 1;
  const scale = meta.deviceWidth > 0 ? pixels.width / meta.deviceWidth : 1;
  const left = options.of === 'document' ? (options.clip.x - scroll.x) * zoom : options.clip.x;
  const top = options.of === 'document' ? (options.clip.y - scroll.y) * zoom : options.clip.y;
  const width = options.of === 'document' ? options.clip.width * zoom : options.clip.width;
  const height = options.of === 'document' ? options.clip.height * zoom : options.clip.height;
  // The region's overlap with the frame: a crop started at a clamped corner
  // would keep the region's size and return screen it never covered.
  const x0 = Math.max(0, left * scale), y0 = Math.max(0, top * scale);
  const x1 = Math.min(pixels.width, (left + width) * scale), y1 = Math.min(pixels.height, (top + height) * scale);
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new OffScreenError(`the screen stands at ${Math.round(scroll.x)},${Math.round(scroll.y)} in the document`);
  }
  const cropped = cropPixels(pixels, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const clipped = x0 > left * scale || y0 > top * scale || x1 < (left + width) * scale || y1 < (top + height) * scale;
  return { data: encodePng(cropped), format: 'png', width: cropped.width, height: cropped.height, scroll, clipped };
}
