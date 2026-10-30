import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { PAGE_CLOCK_SOURCE, CLOCK_KEY } from './page-clock.js';

/**
 * A page global the clock is put into, whose native clock, timers and frames
 * the test moves by hand: `wait(ms)` runs native time on, firing the native
 * timers that come due, and `paint()` runs one native frame.
 */
function pageWithClock(extras: Record<string, unknown> = {}) {
  let nativeNow = 1000;
  let nativeId = 1;
  const nativeTimers: Array<{ id: number; at: number; run: () => void }> = [];
  const nativeFrames: Array<(at: number) => void> = [];
  const reported: unknown[] = [];

  class NativeDate extends Date {
    static now() { return 1_700_000_000_000 + nativeNow; }
  }
  class Event {
    constructor(private at: number | string) {}
    get type() { return typeof this.at === 'string' ? this.at : undefined; }
  }
  Object.defineProperty(Event.prototype, 'timeStamp', {
    configurable: true, enumerable: true,
    get(this: any) { return this.at; },
  });

  const page: any = {
    document: {},
    performance: { now: () => nativeNow },
    Date: NativeDate,
    Event,
    AbortController,
    AbortSignal: { timeout: () => undefined },
    DOMException,
    reportError: (error: unknown) => reported.push(error),
    setTimeout: (run: () => void, ms: number) => {
      const id = nativeId++;
      nativeTimers.push({ id, at: nativeNow + (ms || 0), run });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = nativeTimers.findIndex(timer => timer.id === id);
      if (i >= 0) nativeTimers.splice(i, 1);
    },
    requestAnimationFrame: (run: (at: number) => void) => nativeFrames.push(run),
    cancelAnimationFrame: () => {},
    ...extras,
  };
  vm.createContext(page);
  vm.runInContext(PAGE_CLOCK_SOURCE, page);

  const wait = (ms: number) => {
    const until = nativeNow + ms;
    for (;;) {
      nativeTimers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = nativeTimers[0];
      if (!next || next.at > until) break;
      nativeTimers.shift();
      nativeNow = Math.max(nativeNow, next.at);
      next.run();
    }
    nativeNow = until;
  };
  const paint = () => { for (const run of nativeFrames.splice(0)) run(nativeNow); };
  // A symbol-keyed property set on a sandbox's global stays inside it, so the clock is read from there.
  const clock = vm.runInContext(`globalThis[Symbol.for('${CLOCK_KEY}')]`, page);
  return { page, clock, wait, paint, reported, nativeFrames, run: (source: string) => vm.runInContext(source, page) };
}

describe('the page clock - page time the hold stops', () => {
  it('fires a timer set before a hold as though the hold took no time', () => {
    const { clock, wait, run } = pageWithClock();
    run('globalThis.fired = 0; setTimeout(() => fired++, 200)');
    wait(50);
    clock.pause();
    wait(5000);
    expect(run('fired')).toBe(0);

    clock.resume();
    wait(149);
    expect(run('fired')).toBe(0);
    wait(2);
    expect(run('fired')).toBe(1);
  });

  it('stands Date and performance.now still while paused, and runs them on from there', () => {
    const { clock, wait, run } = pageWithClock();
    const before = { perf: run('performance.now()'), date: run('Date.now()') };
    clock.pause();
    wait(1000);
    expect(run('performance.now()')).toBe(before.perf);
    expect(run('Date.now()')).toBe(before.date);

    clock.resume();
    wait(10);
    expect(run('performance.now()')).toBe(before.perf + 10);
    expect(run('Date.now()')).toBe(before.date + 10);
  });

  it('runs timers due at the same moment in the order they were set, and not a cleared one', () => {
    const { wait, run } = pageWithClock();
    run(`globalThis.order = [];
      setTimeout(() => order.push('a'), 100);
      const b = setTimeout(() => order.push('b'), 100);
      setTimeout(() => order.push('c'), 100);
      clearTimeout(b);`);
    wait(100);
    expect(run('order')).toEqual(['a', 'c']);
  });

  it('reports how far page time is behind wall time, from holds and slower speeds', () => {
    const { clock, wait } = pageWithClock();
    clock.pause();
    wait(500);
    clock.resume();
    clock.rate(0.5);
    wait(200);
    expect(clock.state().behind).toBe(600);
  });

  it('keeps an interval to its rhythm in page time across a hold', () => {
    const { clock, wait, run } = pageWithClock();
    run('globalThis.ticks = []; setInterval(() => ticks.push(performance.now()), 100)');
    wait(150);
    clock.pause();
    wait(2000);
    clock.resume();
    wait(150);
    const ticks = run('ticks') as number[];
    expect(ticks.map(at => Math.round(at - 1000))).toEqual([100, 200, 300]);
  });

  it('runs page time at its rate, and stands it still at 0', () => {
    const { clock, wait, run } = pageWithClock();
    const start = run('performance.now()');
    clock.rate(0.25);
    wait(400);
    expect(run('performance.now()')).toBe(start + 100);
    clock.rate(0);
    wait(400);
    expect(run('performance.now()')).toBe(start + 100);
  });

  it("reads an event's timeStamp as page time", () => {
    const { clock, wait, run } = pageWithClock();
    clock.pause();
    wait(500);
    // An event stamped now on the native timeline, 1500, reads the page time the clock stopped at.
    expect(run('new Event(1500).timeStamp')).toBe(1000);
  });
});

