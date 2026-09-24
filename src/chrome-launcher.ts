/**
 * Chrome Launcher
 * Utilities for launching Chrome with debugging enabled
 */

import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { getGlobalBase } from './helpers/paths.js';
import { getErrorMessage } from './messages.js';
import type { PortReserver } from './port-reserver.js';
import { debugLog } from './debug-logger.js';
import WebSocket from 'ws';

export type ChromeCloseReason = 'inactivity' | 'manual' | 'crash' | 'external' | 'signal' | 'unknown';

export interface ChromeCloseEvent {
  port: number;
  pid: number;
  reason: ChromeCloseReason;
  timestamp: Date;
  exitCode?: number | null;
  signal?: string | null;
}

export type ChromeExitCallback = (event: ChromeCloseEvent) => void | Promise<void>;

/**
 * Prefix used for all launcher-created temporary Chrome profile directories.
 * The startup sweep only ever considers directories with this prefix.
 */
export const EPHEMERAL_PROFILE_PREFIX = 'chrome-debug-profile-';

/**
 * A Chrome user-data-dir tracked by the launcher.
 *
 * `ephemeral` records a throwaway profile we created and are therefore allowed
 * to delete when the instance goes away. Named/persistent profiles (see issue
 * 13) will be registered with `ephemeral: false` and must never be deleted by
 * the launcher, neither on kill nor by the startup sweep.
 */
export interface ChromeProfileRecord {
  dir: string;
  ephemeral: boolean;
  /**
   * Set by a launch that failed, so removeProfileDir() leaves the directory in
   * place. Chrome's own startup logs are written there and are the only record
   * of why the window never painted; the startup sweep removes it later.
   */
  retained?: boolean;
}

/**
 * Legal characters for a named persistent profile (issue 13).
 *
 * Deliberately strict: the name becomes a directory under the profile root, so
 * anything that could escape it (`/`, `..`, leading dot) or confuse the startup
 * sweep is rejected rather than sanitised - silently renaming a profile would
 * hand the caller a different identity than they asked for.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Thrown when a profile name is not a safe single directory segment. */
export class InvalidProfileNameError extends Error {
  constructor(public readonly profile: string) {
    super(
      `Invalid profile name "${profile}". Use 1-64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.`
    );
    this.name = 'InvalidProfileNameError';
  }
}

/** Thrown when an operation would disturb a profile a live Chrome is holding. */
export class ProfileInUseError extends Error {
  constructor(public readonly profile: string, public readonly port: number) {
    super(`Profile "${profile}" is in use by the Chrome running on port ${port}.`);
    this.name = 'ProfileInUseError';
  }
}

/**
 * Thrown when a profile is held by a Chrome this process did not launch -
 * typically another devharness session on the same machine, because the default
 * persistent profile root (`~/.devharness/profiles`) is global.
 *
 * Detected from the profile's Chrome `SingletonLock`, so we know the holding
 * PID but not which debug port it listens on.
 *
 * LIMITATION: the check is POSIX-only. `SingletonLock` is a symlink on
 * macOS/Linux; on Windows Chrome uses a plain lock file we cannot read a PID
 * from, so this error is never raised there and the cross-session races it
 * guards against remain possible.
 */
export class ProfileLockedError extends Error {
  constructor(public readonly profile: string, public readonly pid: number, public readonly dir: string) {
    super(
      `Profile "${profile}" is locked by a Chrome started by another process (PID ${pid}, ${dir}). ` +
      `Only one live Chrome may hold a profile; quit that browser (or use a different profile name) and retry.`
    );
    this.name = 'ProfileLockedError';
  }
}

/** Bytes of Chrome's stderr retained for a launch that failed. */
export const STDERR_TAIL_BYTES = 4096;

/**
 * What was observed while a launch ran. Every field is a reading taken during
 * the launch; none of them names a cause or a remedy, because the session that
 * reads them does that work.
 */
export interface LaunchObservations {
  /** The path getChromePath() resolved for this platform. */
  chromePath: string;
  platform: string;
  /** Whether a file existed at chromePath when the launch started. */
  binaryPresent: boolean;
  port: number;
  pid: number | null;
  /** The retained profile directory, or null when it was removed. */
  profileDir: string | null;
  /** Probes of /json/version made before the launch was abandoned. */
  probeAttempts: number;
  /** Each probe's failure, in order. */
  probeFailures: string[];
  /** The last STDERR_TAIL_BYTES bytes Chrome wrote to stderr. */
  stderrTail: string;
  /** The spawn error's message when no process was produced, null otherwise. */
  spawnFailure: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  /** Milliseconds from spawn to the launch being abandoned. */
  elapsedMs: number;
}

/** Thrown when no file exists at the resolved Chrome path. */
export class ChromeBinaryAbsentError extends Error {
  constructor(public readonly chromePath: string, public readonly platform: string) {
    super(`No file exists at ${chromePath} (platform ${platform}).`);
    this.name = 'ChromeBinaryAbsentError';
  }
}

/**
 * Thrown when Chrome spawned and the debugging port did not become
 * inspectable. Carries the readings taken during the launch.
 */
export class ChromeLaunchFailure extends Error {
  constructor(message: string, public readonly observations: LaunchObservations) {
    super(message);
    this.name = 'ChromeLaunchFailure';
  }
}

/**
 * Validate a persistent profile name, returning it trimmed.
 * @throws InvalidProfileNameError
 */
export function normalizeProfileName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!PROFILE_NAME_PATTERN.test(trimmed) || trimmed.startsWith(EPHEMERAL_PROFILE_PREFIX)) {
    throw new InvalidProfileNameError(name);
  }
  return trimmed;
}

/** Outcome of resolveLaunchPort(). */
export type LaunchPortDecision =
  | { decision: 'use'; port: number }
  /** forceNewInstance asked for a specific port that is already taken. */
  | { decision: 'forced-port-in-use'; port: number };

export interface LaunchPortRequest {
  /** `port` as passed to launchChrome, if the caller gave one. */
  explicitPort?: number;
  forceNewInstance?: boolean;
  /** This session's reserved port - the default when no port is given. */
  reservedPort: number;
  /** Is `port` held by anything other than our own reservation? */
  isPortOccupied: (port: number) => Promise<boolean>;
  /** Pick a genuinely free port (only consulted for a portless forceNewInstance). */
  findFreePort: () => Promise<number>;
}

