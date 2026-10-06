/**
 * When each cause was in effect, as windows of time, so an effect is
 * attributed by when it began rather than by what was in flight when it was
 * stored.
 *
 * A devharness call opens its window when it marks and closes it when it is
 * released; a run's step does the same. A cause known only after its effects -
 * a person's input, reported over a CDP binding after the request it caused
 * reached the proxy - is added with the window its own time bounds, and every
 * capability that holds effects re-stamps the ones its window covers. Each
 * capability stores at its own delay (a stream's request at its headers, a
 * storage write when its read settles), and reading the timeline by an
 * effect's start makes those delays irrelevant to attribution.
 *
 * What the page reports about a cause - a pairing, a parser load, a timer -
 * stays the capability's to apply first; this answers only what nothing else
 * accounts for.
 */
import type { ProxyCursor } from './intercept-proxy.js';

export interface CauseWindow {
  cursor: ProxyCursor;
  from: number;
  /** Absent while the cause is still in effect. */
  to?: number;
}

/** As many windows as the history keeps entries, twice over for a run's steps. */
const WINDOWS_KEPT = 2000;
/** How far back a lookup reads: a late cause lands seconds after its effects, not minutes. */
const LOOKBACK_MS = 10 * 60 * 1000;

const windows: CauseWindow[] = [];
let open: CauseWindow | undefined;
const added = new Set<(window: CauseWindow) => void>();

function keep(window: CauseWindow): void {
  windows.push(window);
  if (windows.length > WINDOWS_KEPT) windows.splice(0, windows.length - WINDOWS_KEPT);
}

/** The cursor now in flight, or none: closes the window before it and opens its own. */
export function markedNow(cursor: ProxyCursor | undefined, at = Date.now()): void {
  if (open && open.cursor === cursor) return;
  if (open) open.to = at;
  open = cursor ? { cursor, from: at } : undefined;
  if (open) keep(open);
}

/**
 * A cause known only after its effects, in effect from `from` to `to`. Every
 * capability that registered with `onCauseAdded` re-stamps the unowned effects
 * that began inside it.
 */
export function addCause(cursor: ProxyCursor, from: number, to: number): void {
  const window = { cursor, from, to };
  keep(window);
  for (const listener of added) listener(window);
}

/**
 * The cause in effect at `at`: of the windows holding it, the one that began
 * latest, which is the more recent cause where a person's input falls inside
 * a devharness call.
 */
export function causeAt(at: number): ProxyCursor | undefined {
  let best: CauseWindow | undefined;
  for (let i = windows.length - 1; i >= 0; i--) {
    const window = windows[i];
    if (window.from < at - LOOKBACK_MS) break;
    if (window.from > at || (window.to !== undefined && at >= window.to)) continue;
    if (!best || window.from > best.from) best = window;
  }
  return best?.cursor;
}

/** Called with each late cause as it is added; returns the unsubscribe. */
export function onCauseAdded(listener: (window: CauseWindow) => void): () => void {
  added.add(listener);
  return () => { added.delete(listener); };
}
