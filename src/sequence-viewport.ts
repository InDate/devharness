import type { Page } from 'puppeteer-core';

/**
 * The page's viewport set by emulation.
 *
 * What a step reaches depends on the viewport: an element below the fold
 * takes a scroll to hover, and a scroll listener's motion follows how far the
 * page can scroll. A sequence that needs one size carries a step that sets it,
 * and the size holds whatever the person's window measures.
 * `Emulation.setDeviceMetricsOverride`, through Puppeteer's `setViewport`,
 * leaves the window where the person put it, and is set on the page's own
 * session: one set on a session that detaches goes with it.
 *
 * Set inside a run, the size lasts until the run ends, which puts back the
 * viewport the page had when it began. Set outside one, it stands until a
 * call releases it.
 */

export interface Viewport { width: number; height: number }

type ViewportPage = Pick<Page, 'evaluate' | 'setViewport' | 'viewport'>;

/** The layout viewport the page measures now, with the pixel ratio an emulated one keeps. */
export async function measureViewport(page: Pick<Page, 'evaluate'>): Promise<Viewport & { scale: number }> {
  return page.evaluate(() => {
    const w = (globalThis as any).window;
    return { width: w.innerWidth, height: w.innerHeight, scale: w.devicePixelRatio || 1 };
  });
}

/**
 * Sets the page's viewport to `size` by emulation, keeping its pixel ratio so
 * a retina page stays at 2x, or with `undefined` releases it to follow its
 * window. Returns what the page measures afterwards.
 */
export async function setPageViewport(page: ViewportPage, size: Viewport | undefined): Promise<Viewport> {
  if (size) {
    const { scale } = await measureViewport(page);
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: scale });
  } else {
    await page.setViewport(null);
  }
  const { width, height } = await measureViewport(page);
  return { width, height };
}

/**
 * Takes the viewport the page holds as a run begins, and returns what puts it
 * back: a viewport step inside the run lasts as long as the run, and a size
 * set before it, by a call outside any run, is the one restored.
 */
export function viewportAtRunStart(page: ViewportPage): () => Promise<void> {
  const before = page.viewport();
  return async () => {
    const now = page.viewport();
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    await page.setViewport(before ?? null);
  };
}
