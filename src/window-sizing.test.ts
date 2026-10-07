/**
 * Tests for sizeWindowToViewport.
 *
 * These never launch Chrome. A fake window models the two facts the real thing
 * imposes: bounds are outer dimensions, and the window manager may refuse a size.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Page } from 'puppeteer-core';
import { loadedViewport, sizeWindowToViewport } from './window-sizing.js';

interface FakeWindowOptions {
  /** Frame the browser adds around the viewport. */
  chrome?: { width: number; height: number };
  /** Frame after the first sized resize, for the stale-measurement case. */
  chromeAfterResize?: { width: number; height: number };
  /** Largest outer size the window manager will grant. */
  maxOuter?: { width: number; height: number };
}

function makeFake(options: FakeWindowOptions = {}) {
  const chrome = options.chrome ?? { width: 0, height: 88 };
  const state = {
    outerWidth: 1000,
    outerHeight: 800,
    chrome,
    sizedOnce: false,
  };

  const win = {
    get outerWidth() { return state.outerWidth; },
    get outerHeight() { return state.outerHeight; },
    get innerWidth() { return state.outerWidth - state.chrome.width; },
    get innerHeight() { return state.outerHeight - state.chrome.height; },
  };

  const sent: Array<{ method: string; params: any }> = [];
  const send = vi.fn(async (method: string, params?: any) => {
    sent.push({ method, params });
    if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
    if (method === 'Browser.setWindowBounds') {
      const bounds = params?.bounds ?? {};
      if (bounds.width !== undefined) {
        const cap = options.maxOuter;
        state.outerWidth = cap ? Math.min(bounds.width, cap.width) : bounds.width;
        state.outerHeight = cap ? Math.min(bounds.height, cap.height) : bounds.height;
        if (!state.sizedOnce && options.chromeAfterResize) state.chrome = options.chromeAfterResize;
        state.sizedOnce = true;
      }
    }
    return {};
  });

  const detach = vi.fn(async () => {});
  const setViewport = vi.fn(async () => {});
  const createCDPSession = vi.fn(async () => ({ send, detach }));

  const page = {
    setViewport,
    createCDPSession,
    evaluate: async (fn: () => unknown) => {
      (globalThis as any).window = win;
      return fn();
    },
  } as unknown as Page;

  const sizedBounds = () =>
    sent.filter((c) => c.method === 'Browser.setWindowBounds' && c.params.bounds.width !== undefined);

  return { page, sent, sizedBounds, send, detach, setViewport, createCDPSession };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('sizeWindowToViewport', () => {
  it('emulates in headless, where there is no window to size', async () => {
    const fake = makeFake();
    const result = await sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, true);

    expect(fake.setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(fake.createCDPSession).not.toHaveBeenCalled();
    expect(result).toEqual({ viewport: { width: 1280, height: 720 }, mode: 'emulated' });
  });

  it('normalizes the window state before sizing it, in a separate call', async () => {
    const fake = makeFake();
    await sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, false);

    const bounds = fake.sent.filter((c) => c.method === 'Browser.setWindowBounds');
    expect(fake.sent[0].method).toBe('Browser.getWindowForTarget');
    expect(bounds[0].params.bounds).toEqual({ windowState: 'normal' });
    expect(bounds[1].params.bounds.width).toBeDefined();
  });

  it('asks for the target plus the measured frame, and never emulates', async () => {
    const fake = makeFake({ chrome: { width: 12, height: 88 } });
    const result = await sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, false);

    expect(fake.sizedBounds()[0].params.bounds).toEqual({ width: 1292, height: 808 });
    expect(fake.setViewport).not.toHaveBeenCalled();
    expect(result).toEqual({ viewport: { width: 1280, height: 720 }, mode: 'window', clampedTo: undefined });
  });

  it('does not correct when the first size lands', async () => {
    const fake = makeFake({ chrome: { width: 12, height: 88 } });
    await sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, false);

    expect(fake.sizedBounds()).toHaveLength(1);
  });

  it('corrects once, re-measuring the frame that changed under it', async () => {
    const fake = makeFake({
      chrome: { width: 0, height: 88 },
      chromeAfterResize: { width: 15, height: 100 },
    });
    const result = await sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, false);

    const sized = fake.sizedBounds();
    expect(sized).toHaveLength(2);
    expect(sized[0].params.bounds).toEqual({ width: 1280, height: 808 });
    expect(sized[1].params.bounds).toEqual({ width: 1295, height: 820 });
    expect(result.viewport).toEqual({ width: 1280, height: 720 });
    expect(result.clampedTo).toBeUndefined();
  });

  it('reports the size it settled at when the window manager refuses', async () => {
    const fake = makeFake({ chrome: { width: 0, height: 88 }, maxOuter: { width: 1000, height: 800 } });
    const result = await sizeWindowToViewport(fake.page, { width: 1600, height: 1000 }, false);

    expect(result.viewport).toEqual({ width: 1000, height: 712 });
    expect(result.clampedTo).toEqual({ width: 1000, height: 712 });
    expect(result.mode).toBe('window');
  });

  it('detaches the session even when the protocol throws', async () => {
    const fake = makeFake();
    fake.send.mockRejectedValueOnce(new Error('target closed'));

    await expect(sizeWindowToViewport(fake.page, { width: 1280, height: 720 }, false)).rejects.toThrow('target closed');
    expect(fake.detach).toHaveBeenCalled();
  });
});

describe('loadedViewport', () => {
  const pageMeasuring = (size: { width: number; height: number } | Error) => ({
    evaluate: vi.fn(async () => {
      if (size instanceof Error) throw size;
      return size;
    }),
  }) as unknown as Page;

  it('reports what the loaded page measures, and that it differs from the size asked for', async () => {
    const settled = await loadedViewport(pageMeasuring({ width: 500, height: 612 }), { width: 500, height: 700 });

    expect(settled).toEqual({ viewport: { width: 500, height: 612 }, differs: true });
  });

  it('reports no difference where the loaded page measures the size asked for', async () => {
    const settled = await loadedViewport(pageMeasuring({ width: 500, height: 700 }), { width: 500, height: 700 });

    expect(settled).toEqual({ viewport: { width: 500, height: 700 }, differs: false });
  });

  it('returns nothing where the page cannot be read, so the sizing numbers stand', async () => {
    const settled = await loadedViewport(pageMeasuring(new Error('Execution context was destroyed')), { width: 500, height: 700 });

    expect(settled).toBeUndefined();
  });
});
