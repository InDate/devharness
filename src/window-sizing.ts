import type { Page } from 'puppeteer-core';

export interface Size {
  width: number;
  height: number;
}

export interface SizeWindowResult {
  /** The layout viewport the page ended up with. */
  viewport: Size;
  /** How the size was applied — emulation pins the page and hides window resizes. */
  mode: 'window' | 'emulated';
  /** Set when the window settled at a different size than asked for; the cause (display
   *  bounds, a window-manager minimum, page zoom) is not distinguishable from here. */
  clampedTo?: Size;
}

/**
 * The viewport a launch reports once its page has loaded. A navigation can
 * change the size the sizing read on the blank tab: per-origin zoom rescales
 * CSS pixels and a window manager can move the window. `differs` is set where
 * the loaded page measures other than `target`. Undefined where the page
 * cannot be read, and the launch keeps the sizing's own numbers.
 */
export async function loadedViewport(page: Page, target: Size): Promise<{ viewport: Size; differs: boolean } | undefined> {
  const measured = await readViewport(page).catch(() => undefined);
  if (!measured) return undefined;
  return { viewport: measured, differs: measured.width !== target.width || measured.height !== target.height };
}

/**
 * Chrome's window bounds are outer dimensions — they include the tab strip, the
 * omnibox and the frame. The caller asks for a *viewport*, so the chrome around it
 * has to be measured and added back.
 */
async function measureChrome(page: Page): Promise<Size> {
  return page.evaluate(() => {
    const w = (globalThis as any).window;
    return { width: w.outerWidth - w.innerWidth, height: w.outerHeight - w.innerHeight };
  });
}

/** The layout viewport the page measures now, innerWidth x innerHeight. */
export async function readViewport(page: Page): Promise<Size> {
  return page.evaluate(() => {
    const w = (globalThis as any).window;
    return { width: w.innerWidth, height: w.innerHeight };
  });
}

/**
 * Window managers apply bounds asynchronously (X11/Wayland) and macOS animates the
 * restore from minimized, so a read taken straight after setWindowBounds can be
 * mid-flight. Measuring the frame from a mid-flight outerWidth yields a wrong
 * correction, so wait for two equal reads before trusting one.
 */
async function settledViewport(page: Page, timeoutMs = 400, stepMs = 25): Promise<Size> {
  let previous = await readViewport(page);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    const next = await readViewport(page);
    if (next.width === previous.width && next.height === previous.height) return next;
    previous = next;
  }
  return previous;
}

/**
 * Resize the real OS window so the page's viewport becomes `target`.
 *
 * Not page.setViewport(): that is Emulation.setDeviceMetricsOverride, which paints the
 * requested size into whatever window Chrome already has — anything wider renders off the
 * frame while screenshots (reading the emulated surface) still look correct. The override
 * also pins the viewport, so the page stops tracking window resizes.
 *
 * Headless has no window, so emulation is the only option there.
 */
export async function sizeWindowToViewport(
  page: Page,
  target: Size,
  headless: boolean
): Promise<SizeWindowResult> {
  if (headless) {
    await page.setViewport(target);
    return { viewport: target, mode: 'emulated' };
  }

  const session = await page.createCDPSession();
  try {
    const { windowId } = (await session.send('Browser.getWindowForTarget')) as {
      windowId: number;
    };

    // A maximized, fullscreen or minimized window ignores bounds changes. The protocol
    // rejects windowState combined with a size, so this has to be its own call.
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await settledViewport(page);

    const chrome = await measureChrome(page);
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        width: target.width + chrome.width,
        height: target.height + chrome.height,
      },
    });

    // One correction pass: the frame measured before the resize can be stale once a
    // scrollbar or bar settles. A single pass cannot oscillate.
    let viewport = await settledViewport(page);
    if (viewport.width !== target.width || viewport.height !== target.height) {
      const correction = await measureChrome(page);
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: target.width + correction.width,
          height: target.height + correction.height,
        },
      });
      viewport = await settledViewport(page);
    }

    const clamped = viewport.width !== target.width || viewport.height !== target.height;
    return { viewport, mode: 'window', clampedTo: clamped ? viewport : undefined };
  } finally {
    await session.detach().catch(() => {});
  }
}
