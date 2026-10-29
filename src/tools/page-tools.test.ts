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

    const result: any = await navigate.handler({ action: 'goto', connection: 'shop-web-app', url: 'http://nowhere.invalid/' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('reports a reload whose navigation throws as failed', async () => {
    const navigate = makeNavigate({ reload: vi.fn(async () => { throw new Error('Navigation timeout of 30000 ms exceeded'); }) });

    const result: any = await navigate.handler({ action: 'reload', connection: 'shop-web-app' });

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
      expect(hint).toContain("connection: 'shop-web-app'");
    }
  });
});

// Last: a successful goto spends the once-per-session hints the test above reads.
describe('a goto on a page that navigates itself once loaded', () => {
  it('reads the page a gate redirects to once loaded, where the first read lost its document', async () => {
    let reads = 0;
    const navigate = makeNavigate({
      goto: vi.fn(async () => null),
      title: vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.');
        return 'Join';
      }),
      evaluate: vi.fn(async (fn: any) => (fn === 'document.readyState' ? 'complete' : { results: [], viewportHeight: 800, viewportWidth: 1200 })),
      once: vi.fn(),
      off: vi.fn(),
    });

    const result: any = await navigate.handler({ action: 'goto', connection: 'shop-web-app', url: 'http://shop.test/' });

    expect(result.isError).toBeFalsy();
    expect(reads).toBe(2);
  });
});
