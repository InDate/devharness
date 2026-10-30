/**
 * The page's clock, put in before the app's first script.
 *
 * A hold stops the page's CSS animations, and a code hold its JS, while wall
 * time goes on:
 * a timer set before the hold comes due during it and fires the moment the
 * page runs again, a JS animation that reads performance.now() jumps by the
 * length of the hold, and a sequence replayed faster than it was recorded
 * holds the page for less time and sees its timers fire at other moments.
 * The page reads time from this clock instead, and devharness stops it for
 * as long as it holds the page.
 *
 * Running, page time is wall time at a rate (1 unless set), synced against
 * the native clock whenever it is read. Timers are kept in one queue ordered
 * by due time, then by the order they were set, and one native timer is set
 * for the next one due, capped so a change of rate or a pause takes effect
 * within that cap. Animation frames stay Chrome's own, so drawing stays real;
 * each frame callback is handed page time, and below a rate of 1 the
 * callbacks run on that share of Chrome's frames. Workers keep wall time.
 *
 * The design follows Playwright's injected clock and @sinonjs/fake-timers
 * (Christian Johansen), from which the queue and the real-time sync come.
 */

/** Where the clock's controls stand on the page's global, out of the app's way. */
export const CLOCK_KEY = 'devharness.clock';

function installPageClock(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.clock')]) return;

  const native = {
    setTimeout: g.setTimeout.bind(g),
    clearTimeout: g.clearTimeout.bind(g),
    perfNow: g.performance.now.bind(g.performance),
    Date: g.Date,
    dateNow: g.Date.now.bind(g.Date),
    requestAnimationFrame: typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : undefined,
    cancelAnimationFrame: typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(g) : undefined,
    timeoutSignal: g.AbortSignal && typeof g.AbortSignal.timeout === 'function' ? g.AbortSignal.timeout.bind(g.AbortSignal) : undefined,
    timeStamp: g.Event ? Object.getOwnPropertyDescriptor(g.Event.prototype, 'timeStamp') : undefined,
  };

  // Page time and native time, both on the performance timeline, at the last
  // sync; page time moves from `page` at `rate` while running.
  let syncedNative = native.perfNow();
  let page = syncedNative;
  let rate = 1;
  let paused = false;
  // Epoch milliseconds at page time 0, so Date follows page time.
  const epochAtZero = native.dateNow() - syncedNative;

  const pageNow = (): number => (paused ? page : page + (native.perfNow() - syncedNative) * rate);
  const sync = () => { page = pageNow(); syncedNative = native.perfNow(); };
  /** A native performance timestamp - an event's, a frame's - as page time. */
  const toPage = (nativeAt: number): number => (paused ? page : page + (nativeAt - syncedNative) * rate);

  interface Timer { id: number; at: number; callback: Function; args: unknown[]; interval?: number; order: number }
  const timers = new Map<number, Timer>();
  let nextId = 1;
  let order = 0;
  let pending: unknown;
  // Most a native timer waits before the clock looks again; a pause or a
  // change of rate lands within it.
  const CHECK_MS = 100;

  const due = (): Timer | undefined => {
    let first: Timer | undefined;
    for (const timer of timers.values()) {
      if (!first || timer.at < first.at || (timer.at === first.at && timer.order < first.order)) first = timer;
    }
    return first;
  };

  const channel = typeof g.MessageChannel === 'function' ? new g.MessageChannel() : undefined;
  // One due timer per task, as the browser runs them; a message port yields
  // without the nested-timer clamp of 4ms.
  const nextTask = (run: () => void) => {
    if (channel) { channel.port1.onmessage = run; channel.port2.postMessage(null); }
    else native.setTimeout(run, 0);
  };

  const runDue = () => {
    pending = undefined;
    if (paused) return;
    const timer = due();
    if (!timer || timer.at > pageNow()) { schedule(); return; }
    if (timer.interval !== undefined) {
      timer.at += timer.interval;
      timer.order = order++;
    } else {
      timers.delete(timer.id);
    }
    try {
      timer.callback.apply(g, timer.args);
    } finally {
      nextTask(runDue);
    }
  };

  const schedule = () => {
    if (pending !== undefined) native.clearTimeout(pending);
    pending = undefined;
    // A rate of 0 stands page time still as a pause does.
    if (paused || rate === 0) return;
    const timer = due();
    if (!timer) return;
    const wait = Math.max(0, (timer.at - pageNow()) / rate);
    pending = native.setTimeout(runDue, Math.min(wait, CHECK_MS));
  };

  const addTimer = (callback: unknown, delay: unknown, args: unknown[], repeats: boolean): number => {
    const ms = Math.max(0, Number(delay) || 0);
    const run = typeof callback === 'function' ? callback : () => (0, g.eval)(String(callback));
    const id = nextId++;
    timers.set(id, { id, at: pageNow() + ms, callback: run, args, order: order++, ...(repeats ? { interval: Math.max(1, ms) } : {}) });
    schedule();
    return id;
  };
  const clearTimer = (id: unknown) => {
    if (timers.delete(Number(id))) schedule();
  };

  const define = (target: any, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true });
    } catch { target[name] = value; }
  };
  define(g, 'setTimeout', function setTimeout(callback: unknown, delay?: unknown, ...args: unknown[]) { return addTimer(callback, delay, args, false); });
  define(g, 'setInterval', function setInterval(callback: unknown, delay?: unknown, ...args: unknown[]) { return addTimer(callback, delay, args, true); });
  define(g, 'clearTimeout', function clearTimeout(id: unknown) { clearTimer(id); });
  define(g, 'clearInterval', function clearInterval(id: unknown) { clearTimer(id); });

  define(g.performance, 'now', function now() { return pageNow(); });
  if (native.timeStamp?.get) {
    const read = native.timeStamp.get;
    Object.defineProperty(g.Event.prototype, 'timeStamp', {
      configurable: true, enumerable: true,
      get() { return toPage(read.call(this)); },
    });
  }

  // Frames are Chrome's while they run, handed page time. Held, the app's
  // frame callbacks wait in a queue and run only when devharness steps a
  // frame, so the page can stand at the frame an input scheduled with its JS
  // still running to take the rest of the input.
  let framesHeld = false;
  const queuedFrames = new Map<number, Function>();
  let nextFrameId = 1;
  let releaseFrames: (() => void) | undefined;
  if (native.requestAnimationFrame && native.cancelAnimationFrame) {
    const frame = native.requestAnimationFrame;
    const cancel = native.cancelAnimationFrame;
    const nativeIds = new Map<number, number>();
    // Chrome stamps a frame with its document timeline, which the CSS rate a
    // hold sets has already slowed, so the stamp is not native time to convert:
    // converted, it falls behind performance.now() by every hold so far. A
    // frame takes the page time read at its first callback, and every callback
    // that frame runs shares it.
    let frameStamp: number | undefined;
    let framePage = 0;
    const frameTime = (at: number): number => {
      if (at !== frameStamp) { frameStamp = at; framePage = pageNow(); }
      return framePage;
    };
    // An app that moves a fixed step per frame reads no time, so page time
    // at a slower rate leaves it at full speed. Below a rate of 1 the app's
    // callbacks run on one native frame in 1/rate, each native frame adding
    // `rate` to the share until a whole frame is due; the rest pass the
    // callbacks on to the next native frame.
    let dueStamp: number | undefined;
    let dueNow = true;
    let frameShare = 1;
    const frameDue = (at: number): boolean => {
      if (at !== dueStamp) {
        dueStamp = at;
        if (paused || rate <= 0 || rate >= 1) { frameShare = 1; dueNow = true; }
        else { frameShare = Math.min(1, frameShare + rate); dueNow = frameShare >= 1; if (dueNow) frameShare -= 1; }
      }
      return dueNow;
    };
    const pass = (id: number, callback: Function) => {
      nativeIds.set(id, frame((at: number) => {
        if (!frameDue(at)) { pass(id, callback); return; }
        nativeIds.delete(id);
        callback(frameTime(at));
      }));
    };
    define(g, 'requestAnimationFrame', function requestAnimationFrame(callback: Function) {
      const id = nextFrameId++;
      if (framesHeld) queuedFrames.set(id, callback);
      else pass(id, callback);
      return id;
    });
    define(g, 'cancelAnimationFrame', function cancelAnimationFrame(id: unknown) {
      const key = Number(id);
      if (queuedFrames.delete(key)) return;
      const nativeId = nativeIds.get(key);
      if (nativeId !== undefined) { nativeIds.delete(key); cancel(nativeId); }
    });
    releaseFrames = () => {
      framesHeld = false;
      const waiting = [...queuedFrames];
      queuedFrames.clear();
      for (const [id, callback] of waiting) pass(id, callback);
    };
  }

  if (native.timeoutSignal) {
    define(g.AbortSignal, 'timeout', function timeout(ms: number) {
      const controller = new g.AbortController();
      addTimer(() => controller.abort(new g.DOMException('signal timed out', 'TimeoutError')), ms, [], false);
      return controller.signal;
    });
  }

  const NativeDate = native.Date;
  const epochNow = () => epochAtZero + pageNow();
  function Date(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new NativeDate(epochNow()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [epochNow()], new.target);
  }
  Object.setPrototypeOf(Date, NativeDate);
  Date.prototype = NativeDate.prototype;
  define(Date, 'now', function now() { return Math.floor(epochNow()); });
  try {
    Object.defineProperty(NativeDate.prototype, 'constructor', { value: Date, writable: true, configurable: true });
  } catch { /* a frozen prototype keeps the native constructor */ }
  define(g, 'Date', Date);

  // Media plays on a clock of its own that neither page time nor the CSS rate
  // reaches: a held page left a video playing to its end (26 Oct). What plays
  // when page time stops is paused with it, moved on by each frame step, and
  // played again when page time runs; the app's own pause events fire for it.
  const heldMedia = new Set<any>();
  const mediaElements = (): any[] => {
    try { return [...g.document.querySelectorAll('video, audio')]; } catch { return []; }
  };
  const holdMedia = () => {
    for (const element of mediaElements()) if (!element.paused) { element.pause(); heldMedia.add(element); }
  };
  const releaseMedia = () => {
    for (const element of heldMedia) { try { element.play()?.catch?.(() => {}); } catch { /* removed from the document */ } }
    heldMedia.clear();
  };
  const stepMedia = (ms: number) => {
    for (const element of heldMedia) { try { element.currentTime += ms / 1000; } catch { /* no seekable range yet */ } }
  };

  // Chrome runs a smooth scroll on its compositor, which neither page time
  // nor the CSS rate reaches: at a rate of 0.25 a jump took 1000ms against
  // 992ms at 1 (30 Oct). Below a rate of 1 a smooth scroll the page asks for
  // runs here instead, on page time: the call is made instant to find where
  // each scroller lands, the scrollers are put back, and every frame moves
  // them along an ease-in-out over Chrome's own duration, the square root of
  // the distance in frames of 1/60s, up to 1s. An instant scroll on the
  // scroller, or a person's wheel or touch, ends it, as either ends Chrome's;
  // scroll anchoring moving the scroller under it does not. The
  // scrollend each instant write raises is stopped, the last write's a frame
  // after it, and one scrollend is raised then, so the page sees one where
  // the scroll ends, as a last write to where the scroller stood raises none.
  const scrolling = new Map<any, { from: { x: number; y: number }; to: { x: number; y: number }; start: number; duration: number; ending?: boolean }>();
  const ElementProto = g.Element?.prototype;
  const nativeScroll = ElementProto ? {
    windowTo: g.scrollTo, windowBy: g.scrollBy, window: g.scroll,
    to: ElementProto.scrollTo, by: ElementProto.scrollBy, scroll: ElementProto.scroll, intoView: ElementProto.scrollIntoView,
  } : undefined;
  if (nativeScroll && native.requestAnimationFrame) {
    const frame = native.requestAnimationFrame;
    const docScroller = () => g.document.scrollingElement ?? g.document.documentElement;
    const at = (scroller: any) => ({ x: Number(scroller.scrollLeft) || 0, y: Number(scroller.scrollTop) || 0 });
    const place = (scroller: any, to: { x: number; y: number }) => nativeScroll.to.call(scroller, { left: to.x, top: to.y, behavior: 'instant' });
    const slowed = () => !paused && rate > 0 && rate < 1;
    const smoothFor = (scroller: any, behavior: unknown) => {
      if (behavior === 'smooth') return true;
      if (behavior === 'instant') return false;
      try { return g.getComputedStyle(scroller).scrollBehavior === 'smooth'; } catch { return false; }
    };
    let ticking = false;
    const tick = () => {
      for (const [scroller, run] of scrolling) {
        if (run.ending) {
          scrolling.delete(scroller);
          const target = scroller === docScroller() ? g.document : scroller;
          try { target.dispatchEvent(new g.Event('scrollend', { bubbles: target === g.document })); } catch { /* a scroller gone from the page */ }
          continue;
        }
        const t = Math.min(1, Math.max(0, (pageNow() - run.start) / run.duration));
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        if (t >= 1) run.ending = true;
        place(scroller, { x: run.from.x + (run.to.x - run.from.x) * eased, y: run.from.y + (run.to.y - run.from.y) * eased });
      }
      ticking = scrolling.size > 0;
      if (ticking) frame(tick);
    };
    const begin = (scroller: any, from: { x: number; y: number }, to: { x: number; y: number }) => {
      const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
      if (distance < 1) { scrolling.delete(scroller); return; }
      scrolling.set(scroller, { from, to, start: pageNow(), duration: Math.min(Math.sqrt(distance), 60) / 60 * 1000 });
      if (!ticking) { ticking = true; frame(tick); }
    };
    // The scrollers a call can move: for scrollIntoView every scrolling box around the element, else the one called on.
    const scrollersOf = (self: any, method: string): any[] => {
      if (method !== 'intoView') return [self === g || self === undefined ? docScroller() : self];
      const boxes: any[] = [];
      for (let box = self?.parentElement; box; box = box.parentElement) {
        if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) boxes.push(box);
      }
      if (!boxes.includes(docScroller())) boxes.push(docScroller());
      return boxes;
    };
    const take = (owner: any, name: string, method: keyof typeof nativeScroll) => {
      const original = nativeScroll[method];
      if (typeof original !== 'function') return;
      define(owner, name, function (this: any, ...args: any[]) {
        const options = args[0] !== null && typeof args[0] === 'object' ? args[0] : undefined;
        const scrollers = scrollersOf(this, method);
        const behavior = method === 'intoView' ? options?.behavior : (options ? options.behavior : undefined);
        const smooth = scrollers.filter(scroller => smoothFor(scroller, behavior));
        if (!slowed() || smooth.length === 0) {
          for (const scroller of scrollers) scrolling.delete(scroller);
          return original.apply(this, args);
        }
        const before = new Map(scrollers.map(scroller => [scroller, at(scroller)]));
        const instant = method === 'intoView'
          ? [{ ...(options ?? (args[0] === false ? { block: 'end', inline: 'nearest' } : {})), behavior: 'instant' }]
          : [options ? { ...options, behavior: 'instant' } : { left: Number(args[0]) || 0, top: Number(args[1]) || 0, behavior: 'instant' }];
        original.apply(this, instant);
        for (const scroller of smooth) {
          const from = before.get(scroller)!;
          const to = at(scroller);
          place(scroller, from);
          begin(scroller, from, to);
        }
        for (const scroller of scrollers) if (!smooth.includes(scroller)) scrolling.delete(scroller);
        return undefined;
      });
    };
    take(g, 'scrollTo', 'windowTo');
    take(g, 'scroll', 'window');
    take(g, 'scrollBy', 'windowBy');
    take(ElementProto, 'scrollTo', 'to');
    take(ElementProto, 'scroll', 'scroll');
    take(ElementProto, 'scrollBy', 'by');
    take(ElementProto, 'scrollIntoView', 'intoView');
    for (const type of ['wheel', 'touchstart']) {
      g.addEventListener(type, (event: any) => { if (event.isTrusted) scrolling.clear(); }, { capture: true, passive: true });
    }
    g.addEventListener('scrollend', (event: any) => {
      const scroller = event.target === g.document ? docScroller() : event.target;
      if (event.isTrusted && scrolling.has(scroller)) event.stopImmediatePropagation();
    }, { capture: true });
  }

  // A frame recalculates style and lays the page out after its callbacks, and
  // recalculating style is what starts a CSS transition. A held page renders
  // no frame, so a step that ran the page's callbacks brings the whole document
  // up to date here - a computed style read updates one element alone, a
  // layout read every one - and the transitions they set off begin on that
  // step, not on whatever next reads the page.
  const flushStyle = () => {
    try { if (g.document.documentElement) void g.document.documentElement.offsetWidth; } catch { /* nothing to lay out */ }
  };
  // What a step's callbacks created and ended, read once style is current:
  // a transition a held step sets off stands pending, where only the page's
  // own list reaches it.
  const swept = (): object => {
    const reading = g[Symbol.for('devharness.animations')]?.sweep?.();
    return reading ? { animations: reading } : {};
  };

  // The controls devharness drives from outside, read while the page's JS is
  // stopped as well as while it runs.
  g[Symbol.for('devharness.clock')] = {
    /** Stop page time where it stands; no timer fires until it runs again. */
    pause() { if (paused) return page; sync(); paused = true; schedule(); holdMedia(); return page; },
    /** Run page time on from where it stopped, and the frames held with it. */
    resume() {
      if (framesHeld) releaseFrames?.();
      if (!paused) return page;
      syncedNative = native.perfNow(); paused = false; schedule(); if (rate > 0) releaseMedia(); return page;
    },
    /** Queue the app's frame callbacks in place of handing them to Chrome. */
    holdFrames() { if (!releaseFrames) return false; framesHeld = true; return true; },
    /**
     * One frame on a stopped clock: page time moves `ms` on, the timers that
     * come due in that span run in order, then the frame callbacks queued so
     * far run once with the new page time; the ones they ask for wait for the
     * next frame.
     */
    frame(ms: number) {
      if (!paused) sync();
      paused = true;
      schedule();
      page += Math.max(0, Number(ms) || 0);
      stepMedia(Math.max(0, Number(ms) || 0));
      // One callback's error leaves the rest of the frame to run, as the
      // browser runs each task and frame callback apart; it is reported as
      // an uncaught error would be.
      const run = (callback: Function, args: unknown[]) => {
        try { callback.apply(g, args); } catch (error) { if (typeof g.reportError === 'function') g.reportError(error); }
      };
      for (let timer = due(); timer && timer.at <= page; timer = due()) {
        if (timer.interval !== undefined) { timer.at += timer.interval; timer.order = order++; } else timers.delete(timer.id);
        run(timer.callback, timer.args);
      }
      const batch = [...queuedFrames.values()];
      queuedFrames.clear();
      for (const callback of batch) run(callback, [page]);
      flushStyle();
      return { now: page, ran: batch.length, waiting: queuedFrames.size, ...swept() };
    },
    /**
     * The next thing a stopped clock holds, run on its own: the timer due
     * first, page time moved to it, or the held frame when that comes first.
     * Nothing held answers null.
     */
    next(frameMs: number) {
      if (!paused) { sync(); paused = true; schedule(); }
      const timer = due();
      const frameAt = queuedFrames.size ? page + frameMs : Infinity;
      if (!timer && frameAt === Infinity) return null;
      if (timer && timer.at <= frameAt) {
        page = Math.max(page, timer.at);
        if (timer.interval !== undefined) { timer.at += timer.interval; timer.order = order++; } else timers.delete(timer.id);
        try { timer.callback.apply(g, timer.args); } catch (error) { if (typeof g.reportError === 'function') g.reportError(error); }
        flushStyle();
        return { kind: timer.interval !== undefined ? 'setInterval' : 'setTimeout', fn: timer.callback.name || '', now: page, ...swept() };
      }
      return { kind: 'requestAnimationFrame', fn: '', ...this.frame(frameMs) };
    },
    /** Whether a smooth scroll the clock runs at a slower rate is still moving. */
    scrolling() { return scrolling.size > 0; },
    /** Run page time at this multiple of wall time. */
    rate(value: number) {
      sync(); rate = Math.max(0, Number(value) || 0); schedule();
      for (const element of mediaElements()) { try { if (rate > 0) element.playbackRate = rate; } catch { /* a rate the element refuses */ } }
      if (rate === 0) holdMedia(); else if (!paused) releaseMedia();
      return rate;
    },
    /** Wall-time scheduling for devharness's own page scripts, out of page time and out of the callbacks a step runs. */
    native: { setTimeout: native.setTimeout, clearTimeout: native.clearTimeout, perfNow: native.perfNow, requestAnimationFrame: native.requestAnimationFrame },
    /** Where page time stands, and how far behind wall time holds and slower speeds have left it. */
    state() {
      const now = pageNow();
      return { now, behind: native.perfNow() - now, paused, rate, timers: timers.size, framesHeld, framesWaiting: queuedFrames.size };
    },
  };
}

/** The clock as page source, run before the app's first script. */
export const PAGE_CLOCK_SOURCE = `(${installPageClock.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
