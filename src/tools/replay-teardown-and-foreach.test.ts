/**
 * Two features that exist because a sequence suite drifts:
 *
 * 1. `teardown` - steps that run when the MAIN steps reach a terminal state,
 *    including the states nothing else survives (a failed step, an abort, the
 *    total timeout). A cleanup that only runs on the happy path is absent
 *    exactly when it is needed.
 * 2. `forEach` - conditions can only ask whether ONE named thing exists, so
 *    "remove everything that shouldn't be here" was inexpressible. This
 *    enumerates a source and runs a sequence per item.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps, resolveForEachItems } from './replay-executor.js';
import { formatExecutionResults } from './replay-formatters.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { ToolError } from '../tool-error.js';

function makeHarness(responses: Record<string, any> = {}, nested?: CommandSequence[]) {
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    const key = `${tool}.${params.action}`;
    const r = key in responses ? responses[key] : responses[tool];
    const response = r !== undefined
      ? (typeof r === 'function' ? r(params) : r)
      : { content: [{ type: 'text', text: '' }] };
    if (response?.isError) throw new ToolError(response);
    return response;
  });

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    getSequence: (id: string) => nested?.find(s => s.id === id),
    getFreshSequence: async (id: string) => nested?.find(s => s.id === id),
    listSequences: () => nested ?? [],
    loadSequenceFromDisk: vi.fn(async () => null),
    listSavedSequencesOnDisk: vi.fn(async () => []),
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connection: 'device-a',
    logPrefix: 'test',
  };

  return { calls, ctx, executeToolCall };
}

const seq = (
  name: string,
  commands: RecordedCommand[],
  teardown?: RecordedCommand[]
): CommandSequence => ({
  id: `seq-${name}`,
  name,
  commands,
  ...(teardown ? { teardown } : {}),
  createdAt: 1,
});

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const evaluated = (value: unknown) => ({
  content: [{ type: 'text', text: 'ok' }],
  _meta: { tool: 'inspect', action: 'evaluateExpression', timestamp: 0, inspect: { value } },
});
const errorText = (t: string) => ({ isError: true, content: [{ type: 'text', text: t }] });

/**
 * Which tool names ran, in order - the cheapest way to assert "cleanup
 * happened". `inspect` and `connection status` are dropped: the executor
 * makes its own probing calls around steps, and they are not what any of these
 * tests are about.
 */
const toolsCalled = (calls: Array<{ tool: string; params: any }>) =>
  calls.filter(c => c.tool !== 'inspect' && !(c.tool === 'connection' && c.params?.action === 'status')).map(c => c.tool);

beforeEach(() => {
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: false, validateNavigation: false, requireDomChanges: false,
  } as any);
  vi.spyOn(configManager, 'getReplayConfig').mockReturnValue({
    maxConditionalDepth: 10, maxRegexLength: 500,
  } as any);
});