describe('the page clock - held frames and the frame step', () => {
  it("queues the app's frame callbacks while frames are held, handing none to the browser", () => {
    const { clock, run, nativeFrames } = pageWithClock();
    clock.holdFrames();
    run('requestAnimationFrame(() => {})');
    expect(nativeFrames).toHaveLength(0);
    expect(clock.state()).toMatchObject({ framesHeld: true, framesWaiting: 1 });
  });

  it('steps a frame: page time on, its due timers first, then the queued frames once with that time', () => {
    const { clock, run } = pageWithClock();
    clock.holdFrames();
    run(`globalThis.order = [];
      requestAnimationFrame(at => { order.push('frame ' + at); requestAnimationFrame(() => order.push('next frame')); });
      setTimeout(() => order.push('timer'), 10);
      setTimeout(() => order.push('later timer'), 40);`);
    clock.pause();

    const stepped = clock.frame(16);

    expect(run('order')).toEqual(['timer', 'frame 1016']);
    expect(stepped).toEqual({ now: 1016, ran: 1, waiting: 1 });
  });

  it('runs the rest of a frame when one callback throws, reporting the error', () => {
    const { clock, run, reported } = pageWithClock();
    clock.holdFrames();
    run(`globalThis.ran = [];
      requestAnimationFrame(() => { throw new Error('boom'); });
      requestAnimationFrame(() => ran.push('second'));`);
    clock.pause();

    clock.frame(16);

    expect(run('ran')).toEqual(['second']);
    expect(reported).toHaveLength(1);
  });

  it('hands held frames back to the browser on resume, with page time', () => {
    const { clock, run, paint, wait } = pageWithClock();
    clock.holdFrames();
    run('globalThis.at = null; requestAnimationFrame(t => { at = t; })');
    clock.pause();
    wait(300);

    clock.resume();
    wait(5);
    paint();

    expect(run('at')).toBe(1005);
    expect(clock.state()).toMatchObject({ framesHeld: false, framesWaiting: 0 });
  });

  it('runs the next thing it holds: the earlier of the next timer and the held frame', () => {
    const { clock, run } = pageWithClock();
    clock.holdFrames();
    run(`globalThis.order = [];
      setTimeout(() => order.push('timer'), 5);
      requestAnimationFrame(() => order.push('frame'));`);
    clock.pause();

    expect(clock.next(16)).toMatchObject({ kind: 'setTimeout', now: 1005 });
    expect(clock.next(16)).toMatchObject({ kind: 'requestAnimationFrame', now: 1021 });
    expect(clock.next(16)).toBeNull();
    expect(run('order')).toEqual(['timer', 'frame']);
  });
});

