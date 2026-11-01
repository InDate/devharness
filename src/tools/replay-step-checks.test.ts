// @vitest-environment happy-dom
/**
 * What the executor reads around a step - navigation, typed text, a click's
 * failed requests, the line a breakpoint landed on - comes from the tools'
 * `_meta`, and each reading covers what the step caused.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateNavigation, validateTypedText, capturePreClickState, validateClickAction,
  executeSteps,
} from './replay-executor.js';
import { navigateToStartUrl } from './replay-step-checks.js';
import { analyzeSequenceConnections } from './replay-connections.js';
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
  return { executeToolCall, commandRecorder: { recordCommand: vi.fn(), getCurrentHistoryIndex: () => 0, getHistory: () => [] } as any, connection: 'shop-web-app', logPrefix: 'test', calls };
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

describe('the startUrl navigation before step 1', () => {
  const sequenceOf = (extra: Partial<CommandSequence>) => ({
    id: 's', name: 'walk', createdAt: 0, startUrl: 'http://shop.test/pair.html',
    commands: [{ tool: 'input', params: { action: 'click', selector: '#pair', connection: 'host-root' } }],
    ...extra,
  }) as CommandSequence;
  const gotos = (calls: any[]) => calls.filter(c => c.tool === 'navigate').map(c => c.params.connection);

  it('goes to the browser step 1 runs in, not the run connection', async () => {
    const ctx = ctxWith(() => undefined);
    const sequence = sequenceOf({});

    await navigateToStartUrl(ctx, sequence, analyzeSequenceConnections(sequence.commands));

    expect(gotos(ctx.calls)).toEqual(['host-root']);
  });

  it('leaves a declared browser the run launches at its declared url', async () => {
    const ctx = ctxWith(() => undefined);
    const sequence = sequenceOf({ requiredConnections: [{ connection: 'host-root', url: 'http://shop.test/pair.html' }] });

    await navigateToStartUrl(ctx, sequence, analyzeSequenceConnections(sequence.commands));

    expect(gotos(ctx.calls)).toEqual([]);
  });

  it('navigates a declared browser rebound onto one already open, since nothing launched it', async () => {
    const ctx = { ...ctxWith(() => undefined), connectionMap: { 'host-root': 'shop-web-app' } };
    const sequence = sequenceOf({ requiredConnections: [{ connection: 'host-root' }] });

    await navigateToStartUrl(ctx, sequence, analyzeSequenceConnections(sequence.commands));

    expect(gotos(ctx.calls)).toEqual(['shop-web-app']);
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

  it('names lengths, never either text, for a concealed value', async () => {
    const ctx = ctxWith(tool => tool === 'inspect' ? evaluated('hunter') : undefined);
    const failure = validateTypedText(ctx, '#password', 'hunter2', false, true);
    await expect(failure).rejects.toThrow('Text validation failed for #password: expected 7 characters, not shown, got 6 characters, not shown');
    await expect(validateTypedText(ctx, '#password', 'hunter2', false, true)).rejects.not.toThrow(/hunter/);
  });

  it('reads a select by the label of its chosen option, not the value it submits', async () => {
    const document = (globalThis as any).document;
    // happy-dom has no HTMLOptionElement.label; Chrome's returns the label attribute, else the option's text
    Object.defineProperty((globalThis as any).HTMLOptionElement.prototype, 'label', {
      configurable: true, get() { return this.getAttribute('label') ?? this.text; },
    });
    document.body.innerHTML = '<select id="person"><option value="r-1a90">Al Fenwick</option><option value="r-6de2" selected>Bo gbybh</option></select>';
    const ctx = ctxWith((tool, params) => tool === 'inspect' ? evaluated((0, eval)(params.expression)) : undefined);
    await expect(validateTypedText(ctx, '#person', 'Bo gbybh')).resolves.toBeUndefined();
    await expect(validateTypedText(ctx, '#person', 'r-6de2')).rejects.toThrow('got "Bo gbybh"');
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

describe('click validation of new console errors', () => {
  const config: ClickValidationConfig = {
    enabled: true, validateNavigation: false, requireDomChanges: false, domChangesFailMode: 'warn',
    failOnConsoleErrors: true, consoleErrorsFailMode: 'error', validateNetworkPayload: false,
    networkFailMode: 'warn', postClickDelayMs: 0,
  };
  const favicon = 'http://localhost:3000/favicon.ico';
  const broken = 'http://localhost:3000/api/broken';
  /** Console entries read before the click, then the ones read after it. */
  async function clicked(after: Array<string | undefined>, failMode: ClickValidationConfig['consoleErrorsFailMode'] = 'error') {
    let reads = 0;
    const entries = (urls: Array<string | undefined>) => urls.map((url, i) => ({ id: `c-${i}`, type: 'error', ...(url ? { url } : {}) }));
    const ctx = ctxWith(tool => {
      if (tool !== 'console') return undefined;
      const list = entries(reads++ === 0 ? [undefined] : [undefined, ...after]);
      return { content: [{ type: 'text', text: '' }], _meta: { console: { totalCount: list.length, errorCount: list.length, warnCount: 0, entries: list } } };
    });
    const pre = await capturePreClickState(ctx);
    return validateClickAction(ctx, pre, {}, { ...config, consoleErrorsFailMode: failMode });
  }

  it('passes a new error that is a favicon 404, query string included, and notes it as browser noise', async () => {
    const result = await clicked([favicon]);
    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(result.info.some(line => line.includes('unrelated browser noise'))).toBe(true);
    expect((await clicked([`${favicon}?v=2`])).valid).toBe(true);
  });

  it('fails on a new error from any other resource, a path containing favicon.ico included', async () => {
    expect((await clicked([broken])).errors[0]).toContain('1 new console error');
    expect((await clicked(['http://localhost:3000/api/favicon.ico/details'])).valid).toBe(false);
  });

  it('counts the favicon error among the new ones when a real error comes with it', async () => {
    const result = await clicked([favicon, broken]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('2 new console error');
  });

  it('turns a new error into a warning under consoleErrorsFailMode warn', async () => {
    const result = await clicked([broken], 'warn');
    expect(result.valid).toBe(true);
    expect(result.warnings[0]).toContain('1 new console error');
  });

  it('reports nothing when no new error appears', async () => {
    expect(await clicked([])).toMatchObject({ valid: true, errors: [], info: [] });
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
