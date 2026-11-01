import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { MOTION_BINDING, MOTION_KEY, PAGE_MOTION_SOURCE, type MotionReport } from './page-motion.js';

/**
 * A page with a clock of its own: page time and wall time moved by hand, page
 * time at `rate` of wall time, the native timers run on wall time by hand,
 * mutations and window events fed by hand.
 */
function pageWithMotion() {
  let pageNow = 1000;
  let wallNow = 1000;
  let rate = 1;
  let trigger: string | undefined;
  let observerCallback: ((records: any[]) => void) | undefined;
  const timers: Array<{ at: number; run: () => void }> = [];
  const reports: MotionReport[] = [];
  class Context2D { canvas: any; constructor(canvas: any) { this.canvas = canvas; } fillRect() {} }
  /** An Animation whose updatePlaybackRate() and reverse() leave the rate pending, as the browser's do until the next frame. */
  class Animation {
    playState = 'running';
    effect = { target: { id: 'ring-arc' } };
    rate = 1;
    pending: number | undefined;
    get playbackRate() { return this.rate; }
    set playbackRate(value: number) { this.rate = value; this.pending = undefined; }
    pause() { this.playState = 'paused'; }
    play() { this.playState = 'running'; }
    updatePlaybackRate(value: number) { this.pending = value; }
    reverse() { this.pending = -(this.pending ?? this.rate); }
  }
  const documentListeners = new Map<string, (event: any) => void>();
  const windowListeners = new Map<string, (event: any) => void>();
  const page: any = {
    document: { addEventListener: (type: string, fn: (event: any) => void) => { documentListeners.set(type, fn); }, removeEventListener: () => {}, documentElement: { tagName: 'HTML' } },
    performance: { now: () => pageNow },
    scrollX: 0, scrollY: 0,
    addEventListener: (type: string, fn: (event: any) => void) => { windowListeners.set(type, fn); }, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    MutationObserver: class { constructor(callback: (records: any[]) => void) { observerCallback = callback; } observe() {} disconnect() {} },
    CanvasRenderingContext2D: Context2D,
    Animation,
    [MOTION_BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  page[Symbol.for('devharness.clock')] = { native: { perfNow: () => wallNow, setTimeout: (run: () => void, ms: number) => { timers.push({ at: wallNow + ms, run }); return timers.length; }, clearTimeout: () => {} } };
  page[Symbol.for('devharness.trigger')] = { current: () => trigger, scrollCause: () => trigger };
  page[Symbol.for('devharness.animations')] = { name: (element: any) => element?.id ? `#${element.id}` : 'div' };
  vm.createContext(page);
  vm.runInContext(PAGE_MOTION_SOURCE, page);
  const motion = vm.runInContext(`globalThis[Symbol.for('${MOTION_KEY}')]`, page);
  const element = { id: 'acc-body', attrs: { style: '' } as Record<string, string>, getAttribute(name: string) { return this.attrs[name] ?? null; } };
  const writeStyle = (style: string) => {
    const oldValue = element.attrs.style;
    element.attrs.style = style;
    observerCallback?.([{ type: 'attributes', attributeName: 'style', target: element, oldValue }]);
  };
  /** Move wall time on, and page time at its rate, and run the native timers that come due, as the browser would. */
  const advance = (ms: number) => {
    wallNow += ms;
    pageNow += ms * rate;
    for (let due = timers.findIndex(t => t.at <= wallNow); due >= 0; due = timers.findIndex(t => t.at <= wallNow)) timers.splice(due, 1)[0].run();
  };
  /** Run page time at this multiple of wall time, as hold rate does. */
  const setRate = (value: number) => { rate = value; };
  /** What the page's trigger tracker reads as the cause of what runs now. */
  const setTrigger = (words: string | undefined) => { trigger = words; };
  /** Scroll the page to `y` and fire its scroll event, as the browser does each frame of a scroll. */
  const scrollTo = (y: number) => { page.scrollY = y; windowListeners.get('scroll')?.({ type: 'scroll' }); };
  /** Fire the window event of this type, as the browser does. */
  const fireWindow = (type: string) => windowListeners.get(type)?.({ type });
  /** Set an element's class attribute, as the page's code does. */
  const writeClass = (target: { attrs: Record<string, string> }, className: string) => {
    const oldValue = target.attrs.class ?? '';
    target.attrs.class = className;
    observerCallback?.([{ type: 'attributes', attributeName: 'class', target, oldValue }]);
  };
  /** Dispatch an event the page's document hears in its capture phase. */
  const fire = (type: string, event: any) => documentListeners.get(type)?.({ type, ...event });
  page.document.scrollingElement = { id: 'page', tagName: 'HTML' };
  return { page, motion, writeStyle, writeClass, fire, advance, setRate, setTrigger, scrollTo, fireWindow, reports, Context2D, run: (source: string) => vm.runInContext(source, page) };
}

describe('the page\'s watch of motion with no Animation object', () => {
  it('reads a frame loop\'s style writes as one motion, from its first value to its last', () => {
    const { motion, writeStyle, advance, reports } = pageWithMotion();
    motion.start();
    for (const px of [4, 20, 40, 58]) { writeStyle(`height: ${px}px;`); advance(16); }
    advance(200);

    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[0]).toMatchObject({ source: 'style', element: '#acc-body', property: 'height', from: '', to: '4px', frames: 1 });
    expect(reports[1]).toMatchObject({ id: reports[0].id, source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', frames: 4 });
    expect(reports[1].endMs - reports[1].startMs).toBe(48);
  });

  it('starts a new motion after a pause longer than its quiet time', () => {
    const { motion, writeStyle, advance, reports } = pageWithMotion();
    motion.start();
    writeStyle('height: 10px;');
    advance(300);
    writeStyle('height: 0px;');
    advance(300);

    expect(reports.filter(r => r.phase === 'close').map(r => r.to)).toEqual(['10px', '0px']);
  });

  it('counts a canvas\'s drawing frames, and watches nothing before it starts', () => {
    const { motion, advance, reports, Context2D } = pageWithMotion();
    const context = new Context2D({ id: 'sky' });
    context.fillRect();
    advance(200);
    expect(reports).toHaveLength(0);

    motion.start();
    for (let frame = 0; frame < 3; frame++) { context.fillRect(); context.fillRect(); advance(16); }
    advance(200);

    expect(reports.filter(r => r.phase === 'close')).toHaveLength(1);
    expect(reports[1]).toMatchObject({ phase: 'close', source: 'canvas', element: '#sky', frames: 3 });
  });
});

describe('a class change that starts no animation', () => {
  const row = (child?: object) => ({ id: 'row', attrs: { class: 'row' } as Record<string, string>, getAttribute(name: string) { return this.attrs[name] ?? null; }, contains: (node: object) => node === child });

  it('reads as one change with the classes it added, once no run event has come for it', () => {
    const { motion, writeClass, advance, reports } = pageWithMotion();
    motion.start();
    writeClass(row(), 'row removing');
    advance(0);

    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[1]).toMatchObject({ source: 'class', element: '#row', property: 'class', from: 'row', to: '+removing', frames: 1 });
  });

  it('reads as nothing where it started a transition on the element or inside it', () => {
    const { motion, writeClass, fire, advance, reports } = pageWithMotion();
    motion.start();
    const item = {};
    writeClass(row(item), 'row open');
    fire('transitionrun', { target: item });
    advance(0);

    expect(reports).toHaveLength(0);
  });
});

describe('a class change whose animations report no run event inside two frames', () => {
  const modal = (animations: object[]) => ({ id: 'modal', attrs: { class: '' } as Record<string, string>, getAttribute(name: string) { return this.attrs[name] ?? null; }, contains: () => false, getAnimations: () => animations });

  it('reads as nothing where the element lists an animation still pending, or started since the change', () => {
    const { page, motion, writeClass, advance, reports } = pageWithMotion();
    page.document.timeline = { currentTime: 1000 };
    motion.start();
    writeClass(modal([{ startTime: null }]), 'open');
    writeClass(modal([{ startTime: 1016 }]), 'open');
    advance(0);

    expect(reports).toHaveLength(0);
  });

  it('reads as changed with no motion where the only animation it lists began before the change', () => {
    const { page, motion, writeClass, advance, reports } = pageWithMotion();
    page.document.timeline = { currentTime: 1000 };
    motion.start();
    writeClass(modal([{ startTime: 400 }]), 'open');
    advance(0);

    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[1]).toMatchObject({ source: 'class', element: '#modal', to: '+open' });
  });
});

describe('a motion on a page slowed by rate', () => {
  it('counts its frames on wall time and gives its length in page time', () => {
    const { motion, writeStyle, advance, setRate, reports } = pageWithMotion();
    setRate(0.25);
    motion.start();
    for (let px = 1; px <= 8; px++) { writeStyle(`height: ${px * 8}px;`); advance(16); }
    advance(800);

    const close = reports.find(r => r.phase === 'close')!;
    expect(close.frames).toBe(8);
    expect(close.endMs - close.startMs).toBe(112);
    expect(close.pageEndMs - close.pageStartMs).toBe(28);
  });
});

describe('a scroll whose events stall part-way', () => {
  it('stays one motion past the quiet time, and closes once the quiet time has passed after its scrollend', () => {
    const { motion, advance, scrollTo, fireWindow, reports } = pageWithMotion();
    motion.start();
    for (const y of [100, 200, 300]) { scrollTo(y); advance(16); }
    advance(313);
    for (const y of [2000, 3000, 3298]) { scrollTo(y); advance(16); }

    expect(reports.map(r => r.phase)).toEqual(['open']);
    fireWindow('scrollend');
    advance(240);
    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[1]).toMatchObject({ source: 'scroll', property: 'scrollY', from: '0', to: '3298', frames: 6 });
  });

  it("keeps what the page's scroll handler writes in one motion with the scroll, closed after the same scrollend", () => {
    const { motion, writeStyle, advance, setTrigger, fireWindow, reports } = pageWithMotion();
    motion.start();
    setTrigger('scroll · key . · scrollIntoView()');
    writeStyle('transform: translateY(40px);');
    advance(16);
    advance(313);
    writeStyle('transform: translateY(1319px);');
    advance(16);

    expect(reports.filter(r => r.phase === 'close')).toHaveLength(0);
    fireWindow('scrollend');
    advance(240);
    expect(reports.filter(r => r.phase === 'close')).toMatchObject([{ property: 'transform', to: 'translateY(1319px)', frames: 2 }]);
  });

  it('reads the ticks of one wheel scroll, each followed by its own scrollend, as one motion', () => {
    const { motion, advance, scrollTo, fireWindow, reports } = pageWithMotion();
    motion.start();
    for (const y of [400, 800, 1200, 1600, 2000]) { scrollTo(y); fireWindow('scrollend'); advance(16); }
    advance(240);

    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[1]).toMatchObject({ source: 'scroll', from: '0', to: '2000', frames: 5 });
  });

  it('closes a scroll that raises no scrollend once it has been still for a second', () => {
    const { motion, advance, scrollTo, reports } = pageWithMotion();
    motion.start();
    scrollTo(100);
    advance(16);
    advance(900);
    expect(reports.map(r => r.phase)).toEqual(['open']);
    advance(200);
    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
  });
});

