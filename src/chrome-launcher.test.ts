/**
 * Tests for ChromeLauncher profile-directory handling.
 *
 * Covers bug-006 (temp user-data-dir names collided when two launches landed in
 * the same millisecond) and bug-007 (temp profiles were never deleted).
 *
 * These tests never spawn a real Chrome - they exercise the profile naming,
 * tracking, cleanup and startup-sweep logic directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { ChromeLauncher, ChromeBinaryAbsentError, ChromeLaunchFailure, EPHEMERAL_PROFILE_PREFIX, orphanedChromePorts, type ChromeProfileRecord } from './chrome-launcher.js';

/** A port that was bound and released, so nothing listens on it right now. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let root: string;

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-launcher-test-'));
}

function newLauncher(overrides: Record<string, unknown> = {}): ChromeLauncher {
  return new ChromeLauncher({
    profileRoot: root,
    sweepStaleProfilesOnStartup: false,
    ...overrides,
  });
}

/** Minimal ChildProcess stand-in that "exits" as soon as it is signalled. */
function fakeChromeProcess(pid = 999999) {
  const proc = new EventEmitter() as any;
  proc.pid = pid;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    setTimeout(() => proc.emit('exit', 0, null), 0);
    return true;
  };
  return proc;
}

function makeProfileDir(name: string, ageMs = 0): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  if (ageMs > 0) {
    age(dir, ageMs);
  }
  return dir;
}

/** Backdate a directory's mtime (writing inside it resets the clock). */
function age(dir: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
}

