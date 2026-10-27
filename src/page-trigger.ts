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
  const unwrappedFrame: ((run: () => void) => unknown) | undefined = native?.requestAnimationFrame ?? (typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : undefined);
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
  // `root` is the input at the head of the chain the mark stands in, carried
  // from mark to mark as the work it started runs on.
  interface Mark { kind: string; words: string; at: number; live: boolean; origin?: string; method?: string; scrolls?: boolean; fn?: any; site?: Site; harness?: boolean; root?: Root }
  /**
   * The input at the head of a chain: an id this document gives it, and the
   * step devharness ran it under where devharness drove it. A person's input
   * has no step here; the person watch reports the id with the input, and the
   * History entry it becomes is the input's step.
   */
  interface Root { id: string; step?: string }
  /** An app call's site: its function where the engine hands it over, else its script and line. */
  interface Site { fn?: any; url?: string; line?: number }
  let last: Mark | undefined;
  // Ids unique to this document: a reload numbers afresh under a new prefix.
  const rootPrefix = Math.random().toString(36).slice(2, 10);
  let nextRoot = 1;
  // The step a driven input runs under, set by devharness around its dispatch.
  let drivenBy: string | undefined;
  const ROOTS = new Set(['input', 'pointer']);
  /** The newest mark of a kind that starts work rather than carries it. */
  let lastCause: Mark | undefined;
  let lastInput: Mark | undefined;
  let lastScrollCall: Mark | undefined;
  let lastHash: Mark | undefined;
  let lastScroll: Mark | undefined;
  let lastHover: Mark | undefined;
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
    const root = facts.root ?? (ROOTS.has(kind) ? { id: `${rootPrefix}:${nextRoot++}`, ...(drivenBy ? { step: drivenBy } : {}) } : undefined);
    const made: Mark = { kind, words, at: now(), live: true, ...facts, ...(root ? { root } : {}) };
    last = made;
    if (!CARRIERS.has(kind)) lastCause = made;
    nextTask(() => { made.live = false; });
    return made;
  };

  // Work outstanding under each root: callbacks scheduled and not yet run,
  // replies and body reads not yet resolved, animations and motion runs not
  // yet ended. A root whose count falls to zero and stays there through the
  // next rendering opportunity - the style recalc that starts a transition
  // its last task queued - has settled: nothing it started can still land.
  // Each change between open and settled is reported, so a reader of a step
  // takes what the step caused once its roots have settled.
  const outstanding = new Map<string, { root: Root; n: number }>();
  const reportRoot = (root: Root, open: boolean) => {
    const send = g.__devharnessMotion;
    if (typeof send !== 'function') return;
    try { send(JSON.stringify({ phase: 'root', id: root.id, ...(root.step ? { step: root.step } : {}), open })); } catch { /* the binding went with a navigation */ }
  };
  const hold = (root: Root | undefined): void => {
    if (!root) return;
    const held = outstanding.get(root.id) ?? { root, n: 0 };
    held.n++;
    outstanding.set(root.id, held);
    if (held.n === 1) reportRoot(root, true);
  };
  const release = (root: Root | undefined): void => {
    const held = root ? outstanding.get(root.id) : undefined;
    if (!held || --held.n > 0) return;
    const settle = () => {
      if (held.n > 0 || outstanding.get(held.root.id) !== held) return;
      outstanding.delete(held.root.id);
      reportRoot(held.root, false);
    };
    if (unwrappedFrame) unwrappedFrame(() => nextTask(settle)); else nextTask(settle);
  };

  // An input's handler can leave work the browser starts after it returns:
  // a class change starts its transition at the next style recalc. Its root
  // is held through the task, and `release` keeps it open through the next
  // rendering opportunity after that.
  const holdThroughTask = (root: Root | undefined): void => {
    if (!root) return;
    hold(root);
    nextTask(() => release(root));
  };
  const harnessRoot = (step: string | undefined): Root => {
    const root: Root = { id: `${rootPrefix}:${nextRoot++}`, ...(step ?? drivenBy ? { step: step ?? drivenBy } : {}) };
    holdThroughTask(root);
    return root;
  };

  /** The root of the work running now: the live mark's, where a live mark carries one. */
  const liveRoot = (): Root | undefined =>
    (last && last.live && (!CARRIERS.has(last.kind) || last.origin !== undefined) ? last.root : undefined);

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
  // One mark per event, made by whichever listener reaches the event first:
  // the person watch's listeners stand in the same dispatch, installed from
  // another CDP session, so their order against these is not fixed.
  const inputMarks = new WeakMap<object, Mark>();
  const markInput = (event: any): Mark => {
    const held = inputMarks.get(event);
    if (held) return held;
    const type = event.type;
    lastInput = mark('input', type === 'keydown' ? `key ${event.key}` : INPUT[type], {
      scrolls: type === 'wheel' || type === 'touchmove' || (type === 'keydown' && SCROLL_KEYS.has(event.key)),
    });
    inputMarks.set(event, lastInput);
    if (lastInput.scrolls) releaseScrollHolds();
    holdThroughTask(lastInput.root);
    return lastInput;
  };
  for (const type of Object.keys(INPUT)) {
    listen(g, type, (event: any) => {
      if (event.isTrusted) markInput(event);
    }, { capture: true, passive: true });
  }
  // Where the pointer last stood: a pointerover at the same point is the page
  // moving under a pointer that stayed, which the browser reports as the
  // pointer arriving. That hover is the moving scroll's, and takes its root.
  let pointerAt: { x: number; y: number } | undefined;
  const stayed = (event: any) => pointerAt !== undefined && event.clientX === pointerAt.x && event.clientY === pointerAt.y;
  listen(g, 'pointermove', (event: any) => {
    if (!event.isTrusted) return;
    const still = stayed(event);
    pointerAt = { x: event.clientX, y: event.clientY };
    if (event.buttons && !still) lastInput = mark('input', 'drag', { scrolls: true });
  }, { capture: true, passive: true });
  // An element the pointer leaves loses its hover by the same cause as the
  // element it arrives on: the pointerover that follows names it.
  const leaving: any[] = [];
  const unhovered = new WeakMap<object, { words: string; root?: Root }>();
  listen(g, 'pointerout', (event: any) => {
    if (event.isTrusted && event.pointerType === 'mouse' && event.target) leaving.push(event.target);
  }, { capture: true, passive: true });
  listen(g, 'pointerover', (event: any) => {
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    const scrolledUnder = stayed(event) ? lastScroll?.root : undefined;
    pointerAt = { x: event.clientX, y: event.clientY };
    lastHover = mark('pointer', scrolledUnder ? `${lastScroll!.words} · hover` : 'hover', scrolledUnder ? { root: scrolledUnder } : {});
    if (!scrolledUnder) holdThroughTask(lastHover.root);
    for (const left of leaving.splice(0)) unhovered.set(left, { words: `${lastHover.words} left`, ...(lastHover.root ? { root: lastHover.root } : {}) });
  }, { capture: true, passive: true });
  for (const type of ['transitionend', 'animationend']) {
    listen(g, type, (event: any) => {
      const root = started.get(event.target)?.get(event.propertyName || event.animationName)?.root;
      mark('chain', `end of ${event.propertyName || event.animationName} on ${nameOf(event.target)}`, root ? { root } : {});
    }, { capture: true, passive: true });
  }
  listen(g, 'hashchange', () => { lastHash = mark('scroll-cause', `#${String(g.location.hash).slice(1)}`); }, { capture: true });
  listen(g, 'DOMContentLoaded', () => mark('load', 'page load'), { capture: true });
  listen(g, 'load', () => { loadedAt = now(); mark('load', 'page load'); }, { capture: true });

  /** What moved the page this scroll: the person's input, a script's call, a link to an anchor, or the browser. */
  const scrollCause = (): string => scrollCauseMark()?.words ?? 'browser';
  const scrollCauseMark = (): Mark | undefined => {
    const t = now();
    // The newest wins: a key whose handler calls scrollIntoView() reads as the call, which carries the key.
    const candidates = [
      lastInput && t - lastInput.at <= 150 ? lastInput : undefined,
      lastScrollCall && t - lastScrollCall.at <= SCROLL_CALL_MS ? lastScrollCall : undefined,
      lastHash && t - lastHash.at <= SCROLL_CALL_MS ? lastHash : undefined,
    ].filter((one): one is Mark => one !== undefined);
    if (candidates.length === 0) return undefined;
    // A call made in the input's own handler can share its timestamp; the call, listed later, is the newer.
    return candidates.reduce((newest, one) => (one.at >= newest.at ? one : newest));
  };
  listen(g, 'scroll', () => {
    const cause = scrollCauseMark();
    lastScroll = mark('scroll', `scroll · ${cause?.words ?? 'browser'}`, cause?.root ? { root: cause.root } : {});
  }, { capture: true, passive: true });

  /** Wrap a function so each call marks first, as `words`, with what was live when it was called. */
  const calls = (owner: any, method: string, kind: string, words: string, after?: (made: Mark) => void, outstanding?: (root: Root, result: any, before: any) => void, prepare?: (self: any, args: unknown[]) => any) => {
    const original = owner && owner[method];
    if (typeof original !== 'function') return;
    const wrapper = function (this: any, ...args: unknown[]) {
      if (quiet) return original.apply(this, args);
      const under = current(false);
      const root = liveRoot();
      const made = mark(kind, under !== undefined ? `${under} · ${words}` : words, { method, fn: running, site: siteOf(wrapper), ...(root ? { root } : {}) });
      after?.(made);
      let before: any;
      try { before = prepare?.(this, args); } catch { /* a target the page cannot measure */ }
      const result = original.apply(this, args);
      if (root) outstanding?.(root, result, before);
      return result;
    };
    owner[method] = wrapper;
  };
  // A smooth scroll runs after the call returns, with no callback of the
  // page's, and a scroll still running from an earlier input fires its own
  // scrollend when the call interrupts it. So a call's root is held until a
  // scrollend finds the scroller where the call sent it: the target its
  // arguments name, or for scrollIntoView the one its element's place and
  // alignment give. A later scroll call or a scrolling input supersedes the
  // hold and releases it; a call to where the scroller stands holds nothing.
  // A target the page's own rules move - scroll-padding, a sticky offset -
  // stands open until superseded, and its step reads as still arriving.
  type ScrollTarget = { scroller: any; top?: number; left?: number };
  const scrollHolds = new Map<string, { root: Root; target: ScrollTarget }>();
  const releaseScrollHolds = () => {
    for (const [id, held] of [...scrollHolds]) { scrollHolds.delete(id); release(held.root); }
  };
  const reached = (target: ScrollTarget): boolean => {
    const { scroller } = target;
    const top = Number(scroller?.scrollTop ?? 0);
    const left = Number(scroller?.scrollLeft ?? 0);
    const maxTop = Math.max(0, Number(scroller?.scrollHeight ?? 0) - Number(scroller?.clientHeight ?? 0));
    const maxLeft = Math.max(0, Number(scroller?.scrollWidth ?? 0) - Number(scroller?.clientWidth ?? 0));
    const near = (at: number, want: number | undefined, max: number) => want === undefined || Math.abs(at - Math.min(Math.max(want, 0), max)) <= 2;
    return near(top, target.top, maxTop) && near(left, target.left, maxLeft);
  };
  const scrollTargetOf = (method: string) => (self: any, args: unknown[]): ScrollTarget | undefined => {
    const docScroller = g.document.scrollingElement ?? g.document.documentElement;
    const windowCall = self === g || self === undefined;
    if (method === 'scrollIntoView') {
      const rect = self.getBoundingClientRect();
      const view = Number(docScroller.clientHeight ?? g.innerHeight);
      const at = Number(docScroller.scrollTop ?? 0);
      const options: any = args[0];
      const block = options === false ? 'end' : (options && typeof options === 'object' && options.block) || 'start';
      const top = block === 'center' ? at + rect.top + rect.height / 2 - view / 2
        : block === 'end' ? at + rect.bottom - view
        : block === 'nearest' ? (rect.top >= 0 && rect.bottom <= view ? at : rect.top < 0 ? at + rect.top : at + rect.bottom - view)
        : at + rect.top;
      return { scroller: docScroller, top };
    }
    const scroller = windowCall ? docScroller : self;
    const at = { top: Number(scroller.scrollTop ?? 0), left: Number(scroller.scrollLeft ?? 0) };
    const given: any = args[0];
    const asked = given && typeof given === 'object' ? { top: given.top, left: given.left } : { left: given, top: args[1] };
    const by = method === 'scrollBy';
    const axis = (value: any, from: number) => (typeof value === 'number' ? (by ? from + value : value) : undefined);
    return { scroller, top: axis(asked.top, at.top), left: axis(asked.left, at.left) };
  };
  const untilScrollEnds = (root: Root, _result: unknown, target: ScrollTarget | undefined) => {
    releaseScrollHolds();
    if (!target || reached(target)) return;
    hold(root);
    scrollHolds.set(root.id, { root, target });
  };
  listen(g, 'scrollend', () => {
    for (const [id, held] of [...scrollHolds]) {
      if (!reached(held.target)) continue;
      scrollHolds.delete(id);
      release(held.root);
    }
  }, { capture: true, passive: true });
  // A media element plays from its play() promise; an SVG animation begins on
  // the frame after beginElement(): each call's root is held until then.
  const untilSettled = (root: Root, result: any) => {
    if (!result || typeof result.then !== 'function') return;
    hold(root);
    result.then(() => nextTask(() => release(root)), () => release(root));
  };
  const throughFrame = (root: Root) => {
    hold(root);
    if (unwrappedFrame) unwrappedFrame(() => nextTask(() => release(root))); else nextTask(() => release(root));
  };
  // The global's own methods stand on the window itself, where a bare
  // `scrollTo()` finds them, not on Window.prototype.
  for (const [owner, method] of [[g, 'scrollTo'], [g, 'scrollBy'], [g, 'scroll'],
    [g.Element?.prototype, 'scrollIntoView'], [g.Element?.prototype, 'scrollTo'], [g.Element?.prototype, 'scrollBy']] as Array<[any, string]>) {
    calls(owner, method, 'scroll-cause', `${method}()`, made => { lastScrollCall = made; }, untilScrollEnds, scrollTargetOf(method));
  }
  for (const property of ['scrollTop', 'scrollLeft']) {
    const described = g.Element && Object.getOwnPropertyDescriptor(g.Element.prototype, property);
    if (!described?.set) continue;
    const set = function (this: any, value: unknown) {
      if (quiet) { described.set!.call(this, value); return; }
      const under = current(false);
      const root = liveRoot();
      lastScrollCall = mark('scroll-cause', under !== undefined ? `${under} · ${property} =` : `${property} =`, { method: property, fn: running, site: siteOf(set), ...(root ? { root } : {}) });
      described.set!.call(this, value);
    };
    Object.defineProperty(g.Element.prototype, property, { ...described, set });
  }
  // A media element and an SVG animation start on their own events, a task
  // after the call; the call is kept for those events to find.
  const called: Mark[] = [];
  const keep = (made: Mark) => { called.push(made); if (called.length > 8) called.shift(); };
  for (const method of ['play', 'pause']) calls(g.HTMLMediaElement?.prototype, method, 'media', `${method}()`, keep, method === 'play' ? untilSettled : throughFrame);
  for (const method of ['beginElement', 'beginElementAt']) calls(g.SVGAnimationElement?.prototype, method, 'media', `${method}()`, keep, throughFrame);

  // An observer's callback is the cause of what it changes: an element coming
  // into view, mostly by a scroll, or an element resized.
  for (const [name, words] of [['IntersectionObserver', 'in view'], ['ResizeObserver', 'resize']]) {
    const Original = g[name];
    if (typeof Original !== 'function') continue;
    const Wrapped = function (this: any, callback: any, ...rest: unknown[]) {
      return new Original(function (this: any, ...given: unknown[]) {
        runAs(callback);
        const after = lastScroll && now() - lastScroll.at <= AFTER_MS ? lastScroll : undefined;
        mark('observer', `${after ? `${after.words} · ` : ''}${words}`, after?.root ? { root: after.root } : {});
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
      // The reply carries the root of the work that asked for it.
      const root = liveRoot();
      hold(root);
      return fetched.apply(this, [resource, init]).then((response: any) => {
        mark('reply', `reply ${method} ${pathOf(url)}`, root ? { root } : {});
        if (root && response) {
          bodyRoot.set(response, { root, words: `reply ${method} ${pathOf(url)}` });
          if (response.body) bodyRoot.set(response.body, { root, words: `reply ${method} ${pathOf(url)}` });
        }
        // Released after this job, so the app's continuation runs under the open root.
        nextTask(() => release(root));
        return response;
      }, (error: unknown) => { release(root); throw error; });
    };
  }
  // A body read in chunks or whole resolves in a promise job the reply's own
  // mark is no longer live in: each read marks the reply again with the root
  // of the fetch that asked for it, ahead of the app's continuation.
  const bodyRoot = new WeakMap<object, { root: Root; words: string }>();
  const markBody = <T>(owner: any, read: Promise<T>): Promise<T> => {
    const body = bodyRoot.get(owner);
    if (!body || !read || typeof read.then !== 'function') return read;
    hold(body.root);
    return read.then(value => {
      mark('reply', body.words, { root: body.root });
      nextTask(() => release(body.root));
      return value;
    }, (error: unknown) => { release(body.root); throw error; });
  };
  const Stream = g.ReadableStream?.prototype;
  if (Stream && typeof Stream.getReader === 'function') {
    const getReader = Stream.getReader;
    Stream.getReader = function (this: any, ...args: unknown[]) {
      const reader = getReader.apply(this, args);
      const body = bodyRoot.get(this);
      if (body && reader) bodyRoot.set(reader, body);
      return reader;
    };
  }
  const Reader = g.ReadableStreamDefaultReader?.prototype;
  if (Reader && typeof Reader.read === 'function') {
    const read = Reader.read;
    Reader.read = function (this: any, ...args: unknown[]) { return markBody(this, read.apply(this, args)); };
  }
  const Response = g.Response?.prototype;
  for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData']) {
    const original = Response && Response[method];
    if (typeof original !== 'function') continue;
    Response[method] = function (this: any, ...args: unknown[]) { return markBody(this, original.apply(this, args)); };
  }
  const Xhr = g.XMLHttpRequest;
  if (typeof Xhr === 'function') {
    const open = Xhr.prototype.open;
    Xhr.prototype.open = function (this: any, method: string, url: string, ...rest: unknown[]) {
      // Added at open, ahead of a handler the app adds before send.
      const root = liveRoot();
      hold(root);
      listen(this, 'loadend', () => nextTask(() => release(root)));
      listen(this, 'readystatechange', () => { if (this.readyState === 4) mark('reply', `reply ${String(method).toUpperCase()} ${pathOf(url)}`, root ? { root } : {}); });
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
      const family = method === 'requestAnimationFrame' ? 'frame' : 'timer';
      const fn = callback[CALLBACK] ?? callback;
      const root = origin !== undefined ? under?.root : undefined;
      // Released after the callback returns, so one that schedules its next
      // keeps its root open across the gap.
      const id = original.apply(this, [function (this: any, ...given: unknown[]) {
        if (method !== 'setInterval') pending.delete(`${family}:${id}`);
        runAs(fn);
        mark(family, carried, origin !== undefined ? { origin, ...(root ? { root } : {}) } : {});
        try { return callback.apply(this, given); } finally { if (method !== 'setInterval') release(root); }
      }, ...args]);
      pending.set(`${family}:${id}`, { fn, root });
      hold(root);
      return id;
    };
  };
  // A frame loop or timer cancelled ends the motion its callback drew: the
  // cancel's cause, root included, is held against that callback, so the end
  // stands under the input that cancelled it rather than the one that began it.
  const pending = new Map<string, { fn: any; root?: Root }>();
  const cancels = new WeakMap<object, { trigger: string; root?: Root; at: number; maker: Record<string, unknown>; held?: true }>();
  const cancelling = (method: string, family: string) => {
    const original = g[method];
    if (typeof original !== 'function') return;
    g[method] = function (this: any, id: unknown, ...args: unknown[]) {
      const scheduled = pending.get(`${family}:${id}`);
      if (scheduled) {
        pending.delete(`${family}:${id}`);
        const under = current();
        const root = liveRoot();
        // A loop drawing a motion run ends it at the run's close: the
        // cancelling root stays open until that stop is reported.
        const drawing = g[Symbol.for('devharness.motion')]?.drawing?.(scheduled.fn) === true;
        if (drawing) hold(root);
        cancels.set(scheduled.fn, { trigger: under !== undefined ? `${under} · ${method}()` : `${method}()`, at: now(), maker: made('JS', running), ...(root ? { root } : {}), ...(drawing && root ? { held: true } : {}) });
        release(scheduled.root);
      }
      return original.apply(this, [id, ...args]);
    };
  };
  scheduled('setTimeout', args => `timer ${Math.round(Number(args[0]) || 0)}ms`);
  scheduled('setInterval', args => `every ${Math.round(Number(args[0]) || 0)}ms`);
  scheduled('requestAnimationFrame', () => 'frame loop');
  cancelling('clearTimeout', 'timer');
  cancelling('clearInterval', 'timer');
  cancelling('cancelAnimationFrame', 'frame');

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
  const animatedRoot = new WeakMap<object, Root>();
  const animate = g.Element?.prototype?.animate;
  if (typeof animate === 'function') {
    const wrapper = function (this: any, ...args: unknown[]) {
      const made = animate.apply(this, args);
      const words = current();
      if (words) byAnimation.set(made, words);
      if (running) animatedBy.set(made, running);
      const site = siteOf(wrapper);
      if (site) animatedAt.set(made, site);
      const root = liveRoot();
      if (root) animatedRoot.set(made, root);
      // Its end starts what the app chains on it: the reaction is added here
      // first, so it marks before the app's own `finished` reaction runs.
      const ended = () => mark('chain', `end of ${made.id || 'animation'} on ${nameOf(this)}`, root ? { root } : {});
      hold(root);
      // Released after the app's own reaction to the end has run in this job.
      made.finished?.then(() => { ended(); nextTask(() => release(root)); }, () => release(root));
      return made;
    };
    g.Element.prototype.animate = wrapper;
  }

  // A transition or keyframe animation starts at the style recalc after the
  // change that set it off, outside any task: the change's trigger is kept.
  interface Change { words: string; at: number; root?: Root }
  const changed = new WeakMap<object, Change>();
  if (typeof g.MutationObserver === 'function') {
    const observer = new g.MutationObserver((records: any[]) => {
      const words = current();
      if (!words) return;
      const at = now();
      const root = liveRoot();
      const change: Change = { words, at, ...(root ? { root } : {}) };
      for (const record of records) {
        changed.set(record.target, change);
        for (const node of record.addedNodes ?? []) changed.set(node, change);
      }
    });
    const watch = () => observer.observe(g.document, { subtree: true, attributes: true, childList: true });
    if (g.document.documentElement) watch(); else listen(g.document, 'readystatechange', watch, { once: true });
  }
  /** What set an element going: the newest change on it or an ancestor, else a hover, else the work running now. */
  const causeOfElement = (target: any): { words?: string; root?: Root } => {
    const t = now();
    let newest: Change | undefined;
    for (let node = target; node; node = node.parentNode ?? node.host) {
      const change = changed.get(node);
      if (change && t - change.at <= CHANGE_MS && (!newest || change.at > newest.at)) newest = change;
    }
    if (newest) return newest;
    try { if (target && target.matches && target.matches(':hover')) return { words: lastHover?.words ?? 'hover', root: lastHover?.root }; } catch { /* a node with no matches */ }
    for (let node = target; node; node = node.parentNode ?? node.host) {
      const left = unhovered.get(node);
      if (left) return left;
    }
    return { words: current(), root: liveRoot() };
  };
  const ofElement = (target: any): string | undefined => causeOfElement(target).words;
  const started = new WeakMap<object, Map<string, { words: string; root?: Root }>>();
  for (const type of ['transitionrun', 'animationstart']) {
    listen(g, type, (event: any) => {
      const cause = causeOfElement(event.target);
      if (!cause.words) return;
      const named = started.get(event.target) ?? new Map<string, { words: string; root?: Root }>();
      const name = event.propertyName || event.animationName;
      if (named.get(name)?.root) release(named.get(name)!.root);
      named.set(name, { words: cause.words, ...(cause.root ? { root: cause.root } : {}) });
      started.set(event.target, named);
      hold(cause.root);
    }, { capture: true, passive: true });
  }
  // A transition or keyframe animation ending or cancelled releases its root once.
  for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) {
    listen(g, type, (event: any) => {
      const named = started.get(event.target);
      const name = event.propertyName || event.animationName;
      const begun = named?.get(name);
      if (!begun?.root) return;
      named!.set(name, { words: begun.words });
      nextTask(() => release(begun.root));
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
    /**
     * Mark the scroll devharness makes next, over CDP or by a call, as `words`:
     * it is the harness's, not the app's. Under a step, `step` roots it there,
     * so what the scroll sets going is credited to the step that made it.
     */
    ownScroll(words: string, step?: string): void { lastScrollCall = mark('scroll-cause', words, { harness: true, root: harnessRoot(step) }); },
    /** Run devharness's own call as `words`, rooted under `step` as `ownScroll` is: a scroll it makes is the harness's, not the app's. */
    quietly<T>(run: () => T, words = 'devharness', step?: string): T {
      lastScrollCall = mark('scroll-cause', words, { harness: true, root: harnessRoot(step) });
      quiet = true;
      try { return run(); } finally { quiet = false; }
    },
    /** What reveals the app's work running now: a JS motion begun in it points at the function. */
    runningMaker: () => made('JS', running),
    /** Count work outstanding under a root: a motion run opened under it. */
    hold,
    /** End one piece of outstanding work under a root: a motion run closed. */
    release,
    /** The app's callback running now, the loop a motion begun in it is drawn by. */
    runningCallback: () => running,
    /** How the loop drawn by `fn` was cancelled at or after `since`: the cancel's trigger, maker and root. */
    cancelOf(fn: any, since: number) {
      const cancel = fn ? cancels.get(fn) : undefined;
      return cancel && cancel.at >= since ? cancel : undefined;
    },
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
      return (target && name && started.get(target)?.get(name)?.words) ?? (target ? ofElement(target) : undefined);
    },
    /** What called one of `methods` within the last second, newest first, else `fallback`. */
    ofCall(methods: string[], fallback: string): string {
      const t = now();
      const call = [...called].reverse().find(one => one.method !== undefined && methods.includes(one.method) && t - one.at <= 1000);
      return call ? call.words : fallback;
    },
    scrollCause,
    /** Set by devharness around a driven input's dispatch, so the input's root names its step; undefined clears it. */
    drive(step: string | undefined): void { drivenBy = step; },
    /** The root of the work running now. */
    rootNow: (): Root | undefined => liveRoot(),
    /** The root of a trusted input event, for the person watch to report with it; marked here when its listener runs first. */
    rootOfEvent(event: any): Root | undefined {
      return event && event.isTrusted && INPUT[event.type] ? markInput(event).root : undefined;
    },
    /** The root of what started an Animation object: its call's, else the change that set its element going. */
    rootOfAnimation(animation: any): Root | undefined {
      const made = animatedRoot.get(animation);
      if (made) return made;
      const target = animation && animation.effect && animation.effect.target;
      const name = animation && (animation.transitionProperty || animation.animationName);
      return (target && name && started.get(target)?.get(name)?.root) ?? (target ? causeOfElement(target).root : undefined);
    },
    /** The root of this scroll's cause. */
    rootOfScroll: (): Root | undefined => scrollCauseMark()?.root,
    /** The root of the newest call of one of `methods` within the last second. */
    rootOfCall(methods: string[]): Root | undefined {
      const t = now();
      return [...called].reverse().find(one => one.method !== undefined && methods.includes(one.method) && t - one.at <= 1000)?.root;
    },
  };
}

/** The trigger tracker as page source, run after the clock and before the app's first script. */
export const PAGE_TRIGGER_SOURCE = `(${installPageTrigger.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