describe('the page clock - frames at a slower rate', () => {
  const frameCount = (rate: number) => {
    const { clock, run, wait, paint } = pageWithClock();
    clock.rate(rate);
    run('globalThis.ran = 0; const loop = () => { ran++; requestAnimationFrame(loop); }; requestAnimationFrame(loop);');
    for (let frame = 0; frame < 8; frame++) { wait(16); paint(); }
    return run('ran');
  };

  it("runs the app's frame callbacks on one native frame in four at a rate of 0.25", () => {
    expect(frameCount(0.25)).toBe(2);
  });

  it('runs them on every native frame at a rate of 1', () => {
    expect(frameCount(1)).toBe(8);
  });
});

describe('the page clock - a smooth scroll at a slower rate', () => {
  /** A page whose one scroller moves only by instant writes, recording every call the browser received and every event dispatched on the document. */
  function pageWithScroller() {
    const calls: Array<{ top: number; behavior?: string }> = [];
    const dispatched: string[] = [];
    class Element {
      scrollTop = 0; scrollLeft = 0; scrollHeight = 5000; clientHeight = 500; scrollWidth = 0; clientWidth = 0;
      parentElement = null;
      scrollTo(options: { top?: number; left?: number; behavior?: string }) {
        calls.push({ top: options.top ?? this.scrollTop, behavior: options.behavior });
        this.scrollTop = options.top ?? this.scrollTop;
        this.scrollLeft = options.left ?? this.scrollLeft;
      }
      scroll() {}
      scrollBy() {}
      scrollIntoView() {}
    }
    const scroller = new Element();
    const listeners = new Map<string, (event: any) => void>();
    const page = pageWithClock({
      Element,
      document: { scrollingElement: scroller, dispatchEvent: (event: { type: string }) => dispatched.push(event.type) },
      scrollTo: (options: { top: number; behavior?: string }) => scroller.scrollTo(options),
      scroll: () => {}, scrollBy: () => {},
      getComputedStyle: () => ({ scrollBehavior: 'auto' }),
      addEventListener: (type: string, fn: (event: any) => void) => { listeners.set(type, fn); },
    });
    /** Native frames, 16ms apart, for this much wall time. */
    const frames = (ms: number) => { for (let at = 0; at < ms; at += 16) { page.wait(16); page.paint(); } };
    return { ...page, scroller, calls, dispatched, frames, listeners };
  }

  it("runs on page time: Chrome's duration for the distance, stretched by the rate, with one scrollend at its end", () => {
    const { clock, run, scroller, frames, dispatched } = pageWithScroller();
    clock.rate(0.25);
    run(`scrollTo({ top: 1000, behavior: 'smooth' })`);
    expect(scroller.scrollTop).toBe(0);

    // sqrt(1000) frames of 1/60s is 527ms of page time, 2108ms of wall time at 0.25.
    frames(1056);
    expect(scroller.scrollTop).toBeGreaterThan(300);
    expect(scroller.scrollTop).toBeLessThan(700);
    expect(clock.scrolling()).toBe(true);

    frames(1200);
    expect(scroller.scrollTop).toBe(1000);
    expect(clock.scrolling()).toBe(false);
    expect(dispatched).toEqual(['scrollend']);
  });

  it('ends where an instant scroll puts the scroller, or at a wheel', () => {
    const { clock, run, scroller, frames, listeners } = pageWithScroller();
    clock.rate(0.25);
    run(`scrollTo({ top: 1000, behavior: 'smooth' })`);
    frames(500);
    run(`scrollTo({ top: 50, behavior: 'instant' })`);
    frames(500);
    expect(scroller.scrollTop).toBe(50);
    expect(clock.scrolling()).toBe(false);

    run(`scrollTo({ top: 1000, behavior: 'smooth' })`);
    frames(500);
    const stoodAt = scroller.scrollTop;
    listeners.get('wheel')?.({ isTrusted: true });
    frames(500);
    expect(scroller.scrollTop).toBe(stoodAt);
    expect(clock.scrolling()).toBe(false);
  });

  it("hands a smooth scroll to Chrome at a rate of 1", () => {
    const { run, calls } = pageWithScroller();
    run(`scrollTo({ top: 1000, behavior: 'smooth' })`);
    expect(calls).toEqual([{ top: 1000, behavior: 'smooth' }]);
  });
});