beforeEach(() => {
  root = makeRoot();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bug-006: profile directory naming', () => {
  it('produces distinct directories for concurrent launches on different ports in the same millisecond', () => {
    const launcher = newLauncher();
    const create = (port: number) => (launcher as any).createProfileRecord(port) as ChromeProfileRecord;

    const dirs = [9222, 9223, 9224, 9225].map(p => create(p).dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    // The whole batch is generated well inside one millisecond, so a Date.now()
    // -only name would have collided here.
    expect(dirs.every(d => path.basename(d).startsWith(EPHEMERAL_PROFILE_PREFIX))).toBe(true);
  });

  it('produces distinct directories for repeated launches on the SAME port', () => {
    const launcher = newLauncher();
    const dirs = Array.from({ length: 200 }, () => (launcher as any).createProfileRecord(9222).dir as string);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('embeds the port in the directory name and marks new profiles ephemeral', () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9333) as ChromeProfileRecord;
    expect(path.basename(record.dir)).toContain('p9333-');
    expect(path.dirname(record.dir)).toBe(root);
    expect(record.ephemeral).toBe(true);
  });
});

describe('bug-007: profile cleanup on kill', () => {
  it('deletes the tracked ephemeral profile when the instance is killed', async () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('chrome-debug-profile-p9222-kill');

    (launcher as any).profileDirs.set(9222, { dir, ephemeral: true });
    (launcher as any).chromeProcesses.set(9222, fakeChromeProcess());

    await launcher.kill(9222);

    expect(fs.existsSync(dir)).toBe(false);
    expect(launcher.getProfileDir(9222)).toBeUndefined();
  });

  it('kill() with no port cleans up every tracked instance', async () => {
    const launcher = newLauncher();
    const a = makeProfileDir('chrome-debug-profile-p9222-a');
    const b = makeProfileDir('chrome-debug-profile-p9223-b');

    (launcher as any).profileDirs.set(9222, { dir: a, ephemeral: true });
    (launcher as any).profileDirs.set(9223, { dir: b, ephemeral: true });
    (launcher as any).chromeProcesses.set(9222, fakeChromeProcess(999998));
    (launcher as any).chromeProcesses.set(9223, fakeChromeProcess(999999));

    await launcher.kill();

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(launcher.getProfiles().size).toBe(0);
  });

  it('cleans up a tracked profile even when the process was already reaped', async () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('chrome-debug-profile-p9222-reaped');
    (launcher as any).profileDirs.set(9222, { dir, ephemeral: true });
    // No entry in chromeProcesses - Chrome died outside our control.

    await launcher.kill(9222);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('NEVER deletes a profile marked persistent (issue 13 named profiles)', async () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('named-profile-alice');

    (launcher as any).profileDirs.set(9222, { dir, ephemeral: false });
    (launcher as any).chromeProcesses.set(9222, fakeChromeProcess());

    await launcher.kill(9222);

    expect(fs.existsSync(dir)).toBe(true);
    expect(launcher.getProfileDir(9222)).toBeUndefined(); // untracked, but kept on disk
  });

  it('a late exit event from a previous Chrome does not delete a relaunch profile on the same port', async () => {
    const launcher = newLauncher();
    const oldDir = makeProfileDir('chrome-debug-profile-p9222-old');
    const newDir = makeProfileDir('chrome-debug-profile-p9222-new');

    const oldRecord: ChromeProfileRecord = { dir: oldDir, ephemeral: true };
    const newRecord: ChromeProfileRecord = { dir: newDir, ephemeral: true };

    // Port has already been reclaimed by a newer launch.
    (launcher as any).profileDirs.set(9222, newRecord);

    await (launcher as any).removeProfileDir(9222, oldRecord);

    expect(fs.existsSync(newDir)).toBe(true);
    expect(launcher.getProfileDir(9222)).toBe(newDir);
  });

  it('reset() untracks profiles without deleting them (Chrome may still be alive)', () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('chrome-debug-profile-p9222-reset');
    (launcher as any).profileDirs.set(9222, { dir, ephemeral: true });

    launcher.reset(9222);

    expect(launcher.getProfileDir(9222)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('bug-007: startup sweep of stale profiles', () => {
  it('removes old ephemeral profiles left by previous sessions', async () => {
    const stale = makeProfileDir('chrome-debug-profile-p9222-stale', 2 * 60 * 60 * 1000);
    const launcher = newLauncher();

    const removed = await launcher.sweepStaleProfiles();

    expect(removed).toContain(stale);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('leaves recently created profiles alone (another instance may be launching)', async () => {
    const fresh = makeProfileDir('chrome-debug-profile-p9223-fresh');
    const launcher = newLauncher();

    const removed = await launcher.sweepStaleProfiles();

    expect(removed).not.toContain(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('leaves unrelated directories alone', async () => {
    const other = makeProfileDir('some-other-tool-profile', 2 * 60 * 60 * 1000);
    const launcher = newLauncher();

    await launcher.sweepStaleProfiles();

    expect(fs.existsSync(other)).toBe(true);
  });

  it('skips a stale profile whose SingletonLock names a live process', async () => {
    const locked = makeProfileDir('chrome-debug-profile-p9224-locked', 2 * 60 * 60 * 1000);
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(locked, 'SingletonLock'));
    age(locked, 2 * 60 * 60 * 1000);
    const launcher = newLauncher();

    const removed = await launcher.sweepStaleProfiles();

    expect(removed).not.toContain(locked);
    expect(fs.existsSync(locked)).toBe(true);
  });

  it('removes a stale profile whose SingletonLock names a dead process', async () => {
    const dead = makeProfileDir('chrome-debug-profile-p9225-dead', 2 * 60 * 60 * 1000);
    fs.symlinkSync(`${os.hostname()}-2147483600`, path.join(dead, 'SingletonLock'));
    age(dead, 2 * 60 * 60 * 1000);
    const launcher = newLauncher();

    const removed = await launcher.sweepStaleProfiles();

    expect(removed).toContain(dead);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('never sweeps a profile this launcher is currently using', async () => {
    const inUse = makeProfileDir('chrome-debug-profile-p9226-inuse', 2 * 60 * 60 * 1000);
    const launcher = newLauncher();
    (launcher as any).profileDirs.set(9226, { dir: inUse, ephemeral: true });

    await launcher.sweepStaleProfiles();

    expect(fs.existsSync(inUse)).toBe(true);
  });

  it('runs the sweep automatically on construction', async () => {
    const stale = makeProfileDir('chrome-debug-profile-p9227-auto', 2 * 60 * 60 * 1000);
    const launcher = new ChromeLauncher({ profileRoot: root });

    const removed = await launcher.startupSweep;

    expect(removed).toContain(stale);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('tolerates a missing profile root', async () => {
    const launcher = new ChromeLauncher({
      profileRoot: path.join(root, 'does-not-exist'),
      sweepStaleProfilesOnStartup: false,
    });
    await expect(launcher.sweepStaleProfiles()).resolves.toEqual([]);
  });
});

describe('launch observations', () => {
  it('retains a profile marked retained, and stops tracking it', async () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('chrome-debug-profile-p9222-retained');
    const record: ChromeProfileRecord = { dir, ephemeral: true, retained: true };

    (launcher as any).profileDirs.set(9222, record);
    await (launcher as any).removeProfileDir(9222, record);

    // The directory holds Chrome's startup logs, which are the only account of
    // a launch that produced no window.
    expect(fs.existsSync(dir)).toBe(true);
    expect(launcher.getProfileDir(9222)).toBeUndefined();
  });

  it('still deletes an ephemeral profile that was not retained', async () => {
    const launcher = newLauncher();
    const dir = makeProfileDir('chrome-debug-profile-p9222-not-retained');
    const record: ChromeProfileRecord = { dir, ephemeral: true };

    (launcher as any).profileDirs.set(9222, record);
    await (launcher as any).removeProfileDir(9222, record);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('records one failure per probe and names the probe count when it gives up', async () => {
    const launcher = newLauncher();
    const port = await closedPort();
    const probeFailures: string[] = [];

    await expect(
      (launcher as any).waitForChromeReady(port, 2, probeFailures)
    ).rejects.toThrow(`did not become inspectable in 2 probes`);

    expect(probeFailures).toHaveLength(2);
    expect(probeFailures.every(f => f.length > 0)).toBe(true);
  });

  it('throws ChromeBinaryAbsentError, spawning nothing, when no file is at the resolved path', async () => {
    const launcher = newLauncher();
    const missing = path.join(root, 'no-such-chrome');
    (launcher as any).getChromePath = () => missing;
    const port = await closedPort();

    await expect((launcher as any).performLaunch(port)).rejects.toThrow(ChromeBinaryAbsentError);
    // No profile was created, so nothing is left tracked or on disk.
    expect(launcher.getProfileDir(port)).toBeUndefined();
  });
  it('keeps the profile and reports the exit code when Chrome dies during startup', async () => {
    const launcher = newLauncher();
    const script = path.join(root, 'exits-immediately.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho "startup failed" >&2\nexit 3\n');
    fs.chmodSync(script, 0o755);
    (launcher as any).getChromePath = () => script;
    const port = await closedPort();

    const failure = await (launcher as any).performLaunch(port).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ChromeLaunchFailure);
    const o = (failure as ChromeLaunchFailure).observations;
    expect(o.exitCode).toBe(3);
    expect(o.stderrTail).toContain('startup failed');
    // Deleting this directory before the observations were taken was the defect
    // this test guards: Chrome's startup logs live in it.
    expect(o.profileDir).not.toBeNull();
    expect(fs.existsSync(o.profileDir as string)).toBe(true);
    // The probe loop stops on the exit rather than spending its whole budget.
    expect(o.probeAttempts).toBeLessThan(15);
  });
});

describe('orphanedChromePorts', () => {
  const THRESHOLD = 60_000;
  const ages: Record<number, number | undefined> = { 9301: 5_000, 9302: 120_000, 9303: 120_000, 9304: undefined };
  const inUse = new Set([9303]);

  const orphaned = () => orphanedChromePorts([9301, 9302, 9303, 9304], port => ages[port], port => inUse.has(port), THRESHOLD);

  it('leaves a Chrome younger than the threshold with no connection, a launch still connecting', () => {
    expect(orphaned()).not.toContain(9301);
  });

  it('takes a Chrome past the threshold that no connection uses', () => {
    expect(orphaned()).toContain(9302);
  });

  it('leaves a Chrome a connection uses, whatever its age', () => {
    expect(orphaned()).not.toContain(9303);
  });

  it('takes a Chrome with no spawn time recorded and no connection', () => {
    expect(orphaned()).toContain(9304);
  });
});
