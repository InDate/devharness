/**
 * A run's reply: its steps from the run's first step, a resume included, and
 * each pause listed where it stood between them.
 */
import { describe, it, expect } from 'vitest';
import { formatRunReply } from './run-table.js';
import { CommandRecorder } from '../command-recorder.js';
import { executeSteps } from './replay-executor.js';
import { historyPlace } from '../call-origin.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import type { Crossing } from '../bench/step-compare.js';
import type { RunRules } from './run-rules.js';

/** History as the reply reads it, newest first: the run's four steps at entries 3, 4, 7 and 8. */
function recorder(): CommandRecorder {
  const steps = [
    { index: 3, run: 'sse', runStep: 0 },
    { index: 4, run: 'sse', runStep: 1 },
    { index: 7, run: 'sse', runStep: 2 },
    { index: 8, run: 'sse', runStep: 3 },
  ].map(step => ({ ...step, tool: 'input', params: {}, timestamp: step.index, result: { content: [] } }));
  return { getHistory: () => [...steps].reverse() } as unknown as CommandRecorder;
}

const answer = { key: '/sse', verb: 'answer' as const, label: '/sse price', from: 'this sequence', pin: 'pin-1' };
const rules: RunRules = { rules: [answer], ignores: [] };

function answered(id: string): Crossing {
  return { id, at: 1, kind: 'frame', url: 'http://app.test/sse', direction: 'in', runId: 'run-a', step: 2, paused: true,
    answeredBy: 'pin-1' } as Crossing;
}

describe('the reply after a resume', () => {
  it('counts every step of the run from its first step, not from the resume', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2 });
    expect(reply.split('\n')[0]).toBe('sse completed 4 of 4 · 4 passed');
  });

  it('counts only the steps after `since` where the reply starts at the resume', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 5 });
    expect(reply.split('\n')[0]).toBe('sse completed 4 of 4 · 2 passed');
  });
});

describe('a pause in the reply', () => {
  it('is listed between the step before it and the step it resumed at', () => {
    const pauses = new Map([[2, [answered('ev-1'), answered('ev-2')]]]);
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, steps: 'all', rules, pauses });
    const rows = reply.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| step') && !line.startsWith('| rule'));
    expect(rows.map(row => row.split('|')[1].trim())).toEqual(['1', '2', 'paused before 3', '3', '4', '/sse price']);
    expect(rows[2]).toContain('2 frames: 2 answered');
  });

  it('is counted in the rules block where a rule acted in it', () => {
    const pauses = new Map([[2, [answered('ev-1')]]]);
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, rules, pauses });
    expect(reply).toContain('| /sse price | answer | this sequence | paused before 3: 1 |');
  });

  it('lists no row after the last step', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, steps: 'all', rules });
    expect(reply).not.toMatch(/\| after \|/);
    expect(reply).toContain('| /sse price | answer | this sequence | never fired |');
  });
});

describe('a step that fails before its call is recorded', () => {
  it('is the failed step, with its reason, and the step before it, of the same tool, passes', async () => {
    const history = new CommandRecorder();
    const executeToolCall = productionShaped(async (tool: string, params: Record<string, any>) => {
      const result = { content: [{ type: 'text', text: tool === 'input' ? `Clicked element \`${params.selector}\`` : '' }] };
      const place = historyPlace();
      if (place) await history.recordCommand(tool, params, { ...place, result });
      return result;
    });
    const sequence = { id: 'seq-env', name: 'env-token-search', createdAt: 1, commands: [
      { tool: 'input', params: { action: 'click', selector: 'search-shell' } },
      { tool: 'input', params: { action: 'type', text: '{{env:SOCKET_APP_TOKEN_UNSET}}' } },
    ] };

    const execution = await executeSteps({
      sequence, startStep: 0,
      ctx: { executeToolCall, commandRecorder: history, connection: 'app', variableStore: {}, runEnv: {} } as any,
    });
    const reply = formatRunReply(history, {
      name: 'env-token-search', total: 2, since: -1,
      failures: new Map(execution.results.filter(r => !r.success).map(r => [r.step, r.error!])),
    });

    expect(reply.split('\n')[0]).toBe('env-token-search failed at step 2 of 2 · 1 passed');
    expect(reply).toContain('Step 2: Could not resolve template token {{env:SOCKET_APP_TOKEN_UNSET}}');
    expect(reply).not.toContain('Clicked element');
  });
});
