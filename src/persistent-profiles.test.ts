/**
 * Tests for feature-013: named persistent Chrome profiles.
 *
 * Covers the three pieces of the feature:
 *  - ChromeLauncher: name validation, stable directories, ephemeral: false so
 *    the bug-007 cleanup paths leave them alone, and reset semantics.
 *  - ConfigManager: where the profile root resolves to (global by default,
 *    per-project override via chrome.persistentProfileRoot).
 *  - config tool: the resetProfile / listProfiles actions.
 *
 * No real Chrome is ever spawned - the launch path is exercised through the
 * profile bookkeeping it depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChromeLauncher,
  InvalidProfileNameError,
  ProfileInUseError,
  ProfileLockedError,
  decideProfileReuse,
  normalizeProfileName,
  type ChromeProfileRecord,
} from './chrome-launcher.js';
import { ConfigManager } from './config.js';
import { setWorkingDirOverride } from './helpers/paths.js';
import { createConfigTools } from './tools/config-tools.js';

let root: string;        // stands in for os.tmpdir() - ephemeral profiles
let persistentRoot: string;

function newLauncher(overrides: Record<string, unknown> = {}): ChromeLauncher {
  return new ChromeLauncher({
    profileRoot: root,
    persistentProfileRoot: persistentRoot,
    sweepStaleProfilesOnStartup: false,
    ...overrides,
  });
}

/** Minimal ChildProcess stand-in whose pid is this (very much alive) process. */
function fakeLiveChromeProcess() {
  const proc = new EventEmitter() as any;
  proc.pid = process.pid;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    setTimeout(() => proc.emit('exit', 0, null), 0);
    return true;
  };
  return proc;
}

/**
 * Write the SingletonLock symlink Chrome leaves in a live user-data-dir.
 * `pid` defaults to this process, i.e. "held by a browser that is still alive".
 * POSIX-only, like the launcher's own check.
 */
function writeSingletonLock(dir: string, pid: number = process.pid): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(`some-host-${pid}`, path.join(dir, 'SingletonLock'));
}

/** Replace the real spawn with bookkeeping that mimics its timing. */
function stubPerformLaunch(launcher: ChromeLauncher, delayMs = 20): number[] {
  const started: number[] = [];
  (launcher as any).performLaunch = async (
    port: number,
    _url?: string,
    _reserver?: unknown,
    _headless?: boolean,
    _extraArgs?: string[],
    profileName?: string
  ) => {
    started.push(port);
    // Mirrors performLaunch(): the profile is tracked well before the process is
    const record = (launcher as any).createProfileRecord(port, profileName);
    (launcher as any).profileDirs.set(port, record);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    (launcher as any).chromeProcesses.set(port, fakeLiveChromeProcess());
    return { port, pid: process.pid };
  };
  return started;
}

const posixOnly = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profiles-eph-'));
  persistentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profiles-persist-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(persistentRoot, { recursive: true, force: true });
});

describe('profile name validation', () => {
  it('accepts ordinary names', () => {
    for (const name of ['device-a', 'work_google', 'a', 'Owner.Console', 'd1']) {
      expect(normalizeProfileName(name)).toBe(name);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeProfileName('  device-a  ')).toBe('device-a');
  });

  it('rejects anything that could escape the profile root or confuse the sweep', () => {
    const bad = [
      '', '   ', '.', '..', '../evil', 'a/b', 'a\\b', '.hidden', '-leading',
      '/absolute', 'has space', 'emoji-🙂',
      'chrome-debug-profile-p9222-x',   // would be eaten by the startup sweep
      'x'.repeat(65),
    ];
    for (const name of bad) {
      expect(() => normalizeProfileName(name), name).toThrow(InvalidProfileNameError);
    }
  });
});

