// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { ConnectionManager } from '../connection-manager.js';
import { createExecutionTools } from './execution-tools.js';
import { attachLayer, forgetConnection, hold, holdReading } from '../hold.js';

const REFERENCE = 'person-held-page';

/** A paused page whose debugger counts the resumes it is sent. */
function fakeCdpManager() {
  const state = { paused: false, resumes: 0 };
  const cdp = {
    getRuntimeType: () => 'browser',
    isConnected: () => true,
    disconnect: async () => {},
    isPaused: () => state.paused,
    getPausedInfo: () => ({ paused: state.paused }),
    getLogpointLimitExceeded: () => undefined,
    getCallStack: () => [],
    watchPause: () => () => {},
    watchNewDocument: () => () => {},
    send: async () => ({}),
    pause: async () => { state.paused = true; },
    resume: async () => { state.paused = false; state.resumes++; },
    disarmPause: async () => {},
  } as any;
  return { cdp, state };
}

afterEach(() => forgetConnection(REFERENCE));

describe('execution resume on a page a person holds by hand', () => {
  it('leaves the page stopped, and names the person\'s hold', async () => {
    const { cdp, state } = fakeCdpManager();
    const connectionManager = new ConnectionManager();
    const id = connectionManager.createConnection(cdp, undefined, undefined, undefined, 'localhost', 9229, REFERENCE);
    // The bench's screen hold, which stops the code with it.
    attachLayer(REFERENCE, 'ui', { covers: ['code'], engage: async () => { state.paused = true; }, disengage: async () => { state.paused = false; } });
    await hold(REFERENCE, { owner: { kind: 'person' }, layers: ['ui'] });
    const resolve = async () => ({ connection: connectionManager.getConnection(id), cdpManager: cdp, puppeteerManager: undefined, consoleMonitor: undefined, networkMonitor: undefined });
    const { execution } = createExecutionTools(resolve, connectionManager);

    const result: any = await execution.handler({ action: 'resume', connection: REFERENCE } as any);

    expect(result._errorId).toBe('HELD_BY_PERSON');
    expect(state.resumes).toBe(0);
    expect(holdReading(REFERENCE).held.map(layer => layer.layer)).toEqual(['ui', 'code']);
  });
});
