import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RestartCoordinator, type RestartCoordinatorDeps } from './restart-coordinator.js';

function makeDeps(overrides: Partial<RestartCoordinatorDeps> = {}): RestartCoordinatorDeps & {
  hostLines: string[];
  childLines: string[];
} {
  const hostLines: string[] = [];
  const childLines: string[] = [];
  return {
    hostLines,
    childLines,
    writeToChild: overrides.writeToChild ?? ((line) => childLines.push(line)),
    writeToHost: overrides.writeToHost ?? ((line) => hostLines.push(line)),
    killChild: overrides.killChild ?? vi.fn().mockResolvedValue(undefined),
    spawnChild: overrides.spawnChild ?? vi.fn(),
    logStderr: overrides.logStderr ?? (() => {}),
  };
}

const INIT_REQUEST = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
const INITIALIZED_NOTIF = '{"jsonrpc":"2.0","method":"notifications/initialized"}';

describe('RestartCoordinator - steady state passthrough', () => {
  it('forwards host requests to the child and captures initialize/initialized', () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);

    coordinator.handleHostLine(INIT_REQUEST);
    coordinator.handleHostLine(INITIALIZED_NOTIF);

    expect(deps.childLines).toEqual([INIT_REQUEST, INITIALIZED_NOTIF]);
  });

  it('forwards child responses to the host untouched', () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);
    coordinator.handleHostLine(INIT_REQUEST);

    const response = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}';
    coordinator.handleChildLine(response);

    expect(deps.hostLines).toEqual([response]);
  });
});

