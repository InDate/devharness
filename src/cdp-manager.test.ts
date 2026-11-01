/**
 * Unit tests for CDPManager: disconnect()'s resume callback, expression
 * evaluation, console links, paused info, script lookup and callback stops.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CDPManager } from './cdp-manager.js';
import { ownScript } from './utils/own-script.js';

describe('CDPManager.disconnect() resume-callback handling', () => {
  // `client` and `state` are private, but typed loosely enough (client: any)
  // that poking them directly is the simplest way to exercise disconnect()'s
  // cleanup logic without standing up a real CDP connection.
  function withMockClient(cdpManager: CDPManager, close: () => Promise<void>, paused: boolean) {
    (cdpManager as any).client = { close };
    (cdpManager as any).state.paused = paused;
  }

  it('fires resumeCallback when disconnecting a paused connection', async () => {
    const cdpManager = new CDPManager();
    const resumeCallback = vi.fn();
    cdpManager.setResumeCallback(resumeCallback);
    const close = vi.fn().mockResolvedValue(undefined);
    withMockClient(cdpManager, close, true);

    await cdpManager.disconnect();

    expect(close).toHaveBeenCalledTimes(1);
    expect(resumeCallback).toHaveBeenCalledTimes(1);
  });

  it('does not fire resumeCallback when disconnecting a connection that was not paused', async () => {
    const cdpManager = new CDPManager();
    const resumeCallback = vi.fn();
    cdpManager.setResumeCallback(resumeCallback);
    const close = vi.fn().mockResolvedValue(undefined);
    withMockClient(cdpManager, close, false);

    await cdpManager.disconnect();

    expect(resumeCallback).not.toHaveBeenCalled();
  });

  it('still fires resumeCallback even if client.close() throws', async () => {
    const cdpManager = new CDPManager();
    const resumeCallback = vi.fn();
    cdpManager.setResumeCallback(resumeCallback);
    const close = vi.fn().mockRejectedValue(new Error('socket already closed'));
    withMockClient(cdpManager, close, true);

    await expect(cdpManager.disconnect()).rejects.toThrow('socket already closed');
    expect(resumeCallback).toHaveBeenCalledTimes(1);
  });
});

describe('CDPManager.evaluateExpression() - bug-004 (hang on thrown RangeError)', () => {
  // Root cause: Runtime.evaluate()/Debugger.evaluateOnCallFrame() report a
  // thrown exception via `exceptionDetails` on an otherwise *successful*
  // response, not via promise rejection. The old code never looked at
  // exceptionDetails, so a genuinely wedged CDP response (e.g. triggered by
  // a stack-exhaustion RangeError) had no code path that could ever produce
  // a result, an error, or a timeout - it just hung.
  function withMockRuntime(cdpManager: CDPManager, evaluate: (...args: any[]) => Promise<any>) {
    (cdpManager as any).client = { Runtime: { evaluate }, Debugger: {} };
    (cdpManager as any).state.connected = true;
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a thrown RangeError (exceptionDetails) as EvaluateExpressionExceptionError instead of hanging or swallowing it', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'undefined' },
      exceptionDetails: {
        text: 'Uncaught RangeError',
        exception: {
          type: 'object',
          subtype: 'error',
          className: 'RangeError',
          description: 'RangeError: Maximum call stack size exceeded\n    at <anonymous>:1:1',
        },
      },
    });
    withMockRuntime(cdpManager, evaluate);

    await expect(
      cdpManager.evaluateExpression('Math.max(...new Float32Array(32768))')
    ).rejects.toMatchObject({
      name: 'EvaluateExpressionExceptionError',
      exceptionType: 'RangeError',
      exceptionMessage: 'RangeError: Maximum call stack size exceeded',
    });
  });

  it('rejects with EvaluateExpressionTimeoutError instead of hanging forever when CDP never responds', async () => {
    vi.useFakeTimers();
    const cdpManager = new CDPManager();
    cdpManager.evaluateExpressionTimeoutMs = 5_000; // short bound, driven by fake timers
    const evaluate = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves - simulates the wedged renderer
    withMockRuntime(cdpManager, evaluate);

    const resultPromise = cdpManager.evaluateExpression('while(true){}');
    // Attach a rejection handler immediately so Node doesn't complain about
    // an unhandled rejection while fake timers are advanced below.
    const assertion = expect(resultPromise).rejects.toMatchObject({
      name: 'EvaluateExpressionTimeoutError',
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });

  it('still returns a normal formatted value when evaluation succeeds without an exception', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'number', value: 42 } });
    withMockRuntime(cdpManager, evaluate);

    const result = await cdpManager.evaluateExpression('40 + 2');
    expect(result).toBe('42');
  });

  it('passes CDP\'s own timeout param so well-behaved renderers can abort the runaway script themselves', async () => {
    const cdpManager = new CDPManager();
    cdpManager.evaluateExpressionTimeoutMs = 10_000;
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'number', value: 1 } });
    withMockRuntime(cdpManager, evaluate);

    await cdpManager.evaluateExpression('1');

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ expression: ownScript('evaluate', '1'), timeout: expect.any(Number) })
    );
    const passedTimeout = evaluate.mock.calls[0][0].timeout;
    expect(passedTimeout).toBeLessThan(10_000); // strictly less than our own client-side bound
    expect(passedTimeout).toBeGreaterThan(0);
  });
});

describe('CDPManager.evaluateExpression() - bug-015 (promises not awaited)', () => {
  // Empirically verified against Chrome 150 (see bug-015):
  // - Runtime.evaluate({ awaitPromise: true }) resolves promises normally
  //   while the page is running, but HANGS if the debugger is paused (the
  //   event loop is stopped, so the promise can never settle).
  // - Debugger.evaluateOnCallFrame IGNORES awaitPromise entirely and returns
  //   the Promise RemoteObject immediately.
  // - While paused, an already-settled promise's value is still recoverable
  //   via the [[PromiseState]]/[[PromiseResult]] internal properties.
  function withMockClient(
    cdpManager: CDPManager,
    mocks: {
      evaluate?: (...args: any[]) => Promise<any>;
      evaluateOnCallFrame?: (...args: any[]) => Promise<any>;
      getProperties?: (...args: any[]) => Promise<any>;
      callFunctionOn?: (...args: any[]) => Promise<any>;
      paused?: boolean;
    }
  ) {
    (cdpManager as any).client = {
      Runtime: {
        evaluate: mocks.evaluate,
        getProperties: mocks.getProperties,
        callFunctionOn: mocks.callFunctionOn,
      },
      Debugger: { evaluateOnCallFrame: mocks.evaluateOnCallFrame },
    };
    (cdpManager as any).state.connected = true;
    (cdpManager as any).state.paused = mocks.paused ?? false;
  }

  const fulfilledPromiseRemote = {
    type: 'object',
    subtype: 'promise',
    className: 'Promise',
    description: 'Promise',
    objectId: 'promise-1',
  };

  it('passes awaitPromise: true to Runtime.evaluate by default so async results resolve', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'string', value: 'AWAITED_OK' } });
    withMockClient(cdpManager, { evaluate });

    const result = await cdpManager.evaluateExpression("(async () => 'AWAITED_OK')()");

    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ awaitPromise: true }));
    expect(result).toBe('"AWAITED_OK"');
  });

  it('does NOT pass awaitPromise to Runtime.evaluate while the debugger is paused (it would hang until timeout)', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({ result: fulfilledPromiseRemote });
    const getProperties = vi.fn().mockResolvedValue({
      result: [],
      internalProperties: [
        { name: '[[PromiseState]]', value: { type: 'string', value: 'fulfilled' } },
        { name: '[[PromiseResult]]', value: { type: 'string', value: 'RECOVERED' } },
      ],
    });
    withMockClient(cdpManager, { evaluate, getProperties, paused: true });

    const result = await cdpManager.evaluateExpression('Promise.resolve("RECOVERED")');

    expect(evaluate.mock.calls[0][0]).not.toHaveProperty('awaitPromise');
    // ...but a promise that already settled is still recovered exactly,
    // via its [[PromiseResult]] internal property.
    expect(result).toBe('"RECOVERED"');
  });

  it('never passes awaitPromise to Debugger.evaluateOnCallFrame and recovers a settled promise via internal properties', async () => {
    const cdpManager = new CDPManager();
    const evaluateOnCallFrame = vi.fn().mockResolvedValue({ result: fulfilledPromiseRemote });
    const getProperties = vi.fn().mockResolvedValue({
      result: [],
      internalProperties: [
        { name: '[[PromiseState]]', value: { type: 'string', value: 'fulfilled' } },
        { name: '[[PromiseResult]]', value: { type: 'number', value: 42 } },
      ],
    });
    withMockClient(cdpManager, { evaluateOnCallFrame, getProperties, paused: true });

    const result = await cdpManager.evaluateExpression('Promise.resolve(42)', 'frame-1');

    expect(evaluateOnCallFrame.mock.calls[0][0]).not.toHaveProperty('awaitPromise');
    expect(result).toBe('42');
  });

  it('fails fast with EvaluateExpressionPendingPromiseError when a promise cannot settle at a paused frame', async () => {
    const cdpManager = new CDPManager();
    const evaluateOnCallFrame = vi.fn().mockResolvedValue({ result: fulfilledPromiseRemote });
    const getProperties = vi.fn().mockResolvedValue({
      result: [],
      internalProperties: [
        { name: '[[PromiseState]]', value: { type: 'string', value: 'pending' } },
        { name: '[[PromiseResult]]', value: { type: 'undefined' } },
      ],
    });
    withMockClient(cdpManager, { evaluateOnCallFrame, getProperties, paused: true });

    const started = Date.now();
    await expect(
      cdpManager.evaluateExpression('fetch("/never")', 'frame-1')
    ).rejects.toMatchObject({ name: 'EvaluateExpressionPendingPromiseError' });
    // Fail-fast, not a burn of the 10s client-side timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('surfaces a promise already rejected at a paused frame as EvaluateExpressionExceptionError', async () => {
    const cdpManager = new CDPManager();
    const evaluateOnCallFrame = vi.fn().mockResolvedValue({ result: fulfilledPromiseRemote });
    const getProperties = vi.fn().mockResolvedValue({
      result: [],
      internalProperties: [
        { name: '[[PromiseState]]', value: { type: 'string', value: 'rejected' } },
        {
          name: '[[PromiseResult]]',
          value: {
            type: 'object',
            subtype: 'error',
            className: 'Error',
            description: 'Error: PRE_PAUSE_REJ\n    at <anonymous>:1:1',
          },
        },
      ],
    });
    withMockClient(cdpManager, { evaluateOnCallFrame, getProperties, paused: true });

    await expect(
      cdpManager.evaluateExpression('globalThis.__rejected', 'frame-1')
    ).rejects.toMatchObject({
      name: 'EvaluateExpressionExceptionError',
      exceptionType: 'Error',
      exceptionMessage: 'Error: PRE_PAUSE_REJ',
    });
  });

  it('surfaces an awaited rejection with a primitive reason (no description on the exception)', async () => {
    const cdpManager = new CDPManager();
    // Chrome reports Promise.reject('plain-reason') as exceptionDetails with
    // text "Uncaught (in promise)" and the primitive as exception.value.
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'undefined' },
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { type: 'string', value: 'plain-reason' },
      },
    });
    withMockClient(cdpManager, { evaluate });

    await expect(cdpManager.evaluateExpression("Promise.reject('plain-reason')")).rejects.toMatchObject({
      name: 'EvaluateExpressionExceptionError',
      exceptionMessage: 'plain-reason',
    });
  });

  it('returns the Promise object itself when awaitPromise: false is passed', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({ result: fulfilledPromiseRemote });
    const getProperties = vi.fn();
    withMockClient(cdpManager, { evaluate, getProperties });

    const result = await cdpManager.evaluateExpression('Promise.resolve(1)', undefined, false, 2, {
      awaitPromise: false,
    });

    expect(evaluate.mock.calls[0][0]).not.toHaveProperty('awaitPromise');
    expect(getProperties).not.toHaveBeenCalled();
    expect(result).toBe('Promise');
  });
});

describe('CDPManager.evaluateExpressionDetailed() - exact raw capture for saveAs (bug-015)', () => {
  function withMockClient(cdpManager: CDPManager, mocks: any) {
    (cdpManager as any).client = {
      Runtime: {
        evaluate: mocks.evaluate,
        getProperties: mocks.getProperties,
        callFunctionOn: mocks.callFunctionOn,
      },
      Debugger: { evaluateOnCallFrame: mocks.evaluateOnCallFrame },
    };
    (cdpManager as any).state.connected = true;
    (cdpManager as any).state.paused = mocks.paused ?? false;
  }

  it('captures a plain object exactly via callFunctionOn returnByValue (no display round-trip)', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'object', className: 'Object', description: 'Object', objectId: 'obj-1' },
    });
    const callFunctionOn = vi.fn().mockResolvedValue({
      result: { type: 'object', value: { id: 7, name: 'kit', nested: { s: '42' } } },
    });
    // formatValue expansion path
    const getProperties = vi.fn().mockResolvedValue({ result: [] });
    withMockClient(cdpManager, { evaluate, getProperties, callFunctionOn });

    const detailed = await cdpManager.evaluateExpressionDetailed('state', undefined, true, 2, {
      captureRaw: true,
    });

    expect(callFunctionOn).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: 'obj-1', returnByValue: true })
    );
    expect(detailed.rawCaptured).toBe(true);
    // The string "42" stays a string - no deformat quoting heuristics involved.
    expect(detailed.rawValue).toEqual({ id: 7, name: 'kit', nested: { s: '42' } });
  });

  it('captures primitives exactly from the RemoteObject value', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'string', value: 'x "quoted" y' } });
    withMockClient(cdpManager, { evaluate });

    const detailed = await cdpManager.evaluateExpressionDetailed('s', undefined, true, 2, {
      captureRaw: true,
    });
    expect(detailed.rawCaptured).toBe(true);
    expect(detailed.rawValue).toBe('x "quoted" y');
  });

  it('falls back (rawCaptured: false) when the value is not serializable by value', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'object', className: 'Object', description: 'Window', objectId: 'win-1' },
    });
    const callFunctionOn = vi.fn().mockRejectedValue(new Error('Object reference chain is too long'));
    const getProperties = vi.fn().mockResolvedValue({ result: [] });
    withMockClient(cdpManager, { evaluate, getProperties, callFunctionOn });

    const detailed = await cdpManager.evaluateExpressionDetailed('window', undefined, true, 2, {
      captureRaw: true,
    });
    expect(detailed.rawCaptured).toBe(false);
  });

  it('does not attempt by-value capture for values that JSON-collapse to {} (Date, Map, DOM nodes)', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn().mockResolvedValue({
      result: { type: 'object', subtype: 'date', className: 'Date', description: 'Thu Jan 02 2026', objectId: 'date-1' },
    });
    const callFunctionOn = vi.fn();
    withMockClient(cdpManager, { evaluate, callFunctionOn });

    const detailed = await cdpManager.evaluateExpressionDetailed('new Date()', undefined, false, 2, {
      captureRaw: true,
    });
    expect(callFunctionOn).not.toHaveBeenCalled();
    expect(detailed.rawCaptured).toBe(false);
  });
});

describe('CDPManager.injectConsoleLink()', () => {
  // A pause requested on an idle page takes effect at the next JavaScript the
  // page runs, and the console link is JavaScript: its evaluation is held until
  // the page resumes, and a breakpoint set waiting on it held with it.
  it('returns without waiting for the page to run the link', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn(() => new Promise(() => {}));
    (cdpManager as any).client = { Runtime: { evaluate }, Debugger: {} };
    (cdpManager as any).state.connected = true;

    const settled = await Promise.race([
      cdpManager.injectConsoleLink('http://app/app.js', 2, 'Breakpoint set at').then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('still waiting'), 200)),
    ]);

    expect(settled).toBe('returned');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('CDPManager.getPausedInfo()', () => {
  it('reports the top frame in 1-based line and column, where Chrome reports them 0-based', () => {
    const cdpManager = new CDPManager();
    (cdpManager as any).state.paused = true;
    (cdpManager as any).state.currentCallFrames = [{ callFrameId: 'f1', functionName: 'tick', location: { scriptId: '7', lineNumber: 2, columnNumber: 4 } }];
    (cdpManager as any).scriptIdToUrl.set('7', 'http://app/app.js');

    expect(cdpManager.getPausedInfo().location).toMatchObject({ url: 'http://app/app.js', lineNumber: 3, columnNumber: 5 });
  });
});

describe('CDPManager script lookup by a partial URL', () => {
  it('matches a path suffix at a path boundary only', () => {
    const cdpManager = new CDPManager();
    (cdpManager as any).urlToScriptId.set('http://app.test/ads/doubleclick.js', ['7']);
    (cdpManager as any).urlToScriptId.set('http://app.test/controls/click.js', ['3']);

    expect((cdpManager as any).findScriptIds('click.js').matchedUrl).toBe('http://app.test/controls/click.js');
    expect((cdpManager as any).findScriptIds('controls/click.js').matchedUrl).toBe('http://app.test/controls/click.js');
    expect((cdpManager as any).findScriptIds('bleclick.js')).toBeNull();
  });
});

describe('CDPManager console link text', () => {
  it('stays one valid expression when the URL holds a quote', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn(async () => ({}));
    (cdpManager as any).client = { Runtime: { evaluate }, Debugger: {} };
    (cdpManager as any).state.connected = true;

    await cdpManager.injectConsoleLink("http://app.test/it's.js", 4, 'Breakpoint set at');

    const logged: unknown[][] = [];
    new Function('console', (evaluate.mock.calls[0] as any)[0].expression)({ log: (...args: unknown[]) => logged.push(args) });
    expect(String(logged[0][0])).toContain("http://app.test/it's.js:4");
  });
});

describe('CDPManager array display', () => {
  it('shows an unexpanded array by its description once', async () => {
    const cdpManager = new CDPManager();
    const evaluate = vi.fn(async () => ({ result: { type: 'object', subtype: 'array', description: 'Array(3)' } }));
    (cdpManager as any).client = { Runtime: { evaluate }, Debugger: {} };
    (cdpManager as any).state.connected = true;

    expect(await cdpManager.evaluateExpression('[1, 2, 3]', undefined, false)).toBe('Array(3)');
  });
});

describe('CDPManager.disarmPause() - a pause asked for while no JS ran', () => {
  // Chrome has no command that cancels a pending pause, so the mock plays the
  // part of the page: the statement disarmPause runs fires the pause, as
  // Debugger.paused would, and resume ends it, as Debugger.resumed would.
  function armedManager() {
    const manager = new CDPManager();
    const state = (manager as any).state;
    state.connected = true;
    const fire = () => {
      state.paused = true;
      (manager as any).pauseArmed = false;
      for (const resolve of (manager as any).pauseResolvers.splice(0)) resolve();
    };
    const evaluate = vi.fn(async () => { fire(); return { result: { type: 'number', value: 0 } }; });
    const resume = vi.fn(async () => {
      state.paused = false;
      for (const resolve of (manager as any).resumeWaiters.splice(0)) resolve();
    });
    (manager as any).client = { Runtime: { evaluate }, Debugger: { pause: vi.fn(async () => {}), resume } };
    return { manager, evaluate, resume, state };
  }

  it('fires the armed pause on one statement and resumes from it', async () => {
    const { manager, evaluate, resume, state } = armedManager();
    await manager.pause();
    await manager.disarmPause();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(state.paused).toBe(false);
  });

  it('runs nothing where no pause is armed', async () => {
    const { manager, evaluate, resume } = armedManager();
    await manager.disarmPause();
    expect(evaluate).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('runs nothing where the armed pause has already fired', async () => {
    const { manager, evaluate, state } = armedManager();
    await manager.pause();
    state.paused = true;
    (manager as any).pauseArmed = false;
    await manager.disarmPause();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('CDPManager callback stops - what moves a held page one callback or one frame', () => {
  function connectedManager(connected = true) {
    const manager = new CDPManager();
    (manager as any).state.connected = connected;
    const send = vi.fn(async () => ({}));
    (manager as any).client = { send };
    return { manager, send };
  }

  it('stops the page in front of each named kind of callback', async () => {
    const { manager, send } = connectedManager();
    await manager.setInstrumentationBreakpoints(['setTimeout.callback', 'requestAnimationFrame.callback']);
    expect(send.mock.calls).toEqual([
      ['EventBreakpoints.setInstrumentationBreakpoint', { eventName: 'setTimeout.callback' }],
      ['EventBreakpoints.setInstrumentationBreakpoint', { eventName: 'requestAnimationFrame.callback' }],
    ]);
  });

  it('refuses to set stops without a debugger connected', async () => {
    const { manager, send } = connectedManager(false);
    await expect(manager.setInstrumentationBreakpoints(['setTimeout.callback'])).rejects.toThrow('Not connected');
    expect(send).not.toHaveBeenCalled();
  });

  it('takes every stop off at once', async () => {
    const { manager, send } = connectedManager();
    await manager.clearInstrumentationBreakpoints();
    expect(send.mock.calls).toEqual([['EventBreakpoints.disable']]);
  });

  it('clears nothing without a debugger connected, where there is no stop to take off', async () => {
    const { manager, send } = connectedManager(false);
    await manager.clearInstrumentationBreakpoints();
    expect(send).not.toHaveBeenCalled();
  });
});
