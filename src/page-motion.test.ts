import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { MOTION_BINDING, MOTION_KEY, PAGE_MOTION_SOURCE, type MotionReport } from './page-motion.js';
import { AnimationRecord } from './animation-record.js';
import { markedNow } from './proxy/cause-timeline.js';

/** A page with a clock of its own: page time moved by hand, the native timers run by hand, mutations fed by hand. */
function pageWithMotion() {
  let pageNow = 1000;
  let observerCallback: ((records: any[]) => void) | undefined;
  const timers: Array<{ at: number; run: () => void }> = [];
  const reports: MotionReport[] = [];
  class Context2D { canvas: any; constructor(canvas: any) { this.canvas = canvas; } fillRect() {} }
  const page: any = {
    document: { addEventListener: () => {}, removeEventListener: () => {}, documentElement: { tagName: 'HTML' } },
    performance: { now: () => pageNow },
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    MutationObserver: class { constructor(callback: (records: any[]) => void) { observerCallback = callback; } observe() {} disconnect() {} },
    CanvasRenderingContext2D: Context2D,
    [MOTION_BINDING]: (payload: string) => reports.push(JSON.parse(payload)),
  };
  page[Symbol.for('devharness.clock')] = { native: { setTimeout: (run: () => void, ms: number) => { timers.push({ at: pageNow + ms, run }); return timers.length; }, clearTimeout: () => {} } };
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
  /** Move page time on and run the native timers that come due, as the browser would. */
  const advance = (ms: number) => {
    pageNow += ms;
    for (let due = timers.findIndex(t => t.at <= pageNow); due >= 0; due = timers.findIndex(t => t.at <= pageNow)) timers.splice(due, 1)[0].run();
  };
  return { page, motion, writeStyle, advance, reports, Context2D };
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

describe('a motion report in the page\'s record', () => {
  it('stands as an ended entry of its kind, with its change for the row', () => {
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 1, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '0px', to: '58px', startMs: 1000, endMs: 1300, frames: 19, sentMs: 1420 }, 50_000);

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
    record.takeMotion({ id: 7, doc: 'd', phase: 'open', source: 'style', element: '#acc-body', property: 'height', from: '', to: '4px', startMs: 1000, endMs: 1000, frames: 1, sentMs: 1000 }, 300_016);

    expect(record.live()).toHaveLength(1);
    expect(record.list()[0]).toMatchObject({ createdIn: { entry: 29 }, read: { playState: 'running' } });

    markedNow(undefined, 300_200);
    record.takeMotion({ id: 7, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, frames: 19, sentMs: 1420 }, 300_436);

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
    record.takeMotion({ id: 2, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.900', startMs: 1000, endMs: 1900, frames: 0, sentMs: 1910 }, 100_910);

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
    record.takeMotion({ id: 3, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, frames: 19, sentMs: 1420 }, 200_500);

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
    record.takeMotion({ id: 4, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.050', startMs: 1000, endMs: 1050, frames: 0, sentMs: 1051,
      root: { id: 'p:9', step: JSON.stringify({ kind: 'command', index: 9 }) },
      stoppedBy: { maker: 'MEDIA', trigger: 'key [ · pause()', root: { id: 'p:11', step: JSON.stringify({ kind: 'command', index: 11 }) } } }, 400_051);

    expect(record.list()[0].endedIn).toMatchObject({ index: 11 });
  });

  it('adds no end where the motion ended by itself under its own root, however late the step after began', () => {
    markedNow({ kind: 'command', index: 20 }, 500_000);
    markedNow({ kind: 'command', index: 21 }, 500_100);
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 5, doc: 'd', phase: 'close', source: 'text', element: '#counter', property: 'text', from: '0', to: '1248', startMs: 1000, endMs: 1624, frames: 39, sentMs: 1625,
      root: { id: 'p:20', step: JSON.stringify({ kind: 'command', index: 20 }) } }, 500_625);

    expect(record.list()[0].endedIn).toBeUndefined();
  });
});
