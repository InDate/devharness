/**
 * What set a motion going, read in the page at the moment it starts.
 *
 * A motion carries no record of its cause: a style write, an `animate()` call
 * and a transition read the same whether a click, a server's reply or a
 * timer started them. The page holds the answer only while the work that
 * started it runs, so every way work enters the page marks it here first:
 * trusted input, a pointer entering an element, a motion ending, a fetch or
 * XHR response, a socket or SSE message, a timer or frame callback, the
 * document loading, a scroll, and a media element told to play or pause.
 * Installed after the clock and before the app's first script, its listeners
 * stand ahead of the app's and its wrappers around the clock's schedulers.
 *
 * A mark is live for the task it was made in, so a motion begun inside that
 * task reads it as its trigger. A timer or frame callback carries the trigger
 * live when it was scheduled, so a timeout set in a click handler reads
 * `click · timer 300ms`. A callback with none - a library's frame loop
 * started at load - reads the trigger of the last 100ms before it as `after
 * click · frame loop`, which says when, not what. A CSS transition or keyframe
 * animation starts at the next style recalc, outside any task, so it reads the
 * trigger of the last class or style change on its element or an ancestor.
 */

/** Where the tracker stands on the page's global, out of the app's way. */
export const TRIGGER_KEY = 'devharness.trigger';

