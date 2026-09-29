/**
 * The browsers a sequence DECLARES (`requiredConnections`) are launched by the
 * run, so the run owns them and every terminal outcome closes them. Pause is
 * the single exception - those browsers are the state someone stopped to look
 * at - but every exit from a pause is terminal and pays the debt.
 *
 * Both gaps this covers were silent: the browser stayed up and the next run
 * reused it carrying the previous run's state, which reads as a broken
 * sequence rather than a stale browser (issues #127, #137).
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const PORTS: Record<string, number> = {
  'run-device': 9222,
  'declared-b': 9333,
};

function makeReplay(commands: RecordedCommand[]) {
  const sequence = {
    id: 'seq-declared',
    name: 'declared-seq',
    commands,
    createdAt: 1,
    requiredConnections: [{ reference: 'declared-b' }],
  } as CommandSequence;

  let activeSequence: any = null;
  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => sequence),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    getActiveSequence: vi.fn(() => activeSequence),
    setActiveSequence: vi.fn((s: any) => { activeSequence = s; }),
    getCommandsSincePause: vi.fn(() => []),
  } as any;

  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    if (tool === 'listConnections') {
      return {
        content: [{ type: 'text', text: 'Active debugger connections' }],
        _meta: {
          tool: 'listConnections', timestamp: 0,
          connections: Object.entries(PORTS).map(([reference, port]) => ({
            reference, port, type: 'chrome', host: 'localhost', active: false, connected: true, paused: false,
          })),
        },
      };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const { replay } = createReplayTools(
    recorder,
    executeToolCall,
    async () => null,
    async (reference: string) => PORTS[reference] ?? null,
    undefined
  );
  return { replay, calls };
}

const killedPorts = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'killChrome').map(c => c.params.port);

const twoSteps = [
  { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
  { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
] as RecordedCommand[];

describe('declared browsers', () => {
  it('are closed when a cancel ends a paused run', async () => {
    const { replay, calls } = makeReplay(twoSteps);

    const paused: any = await replay.handler({
      action: 'run', wait: true, sequenceId: 'seq-declared',
      connectionReason: 'run-device', stepTo: 1,
    } as any);

    expect(paused.content[0].text).toMatch(/paus/i);
    expect(calls.some(c => c.tool === 'launchChrome' && c.params.reference === 'declared-b')).toBe(true);
    // A pause keeps them: that is the state the user stopped to inspect.
    expect(killedPorts(calls)).not.toContain(PORTS['declared-b']);

    await replay.handler({ action: 'cancel' } as any);

    expect(killedPorts(calls)).toContain(PORTS['declared-b']);
    // The reference is released too, or the next run declaring it launches
    // against a browser that no longer exists.
    expect(calls.some(c => c.tool === 'disconnectDebugger' && c.params.reference === 'declared-b')).toBe(true);
  });

  it('are closed when finish ends a paused run', async () => {
    const { replay, calls } = makeReplay(twoSteps);

    await replay.handler({
      action: 'run', wait: true, sequenceId: 'seq-declared',
      connectionReason: 'run-device', stepTo: 1,
    } as any);
    await replay.handler({ action: 'finish' } as any);

    expect(killedPorts(calls)).toContain(PORTS['declared-b']);
  });

  it('are closed when a BACKGROUND run completes', async () => {
    // The default mode. Cleanup used to live in the `wait: true` branch only,
    // so an ordinary suite run leaked one browser per multi-browser sequence.
    const { replay, calls } = makeReplay(twoSteps);

    const started: any = await replay.handler({
      action: 'run', sequenceId: 'seq-declared', connectionReason: 'run-device',
    } as any);
    const runId = started._meta?.replay?.runId ?? started.content[0].text.match(/run-\d+-\w+/)?.[0];

    await vi.waitFor(async () => {
      const status: any = await replay.handler({ action: 'status', runId } as any);
      expect(status.content[0].text).toMatch(/completed|failed/i);
    }, { timeout: 5000 });

    expect(killedPorts(calls)).toContain(PORTS['declared-b']);
  });
});
