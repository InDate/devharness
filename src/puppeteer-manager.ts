/**
 * Puppeteer Manager
 * Manages Puppeteer connection to Chrome for browser automation
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';

/**
 * Browser.newPage() creates the tab in the foreground, which on macOS
 * activates Chrome and moves keyboard focus off the app the user is typing in.
 * Target.createTarget with `background: true` adds the tab without activating.
 */
export async function openBackgroundPage(browser: Browser): Promise<Page> {
  const session = await browser.target().createCDPSession();
  try {
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
    const target = await browser.waitForTarget((t) => (t as any)._targetId === targetId);
    const page = await target.page();
    if (!page) throw new Error(`Target ${targetId} has no page`);
    return page;
  } finally {
    await session.detach().catch(() => {});
  }
}

export class PuppeteerManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private debugPort: number = 9222;

  /**
   * Connect to an existing Chrome instance
   */
  async connect(host: string = 'localhost', port: number = 9222): Promise<void> {
    try {
      this.debugPort = port;
      const browserURL = `http://${host}:${port}`;

      this.browser = await puppeteer.connect({
        browserURL,
        defaultViewport: null,
      });

      // Get the first page or create a new one
      const pages = await this.browser.pages();
      if (pages.length > 0) {
        this.page = pages[0];
      } else {
        this.page = await openBackgroundPage(this.browser);
      }
    } catch (error) {
      throw new Error(`Failed to connect to Puppeteer: ${error}`);
    }
  }

  /**
   * Disconnect from the browser
   */
  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.disconnect();
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.browser !== null && this.browser.connected;
  }

  /**
   * Get the current page
   */
  getPage(): Page {
    if (!this.page) {
      throw new Error('Not connected to a page');
    }
    return this.page;
  }

  /**
   * Get the browser instance
   */
  getBrowser(): Browser {
    if (!this.browser) {
      throw new Error('Not connected to browser');
    }
    return this.browser;
  }

  /**
   * Get all pages
   */
  async getPages(): Promise<Page[]> {
    if (!this.browser) {
      throw new Error('Not connected to browser');
    }
    return await this.browser.pages();
  }

  /**
   * Create a new page
   */
  async newPage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('Not connected to browser');
    }
    const newPage = await openBackgroundPage(this.browser);
    this.page = newPage;
    return newPage;
  }

  /**
   * Set the current page by index
   */
  async setPage(index: number): Promise<void> {
    const pages = await this.getPages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Page index ${index} out of range (0-${pages.length - 1})`);
    }
    this.page = pages[index];
  }

  /**
   * Close a page by index
   */
  async closePage(index: number): Promise<void> {
    const pages = await this.getPages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Page index ${index} out of range (0-${pages.length - 1})`);
    }
    if (pages.length === 1) {
      throw new Error('Cannot close the last page');
    }
    await pages[index].close();
    // Switch to first available page
    if (this.page === pages[index]) {
      this.page = pages[0] === pages[index] ? pages[1] : pages[0];
    }
  }
}
