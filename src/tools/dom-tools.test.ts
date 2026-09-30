import { describe, it, expect, vi } from 'vitest';
import { createDOMTools } from './dom-tools.js';

function makeDom(opts: { paused?: boolean } = {}) {
  const page = { evaluate: vi.fn(async () => []), accessibility: { snapshot: vi.fn(async () => ({})) }, $: vi.fn(async () => null) };
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => opts.paused === true,
    getPausedInfo: () => ({ paused: true, location: { url: 'app.js', lineNumber: 3 } }),
  };
  const puppeteerManager = { isConnected: () => true, getPage: () => page };
  const { dom } = createDOMTools(async () => ({ connection: {}, cdpManager, puppeteerManager }));
  return { dom, page };
}

describe('dom', () => {
  it('refuses hitTest without a selector before touching the page', async () => {
    const { dom, page } = makeDom();

    const result: any = await dom.handler({ action: 'hitTest', connectionReason: 'shop-web-app' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('selector');
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('reports a snapshot taken on a paused page as failed, not as an empty success', async () => {
    const { dom } = makeDom({ paused: true });

    const result: any = await dom.handler({ action: 'snapshot', connectionReason: 'shop-web-app' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paused');
  });
});
