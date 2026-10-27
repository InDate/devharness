import { describe, it, expect, vi, afterEach } from 'vitest';
import { onAnyDisplay, rememberedBounds, trackWindow, type WindowBounds } from './window-memory.js';

const LAPTOP = { left: 0, top: 0, width: 1800, height: 1169 };
const LARGE = { left: -919, top: -2160, width: 3840, height: 2160 };

/** A Browser domain whose window stands at `bounds` in `state`, until `closed` is set. */
function fakeWindow(bounds: WindowBounds, state = 'normal') {
  const window = { bounds, state, closed: false };
  const send = async (method: string) => {
    if (window.closed) throw new Error('Target closed');
    if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { ...window.bounds, windowState: window.state } };
    throw new Error(`unexpected ${method}`);
  };
  return { window, send };
}

describe('onAnyDisplay', () => {
  it('holds bounds whose centre falls on a display', () => {
    expect(onAnyDisplay({ left: -879, top: -2120, width: 1007, height: 1115 }, [LAPTOP, LARGE])).toBe(true);
  });

  it('refuses bounds whose centre falls on no display', () => {
    expect(onAnyDisplay({ left: -879, top: -2120, width: 1007, height: 1115 }, [LAPTOP])).toBe(false);
  });
});

describe('trackWindow and rememberedBounds', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns the bounds a tracked window was last read at', async () => {
    vi.useFakeTimers();
    const { window, send } = fakeWindow({ left: -879, top: -2120, width: 2540, height: 2031 });
    const stop = trackWindow('last-read', send);
    window.bounds = { left: -834, top: -996, width: 1032, height: 986 };
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    expect(await rememberedBounds('last-read', async () => [LAPTOP, LARGE])).toEqual({ left: -834, top: -996, width: 1032, height: 986 });
  });

  it('returns nothing when the display the window was left on is gone', async () => {
    const { send } = fakeWindow({ left: -879, top: -2120, width: 1007, height: 1115 });
    trackWindow('display-gone', send)();
    await vi.waitFor(async () => expect(await rememberedBounds('display-gone', async () => [LAPTOP, LARGE])).toBeDefined());
    expect(await rememberedBounds('display-gone', async () => [LAPTOP])).toBeUndefined();
  });

  it('keeps the last normal bounds while the window is minimised or fullscreen', async () => {
    vi.useFakeTimers();
    const { window, send } = fakeWindow({ left: 100, top: 100, width: 800, height: 600 });
    const stop = trackWindow('not-normal', send);
    await vi.advanceTimersByTimeAsync(0);
    window.state = 'fullscreen';
    window.bounds = { left: 0, top: 0, width: 1800, height: 1169 };
    await vi.advanceTimersByTimeAsync(2000);
    stop();
    expect(await rememberedBounds('not-normal', async () => [LAPTOP])).toEqual({ left: 100, top: 100, width: 800, height: 600 });
  });

  it('stops reading once the window has closed, and keeps its last bounds', async () => {
    vi.useFakeTimers();
    const { window, send } = fakeWindow({ left: 100, top: 100, width: 800, height: 600 });
    trackWindow('closed', send);
    await vi.advanceTimersByTimeAsync(0);
    window.closed = true;
    await vi.advanceTimersByTimeAsync(2000);
    window.closed = false;
    window.bounds = { left: 200, top: 200, width: 400, height: 300 };
    await vi.advanceTimersByTimeAsync(4000);
    expect(await rememberedBounds('closed', async () => [LAPTOP])).toEqual({ left: 100, top: 100, width: 800, height: 600 });
  });
});