/**
 * Decide which port a launchChrome call should use (bug-005).
 *
 * Extracted from the MCP handler so the decision is testable without a browser
 * or an MCP server: src/index.ts calls main() on import, so anything left
 * inline there can only be "tested" by grepping the source.
 *
 * Rules:
 *  - An explicit `port` is always honoured, never silently relocated.
 *  - `forceNewInstance` must produce a fresh process, so an explicit port that
 *    is already occupied is an error rather than a hand-off to whatever is
 *    listening; occupancy is only consulted in that case.
 *  - `forceNewInstance` without a port picks a known-free port instead of the
 *    reserved one, which an existing instance may already be using.
 */
export async function resolveLaunchPort(req: LaunchPortRequest): Promise<LaunchPortDecision> {
  const { explicitPort, forceNewInstance, reservedPort } = req;

  if (!forceNewInstance) {
    return { decision: 'use', port: explicitPort ?? reservedPort };
  }

  if (explicitPort !== undefined) {
    if (await req.isPortOccupied(explicitPort)) {
      return { decision: 'forced-port-in-use', port: explicitPort };
    }
    return { decision: 'use', port: explicitPort };
  }

  return { decision: 'use', port: await req.findFreePort() };
}

/** Outcome of decideProfileReuse(). */
export type ProfileReuseDecision =
  /** Nothing in the way: reuse the existing instance, or spawn if there is none. */
  | { decision: 'ok' }
  /** The requested profile is held by a different live Chrome on `port`. */
  | { decision: 'in-use'; port: number }
  /** The instance we would reuse is running a different profile. */
  | { decision: 'mismatch'; port: number; actualProfile?: string };

export interface ProfileReuseRequest {
  /** Directory of the requested named profile; undefined when none was asked for. */
  wantedProfileDir?: string;
  /**
   * The live Chrome this call would otherwise reuse (matched by reference or by
   * target port), and the profile dir we have tracked for it (undefined when it
   * was not launched by us, so we cannot know).
   */
  existing?: { port: number; profileDir?: string };
  /** Port of the live Chrome currently holding the requested profile, if any. */
  holderPort?: number;
}

/**
 * Decide whether a launchChrome call may reuse an existing Chrome, given the
 * named profile it asked for (issue 13 / bug: profile pre-check ordering).
 *
 * The ordering this encodes is the whole point: a live instance already running
 * the requested profile is REUSED, exactly as it would be without a profile, so
 * the idempotent `launchChrome({ profile, reference })` "make sure it's up"
 * pattern keeps working. "Profile in use" is only an error when the call would
 * have to put a SECOND Chrome on a profile another instance holds.
 */
export function decideProfileReuse(req: ProfileReuseRequest): ProfileReuseDecision {
  const { wantedProfileDir, existing, holderPort } = req;

  if (!wantedProfileDir) {
    return { decision: 'ok' };
  }

  if (!existing) {
    // We would spawn - a holder elsewhere means a second Chrome on one profile.
    return holderPort !== undefined ? { decision: 'in-use', port: holderPort } : { decision: 'ok' };
  }

  if (existing.profileDir === wantedProfileDir) {
    return { decision: 'ok' }; // same profile, same browser - plain reuse
  }

  if (holderPort !== undefined && holderPort !== existing.port) {
    // Reuse is out (wrong profile) and spawning is out (someone holds it).
    return { decision: 'in-use', port: holderPort };
  }

  return { decision: 'mismatch', port: existing.port, actualProfile: existing.profileDir };
}

export interface ChromeLauncherOptions {
  /** Directory the temporary profiles live in. Defaults to os.tmpdir(). */
  profileRoot?: string;
  /**
   * Directory named persistent profiles (issue 13) live in. Defaults to
   * `~/.devharness/profiles`. A function is resolved on every use so a live
   * config reload (`chrome.persistentProfileRoot`) takes effect immediately.
   */
  persistentProfileRoot?: string | (() => string);
  /** Sweep stale ephemeral profiles on construction. Defaults to true. */
  sweepStaleProfilesOnStartup?: boolean;
  /**
   * A stale profile dir must be at least this old (mtime) before the startup
   * sweep will remove it. Guards against deleting a profile belonging to a
   * Chrome that another MCP instance is launching right now. Defaults to 1h.
   */
  staleProfileMaxAgeMs?: number;
}

export class ChromeLauncher {
  private chromeProcesses: Map<number, ChildProcess> = new Map();
  private launchLocks: Map<number, Promise<{ port: number; pid: number }>> = new Map();
  /** profile name -> in-flight launch for that profile (see launch()) */
  private profileLaunchLocks: Map<string, Promise<{ port: number; pid: number }>> = new Map();
  private lastCloseEvents: ChromeCloseEvent[] = [];
  private maxCloseEvents: number = 10; // Keep last 10 close events
  private pendingCloseReason: Map<number, ChromeCloseReason> = new Map(); // Track reason before kill
  private onExitCallback: ChromeExitCallback | null = null;
  /** port -> profile dir currently in use by the Chrome on that port */
  private profileDirs: Map<number, ChromeProfileRecord> = new Map();
  private profileRoot: string;
  private persistentProfileRootOption: string | (() => string);
  private staleProfileMaxAgeMs: number;
  /** Resolves once the startup sweep (if any) has finished. Exposed for tests. */
  readonly startupSweep: Promise<string[]>;

  constructor(options: ChromeLauncherOptions = {}) {
    this.profileRoot = options.profileRoot ?? os.tmpdir();
    this.persistentProfileRootOption =
      options.persistentProfileRoot ?? path.join(getGlobalBase(), 'profiles');
    this.staleProfileMaxAgeMs = options.staleProfileMaxAgeMs ?? 60 * 60 * 1000;

    // Sweep profiles left behind by crashed/killed sessions. Fire-and-forget:
    // a failure here must never prevent the launcher from being usable.
    this.startupSweep = options.sweepStaleProfilesOnStartup === false
      ? Promise.resolve([])
      : this.sweepStaleProfiles().catch((error) => {
          debugLog('ChromeLauncher', `Startup profile sweep failed: ${error}`).catch(() => {});
          return [] as string[];
        });
  }

  /**
   * Set a callback to be invoked when any Chrome process exits.
   * Used for cleanup (closing stale connections) and port re-reservation.
   */
  setOnExitCallback(callback: ChromeExitCallback): void {
    this.onExitCallback = callback;
  }

