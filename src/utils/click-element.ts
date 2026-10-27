import { currentCursor } from '../proxy/registry.js';
import { stepToken } from '../root-credit.js';
import type { Page } from 'puppeteer-core';

/**
 * Click an element without waiting on the document's rendering lifecycle.
 *
 * puppeteer's `ElementHandle.click` begins with `scrollIntoViewIfNeeded`, which
 * asks an IntersectionObserver whether the element is in view. Observer entries
 * are delivered from the rendering lifecycle, and a tab that is not the
 * selected one in its window gets no rendering opportunities - so on a hidden
 * tab that promise never settles, the CDP call never returns, and the click
 * never reaches the wire. Measured: with the bench tab selected, the app tab
 * reports `document.hidden === true` and a selector click runs past 120s while
 * a coordinate click at the same point returns at once.
 *
 * `scrollIntoView` scrolls over CDP and `clickablePoint` reads getClientRects
 * synchronously; neither needs a frame to be produced.
 */
export async function clickElement(
  page: Pick<Page, 'mouse'>,
  handle: OwnScrollHandle & { clickablePoint(): Promise<{ x: number; y: number }> },
  options: { clickCount?: number; as?: string } = {}
): Promise<void> {
  await scrollIntoViewAs(handle, options.as ?? 'click');
  const { x, y } = await handle.clickablePoint();
  await page.mouse.click(x, y, { clickCount: options.clickCount });
}

type OwnScrollHandle = {
  scrollIntoView(): Promise<void>;
  evaluate?(run: (element: unknown, words: string) => void, words: string): Promise<unknown>;
};

/**
 * Scroll an element into view as devharness's own scroll, named `words`. The
 * scroll runs over CDP with no page call, so the page's trigger tracker is
 * marked first; without the mark the scroll, and the app's motion that answers
 * it, read as the browser's.
 */
export async function scrollIntoViewAs(handle: OwnScrollHandle, words: string): Promise<void> {
  // The step it runs under roots the scroll there: what the scroll sets
  // going - a sticky header, a reveal - is credited to the step.
  const said = JSON.stringify({ words, step: stepToken(currentCursor()) });
  await handle.evaluate?.((_element, given) => {
    const { words: named, step } = JSON.parse(given);
    (globalThis as any)[Symbol.for('devharness.trigger')]?.ownScroll?.(named, step);
  }, said).catch(() => { /* a page with no tracker scrolls unmarked */ });
  await handle.scrollIntoView();
}
