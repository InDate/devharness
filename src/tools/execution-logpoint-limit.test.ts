// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (params?: any) => void;
const fake = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  calls: [] as string[],
}));

vi.mock('chrome-remote-interface', () => {
  // An object answering every property answers `then` too, and awaiting it
  // then waits on a promise that never settles.
  const domain = (name: string) => new Proxy({}, {
    get: (_target, prop: string) => prop === 'then' ? undefined : (arg?: unknown) => {
      if (typeof arg === 'function') {
        fake.handlers.set(`${name}.${prop}`, arg as Handler);
        return undefined;
      }
      fake.calls.push(`${name}.${prop}`);
      // Chrome answers resume, then sends Debugger.resumed.
      if (name === 'Debugger' && prop === 'resume') setTimeout(() => fake.handlers.get('Debugger.resumed')?.(), 0);
      if (name === 'Runtime' && prop === 'evaluate') return Promise.resolve({ result: { type: 'string', value: 'object' } });
      return Promise.resolve({});
    },
  });
  const client = new Proxy({}, {
    get: (_target, prop: string) => {
      if (prop === 'then') return undefined;
      if (/^[A-Z]/.test(prop)) return domain(prop);
      return () => Promise.resolve();
    },
  });
  return { default: vi.fn(async () => client) };
});

import { CDPManager } from '../cdp-manager.js';
import { createExecutionTools } from './execution-tools.js';

const BREAKPOINT_ID = 'br:1:88:0:http://localhost:5173/src/NoteText.tsx?t=1';

beforeEach(() => {
  fake.handlers.clear();
  fake.calls.length = 0;
});

const resumes = () => fake.calls.filter(call => call === 'Debugger.resume').length;

async function limitedLogpoint() {
  const cdpManager = new CDPManager();
  await cdpManager.connect('localhost', 9222);
  fake.calls.length = 0;

  const logs = Array.from({ length: 20 }, (_, i) => ({
    id: `console-${i}`,
    type: 'log',
    text: `[Logpoint] http://localhost:5173/src/NoteText.tsx:89:auto: press ${i}`,
    args: [`press ${i}`],
    stackTrace: Array.from({ length: 60 }, () => ({ url: 'preact.js', lineNumber: 256, columnNumber: 196 })),
    timestamp: i,
  }));

  const { execution } = createExecutionTools(async () => ({
    connection: {},
    cdpManager,
    puppeteerManager: null,
    consoleMonitor: null,
    networkMonitor: null,
  }));
  return { cdpManager, execution, logs };
}

describe('execution resume after a logpoint reached its limit', () => {
  it('refuses with the text of the last logs only', async () => {
    const { cdpManager, execution, logs } = await limitedLogpoint();
    await cdpManager.handleLogpointLimitExceeded({
      breakpointId: BREAKPOINT_ID, url: 'http://localhost:5173/src/NoteText.tsx', lineNumber: 89,
      logMessage: 'press', executionCount: 20, maxExecutions: 20, logs,
    });

    const result: any = await execution.handler({ action: 'resume', connection: 'page' });

    expect(result.isError).toBe(true);
    const text: string = result.content[0].text;
    expect(text).toContain('press 19');
    expect(text).not.toContain('press 14');
    expect(text).toContain('15 earlier logs omitted');
    expect(text).not.toContain('preact.js');
  });

  it('resumes once the logpoint is removed', async () => {
    const { cdpManager, execution, logs } = await limitedLogpoint();
    await cdpManager.handleLogpointLimitExceeded({
      breakpointId: BREAKPOINT_ID, url: 'http://localhost:5173/src/NoteText.tsx', lineNumber: 89,
      logMessage: 'press', executionCount: 20, maxExecutions: 20, logs,
    });
    fake.handlers.get('Debugger.paused')!({ reason: 'other', callFrames: [{ url: 'http://localhost:5173/src/NoteText.tsx', functionName: '', location: { scriptId: '1', lineNumber: 88 } }] });

    await cdpManager.removeBreakpoint(BREAKPOINT_ID);
    const result: any = await execution.handler({ action: 'resume', connection: 'page' });

    expect(result.isError).toBeUndefined();
    expect(resumes()).toBe(1);
    expect(cdpManager.isPaused()).toBe(false);
  });

  it('keeps refusing when a different breakpoint is removed', async () => {
    const { cdpManager, execution, logs } = await limitedLogpoint();
    await cdpManager.handleLogpointLimitExceeded({
      breakpointId: BREAKPOINT_ID, url: 'http://localhost:5173/src/NoteText.tsx', lineNumber: 89,
      logMessage: 'press', executionCount: 20, maxExecutions: 20, logs,
    });

    await cdpManager.removeBreakpoint('br:1:12:0:http://localhost:5173/src/render/projection.ts');
    const result: any = await execution.handler({ action: 'resume', connection: 'page' });

    expect(result.isError).toBe(true);
    expect(resumes()).toBe(0);
  });
});
