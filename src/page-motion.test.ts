import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { MOTION_BINDING, MOTION_KEY, PAGE_MOTION_SOURCE, type MotionReport } from './page-motion.js';
import { AnimationRecord } from './animation-record.js';
import { motionOf } from './write-watch.js';
import { markedNow } from './proxy/cause-timeline.js';

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
  return { page, motion, writeStyle, writeClass, fire, advance, setRate, setTrigger, scrollTo, fireWindow, reports, Context2D };
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
  it('stays one motion past the quiet time, and closes at its scrollend', () => {
    const { motion, advance, scrollTo, fireWindow, reports } = pageWithMotion();
    motion.start();
    for (const y of [100, 200, 300]) { scrollTo(y); advance(16); }
    advance(313);
    for (const y of [2000, 3000, 3298]) { scrollTo(y); advance(16); }

    expect(reports.map(r => r.phase)).toEqual(['open']);
    fireWindow('scrollend');
    expect(reports.map(r => r.phase)).toEqual(['open', 'close']);
    expect(reports[1]).toMatchObject({ source: 'scroll', property: 'scrollY', from: '0', to: '3298', frames: 6 });
  });

  it("keeps what the page's scroll handler writes in one motion with the scroll, closed at the same scrollend", () => {
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
    expect(reports.filter(r => r.phase === 'close')).toMatchObject([{ property: 'transform', to: 'translateY(1319px)', frames: 2 }]);
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

describe('a motion report in the page\'s record', () => {
  it('keeps the page-time length for the row and the wall-time length for where it ended', () => {
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 4, doc: 'd', phase: 'close', source: 'scroll', element: 'html', property: 'scrollY', from: '3298', to: '0', startMs: 1000, endMs: 4584, pageStartMs: 1000, pageEndMs: 1896, frames: 203, sentMs: 4704 }, 60_000);

    const [entry] = record.list();
    expect(entry.read).toMatchObject({ duration: 896, wallDuration: 3584 });
    expect(motionOf(entry.read!)).toMatchObject({ durationMs: 896, wallMs: 3584 });
  });

  it('stands as an ended entry of its kind, with its change for the row', () => {
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 1, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '0px', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 50_000);

    const [entry] = record.list();
    expect(entry).toMatchObject({ kind: 'height #acc-body', via: 'motion', gone: 'finished', createdAt: 49_580 });
    expect(entry.read).toMatchObject({ type: 'StyleWrites', duration: 300, from: '0px', to: '58px', frames: 19 });
    expect(record.live()).toHaveLength(0);
  });

  it('stands from its open report, under the step it began in, and its close fills in the same entry', () => {
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 29 }, 300_000);
    const record = new AnimationRecord('conn');
    const changes: string[] = [];
    record.watch((_, change) => changes.push(change));
    record.takeMotion({ id: 7, doc: 'd', phase: 'open', source: 'style', element: '#acc-body', property: 'height', from: '', to: '4px', startMs: 1000, endMs: 1000, pageStartMs: 1000, pageEndMs: 1000, frames: 1, sentMs: 1000 }, 300_016);

    expect(record.live()).toHaveLength(1);
    expect(record.list()[0]).toMatchObject({ createdIn: { entry: 29 }, read: { playState: 'running' } });

    markedNow(undefined, 300_200);
    record.takeMotion({ id: 7, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 300_436);

    expect(record.list()).toHaveLength(1);
    expect(record.list()[0]).toMatchObject({ createdIn: { entry: 29 }, gone: 'finished', read: { duration: 300, to: '58px', frames: 19, playState: 'finished' } });
    expect(changes).toEqual(['added', 'updated']);
  });
});

describe('a motion a later step stopped', () => {
  it('carries the step it ended in beside the step it began in', () => {
    markedNow({ kind: 'command', index: 9 }, 100_000);
    markedNow({ kind: 'command', index: 11 }, 100_900);
    const record = new AnimationRecord('conn');
    // Played at page 1000 under #9, paused at page 1900 under #11, reported at 1910.
    record.takeMotion({ id: 2, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.900', startMs: 1000, endMs: 1900, pageStartMs: 1000, pageEndMs: 1900, frames: 0, sentMs: 1910 }, 100_910);

    const [entry] = record.list();
    expect(entry.createdIn).toMatchObject({ index: 9 });
    expect(entry.endedIn).toMatchObject({ index: 11 });
    expect(entry.endedAt).toBe(100_900);
  });
});

describe('a motion that ends under the step it began in', () => {
  it('carries no end of its own, however many cursors that step stood under', () => {
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 3 }, 200_000);
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 3 }, 200_100);
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 3, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 200_500);

    expect(record.list()[0].endedIn).toBeUndefined();
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

describe('a stop placed by its cause, not by when its report arrived', () => {
  it('ends under the step whose call stopped it, though by time it falls in the step before', () => {
    markedNow({ kind: 'command', index: 9 }, 400_000);
    markedNow({ kind: 'command', index: 11 }, 400_900);
    const record = new AnimationRecord('conn');
    // Paused 2ms into #11 by the page's clock, which runs behind: by time the pause lands in #9.
    record.takeMotion({ id: 4, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.050', startMs: 1000, endMs: 1050, pageStartMs: 1000, pageEndMs: 1050, frames: 0, sentMs: 1051,
      root: { id: 'p:9', step: JSON.stringify({ kind: 'command', index: 9 }) },
      stoppedBy: { maker: 'MEDIA', trigger: 'key [ · pause()', root: { id: 'p:11', step: JSON.stringify({ kind: 'command', index: 11 }) } } }, 400_051);

    expect(record.list()[0].endedIn).toMatchObject({ index: 11 });
  });

  it('adds no end where the motion ended by itself under its own root, however late the step after began', () => {
    markedNow({ kind: 'command', index: 20 }, 500_000);
    markedNow({ kind: 'command', index: 21 }, 500_100);
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 5, doc: 'd', phase: 'close', source: 'text', element: '#counter', property: 'text', from: '0', to: '1248', startMs: 1000, endMs: 1624, pageStartMs: 1000, pageEndMs: 1624, frames: 39, sentMs: 1625,
      root: { id: 'p:20', step: JSON.stringify({ kind: 'command', index: 20 }) } }, 500_625);

    expect(record.list()[0].endedIn).toBeUndefined();
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
