import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps, captureVariable } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { createInspectionTools, deformatEvaluatedValue } from './inspection-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

// ---------------------------------------------------------------------------
// Harness (mirrors replay-step-connection.test.ts)
// ---------------------------------------------------------------------------

interface Call {
  tool: string;
  action?: string;
  connectionReason?: string;
  params: Record<string, any>;
}

function makeHarness(responses: Record<string, any> = {}, ctxOverrides: Partial<ExecutionContext> = {}) {
  const calls: Call[] = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, action: params.action, connectionReason: params.connectionReason, params });
    const key = `${tool}.${params.action}`;
    if (key in responses) {
      const r = responses[key];
      return typeof r === 'function' ? r(params) : r;
    }
    if (tool in responses) {
      const r = responses[tool];
      return typeof r === 'function' ? r(params) : r;
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connectionReason: 'device-a',
    logPrefix: 'test',
    ...ctxOverrides,
  };

  return { calls, ctx, executeToolCall };
}

const seq = (commands: RecordedCommand[]): CommandSequence => ({
  id: 'seq-capture',
  name: 'capture-seq',
  commands,
  createdAt: 1,
});

const find = (calls: Call[], tool: string, action?: string) =>
  calls.filter(c => c.tool === tool && (action === undefined || c.action === action));

const evalResponse = (value: unknown, expression = 'x') => ({
  content: [{ type: 'text', text: 'evaluated' }],
  _meta: {
    tool: 'inspect',
    action: 'evaluateExpression',
    timestamp: 1,
    inspect: { expression, value, valueType: typeof value },
  },
});

beforeEach(() => {
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: false,
    validateNavigation: false,
    requireDomChanges: false,
    domChangesFailMode: 'warn',
    failOnConsoleErrors: false,
    consoleErrorsFailMode: 'error',
    validateNetworkPayload: false,
    networkFailMode: 'warn',
    postClickDelayMs: 0,
  } as any);
});

// ---------------------------------------------------------------------------
// inspection-tools: structured _meta for evaluateExpression
// ---------------------------------------------------------------------------

describe('deformatEvaluatedValue', () => {
  it('reverses formatValue display shaping for primitives', () => {
    expect(deformatEvaluatedValue('"hello"')).toBe('hello');
    expect(deformatEvaluatedValue('42')).toBe(42);
    expect(deformatEvaluatedValue('-1.5e3')).toBe(-1500);
    expect(deformatEvaluatedValue('true')).toBe(true);
    expect(deformatEvaluatedValue('false')).toBe(false);
    expect(deformatEvaluatedValue('null')).toBe(null);
    expect(deformatEvaluatedValue('undefined')).toBe(undefined);
  });

  it('keeps a quoted numeric string a string (the quoting is the type signal)', () => {
    expect(deformatEvaluatedValue('"42"')).toBe('42');
    expect(deformatEvaluatedValue('"true"')).toBe('true');
  });

  it('recurses through objects and arrays', () => {
    expect(deformatEvaluatedValue({ id: '7', name: '"kit"', ok: 'true' }))
      .toEqual({ id: 7, name: 'kit', ok: true });
    expect(deformatEvaluatedValue(['"a"', '2'])).toEqual(['a', 2]);
  });

  it('leaves unrecoverable descriptions as-is', () => {
    expect(deformatEvaluatedValue('[HTMLDivElement]')).toBe('[HTMLDivElement]');
    expect(deformatEvaluatedValue('Array(3)')).toBe('Array(3)');
  });
});

