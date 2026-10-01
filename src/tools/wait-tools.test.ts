/**
 * Unit tests for the wait tool (bug-016): the sequence-step wait primitive.
 * Real-browser behaviour (navigation mid-wait, predicate flip) is verified
 * manually against Chrome; these tests cover the pure logic - form
 * validation, predicate compilation, polling/timeout behaviour and the
 * paused-debugger fail-fast - against a fake CDP manager.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWaitTools, buildPresencePredicate } from './wait-tools.js';
import {
  commandNeedsBrowserConnection,
  TOOLS_ACCEPTING_CONNECTION,
  TOOLS_NEEDING_CONNECTION,
} from './replay-executor.js';

function makeCdpManager(overrides: Partial<{
  isPaused: () => boolean;
  isConnected: () => boolean;
  getRuntimeType: () => string;
  evaluateExpressionDetailed: (...args: any[]) => Promise<any>;
}> = {}) {
  return {
    isPaused: () => false,
    isConnected: () => true,
    getRuntimeType: () => 'browser',
    evaluateExpressionDetailed: vi.fn(async () => ({ formatted: 'true', rawValue: true, rawCaptured: true })),
    ...overrides,
  };
}

function makeWait(cdpManager: any = makeCdpManager()) {
  const resolve = vi.fn(async () => ({
    connection: { port: 9222 },
    cdpManager,
    puppeteerManager: null,
  }));
  const { wait } = createWaitTools(resolve as any);
  return { wait, resolve, cdpManager };
}

describe('buildPresencePredicate', () => {
  it('compiles a plain CSS selector to a querySelector check', () => {
    expect(buildPresencePredicate('#app .btn')).toBe('!!document.querySelector("#app .btn")');
  });

  it('compiles :has-text() to an inline synchronous text match (no element marking)', () => {
    const built = buildPresencePredicate('button:has-text("Join")');
    expect(typeof built).toBe('string');
    const expr = built as string;
    expect(expr).toContain('querySelectorAll("button")');
    expect(expr).toContain('"Join"');
    // Must be self-contained: no data-attribute marking that a navigation would lose
    expect(expr).not.toContain('data-cdp-selector-match');
  });

  it('reports invalid extended selector syntax', () => {
    const built = buildPresencePredicate('button:has-text(unquoted)');
    expect(built).toHaveProperty('error');
  });
});

describe('wait form validation', () => {
  it('rejects zero forms', async () => {
    const { wait } = makeWait();
    const result = await wait.handler({} as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one');
  });

  it('rejects two forms at once', async () => {
    const { wait } = makeWait();
    const result = await wait.handler({ selector: '#a', ms: 100 } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('selector + ms');
  });

  it('requires connection for condition forms', async () => {
    const { wait } = makeWait();
    const result = await wait.handler({ selector: '#a' } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connection');
  });
});

describe('wait({ ms })', () => {
  it('sleeps without touching the connection', async () => {
    const { wait, resolve } = makeWait();
    const start = Date.now();
    const result = await wait.handler({ ms: 60 } as any);
    expect(result.isError).toBeUndefined();
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
    expect(resolve).not.toHaveBeenCalled();
    expect(result._meta?.wait).toMatchObject({ form: 'ms', satisfied: true, polls: 0 });
  });
});

describe('wait condition polling', () => {
  it('returns as soon as the predicate flips true', async () => {
    let calls = 0;
    const cdp = makeCdpManager({
      evaluateExpressionDetailed: vi.fn(async () => {
        calls++;
        return { formatted: String(calls >= 3), rawValue: calls >= 3, rawCaptured: true };
      }),
    });
    const { wait } = makeWait(cdp);
    const result = await wait.handler({
      expression: 'window.__x === 1', connection: 'test', pollIntervalMs: 25,
    } as any);
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(3);
    expect(result._meta?.wait).toMatchObject({ form: 'expression', satisfied: true, polls: 3 });
  });

  it('swallows evaluation errors mid-wait (context destroyed by navigation) and keeps polling', async () => {
    let calls = 0;
    const cdp = makeCdpManager({
      evaluateExpressionDetailed: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error('Execution context was destroyed');
        return { formatted: 'true', rawValue: true, rawCaptured: true };
      }),
    });
    const { wait } = makeWait(cdp);
    const result = await wait.handler({
      selector: '#after-nav', connection: 'test', pollIntervalMs: 25,
    } as any);
    expect(result.isError).toBeUndefined();
    expect(calls).toBe(3);
  });

  it('times out cleanly with WAIT_TIMEOUT instead of hanging', async () => {
    const cdp = makeCdpManager({
      evaluateExpressionDetailed: vi.fn(async () => ({ formatted: 'false', rawValue: false, rawCaptured: true })),
    });
    const { wait } = makeWait(cdp);
    const result = await wait.handler({
      expression: 'false', connection: 'test', timeoutMs: 120, pollIntervalMs: 25,
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timed out after 120ms');
    expect(result._meta?.wait).toMatchObject({ form: 'expression', satisfied: false });
  });

  it('includes the last evaluation error in the timeout message', async () => {
    const cdp = makeCdpManager({
      evaluateExpressionDetailed: vi.fn(async () => { throw new Error('myGlobal is not defined'); }),
    });
    const { wait } = makeWait(cdp);
    const result = await wait.handler({
      expression: 'myGlobal.ready', connection: 'test', timeoutMs: 80, pollIntervalMs: 25,
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('myGlobal is not defined');
  });

  it('fails fast while the debugger is paused (nothing can change)', async () => {
    const evaluate = vi.fn();
    const cdp = makeCdpManager({ isPaused: () => true, evaluateExpressionDetailed: evaluate });
    const { wait } = makeWait(cdp);
    const start = Date.now();
    const result = await wait.handler({
      selector: '#x', connection: 'test', timeoutMs: 5000,
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paused');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails fast on an invalid CSS selector instead of polling out the timeout', async () => {
    const cdp = makeCdpManager({
      evaluateExpressionDetailed: vi.fn(async () => {
        throw new Error(`'###' is not a valid selector`);
      }),
    });
    const { wait } = makeWait(cdp);
    const start = Date.now();
    const result = await wait.handler({
      selector: '###', connection: 'test', timeoutMs: 10000,
    } as any);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not a valid selector');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects selector waits against a Node.js target but allows expression waits', async () => {
    const cdp = makeCdpManager({ getRuntimeType: () => 'node' });
    const { wait } = makeWait(cdp);
    const selectorResult = await wait.handler({ selector: '#x', connection: 'node-app' } as any);
    expect(selectorResult.isError).toBe(true);
    const exprResult = await wait.handler({ expression: 'true', connection: 'node-app' } as any);
    expect(exprResult.isError).toBeUndefined();
  });

  it('negates the predicate for selectorGone', async () => {
    const cdp = makeCdpManager();
    const { wait } = makeWait(cdp);
    await wait.handler({ selectorGone: '.spinner', connection: 'test' } as any);
    const predicate = (cdp.evaluateExpressionDetailed as any).mock.calls[0][0];
    expect(predicate).toBe('!(!!document.querySelector(".spinner"))');
  });
});

describe('executor integration', () => {
  it('wait is injectable but only browser-bound in its selector forms', () => {
    expect(TOOLS_ACCEPTING_CONNECTION).toContain('wait');
    // ms sleeps and expression waits must never drag a Chrome auto-launch in
    expect(TOOLS_NEEDING_CONNECTION).not.toContain('wait');
    expect(commandNeedsBrowserConnection({ tool: 'wait', params: { ms: 500 } })).toBe(false);
    expect(commandNeedsBrowserConnection({ tool: 'wait', params: { expression: 'x' } })).toBe(false);
    expect(commandNeedsBrowserConnection({ tool: 'wait', params: { selector: '#a' } })).toBe(true);
    expect(commandNeedsBrowserConnection({ tool: 'wait', params: { selectorGone: '#a' } })).toBe(true);
    // unchanged for everything else
    expect(commandNeedsBrowserConnection({ tool: 'navigate', params: {} })).toBe(true);
    expect(commandNeedsBrowserConnection({ tool: 'inspect', params: {} })).toBe(false);
  });
});
