// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { CDPManager } from '../cdp-manager.js';
import { createExecutionTools } from './execution-tools.js';

const BREAKPOINT_ID = 'br:1:88:0:http://localhost:5173/src/NoteText.tsx?t=1';

function limitedLogpoint() {
  const cdpManager = new CDPManager();
  const Debugger = {
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    removeBreakpoint: vi.fn(async () => {}),
  };
  (cdpManager as any).client = { Debugger };
  (cdpManager as any).state.connected = true;

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
  return { cdpManager, Debugger, execution, logs };
}

describe('execution resume after a logpoint reached its limit', () => {
  it('refuses with the text of the last logs only', async () => {
    const { cdpManager, execution, logs } = limitedLogpoint();
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
    const { cdpManager, Debugger, execution, logs } = limitedLogpoint();
    await cdpManager.handleLogpointLimitExceeded({
      breakpointId: BREAKPOINT_ID, url: 'http://localhost:5173/src/NoteText.tsx', lineNumber: 89,
      logMessage: 'press', executionCount: 20, maxExecutions: 20, logs,
    });
    (cdpManager as any).state.paused = true;
    setTimeout(() => (cdpManager as any).resumeWaiters.forEach((resolve: () => void) => resolve()), 0);

    await cdpManager.removeBreakpoint(BREAKPOINT_ID);
    const result: any = await execution.handler({ action: 'resume', connection: 'page' });

    expect(result.isError).toBeUndefined();
    expect(Debugger.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps refusing when a different breakpoint is removed', async () => {
    const { cdpManager, Debugger, execution, logs } = limitedLogpoint();
    await cdpManager.handleLogpointLimitExceeded({
      breakpointId: BREAKPOINT_ID, url: 'http://localhost:5173/src/NoteText.tsx', lineNumber: 89,
      logMessage: 'press', executionCount: 20, maxExecutions: 20, logs,
    });

    await cdpManager.removeBreakpoint('br:1:12:0:http://localhost:5173/src/render/projection.ts');
    const result: any = await execution.handler({ action: 'resume', connection: 'page' });

    expect(result.isError).toBe(true);
    expect(Debugger.resume).not.toHaveBeenCalled();
  });
});
