import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { PAGE_TRIGGER_SOURCE } from './page-trigger.js';
import { MOTION_BINDING } from './page-motion.js';

/** A window whose timers, frames and listeners run by hand: what the tracker reports of each root. */
function pageWithTracker() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const tasks: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const reports: Array<{ id: string; open: boolean }> = [];
  const clock = { ms: 0 };
  class EventTarget {
    addEventListener(this: any, type: string, fn: (event: any) => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); }
    removeEventListener() {}
  }
  const transitions: Array<{ update: () => void; finish: () => void }> = [];
  class Document {
    startViewTransition(update: () => void) {
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      transitions.push({ update, finish });
      return { finished };
    }
  }
  const observers: Array<(records: any[]) => void> = [];
  // Records a change queued and no microtask has delivered yet, which takeRecords() hands over.
  const pendingRecords: any[] = [];
  class MutationObserver {
    constructor(callback: (records: any[]) => void) { observers.push(callback); }
    observe() {}
    takeRecords() { return pendingRecords.splice(0); }
  }
  const page: any = new EventTarget();
  Object.assign(page, {
    EventTarget,
    Document,
    MutationObserver,
    document: { readyState: 'complete', documentElement: {}, addEventListener: () => {} },
    performance: { now: () => clock.ms },
    setTimeout: (run: () => void) => { tasks.push(run); return tasks.length; },
    clearTimeout: () => {},
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    cancelAnimationFrame: () => {},
    location: { href: 'http://app.test/' },
    [MOTION_BINDING]: (payload: string) => { const one = JSON.parse(payload); if (one.phase === 'root') reports.push({ id: one.id, open: one.open }); },
  });
  vm.createContext(page);
  vm.runInContext(PAGE_TRIGGER_SOURCE, page);
  const fire = (type: string, event: any) => { for (const fn of listeners.get(type) ?? []) fn({ type, isTrusted: true, ...event }); };
  /** Run what is due: every task queued, then a frame, then the tasks that frame queued. */
  const turn = () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) task();
    for (const frame of frames.splice(0)) frame();
    for (let task = tasks.shift(); task; task = tasks.shift()) task();
  };
  /** Deliver a class change on `target` to the page's observers, as the microtask after the change does. */
  const mutate = (target: object) => { for (const callback of observers) callback([{ type: 'attributes', attributeName: 'class', target }]); };
  /** Queue a style change on `target` that no microtask has delivered yet, as a change made inside a frame callback stands. */
  page.queueChange = (target: object) => { pendingRecords.push({ type: 'attributes', attributeName: 'style', target }); };
  /** Deliver the queued changes to the page's observers, as the microtask checkpoint does. */
  const deliver = () => { const records = pendingRecords.splice(0); if (records.length) for (const callback of observers) callback(records); };
  return { page, fire, turn, reports, tasks, transitions, clock, mutate, deliver };
}

