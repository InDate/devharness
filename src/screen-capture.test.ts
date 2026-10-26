import { describe, it, expect } from 'vitest';
import { OffScreenError, captureScreen } from './screen-capture.js';
import { decodePng, encodePng } from './png.js';

/** A client whose screencast answers its start with one frame: 2 image px per CSS px, the window 100 by 50. */
function screen(metadata: Record<string, number>, frame = true) {
  const handlers = new Map<string, (event: any) => void>();
  const sent: string[] = [];
  const pixels = { width: 200, height: 100, data: Buffer.alloc(200 * 100 * 4) };
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) pixels.data[(y * 200 + x) * 4] = y;
  return {
    sent,
    on: (event: string, handler: (event: any) => void) => { handlers.set(event, handler); },
    off: (event: string) => { handlers.delete(event); },
    send: async (method: string) => {
      sent.push(method);
      if (method === 'Page.startScreencast' && frame) {
        setTimeout(() => handlers.get('Page.screencastFrame')?.({
          data: encodePng(pixels).toString('base64'), sessionId: 1,
          metadata: { deviceWidth: 100, deviceHeight: 50, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0, ...metadata },
        }), 0);
      }
      return {};
    },
  };
}

describe('the screen as its own frame shows it', () => {
  it('crops a window region at the frame\'s pixel ratio', async () => {
    const shot = await captureScreen(screen({}), { clip: { x: 10, y: 5, width: 20, height: 10 }, of: 'viewport' });
    const pixels = decodePng(shot.data);
    expect([pixels.width, pixels.height]).toEqual([40, 20]);
    expect(pixels.data[0]).toBe(10);
    expect(shot.clipped).toBe(false);
  });

  it('places a document region by the frame\'s own scroll offset', async () => {
    const shot = await captureScreen(screen({ scrollOffsetY: 400 }), { clip: { x: 0, y: 420, width: 10, height: 10 }, of: 'document' });
    expect(decodePng(shot.data).data[0]).toBe(40);
    expect(shot.scroll).toEqual({ x: 0, y: 400 });
  });

  it('keeps only the part of a region on screen, and marks it clipped', async () => {
    const shot = await captureScreen(screen({ scrollOffsetY: 400 }), { clip: { x: 0, y: 380, width: 10, height: 40 }, of: 'document' });
    const pixels = decodePng(shot.data);
    expect(shot.clipped).toBe(true);
    expect([pixels.width, pixels.height]).toEqual([20, 40]);
    expect(pixels.data[0]).toBe(0);
  });

  it('refuses a region wholly off screen rather than returning screen it never covered', async () => {
    await expect(captureScreen(screen({ scrollOffsetY: 4000 }), { clip: { x: 0, y: 500, width: 10, height: 40 }, of: 'document' }))
      .rejects.toBeInstanceOf(OffScreenError);
  });

  it('fails at its bound when the screen sends no frame, and stops the screencast', async () => {
    const client = screen({}, false);
    await expect(captureScreen(client, { boundMs: 20 })).rejects.toThrow('no frame in 20ms');
    expect(client.sent).toContain('Page.stopScreencast');
  });
});
