import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClientWatcher,
  clientStillPresent,
  MISSES_BEFORE_SHUTDOWN,
  parseProcessLine,
  resolveClientIdentity,
  type ProcessInfo,
  type ProcessProbe,
} from './client-watcher.js';

type FakeEntry = ProcessInfo;

/** Builds a probe over a fake process table: pid -> { ppid, command }. */
function makeProbe(table: Record<number, FakeEntry>, dead = new Set<number>()): ProcessProbe {
  return {
    info: (pid): ProcessInfo | null => (dead.has(pid) ? null : table[pid] ?? null),
  };
}

describe('resolveClientIdentity', () => {
  it('finds the client through an npm exec wrapper', () => {
    // node <- npm exec <- claude, the shape a `npx cdp-tools-mcp` launch takes
    const probe = makeProbe({
      100: { ppid: 200, command: '/opt/node/bin/node /path/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: 'claude' },
      400: { ppid: 1, command: '/bin/zsh' },
    });

    expect(resolveClientIdentity(100, probe)).toEqual({ pid: 300, command: 'claude' });
  });

  it('finds the desktop app helper below the app itself', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node .bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: '/Applications/Claude.app/Contents/Helpers/disclaimer' },
      400: { ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
    });

    const client = resolveClientIdentity(100, probe);
    expect(client?.pid).toBe(300);
  });

  it('treats an npm-installed node host as the client, not as plumbing', () => {
    // The host itself is a node script here, so a rule that called every node
    // process plumbing would walk past it to the shell and terminal - which
    // outlive the client, leaving the tree unreaped.
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /Users/x/.npm/_npx/abc/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 400, command: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
      400: { ppid: 500, command: '/bin/zsh -l' },
      500: { ppid: 1, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('still walks past npm and npx machinery running under node', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js exec' },
      300: { ppid: 1, command: 'claude' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('treats a bare runtime with no script as plumbing', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'node' },
      300: { ppid: 1, command: 'code-helper' },
    });

    expect(resolveClientIdentity(100, probe)?.pid).toBe(300);
  });

  it('returns null when every ancestor is launch plumbing', () => {
    const probe = makeProbe({
      100: { ppid: 200, command: 'node /path/node_modules/.bin/cdp-tools-mcp' },
      200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
      300: { ppid: 1, command: '/bin/bash' },
    });

    expect(resolveClientIdentity(100, probe)).toBeNull();
  });

  it('returns null when the ancestry is unreadable', () => {
    expect(resolveClientIdentity(100, makeProbe({}))).toBeNull();
  });

  it('gives up rather than looping on a deep ancestry', () => {
    // Every entry is plumbing, so a bounded walk is the only thing that stops it.
    const table: Record<number, FakeEntry> = {};
    for (let pid = 100; pid < 200; pid++) {
      table[pid] = { ppid: pid + 1, command: 'npm exec something' };
    }
    expect(resolveClientIdentity(100, makeProbe(table), 5)).toBeNull();
  });
});

describe('ClientWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TABLE: Record<number, FakeEntry> = {
    100: { ppid: 200, command: 'node .bin/cdp-tools-mcp' },
    200: { ppid: 300, command: 'npm exec cdp-tools-mcp@latest' },
    300: { ppid: 1, command: 'claude' },
  };

  it('calls back once the client is gone', () => {
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TABLE, dead) });
    const onGone = vi.fn();

    expect(watcher.start(100, onGone)).toEqual({ pid: 300, command: 'claude' });

    vi.advanceTimersByTime(3000);
    expect(onGone).not.toHaveBeenCalled();

    dead.add(300);
    vi.advanceTimersByTime(1000 * MISSES_BEFORE_SHUTDOWN);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith({ pid: 300, command: 'claude' });

    // Stops polling after firing - one shutdown is enough.
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('watches nothing when no client can be identified', () => {
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe({}) });
    const onGone = vi.fn();

    expect(watcher.start(100, onGone)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('stops polling when stopped', () => {
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TABLE, dead) });
    const onGone = vi.fn();

    watcher.start(100, onGone);
    watcher.stop();
    dead.add(300);

    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});

/**
 * Twelve supervisors were found alive with their sessions days gone, each
 * burning CPU linear in its age at about 1.4 ms per 60-second poll - that poll
 * and nothing else. A pid-only liveness check on a recycled pid reads alive
 * forever, so the reaper never fired.
 */
