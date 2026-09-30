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
  handle: { scrollIntoView(): Promise<void>; clickablePoint(): Promise<{ x: number; y: number }> },
  options: { clickCount?: number } = {}
): Promise<void> {
  await handle.scrollIntoView();
  const { x, y } = await handle.clickablePoint();
  await page.mouse.click(x, y, options);
}