describe('persistent profile directories', () => {
  it('maps a name to a stable directory under the persistent root', () => {
    const launcher = newLauncher();
    expect(launcher.getPersistentProfilePath('device-a')).toBe(path.join(persistentRoot, 'device-a'));
  });

  it('does NOT pin a port - the same name gives the same dir on any port', () => {
    const launcher = newLauncher();
    const create = (port: number, name?: string) =>
      (launcher as any).createProfileRecord(port, name) as ChromeProfileRecord;

    const a = create(9222, 'device-a');
    const b = create(9333, 'device-a');

    expect(a.dir).toBe(b.dir);
    expect(path.basename(a.dir)).toBe('device-a');
    expect(a.dir).not.toContain('9222');
  });

  it('marks named profiles non-ephemeral so every cleanup path skips them', () => {
    const launcher = newLauncher();
    const named = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    const anon = (launcher as any).createProfileRecord(9222) as ChromeProfileRecord;

    expect(named.ephemeral).toBe(false);
    expect(anon.ephemeral).toBe(true);
    expect(path.dirname(anon.dir)).toBe(root);
  });

  it('rejects an invalid name before it reaches the filesystem', () => {
    const launcher = newLauncher();
    expect(() => launcher.getPersistentProfilePath('../escape')).toThrow(InvalidProfileNameError);
  });

  it('survives kill() of the Chrome that was using it', async () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    fs.mkdirSync(record.dir, { recursive: true });
    fs.writeFileSync(path.join(record.dir, 'state'), 'enrolled');

    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    await launcher.kill(9222);

    expect(fs.existsSync(path.join(record.dir, 'state'))).toBe(true);
  });

  it('is never touched by the startup sweep, even sharing the ephemeral root', async () => {
    const named = path.join(root, 'device-a');
    fs.mkdirSync(named, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(named, old, old);

    const launcher = new ChromeLauncher({
      profileRoot: root,
      persistentProfileRoot: root,
      sweepStaleProfilesOnStartup: false,
    });

    const removed = await launcher.sweepStaleProfiles();

    expect(removed).not.toContain(named);
    expect(fs.existsSync(named)).toBe(true);
  });

  it('re-resolves a function-valued root so a live config reload takes effect', () => {
    let current = persistentRoot;
    const launcher = new ChromeLauncher({
      profileRoot: root,
      persistentProfileRoot: () => current,
      sweepStaleProfilesOnStartup: false,
    });

    expect(launcher.getPersistentProfilePath('device-a')).toBe(path.join(persistentRoot, 'device-a'));
    current = path.join(persistentRoot, 'elsewhere');
    expect(launcher.getPersistentProfilePath('device-a')).toBe(path.join(current, 'device-a'));
  });

  it('lists the profiles that exist on disk', async () => {
    const launcher = newLauncher();
    fs.mkdirSync(path.join(persistentRoot, 'device-b'), { recursive: true });
    fs.mkdirSync(path.join(persistentRoot, 'device-a'), { recursive: true });
    fs.writeFileSync(path.join(persistentRoot, 'not-a-profile.txt'), 'x');

    expect(await launcher.listPersistentProfiles()).toEqual(['device-a', 'device-b']);
  });

  it('lists nothing when the root does not exist yet', async () => {
    const launcher = newLauncher({ persistentProfileRoot: path.join(persistentRoot, 'nope') });
    expect(await launcher.listPersistentProfiles()).toEqual([]);
  });
});

