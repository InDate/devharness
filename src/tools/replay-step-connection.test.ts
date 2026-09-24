import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  executeSteps,
  sequenceNeedsConnection,
  analyzeSequenceConnections,
  TOOLS_NEEDING_CONNECTION,
  TOOLS_ACCEPTING_CONNECTION,
  commandTakesInjectedConnection,
} from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { createErrorResponse } from '../messages.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Call {
  tool: string;
  action?: string;
  connectionReason?: string;
  params: Record<string, any>;
}

function makeHarness(responses: Record<string, any> = {}) {
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
  };

  return { calls, ctx, executeToolCall };
}

const seq = (commands: RecordedCommand[]): CommandSequence => ({
  id: 'seq-conn',
  name: 'conn-seq',
  commands,
  createdAt: 1,
});

/** All calls for a tool (optionally an action), in order. */
const find = (calls: Call[], tool: string, action?: string) =>
  calls.filter(c => c.tool === tool && (action === undefined || c.action === action));

beforeEach(() => {
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: true,
    validateNavigation: true,
    requireDomChanges: false,
    domChangesFailMode: 'warn',
    failOnConsoleErrors: true,
    consoleErrorsFailMode: 'error',
    validateNetworkPayload: true,
    networkFailMode: 'warn',
    postClickDelayMs: 0,
  });
});

// ---------------------------------------------------------------------------
// bug-008: inspect + per-step connection
// ---------------------------------------------------------------------------

