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
  class EventTarget {
    addEventListener(this: any, type: string, fn: (event: any) => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); }
    removeEventListener() {}
  }
  const page: any = new EventTarget();
  Object.assign(page, {
    EventTarget,
    document: { readyState: 'complete', documentElement: {}, addEventListener: () => {} },
    performance: { now: () => 0 },
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
  return { page, fire, turn, reports, tasks };
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
});
