/**
 * A setup sequence that declares its browsers (`requiredConnections`) and names
 * them on its steps, run inside another sequence by a check's `{ run }`. The
 * declaration is the only thing that creates those browsers: without the
 * nested launch, the child's first step names a connection that is not live
 * and the child fails there.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { HELD } from '../test-support/check-steps.js';

const PORTS: Record<string, number> = { 'run-device': 9222, 'setup-a': 9333, 'setup-b': 9444 };

function makeReplay(parentStartUrl?: string) {
  const child = {
    id: 'seq-setup', name: 'setup', createdAt: 1,
    requiredConnections: [{ connection: 'setup-a' }, { connection: 'setup-b' }],
    commands: [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connection: 'setup-a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connection: 'setup-b' } },
    ],
  } as CommandSequence;
  const parent = {
    id: 'seq-parent', name: 'parent', createdAt: 1,
    ...(parentStartUrl ? { startUrl: parentStartUrl } : {}),
    commands: [
      { tool: 'check', params: { afterMs: 0, holds: { run: 'setup' } } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#after', connection: 'setup-a' } },
    ] as RecordedCommand[],
  } as CommandSequence;
  const byId: Record<string, CommandSequence> = { 'seq-setup': child, 'seq-parent': parent };

  let activeSequence: any = null;
  const recorder = {
    getSequence: vi.fn((id: string) => byId[id]),
    getFreshSequence: vi.fn(async (id: string) => byId[id]),
    listSequences: vi.fn(() => [child, parent]),
    loadSequenceFromDisk: vi.fn(async (name: string) => Object.values(byId).find(s => s.name === name)),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    getActiveSequence: vi.fn(() => activeSequence),
    setActiveSequence: vi.fn((s: any) => { activeSequence = s; }),
    getCommandsSincePause: vi.fn(() => []),
  } as any;

  const live = new Set(['run-device']);
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    if (tool === 'connection' && params.action === 'launch') {
      const reused = live.has(params.connection);
      live.add(params.connection);
      return { content: [{ type: 'text', text: '' }], _meta: { launch: { name: params.connection, reused } } };
    }
    if (tool === 'check') return HELD;
    if (tool === 'connection' && params.action === 'close') live.delete(params.connection);
    if (tool === 'connection' && params.action === 'list') {
      return {
        content: [{ type: 'text', text: 'Active debugger connections' }],
        _meta: {
          tool: 'connection', action: 'list', timestamp: 0,
          connections: [...live].map(reference => ({
            reference, port: PORTS[reference], type: 'chrome', host: 'localhost', active: false, connected: true, paused: false,
          })),
        },
      };
    }
    if (tool !== 'connection' && params.connection && !live.has(params.connection)) {
      return { isError: true, content: [{ type: 'text', text: `Error: no connection ${params.connection}` }] };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const { run } = createReplayTools(
    recorder, executeToolCall, async () => null, async (reference: string) => PORTS[reference] ?? null, undefined
  );
  return { run, calls };
}

describe('a nested sequence that declares its browsers', () => {
  it('launches them before its first step, and the outer run closes them when it finishes', async () => {
    const { run, calls } = makeReplay();

    const result: any = await run.handler({
      action: 'sequence', wait: true, sequenceId: 'seq-parent', connection: 'run-device',
    } as any);

    expect(result._meta.replay.success).toBe(true);
    const launched = calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.connection);
    expect(launched).toEqual(['setup-a', 'setup-b']);
    const ranOnB = calls.findIndex(c => c.tool === 'dom' && c.params.connection === 'setup-b');
    expect(calls.findIndex(c => c.params.action === 'launch' && c.params.connection === 'setup-b')).toBeLessThan(ranOnB);
    const ranAfter = calls.findIndex(c => c.tool === 'dom' && c.params.selector === '#after');
    const closed = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.tool === 'connection' && c.params.action === 'close')
      .filter(({ i }) => i > ranAfter)
      .map(({ c }) => c.params.connection);
    expect(closed).toEqual(expect.arrayContaining(['setup-a', 'setup-b']));
  });

  it('is not opened by the start url ahead of its declaration, where the first step that names a browser names one of its', async () => {
    const { run, calls } = makeReplay('http://localhost:8801/');

    const result: any = await run.handler({
      action: 'sequence', wait: true, sequenceId: 'seq-parent', connection: 'run-device',
    } as any);

    expect(result._meta.replay.success).toBe(true);
    const first = calls.find(c => c.params.connection === 'setup-a');
    expect(first?.params).toMatchObject({ action: 'launch', forceNewInstance: true });
  });
});
