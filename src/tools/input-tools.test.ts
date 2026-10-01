import { describe, it, expect, vi } from 'vitest';
import { createInputTools } from './input-tools.js';
import { domChangeMonitor } from '../dom-change-monitor.js';

function makeInput(page: Record<string, any>) {
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => false,
    getPausedInfo: () => ({ paused: false }),
    waitForPause: () => new Promise(() => {}),
  };
  const fullPage = {
    url: () => 'http://shop.test/',
    evaluate: vi.fn(async () => undefined),
    $: vi.fn(async () => ({})),
    mouse: { click: vi.fn(async () => {}), move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    ...page,
  };
  const puppeteerManager = { isConnected: () => true, getPage: () => fullPage };
  const { input } = createInputTools(async () => ({ connection: {}, cdpManager, puppeteerManager }));
  return { input, page: fullPage };
}

const on = { connection: 'shop-web-app', detectChanges: false };

describe('an input action whose dispatch throws', () => {
  it('reports a press of a key the page refuses as failed', async () => {
    const { input } = makeInput({ keyboard: { press: vi.fn(async () => { throw new Error('Unknown key: "Nope"'); }) } });

    const result: any = await input.handler({ ...on, action: 'press', key: 'Nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown key');
  });

  it('reports a drag whose mouse press throws as failed, not as a drag between undefined points', async () => {
    const { input } = makeInput({
      mouse: { move: vi.fn(async () => {}), down: vi.fn(async () => { throw new Error('Target closed'); }), up: vi.fn(async () => {}) },
    });

    const result: any = await input.handler({ ...on, action: 'drag', from: { x: 1, y: 1 }, to: { x: 5, y: 5 } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Target closed');
  });

  it('reports a type whose typing throws as failed', async () => {
    const { input } = makeInput({
      evaluate: vi.fn(async () => ({ blocked: false })),
      type: vi.fn(async () => { throw new Error('Node is detached from document'); }),
    });

    const result: any = await input.handler({ ...on, action: 'type', selector: '#name', text: 'Ada', append: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('detached');
  });
});

describe('the DOM change observer', () => {
  it('is not left running by a click that returns before collecting it', async () => {
    const { input } = makeInput({});

    await input.handler({ connection: 'observer-left-check', action: 'click', x: 10, y: 20, detectChanges: true });

    expect(domChangeMonitor.isObserving('observer-left-check')).toBe(false);
  });
});
