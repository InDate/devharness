import { describe, it, expect, vi, afterEach } from 'vitest';
import { ancestorTty, waitForTerminalDesktop, releaseWhenHeld, terminalDisplay, HELD_AFTER_MS, type DesktopWaitIo } from './terminal-desktop.js';

/** `ps -A -o pid=,ppid=,tty=` rows for a server under claude, under a Terminal login shell. */
const TABLE = `
    1     0 ??
  780     1 ??
12648   780 ttys027
12656 12648 ttys027
13159 12656 ttys027
13243 13159 ttys027
 4339 13159 ??
 4361  4339 ??
`;

describe('ancestorTty', () => {
  it('returns the tty of the nearest ancestor holding one', () => {
    expect(ancestorTty(TABLE, 4361)).toBe('/dev/ttys027');
  });

  it('returns the tty of the process itself when it holds one', () => {
    expect(ancestorTty(TABLE, 13243)).toBe('/dev/ttys027');
  });

  it('returns undefined when the chain reaches launchd with no tty', () => {
    expect(ancestorTty(TABLE, 780)).toBeUndefined();
  });

  it('returns undefined when a parent is absent from the table', () => {
    expect(ancestorTty(' 5000  4999 ??\n', 5000)).toBeUndefined();
  });
});

function fakeIo(overrides: Partial<DesktopWaitIo> = {}) {
  const started: string[] = [];
  let killed = 0;
  let finish: (output: string) => void = () => {};
  const io: DesktopWaitIo = {
    platform: 'darwin',
    env: {},
    pid: 4361,
    psTable: async () => TABLE,
    startWait(tty) {
      started.push(tty);
      return { result: new Promise<string>((resolve) => { finish = resolve; }), kill: () => { killed++; } };
    },
    ...overrides,
  };
  return { io, started, killed: () => killed, finish: (output: string) => finish(output) };
}

const never = new Promise<never>(() => {});

describe('waitForTerminalDesktop', () => {
  it('holds until the wait script exits, and returns its output', async () => {
    const fake = fakeIo();
    let settled = false;
    const waiting = waitForTerminalDesktop(never, fake.io).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.started).toEqual(['/dev/ttys027']);
    expect(settled).toBe(false);
    fake.finish('5');
    expect(await waiting).toBe('5');
  });

  it('ends the wait and kills the script when stop settles first', async () => {
    const fake = fakeIo();
    let exit: () => void = () => {};
    const stop = new Promise<void>((resolve) => { exit = resolve; });
    const waiting = waitForTerminalDesktop(stop, fake.io);
    await new Promise((r) => setTimeout(r, 20));
    exit();
    expect(await waiting).toBe('stopped');
    expect(fake.killed()).toBe(1);
  });

  it('starts no wait off macOS', async () => {
    const fake = fakeIo({ platform: 'linux' });
    expect(await waitForTerminalDesktop(never, fake.io)).toBe('skipped: not macOS');
    expect(fake.started).toEqual([]);
  });

  it('starts no wait with CDP_TOOLS_DESKTOP_WAIT=0', async () => {
    const fake = fakeIo({ env: { CDP_TOOLS_DESKTOP_WAIT: '0' } });
    expect(await waitForTerminalDesktop(never, fake.io)).toBe('skipped: CDP_TOOLS_DESKTOP_WAIT=0');
    expect(fake.started).toEqual([]);
  });

  it('starts no wait when no ancestor holds a tty', async () => {
    const fake = fakeIo({ pid: 780 });
    expect(await waitForTerminalDesktop(never, fake.io)).toBe('skipped: no tty');
    expect(fake.started).toEqual([]);
  });

  it('starts no wait when the process table cannot be read', async () => {
    const fake = fakeIo({ psTable: async () => { throw new Error('ps failed'); } });
    expect(await waitForTerminalDesktop(never, fake.io)).toBe('skipped: no tty');
    expect(fake.started).toEqual([]);
  });
});

describe('releaseWhenHeld', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('settles early with the tty once a desktop wait inside the call holds past HELD_AFTER_MS, and carries the call to its end', async () => {
    vi.useFakeTimers();
    const fake = fakeIo();
    const outcome = releaseWhenHeld(async () => `opened after ${await waitForTerminalDesktop(never, fake.io)}`);
    await vi.advanceTimersByTimeAsync(HELD_AFTER_MS);
    const held = await outcome;
    expect(held).toMatchObject({ done: false, tty: '/dev/ttys027' });
    fake.finish('5');
    expect(await (held as { rest: Promise<string> }).rest).toBe('opened after 5');
  });

  it('returns the reply when the wait ends before HELD_AFTER_MS, the Terminal\'s desktop already showing', async () => {
    vi.useFakeTimers();
    const fake = fakeIo();
    const outcome = releaseWhenHeld(async () => `opened after ${await waitForTerminalDesktop(never, fake.io)}`);
    await vi.advanceTimersByTimeAsync(10);
    fake.finish('5');
    await vi.advanceTimersByTimeAsync(HELD_AFTER_MS);
    expect(await outcome).toEqual({ done: true, value: 'opened after 5' });
  });

  it('rejects with the call\'s failure when it fails before holding', async () => {
    await expect(releaseWhenHeld(async () => { throw new Error('launch failed'); })).rejects.toThrow('launch failed');
  });
});

describe('terminalDisplay', () => {
  it('reads the display and the Terminal window\'s size from a wait reading', () => {
    const reading = JSON.stringify({ space: 5, display: { left: -919, top: -2160, width: 3840, height: 2160 }, window: { width: 2540, height: 2031 } });
    expect(terminalDisplay(reading)).toEqual({ left: -919, top: -2160, width: 3840, height: 2160, window: { width: 2540, height: 2031 } });
  });

  it('reads a display with no window size when the reading carries none', () => {
    expect(terminalDisplay(JSON.stringify({ space: 5, display: { left: 0, top: 0, width: 1800, height: 1169 } })))
      .toEqual({ left: 0, top: 0, width: 1800, height: 1169 });
  });

  it('returns undefined for a reading that names no display', () => {
    expect(terminalDisplay('none')).toBeUndefined();
    expect(terminalDisplay('stopped')).toBeUndefined();
    expect(terminalDisplay(JSON.stringify({ space: 5 }))).toBeUndefined();
  });
});
