/**
 * The check engine: one reading of an element, a value, an expression, the
 * URL, a cookie, storage or time, read again until it holds or its time runs
 * out. assert and wait are faces of it, so their behaviour is pinned here
 * too: the defaults each carries, and what ends a read early.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  assertAsCheck, compare, formOf, runCheck, subjectOf, waitAsCheck, WAIT_TIMEOUT_MS,
  type CheckSpec,
} from './check-engine.js';

/** A page connection whose reads answer from `answers`, one per read, the last repeating. */
function page(answers: Array<unknown | Error>, overrides: Record<string, unknown> = {}) {
  let at = 0;
  const cdpManager = {
    isPaused: () => false,
    isConnected: () => true,
    getRuntimeType: () => 'browser',
    evaluateExpressionDetailed: vi.fn(async () => {
      const answer = answers[Math.min(at++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { rawCaptured: true, rawValue: answer, formatted: String(answer) };
    }),
    ...overrides,
  };
  return {
    cdpManager,
    deps: { connectionReason: 'tab', resolveConnection: vi.fn(async () => ({ cdpManager })) },
  };
}

/** What the element probe returns, as the page serialises it. */
const probe = (fields: Partial<{ count: number; visible: boolean; hittable: boolean; text: string; attribute: string | null; enabled: boolean }>) =>
  JSON.stringify({ count: 1, visible: true, hittable: true, text: '', attribute: null, enabled: true, ...fields });

describe('compare', () => {
  it.each([
    ['equals', { a: 1 }, { a: 1 }, true],
    ['equals', 'open', 'opened', false],
    ['notEquals', 'open', 'failed', true],
    ['contains', 'connection open', 'open', true],
    ['contains', ['a', 'b'], 'b', true],
    ['matches', 's-12ab', '^s-', true],
    ['matches', 'x-12', '^s-', false],
    ['gt', '10', '9', true],
    ['gte', 3, 3, true],
    ['lt', 2, 3, true],
    ['lte', 4, 3, false],
    ['exists', 0, undefined, true],
    ['notExists', undefined, undefined, true],
  ] as const)('%s %j against %j is %s', (operator, left, right, passed) => {
    expect(compare(left, operator, right).passed).toBe(passed);
  });

  it('orders numeric strings as numbers, so "10" is greater than "9"', () => {
    expect(compare('10', 'gt', '9').passed).toBe(true);
  });
});

describe('what a check reads, and how it is worded', () => {
  it.each([
    [{ selector: '#a' }, 'element', '#a present'],
    [{ selector: '#a', condition: 'text', operator: 'equals', right: 'open' }, 'element', '#a text equals "open"'],
    [{ value: 's-1', hasValue: true, operator: 'matches', right: '^s-' }, 'value', '"s-1" matches "^s-"'],
    [{ expression: 'window.ready' }, 'expression', 'window.ready'],
    [{ url: '/app', operator: 'contains' }, 'url', 'url contains "/app"'],
    [{ cookie: 'session' }, 'cookie', 'cookie session present'],
    [{ localStorage: 'token', condition: 'absent' }, 'localStorage', 'localStorage token absent'],
    [{ indexedDB: 'db/store' }, 'indexedDB', 'indexedDB db/store present'],
    [{ afterMs: 1000 }, 'time', '1000ms passed'],
  ] as Array<[CheckSpec, string, string]>)('%j reads as %s: %s', (spec, form, subject) => {
    expect(formOf(spec)).toBe(form);
    expect(subjectOf(spec)).toBe(subject);
  });
});

describe('assert and wait as checks', () => {
  it('reads a DOM assert for up to 5s, every 250ms', () => {
    expect(assertAsCheck({ selector: '#a', condition: 'visible' })).toMatchObject({ withinMs: 5000, pollMs: 250 });
  });

  it('reads a value assert once', () => {
    const spec = assertAsCheck({ left: 's-1', operator: 'matches', right: '^s-' });
    expect(spec).toEqual({ value: 's-1', hasValue: true, operator: 'matches', right: '^s-' });
    expect(spec.withinMs).toBeUndefined();
  });

  it('waits up to 15s for an element, every 100ms', () => {
    expect(waitAsCheck({ selector: '#done' })).toEqual({ selector: '#done', condition: 'present', withinMs: WAIT_TIMEOUT_MS, pollMs: 100 });
    expect(WAIT_TIMEOUT_MS).toBe(15000);
  });

  it('reads a wait for an element going as absent', () => {
    expect(waitAsCheck({ selectorGone: '.spinner', timeoutMs: 2000 })).toMatchObject({ selector: '.spinner', condition: 'absent', withinMs: 2000 });
  });

  it('reads a fixed wait as time alone', () => {
    expect(waitAsCheck({ ms: 500 })).toEqual({ afterMs: 500 });
  });
});

describe('runCheck', () => {
  it('holds a timer once its time has passed, reading nothing', async () => {
    const started = Date.now();
    const reading = await runCheck({ afterMs: 40 }, {});
    expect(reading).toMatchObject({ outcome: 'held', form: 'time', found: '40ms passed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('holds and fails a value check on its comparison', async () => {
    expect((await runCheck({ value: 's-12', hasValue: true, operator: 'matches', right: '^s-' }, {})).outcome).toBe('held');
    expect((await runCheck({ value: 'x-12', hasValue: true, operator: 'matches', right: '^s-' }, {})).outcome).toBe('failed');
  });

  it('answers error, not failed, for a value check with no operator', async () => {
    expect(await runCheck({ value: 1, hasValue: true }, {})).toMatchObject({ outcome: 'error', errorKind: 'invalid' });
  });

  it('reads an element once when it has no time limit', async () => {
    const { deps, cdpManager } = page([false]);
    const reading = await runCheck({ selector: '#a', condition: 'present' }, deps);
    expect(reading).toMatchObject({ outcome: 'failed', found: 'absent', polls: 1 });
    expect(cdpManager.evaluateExpressionDetailed).toHaveBeenCalledTimes(1);
  });

  it('reads again until it holds, within its time limit', async () => {
    const { deps } = page([false, false, true]);
    const reading = await runCheck({ selector: '#a', condition: 'present', withinMs: 2000, pollMs: 25 }, deps);
    expect(reading).toMatchObject({ outcome: 'held', found: 'present', polls: 3 });
  });

  it('fails once its time limit runs out', async () => {
    const { deps } = page([false]);
    const reading = await runCheck({ selector: '#a', condition: 'present', withinMs: 120, pollMs: 25 }, deps);
    expect(reading.outcome).toBe('failed');
    expect(reading.polls).toBeGreaterThan(1);
    expect(reading.elapsedMs).toBeGreaterThanOrEqual(90);
  });

  it('holds absent when the element is not there', async () => {
    const { deps } = page([true]);
    expect(await runCheck({ selector: '#a', condition: 'absent' }, deps)).toMatchObject({ outcome: 'held', found: 'absent' });
  });

  it('compares an element text, and names what it found on a fail', async () => {
    const { deps } = page([probe({ text: 'failed' })]);
    const reading = await runCheck({ selector: '#state', condition: 'text', operator: 'equals', right: 'open' }, deps);
    expect(reading.outcome).toBe('failed');
    expect(reading.found).toContain('text="failed"');
  });

  it('keeps reading through a read that throws, as a navigation mid-read does', async () => {
    const { deps } = page([new Error('Execution context was destroyed'), probe({ text: 'open' })]);
    const reading = await runCheck({ selector: '#state', condition: 'text', operator: 'equals', right: 'open', withinMs: 1000, pollMs: 25 }, deps);
    expect(reading).toMatchObject({ outcome: 'held', polls: 2 });
  });

  it('answers error at once on a selector the page cannot parse, before its time limit', async () => {
    const { deps } = page([new Error("'##a' is not a valid selector")]);
    const started = Date.now();
    const reading = await runCheck({ selector: '##a', condition: 'visible', withinMs: 5000 }, deps);
    expect(reading).toMatchObject({ outcome: 'error', errorKind: 'invalid', polls: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('answers error at once on a page paused at a breakpoint', async () => {
    const { deps } = page([true], { isPaused: () => true });
    expect(await runCheck({ selector: '#a', withinMs: 5000 }, deps)).toMatchObject({ outcome: 'error', errorKind: 'paused', polls: 0 });
  });

  it('answers error for a page check with no connection', async () => {
    expect(await runCheck({ selector: '#a' }, {})).toMatchObject({ outcome: 'error', errorKind: 'no-connection' });
  });

  it('answers error for an element check against a Node target', async () => {
    const { deps } = page([true], { getRuntimeType: () => 'node' });
    expect(await runCheck({ selector: '#a' }, deps)).toMatchObject({ outcome: 'error', errorKind: 'node' });
  });

  it('answers error for a comparing condition with no operator', async () => {
    const { deps } = page([probe({})]);
    expect(await runCheck({ selector: '#a', condition: 'text' }, deps)).toMatchObject({ outcome: 'error', errorKind: 'invalid' });
  });

  it('stops mid-read when the run is cancelled', async () => {
    const { deps } = page([false]);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const started = Date.now();
    await expect(runCheck({ selector: '#a', withinMs: 10_000, pollMs: 25 }, { ...deps, abortSignal: abort.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads the URL through the navigate tool', async () => {
    const executeToolCall = vi.fn(async () => ({
      content: [{ type: 'text', text: 'URL: https://example.com/app/home' }],
      _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url: 'https://example.com/app/home', title: 't', action: 'info' } },
    }));
    const reading = await runCheck({ url: '/app', operator: 'contains' }, { connectionReason: 'tab', executeToolCall: executeToolCall as any });
    expect(reading.outcome).toBe('held');
    expect((executeToolCall.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(['navigate', { action: 'info', connectionReason: 'tab' }]);
  });
});
