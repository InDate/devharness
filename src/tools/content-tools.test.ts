import { describe, it, expect, vi } from 'vitest';

vi.mock('../helpers/parser-plugins.js', () => ({
  listParsers: vi.fn(async () => []),
  loadParser: vi.fn(async () => ({ name: 'prices', extract: () => ({ ok: true }) })),
}));

const { createContentTools } = await import('./content-tools.js');

function makeContent(page: Record<string, any>, opts: { paused?: boolean; cached?: any[] } = {}) {
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => opts.paused === true,
    getPausedInfo: () => ({ paused: opts.paused === true, location: { url: 'app.js', lineNumber: 2 } }),
    waitForPause: () => new Promise(() => {}),
  };
  const title = vi.fn(() => (opts.paused ? new Promise(() => {}) : Promise.resolve('Shop')));
  const fullPage = { url: () => 'http://shop.test/', title, ...page };
  const puppeteerManager = { isConnected: () => true, getPage: () => fullPage };
  const clickableCache = { get: () => (opts.cached ? { elements: opts.cached } : undefined), set: vi.fn() } as any;
  const { content } = createContentTools(async () => ({ connection: {}, cdpManager, puppeteerManager }), clickableCache);
  return { content, title };
}

const within = <T>(promise: Promise<T>, ms = 500) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms))]);

const button = { type: 'button', text: 'Buy', href: '', selector: '#buy', width: 10, height: 10, visible: true };
const on = { connectionReason: 'shop-web-app' };

describe('content', () => {
  it('reports a parse whose extract throws as failed, not as a null result', async () => {
    const { content } = makeContent({ evaluate: vi.fn(async () => { throw new Error('extract threw: no table'); }) });

    const result: any = await content.handler({ ...on, action: 'parse', name: 'prices' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no table');
  });

  it('answers findInteractive on a paused page at once rather than waiting on its title', async () => {
    const { content, title } = makeContent({}, { paused: true, cached: [button] });

    const result: any = await within(content.handler({ ...on, action: 'findInteractive' }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paused');
    expect(title).not.toHaveBeenCalled();
  });

  it('names the connection in the calls its replies suggest', async () => {
    const { content } = makeContent({
      evaluate: vi.fn(async () => ({ headings: [{ level: 1, text: 'Deals' }], markdown: '# Deals' })),
    }, { cached: [button] });

    const outline: any = await content.handler({ ...on, action: 'extractText' });
    const interactive: any = await content.handler({ ...on, action: 'findInteractive' });

    const suggested = [...`${outline.content[0].text}\n${interactive.content[0].text}`.matchAll(/(content|input)\(\{[^}]*\}\)/g)].map(m => m[0]);
    expect(suggested.length).toBeGreaterThanOrEqual(4);
    for (const call of suggested) expect(call).toContain("connectionReason: 'shop-web-app'");
  });
});
