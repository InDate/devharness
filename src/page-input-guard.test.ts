import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { INPUT_GUARD_KEY, PAGE_INPUT_GUARD_SOURCE } from './page-input-guard.js';

/** A window whose listeners the guard registers first, as it is installed before the app's script. */
function pageWithGuard() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const scrolls: Array<{ left: number; top: number }> = [];
  const page: any = {
    document: {},
    scrollX: 0,
    scrollY: 0,
    addEventListener: (type: string, listener: (event: any) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    scrollTo: (at: { left: number; top: number }) => { scrolls.push(at); page.scrollX = at.left; page.scrollY = at.top; },
  };
  vm.createContext(page);
  vm.runInContext(PAGE_INPUT_GUARD_SOURCE, page);
  const guard = vm.runInContext(`globalThis[Symbol.for('${INPUT_GUARD_KEY}')]`, page);
  const appSaw: string[] = [];
  /** Dispatch to every listener in order, the app's after the guard's, stopping where propagation stops. */
  const dispatch = (type: string, isTrusted = true) => {
    let stopped = false;
    const event = {
      type, isTrusted, cancelable: true, defaultPrevented: false,
      stopImmediatePropagation: () => { stopped = true; },
      preventDefault: () => { event.defaultPrevented = true; },
    };
    for (const listener of [...(listeners.get(type) ?? []), () => appSaw.push(type)]) {
      if (stopped) break;
      listener(event);
    }
    return event;
  };
  return { page, guard, dispatch, appSaw, scrolls };
}

describe('the page\'s input guard while the screen is held', () => {
  it('stops a person\'s click before the app sees it, its default with it', () => {
    const { guard, dispatch, appSaw } = pageWithGuard();
    guard.hold();

    const click = dispatch('click');

    expect(appSaw).toEqual([]);
    expect(click.defaultPrevented).toBe(true);
  });

  it('keeps a wheel\'s default, so the page scrolls, and keeps the app\'s handler out', () => {
    const { guard, dispatch, appSaw } = pageWithGuard();
    guard.hold();

    const wheel = dispatch('wheel');

    expect(appSaw).toEqual([]);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('passes the page\'s own synthetic events, and everything once released', () => {
    const { guard, dispatch, appSaw } = pageWithGuard();
    guard.hold();
    dispatch('click', false);
    guard.release();
    dispatch('click');

    expect(appSaw).toEqual(['click', 'click']);
  });

  it('puts the page back where it stood before a person scrolled it', () => {
    const { page, guard, dispatch, scrolls } = pageWithGuard();
    page.scrollY = 300;
    guard.hold();
    dispatch('wheel');
    page.scrollY = 900;

    guard.release();

    expect(scrolls.at(-1)).toMatchObject({ left: 0, top: 300 });
  });

  it('leaves a page nobody scrolled where it stands at release', () => {
    const { page, guard, scrolls } = pageWithGuard();
    page.scrollY = 102;
    guard.hold();
    page.scrollY = 149;
    const before = scrolls.length;

    guard.release();

    expect(scrolls.length).toBe(before);
    expect(page.scrollY).toBe(149);
  });
});
