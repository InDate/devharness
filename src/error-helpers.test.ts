import { describe, it, expect } from 'vitest';
import { checkBrowserAutomation, setChromeLauncher } from './error-helpers.js';
import type { ChromeLauncher } from './chrome-launcher.js';
import type { CDPManager } from './cdp-manager.js';

function launcher(state: { spawned: boolean; running: boolean; closedSince: boolean }): ChromeLauncher {
  return {
    spawnedOn: () => state.spawned,
    isRunning: () => state.running,
    closedSince: () => state.closedSince,
  } as unknown as ChromeLauncher;
}

const disconnected = { isConnected: () => false } as unknown as CDPManager;
const browser = { port: 9333, createdAt: Date.now() };
const errorId = (response: unknown) => (response as { _errorId?: string } | null)?._errorId;

describe('checkBrowserAutomation', () => {
  it('passes the liveness check for a Chrome devharness attached to and never spawned', () => {
    setChromeLauncher(launcher({ spawned: false, running: false, closedSince: false }));
    expect(errorId(checkBrowserAutomation(disconnected, null, 'extractText', browser))).toBe('DEBUGGER_NOT_CONNECTED');
  });

  it('reports a spawned Chrome whose process is gone as not running', () => {
    setChromeLauncher(launcher({ spawned: true, running: false, closedSince: false }));
    expect(errorId(checkBrowserAutomation(disconnected, null, 'extractText', browser))).toBe('CHROME_NOT_RUNNING');
  });

  it('reports a spawned Chrome that closed since the connection was made as not running', () => {
    setChromeLauncher(launcher({ spawned: false, running: false, closedSince: true }));
    expect(errorId(checkBrowserAutomation(disconnected, null, 'extractText', browser))).toBe('CHROME_NOT_RUNNING');
  });
});
