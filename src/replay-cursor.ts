/**
 * Where a replay clicks, drawn by Chrome's overlay over the page.
 *
 * An element put into the app's document is read as the app's own by
 * everything that reads the page: its animations become rows, its captures
 * show it, its DOM holds it. The overlay is drawn by the browser above the
 * document and appears in none of them. A key press needs no mark on the
 * page: the bench's step list names the step running, key and all.
 */

import type { Page } from 'puppeteer-core';

export interface ReplayCursor {
  /** Mark the point a click lands on, for a moment. */
  click(x: number, y: number, isRightClick: boolean): Promise<void>;
  close(): Promise<void>;
}

/** Side of the square marking a click, in CSS px. */
const MARK_PX = 16;
/** How long a click's mark stays drawn. */
const MARK_MS = 350;

export async function openReplayCursor(page: Page): Promise<ReplayCursor | null> {
  let client: Awaited<ReturnType<Page['createCDPSession']>>;
  try {
    client = await page.createCDPSession();
    await client.send('DOM.enable');
    await client.send('Overlay.enable');
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => client.send('Overlay.hideHighlight').catch(() => {});
  return {
    click: async (x, y, isRightClick) => {
      if (timer) clearTimeout(timer);
      const tone = isRightClick ? { r: 180, g: 64, b: 126 } : { r: 26, g: 115, b: 232 };
      await client.send('Overlay.highlightRect', {
        x: Math.round(x - MARK_PX / 2), y: Math.round(y - MARK_PX / 2), width: MARK_PX, height: MARK_PX,
        color: { ...tone, a: 0.35 }, outlineColor: { ...tone, a: 0.9 },
      }).catch(() => {});
      timer = setTimeout(() => void hide(), MARK_MS);
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      await hide();
      await client.detach().catch(() => {});
    },
  };
}
