import { AsyncLocalStorage } from 'async_hooks';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { dirname, join } from 'path';
import { debugLog } from '../debug-logger.js';
import { getGlobalBase } from '../helpers/paths.js';
import { isProcessAlive } from '../helpers/process-liveness.js';

/**
 * A wait still holding after this long is one the person ends by switching
 * desktops: the wait script returns within one check when the Terminal's
 * desktop is already showing.
 */
export const HELD_AFTER_MS = 1000;

/** The MCP call a desktop wait runs under, which returns early once the wait holds. */
const heldCall = new AsyncLocalStorage<(tty: string) => void>();

export type HeldOrDone<T> = { done: true; value: T } | { done: false; tty: string; rest: Promise<T> };

/**
 * Runs `call`, and settles early when a desktop wait inside it holds past
 * HELD_AFTER_MS. The caller is blocked for the whole wait otherwise, with no
 * channel to the session until the client backgrounds it at 120s; settled
 * early, the reply carries the hold and `rest` carries the call to its end.
 */
export function releaseWhenHeld<T>(call: () => Promise<T>): Promise<HeldOrDone<T>> {
  return new Promise((resolve, reject) => {
    const rest = heldCall.run(tty => resolve({ done: false, tty, rest }), call);
    rest.then(value => resolve({ done: true, value }), reject);
  });
}

/**
 * macOS places a new window on the desktop (Space) showing when the window is
 * created, and offers no public call that moves it afterwards. A Chrome window
 * opened while the person is on another desktop lands there, away from the
 * Terminal window that launched it. Holding the window back until the
 * Terminal's desktop is showing places it beside that Terminal.
 *
 * The Space of a window comes from the private SkyLight calls
 * CGSCopySpacesForWindows and CGSCopyManagedDisplaySpaces, bound through JXA
 * so no native module is needed. A Terminal tab behind another in its tab
 * group is ordered out and sits on no Space; the shown tab shares its frame
 * and carries the group's Space.
 *
 * A Space showing on one display says nothing of where a new window goes:
 * macOS opens it on the display holding the pointer. The display holding the
 * Terminal window's centre is read from NSScreen, whose frames run from the
 * primary display's bottom-left corner, and turned into the top-left
 * coordinates Terminal's bounds and Chrome's window bounds share.
 *
 * With argv[1] '1', the first check that finds keyboard and mouse idle for
 * argv[2] seconds while that Space is not current switches to that Space.
 * Activating Terminal switches nothing while Terminal has a window on the
 * current Space, and ordering the Terminal window front from there moves the
 * window onto the current Space. The switch instead goes through a 1pt
 * borderless window this script owns: CGSMoveWindowsToManagedSpace places it
 * on the Terminal's Space, which the window server permits for the caller's
 * own windows, and activating this script with that window key switches to
 * the Space holding its only window. Once the Space is current, the Terminal
 * window is ordered front among windows already on it, which moves nothing,
 * so keystrokes reach that window. The idle reading is
 * CGEventSourceSecondsSinceLastEventType over every input event type; no step
 * needs an Accessibility grant. One raise per wait: a raise on every idle
 * check would pull focus to Terminal each time the person moves away.
 *
 * Prints `{"space":<id>,"display":{left,top,width,height},"window":{width,height}}`
 * once that Space is current on any display, `window` being the Terminal
 * window's size, or `none` when the tty maps to no Terminal window or to an
 * ambiguous tab group.
 */