describe('teardown', () => {
  it('runs after the main steps succeed', async () => {
    const { ctx, calls } = makeHarness({ screenshot: text('ok'), storage: text('cleared') });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);

    const result = await executeSteps({ sequence: s, ctx, startStep: 0 });

    expect(result.results.every(r => r.success)).toBe(true);
    expect(result.teardownResults).toHaveLength(1);
    expect(result.teardownFailed).toBe(false);
    expect(toolsCalled(calls)).toEqual(['screenshot', 'storage']);
  });

  it('runs even when a main step fails - the case cleanup exists for', async () => {
    const { ctx, calls } = makeHarness({
      screenshot: errorText('boom'),
      storage: text('cleared'),
    });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);

    const result = await executeSteps({ sequence: s, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(false);
    expect(result.teardownResults).toHaveLength(1);
    expect(result.teardownResults![0].success).toBe(true);
    expect(toolsCalled(calls)).toContain('storage');
  });

  it('runs after the run is cancelled, because the signal is NOT passed down', async () => {
    const controller = new AbortController();
    const { ctx, calls } = makeHarness({ screenshot: text('ok'), storage: text('cleared') });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);
    controller.abort();

    const result = await executeSteps({
      sequence: s, ctx, startStep: 0, abortSignal: controller.signal,
    });

    expect(result.results[0].error).toBe('Replay aborted by user');
    // The whole point: a cancelled run is precisely one that left something behind.
    expect(result.teardownResults?.[0].success).toBe(true);
    expect(toolsCalled(calls)).toEqual(['storage']);
  });

  it('has its own budget, so an exhausted totalTimeout does not skip it', async () => {
    const { ctx, calls } = makeHarness({ screenshot: text('ok'), storage: text('cleared') });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);

    // totalTimeout of 0 means the main loop gives up before its first step.
    const result = await executeSteps({ sequence: s, ctx, startStep: 0, totalTimeout: 0 });

    expect(result.results[0].error).toContain('Total timeout exceeded');
    expect(result.teardownResults?.[0].success).toBe(true);
    expect(toolsCalled(calls)).toEqual(['storage']);
  });

  it('does NOT run when the sequence pauses at stepTo - the run is not over', async () => {
    const { ctx, calls } = makeHarness({ screenshot: text('ok'), storage: text('cleared') });
    const s = seq(
      'main',
      [{ tool: 'screenshot', params: {} }, { tool: 'screenshot', params: {} }],
      [{ tool: 'storage', params: {} }]
    );

    const result = await executeSteps({ sequence: s, ctx, startStep: 0, endStep: 1 });

    expect(result.teardownResults).toBeUndefined();
    expect(toolsCalled(calls)).toEqual(['screenshot']);
  });

  it('reads variables the main steps captured, so it can undo what setup minted', async () => {
    const { ctx, calls } = makeHarness({
      request: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { tool: 'request', action: 'send', timestamp: 0, request: { body: { id: 'share-42' } } },
      },
      navigate: text('ok'),
    });
    const s = seq(
      'main',
      [{ tool: 'request', params: { url: '/mint', saveAs: 'mint' } }],
      [{ tool: 'navigate', params: { action: 'goto', url: '/revoke/{{var:mint.body.id}}' } }]
    );

    await executeSteps({ sequence: s, ctx, startStep: 0 });

    const revoke = calls.find(c => c.tool === 'navigate');
    expect(revoke?.params.url).toBe('/revoke/share-42');
  });

  it('does not change the run verdict when a teardown step fails', async () => {
    const { ctx } = makeHarness({ navigate: text('ok'), storage: errorText('cleanup broke') });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);

    const result = await executeSteps({ sequence: s, ctx, startStep: 0 });

    expect(result.results.every(r => r.success)).toBe(true);
    expect(result.teardownFailed).toBe(true);

    const rendered = formatExecutionResults('main', result.results, 1, 0, {
      results: result.teardownResults!, failed: true,
    });
    expect(rendered).toContain("does not change the run's verdict");
    expect(rendered).toContain('**Successful:** 1');
    expect(rendered).toContain('**Failed:** 0');
  });

  it('does not recurse - a teardown does not run its own teardown', async () => {
    const { ctx, calls } = makeHarness({ screenshot: text('ok'), storage: text('cleared') });
    const s = seq('main', [{ tool: 'screenshot', params: {} }], [{ tool: 'storage', params: {} }]);

    await executeSteps({ sequence: s, ctx, startStep: 0 });

    expect(calls.filter(c => c.tool === 'storage')).toHaveLength(1);
  });
});

describe('resolveForEachItems', () => {
  it('reads an array a previous saveAs captured', async () => {
    const { ctx } = makeHarness();
    ctx.variableStore = { rows: [{ id: 1 }, { id: 2 }] };

    const result = await resolveForEachItems('{{var:rows}}', ctx);

    expect(result).toEqual({ ok: true, items: [{ id: 1 }, { id: 2 }] });
  });

  it('addresses into a captured object', async () => {
    const { ctx } = makeHarness();
    ctx.variableStore = { list: { body: { shares: ['a', 'b'] } } };

    const result = await resolveForEachItems('{{var:list.body.shares}}', ctx);

    expect(result).toEqual({ ok: true, items: ['a', 'b'] });
  });

  it('rejects a non-array rather than looping over its characters', async () => {
    const { ctx } = makeHarness();
    ctx.variableStore = { name: 'employees' };

    const result = await resolveForEachItems('{{var:name}}', ctx);

    expect(result).toMatchObject({ ok: false });
    expect((result as any).error).toContain('not an array');
  });

  it('names the missing variable instead of yielding nothing', async () => {
    const { ctx } = makeHarness();

    const result = await resolveForEachItems('{{var:nope}}', ctx);

    expect((result as any).error).toContain('no variable named "nope"');
  });

  it('enumerates the DOM via selectorAll', async () => {
    const { ctx, calls } = makeHarness({
      'inspect.evaluateExpression': evaluated([{ index: 0, text: 'Employees' }]),
    });

    const result = await resolveForEachItems('{{selectorAll:.share-row}}', ctx);

    expect(result).toEqual({ ok: true, items: [{ index: 0, text: 'Employees' }] });
    expect(calls[0].params.expression).toContain('.share-row');
  });

  it('rejects an unrecognised source instead of treating it as empty', async () => {
    const { ctx } = makeHarness();

    const result = await resolveForEachItems('.share-row', ctx);

    expect((result as any).error).toContain('unrecognised source');
  });
});

