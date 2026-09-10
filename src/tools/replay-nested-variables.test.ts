/**
 * `variables` must reach the sequences a run nests into, and a key that lands
 * nowhere must be an error rather than a silent no-op.
 *
 * Both failures ran the same way: the step executed on its RECORDED text while
 * the call read as an override. A recorded credential therefore reached the
 * live app with the run reporting success - the shape that makes it worse than
 * a plain failure, because nothing in the output says the substitution did not
 * happen. A shared login helper reached by a `conditional` is exactly where a
 * supplied password has to land, so the top-level-only substitution missed the
 * one case that matters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const seq = (name: string, commands: RecordedCommand[]): CommandSequence =>
  ({ id: `seq-${name}`, name, commands, createdAt: 1 });

const pageInfo = (url: string) => ({
  content: [{ type: 'text', text: `URL: ${url}` }],
  _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url, title: 't', action: 'info' } },
});

function makeHarness(nested: CommandSequence[]) {
  const typed: Array<{ selector?: string; text: string }> = [];
  const fieldValues = new Map<string, string>();
  const logged: string[] = [];

  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'input' && params.action === 'type') {
      typed.push({ selector: params.selector, text: String(params.text) });
      if (params.selector) fieldValues.set(String(params.selector), String(params.text));
    }
    if (tool === 'navigate' && params.action === 'info') return pageInfo('https://app.example.com/');
    // The executor reads a typed field back and fails the step on a mismatch.
    if (tool === 'inspect' && params.action === 'evaluateExpression') {
      const selector = String(params.expression).match(/querySelector\('([^']*)'\)/)?.[1] ?? '';
      return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(fieldValues.get(selector) ?? '') + '\n```' }] };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    getSequence: (id: string) => nested.find(s => s.id === id),
    getFreshSequence: async (id: string) => nested.find(s => s.id === id),
    listSequences: () => nested,
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connectionReason: 'device-a',
    logPrefix: 'test',
    variableStore: {},
  };

  return { typed, logged, ctx };
}

beforeEach(() => {
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: false, validateNavigation: false, requireDomChanges: false,
    domChangesFailMode: 'warn', failOnConsoleErrors: false,
    consoleErrorsFailMode: 'error', validateNetworkPayload: false,
    networkFailMode: 'warn', postClickDelayMs: 0,
  } as any);
  vi.spyOn(configManager, 'getReplayConfig').mockReturnValue({
    maxConditionalDepth: 10, maxRegexLength: 500, showCursor: false,
    playwrightExportPath: './x', puppeteerExportPath: './y', maxDelayMs: 0,
  } as any);
});

const login = () => seq('login', [
  { tool: 'input', params: { action: 'type', selector: '#password', text: 'recorded-secret' } },
]);

describe('variables reach nested sequences', () => {
  it("substitutes inside a conditional's then sequence", async () => {
    const { typed, ctx } = makeHarness([login()]);
    ctx.variables = { var_0__password: 'supplied-secret' };

    const result = await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:example}}', then: 'login' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(result.results[0].success).toBe(true);
    expect(typed).toEqual([{ selector: '#password', text: 'supplied-secret' }]);
  });

  it("substitutes inside a forEach's do sequence, on every iteration", async () => {
    const { typed, ctx } = makeHarness([seq('fill-row', [
      { tool: 'input', params: { action: 'type', selector: '#cell', text: 'recorded' } },
    ])]);
    ctx.variables = { var_0__cell: 'supplied' };

    await executeSteps({
      sequence: seq('outer', [
        { tool: 'forEach', params: { in: ['a', 'b'], as: 'row', do: 'fill-row' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(typed).toEqual([
      { selector: '#cell', text: 'supplied' },
      { selector: '#cell', text: 'supplied' },
    ]);
  });

  it('reaches a sequence nested two deep', async () => {
    const mid = seq('mid', [{ tool: 'conditional', params: { if: '{{url:contains:example}}', then: 'login' } }]);
    const { typed, ctx } = makeHarness([mid, login()]);
    ctx.variables = { var_0__password: 'supplied-secret' };

    await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:example}}', then: 'mid' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(typed).toEqual([{ selector: '#password', text: 'supplied-secret' }]);
  });

  it('types the recorded text when the context carries no variables', async () => {
    const { typed, ctx } = makeHarness([login()]);

    await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:example}}', then: 'login' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(typed).toEqual([{ selector: '#password', text: 'recorded-secret' }]);
  });

  it('lets the explicit option win over the context, for teardown and direct callers', async () => {
    const { typed, ctx } = makeHarness([]);
    ctx.variables = { var_0__password: 'from-context' };

    await executeSteps({
      sequence: login(),
      ctx,
      startStep: 0,
      variables: { var_0__password: 'from-option' },
    });

    expect(typed).toEqual([{ selector: '#password', text: 'from-option' }]);
  });
});
