import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInputTools } from './input-tools.js';
import { domChangeMonitor } from '../dom-change-monitor.js';
import { attachLayer, forgetConnection } from '../hold.js';
import { sessions } from '../bench-mode/session.js';

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
      $: vi.fn(async () => ({
        scrollIntoView: async () => {}, clickablePoint: async () => ({ x: 1, y: 1 }), dispose: async () => {},
      })),
      keyboard: {
        press: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}),
        type: vi.fn(async () => { throw new Error('Node is detached from document'); }),
      },
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

/**
 * A page whose evaluate answers by what each read asks for: the viewport,
 * the scroll position, or the element under a point. `elements` maps "x,y"
 * to the fingerprint there; a point not in it reads as the bare body.
 */
function pageWithViewport(viewport: { width: number; height: number }, elements: Record<string, Record<string, unknown>> = {}) {
  return {
    evaluate: vi.fn(async (fn: unknown, target?: { x: number; y: number }) => {
      if (target && typeof target.x === 'number') return elements[`${target.x},${target.y}`] ?? { tag: 'body' };
      const source = String(fn);
      if (source.includes('scrollX')) return { scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0 };
      if (source.includes('innerWidth')) return viewport;
      return undefined;
    }),
  };
}

describe('the element a gesture lands on', () => {
  const button = { tag: 'button', id: 'target', text: 'Remove' };

  it('names the element under a drag\'s start and the bare page under its end', async () => {
    const { input } = makeInput(pageWithViewport({ width: 500, height: 700 }, { '100,50': button }));

    const result: any = await input.handler({ ...on, action: 'drag', from: { x: 100, y: 50 }, to: { x: 300, y: 400 } });

    expect(result.content[0].text).toContain('Dragged from (100, 50) on button #target "Remove" to (300, 400) on no element');
    expect(result._meta.elements).toEqual({ from: button, to: { tag: 'body' } });
  });

  it('names the viewport a scroll point falls outside, which no wheel event reaches', async () => {
    const { input } = makeInput(pageWithViewport({ width: 572, height: 342 }));

    const result: any = await input.handler({ ...on, action: 'scroll', x: 600, y: 400, deltaY: -200 });

    expect(result.content[0].text).toContain('Scrolled up 200px at (600, 400) on nothing: outside the 572x342 viewport');
    expect(result._meta.outsideViewport).toEqual({ viewport: { width: 572, height: 342 } });
  });

  it('names the viewport a drag point falls outside', async () => {
    const { input } = makeInput(pageWithViewport({ width: 500, height: 700 }, { '100,50': button }));

    const result: any = await input.handler({ ...on, action: 'drag', from: { x: 100, y: 50 }, to: { x: 900, y: 50 } });

    expect(result.content[0].text).toContain('to (900, 50) on nothing: outside the 500x700 viewport');
    expect(result._meta.outsideViewport).toMatchObject({ from: false, to: true });
  });
});

describe('a scroll as a run of wheel events', () => {
  it('sends one wheel event by default', async () => {
    const { input, page } = makeInput(pageWithViewport({ width: 500, height: 700 }));

    await input.handler({ ...on, action: 'scroll', deltaY: -120 });

    expect(page.mouse.wheel).toHaveBeenCalledTimes(1);
    expect(page.mouse.wheel).toHaveBeenCalledWith({ deltaX: 0, deltaY: -120 });
  });

  it('sends steps events, each delta decay times the last, as a momentum tail', async () => {
    const { input, page } = makeInput(pageWithViewport({ width: 500, height: 700 }));

    const result: any = await input.handler({ ...on, action: 'scroll', deltaY: -100, steps: 3, durationMs: 0, decay: 0.5 });

    expect(page.mouse.wheel.mock.calls.map((call: any[]) => call[0].deltaY)).toEqual([-100, -50, -25]);
    expect(result.content[0].text).toContain('as the first of 3 wheel events');
  });
});

describe('a press held in front of the frame it schedules', () => {
  afterEach(() => {
    sessions.delete(on.connection);
    forgetConnection(on.connection);
  });

  /** A bench on the connection whose screen layer and debugger record the order things happen in. */
  function benchWithScreen(landsOnFrame: boolean) {
    const order: string[] = [];
    const session: any = { connection: on.connection };
    session.debugger = {
      paused: false,
      isPaused: () => session.debugger.paused,
      waitForPause: vi.fn(async () => {
        if (landsOnFrame) { session.debugger.paused = true; order.push('frame stop'); return; }
        throw new Error('Timeout waiting for pause');
      }),
      pause: vi.fn(async () => { order.push('pause'); session.debugger.paused = true; }),
      setInstrumentationBreakpoints: vi.fn(async () => { order.push('frame stop armed'); }),
    };
    sessions.set(on.connection, session);
    attachLayer(on.connection, 'ui', {
      covers: ['code'],
      engage: async () => { order.push(session.frameStopArming ? 'hold armed on the frame' : 'hold'); session.frameStopArming = false; },
      disengage: async () => {},
    });
    return { order, session };
  }

  it('takes the hold before the key is dispatched and arms the frame stop after it', async () => {
    const { order, session } = benchWithScreen(true);
    const { input } = makeInput({ keyboard: { press: vi.fn(async () => { order.push('key'); }) } });

    const result: any = await input.handler({ ...on, action: 'press', key: '2', hold: ['ui'], holdBeforeFrame: true });

    expect(order).toEqual(['hold armed on the frame', 'key', 'frame stop armed', 'frame stop']);
    expect(session.debugger.pause).not.toHaveBeenCalled();
    expect(result._meta.hold.atFrame).toBe(true);
    expect(result.content[0].text).toContain('at the first frame after the press');
  });

  it('pauses the page where it stands when no frame comes, as in a hidden tab', async () => {
    const { order } = benchWithScreen(false);
    const { input } = makeInput({ keyboard: { press: vi.fn(async () => { order.push('key'); }) } });

    await input.handler({ ...on, action: 'press', key: '2', hold: ['ui'], holdBeforeFrame: true });

    expect(order).toEqual(['hold armed on the frame', 'key', 'frame stop armed', 'pause']);
  });
});
