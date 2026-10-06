/** How long a tab brought to the front has to report itself visible. */
const FRONT_WAIT_MS = 1000;

async function visibilityOf(page: any): Promise<unknown> {
  try {
    return await page.evaluate(() => (globalThis as any).document.visibilityState);
  } catch {
    return undefined;
  }
}

/**
 * Brings a background tab to the front, and returns whether the page is
 * visible. A background tab produces no frames, so Chrome drops a mouse or
 * touch event dispatched to it while `Input.dispatchMouseEvent` still returns.
 * The tab stays in front afterwards: CDP reports no record of which tab was
 * in front before, so there is none to restore.
 */
export async function bringHiddenPageToFront(
  page: any,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (await visibilityOf(page) !== 'hidden') return true;
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + FRONT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await visibilityOf(page) !== 'hidden') return true;
    await sleep(50);
  }
  return false;
}