describe('a call that changes a running animation\'s playback', () => {
  it('reads as one change each, from the playback it had to the one it leaves, a pending rate included', () => {
    const { motion, run, reports } = pageWithMotion();
    motion.start();
    run('globalThis.ring = new Animation(); ring.pause(); ring.play(); ring.updatePlaybackRate(4); ring.reverse();');

    const closes = reports.filter(r => r.phase === 'close');
    expect(closes.map(r => `${r.from} → ${r.to}`)).toEqual(['1× → paused', 'paused → 1×', '1× → 4×', '4× → -4×']);
    expect(closes[0]).toMatchObject({ source: 'playback', element: '#ring-arc', property: 'animation', frames: 1 });
  });

  it('reads as nothing while the watch is off, or where the call leaves the playback as it was', () => {
    const { motion, run, reports } = pageWithMotion();
    run('globalThis.ring = new Animation(); ring.pause();');
    motion.start();
    run('ring.pause();');

    expect(reports).toHaveLength(0);
  });
});

/** The page above with a trigger tracker standing in: what it holds open per root, and how a loop's cancel reads. */
function pageWithTracker() {
  const made = pageWithMotion();
  const held: Array<[string, string]> = [];
  const drawing = () => undefined;
  const cancel: { trigger: string; root?: { id: string; step?: string }; at: number; maker: Record<string, unknown>; held?: true } = {
    trigger: 'key - · cancelAnimationFrame()', root: { id: 'p:2', step: 'step-5' }, at: 0, maker: { maker: 'JS' }, held: true,
  };
  let cancelled = false;
  made.page[Symbol.for('devharness.trigger')] = {
    rootNow: () => ({ id: 'p:1', step: 'step-4' }),
    runningCallback: () => drawing,
    cancelOf: (fn: unknown) => (cancelled && fn === drawing ? cancel : undefined),
    hold: (root?: { id: string }) => root && held.push(['hold', root.id]),
    release: (root?: { id: string }) => root && held.push(['release', root.id]),
  };
  return { ...made, held, cancelNow: () => { cancelled = true; } };
}

