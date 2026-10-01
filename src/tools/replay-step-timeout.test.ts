import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps, executeSequenceWithPause } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { getMessage } from '../messages.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

// ---------------------------------------------------------------------------
// Harness (same style as replay-step-connection.test.ts)
// ---------------------------------------------------------------------------

interface Call {
  tool: string;
  action?: string;
  params: Record<string, any>;
}

function makeHarness(responses: Record<string, any> = {}) {
  const calls: Call[] = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, action: params.action, params });
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
    connection: 'device-a',
    logPrefix: 'test',
  };

  return { calls, ctx, executeToolCall };
}

const seq = (commands: RecordedCommand[]): CommandSequence => ({
  id: 'seq-timeout',
  name: 'timeout-seq',
  commands,
  createdAt: 1,
});

/** A promise that never settles - simulates a hung tool call. */
const hangForever = () => new Promise<never>(() => {});

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
// stepTimeout enforcement
// ---------------------------------------------------------------------------

describe('stepTimeout enforcement', () => {
  // NOTE: against pre-fix code this test HANGS (stepTimeout was accepted but
  // never enforced) - the it() timeout of 2000ms is what terminates it.
  it('fails a hanging step at stepTimeout instead of hanging the run', { timeout: 2000 }, async () => {
    const { calls, ctx } = makeHarness({
      'inspect.evaluateExpression': () => hangForever(),
    });

    const start = Date.now();
    const result = await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'hang()' } },
        { tool: 'navigate', params: { action: 'info' } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 100,
      totalTimeout: 300000,
    });
    const elapsed = Date.now() - start;

    // Failed at its bound, not at totalTimeout and not never
    expect(elapsed).toBeLessThan(1500);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].step).toBe(1);
    expect(result.results[0].tool).toBe('inspect');
    // Error names the step, the tool, and the bound
    expect(result.results[0].error).toContain('Step 1');
    expect(result.results[0].error).toContain('inspect');
    expect(result.results[0].error).toContain('100ms');
    expect(result.results[0].error).not.toContain('Message not found');

    // Run stopped - same semantics as any other step failure (no step 2 ran)
    const navCalls = calls.filter(c => c.tool === 'navigate');
    expect(navCalls).toHaveLength(0);
  });

  it('bounds a hanging step by remaining totalTimeout when that is smaller than stepTimeout', { timeout: 2000 }, async () => {
    const { ctx } = makeHarness({
      'inspect.evaluateExpression': () => hangForever(),
    });

    const start = Date.now();
    const result = await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'hang()' } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 60000,
      totalTimeout: 120, // remaining total < stepTimeout -> total wins
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('totalTimeout');
  });

  it('does not disturb steps that complete within the bound', async () => {
    const { ctx } = makeHarness();

    const result = await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '1+1' } },
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '2+2' } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 5000,
      totalTimeout: 300000,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.success)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wait steps are exempt from stepTimeout (they carry their own timeoutMs)
// ---------------------------------------------------------------------------

describe('stepTimeout and wait steps', () => {
  it('does not kill a wait step that outlives stepTimeout (wait has its own timeoutMs bound)', { timeout: 2000 }, async () => {
    const { ctx } = makeHarness({
      wait: () => new Promise(resolve =>
        setTimeout(() => resolve({ content: [{ type: 'text', text: 'Condition met' }] }), 200)),
    });

    const result = await executeSteps({
      sequence: seq([
        { tool: 'wait', params: { for: 'selector', selector: '.late', timeoutMs: 5000 } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 50, // far below the wait's legitimate duration
      totalTimeout: 300000,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(true);
  });

  it('still bounds a hung wait step by remaining totalTimeout', { timeout: 2000 }, async () => {
    const { ctx } = makeHarness({
      wait: () => hangForever(),
    });

    const start = Date.now();
    const result = await executeSteps({
      sequence: seq([
        { tool: 'wait', params: { for: 'time', durationMs: 999999 } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 30000,
      totalTimeout: 120,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1500);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('totalTimeout');
  });
});

// ---------------------------------------------------------------------------
// pausing (replay step / stepTo) is unaffected
// ---------------------------------------------------------------------------

describe('stepTimeout and pause interaction', () => {
  it('a stepTo pause still works with a small stepTimeout (pause happens between steps)', async () => {
    const { ctx } = makeHarness();

    const result = await executeSequenceWithPause({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '1' } },
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '2' } },
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '3' } },
      ]),
      startStep: 0,
      ctx,
      stepTimeout: 500,
      totalTimeout: 300000,
      stepTo: 2,
    });

    expect(result.pausedAtStep).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.success)).toBe(true);
    expect(result.activeSequenceState).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// message template exists
// ---------------------------------------------------------------------------

describe('REPLAY_STEP_TIMEOUT template', () => {
  it('renders with step, tool and timeout substituted', () => {
    const msg = getMessage('REPLAY_STEP_TIMEOUT', {
      step: 3, tool: 'input', timeoutMs: 30000, limitSource: 'stepTimeout',
    });
    expect(msg).not.toContain('Message not found');
    expect(msg).toContain('3');
    expect(msg).toContain('input');
    expect(msg).toContain('30000');
  });
});
