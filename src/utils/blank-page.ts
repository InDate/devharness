/**
 * Whether `url` is a page Chrome opens on its own with nothing loaded: the
 * blank page, or the new-tab page a fresh tab shows. A navigation to the
 * new-tab page from outside it fails with ERR_INVALID_URL, so a start URL read
 * off a connection sitting there carries nothing to start on.
 */
export function blankPageUrl(url: string | undefined): boolean {
  return !url || url === 'about:blank' || url === 'chrome://newtab/' || url === 'chrome://new-tab-page/';
}
