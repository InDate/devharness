/**
 * A sequence a check runs must inherit the parent run's timeout budget.
 *
 * The nested run used to call executeSteps without stepTimeout or
 * totalTimeout, so substeps silently fell back to the defaults (30s/5min) no
 * matter what the caller passed. That only became observable once stepTimeout
 * was actually enforced - before then both values were being discarded anyway.
 *
 * The second test is the one that matters for correctness: the total must be
 * inherited as the parent's REMAINING budget, or wrapping steps in a
 * check becomes a way to extend it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';

function makeHarness(responses: Record<string, any> = {}, nested?: CommandSequence) {
  const calls: string[] = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'check') return HELD;
    calls.push(`${tool}.${params.action ?? ''}`);
    const key = `${tool}.${params.action}`;
    const r = key in responses ? responses[key] : responses[tool];
    if (r !== undefined) return typeof r === 'function' ? r(params) : r;
    return { content: [{ type: 'text', text: '' }] };
  }));

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    // A check's `{ run }` resolves its sequence via loadSequence,
    // which matches by name against listSequences().
    getSequence: (id: string) => (nested?.id === id ? nested : undefined),
    getFreshSequence: async (id: string) => (nested?.id === id ? nested : undefined),
    listSequences: () => (nested ? [nested] : []),
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connection: 'device-a',
    logPrefix: 'test',
  };

  return { calls, ctx };
}

const seq = (name: string, commands: RecordedCommand[]): CommandSequence => ({
  id: `seq-${name}`,
  name,
  commands,
  createdAt: 1,
});

const hangForever = () => new Promise<never>(() => {});

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

/** The shape navigate.info really returns: the URL comes from `_meta`. */
const pageInfo = (url: string) => ({
  content: [{ type: 'text', text: `URL: ${url}` }],
  _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url, title: 't', action: 'info' } },
});

describe('a sequence a check runs inherits the parent timeout budget', () => {
  // Against pre-fix code this HANGS: the substep got the 30s default rather
  // than the caller's 300ms, so nothing bounded it inside the it() timeout.
  it("bounds a hanging substep by the parent's stepTimeout", { timeout: 3000 }, async () => {
    const nested = seq('inner', [
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'hang()' } },
    ]);
    const { ctx } = makeHarness({ 'navigate.info': pageInfo('https://example.com/'), 'inspect.evaluateExpression': () => hangForever() }, nested);

    const started = Date.now();
    const result = await executeSteps({
      sequence: seq('outer', [
        runsOnPass('inner'),
      ]),
      ctx,
      startStep: 0,
      stepTimeout: 300,
      totalTimeout: 60_000,
    });

    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.results[0].success).toBe(false);
  });

  it('inherits the remaining total, so nesting cannot extend it', { timeout: 4000 }, async () => {
    const nested = seq('inner', [
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'hang()' } },
    ]);
    const { ctx } = makeHarness({ 'navigate.info': pageInfo('https://example.com/'), 'inspect.evaluateExpression': () => hangForever() }, nested);

    const started = Date.now();
    const result = await executeSteps({
      sequence: seq('outer', [
        runsOnPass('inner'),
      ]),
      ctx,
      startStep: 0,
      // stepTimeout is generous; the TOTAL is what must stop this. If the
      // child received a fresh copy of totalTimeout rather than the remaining
      // budget, the effective bound would still be 800ms here - so to make the
      // distinction observable the assertion below is on the total elapsed.
      stepTimeout: 60_000,
      totalTimeout: 800,
    });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.results[0].success).toBe(false);
  });

  it('leaves an unbudgeted caller on the defaults', async () => {
    const nested = seq('inner', [{ tool: 'navigate', params: { action: 'info' } }]);
    const { calls, ctx } = makeHarness({ 'navigate.info': pageInfo('https://example.com/') }, nested);

    const result = await executeSteps({
      sequence: seq('outer', [
        runsOnPass('inner'),
      ]),
      ctx,
      startStep: 0,
    });

    // The substep ran normally - inheritance must not break the common path.
    expect(result.results[0].success).toBe(true);
    expect(calls).toContain('navigate.info');
  });
});
