/**
 * `saveAs` and a sequence's assertions read `_meta.inspect.value`
 * (CAPTURE_SOURCES in replay-executor.ts), never the rendered text. An evaluation inside a
 * worker target takes a different code path from the page's, so if it renders
 * the value but omits the meta, every capture and every assertion downstream
 * of it silently sees nothing while the step reports success.
 */

import { describe, it, expect, vi } from 'vitest';
import { createInspectionTools } from './inspection-tools.js';
import { WorkerTargetNotFoundError, WorkerTargetAmbiguousError } from '../worker-targets.js';

const fakeSourceMapHandler = { mapToOriginal: vi.fn(async () => null) } as any;

function makeInspect(registry: any, endpoint: { host: string; port: number } | null = { host: 'localhost', port: 9222 }) {
  const cdpManager = {
    isConnected: () => true,
    getEndpoint: () => endpoint,
  } as any;
  const tools = createInspectionTools(
    fakeSourceMapHandler,
    async () => ({ cdpManager }) as any,
    () => registry as any
  );
  return tools.inspect;
}

describe('inspect evaluateExpression inside a worker target', () => {
  it('carries the evaluated value in _meta, which is what saveAs captures', async () => {
    const inspect = makeInspect({ evaluate: async () => 'http://localhost:5173/' });

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'sw.js',
      expression: 'self.registration.scope',
    });

    expect(result._meta.inspect).toMatchObject({
      expression: 'self.registration.scope',
      value: 'http://localhost:5173/',
      valueType: 'string',
      valueSource: 'exact',
      workerTarget: 'sw.js',
    });
  });

  it('captures a structured value by value, not through display text', async () => {
    const inspect = makeInspect({ evaluate: async () => ({ scope: '/', clients: 2 }) });

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'sw.js',
      expression: '({ scope: self.registration.scope, clients: 2 })',
    });

    expect(result._meta.inspect.value).toEqual({ scope: '/', clients: 2 });
  });

  it('reports the evaluated value in the text as well', async () => {
    const inspect = makeInspect({ evaluate: async () => 42 });

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'sw.js',
      expression: '42',
    });

    expect(result.content.map((c: any) => c.text).join('\n')).toContain('42');
  });

  it('passes awaitPromise through to the worker client', async () => {
    const evaluate = vi.fn(async () => 'done');
    const inspect = makeInspect({ evaluate });

    await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'sw.js',
      expression: 'p',
      awaitPromise: false,
    });

    expect(evaluate).toHaveBeenCalledWith('sw.js', 'p', false);
  });

  it('fails rather than capturing nothing when the reference matches no target', async () => {
    const inspect = makeInspect({
      evaluate: async () => {
        throw new WorkerTargetNotFoundError('absent.js', [
          { targetId: 'sw-1', type: 'service_worker', url: 'http://localhost:5173/sw.js', attached: false },
        ]);
      },
    });

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'absent.js',
      expression: '1',
    });

    expect(result.isError).toBe(true);
    expect(result._errorId).toBe('WORKER_TARGET_NOT_FOUND');
    expect(result._meta?.inspect).toBeUndefined();
  });

  it('fails rather than choosing when the reference matches two targets', async () => {
    const inspect = makeInspect({
      evaluate: async () => {
        throw new WorkerTargetAmbiguousError('worker.js', [
          { targetId: 'w-1', type: 'worker', url: 'http://localhost:5173/worker.js', attached: false },
          { targetId: 'w-2', type: 'worker', url: 'http://localhost:5173/second-worker.js', attached: false },
        ]);
      },
    });

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'worker.js',
      expression: '1',
    });

    expect(result._errorId).toBe('WORKER_TARGET_AMBIGUOUS');
  });

  it('reports no connection rather than reaching for a registry', async () => {
    const evaluate = vi.fn();
    const inspect = makeInspect({ evaluate }, null);

    const result: any = await inspect.handler({
      connection: 'app',
      action: 'evaluateExpression',
      target: 'sw.js',
      expression: '1',
    });

    expect(result.isError).toBe(true);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('inspect listTargets', () => {
  it('carries the targets in _meta, so behaviour reads them rather than the table', async () => {
    const targets = [
      { targetId: 'sw-1', type: 'service_worker', url: 'http://localhost:5173/sw.js', attached: true },
      { targetId: 'w-1', type: 'worker', url: 'http://localhost:5173/worker.js', attached: false },
    ];
    const inspect = makeInspect({ list: async () => targets });

    const result: any = await inspect.handler({ action: 'listTargets', connection: 'app' });

    expect(result._meta.workerTargets).toEqual(targets);
    expect(result.content.map((c: any) => c.text).join('\n')).toContain('sw.js');
  });
});
