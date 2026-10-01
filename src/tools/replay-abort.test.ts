// @vitest-environment node
// (node, not happy-dom: events.getEventListeners only accepts Node's own
// EventTarget, and the hygiene test asserts listener counts on a real signal)
/**
 * Run-signal cancellation (#110, stages 1a/1b): `replay cancel` aborts the
 * run's controller, the executor forwards that signal to every step's tool
 * handler, and the `wait` handler honours it - so cancel interrupts a wait
 * MID-POLL instead of letting it run out its own timeoutMs (measured at
 * ~105s of dead time before this change).
 *
 * Real timers throughout: the interruption tests prove polling STOPPED by
 * watching the poll count over real elapsed time - with fake timers a leaked
 * loop makes no progress and the leak is invisible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { createWaitTools } from './wait-tools.js';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';

// ---------------------------------------------------------------------------
// Harness: an executeToolCall that routes `wait` to the REAL wait handler
// (signal included, ToolError-throwing semantics like index.ts) and returns
// canned responses for everything else.
// ---------------------------------------------------------------------------

interface Call {
  tool: string;
  action?: string;
  params: Record<string, any>;
}

function makeHarness(opts: {
  /** Return value of each evaluateExpressionDetailed poll (default: always false). */
  pollResult?: () => boolean;
  responses?: Record<string, any>;
} = {}) {
  const calls: Call[] = [];
  let pollCount = 0;

  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => false,
    evaluateExpressionDetailed: vi.fn(async () => {
      pollCount++;
      return { rawCaptured: true, rawValue: opts.pollResult ? opts.pollResult() : false };
    }),
  };

  const resolveConnectionByName = async () => ({
    connection: { port: 9222 },
    cdpManager,
    puppeteerManager: {} as any,
  });

  const { wait } = createWaitTools(resolveConnectionByName as any);

  // productionShaped mirrors index.ts: any isError response becomes a thrown
  // ToolError, carrying the response the classifiers read.
  const executeToolCall: ExecuteToolCall = vi.fn(productionShaped(async (tool: string, params: any, abortSignal?: AbortSignal) => {
    if (tool === 'check') return HELD;
    calls.push({ tool, action: params.action, params });
    if (tool === 'wait') {
      return await wait.handler(params as any, abortSignal);
    }
    if (opts.responses && tool in opts.responses) {
      const r = opts.responses[tool];
      return typeof r === 'function' ? r(params) : r;
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    listSequences: vi.fn(() => [] as CommandSequence[]),
    loadSequenceFromDisk: vi.fn(async () => null),
    getFreshSequence: vi.fn(async (id: string) =>
      (commandRecorder.listSequences() as CommandSequence[]).find(s => s.id === id)),
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connection: 'test-conn',
    logPrefix: 'abort-test',
  };

  return {
    calls,
    ctx,
    executeToolCall,
    commandRecorder,
    cdpManager,
    getPollCount: () => pollCount,
    resolveConnectionByName,
    waitTool: wait,
  };
}

const seq = (commands: RecordedCommand[], name = 'abort-seq'): CommandSequence => ({
  id: `seq-${name}`,
  name,
  commands,
  createdAt: 1,
});

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

beforeEach(() => {
  runRegistry.clear();
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: false,
  } as any);
});

// ---------------------------------------------------------------------------
// cancel interrupts a running wait step promptly
// ---------------------------------------------------------------------------

describe('run-signal abort interrupts wait steps', () => {
  it('stops a polling wait mid-step: polls cease and the run settles promptly', { timeout: 10000 }, async () => {
    const h = makeHarness();
    const controller = new AbortController();

    const run = executeSteps({
      sequence: seq([
        { tool: 'wait', params: { selector: '#never', timeoutMs: 120000, pollIntervalMs: 20 } },
        { tool: 'dom', params: { action: 'querySelector', selector: '#after' } },
      ]),
      startStep: 0,
      ctx: h.ctx,
      totalTimeout: 300000,
      abortSignal: controller.signal,
    });

    // Let it genuinely poll a few times, then cancel mid-poll.
    await waitFor(() => h.getPollCount() >= 3);
    const abortedAt = Date.now();
    controller.abort();

    const result = await run;
    expect(Date.now() - abortedAt).toBeLessThan(1000); // not wait's 120s timeoutMs

    // Interruption, not early return: the poll count must NOT grow over a
    // further 500ms of real time.
    const pollsAtSettle = h.getPollCount();
    await new Promise(r => setTimeout(r, 500));
    expect(h.getPollCount()).toBe(pollsAtSettle);

    // Classified as the canonical abort, not a wait failure...
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe('Replay aborted by user');
    // ...with no post-failure diagnostics against the cancelled browser and
    // no subsequent step.
    expect(h.calls.filter(c => ['console', 'network', 'content'].includes(c.tool))).toHaveLength(0);
    expect(h.calls.filter(c => c.tool === 'dom')).toHaveLength(0);
  });

  it('interrupts a wait({ ms }) sleep promptly', { timeout: 10000 }, async () => {
    const h = makeHarness();
    const controller = new AbortController();

    const run = executeSteps({
      sequence: seq([{ tool: 'wait', params: { ms: 60000 } }]),
      startStep: 0,
      ctx: h.ctx,
      totalTimeout: 300000,
      abortSignal: controller.signal,
    });

    await waitFor(() => h.calls.some(c => c.tool === 'wait'));
    const abortedAt = Date.now();
    controller.abort();

    const result = await run;
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    expect(result.results[0].error).toBe('Replay aborted by user');
  });
});

