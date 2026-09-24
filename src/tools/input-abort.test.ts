// @vitest-environment node
/**
 * Cancellation of the `input` tool (#110).
 *
 * IMPORTANT about what this can and cannot prove. Nothing in `input` is
 * genuinely cancellable: `page.mouse.click` becomes an
 * Input.dispatchMouseEvent, and once that is on the wire Chrome WILL process
 * it. There is no CDP "un-click". So the win - and the only thing these tests
 * assert - is that a cancelled step does NOT DISPATCH events that had not gone
 * out yet, and that the handler stops with an abort-shaped error instead of
 * carrying on to the end of a multi-event gesture.
 *
 * The `does not undo` test exists deliberately so nobody later reads the suite
 * as a claim that cancellation rolls anything back.
 *
 * Every dispatch on the fake page is recorded, so "interrupted" means a
 * SHORTER dispatch log, not merely an earlier return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInputTools } from './input-tools.js';
import { isAbortError } from '../utils/abort.js';
import { configManager } from '../config.js';

interface Dispatch { kind: string; args: any[] }

/**
 * Fake page recording every input dispatch. `onDispatch` runs before each one
 * is recorded, which is how a test aborts "mid-gesture" at a precise point.
 */
function makePage(opts: { onDispatch?: (d: Dispatch) => void; elementExists?: boolean } = {}) {
  const dispatches: Dispatch[] = [];
  const record = (kind: string, ...args: any[]) => {
    const d = { kind, args };
    opts.onDispatch?.(d);
    dispatches.push(d);
  };

  const page: any = {
    url: () => 'https://example.test/page',
    // Every page.evaluate in the handler is read-only introspection (focus
    // info, click-handler sniffing, the replay-bypass flag) - never a dispatch.
    evaluate: vi.fn(async (fn: any, ...args: any[]) => {
      void fn; void args;
      return {} as any;
    }),
    // An element handle as clickSelector drives one: it resolves a handle and
    // dispatches through page.mouse, rather than page.click, so that a click
    // never waits on an IntersectionObserver a background tab cannot deliver.
    $: vi.fn(async () => (opts.elementExists === false ? null : {
      scrollIntoView: vi.fn(async () => {}),
      clickablePoint: vi.fn(async () => ({ x: 10, y: 20 })),
      dispose: vi.fn(async () => {}),
    })),
    click: vi.fn(async (...a: any[]) => record('page.click', ...a)),
    type: vi.fn(async (...a: any[]) => record('page.type', ...a)),
    hover: vi.fn(async (...a: any[]) => record('page.hover', ...a)),
    focus: vi.fn(async (...a: any[]) => record('page.focus', ...a)),
    mouse: {
      click: vi.fn(async (...a: any[]) => record('mouse.click', ...a)),
      move: vi.fn(async (...a: any[]) => record('mouse.move', ...a)),
      down: vi.fn(async (...a: any[]) => record('mouse.down', ...a)),
      up: vi.fn(async (...a: any[]) => record('mouse.up', ...a)),
      wheel: vi.fn(async (...a: any[]) => record('mouse.wheel', ...a)),
    },
    keyboard: {
      press: vi.fn(async (...a: any[]) => record('keyboard.press', ...a)),
      down: vi.fn(async (...a: any[]) => record('keyboard.down', ...a)),
      up: vi.fn(async (...a: any[]) => record('keyboard.up', ...a)),
    },
  };

  return { page, dispatches };
}

function makeInput(page: any) {
  const cdpManager: any = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => false,
    getPausedInfo: () => ({ paused: false }),
    getClient: () => ({ send: vi.fn(async () => ({})) }),
    // executeWithPauseDetection races the action against this; never pausing
    // means the action's own outcome always wins.
    waitForPause: () => new Promise<void>(() => {}),
  };
  const puppeteerManager: any = {
    isConnected: () => true,
    getPage: () => page,
  };
  const resolve = async () => ({
    connection: { port: undefined },
    cdpManager,
    puppeteerManager,
    consoleMonitor: {},
    networkMonitor: {},
  });
  const { input } = createInputTools(puppeteerManager, cdpManager, {} as any, resolve as any);
  return input;
}

/** Run the handler and reify the outcome (abort-shaped throws included). */
async function callInput(input: any, args: any, signal?: AbortSignal) {
  try {
    return { threw: false as const, result: await input.handler(args, signal) };
  } catch (err) {
    return { threw: true as const, err };
  }
}

beforeEach(() => {
  // DOM-change detection would add page.evaluate traffic and a settle wait;
  // these tests are about dispatches, so keep it off unless a test opts in.
  vi.spyOn(configManager, 'getChangeDetectionConfig').mockReturnValue({
    enabled: false,
    settleTimeout: 0,
  } as any);
});