describe('the work outstanding under an input\'s root', () => {
  it('opens at the input and settles once its handler\'s work and the next rendering opportunity have passed', () => {
    const { fire, turn, reports } = pageWithTracker();
    fire('keydown', { key: 'u' });
    expect(reports).toEqual([{ id: expect.any(String), open: true }]);

    turn();
    turn();
    expect(reports.map(one => one.open)).toEqual([true, false]);
  });

  it('stays open across a timer the input scheduled, and settles after it runs', () => {
    const { page, fire, turn, reports, tasks } = pageWithTracker();
    fire('keydown', { key: 'h' });
    vm.runInContext('setTimeout(() => { globalThis.ranTimer = true; }, 300)', page);
    const root = reports[0].id;

    // The input's own hold is released at the next task; the timer keeps the root open.
    const timer = tasks.pop()!;
    turn();
    expect(reports.filter(one => one.id === root).map(one => one.open)).toEqual([true]);

    timer();
    turn();
    turn();
    expect(page.ranTimer).toBe(true);
    expect(reports.filter(one => one.id === root).map(one => one.open)).toEqual([true, false]);
  });

  it('credits a hover the page scrolled under a still pointer to the scroll, not to a root of its own', () => {
    const { page, fire } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60 });
    const pointerRoot = tracker.rootNow().id;
    fire('keydown', { key: 'PageDown' });
    const keyRoot = tracker.rootNow().id;
    fire('scroll', {});

    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60 });
    expect(tracker.rootNow().id).toBe(keyRoot);

    fire('pointerover', { pointerType: 'mouse', clientX: 80, clientY: 60 });
    expect([keyRoot, pointerRoot]).not.toContain(tracker.rootNow().id);
  });

  it('credits a hover under a still pointer to the input scrolling now, ahead of its scroll event', () => {
    const { page, fire, clock } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    tracker.ownScroll('hover #card', 'step 13');
    const hoverScrollRoot = tracker.rootNow().id;
    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60 });
    clock.ms = 16;
    fire('scroll', {});
    clock.ms = 40;
    fire('wheel', {});
    const wheelRoot = tracker.rootNow().id;

    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60 });
    expect(tracker.rootNow().id).toBe(wheelRoot);
    expect(wheelRoot).not.toBe(hoverScrollRoot);
  });

  it("credits a transition a frame callback's style change set off to the input that scheduled it, though the change is delivered after the page moved on", () => {
    const { page, fire, turn, deliver } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    const toast = { matches: () => false };
    page.toast = toast;
    fire('keydown', { key: '2' });
    const keyRoot = tracker.rootNow().id;
    vm.runInContext('requestAnimationFrame(() => { requestAnimationFrame(() => { queueChange(toast); }); })', page);
    turn();
    turn();
    turn();
    turn();
    deliver();
    fire('transitionrun', { target: toast, propertyName: 'opacity' });

    expect(tracker.rootOfAnimation({ effect: { target: toast }, transitionProperty: 'opacity' })?.id).toBe(keyRoot);
  });

  it("reads a drag's first move as the drag, after the pointerover that pointer capture fires at the same point", () => {
    const { page, fire } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    const handle = { matches: () => false };
    fire('pointerover', { pointerType: 'mouse', clientX: 686, clientY: 1722, buttons: 0, target: handle });
    fire('pointermove', { pointerType: 'mouse', clientX: 686, clientY: 1722, buttons: 0, target: handle });
    fire('pointerdown', { pointerType: 'mouse', clientX: 686, clientY: 1722, buttons: 1, target: handle });
    fire('pointerover', { pointerType: 'mouse', clientX: 686, clientY: 1737, buttons: 1, target: handle });
    fire('pointermove', { pointerType: 'mouse', clientX: 686, clientY: 1737, buttons: 1, target: handle });

    expect(tracker.current()).toBe('drag');
  });

  it("credits a transition in a same-origin frame to the parent's input, where the parent's code changed the frame", () => {
    const { page, mutate } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    page.parent = { [Symbol.for('devharness.trigger')]: { current: () => 'key 6', rootNow: () => ({ id: 'top:4' }) } };
    const box = { matches: () => false };
    mutate(box);

    expect(tracker.rootOfAnimation({ effect: { target: box }, transitionProperty: 'transform' })?.id).toBe('top:4');
  });

  it('credits a delayed keyframe animation to the cause live when it was created, not to an input made inside its delay', () => {
    const { page, fire, clock } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    const delayed = (target: any) => ({ animationName: 'rise', effect: { target, pseudoElement: null, getTiming: () => ({ delay: 100 }) } });
    const title: any = { matches: () => false };
    const rise = delayed(title);
    title.getAnimations = () => [rise];
    fire('load', {});
    clock.ms = 60;
    fire('keydown', { key: '6' });
    clock.ms = 100;
    fire('animationstart', { target: title, animationName: 'rise', pseudoElement: '' });
    expect(tracker.rootOfAnimation(rise)).toBeUndefined();

    clock.ms = 2000;
    fire('keydown', { key: 'g' });
    const keyRoot = tracker.rootNow().id;
    const card: any = { matches: () => false };
    const pop = delayed(card);
    card.getAnimations = () => [pop];
    clock.ms = 2100;
    fire('animationstart', { target: card, animationName: 'rise', pseudoElement: '' });
    expect(tracker.rootOfAnimation(pop)?.id).toBe(keyRoot);
  });

  it('credits the transition of an element the page scrolled from under the pointer to that scroll', () => {
    const { page, fire } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    const card = { matches: () => false };
    const below = { matches: () => false };
    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60, target: card });
    fire('keydown', { key: 'PageDown' });
    const keyRoot = tracker.rootNow().id;
    fire('scroll', {});

    fire('pointerout', { pointerType: 'mouse', clientX: 40, clientY: 60, target: card });
    fire('pointerover', { pointerType: 'mouse', clientX: 40, clientY: 60, target: below });
    fire('transitionrun', { target: card, propertyName: 'transform' });

    expect(tracker.rootOfAnimation({ effect: { target: card }, transitionProperty: 'transform' })?.id).toBe(keyRoot);
  });

  it.each([['an element', ''], ['a pseudo-element', '::backdrop']])('credits a transition on %s that reverses a running one to the change that reversed it, before and after its run event', (_, pseudoElement) => {
    const { page, fire, turn, mutate } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    let listed: object[] = [];
    const panel = { matches: () => false, getAnimations: () => listed };
    fire('keydown', { key: 'c' });
    const dimRoot = tracker.rootNow().id;
    mutate(panel);
    const dim = { transitionProperty: 'opacity', effect: { target: panel, pseudoElement: pseudoElement || null } };
    listed = [dim];
    fire('transitionrun', { target: panel, propertyName: 'opacity', pseudoElement });
    turn();

    fire('keydown', { key: 'v' });
    const undimRoot = tracker.rootNow().id;
    mutate(panel);
    const reversed = { transitionProperty: 'opacity', effect: { target: panel, pseudoElement: pseudoElement || null } };
    listed = [reversed];
    turn();

    expect(tracker.rootOfAnimation(reversed)?.id).toBe(undimRoot);
    expect(tracker.ofAnimation(reversed)).toBe('key v');

    fire('transitioncancel', { target: panel, propertyName: 'opacity', pseudoElement });
    fire('transitionrun', { target: panel, propertyName: 'opacity', pseudoElement });

    expect(tracker.rootOfAnimation(reversed)?.id).toBe(undimRoot);
    expect(tracker.rootOfAnimation(dim)?.id).toBe(dimRoot);
  });

  it('runs a view transition\'s update under the root of the input that started it, and credits its pseudo-elements\' animations to it', async () => {
    const { page, fire, turn, reports, transitions } = pageWithTracker();
    const tracker = vm.runInContext("globalThis[Symbol.for('devharness.trigger')]", page);
    fire('keydown', { key: 'r' });
    const keyRoot = tracker.rootNow().id;
    vm.runInContext('globalThis.seen = []; new Document().startViewTransition(() => { globalThis.seen.push(globalThis[Symbol.for("devharness.trigger")].rootNow()?.id); })', page);
    turn();
    turn();
    fire('keydown', { key: 'i' });

    transitions[0].update();
    expect(page.seen).toEqual([keyRoot]);
    expect(tracker.rootOfAnimation({ effect: { pseudoElement: '::view-transition-old(root)' } })?.id).toBe(keyRoot);
    expect(reports.filter(one => one.id === keyRoot).map(one => one.open)).toEqual([true]);

    transitions[0].finish();
    await Promise.resolve();
    turn();
    turn();
    expect(reports.filter(one => one.id === keyRoot).map(one => one.open)).toEqual([true, false]);
  });
});
