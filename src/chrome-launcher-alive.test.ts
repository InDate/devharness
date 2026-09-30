import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChromeLauncher } from './chrome-launcher.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const launcher = () => new ChromeLauncher({ sweepStaleProfilesOnStartup: false });
const failWith = (code: string) => vi.spyOn(process, 'kill').mockImplementation(() => {
  throw Object.assign(new Error(code), { code });
});

describe('whether a process is alive', () => {
  it('reads a process this user may not signal (EPERM) as alive', () => {
    failWith('EPERM');
    expect((launcher() as any).isProcessAlive(4242)).toBe(true);
  });

  it('reads a process that does not exist (ESRCH) as dead', () => {
    failWith('ESRCH');
    expect((launcher() as any).isProcessAlive(4242)).toBe(false);
  });
});

describe('launcher status', () => {
  it('hands out a copy of the close events, not the record itself', () => {
    const chrome = launcher();
    chrome.getStatus().lastCloseEvents.push({ port: 1, pid: 1, reason: 'manual', timestamp: new Date() });

    expect(chrome.getLastCloseEvents()).toEqual([]);
  });
});