describe('input: abort before dispatch means ZERO dispatches', () => {
  it('click by selector dispatches nothing when already aborted', async () => {
    const { page, dispatches } = makePage();
    const input = makeInput(page);
    const controller = new AbortController();
    controller.abort();

    const outcome = await callInput(
      input,
      { action: 'click', selector: '#go', connectionReason: 'app' },
      controller.signal
    );

    expect(outcome.threw).toBe(true);
    expect(isAbortError((outcome as any).err)).toBe(true);
    expect(dispatches).toEqual([]);
    expect(page.click).not.toHaveBeenCalled();
  });

  it('coordinate click dispatches nothing when already aborted', async () => {
    const { page, dispatches } = makePage();
    const input = makeInput(page);
    const controller = new AbortController();
    controller.abort();

    const outcome = await callInput(
      input,
      { action: 'click', x: 10, y: 20, connectionReason: 'app' },
      controller.signal
    );

    expect(outcome.threw).toBe(true);
    expect(dispatches).toEqual([]);
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it.each([
    ['type', { action: 'type', selector: '#field', text: 'hello' }],
    ['press', { action: 'press', key: 'Enter' }],
    ['hover', { action: 'hover', selector: '#thing' }],
    ['focus', { action: 'focus', selector: '#thing' }],
    ['focusNext', { action: 'focusNext' }],
    ['focusPrevious', { action: 'focusPrevious' }],
    ['drag', { action: 'drag', from: { x: 0, y: 0 }, to: { x: 50, y: 50 } }],
    ['scroll', { action: 'scroll', deltaY: 300 }],
    ['mousemove', { action: 'mousemove', x: 5, y: 5 }],
    ['pinch', { action: 'pinch', scale: 2 }],
  ])('%s dispatches nothing when already aborted', async (_name, args) => {
    const { page, dispatches } = makePage();
    const input = makeInput(page);
    const controller = new AbortController();
    controller.abort();

    const outcome = await callInput(input, { ...args, connectionReason: 'app' }, controller.signal);

    expect(outcome.threw).toBe(true);
    expect(isAbortError((outcome as any).err)).toBe(true);
    expect(dispatches).toEqual([]);
  });
});

describe('input: multi-dispatch paths stop mid-gesture', () => {
  it('focusNext stops Tabbing after the abort instead of pressing all 5', async () => {
    const controller = new AbortController();
    const { page, dispatches } = makePage({
      onDispatch: (d) => {
        // Cancel once two Tabs have gone out.
        if (d.kind === 'keyboard.press' && dispatches.length === 2) controller.abort();
      },
    });
    const input = makeInput(page);

    const outcome = await callInput(
      input,
      { action: 'focusNext', count: 5, connectionReason: 'app' },
      controller.signal
    );

    expect(outcome.threw).toBe(true);
    expect(isAbortError((outcome as any).err)).toBe(true);
    const tabs = dispatches.filter((d) => d.kind === 'keyboard.press').length;
    // 3 = the two before the cancel plus the one that was already in flight.
    expect(tabs).toBe(3);
    expect(tabs).toBeLessThan(5);
  });

  it('drag stops stepping and releases the button rather than leaving it held', async () => {
    const controller = new AbortController();
    const { page, dispatches } = makePage({
      onDispatch: (d) => {
        if (d.kind === 'mouse.move' && dispatches.filter((x) => x.kind === 'mouse.move').length === 3) {
          controller.abort();
        }
      },
    });
    const input = makeInput(page);

    const outcome = await callInput(
      input,
      { action: 'drag', from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, steps: 20, connectionReason: 'app' },
      controller.signal
    );

    expect(outcome.threw).toBe(true);
    expect(isAbortError((outcome as any).err)).toBe(true);

    const moves = dispatches.filter((d) => d.kind === 'mouse.move').length;
    // Interruption, not completion: far fewer than the 1 initial + 20 stepped moves.
    expect(moves).toBeLessThan(21);
    // The button must not be left down on a cancelled drag.
    expect(dispatches.some((d) => d.kind === 'mouse.down')).toBe(true);
    expect(dispatches.some((d) => d.kind === 'mouse.up')).toBe(true);
  });

  it('type stops between the clear and the retype (clear stays applied)', async () => {
    const controller = new AbortController();
    const { page, dispatches } = makePage({
      onDispatch: (d) => {
        // Abort right after the triple-click + Backspace that clears the field.
        if (d.kind === 'keyboard.press' && d.args[0] === 'Backspace') controller.abort();
      },
    });
    const input = makeInput(page);

    const outcome = await callInput(
      input,
      { action: 'type', selector: '#field', text: 'new value', connectionReason: 'app' },
      controller.signal
    );

    expect(outcome.threw).toBe(true);
    expect(isAbortError((outcome as any).err)).toBe(true);
    // The clear went out and stays out; the new text never got dispatched.
    expect(dispatches.some((d) => d.kind === 'keyboard.press' && d.args[0] === 'Backspace')).toBe(true);
    expect(page.type).not.toHaveBeenCalled();
  });
});

describe('input: cancellation does NOT undo what was already dispatched', () => {
  it('a click already issued is never retracted - no compensating dispatch is sent', async () => {
    const controller = new AbortController();
    const { page, dispatches } = makePage({
      onDispatch: (d) => {
        // Cancel the instant the click is handed to the page. A click goes out
        // through page.mouse, not page.click - see clickSelector.
        if (d.kind === 'mouse.click') controller.abort();
      },
    });
    const input = makeInput(page);

    await callInput(
      input,
      { action: 'click', selector: '#submit', connectionReason: 'app' },
      controller.signal
    );

    // The click IS recorded - Chrome already has it, and cancellation cannot
    // and does not take it back.
    expect(dispatches.filter((d) => d.kind === 'mouse.click')).toHaveLength(1);

    // And nothing "undoing" it was sent afterwards: no second click, no
    // synthetic Escape, no navigation. The dispatch log ends at the click.
    const after = dispatches.slice(dispatches.findIndex((d) => d.kind === 'mouse.click') + 1);
    expect(after).toEqual([]);
  });
});
