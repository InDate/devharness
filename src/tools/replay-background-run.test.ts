/**
 * Background runs: `replay({ action: 'run' })` returns a run id immediately
 * and executes in the background; `status`/`cancel` address a run by that id.
 * `wait: true` restores the pre-0.7 blocking behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import { runRegistry } from './replay-run-registry.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';

function makeReplay(sequences: CommandSequence[], opts: { stepDelayMs?: number } = {}) {
  const byId = new Map(sequences.map(s => [s.id, s]));

  const recorder = {
    getSequence: vi.fn((id: string) => byId.get(id)),
    getFreshSequence: vi.fn(async (id: string) => byId.get(id)),
    listSequences: vi.fn(() => sequences),
    loadSequenceFromDisk: vi.fn(async () => null),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn(),
    getActiveSequence: vi.fn(() => null),
    getCommandsSincePause: vi.fn(() => []),
  } as any;

  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'check') return HELD;
    calls.push({ tool, params });
    if (tool === 'dom' && opts.stepDelayMs) {
      await new Promise(r => setTimeout(r, opts.stepDelayMs));
    }
    if (tool === 'dom' && params.action === 'querySelector') {
      return { content: [{ type: 'text', text: 'Element found' }] };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const { replay } = createReplayTools(
    recorder,
    executeToolCall,
    async () => null,   // no page -> no cursor/overlay injection
    async () => 9222,
    undefined
  );

  return { replay, recorder, calls, executeToolCall };
}

const seq = (id: string, name: string, commands: RecordedCommand[]): CommandSequence =>
  ({ id, name, commands, createdAt: 1 });

const domStep = (selector: string): RecordedCommand =>
  ({ tool: 'dom', params: { action: 'querySelector', selector } });

const text = (res: any) => res.content[0].text as string;

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

beforeEach(() => {
  runRegistry.clear();
});

describe('background run', () => {
  it('returns a runId immediately and the results are retrievable via status', async () => {
    const { replay, calls } = makeReplay(
      [seq('seq-a', 'flow-a', [domStep('#a'), domStep('#b'), domStep('#c')])],
      { stepDelayMs: 40 }
    );

    const res = await replay.handler({
      action: 'run', sequenceId: 'seq-a', connection: 'test-conn',
    } as any);

    // Returned before all three (slow) steps could possibly have run
    const runId = res._meta?.replay?.runId as string;
    expect(runId).toBeTruthy();
    expect(res._meta.replay.background).toBe(true);
    expect(text(res)).toContain(runId);
    expect(calls.filter(c => c.tool === 'dom' && c.params.selector).length).toBeLessThan(3);

    // While running, status reports progress
    await waitFor(() => runRegistry.get(runId)!.currentStep >= 1);
    const mid = await replay.handler({ action: 'status', runId } as any);
    expect(text(mid)).toMatch(/running|completed/);

    // Once completed, status returns the full result
    await waitFor(() => runRegistry.get(runId)!.status === 'completed');
    const done = await replay.handler({ action: 'status', runId } as any);
    expect(text(done)).toContain('completed');
    expect(text(done)).toContain('flow-a');
    expect(runRegistry.get(runId)!.results).toHaveLength(3);
    expect(done.isError).toBeUndefined();
  });

  it('cancel by runId stops a run at the next step boundary', async () => {
    const commands = Array.from({ length: 10 }, (_, i) => domStep(`#s${i}`));
    const { replay, calls } = makeReplay([seq('seq-b', 'flow-b', commands)], { stepDelayMs: 50 });

    const res = await replay.handler({
      action: 'run', sequenceId: 'seq-b', connection: 'test-conn',
    } as any);
    const runId = res._meta.replay.runId as string;

    await waitFor(() => runRegistry.get(runId)!.currentStep >= 1);
    const cancelRes = await replay.handler({ action: 'cancel', runId } as any);
    expect(text(cancelRes)).toContain(runId);

    await waitFor(() => runRegistry.get(runId)!.status === 'cancelled');
    const stepCalls = calls.filter(c => c.tool === 'dom' && c.params.selector?.startsWith('#s')).length;
    expect(stepCalls).toBeLessThan(10);

    // No further steps run after cancellation settles
    await new Promise(r => setTimeout(r, 200));
    expect(calls.filter(c => c.tool === 'dom' && c.params.selector?.startsWith('#s')).length).toBe(stepCalls);

    const status = await replay.handler({ action: 'status', runId } as any);
    expect(text(status)).toContain('cancelled');
  });

  it('two concurrent runs of the same sequence are distinguishable', async () => {
    const { replay } = makeReplay(
      [seq('seq-c', 'flow-c', [domStep('#a'), domStep('#b')])],
      { stepDelayMs: 30 }
    );

    const [r1, r2] = await Promise.all([
      replay.handler({ action: 'run', sequenceId: 'seq-c', connection: 'conn-1' } as any),
      replay.handler({ action: 'run', sequenceId: 'seq-c', connection: 'conn-2' } as any),
    ]);

    const id1 = r1._meta.replay.runId as string;
    const id2 = r2._meta.replay.runId as string;
    expect(id1).not.toBe(id2);
    expect(runRegistry.list()).toHaveLength(2);

    await waitFor(() =>
      runRegistry.get(id1)!.status === 'completed' && runRegistry.get(id2)!.status === 'completed'
    );
    expect(runRegistry.get(id1)!.connection).toBe('conn-1');
    expect(runRegistry.get(id2)!.connection).toBe('conn-2');
  });

  it('a sequence a check runs does not register as a separate run', async () => {
    const inner = seq('seq-inner', 'inner-flow', [domStep('#inner')]);
    const outer = seq('seq-outer', 'outer-flow', [
      runsOnPass('inner-flow'),
    ]);
    const { replay, calls } = makeReplay([outer, inner]);

    const res = await replay.handler({
      action: 'run', sequenceId: 'seq-outer', connection: 'test-conn',
    } as any);
    const runId = res._meta.replay.runId as string;

    await waitFor(() => runRegistry.get(runId)!.status === 'completed');
    // The nested sequence really executed...
    expect(calls.some(c => c.tool === 'dom' && c.params.selector === '#inner')).toBe(true);
    // ...but only the outer run is registered
    expect(runRegistry.list()).toHaveLength(1);
  });

  it('a nested `replay run` STEP is forced to block (wait injected)', async () => {
    const outer = seq('seq-nest', 'nest-flow', [
      { tool: 'replay', params: { action: 'run', name: 'inner-flow' } },
    ]);
    const { replay, calls } = makeReplay([outer]);

    const res = await replay.handler({
      action: 'run', sequenceId: 'seq-nest', wait: true,
    } as any);

    const nested = calls.find(c => c.tool === 'replay' && c.params.action === 'run');
    expect(nested?.params.wait).toBe(true);
    expect(res._meta.replay.paused).toBe(false);
  });

  it('unknown or expired runId gives a clean error', async () => {
    const { replay } = makeReplay([]);
    const res = await replay.handler({ action: 'status', runId: 'run-99-zzz' } as any);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('run-99-zzz');
    expect(text(res)).toContain('restart');

    const cancelRes = await replay.handler({ action: 'cancel', runId: 'run-99-zzz' } as any);
    expect(cancelRes.isError).toBe(true);
  });

  it('wait: true blocks and returns the full result (pre-0.7 behaviour), without registering a run', async () => {
    const { replay } = makeReplay([seq('seq-w', 'wait-flow', [domStep('#a'), domStep('#b')])]);

    const res = await replay.handler({
      action: 'run', sequenceId: 'seq-w', connection: 'test-conn', wait: true,
    } as any);

    expect(res._meta.replay.success).toBe(true);
    expect(res._meta.replay.runId).toBeUndefined();
    expect(runRegistry.list()).toHaveLength(0);
    expect(text(res)).toContain('wait-flow');
  });

  it('cancel without runId targets the only executing run, and errors when ambiguous', async () => {
    const commands = Array.from({ length: 8 }, (_, i) => domStep(`#s${i}`));
    const { replay } = makeReplay([seq('seq-d', 'flow-d', commands)], { stepDelayMs: 40 });

    const r1 = await replay.handler({ action: 'run', sequenceId: 'seq-d', connection: 'c1' } as any);
    const r2 = await replay.handler({ action: 'run', sequenceId: 'seq-d', connection: 'c2' } as any);

    // Two executing runs: ambiguous
    const ambiguous = await replay.handler({ action: 'cancel' } as any);
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain(r1._meta.replay.runId);
    expect(text(ambiguous)).toContain(r2._meta.replay.runId);

    // Cancel one by id and let it settle ('cancelling' still counts as
    // executing); a bare cancel then resolves to the remaining run.
    await replay.handler({ action: 'cancel', runId: r1._meta.replay.runId } as any);
    await waitFor(() => runRegistry.get(r1._meta.replay.runId)!.status === 'cancelled');

    const second = await replay.handler({ action: 'cancel' } as any);
    expect(text(second)).toContain(r2._meta.replay.runId);

    await waitFor(() => runRegistry.get(r2._meta.replay.runId)!.status === 'cancelled');
  });
});
