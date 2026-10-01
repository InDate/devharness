/**
 * A declared socket is required only where the sequence LOADS the app.
 *
 * The transport rides on a page, so a connection that never navigated has
 * nothing for it to belong to. Reading "drives" from connection injection
 * instead failed a healthy three-browser run: its three bare steps were
 * `assert`s over values already captured - they take a connection but load
 * nothing - and that was enough to demand a sync socket on the run's own idle
 * browser, and fail a sequence whose 37 steps had all passed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const PORTS: Record<string, number> = { 'the-run-connection': 9222, 'member-a': 9333 };

function makeReplay(commands: RecordedCommand[]) {
  const sequence = {
    id: 'seq-sockets', name: 'socket-seq', createdAt: 1,
    commands,
    requiredConnections: [{ connection: 'member-a' }],
    requiredSockets: ['/api/sync/socket'],
  } as CommandSequence;

  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => sequence),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn(),
    getActiveSequence: vi.fn(() => null),
  } as any;

  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'network' && params.action === 'sockets') {
      // Only the browser that navigated ever opened the sync socket.
      const list = params.connection === 'member-a'
        ? [{ id: 's1', url: 'wss://app.test/api/sync/socket', target: 'page', closed: false, errors: 0 }]
        : [];
      return { content: [{ type: 'text', text: '' }], _meta: { socketList: list } };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const { replay } = createReplayTools(
    recorder, executeToolCall, async () => null,
    async (reference: string) => PORTS[reference] ?? null, undefined
  );
  return { replay };
}

const run = (replay: any) => replay.handler({
  action: 'run', wait: true, sequenceId: 'seq-sockets', connection: 'the-run-connection',
} as any);

const text = (res: any) => res.content[0].text as string;

describe('a declared socket', () => {
  it('is not demanded of the run\'s own browser when every navigate names another', async () => {
    const { replay } = makeReplay([
      { tool: 'navigate', params: { action: 'goto', url: 'https://app.test/', connection: 'member-a' } },
      { tool: 'input', params: { action: 'click', selector: '#draw', connection: 'member-a' } },
      // Takes a connection, loads nothing: this is what used to make the run's
      // idle browser look driven.
      { tool: 'assert', params: { value: '{{var:count}}', equals: '1' } },
    ] as RecordedCommand[]);

    const res = await run(replay);

    expect(text(res)).not.toContain('Socket health failed');
  });

  // The absence check re-reads for a few seconds before calling a socket
  // missing, so this one outlives the default test timeout.
  it('is still demanded of the browser that DID navigate', { timeout: 15000 }, async () => {
    const { replay } = makeReplay([
      // The run's own connection loads the app here, and never opens the socket.
      { tool: 'navigate', params: { action: 'goto', url: 'https://app.test/' } },
      { tool: 'input', params: { action: 'click', selector: '#draw' } },
    ] as RecordedCommand[]);

    const res = await run(replay);

    expect(text(res)).toContain('Socket health failed');
    expect(text(res)).toContain('never opened');
  });
});