describe('inspect({ action: "evaluateExpression" }) _meta', () => {
  // The handler now calls evaluateExpressionDetailed (bug-015). These helpers
  // simulate the rawCaptured: false path (display-derived fallback) unless a
  // detailed result is provided explicitly.
  function makeInspectTool(evaluate: (...args: any[]) => Promise<any>) {
    const cdpManager = {
      evaluateExpressionDetailed: vi.fn(async (...args: any[]) => ({
        formatted: await evaluate(...args),
        rawCaptured: false,
      })),
    } as any;
    const sourceMapHandler = {} as any;
    return createInspectionTools(sourceMapHandler, async () => ({ cdpManager }) as any).inspect;
  }

  function makeInspectToolDetailed(detailed: (...args: any[]) => Promise<any>) {
    const cdpManager = { evaluateExpressionDetailed: vi.fn(detailed) } as any;
    return createInspectionTools({} as any, async () => ({ cdpManager }) as any).inspect;
  }

  it('prefers the exact by-value capture over the display reconstruction (bug-015)', async () => {
    const tool = makeInspectToolDetailed(async () => ({
      formatted: { token: '"t-1"', count: '3' },
      rawValue: { token: 't-1', count: 3, quotedNumber: '42' },
      rawCaptured: true,
    }));
    const res = await tool.handler({ action: 'evaluateExpression', connectionReason: 'app', expression: 'state' } as any);
    // '42' stays a string - no deformat quoting heuristics applied to exact captures.
    expect(res._meta.inspect.value).toEqual({ token: 't-1', count: 3, quotedNumber: '42' });
    expect(res._meta.inspect.valueSource).toBe('exact');
  });

  it('requests promise awaiting and raw capture from the manager by default', async () => {
    const detailed = vi.fn(async () => ({ formatted: '1', rawValue: 1, rawCaptured: true }));
    const tool = makeInspectToolDetailed(detailed);
    await tool.handler({ action: 'evaluateExpression', connectionReason: 'app', expression: '1' } as any);
    expect(detailed).toHaveBeenCalledWith('1', undefined, true, 2, {
      awaitPromise: true,
      captureRaw: true,
    });
  });

  it('passes awaitPromise: false through when the caller opts out', async () => {
    const detailed = vi.fn(async () => ({ formatted: 'Promise', rawCaptured: false }));
    const tool = makeInspectToolDetailed(detailed);
    await tool.handler({ action: 'evaluateExpression', connectionReason: 'app', expression: 'p', awaitPromise: false } as any);
    expect(detailed).toHaveBeenCalledWith('p', undefined, true, 2, {
      awaitPromise: false,
      captureRaw: true,
    });
  });

  it('publishes a machine-readable value alongside the text', async () => {
    const tool = makeInspectTool(async () => '"https://pair.example/abc"');
    const res = await tool.handler({
      action: 'evaluateExpression',
      connectionReason: 'app',
      expression: 'window.pairingUrl',
    } as any);

    expect(res._meta).toMatchObject({
      tool: 'inspect',
      action: 'evaluateExpression',
      inspect: {
        expression: 'window.pairingUrl',
        value: 'https://pair.example/abc',
        valueType: 'string',
      },
    });
    // text output is untouched
    expect(res.content[0].text).toContain('window.pairingUrl');
  });

  it('carries object results through as structured data', async () => {
    const tool = makeInspectTool(async () => ({ token: '"t-1"', count: '3' }));
    const res = await tool.handler({ action: 'evaluateExpression', connectionReason: 'app', expression: 'state' } as any);
    expect(res._meta.inspect.value).toEqual({ token: 't-1', count: 3 });
    expect(res._meta.inspect.valueType).toBe('object');
  });

  it('records the call frame when evaluating on a paused frame', async () => {
    const tool = makeInspectTool(async () => '1');
    const res = await tool.handler({
      action: 'evaluateExpression',
      connectionReason: 'app',
      expression: 'x',
      callFrameId: 'frame-7',
    } as any);
    expect(res._meta.inspect.callFrameId).toBe('frame-7');
  });

  it('accepts saveAs as a step param without breaking the strict schema', () => {
    const tool = makeInspectTool(async () => '1');
    const parsed = tool.zodSchema.safeParse({
      action: 'evaluateExpression',
      connectionReason: 'app',
      expression: 'x',
      saveAs: 'pairingUrl',
    });
    expect(parsed.success).toBe(true);
  });

  it('emits no capturable _meta on error responses', async () => {
    const tool = makeInspectTool(async () => { throw new Error('boom'); });
    const res = await tool.handler({ action: 'evaluateExpression', connectionReason: 'app', expression: 'x' } as any);
    expect(res.isError).toBe(true);
    expect(res._meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// captureVariable table
// ---------------------------------------------------------------------------

describe('captureVariable', () => {
  it('stores the whole response object for request (unchanged behaviour)', () => {
    const meta = { request: { ok: true, status: 200, body: '{"a":1}' } };
    expect(captureVariable('request', { saveAs: 'r' }, { _meta: meta }))
      .toEqual({ ok: true, value: meta.request });
  });

  it('stores the evaluated value itself for inspect', () => {
    const result = { _meta: { inspect: { expression: 'x', value: 'abc', valueType: 'string' } } };
    expect(captureVariable('inspect', { saveAs: 'v' }, result)).toEqual({ ok: true, value: 'abc' });
  });

  it('rejects saveAs on a tool with no capture source', () => {
    const captured = captureVariable('dom', { saveAs: 'v', action: 'querySelector' }, {});
    expect(captured.ok).toBe(false);
    expect((captured as any).error).toContain('not supported on "dom"');
  });

  it('rejects saveAs on an inspect action that produces no value', () => {
    const captured = captureVariable('inspect', { saveAs: 'v', action: 'getCallStack' }, { _meta: {} });
    expect(captured.ok).toBe(false);
    expect((captured as any).error).toContain('evaluateExpression');
  });
});

// ---------------------------------------------------------------------------
// executor: end-to-end capture + interpolation
// ---------------------------------------------------------------------------

describe('feature-014: capturing sequence variables from inspect steps', () => {
  it('captures an inspect({ saveAs }) value and interpolates it into a later step', async () => {
    const { calls, ctx } = makeHarness({
      'inspect.evaluateExpression': evalResponse('https://pair.example/abc', 'window.pairingUrl'),
    });

    const result = await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'window.pairingUrl', saveAs: 'pairingUrl' } },
        { tool: 'navigate', params: { action: 'goto', url: '{{var:pairingUrl}}' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(result.results.every(r => r.success)).toBe(true);
    expect(ctx.variableStore).toEqual({ pairingUrl: 'https://pair.example/abc' });
    expect(find(calls, 'navigate', 'goto')[0].params.url).toBe('https://pair.example/abc');
  });

  it('preserves the real type of a captured value and allows path access', async () => {
    const { calls, ctx } = makeHarness({
      'inspect.evaluateExpression': evalResponse({ user: { id: 7 }, ready: true }, 'state'),
    });

    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'state', saveAs: 'state' } },
        { tool: 'assert', params: { left: '{{var:state.user.id}}', operator: 'equals', right: 7 } },
      ]),
      startStep: 0,
      ctx,
    });

    const assertCall = find(calls, 'assert')[0];
    expect(assertCall.params.left).toBe(7);
  });

  it('fails the step (and stops the run) when saveAs cannot be honoured', async () => {
    const { ctx } = makeHarness({
      'inspect.getCallStack': { content: [{ type: 'text', text: '' }] },
    });

    const result = await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'getCallStack', saveAs: 'frames' } },
        { tool: 'navigate', params: { action: 'goto', url: 'http://a/' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('saveAs');
    // run stopped - the second step never ran
    expect(result.results).toHaveLength(1);
  });

  it('still captures request({ saveAs }) as the whole response object', async () => {
    const { calls, ctx } = makeHarness({
      request: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { request: { ok: true, status: 200, body: '{"token":"t-9"}' } },
      },
    });

    await executeSteps({
      sequence: seq([
        { tool: 'request', params: { url: 'http://api/', method: 'POST', saveAs: 'login' } },
        { tool: 'navigate', params: { action: 'goto', url: 'http://a/?t={{var:login.body.token}}' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(ctx.variableStore!.login.status).toBe(200);
    expect(find(calls, 'navigate', 'goto')[0].params.url).toBe('http://a/?t=t-9');
  });
});

// ---------------------------------------------------------------------------
// hardening: one shared variable store, even from a hand-built ctx
// ---------------------------------------------------------------------------

describe('feature-014: variable store is seeded once and shared by reference', () => {
  it('seeds the caller ctx store when it was never provided', async () => {
    const { ctx } = makeHarness({
      'inspect.evaluateExpression': evalResponse('v1'),
    });
    expect(ctx.variableStore).toBeUndefined();

    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'x', saveAs: 'a' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(ctx.variableStore).toEqual({ a: 'v1' });
  });

  it('a capture on a per-step-connection step lands in the run-level store', async () => {
    const { calls, ctx } = makeHarness({
      'inspect.evaluateExpression': evalResponse('from-device-b'),
    });

    await executeSteps({
      sequence: seq([
        // step runs on its own connection -> executor uses a cloned stepCtx
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'x', connectionReason: 'device-b', saveAs: 'b' } },
        { tool: 'navigate', params: { action: 'goto', url: '{{var:b}}' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(ctx.variableStore).toEqual({ b: 'from-device-b' });
    expect(find(calls, 'navigate', 'goto')[0].params.url).toBe('from-device-b');
    // and the step really did run on its own connection (no regression)
    expect(find(calls, 'inspect', 'evaluateExpression')[0].connectionReason).toBe('device-b');
  });

  it('keeps an externally supplied store object identity', async () => {
    const store: Record<string, any> = { seeded: 'yes' };
    const { ctx } = makeHarness({ 'inspect.evaluateExpression': evalResponse('v') }, { variableStore: store });

    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'x', saveAs: 'a' } },
      ]),
      startStep: 0,
      ctx,
    });

    expect(ctx.variableStore).toBe(store);
    expect(store).toEqual({ seeded: 'yes', a: 'v' });
  });
});