const WAIT_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
ObjC.bindFunction('CGSMainConnectionID', ['int', []]);
ObjC.bindFunction('CGSCopySpacesForWindows', ['id', ['int', 'int', 'id']]);
ObjC.bindFunction('CGSCopyManagedDisplaySpaces', ['id', ['int']]);
ObjC.bindFunction('CGEventSourceSecondsSinceLastEventType', ['double', ['int', 'unsigned int']]);
ObjC.bindFunction('CGSMoveWindowsToManagedSpace', ['void', ['int', 'id', 'unsigned long long']]);
function run(argv) {
  const tty = argv[0];
  const raise = argv[1] === '1';
  const idleSeconds = Number(argv[2]);
  const hidSystemState = 1;
  const anyInputEvent = 0xFFFFFFFF;
  const idle = () => $.CGEventSourceSecondsSinceLastEventType(hidSystemState, anyInputEvent);
  const pump = (seconds) => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
  const switchTo = (space, frame) => {
    const app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    app.finishLaunching;
    const primaryHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
    const at = $.NSMakeRect(frame.x + frame.width / 2, primaryHeight - (frame.y + frame.height / 2), 1, 1);
    const helper = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(at, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    helper.setOpaque(false);
    helper.setBackgroundColor($.NSColor.clearColor);
    helper.setIgnoresMouseEvents(true);
    helper.setReleasedWhenClosed(false);
    helper.orderFrontRegardless;
    pump(0.05);
    $.CGSMoveWindowsToManagedSpace(cid, $.NSArray.arrayWithObject($.NSNumber.numberWithInt(helper.windowNumber)), space);
    helper.makeKeyAndOrderFront(null);
    app.activateIgnoringOtherApps(true);
    return helper;
  };
  let helper;
  const terminal = Application('Terminal');
  const cid = $.CGSMainConnectionID();
  const spacesOf = (id) => ObjC.deepUnwrap($.CGSCopySpacesForWindows(cid, 7, $([id]))) || [];
  const terminalSpace = () => {
    const ids = terminal.windows.id();
    const ttys = terminal.windows.tabs.tty();
    const frames = terminal.windows.bounds();
    const bounds = frames.map((b) => JSON.stringify(b));
    const index = ttys.findIndex((tabs) => tabs.includes(tty));
    if (index < 0) return undefined;
    const own = spacesOf(ids[index]);
    if (own.length) return { space: own[0], frame: frames[index], id: ids[index] };
    const found = new Set();
    ids.forEach((id, i) => {
      if (i !== index && bounds[i] === bounds[index]) spacesOf(id).forEach((s) => found.add(s));
    });
    return found.size === 1 ? { space: [...found][0], frame: frames[index], id: ids[index] } : undefined;
  };
  const displayOf = (frame) => {
    const screens = $.NSScreen.screens;
    const primaryHeight = screens.objectAtIndex(0).frame.size.height;
    const x = frame.x + frame.width / 2;
    const y = frame.y + frame.height / 2;
    for (let i = 0; i < screens.count; i++) {
      const f = screens.objectAtIndex(i).frame;
      const left = f.origin.x;
      const top = primaryHeight - (f.origin.y + f.size.height);
      if (x >= left && x < left + f.size.width && y >= top && y < top + f.size.height) {
        return { left, top, width: f.size.width, height: f.size.height };
      }
    }
    return undefined;
  };
  for (;;) {
    const found = terminalSpace();
    if (found === undefined) return 'none';
    const current = (ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces(cid)) || []).map((d) => d['Current Space'].ManagedSpaceID);
    if (current.includes(found.space)) {
      if (helper) {
        terminal.windows.byId(found.id).index = 1;
        terminal.activate();
        helper.orderOut(null);
      }
      return JSON.stringify({ space: found.space, display: displayOf(found.frame), window: { width: found.frame.width, height: found.frame.height } });
    }
    if (raise && !helper && idle() >= idleSeconds) helper = switchTo(found.space, found.frame);
    pump(0.5);
  }
}
`;

export interface ScreenRect { left: number; top: number; width: number; height: number }

/** Every connected display, in the top-left coordinates Chrome's window bounds use. */
const DISPLAYS_SCRIPT = `
ObjC.import('AppKit');
function run() {
  const screens = $.NSScreen.screens;
  const primaryHeight = screens.objectAtIndex(0).frame.size.height;
  const out = [];
  for (let i = 0; i < screens.count; i++) {
    const f = screens.objectAtIndex(i).frame;
    out.push({ left: f.origin.x, top: primaryHeight - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height });
  }
  return JSON.stringify(out);
}
`;

/** The connected displays, or none off macOS or when they cannot be read. */
export function readDisplays(): Promise<ScreenRect[]> {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise(resolve => {
    execFile('osascript', ['-l', 'JavaScript', '-e', DISPLAYS_SCRIPT], { timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const displays = JSON.parse(out);
        resolve(Array.isArray(displays) ? displays : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export interface TerminalDisplay {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The Terminal window's size, which the first Chrome window takes. */
  window?: { width: number; height: number };
}

const numbers = (...values: unknown[]) => values.every(n => typeof n === 'number' && Number.isFinite(n));

/** The display a wait script's reading names, with the Terminal window's size, or undefined for a reading that names none. */
export function terminalDisplay(reading: string): TerminalDisplay | undefined {
  try {
    const { display, window } = JSON.parse(reading) ?? {};
    if (!numbers(display?.left, display?.top, display?.width, display?.height)) return undefined;
    return {
      left: display.left, top: display.top, width: display.width, height: display.height,
      ...(numbers(window?.width, window?.height) ? { window: { width: window.width, height: window.height } } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The tty of the nearest ancestor of `pid`, `pid` included, read from a `ps -A -o pid=,ppid=,tty=` table. */
export function ancestorTty(table: string, pid: number): string | undefined {
  const rows = new Map<number, { ppid: number; tty: string }>();
  for (const line of table.split('\n')) {
    const [rowPid, ppid, tty] = line.trim().split(/\s+/);
    if (rowPid) rows.set(Number(rowPid), { ppid: Number(ppid), tty });
  }
  for (let at = pid; at > 1;) {
    const row = rows.get(at);
    if (!row) return undefined;
    if (row.tty && row.tty !== '??') return `/dev/${row.tty}`;
    at = row.ppid;
  }
  return undefined;
}

export interface DesktopWaitIo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pid: number;
  psTable(): Promise<string>;
  /**
   * Starts WAIT_SCRIPT for `tty`, raising the Terminal once keyboard and mouse
   * are idle for `raiseAfterIdleSeconds`, with no raise when it is undefined;
   * `result` holds its output once it exits.
   */
  startWait(tty: string, raiseAfterIdleSeconds?: number): { result: Promise<string>; kill(): void };
}

const systemIo: DesktopWaitIo = {
  platform: process.platform,
  env: process.env,
  pid: process.pid,
  psTable: () => new Promise((resolve, reject) =>
    execFile('ps', ['-A', '-o', 'pid=,ppid=,tty='], (err, out) => (err ? reject(err) : resolve(out)))),
  startWait(tty, raiseAfterIdleSeconds) {
    let child: ChildProcess | undefined;
    const result = new Promise<string>((resolve) => {
      let out = '';
      child = spawn('osascript', ['-l', 'JavaScript', '-e', WAIT_SCRIPT, tty, raiseAfterIdleSeconds === undefined ? '0' : '1', String(raiseAfterIdleSeconds ?? 0)], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.on('error', (err) => resolve(`error: ${err.message}`));
      child.on('close', () => resolve(out.trim()));
    });
    return { result, kill: () => child?.kill() };
  },
};

/**
 * Resolves once the desktop of the Terminal window this server runs under is
 * showing, with no timeout, and returns the wait script's output. Resolves at
 * once off macOS, with CDP_TOOLS_DESKTOP_WAIT=0, and whenever the Terminal
 * window or its Space cannot be read, so the window then opens where it would
 * without the wait. `stop` ends the wait early, for a Chrome that exits before
 * its window opens. `raiseAfterIdleSeconds` raises the Terminal window once
 * keyboard and mouse are idle that long, which ends the wait without the
 * person switching; undefined holds the wait for the person's switch.
 */
export async function waitForTerminalDesktop(stop: Promise<unknown>, io: DesktopWaitIo = systemIo, raiseAfterIdleSeconds?: number): Promise<string> {
  if (io.platform !== 'darwin') return 'skipped: not macOS';
  if (io.env.CDP_TOOLS_DESKTOP_WAIT === '0') return 'skipped: CDP_TOOLS_DESKTOP_WAIT=0';
  const tty = ancestorTty(await io.psTable().catch(() => ''), io.pid);
  if (!tty) {
    await debugLog('TerminalDesktop', 'No ancestor holds a tty; opening the window at once');
    return 'skipped: no tty';
  }
  const wait = io.startWait(tty, raiseAfterIdleSeconds);
  await debugLog('TerminalDesktop', `Holding a new window until the desktop of the Terminal on ${tty} is showing`);
  const release = heldCall.getStore();
  const holding = release ? setTimeout(() => release(tty), HELD_AFTER_MS) : undefined;
  const reading = await Promise.race([wait.result, stop.then(() => 'stopped')]);
  clearTimeout(holding);
  wait.kill();
  await debugLog('TerminalDesktop', `Desktop wait for ${tty} returned: ${reading}`);
  return reading;
}

/** How often a launch waiting on another server's desktop lock reads the lock again. */
const LOCK_POLL_MS = 200;

/**
 * The lock every devharness server on this machine takes from the start of a
 * desktop wait until the Chrome window it waited for exists. Two launches from
 * Terminals on different desktops otherwise switch the desktop in turn, and
 * the later switch lands in the first launch's gap between reading its
 * desktop as showing and creating its window, which puts that window on the
 * later desktop. The file holds `<pid>:<token>`: the pid frees a lock whose
 * server exited without releasing it, and the token keeps two launches in one
 * server from releasing each other's lock.
 */
export function desktopLockPath(): string {
  return join(getGlobalBase(), 'desktop-switch.lock');
}

/**
 * Takes the desktop lock, waiting while a live server holds it, and returns
 * its release. Returns a release that does nothing where no desktop wait runs:
 * off macOS, with CDP_TOOLS_DESKTOP_WAIT=0, or with no Terminal tty. A lock
 * wait past HELD_AFTER_MS settles the MCP call early, as a desktop wait does.
 */
export async function holdDesktop(io: DesktopWaitIo = systemIo, path: string = desktopLockPath()): Promise<() => void> {
  const none = () => {};
  if (io.platform !== 'darwin' || io.env.CDP_TOOLS_DESKTOP_WAIT === '0') return none;
  const tty = ancestorTty(await io.psTable().catch(() => ''), io.pid);
  if (!tty) return none;
  const token = `${io.pid}:${randomBytes(6).toString('hex')}`;
  const release = heldCall.getStore();
  const holding = release ? setTimeout(() => release(tty), HELD_AFTER_MS) : undefined;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    for (;;) {
      try {
        fs.writeFileSync(path, token, { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = Number((readLock(path) ?? '').split(':')[0]);
      if (!isProcessAlive(holder)) {
        await debugLog('TerminalDesktop', `Desktop lock held by exited pid ${holder}; removing it`);
        fs.rmSync(path, { force: true });
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
    }
  } catch (error) {
    await debugLog('TerminalDesktop', `Desktop lock at ${path} could not be taken, so this launch runs unserialised: ${error}`);
    return none;
  } finally {
    clearTimeout(holding);
  }
  return () => {
    if (readLock(path) === token) fs.rmSync(path, { force: true });
  };
}

function readLock(path: string): string | undefined {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
