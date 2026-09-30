import { describe, it, expect, vi } from 'vitest';
import { createPageTools, formatPageContextForResponse } from './page-tools.js';

function makeNavigate(page: Record<string, any>) {
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => false,
    getPausedInfo: () => ({ paused: false }),
    waitForPause: () => new Promise(() => {}),
  };
  const monitor = { isActive: () => false, startMonitoring: vi.fn(), getCount: () => 0, getRequests: () => [] };
  const puppeteerManager = { isConnected: () => true, getPage: () => ({ url: () => 'http://shop.test/', ...page }) };
  const clickableCache = { set: vi.fn() } as any;
  const { navigate } = createPageTools(
    async () => ({ connection: {}, cdpManager, puppeteerManager, consoleMonitor: monitor, networkMonitor: monitor }),
    clickableCache,
  );
  return navigate;
}

describe('navigate', () => {
  it('reports a goto whose navigation throws as failed, with the reason', async () => {
    const navigate = makeNavigate({ goto: vi.fn(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); }) });

    const result: any = await navigate.handler({ action: 'goto', connectionReason: 'shop-web-app', url: 'http://nowhere.invalid/' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('reports a reload whose navigation throws as failed', async () => {
    const navigate = makeNavigate({ reload: vi.fn(async () => { throw new Error('Navigation timeout of 30000 ms exceeded'); }) });

    const result: any = await navigate.handler({ action: 'reload', connectionReason: 'shop-web-app' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timeout');
  });
});

describe('the hints in a navigation reply', () => {
  it('name the connection, so following one is not refused', () => {
    const response = formatPageContextForResponse({
      url: 'http://shop.test/', title: 'Shop',
      clickableElements: { total: 3, inViewport: 2 },
      console: { errors: 1, warnings: 0, total: 1 },
      network: { failed: 1, total: 4 },
    }, 'shop-web-app');

    for (const hint of [response.clickableElements.hint, response.console.hint, response.network.hint]) {
      expect(hint).toContain("connectionReason: 'shop-web-app'");
    }
  });
});
