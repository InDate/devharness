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
import { HELD, runsOnPass } from '../test-support/check-steps.js';

/**
 * `live` is what `connection list` reports: the names already connected in this
 * session. A launch or attach adds its name, and a call naming a connection
 * outside that set fails, as the real tools do.
 */
function makeHarness(opts: { live?: string[] } = {}) {
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const live = new Set(opts.live ?? []);
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'check') return HELD;
    calls.push({ tool, params });
    if (tool === 'connection' && (params.action === 'launch' || params.action === 'attach')) {
      const name = params.name ?? 'unnamed-connection-default';
      if (live.has(name)) {
        return { isError: true, content: [{ type: 'text', text: `Reference "${name}" is already in use` }] };
      }
      live.add(name);
      return { content: [{ type: 'text', text: '' }] };
    }
    if (typeof params.connectionReason === 'string' && !live.has(params.connectionReason)) {
      return { isError: true, content: [{ type: 'text', text: 'Connection not found' }] };
    }
    if (tool === 'connection' && params.action === 'list') {
      return {
        content: [{ type: 'text', text: '' }],
        _meta: {
          tool: 'connection', action: 'list', timestamp: 0,
          connections: [...live].map((reference, i) => ({
            reference, type: 'chrome', host: 'localhost', port: 9222 + i, active: i === 0, connected: true, paused: false,
          })),
        },
      };
    }
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

describe('a run of an attach to Chrome followed by bare browser steps', () => {
  it('attaches under the name and drives that browser, launching none', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.createSequenceFromCommands('chrome-attach', [
      { tool: 'connection', params: { action: 'attach', name: 'shop-tab', port: 9222 } },
      { tool: 'navigate', params: { action: 'goto', url: 'http://shop.test/' } },
      { tool: 'input', params: { action: 'click', selector: '#buy' } },
    ]);

    const result: any = await replay.handler({ action: 'run', wait: true, name: 'chrome-attach' } as any);

    expect(result.isError).toBeFalsy();
    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toEqual([]);
    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'attach')).toHaveLength(1);
    expect(connectionsOf(calls, 'input')).toEqual(['shop-tab']);
  });
});

describe('a run of a launch that names no connection, followed by bare steps', () => {
  it('runs the bare steps on the connection the launch created, under the default name', async () => {
    const { calls, replay, recorder } = makeHarness();
    await recorder.createSequenceFromCommands('unnamed-launch', [
      { tool: 'connection', params: { action: 'launch', url: 'http://shop.test/' } },
      { tool: 'navigate', params: { action: 'goto', url: 'http://shop.test/cart' } },
    ]);

    const result: any = await replay.handler({ action: 'run', wait: true, name: 'unnamed-launch' } as any);

    expect(result.isError).toBeFalsy();
    const gotos = calls.filter(c => c.tool === 'navigate' && c.params.action === 'goto');
    expect(gotos.map(c => c.params.connectionReason)).toEqual(['unnamed-connection-default']);
  });
});

describe('a nested sequence that attaches', () => {
  async function recordNested(recorder: any) {
    await recorder.createSequenceFromCommands('node-setup', [
      { tool: 'connection', params: { action: 'attach', name: 'api-server', port: 9229 } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'process.pid' } },
    ]);
    await recorder.createSequenceFromCommands('outer', [runsOnPass('node-setup')]);
  }

  it('runs its bare steps on the connection its attach created', async () => {
    const { calls, replay, recorder } = makeHarness({ live: ['browser-a'] });
    await recordNested(recorder);

    await replay.handler({ action: 'run', wait: true, name: 'outer', connectionReason: 'browser-a' } as any);

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'attach')).toHaveLength(1);
    expect(connectionsOf(calls, 'inspect')).toEqual(['api-server']);
  });

  it('skips an attach whose name is already connected, and runs its steps where it was called from', async () => {
    const { calls, replay, recorder } = makeHarness({ live: ['browser-a', 'api-server'] });
    await recordNested(recorder);

    await replay.handler({ action: 'run', wait: true, name: 'outer', connectionReason: 'browser-a' } as any);

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'attach')).toEqual([]);
    expect(connectionsOf(calls, 'inspect')).toEqual(['browser-a']);
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

describe('calls that take no connection', () => {
  it('repeat runs a bare acknowledge and loadMaps as they were, without refusing them', async () => {
    const { calls, replay, recorder } = makeHarness({ live: ['browser-a'] });
    await recorder.recordCommand('execution', { action: 'acknowledge' });
    await recorder.recordCommand('source', { action: 'loadMaps', directory: 'dist' });

    const result: any = await replay.handler({ action: 'repeat', indices: [0, 1] } as any);

    expect(result.isError).toBeFalsy();
    expect(calls.filter(c => c.tool === 'execution' || c.tool === 'source').map(c => c.params)).toEqual([
      { action: 'acknowledge' },
      { action: 'loadMaps', directory: 'dist' },
    ]);
  });

  it('a run leaves a bare acknowledge bare, so it acknowledges every paused connection', async () => {
    const { calls, replay, recorder } = makeHarness({ live: ['browser-a'] });
    await recorder.createSequenceFromCommands('ack-all', [
      { tool: 'execution', params: { action: 'acknowledge' } },
    ]);

    await replay.handler({ action: 'run', wait: true, name: 'ack-all', connectionReason: 'browser-a' } as any);

    expect(calls.filter(c => c.tool === 'execution').map(c => c.params)).toEqual([{ action: 'acknowledge' }]);
  });
});

describe('a forEach whose body attaches', () => {
  it('attaches once and runs every iteration on that connection', async () => {
    const { calls, replay, recorder } = makeHarness({ live: ['browser-a'] });
    await recorder.createSequenceFromCommands('per-row', [
      { tool: 'connection', params: { action: 'attach', name: 'api-server', port: 9229 } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'process.pid' } },
    ]);
    await recorder.createSequenceFromCommands('rows', [
      { tool: 'forEach', params: { in: [1, 2, 3], as: 'row', do: 'per-row' } },
    ]);

    const result: any = await replay.handler({ action: 'run', wait: true, name: 'rows', connectionReason: 'browser-a' } as any);

    expect(result.isError).toBeFalsy();
    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'attach')).toHaveLength(1);
    expect(connectionsOf(calls, 'inspect')).toEqual(['api-server', 'api-server', 'api-server']);
  });
});

describe('a session with nothing connected', () => {
  it('runs a nested launch, and runs the nested steps on the browser it launched', async () => {
    const { calls, replay, recorder } = makeHarness({ live: [] });
    await recorder.createSequenceFromCommands('first-device', [
      { tool: 'connection', params: { action: 'launch', name: 'first-device-tab' } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'document.title' } },
    ]);
    await recorder.createSequenceFromCommands('setup', [runsOnPass('first-device')]);

    await replay.handler({ action: 'run', wait: true, name: 'setup' } as any);

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params.name))
      .toEqual(['first-device-tab']);
    expect(connectionsOf(calls, 'inspect')).toEqual(['first-device-tab']);
  });

  it('refuses a step naming a connection, naming the one it wanted', async () => {
    const { calls, replay, recorder } = makeHarness({ live: [] });
    await recorder.createSequenceFromCommands('named-step', [
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: '1', connectionReason: 'second-device-tab' } },
    ]);

    const result: any = await replay.handler({ action: 'run', wait: true, name: 'named-step' } as any);

    expect(result.content[0].text).toContain('"second-device-tab"');
    expect(result.content[0].text).toContain('does not exist in this session');
    expect(calls.filter(c => c.tool === 'inspect')).toEqual([]);
  });
});