describe('bug-008: inspect steps and connection resolution', () => {
  it('passes a per-step connectionReason on an inspect step straight through (already worked)', async () => {
    const { calls, ctx } = makeHarness();
    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'location.href', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const evals = find(calls, 'inspect', 'evaluateExpression');
    expect(evals).toHaveLength(1);
    expect(evals[0].connectionReason).toBe('device-b');
  });

  it('injects the run-level connection into an inspect step that has none', async () => {
    const { calls, ctx } = makeHarness();
    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'evaluateExpression', expression: '1+1' } },
      ]),
      startStep: 0,
      ctx,
    });

    const evals = find(calls, 'inspect', 'evaluateExpression');
    expect(evals[0].connectionReason).toBe('device-a');
  });

  it('refreshes a stale callFrameId against the step connection, not the run connection', async () => {
    const { calls, ctx } = makeHarness({
      'inspect.getCallStack': {
        content: [{ type: 'text', text: '{"callFrameId": "fresh-frame"}' }],
      },
    });
    await executeSteps({
      sequence: seq([
        { tool: 'inspect', params: { action: 'getVariables', callFrameId: 'stale', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const stackProbes = find(calls, 'inspect', 'getCallStack');
    // [0] is the run-level pre-run resume probe; [1] is the callFrameId refresh,
    // which must target the step's own connection
    expect(stackProbes[0].connectionReason).toBe('device-a');
    expect(stackProbes[1].connectionReason).toBe('device-b');
    const getVars = find(calls, 'inspect', 'getVariables');
    expect(getVars[0].params.callFrameId).toBe('fresh-frame');
  });

  it('keeps inspect out of the browser-auto-launch list (node sequences must not launch Chrome)', () => {
    expect(TOOLS_NEEDING_CONNECTION).not.toContain('inspect');
    expect(TOOLS_NEEDING_CONNECTION).not.toContain('request');
    expect(TOOLS_ACCEPTING_CONNECTION).toContain('inspect');

    // bench takes a required connectionReason and launches Chrome when the
    // reference is unbound, so a sequence holding one must get it back after
    // the hoist - otherwise the replay fails on a missing parameter.
    expect(TOOLS_NEEDING_CONNECTION).toContain('bench');
    expect(commandTakesInjectedConnection({ tool: 'bench', params: { action: 'start' } })).toBe(true);
    // every browser tool still gets injection
    for (const t of TOOLS_NEEDING_CONNECTION) {
      expect(TOOLS_ACCEPTING_CONNECTION).toContain(t);
    }

    const nodeOnly = [
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: '1' } },
    ] as RecordedCommand[];
    expect(sequenceNeedsConnection(nodeOnly)).toBe(false);
    expect(analyzeSequenceConnections(nodeOnly).firstConnectionToolIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// bug-009: validation / pause machinery around a per-step connection
// ---------------------------------------------------------------------------

describe('bug-009: validation machinery follows the per-step connection', () => {
  it('captures pre-click state and validates the click against the step connection', async () => {
    const { calls, ctx } = makeHarness({
      'input.click': {
        content: [{ type: 'text', text: 'clicked' }],
        _meta: { click: { domChanges: { mutationCount: 3 }, navigationOccurred: true } },
      },
      network: { content: [{ type: 'text', text: '' }], _meta: { network: { totalCount: 0, matchCount: 0 } } },
      console: { content: [{ type: 'text', text: '' }], _meta: { console: { errorCount: 0, warnCount: 0, totalCount: 0 } } },
      navigate: { content: [{ type: 'text', text: 'URL: http://b/' }], _meta: { navigate: { url: 'http://b/' } } },
    });

    await executeSteps({
      sequence: seq([
        { tool: 'input', params: { action: 'click', selector: '#go', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    // calls[0] is the run-level "resume if a previous run left us paused" probe
    expect(calls[0]).toMatchObject({ tool: 'inspect', action: 'getCallStack', connectionReason: 'device-a' });

    // every observation around the click must target device-b (listConnections
    // is the step-connection existence probe - it is session-wide, not per
    // connection, so it carries none)
    for (const c of calls.slice(1).filter(c => c.tool !== 'listConnections')) {
      expect(
        { tool: c.tool, action: c.action, connectionReason: c.connectionReason }
      ).toMatchObject({ connectionReason: 'device-b' });
    }
    // and the machinery really did run
    expect(find(calls, 'console').length).toBeGreaterThanOrEqual(2);
    expect(find(calls, 'navigate', 'info').length).toBeGreaterThanOrEqual(2);
  });

  it('validates navigation of a per-step-connection navigate step against that connection', async () => {
    const { calls, ctx } = makeHarness({
      navigate: { content: [{ type: 'text', text: 'URL: http://b/page' }], _meta: { navigate: { url: 'http://b/page' } } },
    });

    await executeSteps({
      sequence: seq([
        { tool: 'navigate', params: { action: 'goto', url: 'http://b/page', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const infos = find(calls, 'navigate', 'info');
    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(infos.every(c => c.connectionReason === 'device-b')).toBe(true);
  });

  it('validates typed text against the step connection', async () => {
    const { calls, ctx } = makeHarness({
      'inspect.evaluateExpression': { content: [{ type: 'text', text: '```json\n"hello"\n```' }] },
    });

    await executeSteps({
      sequence: seq([
        { tool: 'input', params: { action: 'type', selector: '#f', text: 'hello', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const evals = find(calls, 'inspect', 'evaluateExpression');
    expect(evals).toHaveLength(1);
    expect(evals[0].connectionReason).toBe('device-b');
  });

  it('checks for a breakpoint pause on the step connection', async () => {
    const { calls, ctx } = makeHarness();

    await executeSteps({
      sequence: seq([
        { tool: 'dom', params: { action: 'querySelector', selector: '#x', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    // first probe is the run-level pre-run resume check, second is the post-step check
    const stackProbes = find(calls, 'inspect', 'getCallStack');
    expect(stackProbes.map(c => c.connectionReason)).toEqual(['device-a', 'device-b']);
  });

  it('prefetches the next element on the NEXT step connection', async () => {
    const { calls, ctx } = makeHarness({
      navigate: { content: [{ type: 'text', text: 'URL: http://a/' }], _meta: { navigate: { url: 'http://a/' } } },
    });

    await executeSteps({
      sequence: seq([
        { tool: 'navigate', params: { action: 'goto', url: 'http://a/' } },
        { tool: 'input', params: { action: 'click', selector: '#later', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      endStep: 1,
      ctx,
    });

    const queries = find(calls, 'dom', 'querySelector');
    expect(queries).toHaveLength(1);
    expect(queries[0].params.selector).toBe('#later');
    expect(queries[0].connectionReason).toBe('device-b');
  });

  it('gathers failure diagnostics from the step connection', async () => {
    const { calls, ctx } = makeHarness({
      // From the real helper: a hand-written fixture had neither the `_errorId`
      // the failure classifier prefers nor the "Error: " prefix the template
      // actually emits.
      'dom.querySelector': createErrorResponse('ELEMENT_NOT_FOUND', { selector: '#missing' }),
    });

    await executeSteps({
      sequence: seq([
        { tool: 'dom', params: { action: 'querySelector', selector: '#missing', connectionReason: 'device-b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const networkProbes = find(calls, 'network', 'search');
    const diagnostics = [
      ...find(calls, 'console', 'list'),
      ...networkProbes,
      ...find(calls, 'content', 'findInteractive'),
    ];
    expect(diagnostics.length).toBe(4);   // console + 4xx + 5xx + interactive
    expect(diagnostics.every(c => c.connectionReason === 'device-b')).toBe(true);
    // `network search` rejects a call with no pattern, and reads statusCode as
    // an exact code or an "Nxx" class - `{ statusCode: '4' }` matched nothing
    // and errored before that, losing the whole diagnostic block.
    expect(networkProbes.map(c => c.params.statusCode)).toEqual(['4xx', '5xx']);
    expect(networkProbes.every(c => typeof c.params.pattern === 'string')).toBe(true);
  });

  it('leaves run-level steps on the run connection when another step overrides', async () => {
    const { calls, ctx } = makeHarness();

    await executeSteps({
      sequence: seq([
        { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: 'device-b' } },
        { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
      ]),
      startStep: 0,
      ctx,
    });

    const queries = find(calls, 'dom', 'querySelector');
    expect(queries.map(q => q.connectionReason)).toEqual(['device-b', 'device-a']);
    // pause probes follow suit
    expect(find(calls, 'inspect', 'getCallStack').map(c => c.connectionReason))
      .toEqual(['device-a', 'device-b', 'device-a']);
  });
});

/**
 * The "Page state:" suffix on a failed step. It was silently absent from every
 * failure: the network probe asked for `{ statusCode: '4' }` with no pattern,
 * which the tool rejects outright, so gatherDiagnostics threw and returned ''.
 */
describe('failure diagnostics suffix', () => {
  it('appends the page state to the failing step error', async () => {
    const { ctx } = makeHarness({
      'input.click': createErrorResponse('ELEMENT_NOT_FOUND', { selector: '#go' }),
      'console.list': {
        content: [{ type: 'text', text: 'Console Messages: 0 of 0' }],
        _meta: { tool: 'console', action: 'list', timestamp: 0, console: { totalCount: 7, errorCount: 2 } },
      },
      'network.search': (params: Record<string, any>) => ({
        content: [{ type: 'text', text: 'matches' }],
        _meta: {
          tool: 'network', action: 'search', timestamp: 0,
          network: { totalCount: 9, matchCount: params.statusCode === '4xx' ? 3 : 1 },
        },
      }),
      'content.findInteractive': {
        content: [{ type: 'text', text: 'Interactive Elements' }],
        _meta: { tool: 'content', action: 'findInteractive', timestamp: 0, content: { totalCount: 12 } },
      },
    });

    const result = await executeSteps({
      sequence: seq([{ tool: 'input', params: { action: 'click', selector: '#go' } }]),
      startStep: 0,
      ctx,
    });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('Page state: 12 interactive elements, 2 console errors, 4 failed requests');
  });
});