describe('one live Chrome per named profile', () => {
  it('findPortForProfile reports the port holding the profile', () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    expect(launcher.findPortForProfile('device-a')).toBe(9222);
    expect(launcher.findPortForProfile('device-b')).toBeUndefined();
  });

  it('ignores a tracked profile whose Chrome is gone', () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    (launcher as any).profileDirs.set(9222, record);
    // No process tracked - the Chrome died, the profile is free again.

    expect(launcher.findPortForProfile('device-a')).toBeUndefined();
  });

  it('launch() refuses a profile another live Chrome already holds', async () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    // Different port, same profile - would otherwise be handed off to the
    // Chrome on 9222 and our process would immediately exit.
    await expect(launcher.launch(9333, undefined, undefined, false, [], 'device-a'))
      .rejects.toBeInstanceOf(ProfileInUseError);
  });

  posixOnly('launch() refuses a profile another PROCESS\'s Chrome holds', async () => {
    // The default profile root is global, so a second devharness session can be
    // running this exact profile - invisible to our profileDirs/chromeProcesses.
    const launcher = newLauncher();
    writeSingletonLock(path.join(persistentRoot, 'device-a'));
    const started = stubPerformLaunch(launcher);

    await expect(launcher.launch(9222, undefined, undefined, false, [], 'device-a'))
      .rejects.toBeInstanceOf(ProfileLockedError);
    expect(started).toEqual([]); // never spawned, so no confusing singleton hand-off
  });

  posixOnly('launch() ignores a stale lock naming a dead process', async () => {
    const launcher = newLauncher();
    writeSingletonLock(path.join(persistentRoot, 'device-a'), 999999); // no such pid
    const started = stubPerformLaunch(launcher);

    await expect(launcher.launch(9222, undefined, undefined, false, [], 'device-a')).resolves.toMatchObject({ port: 9222 });
    expect(started).toEqual([9222]);
  });

  it('serialises two concurrent launches of the same profile', async () => {
    // Both used to pass the guard: findPortForProfile() needs isRunning(), which
    // is false for the whole spawn window, so the second Chrome was handed off
    // to the first singleton and died with a generic spawn failure.
    const launcher = newLauncher();
    const started = stubPerformLaunch(launcher);

    const [first, second] = await Promise.allSettled([
      launcher.launch(9222, undefined, undefined, false, [], 'device-a'),
      launcher.launch(9333, undefined, undefined, false, [], 'device-a'),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(ProfileInUseError);
    expect(started).toEqual([9222]);
  });

  it('still allows concurrent launches of DIFFERENT profiles', async () => {
    const launcher = newLauncher();
    const started = stubPerformLaunch(launcher);

    const results = await Promise.all([
      launcher.launch(9222, undefined, undefined, false, [], 'device-a'),
      launcher.launch(9333, undefined, undefined, false, [], 'device-b'),
    ]);

    expect(results.map(r => r.port)).toEqual([9222, 9333]);
    expect(started.sort()).toEqual([9222, 9333]);
  });
});

describe('decideProfileReuse - connection launch profile ordering', () => {
  const wanted = '/profiles/device-a';

  it('never interferes when no profile was requested', () => {
    expect(decideProfileReuse({ existing: { port: 9222, profileDir: '/other' }, holderPort: 9222 }))
      .toEqual({ decision: 'ok' });
  });

  it('reuses a live connection that is already running the requested profile', () => {
    // The regression: `connection({ action: 'launch', profile, name })` called again to
    // make sure the browser is up must reuse it, not error with "in use".
    expect(decideProfileReuse({
      wantedProfileDir: wanted,
      existing: { port: 9222, profileDir: wanted },
      holderPort: 9222,
    })).toEqual({ decision: 'ok' });
  });

  it('reports in-use only when the call would spawn a second Chrome', () => {
    expect(decideProfileReuse({ wantedProfileDir: wanted, holderPort: 9333 }))
      .toEqual({ decision: 'in-use', port: 9333 });
  });

  it('spawns freely when nothing holds the profile', () => {
    expect(decideProfileReuse({ wantedProfileDir: wanted })).toEqual({ decision: 'ok' });
  });

  it('prefers the in-use error when the reusable instance runs another profile and the profile is held elsewhere', () => {
    expect(decideProfileReuse({
      wantedProfileDir: wanted,
      existing: { port: 9222, profileDir: '/profiles/device-b' },
      holderPort: 9333,
    })).toEqual({ decision: 'in-use', port: 9333 });
  });

  it('reports a mismatch when the reusable instance runs another profile that nobody else holds', () => {
    expect(decideProfileReuse({
      wantedProfileDir: wanted,
      existing: { port: 9222, profileDir: '/profiles/device-b' },
    })).toEqual({ decision: 'mismatch', port: 9222, actualProfile: '/profiles/device-b' });
  });

  it('reports a mismatch for a Chrome we did not launch (profile unknown)', () => {
    expect(decideProfileReuse({ wantedProfileDir: wanted, existing: { port: 9222 } }))
      .toEqual({ decision: 'mismatch', port: 9222, actualProfile: undefined });
  });
});