describe('a motion run in the count of work outstanding under its root', () => {
  it('holds its root open from its open report until its close', () => {
    const { motion, writeStyle, advance, held } = pageWithTracker();
    motion.start();
    writeStyle('height: 4px;');
    expect(held).toEqual([['hold', 'p:1']]);
    advance(200);
    expect(held).toEqual([['hold', 'p:1'], ['release', 'p:1']]);
  });

  it('closes a loop a later input cancelled as stopped by that input, releasing the cancelling root once', () => {
    const { page, motion, advance, held, reports, Context2D, cancelNow } = pageWithTracker();
    motion.start();
    const sky = new Context2D({ id: 'sky' });
    sky.fillRect();
    sky.fillRect();
    expect(motion.drawing(page[Symbol.for('devharness.trigger')].runningCallback())).toBe(true);
    cancelNow();
    advance(200);

    expect(reports[1]).toMatchObject({ phase: 'close', stoppedBy: { trigger: 'key - · cancelAnimationFrame()', root: { id: 'p:2', step: 'step-5' } } });
    expect(held.filter(([, id]) => id === 'p:2')).toEqual([['release', 'p:2']]);
  });
});

describe('a run another step\'s input takes over', () => {
  it('splits where a root of a later step arrives, and stays one run across one step\'s inputs', () => {
    const { page, motion, writeStyle, advance, reports } = pageWithMotion();
    let root: { id: string; step?: string } = { id: 'p:3', step: 'step-14' };
    page[Symbol.for('devharness.trigger')] = { rootNow: () => root, hold: () => {}, release: () => {} };
    motion.start();
    writeStyle('height: 10px;'); advance(16);
    root = { id: 'p:4', step: 'step-14' };
    writeStyle('height: 20px;'); advance(16);
    root = { id: 'p:5', step: 'step-15' };
    writeStyle('height: 30px;'); advance(16);
    advance(200);

    const opened = reports.filter(r => r.phase === 'open');
    expect(opened.map(r => r.root?.id)).toEqual(['p:3', 'p:5']);
    expect(reports.filter(r => r.phase === 'close').map(r => [r.from, r.to])).toEqual([['', '20px'], ['20px', '30px']]);
  });
});
