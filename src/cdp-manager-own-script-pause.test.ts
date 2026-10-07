/**
 * Where a pause armed for the app's next statement ends up.
 *
 * devharness's own scripts run in the page too. A read stopped in one hangs
 * until the hold is released, so the pause steps out of it. The timer wrapper
 * is different: it calls the app's callback, so stepping out of it runs past
 * the app; it is stepped into instead. Neither step is the page resuming, and
 * reporting it as one records a release that drops the hold (#115).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (params?: any) => void;
const fake = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  calls: [] as string[],
}));

vi.mock('chrome-remote-interface', () => {
  // An object answering every property answers `then` too, and awaiting it
  // then waits on a promise that never settles.
  const domain = (name: string) => new Proxy({}, {
    get: (_target, prop: string) => prop === 'then' ? undefined : (arg?: unknown) => {
      if (typeof arg === 'function') {
        fake.handlers.set(`${name}.${prop}`, arg as Handler);
        return undefined;
      }
      fake.calls.push(`${name}.${prop}`);
      if (name === 'Runtime' && prop === 'evaluate') return Promise.resolve({ result: { type: 'string', value: 'object' } });
      return Promise.resolve({});
    },
  });
  const client = new Proxy({}, {
    get: (_target, prop: string) => {
      if (prop === 'then') return undefined;
      if (/^[A-Z]/.test(prop)) return domain(prop);
      return () => Promise.resolve();
    },
  });
  return { default: vi.fn(async () => client) };
});

import { CDPManager } from './cdp-manager.js';

const fire = (event: string, params?: any) => fake.handlers.get(event)!(params);
const pausedIn = (url: string) => ({
  reason: 'other',
  callFrames: [{ url, functionName: '', location: { scriptId: '1', lineNumber: 4 } }],
});

async function armedManager() {
  const manager = new CDPManager();
  await manager.connect('localhost', 9222);
  const notices: boolean[] = [];
  manager.watchPause(paused => notices.push(paused));
  await manager.pause();
  fake.calls.length = 0;
  return { manager, notices };
}

beforeEach(() => {
  fake.handlers.clear();
  fake.calls.length = 0;
});

describe('an armed pause landing in a devharness script', () => {
  it('steps into the timer wrapper, so it lands in the app callback the wrapper calls', async () => {
    const { manager, notices } = await armedManager();

    fire('Debugger.paused', pausedIn('devharness://send-wrapper'));

    expect(fake.calls).toContain('Debugger.stepInto');
    expect(fake.calls).not.toContain('Debugger.stepOut');
    expect(manager.isPaused()).toBe(false);
    expect(notices).toEqual([]);
  });

  it('steps out of a read, which calls no app code', async () => {
    const { notices } = await armedManager();

    fire('Debugger.paused', pausedIn('devharness://bench-evaluate'));
    fire('Debugger.paused', pausedIn('pptr:evaluate;readFingerprint'));

    expect(fake.calls.filter(call => call === 'Debugger.stepOut')).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it('reports no resume for the step, so the hold stays recorded', async () => {
    const { notices } = await armedManager();

    fire('Debugger.paused', pausedIn('devharness://send-wrapper'));
    fire('Debugger.resumed');

    expect(notices).toEqual([]);
  });

  it('stops where the step lands in the app, and reports that pause', async () => {
    const { manager, notices } = await armedManager();

    fire('Debugger.paused', pausedIn('devharness://send-wrapper'));
    fire('Debugger.resumed');
    fire('Debugger.paused', pausedIn('http://localhost:5180/app.js'));

    expect(manager.isPaused()).toBe(true);
    expect(manager.pausedAt()).toEqual({ url: 'http://localhost:5180/app.js', line: 5 });
    expect(notices).toEqual([true]);
  });

  it('reports a resume once the page stood paused in the app', async () => {
    const { manager, notices } = await armedManager();

    fire('Debugger.paused', pausedIn('http://localhost:5180/app.js'));
    fire('Debugger.resumed');

    expect(manager.isPaused()).toBe(false);
    expect(notices).toEqual([true, false]);
  });
});

describe('a pause nobody armed', () => {
  it('stops in a devharness script as it would anywhere, where a breakpoint stands there', async () => {
    const manager = new CDPManager();
    await manager.connect('localhost', 9222);
    fake.calls.length = 0;

    fire('Debugger.paused', pausedIn('devharness://send-wrapper'));

    expect(fake.calls).not.toContain('Debugger.stepInto');
    expect(fake.calls).not.toContain('Debugger.stepOut');
    expect(manager.isPaused()).toBe(true);
  });
});