describe('clientStillPresent', () => {
  const TREE: Record<number, FakeEntry> = {
    100: { ppid: 200, command: 'node .bin/devharness' },
    200: { ppid: 300, command: 'npm exec devharness@0.9.14' },
    300: { ppid: 1, command: 'claude' },
  };
  const CLIENT = { pid: 300, command: 'claude' };

  it('holds while the whole ancestry is intact', () => {
    expect(clientStillPresent(100, CLIENT, makeProbe(TREE))).toBe(true);
  });

  it('fails once the client exits and the wrapper reparents onto init', () => {
    // What `npm exec` surviving its client actually looks like: the wrapper
    // lives on with ppid 1, so the walk stops there instead of finding a client.
    const orphaned: Record<number, FakeEntry> = {
      100: { ppid: 200, command: 'node .bin/devharness' },
      200: { ppid: 1, command: 'npm exec devharness@0.9.14' },
    };
    expect(clientStillPresent(100, CLIENT, makeProbe(orphaned))).toBe(false);
  });

  it('fails when the client pid was recycled onto another process', () => {
    // The pid is alive and would pass a kill(pid, 0) check; the ancestry no
    // longer runs through it, which is what the twelve orphans missed.
    const recycled: Record<number, FakeEntry> = {
      100: { ppid: 200, command: 'node .bin/devharness' },
      200: { ppid: 1, command: 'npm exec devharness@0.9.14' },
      300: { ppid: 1, command: '/usr/sbin/cupsd' },
    };
    expect(clientStillPresent(100, CLIENT, makeProbe(recycled))).toBe(false);
  });

  it('fails when the walk lands on a different pid', () => {
    const moved: Record<number, FakeEntry> = {
      100: { ppid: 200, command: 'node .bin/devharness' },
      200: { ppid: 999, command: 'npm exec devharness@0.9.14' },
      999: { ppid: 1, command: 'claude' },
    };
    expect(clientStillPresent(100, CLIENT, makeProbe(moved))).toBe(false);
  });

  it('fails when the pid carries a different command', () => {
    const swapped: Record<number, FakeEntry> = {
      ...TREE,
      300: { ppid: 1, command: 'code helper' },
    };
    expect(clientStillPresent(100, CLIENT, makeProbe(swapped))).toBe(false);
  });
});

describe('ClientWatcher miss tolerance', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TREE: Record<number, FakeEntry> = {
    100: { ppid: 200, command: 'node .bin/devharness' },
    200: { ppid: 300, command: 'npm exec devharness@0.9.14' },
    300: { ppid: 1, command: 'claude' },
  };

  it('waits for three consecutive misses before shutting the tree down', () => {
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TREE, dead) });
    const onGone = vi.fn();
    watcher.start(100, onGone);

    dead.add(300);
    for (let poll = 1; poll < MISSES_BEFORE_SHUTDOWN; poll++) {
      vi.advanceTimersByTime(1000);
      expect(onGone).not.toHaveBeenCalled();
    }
    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('forgets earlier misses once the client is found again', () => {
    // A `ps` that times out reads exactly like an exit. Without the reset, two
    // unrelated timeouts days apart would add up to a shutdown.
    const dead = new Set<number>();
    const watcher = new ClientWatcher({ pollIntervalMs: 1000, probe: makeProbe(TREE, dead) });
    const onGone = vi.fn();
    watcher.start(100, onGone);

    dead.add(300);
    vi.advanceTimersByTime(2000);
    dead.delete(300);
    vi.advanceTimersByTime(1000);
    dead.add(300);
    vi.advanceTimersByTime(2000);
    expect(onGone).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});

describe('parseProcessLine', () => {
  it('reads ppid and command from a ps line', () => {
    expect(parseProcessLine('  40544 node /opt/homebrew/bin/devharness')).toEqual({
      ppid: 40544,
      command: 'node /opt/homebrew/bin/devharness',
    });
  });

  it('keeps the whole command including its arguments', () => {
    expect(parseProcessLine('81785 claude --resume d100b5ed-ecf8')).toEqual({
      ppid: 81785,
      command: 'claude --resume d100b5ed-ecf8',
    });
  });

  it('returns null for a line carrying no pid', () => {
    expect(parseProcessLine('')).toBeNull();
    expect(parseProcessLine('no numbers here')).toBeNull();
  });
});
