/**
 * killChromeOnFinish must only tear down the browser behind the RUN's own
 * connection. A step that names its own connectionReason is typically pointing
 * at a long-lived instance the user launched by hand (the multi-device case);
 * killing it would destroy state they cannot get back, so those are left alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const RUN_PORT = 9222;
const BORROWED_PORT = 9333;

const PORTS: Record<string, number> = {
  'run-device': RUN_PORT,
  'borrowed-device': BORROWED_PORT,
  'phone': 9444,
};

function makeReplay(
  commands: RecordedCommand[],
  opts: {
    connections?: Array<{ reference: string; port: number }>;
    /** References a launchChrome step finds already bound (someone else's). */
    reused?: string[];
  } = {},
) {
  const sequence: CommandSequence = { id: 'seq-kill', name: 'kill-seq', commands, createdAt: 1 };

  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => sequence),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn(),
  } as any;

  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    if (tool === 'listConnections' && opts.connections) {
      return {
        content: [{ type: 'text', text: 'Active debugger connections' }],
        _meta: {
          tool: 'listConnections', timestamp: 0,
          connections: opts.connections.map(c => ({
            ...c, type: 'chrome', host: 'localhost', active: false, connected: true, paused: false,
          })),
        },
      };
    }
    if (tool === 'network' && params.action === 'sockets') {
      // Readable only while the browser is alive, which is the point: after the
      // kill this would be an error, and the verdict would blame the sequence.
      return {
        content: [{ type: 'text', text: '' }],
        _meta: { socketList: [{ id: 's1', url: 'ws://localhost/api/sync', target: 'page', closed: false, errors: 0 }] },
      };
    }
    if (tool === 'launchChrome') {
      // Production stamps ownership on the response; a reference that already
      // existed comes back reused, and a reused browser is not the run's.
      return {
        content: [{ type: 'text', text: '' }],
        _meta: {
          launchChrome: {
            reference: params.reference,
            reused: (opts.reused || []).includes(params.reference),
          },
        },
      };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const getConnectionPort = vi.fn(async (reference: string) => PORTS[reference] ?? null);

  const { replay } = createReplayTools(
    recorder,
    executeToolCall,
    async () => null,          // no page -> no cursor/overlay injection
    getConnectionPort,
    undefined
  );

  return { replay, calls, getConnectionPort };
}

const killedPorts = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'killChrome').map(c => c.params.port);

const text = (res: any) => res.content[0].text as string;

const run = (replay: any, extra: Record<string, any> = {}) =>
  replay.handler({
    action: 'run',
    // These tests assert on the run's final text, so they use the blocking mode.
    wait: true,
    sequenceId: 'seq-kill',
    connectionReason: 'run-device',
    killChromeOnFinish: true,
    ...extra,
  } as any);

describe('killChromeOnFinish', () => {
  it("kills the run's own Chrome exactly once", async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b' } },
    ]);

    const res = await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    expect(text(res)).toContain('Chrome killed');
  });

  it('leaves a borrowed per-step connection running', async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
      // a browser the user launched themselves and expects to keep
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: 'borrowed-device' } },
    ]);

    await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    expect(killedPorts(calls)).not.toContain(BORROWED_PORT);
    // the step really did run against the borrowed connection
    expect(calls.some(c => c.tool === 'dom' && c.params.connectionReason === 'borrowed-device')).toBe(true);
  });

  it('leaves a borrowed connection running even when its reference comes from a variable', async () => {
    const { replay, calls, getConnectionPort } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: '{{var:device}}' } },
    ]);

    await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    // and we never even asked for the port of an uninterpolated reference
    expect(getConnectionPort.mock.calls.flat()).toEqual(['run-device']);
  });

  // Driven live: a launchChrome step usually opens a TAB in the existing
  // instance, so a second connection shares the run's port. Killing by port
  // then takes that browser down too - the exact thing this promises not to do.
  it('leaves the browser running when another connection shares its port', async () => {
    const { replay, calls } = makeReplay(
      [{ tool: 'dom', params: { action: 'querySelector', selector: '#a' } }],
      { connections: [{ reference: 'run-device', port: RUN_PORT }, { reference: 'tab-sibling', port: RUN_PORT }] },
    );

    const res = await run(replay);

    expect(killedPorts(calls)).toEqual([]);
    expect(text(res)).toContain('Chrome left running');
    expect(text(res)).toContain('tab-sibling');
  });

  it('still kills when the only connection on the port is the run\'s own', async () => {
    const { replay, calls } = makeReplay(
      [{ tool: 'dom', params: { action: 'querySelector', selector: '#a' } }],
      { connections: [{ reference: 'run-device', port: RUN_PORT }, { reference: 'phone', port: 9444 }] },
    );

    await run(replay);

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
  });

  // The other half of the trade: under-killing leaks a process on every run.
  // A step's browser is only spared when the step BORROWED it (issue #103).
  it('kills a per-step browser the run itself launched', async () => {
    // The device shape: the sequence brings up its own browsers, so the run
    // takes no connectionReason of its own and the second launch is a browser
    // that exists only because this run opened it.
    const { replay, calls } = makeReplay([
      { tool: 'launchChrome', params: { reference: 'run-device' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: 'run-device' } },
      { tool: 'launchChrome', params: { reference: 'phone' } },
      { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: 'phone' } },
    ]);

    await run(replay, { connectionReason: undefined });

    expect(killedPorts(calls)).toContain(PORTS['phone']);
    // and the reference is released, so the next run can launch it again
    const release = calls.find(c => c.tool === 'disconnectDebugger' && c.params.reference === 'phone');
    expect(release?.params.reason).toEqual(expect.stringContaining('phone'));
  });

  it('leaves a per-step browser alone when the launch only reused it', async () => {
    const { replay, calls } = makeReplay(
      [
        { tool: 'launchChrome', params: { reference: 'run-device' } },
        { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: 'run-device' } },
        { tool: 'launchChrome', params: { reference: 'borrowed-device' } },
        { tool: 'dom', params: { action: 'querySelector', selector: '#b', connectionReason: 'borrowed-device' } },
      ],
      { reused: ['borrowed-device'] },
    );

    await run(replay, { connectionReason: undefined });

    expect(killedPorts(calls)).toEqual([RUN_PORT]);
    expect(killedPorts(calls)).not.toContain(BORROWED_PORT);
  });

  // The kill interrogates the browser and so does the health verdict. Killing
  // first made every killChromeOnFinish run with declared sockets fail with
  // "could not read socket health - Connection not found" - a failure produced
  // by the run's own cleanup.
  it('reads socket health BEFORE killing the browser', async () => {
    const { replay, calls } = makeReplay(
      [{ tool: 'dom', params: { action: 'querySelector', selector: '#a' } }],
    );

    const res = await run(replay, { requireSockets: true });

    const order = calls.map(c => c.tool);
    const lastNetwork = order.lastIndexOf('network');
    const kill = order.indexOf('killChrome');
    expect(lastNetwork).toBeGreaterThan(-1);
    expect(kill).toBeGreaterThan(lastNetwork);
    expect(text(res)).not.toContain('could not read socket health');
  });

  it('kills nothing when killChromeOnFinish is not set', async () => {
    const { replay, calls } = makeReplay([
      { tool: 'dom', params: { action: 'querySelector', selector: '#a', connectionReason: 'borrowed-device' } },
    ]);

    await run(replay, { killChromeOnFinish: undefined });

    expect(killedPorts(calls)).toEqual([]);
  });
});


