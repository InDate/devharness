/**
 * Where each connection's Chrome window and its bench window stood, so a
 * launch reopens them there. Chrome reports no event when a window moves or
 * closes, so a tracked window's bounds are read on a timer and the last
 * reading is what a launch finds. The readings are held in this process only:
 * a connection name is what a session reaches them by, and the names a session
 * holds go with the process.
 */

import { readDisplays, type ScreenRect } from './utils/terminal-desktop.js';

export interface WindowBounds { left: number; top: number; width: number; height: number }

type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** A moved window is recorded within this long of the move. */
const READ_EVERY_MS = 2000;

/** The key the bench window of `connection` is remembered under. */
export const benchWindowKey = (connection: string) => `${connection}#bench`;

const isBounds = (b: any): b is WindowBounds =>
  [b?.left, b?.top, b?.width, b?.height].every(n => typeof n === 'number' && Number.isFinite(n));

const recorded = new Map<string, WindowBounds>();

/** Whether the centre of `bounds` falls on one of `displays`. */
export function onAnyDisplay(bounds: WindowBounds, displays: ScreenRect[]): boolean {
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  return displays.some(d => x >= d.left && x < d.left + d.width && y >= d.top && y < d.top + d.height);
}

/**
 * The bounds `key` was last recorded at, when their centre still falls on a
 * connected display. A window left on a display since unplugged returns
 * undefined, and the launch places it as it would with nothing recorded.
 */
export async function rememberedBounds(key: string, displays: () => Promise<ScreenRect[]> = readDisplays): Promise<WindowBounds | undefined> {
  const bounds = recorded.get(key);
  if (!bounds) return undefined;
  return onAnyDisplay(bounds, await displays()) ? bounds : undefined;
}

/** Moves the window holding the session's target to `bounds`. */
export async function placeWindow(send: Send, bounds: WindowBounds, targetId?: string): Promise<void> {
  const { windowId } = await send('Browser.getWindowForTarget', targetId ? { targetId } : {});
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId, bounds: { ...bounds } });
}

/**
 * Records the bounds of the window holding the session's target under `key`
 * every READ_EVERY_MS, while it stands in its normal state: a minimised or
 * fullscreen window's bounds are not where it reopens. Ends once a read fails,
 * which is the window closing or Chrome exiting.
 */
export function trackWindow(key: string, send: Send): () => void {
  const read = async () => {
    try {
      const { bounds } = await send('Browser.getWindowForTarget');
      if (bounds?.windowState !== 'normal' || !isBounds(bounds)) return;
      recorded.set(key, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
    } catch {
      stop();
    }
  };
  const timer = setInterval(() => void read(), READ_EVERY_MS);
  timer.unref();
  const stop = () => clearInterval(timer);
  void read();
  return stop;
}
