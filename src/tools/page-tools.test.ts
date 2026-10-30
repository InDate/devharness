import { describe, it, expect, vi } from 'vitest';
import { createPageTools, formatPageContextForResponse } from './page-tools.js';
import { ConsoleMonitor } from '../console-monitor.js';

function makeNavigate(page: Record<string, any>, monitors: { consoleMonitor?: any; networkMonitor?: any } = {}) {
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
    async () => ({ connection: {}, cdpManager, puppeteerManager, consoleMonitor: monitors.consoleMonitor ?? monitor, networkMonitor: monitors.networkMonitor ?? monitor }),
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

// After the hints test: a successful reload spends the once-per-session hints it reads.
describe('the console and network counts in a navigation reply', () => {
  // The monitors keep what earlier documents logged: after a reload with the
  // cache cleared, the reply counted 2 errors whose stack named the bundle
  // the page had just replaced (#563-#569).
  it('count what the reload\'s own load logged and fetched, not what the page before it left', async () => {
    const consoleMonitor: any = new ConsoleMonitor();
    const error = (id: string, timestamp: number) => ({ id, type: 'error', text: `error ${id}`, args: [], timestamp });
    consoleMonitor.messages = [error('before', Date.now() - 5000)];
    const network = { isActive: () => false, startMonitoring: vi.fn(), getRequests: vi.fn((_filter?: { since?: number }) => []) };
    const calledAt = Date.now();
    const navigate = makeNavigate({
      reload: vi.fn(async () => { consoleMonitor.messages.push(error('during', Date.now())); }),
      title: vi.fn(async () => 'Shop'),
      evaluate: vi.fn(async () => ({ results: [], viewportHeight: 800, viewportWidth: 1200 })),
    }, { consoleMonitor, networkMonitor: network });

    const result: any = await navigate.handler({ action: 'reload', connection: 'shop-web-app' });

    expect(result.content[0].text).toContain('**Console:** 1 errors, 0 warnings');
    const since = network.getRequests.mock.calls[0]?.[0]?.since;
    expect(since).toBeGreaterThanOrEqual(calledAt);
    expect(since).toBeLessThanOrEqual(Date.now());
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