describe('RestartCoordinator - restart via requestRestart()', () => {
  it('synthesizes an error for an in-flight request and does not double-deliver a late real response', async () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);

    const slowReq = '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{}}';
    coordinator.handleHostLine(slowReq);
    expect(deps.hostLines).toEqual([]);

    coordinator.requestRestart('test');
    await flushMicrotasks();

    // Exactly one synthesized error for id 42
    expect(deps.hostLines).toHaveLength(1);
    const synthesized = JSON.parse(deps.hostLines[0]);
    expect(synthesized).toMatchObject({ jsonrpc: '2.0', id: 42, error: { code: -32000 } });

    // The old (now-dead) child's late real answer for the same id must be dropped, not forwarded again.
    coordinator.handleChildLine('{"jsonrpc":"2.0","id":42,"result":{"late":true}}');
    expect(deps.hostLines).toHaveLength(1);
  });

  it('replays the buffered initialize+initialized to the new child, in order, before anything else', async () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);
    coordinator.handleHostLine(INIT_REQUEST);
    coordinator.handleHostLine(INITIALIZED_NOTIF);
    deps.childLines.length = 0; // clear the initial forwarding, we only care about the replay

    coordinator.requestRestart('test');
    await flushMicrotasks();

    expect(deps.childLines).toEqual([INIT_REQUEST, INITIALIZED_NOTIF]);
  });

  it('swallows the new child response to the replayed initialize exactly once (once the host already has its original answer)', async () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);
    coordinator.handleHostLine(INIT_REQUEST);
    coordinator.handleHostLine(INITIALIZED_NOTIF);
    // The original child answers normally, forwarded to the host - this is what
    // makes it safe to swallow a *replayed* init's response on a later restart.
    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}');
    deps.hostLines.length = 0; // clear that forwarded response, we only care about what happens after restart

    coordinator.requestRestart('test');
    await flushMicrotasks();

    // A restart with a captured init sends a best-effort tools/list_changed
    // nudge to the host - not the thing under test here, so drop it before
    // checking the swallow behavior below.
    const TOOLS_LIST_CHANGED = '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n';
    expect(deps.hostLines).toEqual([TOOLS_LIST_CHANGED]);
    deps.hostLines.length = 0;

    // New child answers the replayed initialize - must be swallowed.
    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}');
    expect(deps.hostLines).toEqual([]);

    // A second, unrelated response with the same id shape after that should NOT also be swallowed
    // (the swallow is one-shot).
    coordinator.handleHostLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}');
    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(deps.hostLines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);
  });

  it('does NOT swallow a restart-triggered init replay response if the host never got its original answer', async () => {
    // Edge case: the very first child dies/restarts before ever answering the
    // host's original `initialize` - the host is still waiting for a real
    // answer, so eating the replayed response here would hang it forever.
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);
    coordinator.handleHostLine(INIT_REQUEST);
    coordinator.handleHostLine(INITIALIZED_NOTIF);
    // No response simulated yet - restart happens before any answer arrives.

    coordinator.requestRestart('test');
    await flushMicrotasks();
    // The init request wasn't in the generic in-flight map, so no premature
    // synthesized error for it - just the best-effort tools/list_changed nudge.
    expect(deps.hostLines).toEqual(['{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n']);
    deps.hostLines.length = 0;

    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}');
    expect(deps.hostLines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}']);
  });

  it('answers a request arriving mid-restart immediately instead of queuing it', async () => {
    let resolveKill: () => void;
    const killPromise = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    const deps = makeDeps({ killChild: () => killPromise });
    const coordinator = new RestartCoordinator(deps);

    coordinator.requestRestart('test');
    expect(coordinator.getPhase()).toBe('restarting');

    coordinator.handleHostLine('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{}}');
    expect(deps.hostLines).toHaveLength(1);
    expect(JSON.parse(deps.hostLines[0])).toMatchObject({ id: 99, error: { code: -32000 } });
    // Must not have been forwarded to spawnChild/child at all.
    expect(deps.childLines).toEqual([]);

    resolveKill!();
    await flushMicrotasks();
    expect(coordinator.getPhase()).toBe('ready');
  });

  it('ignores a second requestRestart() while one is already in progress', async () => {
    let resolveKill: () => void;
    const killPromise = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    const killChild = vi.fn(() => killPromise);
    const deps = makeDeps({ killChild });
    const coordinator = new RestartCoordinator(deps);

    coordinator.requestRestart('first');
    coordinator.requestRestart('second');
    expect(killChild).toHaveBeenCalledTimes(1);

    resolveKill!();
    await flushMicrotasks();
  });

  it('prepareForShutdown() prevents a deliberate shutdown kill from being mistaken for a crash', () => {
    const spawnChild = vi.fn();
    const logStderr = vi.fn();
    const deps = makeDeps({ spawnChild, logStderr });
    const coordinator = new RestartCoordinator(deps);

    coordinator.prepareForShutdown();
    coordinator.onChildExit(); // as mcp-supervisor.ts's real exit listener would call, unconditionally

    expect(spawnChild).not.toHaveBeenCalled();
    expect(coordinator.getPhase()).toBe('ready'); // never entered 'restarting'/crash-backoff at all
    expect(logStderr).not.toHaveBeenCalledWith(expect.stringContaining('crashed'));
  });

  it('drops notifications arriving mid-restart with no synthesized response (nothing to respond to)', () => {
    let resolveKill: () => void;
    const killPromise = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    const deps = makeDeps({ killChild: () => killPromise });
    const coordinator = new RestartCoordinator(deps);

    coordinator.requestRestart('test');
    coordinator.handleHostLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}');
    expect(deps.hostLines).toEqual([]);
    expect(deps.childLines).toEqual([]);
    resolveKill!();
  });
});

