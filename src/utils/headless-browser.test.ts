import { describe, it, expect } from 'vitest';
import { runsHeadless } from './headless-browser.js';

const pageOn = (browser: Record<string, unknown>) => ({ browser: () => browser });

describe('whether a page\'s browser runs headless', () => {
  // Chrome 156 under --headless=new answers Browser.getVersion with
  // "Chrome/156.0.8078.74" and a user agent holding "HeadlessChrome/156.0.0.0".
  it('reads headless from the user agent while the version reads plain Chrome/', async () => {
    const page = pageOn({
      version: async () => 'Chrome/156.0.8078.74',
      userAgent: async () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
    });
    expect(await runsHeadless(page)).toBe(true);
  });

  it('reads windowed from a user agent naming Chrome', async () => {
    const page = pageOn({ userAgent: async () => 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' });
    expect(await runsHeadless(page)).toBe(false);
  });

  it('reads nothing from a page with no browser to ask', async () => {
    expect(await runsHeadless(null)).toBeUndefined();
    expect(await runsHeadless(pageOn({ userAgent: async () => { throw new Error('Target closed'); } }))).toBeUndefined();
  });
});