describe('forEach step', () => {
  const body = seq('revoke-one', [
    { tool: 'storage', params: { action: 'setLocalStorage', key: 'revoked', value: '{{var:row.id}}' } },
  ]);
  /** What the body actually wrote, one entry per iteration. */
  const revoked = (calls: Array<{ tool: string; params: any }>) =>
    calls.filter(c => c.tool === 'storage').map(c => c.params.value);

  it('runs the body once per item, binding each to `as`', async () => {
    const { ctx, calls } = makeHarness({ storage: text('ok') }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(true);
    expect(result.results[0].iterations).toBe(3);
    expect(result.results[0].itemsFound).toBe(3);
    expect(revoked(calls)).toEqual(['a', 'b', 'c']);
  });

  it('an empty source is a success, not a failure', async () => {
    const { ctx, calls } = makeHarness({ storage: text('ok') }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one' } },
    ]);
    ctx.variableStore = { rows: [] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(true);
    expect(result.results[0].iterations).toBe(0);
    expect(revoked(calls)).toEqual([]);
  });

  it('states the count when nothing ran, so an empty set is not mistaken for a broken selector', async () => {
    const rendered = formatExecutionResults('main', [
      { step: 1, tool: 'forEach', success: true, sequenceName: 'revoke-one', itemsFound: 0, iterations: 0 },
    ], 1, 0);

    expect(rendered).toContain('0 item(s) found, none ran');
  });

  it('filters with `where`, evaluated as JS with item in scope', async () => {
    const { ctx, calls } = makeHarness({
      storage: text('ok'),
      'inspect.evaluateExpression': (params: any) =>
        evaluated(!params.expression.includes('"keep":false')),
    }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one', where: 'item.keep' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a', keep: true }, { id: 'b', keep: false }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].itemsFound).toBe(2);
    expect(result.results[0].iterations).toBe(1);
    expect(revoked(calls)).toEqual(['a']);
  });

  it('fails the step when `where` cannot be evaluated, rather than quietly excluding everything', async () => {
    const { ctx } = makeHarness({
      storage: text('ok'),
      'inspect.evaluateExpression': errorText('SyntaxError'),
    }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one', where: 'item.((' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('could not be evaluated');
  });

  it('stops the run when the body fails, naming which item', async () => {
    const { ctx } = makeHarness({
      storage: (params: any) => (params.value === 'b' ? errorText('nope') : text('ok')),
    }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('item 2/3');
  });

  it('caps iterations and says so rather than silently truncating', async () => {
    const { ctx, calls } = makeHarness({ storage: text('ok') }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one', maxItems: 2 } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].iterations).toBe(2);
    expect(result.results[0].itemsFound).toBe(3);
    expect(revoked(calls)).toEqual(['a', 'b']);
  });

  it('stops between iterations when the run is cancelled', async () => {
    const controller = new AbortController();
    const { ctx, calls } = makeHarness({
      storage: () => { controller.abort(); return text('ok'); },
    }, [body]);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'revoke-one' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

    const result = await executeSteps({
      sequence: main, ctx, startStep: 0, abortSignal: controller.signal,
    });

    expect(result.results[0].success).toBe(false);
    expect(revoked(calls).length).toBeLessThan(3);
  });

  it('reports the missing parameters instead of failing mid-loop', async () => {
    const { ctx } = makeHarness({}, [body]);
    // A selectorAll source, so param interpolation leaves it alone and the
    // step's own validation is what reports.
    const main = seq('main', [{ tool: 'forEach', params: { in: '{{selectorAll:.row}}' } }]);

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('"as"');
    expect(result.results[0].error).toContain('"do"');
  });

  it('names the sequence when the body does not exist', async () => {
    const { ctx } = makeHarness({}, []);
    const main = seq('main', [
      { tool: 'forEach', params: { in: '{{var:rows}}', as: 'row', do: 'no-such-sequence' } },
    ]);
    ctx.variableStore = { rows: [{ id: 'a' }] };

    const result = await executeSteps({ sequence: main, ctx, startStep: 0 });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('no-such-sequence');
  });
});