describe('RestartCoordinator - onChildExit (crash) vs deliberate restart', () => {
  it('a deliberate restart does not trigger crash backoff when onChildExit() fires for it', async () => {
    let resolveKill: () => void;
    const killPromise = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });
    const logStderr = vi.fn();
    const deps = makeDeps({ killChild: () => killPromise, logStderr });
    const coordinator = new RestartCoordinator(deps);

    coordinator.requestRestart('test');
    // Simulate the real child's 'exit' event firing as a *result* of killChild(), same as
    // child-manager.ts wiring would do, before killChild()'s own promise resolves.
    coordinator.onChildExit();
    resolveKill!();
    await flushMicrotasks();

    expect(coordinator.getPhase()).toBe('ready');
    expect(logStderr).not.toHaveBeenCalledWith(expect.stringContaining('crashed'));
  });

  it('an unplanned crash synthesizes errors, backs off, and respawns', () => {
    vi.useFakeTimers();
    try {
      const spawnChild = vi.fn();
      const deps = makeDeps({ spawnChild });
      const coordinator = new RestartCoordinator(deps, { crashBackoffBaseMs: 500, crashBackoffCapMs: 30000 });

      coordinator.handleHostLine('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}');
      deps.hostLines.length = 0;

      coordinator.onChildExit(); // unplanned - expectingExit was never set
      expect(coordinator.getPhase()).toBe('restarting');
      expect(JSON.parse(deps.hostLines[0])).toMatchObject({ id: 5, error: { code: -32000 } });

      vi.advanceTimersByTime(499);
      expect(spawnChild).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(coordinator.getPhase()).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('backoff follows 500*2^(n-1) capped at 30000, and gives up after 10 attempts', () => {
    vi.useFakeTimers();
    try {
      const spawnChild = vi.fn();
      const logStderr = vi.fn();
      const deps = makeDeps({ spawnChild, logStderr });
      const coordinator = new RestartCoordinator(deps, { crashBackoffBaseMs: 500, crashBackoffCapMs: 30000, maxCrashAttempts: 10 });

      const expectedDelays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
      for (let attempt = 1; attempt <= 10; attempt++) {
        coordinator.onChildExit();
        expect(coordinator.getPhase()).toBe('restarting');
        vi.advanceTimersByTime(expectedDelays[attempt - 1]);
        expect(spawnChild).toHaveBeenCalledTimes(attempt);
      }

      // 11th consecutive crash (stability timer never got a chance to reset the counter
      // since we advance straight from spawn to the next crash) - gives up.
      coordinator.onChildExit();
      expect(coordinator.getPhase()).toBe('idle-gave-up');
      expect(spawnChild).toHaveBeenCalledTimes(10); // no 11th spawn attempt
      expect(logStderr).toHaveBeenCalledWith(expect.stringContaining('Giving up'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit requestRestart() resets the crash counter and exits idle-gave-up', async () => {
    vi.useFakeTimers();
    try {
      const spawnChild = vi.fn();
      const killChild = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ spawnChild, killChild });
      const coordinator = new RestartCoordinator(deps, { maxCrashAttempts: 2, crashBackoffBaseMs: 10 });

      coordinator.onChildExit();
      vi.advanceTimersByTime(10);
      coordinator.onChildExit();
      vi.advanceTimersByTime(20);
      coordinator.onChildExit(); // 3rd consecutive crash, exceeds maxCrashAttempts=2
      expect(coordinator.getPhase()).toBe('idle-gave-up');

      coordinator.requestRestart('manual');
      await flushPromises();
      expect(coordinator.getPhase()).toBe('ready');
      expect(killChild).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests during idle-gave-up get an immediate synthesized error, not a queue', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const coordinator = new RestartCoordinator(deps, { maxCrashAttempts: 1, crashBackoffBaseMs: 10 });

      coordinator.onChildExit();
      vi.advanceTimersByTime(10);
      coordinator.onChildExit(); // exceeds maxCrashAttempts=1
      expect(coordinator.getPhase()).toBe('idle-gave-up');

      coordinator.handleHostLine('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}');
      expect(JSON.parse(deps.hostLines.at(-1)!)).toMatchObject({ id: 7, error: { code: -32000 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RestartCoordinator - cancelled requests', () => {
  it('stops awaiting a cancelled request, so idle suspend is not blocked forever', async () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);

    coordinator.handleHostLine('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}');
    // MCP forbids answering a cancelled request, so no response will ever come.
    coordinator.handleHostLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}');

    coordinator.suspend('idle');
    await flushPromises();

    expect(deps.suspendChild).toHaveBeenCalledTimes(1);
    expect(coordinator.getPhase()).toBe('suspended');
  });

  it('swallows a late response to a cancelled request', () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);

    coordinator.handleHostLine('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}');
    coordinator.handleHostLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}');
    deps.hostLines.length = 0;

    coordinator.handleChildLine('{"jsonrpc":"2.0","id":9,"result":{}}');
    expect(deps.hostLines).toEqual([]);
  });

  it('still blocks suspend for requests that were not cancelled', () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);

    coordinator.handleHostLine('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}');
    coordinator.handleHostLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":10}}');

    coordinator.suspend('idle');
    expect(deps.suspendChild).not.toHaveBeenCalled();
  });
});

// Real timers, so `.then()` chains attached to already-resolved/pending native
// Promises actually get a chance to run.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushPromises(): Promise<void> {
  await flushMicrotasks();
}