// ---------------------------------------------------------------------------
// the signal reaches sequences a check runs
// ---------------------------------------------------------------------------

describe('run-signal abort inside a sequence a check runs', () => {
  it('stops the nested run promptly (the signal used to be dropped at the executeSteps call)', { timeout: 10000 }, async () => {
    const inner = seq([
      { tool: 'wait', params: { selector: '#never', timeoutMs: 120000, pollIntervalMs: 20 } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#inner-after' } },
    ], 'inner-flow');

    const h = makeHarness({
      responses: {
        dom: { content: [{ type: 'text', text: 'Element found' }] }, // condition met
      },
    });
    h.commandRecorder.listSequences.mockReturnValue([inner]);

    const controller = new AbortController();
    const run = executeSteps({
      sequence: seq([
        runsOnPass('inner-flow'),
      ]),
      startStep: 0,
      ctx: h.ctx,
      totalTimeout: 300000,
      abortSignal: controller.signal,
    });

    // The nested wait is polling; cancel the RUN.
    await waitFor(() => h.getPollCount() >= 3);
    const abortedAt = Date.now();
    controller.abort();

    const result = await run;
    expect(Date.now() - abortedAt).toBeLessThan(1000);

    const pollsAtSettle = h.getPollCount();
    await new Promise(r => setTimeout(r, 500));
    expect(h.getPollCount()).toBe(pollsAtSettle);

    // The check step failed via the nested abort; the substep carries
    // the canonical abort message and the step after the nested wait never ran.
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].substeps?.[0].error).toBe('Replay aborted by user');
    expect(h.calls.some(c => c.params.selector === '#inner-after')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listener hygiene: a long run must not accumulate listeners on the run signal
// ---------------------------------------------------------------------------

describe('run-signal listener hygiene', () => {
  it('leaves no abort listeners on the run signal after a 200-step run', { timeout: 20000 }, async () => {
    // Alternate polls false/true so every wait step exercises one abortable
    // poll sleep (listener attach + detach) before succeeding.
    let flip = false;
    const h = makeHarness({ pollResult: () => (flip = !flip, !flip ? false : true) });
    const controller = new AbortController();

    const commands: RecordedCommand[] = [];
    for (let i = 0; i < 200; i++) {
      commands.push(i % 5 === 0
        ? { tool: 'wait', params: { selector: `#s${i}`, timeoutMs: 5000, pollIntervalMs: 1 } }
        : { tool: 'dom', params: { action: 'querySelector', selector: `#s${i}` }, delay: 1 });
    }

    const result = await executeSteps({
      sequence: seq(commands, 'long-run'),
      startStep: 0,
      ctx: h.ctx,
      totalTimeout: 300000,
      abortSignal: controller.signal,
    });

    expect(result.results).toHaveLength(200);
    expect(result.results.every(r => r.success)).toBe(true);
    expect(getEventListeners(controller.signal as any, 'abort')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// full path: replay({action:'cancel'}) -> controller -> wait handler
// ---------------------------------------------------------------------------

describe('replay cancel end to end', () => {
  it('cancelling a background run interrupts its in-flight wait step', { timeout: 10000 }, async () => {
    const h = makeHarness();
    const sequence = seq([
      { tool: 'wait', params: { selector: '#never', timeoutMs: 120000, pollIntervalMs: 20 } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#after' } },
    ], 'cancel-e2e');

    const recorder = {
      ...h.commandRecorder,
      getSequence: vi.fn((id: string) => (id === sequence.id ? sequence : undefined)),
      getFreshSequence: vi.fn(async (id: string) => (id === sequence.id ? sequence : undefined)),
      listSequences: vi.fn(() => [sequence]),
      getHistory: vi.fn(() => []),
      setActiveSequence: vi.fn(),
      getActiveSequence: vi.fn(() => null),
      getCommandsSincePause: vi.fn(() => []),
    } as any;

    const { replay } = createReplayTools(recorder, h.executeToolCall, async () => null, async () => 9222, undefined);

    const started = await replay.handler({
      action: 'run', sequenceId: sequence.id, connection: 'test-conn',
    } as any);
    const runId = started._meta.replay.runId as string;

    await waitFor(() => h.getPollCount() >= 3);
    const abortedAt = Date.now();
    await replay.handler({ action: 'cancel', runId } as any);

    await waitFor(() => runRegistry.get(runId)!.status === 'cancelled');
    expect(Date.now() - abortedAt).toBeLessThan(2000); // not 120s

    const pollsAtSettle = h.getPollCount();
    await new Promise(r => setTimeout(r, 500));
    expect(h.getPollCount()).toBe(pollsAtSettle);

    const record = runRegistry.get(runId)!;
    expect(record.results.some(r => r.error === 'Replay aborted by user')).toBe(true);
    // Cancelled, not paused: a paused run is still open, and runAll reads this.
    expect(record.finalResponse._meta.replay).toMatchObject({ success: false, cancelled: true, paused: false });
  });
});