  /**
   * Get the Chrome executable path for the current platform
   */
  private getChromePath(): string {
    const platform = os.platform();

    switch (platform) {
      case 'darwin': // macOS
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      case 'win32': // Windows
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      case 'linux':
        // Try common Linux paths
        return '/usr/bin/google-chrome';
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Create Chrome preferences file that disables password manager popups
   * This is required because command-line flags alone don't reliably disable
   * the "Change your password" leak detection popup
   */
  private createChromePreferences(userDataDir: string, overwrite: boolean = true): void {
    const defaultDir = path.join(userDataDir, 'Default');
    const prefsPath = path.join(defaultDir, 'Preferences');

    // Create Default directory if it doesn't exist
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }

    // Persistent/named profiles (issue 13) only get the seed once. Rewriting
    // Preferences on every launch would throw away everything the profile has
    // accumulated - which is the entire point of a persistent profile.
    if (!overwrite && fs.existsSync(prefsPath)) {
      debugLog('ChromeLauncher', `Keeping existing Chrome preferences at ${prefsPath}`);
      return;
    }

    // Chrome preferences to disable password-related popups
    const preferences = {
      credentials_enable_service: false,
      profile: {
        password_manager_enabled: false,
        password_manager_leak_detection: false,
      },
      safebrowsing: {
        enabled: false,
        enhanced: false,
      },
      autofill: {
        profile_enabled: false,
        credit_card_enabled: false,
      },
    };

    fs.writeFileSync(prefsPath, JSON.stringify(preferences, null, 2));
    debugLog('ChromeLauncher', `Created Chrome preferences at ${prefsPath} with password manager disabled`);
  }

  /**
   * Check if a port is already in use using TCP connection
   */
  private async isPortInUse(port: number): Promise<boolean> {
    await debugLog('ChromeLauncher', `isPortInUse() checking port ${port}`);

    return new Promise((resolve) => {
      try {
        const socket = new net.Socket();

        socket.setTimeout(500);

        socket.on('connect', () => {
          socket.destroy();
          debugLog('ChromeLauncher', `isPortInUse() port ${port} is in use`).catch(() => {});
          resolve(true);
        });

        socket.on('timeout', () => {
          socket.destroy();
          debugLog('ChromeLauncher', `isPortInUse() timeout checking port ${port}, assuming free`).catch(() => {});
          resolve(false);
        });

        socket.on('error', (err: any) => {
          socket.destroy();
          if (err.code === 'ECONNREFUSED') {
            // Port is not in use
            debugLog('ChromeLauncher', `isPortInUse() port ${port} is free (ECONNREFUSED)`).catch(() => {});
            resolve(false);
          } else {
            // Other error, assume port is in use to be safe
            debugLog('ChromeLauncher', `isPortInUse() error checking port ${port}: ${err.code}, assuming in use`).catch(() => {});
            resolve(true);
          }
        });

        try {
          socket.connect(port, 'localhost');
        } catch (connectError) {
          debugLog('ChromeLauncher', `isPortInUse() socket.connect() threw for port ${port}: ${connectError}`).catch(() => {});
          socket.destroy();
          resolve(true); // Assume in use to be safe
        }
      } catch (error) {
        debugLog('ChromeLauncher', `isPortInUse() unexpected error for port ${port}: ${error}`).catch(() => {});
        resolve(true); // Assume in use to be safe
      }
    });
  }

  /**
   * Wait for Chrome debugging port to become ready
   * Polls the /json/version endpoint until Chrome is inspectable
   *
   * Every probe that does not succeed is appended to `probeFailures`, which the
   * caller reports; debugLog alone loses them for anyone without debug logging on.
   */
  private async waitForChromeReady(
    port: number,
    maxAttempts: number = 15,
    probeFailures: string[] = [],
    hasExited: () => boolean = () => false
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      // A dead process never binds the port, so the remaining probes and their
      // backoff add delay and no reading.
      if (hasExited()) {
        throw new Error(`Chrome exited during startup, after ${i} probes.`);
      }

      let failure: string;
      try {
        // Use a race between fetch and timeout
        const fetchPromise = fetch(`http://localhost:${port}/json/version`);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 1000)
        );

        const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;

        if (response.ok) {
          // Validate it's actually Chrome responding, not the port reserver
          const text = await response.text();
          if (text.trim() === 'chrome-not-running') {
            await debugLog('ChromeLauncher', `Port ${port} is reserved by PortReserver, Chrome failed to bind`);
            throw new Error(`Port ${port} is reserved by another MCP instance. Chrome cannot bind to this port.`);
          }

          // Valid Chrome response
          await debugLog('ChromeLauncher', `Chrome ready on port ${port} after ${i + 1} attempts`);
          return;
        }

        failure = `HTTP ${response.status}`;
      } catch (error) {
        // Re-throw port reservation errors immediately
        if (error instanceof Error && error.message.includes('reserved by another MCP instance')) {
          throw error;
        }

        failure = `${error}`;

        // Chrome not ready yet, continue polling
        // Only log every 5 attempts to reduce noise
        if (i % 5 === 0) {
          await debugLog('ChromeLauncher', `Waiting for Chrome on port ${port} (attempt ${i + 1}/${maxAttempts}) - error: ${error}`);
        }
      }

      probeFailures.push(failure);