describe('RestartCoordinator - idle suspend', () => {
  const TOOL_CALL = '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}';

  async function handshake(deps: ReturnType<typeof makeDeps>, coordinator: RestartCoordinator) {
    coordinator.handleHostLine(INIT_REQUEST);
    coordinator.handleHostLine(INITIALIZED_NOTIF);
    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    deps.childLines.length = 0;
    deps.hostLines.length = 0;
  }

  it('tears the child down and stays suspended until the host speaks again', async () => {
    const deps = makeDeps();
    const suspendChild = vi.fn().mockResolvedValue(undefined);
    deps.suspendChild = suspendChild;
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle for 120 minute(s)');
    expect(suspendChild).toHaveBeenCalledTimes(1);
    await flushPromises();
    expect(coordinator.getPhase()).toBe('suspended');
    expect(deps.spawnChild).not.toHaveBeenCalled();
  });

  it('respawns and replays the handshake on the next host line', async () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    await flushPromises();

    coordinator.handleHostLine(TOOL_CALL);

    expect(deps.spawnChild).toHaveBeenCalledTimes(1);
    expect(coordinator.getPhase()).toBe('ready');
    // Replayed handshake first, then the request that woke us - and the
    // request is forwarded rather than answered with an error.
    expect(deps.childLines).toEqual([INIT_REQUEST, INITIALIZED_NOTIF, TOOL_CALL]);
    expect(deps.hostLines.every((line) => !line.includes('"error"'))).toBe(true);
  });

  it('swallows the replayed initialize response the host already has', async () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    await flushPromises();
    coordinator.handleHostLine(TOOL_CALL);

    coordinator.handleChildLine('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(deps.hostLines.some((line) => JSON.parse(line).id === 1)).toBe(false);

    coordinator.handleChildLine('{"jsonrpc":"2.0","id":9,"result":{}}');
    expect(JSON.parse(deps.hostLines.at(-1)!)).toMatchObject({ id: 9 });
  });

  it('queues a request that arrives while the child is still exiting', async () => {
    const deps = makeDeps();
    let releaseTeardown: () => void = () => {};
    deps.suspendChild = vi.fn(() => new Promise<void>((resolve) => { releaseTeardown = resolve; }));
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    expect(coordinator.getPhase()).toBe('suspending');

    coordinator.handleHostLine(TOOL_CALL);
    // Nothing spawned yet - two children must never be alive at once.
    expect(deps.spawnChild).not.toHaveBeenCalled();
    expect(deps.hostLines).toEqual([]);

    releaseTeardown();
    await flushPromises();

    expect(deps.spawnChild).toHaveBeenCalledTimes(1);
    expect(deps.childLines).toContain(TOOL_CALL);
  });

  it('refuses to suspend with a request in flight', () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);
    coordinator.handleHostLine(TOOL_CALL);

    coordinator.suspend('idle');

    expect(deps.suspendChild).not.toHaveBeenCalled();
    expect(coordinator.getPhase()).toBe('ready');
  });

  it('refuses to suspend while restarting', () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);
    coordinator.requestRestart('signal');

    coordinator.suspend('idle');

    expect(deps.suspendChild).not.toHaveBeenCalled();
  });

  it('ignores a restart trigger while suspended, leaving the next request to spawn a fresh build', async () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    await flushPromises();

    coordinator.requestRestart('signal');
    await flushPromises();

    expect(deps.killChild).not.toHaveBeenCalled();
    expect(deps.spawnChild).not.toHaveBeenCalled();
    expect(coordinator.getPhase()).toBe('suspended');
  });

  it('does not treat the suspended child\'s exit as a crash', async () => {
    const deps = makeDeps();
    deps.suspendChild = vi.fn(async () => { coordinator.onChildExit(); });
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    await flushPromises();

    expect(deps.spawnChild).not.toHaveBeenCalled();
    expect(coordinator.getPhase()).toBe('suspended');
  });

  it('falls back to killChild when no suspendChild is wired', async () => {
    const deps = makeDeps();
    const coordinator = new RestartCoordinator(deps);
    await handshake(deps, coordinator);

    coordinator.suspend('idle');
    await flushPromises();

    expect(deps.killChild).toHaveBeenCalledTimes(1);
    expect(coordinator.getPhase()).toBe('suspended');
  });
});