describe('resetPersistentProfile', () => {
  it('wipes an existing profile and recreates it empty', async () => {
    const launcher = newLauncher();
    const dir = path.join(persistentRoot, 'device-a');
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{"enrolled":true}');

    const result = await launcher.resetPersistentProfile('device-a');

    expect(result).toEqual({ profile: 'device-a', path: dir, existed: true });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('creates the profile when it does not exist yet', async () => {
    const launcher = newLauncher();
    const result = await launcher.resetPersistentProfile('brand-new');

    expect(result.existed).toBe(false);
    expect(fs.existsSync(path.join(persistentRoot, 'brand-new'))).toBe(true);
  });

  it('refuses while a live Chrome still holds the profile', async () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    fs.mkdirSync(record.dir, { recursive: true });
    fs.writeFileSync(path.join(record.dir, 'state'), 'enrolled');
    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    await expect(launcher.resetPersistentProfile('device-a')).rejects.toBeInstanceOf(ProfileInUseError);
    // And nothing was destroyed on the way to refusing.
    expect(fs.existsSync(path.join(record.dir, 'state'))).toBe(true);
  });

  it('refuses an invalid name', async () => {
    const launcher = newLauncher();
    await expect(launcher.resetPersistentProfile('../etc')).rejects.toBeInstanceOf(InvalidProfileNameError);
  });

  posixOnly('refuses while ANOTHER process\'s Chrome holds the profile', async () => {
    // Session A launched device-a; session B - a different devharness process,
    // sharing the global profile root - must not rm -rf it out from under A.
    const launcher = newLauncher();
    const dir = path.join(persistentRoot, 'device-a');
    writeSingletonLock(dir);
    fs.writeFileSync(path.join(dir, 'state'), 'enrolled');

    await expect(launcher.resetPersistentProfile('device-a')).rejects.toBeInstanceOf(ProfileLockedError);
    expect(fs.readFileSync(path.join(dir, 'state'), 'utf-8')).toBe('enrolled');
  });

  posixOnly('still resets when the lock names a process that is gone', async () => {
    const launcher = newLauncher();
    const dir = path.join(persistentRoot, 'device-a');
    writeSingletonLock(dir, 999999); // crashed session left the lock behind
    fs.writeFileSync(path.join(dir, 'state'), 'enrolled');

    const result = await launcher.resetPersistentProfile('device-a');

    expect(result.existed).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('browser kill vs a relaunch on the same port', () => {
  it('does not delete the profile of a launch that claimed the port meanwhile', async () => {
    const launcher = newLauncher();
    const oldRecord: ChromeProfileRecord = {
      dir: path.join(root, 'chrome-debug-profile-p9222-old'),
      ephemeral: true,
    };
    fs.mkdirSync(oldRecord.dir, { recursive: true });
    (launcher as any).profileDirs.set(9222, oldRecord);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    const killing = launcher.kill(9222);

    // A relaunch tracks its fresh profile while the kill is still in flight -
    // the window between profileDirs.set() and chromeProcesses.set().
    const newRecord: ChromeProfileRecord = {
      dir: path.join(root, 'chrome-debug-profile-p9222-new'),
      ephemeral: true,
    };
    fs.mkdirSync(newRecord.dir, { recursive: true });
    (launcher as any).profileDirs.set(9222, newRecord);

    await killing;

    expect(fs.existsSync(newRecord.dir)).toBe(true);
    expect(launcher.getProfileDir(9222)).toBe(newRecord.dir);
  });

  it('still cleans up its own ephemeral profile when nobody else claimed the port', async () => {
    const launcher = newLauncher();
    const record: ChromeProfileRecord = {
      dir: path.join(root, 'chrome-debug-profile-p9222-mine'),
      ephemeral: true,
    };
    fs.mkdirSync(record.dir, { recursive: true });
    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    await launcher.kill(9222);

    expect(fs.existsSync(record.dir)).toBe(false);
    expect(launcher.getProfileDir(9222)).toBeUndefined();
  });

  it('cleans up a tracked profile whose process was already reaped', async () => {
    const launcher = newLauncher();
    const record: ChromeProfileRecord = {
      dir: path.join(root, 'chrome-debug-profile-p9222-orphan'),
      ephemeral: true,
    };
    fs.mkdirSync(record.dir, { recursive: true });
    (launcher as any).profileDirs.set(9222, record);
    // No process tracked at all - the early-return path in killInstance().

    await launcher.kill(9222);

    expect(fs.existsSync(record.dir)).toBe(false);
  });
});

describe('ConfigManager.getPersistentProfileRoot', () => {
  let tempDir: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profile-config-'));
    setWorkingDirOverride(tempDir);
    manager = new ConfigManager();
  });

  afterEach(() => {
    manager.stopWatching();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function withRoot(value: string): void {
    (manager.getConfig() as any).chrome.persistentProfileRoot = value;
  }

  it('defaults to the global ~/.devharness/profiles', () => {
    expect(manager.getChromeConfig().persistentProfileRoot).toBe('');
    expect(manager.getPersistentProfileRoot()).toBe(path.join(os.homedir(), '.devharness', 'profiles'));
  });

  it('honours an absolute per-project override', () => {
    withRoot(path.join(tempDir, 'browsers'));
    expect(manager.getPersistentProfileRoot()).toBe(path.join(tempDir, 'browsers'));
  });

  it('resolves a relative override against the working directory', () => {
    withRoot('./.devharness/profiles');
    expect(manager.getPersistentProfileRoot()).toBe(path.resolve(process.cwd(), '.devharness/profiles'));
  });

  it('expands a leading ~/', () => {
    withRoot('~/my-profiles');
    expect(manager.getPersistentProfileRoot()).toBe(path.join(os.homedir(), 'my-profiles'));
  });

  it('persists the setting through a save/reload round trip', async () => {
    const configPath = path.join(tempDir, '.devharness', 'config.json');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    onDisk.chrome.persistentProfileRoot = path.join(tempDir, 'browsers');
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));

    const result = await manager.reload();

    expect(result.changed).toBe(true);
    expect(manager.getPersistentProfileRoot()).toBe(path.join(tempDir, 'browsers'));
  });
});

describe('config({ action: "resetProfile" | "listProfiles" })', () => {
  function tools() {
    return createConfigTools(newLauncher());
  }

  it('resets a named profile', async () => {
    const dir = path.join(persistentRoot, 'device-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state'), 'enrolled');

    const response = await tools().config.handler({ action: 'resetProfile', profile: 'device-a' } as any);

    expect(response.isError).toBeFalsy();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('errors when no profile name is given', async () => {
    const response = await tools().config.handler({ action: 'resetProfile' } as any);
    expect(response.isError).toBe(true);
  });

  it('errors on an invalid profile name without touching the filesystem', async () => {
    const response = await tools().config.handler({ action: 'resetProfile', profile: '../escape' } as any);
    expect(response.isError).toBe(true);
    expect(fs.existsSync(path.join(persistentRoot, '..', 'escape'))).toBe(false);
  });

  it('refuses to reset a profile another process\'s Chrome has locked', async () => {
    if (process.platform === 'win32') return;
    const dir = path.join(persistentRoot, 'device-a');
    writeSingletonLock(dir);
    fs.writeFileSync(path.join(dir, 'state'), 'enrolled');

    const response = await tools().config.handler({ action: 'resetProfile', profile: 'device-a' } as any);

    expect(response.isError).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'state'), 'utf-8')).toBe('enrolled');
  });

  it('refuses to reset a profile a live Chrome is using', async () => {
    const launcher = newLauncher();
    const record = (launcher as any).createProfileRecord(9222, 'device-a') as ChromeProfileRecord;
    fs.mkdirSync(record.dir, { recursive: true });
    fs.writeFileSync(path.join(record.dir, 'state'), 'enrolled');
    (launcher as any).profileDirs.set(9222, record);
    (launcher as any).chromeProcesses.set(9222, fakeLiveChromeProcess());

    const response = await createConfigTools(launcher).config.handler(
      { action: 'resetProfile', profile: 'device-a' } as any
    );

    expect(response.isError).toBe(true);
    expect(fs.existsSync(path.join(record.dir, 'state'))).toBe(true);
  });

  it('lists existing profiles', async () => {
    fs.mkdirSync(path.join(persistentRoot, 'device-a'), { recursive: true });
    const response = await tools().config.handler({ action: 'listProfiles' } as any);
    expect(response.isError).toBeFalsy();
  });
});