function installPageTrigger(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.trigger')]) return;

  const native = g[Symbol.for('devharness.clock')]?.native;
  const now: () => number = native?.perfNow ?? g.performance.now.bind(g.performance);
  // Taken before the schedulers below are wrapped: a wrapped timer marks, and
  // a mark that set one would mark again on every task.
  const unwrappedTimeout: (run: () => void, ms: number) => unknown = native?.setTimeout ?? g.setTimeout.bind(g);
  const nextTask = (run: () => void) => { unwrappedTimeout(run, 0); };
  // A trigger the last of these named reads as `after <it>` on a callback that carries none.
  const AFTER_MS = 100;
  // A smooth scroll runs for up to a second after the call that began it.
  const SCROLL_CALL_MS = 1000;
  const CHANGE_MS = 2000;

  // A carrier's mark holds the cause it was scheduled under as `origin`, where
  // one was live; a call's mark holds its method; an input's, whether the
  // page scrolls on it by itself.
  // `site` is where the app made the call that marked; `harness` marks a
  // scroll devharness made itself.
  interface Mark { kind: string; words: string; at: number; live: boolean; origin?: string; method?: string; scrolls?: boolean; fn?: any; site?: Site; harness?: boolean }
  /** An app call's site: its function where the engine hands it over, else its script and line. */
  interface Site { fn?: any; url?: string; line?: number }
  let last: Mark | undefined;
  /** The newest mark of a kind that starts work rather than carries it. */
  let lastCause: Mark | undefined;
  let lastInput: Mark | undefined;
  let lastScrollCall: Mark | undefined;
  let lastHash: Mark | undefined;
  let lastScroll: Mark | undefined;
  let loadedAt: number | undefined;
  // A change this soon after the load event belongs to the load: an app's
  // load-time setup runs in callbacks nothing here marks.
  const LOAD_TAIL_MS = 500;
  const CARRIERS = new Set(['timer', 'frame']);
  // Keys the page scrolls on by itself, with no script of its own.
  const SCROLL_KEYS = new Set([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  // Taken before the wrapper below, for the tracker's own listeners: theirs
  // are not the app's work, and a JS motion must never point at them.
  const EventTargetProto = g.EventTarget?.prototype;
  const add = EventTargetProto?.addEventListener;
  const listen = (target: any, type: string, fn: (event: any) => void, options?: any) => { add?.call(target, type, fn, options); };
  // Listeners devharness's other page scripts register here through `own`.
  const owned = new WeakSet<object>();
  // Set while devharness's own code calls a wrapped function through
  // `quietly`: its scroll is not the app's work.
  let quiet = false;

  // Held weakly by id, for a reader to reveal what made a motion without
  // keeping a function or an element the page has let go.
  const Ref = typeof g.WeakRef === 'function' ? g.WeakRef : class { constructor(private value: object) {} deref() { return this.value; } };
  const refs = new Map<number, { deref(): any }>();
  const refIds = new WeakMap<object, number>();
  let nextRef = 1;
  const refOf = (target: any): number | undefined => {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
    let id = refIds.get(target);
    if (id === undefined) {
      id = nextRef++;
      refIds.set(target, id);
      refs.set(id, new Ref(target));
      if (refs.size > 2000) refs.delete(refs.keys().next().value as number);
    }
    return id;
  };
  // The app's function running now, set by every callback wrapper below and
  // cleared at the end of its task: what a JS motion begun in it points at.
  let running: any;
  const runAs = (fn: any) => {
    running = fn;
    nextTask(() => { if (running === fn) running = undefined; });
  };
  // The send wrapper schedules the app's callback inside one of its own, and
  // hands the app's on under this symbol.
  const CALLBACK = Symbol.for('devharness.callback');
  // A listener the app adds is the outermost of its functions on the stack; a
  // call it reaches through a plain function, as a key map does, stands below
  // it. V8's structured stack gives the frame that called `wrapper`: its
  // function in sloppy code, and its script and line in strict code, where
  // the engine withholds the function.
  const siteOf = (wrapper: any): Site | undefined => {
    const E = g.Error;
    if (typeof E?.captureStackTrace !== 'function') return undefined;
    const prepare = E.prepareStackTrace;
    const holder: { stack?: any } = {};
    try {
      E.prepareStackTrace = (_: unknown, sites: any[]) => sites;
      E.captureStackTrace(holder, wrapper);
      const frame = Array.isArray(holder.stack) ? holder.stack[0] : undefined;
      if (!frame) return undefined;
      const fn = frame.getFunction?.();
      const url = frame.getScriptNameOrSourceURL?.() ?? frame.getFileName?.();
      const line = frame.getLineNumber?.();
      return { ...(fn ? { fn } : {}), ...(url ? { url: String(url) } : {}), ...(typeof line === 'number' ? { line } : {}) };
    } catch {
      return undefined;
    } finally {
      E.prepareStackTrace = prepare;
    }
  };

  const nameOf = (element: any): string => {
    const named = g[Symbol.for('devharness.animations')]?.name?.(element);
    if (named) return named;
    return element && element.tagName ? String(element.tagName).toLowerCase() : 'window';
  };
  const pathOf = (url: unknown): string => {
    try { return new g.URL(String(url), g.location.href).pathname; } catch { return String(url); }
  };

  const mark = (kind: string, words: string, facts: Partial<Mark> = {}): Mark => {
    const made: Mark = { kind, words, at: now(), live: true, ...facts };
    last = made;
    if (!CARRIERS.has(kind)) lastCause = made;
    nextTask(() => { made.live = false; });
    return made;
  };

  const loading = (): boolean => g.document.readyState !== 'complete' || (loadedAt !== undefined && now() - loadedAt <= LOAD_TAIL_MS);

  /**
   * The trigger of work running now, in words, or undefined where nothing
   * marked it. `withLoad: false` leaves the page loading out: a call made
   * while the page loads names no cause of its own to carry.
   */
  const current = (withLoad = true): string | undefined => {
    if (last && last.live && (withLoad || last.kind !== 'load')) {
      if (!CARRIERS.has(last.kind) || last.origin !== undefined) return last.words;
      if (lastCause && now() - lastCause.at <= AFTER_MS) return `after ${lastCause.words} · ${last.words}`;
      if (withLoad && loading()) return `page load · ${last.words}`;
      return last.words;
    }
    if (withLoad && loading()) return 'page load';
    if (lastCause && lastCause.kind !== 'load' && now() - lastCause.at <= AFTER_MS) return `after ${lastCause.words}`;
    return undefined;
  };

  // Input, first in every dispatch: these listeners stand ahead of the app's.
  const INPUT: Record<string, string> = { pointerdown: 'press', click: 'click', keydown: 'key', wheel: 'wheel', touchstart: 'touch', touchmove: 'touch' };
  for (const type of Object.keys(INPUT)) {
    listen(g, type, (event: any) => {
      if (!event.isTrusted) return;
      lastInput = mark('input', type === 'keydown' ? `key ${event.key}` : INPUT[type], {
        scrolls: type === 'wheel' || type === 'touchmove' || (type === 'keydown' && SCROLL_KEYS.has(event.key)),
      });
    }, { capture: true, passive: true });
  }
  listen(g, 'pointermove', (event: any) => {
    if (event.isTrusted && event.buttons) lastInput = mark('input', 'drag', { scrolls: true });
  }, { capture: true, passive: true });
  listen(g, 'pointerover', (event: any) => {
    if (event.isTrusted && event.pointerType === 'mouse') mark('pointer', 'hover');
  }, { capture: true, passive: true });
  for (const type of ['transitionend', 'animationend']) {
    listen(g, type, (event: any) => {
      mark('chain', `end of ${event.propertyName || event.animationName} on ${nameOf(event.target)}`);
    }, { capture: true, passive: true });
  }
  listen(g, 'hashchange', () => { lastHash = mark('scroll-cause', `#${String(g.location.hash).slice(1)}`); }, { capture: true });
  listen(g, 'DOMContentLoaded', () => mark('load', 'page load'), { capture: true });
  listen(g, 'load', () => { loadedAt = now(); mark('load', 'page load'); }, { capture: true });

  /** What moved the page this scroll: the person's input, a script's call, a link to an anchor, or the browser. */
  const scrollCause = (): string => {
    const t = now();
    // The newest wins: a key whose handler calls scrollIntoView() reads as the call, which carries the key.
    const candidates = [
      lastInput && t - lastInput.at <= 150 ? lastInput : undefined,
      lastScrollCall && t - lastScrollCall.at <= SCROLL_CALL_MS ? lastScrollCall : undefined,
      lastHash && t - lastHash.at <= SCROLL_CALL_MS ? lastHash : undefined,
    ].filter((one): one is Mark => one !== undefined);
    if (candidates.length === 0) return 'browser';
    // A call made in the input's own handler can share its timestamp; the call, listed later, is the newer.
    return candidates.reduce((newest, one) => (one.at >= newest.at ? one : newest)).words;
  };
  listen(g, 'scroll', () => { lastScroll = mark('scroll', `scroll · ${scrollCause()}`); }, { capture: true, passive: true });

  /** Wrap a function so each call marks first, as `words`, with what was live when it was called. */
  const calls = (owner: any, method: string, kind: string, words: string, after?: (made: Mark) => void) => {
    const original = owner && owner[method];
    if (typeof original !== 'function') return;
    const wrapper = function (this: any, ...args: unknown[]) {
      if (quiet) return original.apply(this, args);
      const under = current(false);
      const made = mark(kind, under !== undefined ? `${under} · ${words}` : words, { method, fn: running, site: siteOf(wrapper) });
      after?.(made);
      return original.apply(this, args);
    };
    owner[method] = wrapper;
  };
  // The global's own methods stand on the window itself, where a bare
  // `scrollTo()` finds them, not on Window.prototype.
  for (const [owner, method] of [[g, 'scrollTo'], [g, 'scrollBy'], [g, 'scroll'],
    [g.Element?.prototype, 'scrollIntoView'], [g.Element?.prototype, 'scrollTo'], [g.Element?.prototype, 'scrollBy']] as Array<[any, string]>) {
    calls(owner, method, 'scroll-cause', `${method}()`, made => { lastScrollCall = made; });
  }
  for (const property of ['scrollTop', 'scrollLeft']) {
    const described = g.Element && Object.getOwnPropertyDescriptor(g.Element.prototype, property);
    if (!described?.set) continue;
    const set = function (this: any, value: unknown) {
      if (quiet) { described.set!.call(this, value); return; }
      const under = current(false);
      lastScrollCall = mark('scroll-cause', under !== undefined ? `${under} · ${property} =` : `${property} =`, { method: property, fn: running, site: siteOf(set) });
      described.set!.call(this, value);
    };
    Object.defineProperty(g.Element.prototype, property, { ...described, set });
  }
  // A media element and an SVG animation start on their own events, a task
  // after the call; the call is kept for those events to find.
  const called: Mark[] = [];
  const keep = (made: Mark) => { called.push(made); if (called.length > 8) called.shift(); };
  for (const method of ['play', 'pause']) calls(g.HTMLMediaElement?.prototype, method, 'media', `${method}()`, keep);
  for (const method of ['beginElement', 'beginElementAt']) calls(g.SVGAnimationElement?.prototype, method, 'media', `${method}()`, keep);

  // An observer's callback is the cause of what it changes: an element coming
  // into view, mostly by a scroll, or an element resized.
  for (const [name, words] of [['IntersectionObserver', 'in view'], ['ResizeObserver', 'resize']]) {
    const Original = g[name];
    if (typeof Original !== 'function') continue;
    const Wrapped = function (this: any, callback: any, ...rest: unknown[]) {
      return new Original(function (this: any, ...given: unknown[]) {
        runAs(callback);
        const scrolled = lastScroll && now() - lastScroll.at <= AFTER_MS ? `${lastScroll.words} · ` : '';
        mark('observer', `${scrolled}${words}`);
        return callback.apply(this, given);
      }, ...rest);
    } as any;
    Wrapped.prototype = Original.prototype;
    g[name] = Wrapped;
  }

  // A reply's handlers run in the microtasks after its promise settles.
  if (typeof g.fetch === 'function') {
    const fetched = g.fetch;
    g.fetch = function (this: any, resource: any, init?: any) {
      const method = String(init?.method ?? resource?.method ?? 'GET').toUpperCase();
      const url = resource && typeof resource === 'object' && resource.url ? resource.url : resource;
      return fetched.apply(this, [resource, init]).then((response: any) => {
        mark('reply', `reply ${method} ${pathOf(url)}`);
        return response;
      });
    };
  }
  const Xhr = g.XMLHttpRequest;
  if (typeof Xhr === 'function') {
    const open = Xhr.prototype.open;
    Xhr.prototype.open = function (this: any, method: string, url: string, ...rest: unknown[]) {
      // Added at open, ahead of a handler the app adds before send.
      listen(this, 'readystatechange', () => { if (this.readyState === 4) mark('reply', `reply ${String(method).toUpperCase()} ${pathOf(url)}`); });
      return open.apply(this, [method, url, ...rest]);
    };
  }
  for (const name of ['WebSocket', 'EventSource']) {
    const Original = g[name];
    if (typeof Original !== 'function') continue;
    const Wrapped = function (this: any, url: string, ...rest: unknown[]) {
      const made = new Original(url, ...rest);
      listen(made, 'message', () => mark('push', `push ${pathOf(url)}`));
      return made;
    } as any;
    Wrapped.prototype = Original.prototype;
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (!(key in Wrapped)) { try { Wrapped[key] = Original[key]; } catch { /* a read-only static */ } }
    }
    g[name] = Wrapped;
  }

  // A callback carries the trigger live when it was scheduled.
  const scheduled = (method: string, words: (args: unknown[]) => string) => {
    const original = g[method];
    if (typeof original !== 'function') return;
    g[method] = function (this: any, callback: any, ...args: unknown[]) {
      if (typeof callback !== 'function') return original.apply(this, [callback, ...args]);
      // A carrier passes on the cause it carries; one carrying none passes on nothing.
      const under = last && last.live && (!CARRIERS.has(last.kind) || last.origin !== undefined) ? last : undefined;
      const said = words(args);
      const origin = under ? (CARRIERS.has(under.kind) ? under.origin : under.words) : undefined;
      const carried = origin !== undefined ? `${origin} · ${said}` : said;
      return original.apply(this, [function (this: any, ...given: unknown[]) {
        runAs(callback[CALLBACK] ?? callback);
        mark(method === 'requestAnimationFrame' ? 'frame' : 'timer', carried, origin !== undefined ? { origin } : {});
        return callback.apply(this, given);
      }, ...args]);
    };
  };
  scheduled('setTimeout', args => `timer ${Math.round(Number(args[0]) || 0)}ms`);
  scheduled('setInterval', args => `every ${Math.round(Number(args[0]) || 0)}ms`);
  scheduled('requestAnimationFrame', () => 'frame loop');

  // A listener the app adds runs as the app's function, for a motion it starts
  // to point at; the same wrapper is handed back to remove it.
  if (EventTargetProto && typeof add === 'function') {
    const remove = EventTargetProto.removeEventListener;
    const wrapped = new WeakMap<object, Map<string, any>>();
    const keyOf = (type: string, options: any) => `${type}|${typeof options === 'boolean' ? options : !!options?.capture}`;
    EventTargetProto.addEventListener = function (this: any, type: string, listener: any, options?: any) {
      if (typeof listener !== 'function' || owned.has(listener)) return add.call(this, type, listener, options);
      const byKey = wrapped.get(listener) ?? new Map<string, any>();
      const key = keyOf(type, options);
      let wrapper = byKey.get(key);
      if (!wrapper) {
        wrapper = function (this: any, ...given: unknown[]) { runAs(listener); return listener.apply(this, given); };
        byKey.set(key, wrapper);
        wrapped.set(listener, byKey);
      }
      return add.call(this, type, wrapper, options);
    };
    EventTargetProto.removeEventListener = function (this: any, type: string, listener: any, options?: any) {
      const wrapper = typeof listener === 'function' ? wrapped.get(listener)?.get(keyOf(type, options)) : undefined;
      return remove.call(this, type, wrapper ?? listener, options);
    };
  }

  // An animation the page creates by call reads the trigger live at the call.
  const byAnimation = new WeakMap<object, string>();
  const animatedBy = new WeakMap<object, any>();
  const animatedAt = new WeakMap<object, Site>();
  const animate = g.Element?.prototype?.animate;
  if (typeof animate === 'function') {
    const wrapper = function (this: any, ...args: unknown[]) {
      const made = animate.apply(this, args);
      const words = current();
      if (words) byAnimation.set(made, words);
      if (running) animatedBy.set(made, running);
      const site = siteOf(wrapper);
      if (site) animatedAt.set(made, site);
      // Its end starts what the app chains on it: the reaction is added here
      // first, so it marks before the app's own `finished` reaction runs.
      const ended = () => mark('chain', `end of ${made.id || 'animation'} on ${nameOf(this)}`);
      made.finished?.then(ended, () => {});
      return made;
    };
    g.Element.prototype.animate = wrapper;
  }

  // A transition or keyframe animation starts at the style recalc after the
  // change that set it off, outside any task: the change's trigger is kept.
  const changed = new WeakMap<object, { words: string; at: number }>();
  if (typeof g.MutationObserver === 'function') {
    const observer = new g.MutationObserver((records: any[]) => {
      const words = current();
      if (!words) return;
      const at = now();
      for (const record of records) {
        changed.set(record.target, { words, at });
        for (const node of record.addedNodes ?? []) changed.set(node, { words, at });
      }
    });
    const watch = () => observer.observe(g.document, { subtree: true, attributes: true, childList: true });
    if (g.document.documentElement) watch(); else listen(g.document, 'readystatechange', watch, { once: true });
  }
  const ofElement = (target: any): string | undefined => {
    const t = now();
    let newest: { words: string; at: number } | undefined;
    for (let node = target; node; node = node.parentNode ?? node.host) {
      const change = changed.get(node);
      if (change && t - change.at <= CHANGE_MS && (!newest || change.at > newest.at)) newest = change;
    }
    if (newest) return newest.words;
    try { if (target && target.matches && target.matches(':hover')) return 'hover'; } catch { /* a node with no matches */ }
    return current();
  };
  const started = new WeakMap<object, Map<string, string>>();
  for (const type of ['transitionrun', 'animationstart']) {
    listen(g, type, (event: any) => {
      const words = ofElement(event.target);
      if (!words) return;
      const named = started.get(event.target) ?? new Map<string, string>();
      named.set(event.propertyName || event.animationName, words);
      started.set(event.target, named);
    }, { capture: true, passive: true });
  }

  /**
   * A motion's maker, with what a go-to reveals and its name. A call's site
   * holding its function reveals that function; one holding only its script
   * and line reveals `target` and carries the line as `makerAt`.
   */
  const made = (maker: string, target?: any, site?: Site) => {
    const shown = site?.fn ?? target;
    return {
      maker,
      ...(refOf(shown) !== undefined ? { makerRef: refOf(shown) } : {}),
      ...(shown ? { makerName: typeof shown === 'function' ? (shown.name ? `${shown.name}()` : 'a function') : nameOf(shown) } : {}),
      ...(!site?.fn && site?.url && site.line !== undefined ? { makerAt: { url: site.url, line: site.line } } : {}),
    };
  };

  g[Symbol.for('devharness.trigger')] = {
    current,
    /** Register a listener of devharness's own, which the listener wrapper leaves as it is. */
    own<T extends object>(fn: T): T { owned.add(fn); return fn; },
    /** Mark the scroll devharness makes next, over CDP or by a call, as `words`: it is the harness's, not the app's. */
    ownScroll(words: string): void { lastScrollCall = mark('scroll-cause', words, { harness: true }); },
    /** Run devharness's own call as `words`: a scroll it makes is the harness's, not the app's. */
    quietly<T>(run: () => T, words = 'devharness'): T {
      lastScrollCall = mark('scroll-cause', words, { harness: true });
      quiet = true;
      try { return run(); } finally { quiet = false; }
    },
    /** What reveals the app's work running now: a JS motion begun in it points at the function. */
    runningMaker: () => made('JS', running),
    /** Who moved the page this scroll: the person, a script's call, devharness, or the browser. */
    scrollMaker() {
      const t = now();
      const newest = [lastInput && t - lastInput.at <= 150 ? lastInput : undefined, lastScrollCall && t - lastScrollCall.at <= SCROLL_CALL_MS ? lastScrollCall : undefined]
        .filter((one): one is Mark => one !== undefined).reduce<Mark | undefined>((newest, one) => (!newest || one.at >= newest.at ? one : newest), undefined);
      // The person scrolls the page by wheel, touch, a drag or a key the page
      // scrolls on; any other input that scrolled it ran the app's code.
      if (newest && newest === lastInput) return newest.scrolls ? made('ME') : made('JS', running);
      if (newest?.harness) return made('HARNESS');
      if (newest) return made('JS', newest.fn, newest.site);
      return made('BROWSER');
    },
    /** What made an Animation object: a CSS transition or keyframes, else the script that called animate(). */
    animationMaker(animation: any) {
      const target = animation && animation.effect && animation.effect.target;
      if (animation && (animation.transitionProperty !== undefined || animation.animationName !== undefined)) return made('CSS', target);
      return made('JS', animatedBy.get(animation) ?? target, animatedAt.get(animation));
    },
    /** What made a media element play, or pause: the function that called `method`, else the element. */
    mediaMaker(element: any, method = 'play') {
      const t = now();
      const call = [...called].reverse().find(one => one.method === method && t - one.at <= 1000);
      return made('MEDIA', call?.fn ?? element, call?.site);
    },
    /** A maker of `kind` pointing at `target`. */
    maker: made,
    /** The object behind a maker's ref, for DevTools to reveal; null once the page let it go. */
    reveal: (id: number) => refs.get(Number(id))?.deref() ?? null,
    /** What started an Animation object: its call, else the change that set its element going. */
    ofAnimation(animation: any): string | undefined {
      // A scroll-driven animation moves with the scroll position, whatever created it.
      if (animation && animation.timeline && g.document.timeline && animation.timeline !== g.document.timeline) return 'scroll timeline';
      const called = byAnimation.get(animation);
      if (called) return called;
      const target = animation && animation.effect && animation.effect.target;
      const name = animation && (animation.transitionProperty || animation.animationName);
      return (target && name && started.get(target)?.get(name)) ?? (target ? ofElement(target) : undefined);
    },
    /** What called one of `methods` within the last second, newest first, else `fallback`. */
    ofCall(methods: string[], fallback: string): string {
      const t = now();
      const call = [...called].reverse().find(one => one.method !== undefined && methods.includes(one.method) && t - one.at <= 1000);
      return call ? call.words : fallback;
    },
    scrollCause,
  };
}

/** The trigger tracker as page source, run after the clock and before the app's first script. */
export const PAGE_TRIGGER_SOURCE = `(${installPageTrigger.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
