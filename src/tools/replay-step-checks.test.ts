/**
 * What the executor reads around a step - navigation, typed text, a click's
 * failed requests, the line a breakpoint landed on, a step's traffic - comes
 * from the tools' `_meta`, and each reading covers what the step caused.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateNavigation, validateTypedText, capturePreClickState, validateClickAction,
  autoLaunchChrome, executeSteps,
} from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import type { ClickValidationConfig } from '../config.js';
import type { CommandSequence } from '../command-recorder.js';

function ctxWith(answer: (tool: string, params: Record<string, any>) => any): ExecutionContext & { calls: any[] } {
  const calls: any[] = [];
  const executeToolCall = productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    return answer(tool, params) ?? { content: [{ type: 'text', text: '' }] };
  });
  return { executeToolCall, commandRecorder: { recordCommand: vi.fn(), getCurrentHistoryIndex: () => 0 } as any, connectionReason: 'shop-web-app', logPrefix: 'test', calls };
}

const pageInfo = (url: string, title: string) => ({
  content: [{ type: 'text', text: `**Title:** ${title}\nURL: ${url}` }],
  _meta: { navigate: { url, title, action: 'info' } },
});

describe('validateNavigation', () => {
  it('fails on a Chrome error page', async () => {
    const ctx = ctxWith(tool => tool === 'navigate' ? pageInfo('chrome-error://chromewebdata/', 'shop.test') : undefined);
    expect((await validateNavigation(ctx, 'http://shop.test/')).success).toBe(false);
  });

  it('passes a loaded page whose title happens to contain ERR_ or about:blank', async () => {
    const ctx = ctxWith(tool => tool === 'navigate' ? pageInfo('http://shop.test/errors', 'ERR_ codes and about:blank explained') : undefined);
    expect((await validateNavigation(ctx, 'http://shop.test/errors')).success).toBe(true);
  });

  it('fails a page left on about:blank when another URL was expected', async () => {
    const ctx = ctxWith(tool => tool === 'navigate' ? pageInfo('about:blank', '') : undefined);
    expect((await validateNavigation(ctx, 'http://shop.test/')).success).toBe(false);
  });
});

describe('validateTypedText', () => {
  const evaluated = (value: string) => ({ content: [{ type: 'text', text: 'Result:\n```\n"something else"\n```' }], _meta: { inspect: { value } } });

  it('reads the typed value from _meta', async () => {
    const ctx = ctxWith(tool => tool === 'inspect' ? evaluated('hello') : undefined);
    await expect(validateTypedText(ctx, '#name', 'hello')).resolves.toBeUndefined();
  });

  it('reports a value that differs', async () => {
    const ctx = ctxWith(tool => tool === 'inspect' ? evaluated('hell') : undefined);
    await expect(validateTypedText(ctx, '#name', 'hello')).rejects.toThrow('Text validation failed');
  });

  it('passes a selector with quotes and backslashes into the page intact', async () => {
    const ctx = ctxWith(tool => tool === 'inspect' ? evaluated('x') : undefined);
    const selector = `input[name='a\\'b']`;
    await validateTypedText(ctx, selector, 'x');
    const expression: string = ctx.calls.find(c => c.tool === 'inspect').params.expression;
    expect(expression).toContain(JSON.stringify(selector));
  });
});

describe('click validation of failed POST requests', () => {
  const config: ClickValidationConfig = {
    enabled: true, validateNavigation: false, requireDomChanges: false, domChangesFailMode: 'warn',
    failOnConsoleErrors: false, consoleErrorsFailMode: 'warn', validateNetworkPayload: true,
    networkFailMode: 'error', postClickDelayMs: 0,
  };
  const requests = [
    { id: 'old', url: 'http://shop.test/api/old', method: 'POST', status: 409, startTime: 1_000 },
    { id: 'new', url: 'http://shop.test/api/cart', method: 'POST', status: 422, startTime: 5_000 },
    { id: 'get', url: 'http://shop.test/api/list', method: 'GET', status: 404, startTime: 5_000 },
  ];
  function networkCtx(clickAt: number, inWindow: typeof requests) {
    return ctxWith((tool, params) => {
      if (tool !== 'network' || params.action !== 'list') return undefined;
      const rows = params.since === undefined ? inWindow : inWindow.filter(r => r.startTime >= params.since);
      return { content: [{ type: 'text', text: '' }], _meta: { network: { totalCount: inWindow.length, at: clickAt, requests: rows.map(({ startTime: _s, ...r }) => r) } } };
    });
  }

  it('fails on a POST answered 4xx after the click', async () => {
    const ctx = networkCtx(4_000, requests);
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, config);
    expect(result.errors).toEqual([expect.stringContaining('POST')]);
  });

  it('does not count a POST that failed before the click', async () => {
    const ctx = networkCtx(4_000, requests.filter(r => r.id !== 'new'));
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, config);
    expect(result.errors).toEqual([]);
  });
});

describe('autoLaunchChrome', () => {
  it('answers a name that is not three words as INVALID_REFERENCE instead of throwing', async () => {
    const ctx = ctxWith(() => undefined);
    const result = await autoLaunchChrome(ctx.executeToolCall, 'shop');
    expect(result).toMatchObject({ success: false, errorType: 'INVALID_REFERENCE' });
    expect(ctx.calls).toEqual([]);
  });
});

const seq = (commands: any[], extra: Partial<CommandSequence> = {}): CommandSequence =>
  ({ id: 'seq', name: 'seq', commands, createdAt: 1, ...extra });

describe('a breakpoint the sequence set', () => {
  it('is known by the line the tool resolved it to, so a pause there does not stop the run', async () => {
    let paused = false;
    const ctx = ctxWith((tool, params) => {
      if (tool === 'breakpoint') {
        paused = true;
        return { content: [{ type: 'text', text: 'Breakpoint set' }], _meta: { breakpoint: { url: 'http://shop.test/app.js', line: 12 } } };
      }
      if (tool === 'connection' && params.action === 'status') {
        return { content: [{ type: 'text', text: '' }], _meta: { debugger: { reference: 'shop-web-app', connected: true, paused, totalBreakpoints: 1, ...(paused ? { pausedAt: { url: 'http://shop.test/app.js', lineNumber: 12, functionName: 'f', callFrameId: 'c' } } : {}) } } };
      }
      return undefined;
    });

    const result = await executeSteps({
      sequence: seq([
        { tool: 'breakpoint', params: { action: 'set', url: 'http://shop.test/app.js', lineNumber: 10 } },
        { tool: 'content', params: { action: 'extractText' } },
      ]),
      startStep: 0, ctx,
    });

    expect(result.breakpointHit).toBeUndefined();
    expect(result.results.map(r => r.success)).toEqual([true, true]);
  });
});

describe('behaviour drift', () => {
  it('counts every request a step made, past the first 50', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i), url: `http://shop.test/api/${i}`, method: 'GET', status: 200 }));
    const ctx = ctxWith((tool, params) => {
      if (tool === 'network' && params.action === 'list') {
        return { content: [{ type: 'text', text: '' }], _meta: { network: { totalCount: 60, requests: rows.slice(0, params.limit ?? 100) } } };
      }
      return undefined;
    });

    const result = await executeSteps({
      sequence: seq([
        { tool: 'content', params: { action: 'extractText' }, traffic: { requests: 60, failed: 0, events: 0, writes: 0 } },
      ]),
      startStep: 0, ctx,
    });

    expect(result.behaviourDrift).toBeUndefined();
  });
});
