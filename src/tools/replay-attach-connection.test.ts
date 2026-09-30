/**
 * A Node.js debugging sequence is an attach followed by bare `breakpoint` and
 * `inspect` steps. Those steps reach their connection only through the one the
 * run carries, so the run has to take it from the attach step, and `repeat`
 * has to fill it in for every tool that takes one, not only browser tools.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

function makeHarness() {
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    return { content: [{ type: 'text', text: '' }] };
  }));
  const recorder = new CommandRecorder();
  const { replay } = createReplayTools(recorder, executeToolCall as any, async () => null, async () => null, undefined);
  return { calls, replay, recorder };
}

/** The connection each call of `tool` ran against, in order. */
const connectionsOf = (calls: Array<{ tool: string; params: Record<string, any> }>, tool: string) =>
  calls.filter(c => c.tool === tool).map(c => c.params.connectionReason);

describe('a run of an attach followed by bare steps', () => {
  it('runs the bare steps on the connection the attach created', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.createSequenceFromCommands('node-debug', [
      { tool: 'connection', params: { action: 'attach', name: 'api-server', port: 9229 } },
      { tool: 'breakpoint', params: { action: 'set', url: 'file:///app/server.js', lineNumber: 10 } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'process.pid' } },
    ]);

    await replay.handler({ action: 'run', wait: true, name: 'node-debug' } as any);

    expect(connectionsOf(calls, 'breakpoint')).toEqual(['api-server']);
    expect(connectionsOf(calls, 'inspect')).toEqual(['api-server']);
  });
});

describe('repeat', () => {
  it('fills the given connection into a bare inspect step', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: 'process.pid' });

    await replay.handler({ action: 'repeat', indices: [0], connectionReason: 'api-server' } as any);

    expect(connectionsOf(calls, 'inspect')).toEqual(['api-server']);
  });

  it('takes the connection from an attach among the repeated calls', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.recordCommand('connection', { action: 'attach', name: 'api-server', port: 9229 });
    await recorder.recordCommand('execution', { action: 'resume' });

    await replay.handler({ action: 'repeat', indices: [0, 1] } as any);

    expect(connectionsOf(calls, 'execution')).toEqual(['api-server']);
  });

  it('refuses a bare inspect step when no connection can be determined', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: 'process.pid' });

    const result: any = await replay.handler({ action: 'repeat', indices: [0] } as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('connectionReason');
    expect(calls.filter(c => c.tool === 'inspect')).toEqual([]);
  });
});