      // Exponential backoff: 500ms + (attempt * 200ms)
      await new Promise(resolve => setTimeout(resolve, 500 + i * 200));
    }

    throw new Error(`Chrome debugging port ${port} did not become inspectable in ${maxAttempts} probes.`);
  }

  /**
   * Launch Chrome with debugging enabled
   * Uses atomic release-and-launch to prevent race conditions
   * Waits for Chrome to actually bind to the port before resolving
   */
  async launch(port: number = 9222, url?: string, portReserver?: PortReserver, headless: boolean = false, extraArgs: string[] = [], profileName?: string): Promise<{ port: number; pid: number }> {
    if (profileName === undefined) {
      return this.launchOnPort(port, url, portReserver, headless, extraArgs, profileName);
    }

    // Named profiles are serialised by NAME as well as by port (bug-006 follow-up).
    // The per-port lock does not help here: two launches for the same profile on
    // different ports both pass the "is this profile held?" guard while the first
    // Chrome is still spawning (findPortForProfile requires isRunning(), which is
    // false during that window). Chrome then hands the second process off to the
    // first singleton and it exits, surfacing as a generic spawn failure.
    const name = normalizeProfileName(profileName);
    for (let i = 0; i < 50; i++) {
      const inFlight = this.profileLaunchLocks.get(name);
      if (!inFlight) break;
      await debugLog('ChromeLauncher', `Another launch is in progress for profile "${name}", waiting...`);
      // Its failure is its caller's problem, not ours - we just need it settled.
      const result = await inFlight.then(r => r, () => undefined);
      if (result && result.port === port && this.isRunning(port)) {
        // Same port, same profile: this is the per-port hand-off case, so give
        // both callers the one launch instead of "already running on port X".
        return result;
      }
    }

    const launchPromise = this.launchOnPort(port, url, portReserver, headless, extraArgs, name);
    this.profileLaunchLocks.set(name, launchPromise);
    try {
      return await launchPromise;
    } finally {
      if (this.profileLaunchLocks.get(name) === launchPromise) {
        this.profileLaunchLocks.delete(name);
      }
    }
  }

  /**
   * Port-scoped half of launch(): the per-port lock, the "already running" and
   * profile-ownership guards, and the spawn itself.
   */
  private async launchOnPort(port: number, url?: string, portReserver?: PortReserver, headless: boolean = false, extraArgs: string[] = [], profileName?: string): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `launch() called with port ${port}, portReserver=${!!portReserver}, isReserved=${portReserver?.isReserved()}`);

    // CRITICAL: Check if another launch is in progress for this port
    // This prevents race conditions where two launch() calls happen simultaneously
    const existingLaunch = this.launchLocks.get(port);
    if (existingLaunch) {
      await debugLog('ChromeLauncher', `Another launch is in progress for port ${port}, waiting for it to complete...`);
      return existingLaunch; // Return the same promise, so both callers wait for the same launch
    }

    // Use isRunning() to verify the process is actually alive (handles external kills)
    if (this.isRunning(port)) {
      throw new Error(`Chrome is already running on port ${port}. Use killChrome() to stop it first, or specify a different port.`);
    }

    // Create a promise for this launch and store it in the lock map
    // This prevents concurrent launches on the same port
    // A named profile can only be held by one live Chrome - a second launch on
    // the same user-data-dir is handed off to the first process and ours exits.
    if (profileName !== undefined) {
      const name = normalizeProfileName(profileName);
      const holder = this.findPortForProfile(name);
      if (holder !== undefined) {
        throw new ProfileInUseError(name, holder);
      }
      // ...and the same profile may be held by a Chrome belonging to ANOTHER
      // devharness session (the persistent profile root is global by default),
      // which our own maps know nothing about. Without this the launch "works",
      // Chrome hands off to the existing singleton, and the caller gets an
      // unexplained spawn failure. POSIX-only - see ProfileLockedError.
      const lockPid = await this.findProfileLockHolder(name);
      if (lockPid !== undefined) {
        throw new ProfileLockedError(name, lockPid, this.getPersistentProfilePath(name));
      }
    }

    const launchPromise = this.performLaunch(port, url, portReserver, headless, extraArgs, profileName);
    this.launchLocks.set(port, launchPromise);

    try {
      const result = await launchPromise;
      return result;
    } finally {
      // Always clean up the lock when done (success or failure)
      this.launchLocks.delete(port);
    }
  }

  /**
   * Internal method that performs the actual Chrome launch
   * Separated from launch() to allow mutex/locking logic
   */
  private async performLaunch(port: number, url?: string, portReserver?: PortReserver, headless: boolean = false, extraArgs: string[] = [], profileName?: string): Promise<{ port: number; pid: number }> {
    await debugLog('ChromeLauncher', `performLaunch() starting for port ${port}`);

    // Check if port is in use by something OTHER than our port reserver
    // This prevents multiple Chrome instances from being launched on the same port
    let isPortInUse: boolean;
    try {
      isPortInUse = await this.isPortInUse(port);
      await debugLog('ChromeLauncher', `performLaunch() isPortInUse check completed: ${isPortInUse}`);
    } catch (portCheckError) {
      await debugLog('ChromeLauncher', `performLaunch() isPortInUse check failed: ${portCheckError}`);
      throw new Error(`Failed to check port availability: ${portCheckError}`);
    }
    const isOurReservation = portReserver && portReserver.isReserved() && portReserver.getPort() === port;

    if (isPortInUse && !isOurReservation) {
      // Port is in use by something else (not our reservation)
      throw new Error(`Port ${port} is already in use by another process or MCP instance. Please choose a different port.`);
    }

    if (!isPortInUse && !isOurReservation) {
      // Port is free but not reserved by us - this is fine, we can use it
      await debugLog('ChromeLauncher', `Port ${port} is free and not reserved, proceeding with launch`);
    }

    const chromePath = this.getChromePath();
    // Checked before any profile is created, so an absent binary costs one
    // stat rather than the full probe budget in waitForChromeReady().
    if (!fs.existsSync(chromePath)) {
      throw new ChromeBinaryAbsentError(chromePath, os.platform());
    }
    // Unique by construction: the port can only be held by one live Chrome at a
    // time, and the random suffix covers same-millisecond relaunches on the same
    // port. Using Date.now() alone let two concurrent launches on *different*
    // ports share a profile (launchLocks only serialises per-port) - bug-006.
    const profile = this.createProfileRecord(port, profileName);
    // Retained for the duration of the launch, cleared once Chrome is
    // inspectable. The exit handler registered at spawn fires the instant Chrome
    // dies mid-probe, and would otherwise delete the startup logs that explain it.
    profile.retained = true;
    const userDataDir = profile.dir;
    this.profileDirs.set(port, profile);
    await debugLog('ChromeLauncher', `Using ${profile.ephemeral ? 'ephemeral' : 'persistent'} profile ${userDataDir} for port ${port}`);

    if (!profile.ephemeral) {
      // First use of a named profile: the directory does not exist yet.
      await fs.promises.mkdir(userDataDir, { recursive: true });
    }

    // Create Chrome preferences file to disable password manager popups
    // This is more reliable than command-line flags alone
    this.createChromePreferences(userDataDir, profile.ephemeral);

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Disable password manager and related popups that can block automation
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-save-password-bubble',
      '--disable-features=PasswordLeakDetection,PasswordCheck,PasswordImport,PasswordManagerOnboarding',
    ];

    // A window Chrome opens itself at startup is activated, and on macOS that
    // moves keyboard focus off the app the user is typing in. Started with no
    // window, Chrome stays in the background; the first window is opened after
    // startup by openBackgroundWindow(), which does not activate it.
    if (headless) {
      args.push('--headless=new');
    } else {
      args.push('--no-startup-window');
    }

    // Pass-through: any extra Chrome flags from the launchChrome call (extraArgs)
    // and/or the CDP_TOOLS_EXTRA_CHROME_ARGS env var (space-separated). Merged
    // after the managed defaults and before the URL (Chrome treats the trailing
    // positional arg as the page to open). Lets callers enable things like a fake
    // camera (--use-fake-device-for-media-stream) without patching this file.
    const envExtra = (process.env.CDP_TOOLS_EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
    const passthrough = [...extraArgs, ...envExtra];
    if (passthrough.length) {
      await debugLog('ChromeLauncher', `Passing through extra Chrome args: ${passthrough.join(' ')}`);
      args.push(...passthrough);
    }

    if (url && headless) {
      args.push(url);
    }

    // Track whether we released the reservation (so we can re-reserve on failure)
    let didReleaseReservation = false;

    try {
      // ATOMIC OPERATION: Release port reservation immediately before spawning Chrome
      // This minimizes the race condition window to just a few milliseconds
      if (isOurReservation) {
        await debugLog('ChromeLauncher', `Releasing port reservation for ${port} immediately before spawn`);
        await portReserver.release();
        didReleaseReservation = true;
        await debugLog('ChromeLauncher', `Port ${port} released, spawning Chrome immediately...`);
      }

      await debugLog('ChromeLauncher', `Spawning Chrome process on port ${port}...`);
      const spawnedAt = Date.now();
      // stderr is piped rather than ignored: it carries Chrome's own account of
      // a startup that produced no window, which no other channel reports.
      const chromeProcess = spawn(chromePath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderrTail = '';
      chromeProcess.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });

      const pid = chromeProcess.pid;
      await debugLog('ChromeLauncher', `Chrome process spawned with PID ${pid}`);

      // CRITICAL FIX: Add to tracking map IMMEDIATELY after spawn to prevent orphans
      // This ensures the process is tracked even if waitForChromeReady fails
      this.chromeProcesses.set(port, chromeProcess);
      await debugLog('ChromeLauncher', `Added Chrome process (PID: ${pid}) to tracking map for port ${port}`);

      // Set up auto-cleanup when process exits (BEFORE waitForChromeReady)
      // This ensures cleanup happens even if the launch fails later
      chromeProcess.once('exit', (code, signal) => {
        debugLog('ChromeLauncher', `Chrome process on port ${port} (PID: ${pid}) exited (code: ${code}, signal: ${signal}), removing from tracking`);
        this.chromeProcesses.delete(port);

        // Record the close event with reason
        const pendingReason = this.pendingCloseReason.get(port);
        this.pendingCloseReason.delete(port);

        let reason: ChromeCloseReason;
        if (pendingReason) {
          reason = pendingReason;
        } else if (signal) {
          reason = 'signal';
        } else if (code !== 0 && code !== null) {
          reason = 'crash';
        } else {
          reason = 'external'; // Closed externally (user closed browser, etc.)
        }

        const closeEvent = this.recordCloseEvent(port, pid || -1, reason, code, signal);

        // Remove the throwaway profile now that its Chrome is gone. Covers
        // external closes and crashes as well as killInstance() - bug-007.
        this.removeProfileDir(port, profile).catch(() => {});

        // Invoke the exit callback if set (for port re-reservation)
        if (this.onExitCallback) {
          debugLog('ChromeLauncher', `Invoking onExit callback for port ${port}`);
          // Don't await - fire and forget to avoid blocking exit handler
          Promise.resolve(this.onExitCallback(closeEvent)).catch((err) => {
            debugLog('ChromeLauncher', `onExit callback error: ${err}`);
          });
        }
      });

      // Handle process errors and unexpected exits
      let processExited = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let spawnFailure: string | null = null;
      const exitHandler = (first: number | Error | null, signal?: NodeJS.Signals | null) => {
        processExited = true;
        // 'exit' passes (code, signal); 'error' passes an Error.
        if (first instanceof Error) {
          spawnFailure = first.message;
        } else if (typeof first === 'number') {
          exitCode = first;
        }
        if (signal) {
          exitSignal = signal;
        }
      };

      chromeProcess.once('exit', exitHandler);
      chromeProcess.once('error', exitHandler);

      // Wait for Chrome to actually start and bind to the port
      await debugLog('ChromeLauncher', `Waiting for Chrome to become ready on port ${port}...`);
      const probeFailures: string[] = [];
      const takeObservations = (code: number | null, signal: string | null): LaunchObservations => ({
        chromePath,
        platform: os.platform(),
        binaryPresent: true,
        port,
        pid: pid ?? null,
        // Read rather than assumed: a path is reported only while it exists.
        profileDir: fs.existsSync(userDataDir) ? userDataDir : null,
        probeAttempts: probeFailures.length,
        probeFailures,
        stderrTail,
        spawnFailure,
        exitCode: code,
        exitSignal: signal,
        elapsedMs: Date.now() - spawnedAt,
      });
      try {
        await this.waitForChromeReady(port, 15, probeFailures, () => processExited);
      } catch (waitError) {
        await debugLog('ChromeLauncher', `waitForChromeReady failed: ${waitError}`);

        // Re-reserve the port if we released it (cleanup after failure)
        if (didReleaseReservation && portReserver) {
          try {
            await debugLog('ChromeLauncher', `Re-reserving port ${port} after Chrome launch failure`);
            await portReserver.reserve(port);
            await debugLog('ChromeLauncher', `Successfully re-reserved port ${port}`);
          } catch (reserveError) {
            await debugLog('ChromeLauncher', `Failed to re-reserve port ${port}: ${reserveError}`);
          }
        }

        // Read before the SIGKILL below, whose own exit event would otherwise
        // overwrite the signal Chrome stopped on with ours.
        const observedExitCode = exitCode;
        const observedExitSignal = exitSignal;

        // Clean up if Chrome failed to start - use SIGKILL for immediate termination
        if (chromeProcess && !chromeProcess.killed && pid) {
          await debugLog('ChromeLauncher', `Force killing orphaned Chrome process (PID: ${pid})`);
          try {
            chromeProcess.kill('SIGKILL');
            // Wait a moment to ensure kill completes
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (killError) {
            await debugLog('ChromeLauncher', `Failed to kill orphaned process: ${killError}`);
          }
        }
        // Remove from tracking map since we're about to throw
        // (exit handler will also remove it when process dies, but this is defensive)
        this.chromeProcesses.delete(port);
        await this.removeProfileDir(port, profile);
        // A reservation conflict names another MCP instance holding the port. It
        // is not a reading taken from this launch, and CHROME_SPAWN_FAILED
        // carries its text; wrapping it here would drop that text.
        if (waitError instanceof Error && waitError.message.includes('reserved by another MCP instance')) {
          throw waitError;
        }
        throw new ChromeLaunchFailure(`${waitError}`, takeObservations(observedExitCode, observedExitSignal));
      }

      // Check if process exited during startup
      if (processExited) {
        // Remove from tracking since process is dead
        this.chromeProcesses.delete(port);
        await this.removeProfileDir(port, profile);
        throw new ChromeLaunchFailure(
          spawnFailure ?? 'Chrome exited during startup.',
          takeObservations(exitCode, exitSignal)
        );
      }

      // Remove temporary exit handler now that Chrome is confirmed running
      // (The permanent exit handler was already set up earlier)
      chromeProcess.removeListener('exit', exitHandler);
      chromeProcess.removeListener('error', exitHandler);

      if (!headless) {
        await openBackgroundWindow(port, url ?? 'about:blank');
      }

      // Inspectable, so the startup logs have served their purpose and this
      // profile returns to ordinary cleanup on exit.
      profile.retained = false;

      await debugLog('ChromeLauncher', `Chrome successfully started on port ${port} with PID ${pid}`);
      return { port, pid: pid || -1 };
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to launch Chrome: ${error}`);

      // Re-reserve the port if we released it (cleanup after any failure)
      if (didReleaseReservation && portReserver) {
        try {
          await debugLog('ChromeLauncher', `Re-reserving port ${port} after outer catch block failure`);
          await portReserver.reserve(port);
          await debugLog('ChromeLauncher', `Successfully re-reserved port ${port}`);
        } catch (reserveError) {
          await debugLog('ChromeLauncher', `Failed to re-reserve port ${port}: ${reserveError}`);
        }
      }

      // A typed failure carries the readings taken during the launch; wrapping
      // it in a new Error would discard both the type and the readings.
      if (error instanceof ChromeLaunchFailure) {
        throw error;
      }

      throw new Error(`Failed to launch Chrome: ${error}`);
    }
  }

  /**
   * Check if a process with the given PID is actually running
   * This handles the case where Chrome is killed externally (e.g., Activity Monitor, kill command)
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // process.kill with signal 0 doesn't kill the process, just checks if it exists
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH = No such process, EPERM = exists but no permission (still alive)
      return false;
    }
  }

  /**
   * Check if Chrome is running on a specific port, or if any Chrome instance is running
   * This verifies the process is actually alive, not just tracked
   */
  isRunning(port?: number): boolean {
    if (port !== undefined) {
      const chromeProcess = this.chromeProcesses.get(port);
      if (!chromeProcess || chromeProcess.killed) {
        return false;
      }
      // Verify the process is actually alive (handles external kills)
      const pid = chromeProcess.pid;
      if (!pid || !this.isProcessAlive(pid)) {
        // Process is dead but we didn't know - clean up tracking
        this.chromeProcesses.delete(port);
        this.recordCloseEvent(port, pid || -1, 'external', null, null);
        return false;
      }
      return true;
    }
    // Check if any Chrome instance is running - verify each one
    for (const [p, chromeProcess] of this.chromeProcesses.entries()) {
      const pid = chromeProcess.pid;
      if (pid && this.isProcessAlive(pid)) {
        return true;
      } else {
        // Clean up dead process
        this.chromeProcesses.delete(p);
        this.recordCloseEvent(p, pid || -1, 'external', null, null);
      }
    }
    return false;
  }

  /**
   * Get all running Chrome ports
   */
  getRunningPorts(): number[] {
    return Array.from(this.chromeProcesses.keys());
  }

  /**
   * Kill Chrome process(es)
   * If port is specified, kills only that instance. Otherwise kills all instances.
   * First attempts graceful shutdown with SIGTERM, then force kills with SIGKILL if needed
   */
  async kill(port?: number): Promise<void> {
    if (port !== undefined) {
      // Kill specific instance
      await this.killInstance(port);
    } else {
      // Kill all instances
      const ports = Array.from(this.chromeProcesses.keys());
      await debugLog('ChromeLauncher', `Killing all Chrome instances (${ports.length} total)`);
      for (const p of ports) {
        await this.killInstance(p);
      }
    }
  }

  /**
   * Kill a specific Chrome instance by port
   */
  private async killInstance(port: number): Promise<void> {
    // Snapshot the profile we are killing *now*: a relaunch on this port can
    // land between profileDirs.set() and chromeProcesses.set() in
    // performLaunch(), and deleting whatever profile happens to be tracked by
    // the time we get around to it would wipe the new launch's fresh dir.
    // Passing the snapshot as `expected` makes every deletion below a no-op
    // once someone else owns the port.
    const profile = this.profileDirs.get(port);
    const chromeProcess = this.chromeProcesses.get(port);
    if (!chromeProcess || chromeProcess.killed) {
      // Nothing to kill, but a profile may still be tracked (e.g. the process
      // was reaped externally) - make sure it does not leak.
      if (profile) await this.removeProfileDir(port, profile);
      return;
    }

    const pid = chromeProcess.pid;
    if (!pid) {
      this.chromeProcesses.delete(port);
      if (profile) await this.removeProfileDir(port, profile);
      return;
    }

    await debugLog('ChromeLauncher', `Killing Chrome process on port ${port} (PID: ${pid})`);

    // Try graceful shutdown first (SIGTERM)
    try {
      chromeProcess.kill('SIGTERM');
      await debugLog('ChromeLauncher', `Sent SIGTERM to Chrome on port ${port} (PID: ${pid})`);
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to send SIGTERM: ${error}`);
    }

    // Wait 500ms for graceful shutdown, then force kill if needed
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          // Check if process still exists using signal 0 (doesn't actually kill)
          process.kill(pid, 0);
          // Process still exists, force kill
          debugLog('ChromeLauncher', `Chrome on port ${port} didn't exit gracefully, sending SIGKILL (PID: ${pid})`);
          try {
            chromeProcess.kill('SIGKILL');
            debugLog('ChromeLauncher', `Sent SIGKILL to Chrome on port ${port} (PID: ${pid})`);
          } catch (killError) {
            debugLog('ChromeLauncher', `Failed to send SIGKILL: ${killError}`);
          }
        } catch {
          // Process already dead (signal 0 threw error)
          debugLog('ChromeLauncher', `Chrome on port ${port} exited gracefully (PID: ${pid})`);
        }
        resolve();
      }, 500);

      // If process exits before timeout, clear the timeout
      chromeProcess.once('exit', () => {
        clearTimeout(timeout);
        debugLog('ChromeLauncher', `Chrome process on port ${port} exited (PID: ${pid})`);
        resolve();
      });
    });

    this.chromeProcesses.delete(port);

    // Chrome is gone (or was force-killed) - drop its throwaway profile,
    // unless a relaunch has already claimed this port (see snapshot above).
    if (profile) await this.removeProfileDir(port, profile);

    await debugLog('ChromeLauncher', `Chrome cleanup complete for port ${port}`);
  }

  /**
   * Build the profile record for a launch on `port`.
   *
   * The name embeds the port (only one live Chrome can hold a debug port, so
   * this alone separates concurrent launches) plus a timestamp and 4 random
   * bytes (so sequential relaunches on the same port within one millisecond
   * still differ). Naming on Date.now() alone let same-millisecond launches on
   * different ports share a profile - bug-006.
   *
   * With `profileName` (issue 13) the record is a stable directory under the
   * persistent profile root and is marked `ephemeral: false`, which every
   * cleanup path skips. The port is deliberately NOT part of a named profile's
   * directory: the profile is the identity, the port is just where this run of
   * it happens to listen.
   */
  private createProfileRecord(port: number, profileName?: string): ChromeProfileRecord {
    if (profileName !== undefined) {
      return { dir: this.getPersistentProfilePath(profileName), ephemeral: false };
    }
    const name = `${EPHEMERAL_PROFILE_PREFIX}p${port}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    return { dir: path.join(this.profileRoot, name), ephemeral: true };
  }

  /**
   * Directory named persistent profiles live under (see
   * `chrome.persistentProfileRoot`; defaults to `~/.devharness/profiles`).
   */
  getPersistentProfileRoot(): string {
    return typeof this.persistentProfileRootOption === 'function'
      ? this.persistentProfileRootOption()
      : this.persistentProfileRootOption;
  }

  /**
   * Absolute path of a named persistent profile. Does not create it.
   * @throws InvalidProfileNameError
   */
  getPersistentProfilePath(profileName: string): string {
    return path.join(this.getPersistentProfileRoot(), normalizeProfileName(profileName));
  }

  /**
   * Port of the live Chrome currently holding a named profile, if any.
   * @throws InvalidProfileNameError
   */
  findPortForProfile(profileName: string): number | undefined {
    const dir = this.getPersistentProfilePath(profileName);
    for (const [port, record] of this.profileDirs.entries()) {
      if (record.dir === dir && this.isRunning(port)) {
        return port;
      }
    }
    return undefined;
  }

  /**
   * PID of a live Chrome holding a named persistent profile, if the profile's
   * SingletonLock says so. Unlike findPortForProfile() this sees Chromes we did
   * NOT launch (other devharness sessions sharing the global profile root, or a
   * Chrome started by hand on the same user-data-dir).
   *
   * LIMITATION: POSIX-only. It reads the SingletonLock symlink target, which
   * Windows Chrome does not create - there it always reports "not locked", so
   * callers must treat a negative result as "no evidence of a holder" rather
   * than proof the profile is free.
   *
   * @throws InvalidProfileNameError
   */
  async findProfileLockHolder(profileName: string): Promise<number | undefined> {
    const dir = this.getPersistentProfilePath(profileName);
    return this.readProfileLockPid(dir);
  }

  /**
   * Names of persistent profiles that exist on disk.
   */
  async listPersistentProfiles(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.getPersistentProfileRoot(), { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch {
      return [];
    }
  }

  /**
   * Wipe a named persistent profile and recreate it empty, so the next launch
   * starts from a clean browser (no cookies, no IndexedDB, no enrolment).
   *
   * Refuses while a Chrome we launched still holds the profile: deleting a
   * live user-data-dir corrupts the running browser and the deletion would be
   * partly undone as Chrome flushes state back out on exit. Kill that instance
   * (`killChrome({ port })`) first.
   *
   * Also refuses when the profile's Chrome SingletonLock names a live PID we
   * did not launch. The default profile root is global (`~/.devharness/profiles`),
   * so another devharness session may be running this exact profile; without the
   * lock check this call would rm -rf a live browser's user-data-dir and destroy
   * the very identity persistent profiles exist to preserve. That check is
   * POSIX-only (see ProfileLockedError) - on Windows this remains unguarded.
   *
   * @throws InvalidProfileNameError | ProfileInUseError | ProfileLockedError
   */
  async resetPersistentProfile(profileName: string): Promise<{ profile: string; path: string; existed: boolean }> {
    const name = normalizeProfileName(profileName);
    const holder = this.findPortForProfile(name);
    if (holder !== undefined) {
      throw new ProfileInUseError(name, holder);
    }
    const lockPid = await this.findProfileLockHolder(name);
    if (lockPid !== undefined) {
      throw new ProfileLockedError(name, lockPid, this.getPersistentProfilePath(name));
    }

    const dir = this.getPersistentProfilePath(name);
    const existed = fs.existsSync(dir);

    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
    await debugLog('ChromeLauncher', `Reset persistent profile "${name}" at ${dir} (existed: ${existed})`);

    return { profile: name, path: dir, existed };
  }

  /**
   * Profile directory currently tracked for a port (if any).
   */
  getProfileDir(port: number): string | undefined {
    return this.profileDirs.get(port)?.dir;
  }

  /**
   * All tracked profiles, keyed by port. Persistent profiles are included but
   * are never deleted by the launcher.
   */
  getProfiles(): Map<number, ChromeProfileRecord> {
    return new Map(this.profileDirs);
  }

  /**
   * Stop tracking a port's profile and, if it is ephemeral, delete it from disk.
   *
   * `expected` guards against a late exit event from a previous Chrome deleting
   * the freshly created profile of a relaunch on the same port: if the tracked
   * record is no longer the one we started with, nothing is touched.
   */
  private async removeProfileDir(port: number, expected?: ChromeProfileRecord): Promise<void> {
    const record = this.profileDirs.get(port);
    if (!record) {
      return;
    }
    if (expected && record !== expected) {
      // A newer launch owns this port now - leave its profile alone.
      return;
    }

    if (record.retained) {
      // A failed launch kept this directory for its Chrome startup logs. The
      // startup sweep removes it once no live Chrome holds it.
      this.profileDirs.delete(port);
      await debugLog('ChromeLauncher', `Retaining profile ${record.dir} for port ${port} after a failed launch`);
      return;
    }

    this.profileDirs.delete(port);

    if (!record.ephemeral) {
      // Persistent/named profile (issue 13) - tracking only, never delete.
      await debugLog('ChromeLauncher', `Keeping persistent profile ${record.dir} for port ${port}`);
      return;
    }

    try {
      await fs.promises.rm(record.dir, { recursive: true, force: true });
      await debugLog('ChromeLauncher', `Removed ephemeral profile ${record.dir} for port ${port}`);
    } catch (error) {
      await debugLog('ChromeLauncher', `Failed to remove profile ${record.dir}: ${error}`);
    }
  }

  /**
   * Delete ephemeral profile directories left behind by previous sessions
   * (crashes, SIGKILL, machine restart). Returns the directories removed.
   *
   * Conservative on purpose - a directory is skipped when:
   *  - it is younger than staleProfileMaxAgeMs (another MCP instance may be
   *    launching Chrome into it right now), or
   *  - its Chrome SingletonLock names a PID that is still alive, or
   *  - it is currently tracked by this launcher.
   */
  async sweepStaleProfiles(): Promise<string[]> {
    const removed: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.profileRoot, { withFileTypes: true });
    } catch (error) {
      await debugLog('ChromeLauncher', `Profile sweep could not read ${this.profileRoot}: ${error}`);
      return removed;
    }

    const inUse = new Set(Array.from(this.profileDirs.values()).map(r => r.dir));
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(EPHEMERAL_PROFILE_PREFIX)) {
        continue;
      }

      const dir = path.join(this.profileRoot, entry.name);
      if (inUse.has(dir)) {
        continue;
      }

      try {
        const stats = await fs.promises.stat(dir);
        if (now - stats.mtimeMs < this.staleProfileMaxAgeMs) {
          continue; // Too fresh - may belong to a launch in progress elsewhere
        }
      } catch {
        continue; // Vanished or unreadable - leave it alone
      }

      if (await this.isProfileLocked(dir)) {
        await debugLog('ChromeLauncher', `Profile sweep skipping ${dir} - still locked by a live Chrome`);
        continue;
      }

      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (error) {
        await debugLog('ChromeLauncher', `Profile sweep failed to remove ${dir}: ${error}`);
      }
    }

    if (removed.length) {
      await debugLog('ChromeLauncher', `Profile sweep removed ${removed.length} stale profile(s)`);
    }
    return removed;
  }

  /**
   * Is a profile directory still held by a running Chrome?
   * Chrome writes a SingletonLock symlink whose target is "<hostname>-<pid>".
   * Unreadable/absent lock means "not locked" (Windows uses a plain lockfile).
   */
  private async isProfileLocked(dir: string): Promise<boolean> {
    return (await this.readProfileLockPid(dir)) !== undefined;
  }

  /**
   * PID named by a profile directory's Chrome SingletonLock, if that process is
   * still alive. POSIX-only: on Windows the lock is a plain file with no
   * readable PID, so this always returns undefined ("no evidence of a holder").
   */
  private async readProfileLockPid(dir: string): Promise<number | undefined> {
    try {
      const target = await fs.promises.readlink(path.join(dir, 'SingletonLock'));
      const pid = Number(target.split('-').pop());
      return Number.isInteger(pid) && pid > 0 && this.isProcessAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reset the launcher state (useful if Chrome was closed externally)
   */
  reset(port?: number): void {
    // Note: profile dirs are only untracked here, never deleted - reset() is a
    // "forget my state" escape hatch and the Chrome holding the profile may
    // still be alive. Anything orphaned this way is picked up by the startup
    // sweep on the next run.
    if (port !== undefined) {
      this.chromeProcesses.delete(port);
      this.profileDirs.delete(port);
    } else {
      this.chromeProcesses.clear();
      this.profileDirs.clear();
    }
  }

  /**
   * Record a Chrome close event
   */
  private recordCloseEvent(port: number, pid: number, reason: ChromeCloseReason, exitCode?: number | null, signal?: string | null): ChromeCloseEvent {
    const event: ChromeCloseEvent = {
      port,
      pid,
      reason,
      timestamp: new Date(),
      exitCode,
      signal,
    };

    this.lastCloseEvents.push(event);

    // Keep only the last N events
    if (this.lastCloseEvents.length > this.maxCloseEvents) {
      this.lastCloseEvents.shift();
    }

    debugLog('ChromeLauncher', `Recorded close event: port=${port}, pid=${pid}, reason=${reason}, exitCode=${exitCode}, signal=${signal}`);
    return event;
  }

  /**
   * Get the last close events
   */
  getLastCloseEvents(): ChromeCloseEvent[] {
    return [...this.lastCloseEvents];
  }

  /**
   * Get Chrome launcher status for all instances
   * Verifies each process is actually alive and cleans up dead ones
   */
  getStatus(): { instances: Array<{ port: number; pid: number; running: boolean }>; lastCloseEvents: ChromeCloseEvent[] } {
    const instances: Array<{ port: number; pid: number; running: boolean }> = [];
    const deadPorts: number[] = [];

    for (const [port, chromeProcess] of this.chromeProcesses.entries()) {
      const pid = chromeProcess.pid || -1;
      const alive = pid > 0 && this.isProcessAlive(pid);

      if (!alive) {
        deadPorts.push(port);
      }

      instances.push({ port, pid, running: alive });
    }

    // Clean up dead processes
    for (const port of deadPorts) {
      const chromeProcess = this.chromeProcesses.get(port);
      const pid = chromeProcess?.pid || -1;
      this.chromeProcesses.delete(port);
      this.recordCloseEvent(port, pid, 'external', null, null);
    }

    // Return only alive instances
    return {
      instances: instances.filter(i => i.running),
      lastCloseEvents: this.lastCloseEvents
    };
  }

  /**
   * Set the pending close reason for a port (call before killing)
   */
  setPendingCloseReason(port: number, reason: ChromeCloseReason): void {
    this.pendingCloseReason.set(port, reason);
  }
}

/**
 * Opens a page in a new window with Target.createTarget `background: true`,
 * which shows the window without activating Chrome. Every later tool attaches
 * to a page target, so a launch that leaves none returns no connection.
 */
async function openBackgroundWindow(port: number, url: string): Promise<void> {
  const version = (await (await fetch(`http://localhost:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data) => {
        const reply = JSON.parse(data.toString()) as { id?: number; error?: { message: string } };
        if (reply.id !== 1) return;
        if (reply.error) reject(new Error(`Target.createTarget: ${reply.error.message}`));
        else resolve();
      });
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true, background: true } }));
    });
  } finally {
    ws.close();
  }
}
