import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { debugLog } from '../debug-logger.js';

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
 * Prints the Space id once that Space is current on any display, or `none`
 * when the tty maps to no Terminal window or to an ambiguous tab group.
 */
const WAIT_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGSMainConnectionID', ['int', []]);
ObjC.bindFunction('CGSCopySpacesForWindows', ['id', ['int', 'int', 'id']]);
ObjC.bindFunction('CGSCopyManagedDisplaySpaces', ['id', ['int']]);
function run(argv) {
  const tty = argv[0];
  const terminal = Application('Terminal');
  const cid = $.CGSMainConnectionID();
  const spacesOf = (id) => ObjC.deepUnwrap($.CGSCopySpacesForWindows(cid, 7, $([id]))) || [];
  const terminalSpace = () => {
    const ids = terminal.windows.id();
    const ttys = terminal.windows.tabs.tty();
    const bounds = terminal.windows.bounds().map((b) => JSON.stringify(b));
    const index = ttys.findIndex((tabs) => tabs.includes(tty));
    if (index < 0) return undefined;
    const own = spacesOf(ids[index]);
    if (own.length) return own[0];
    const found = new Set();
    ids.forEach((id, i) => {
      if (i !== index && bounds[i] === bounds[index]) spacesOf(id).forEach((s) => found.add(s));
    });
    return found.size === 1 ? [...found][0] : undefined;
  };
  for (;;) {
    const space = terminalSpace();
    if (space === undefined) return 'none';
    const current = (ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces(cid)) || []).map((d) => d['Current Space'].ManagedSpaceID);
    if (current.includes(space)) return String(space);
    delay(0.5);
  }
}
`;

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
  /** Starts WAIT_SCRIPT for `tty`; `result` holds its output once it exits. */
  startWait(tty: string): { result: Promise<string>; kill(): void };
}

const systemIo: DesktopWaitIo = {
  platform: process.platform,
  env: process.env,
  pid: process.pid,
  psTable: () => new Promise((resolve, reject) =>
    execFile('ps', ['-A', '-o', 'pid=,ppid=,tty='], (err, out) => (err ? reject(err) : resolve(out)))),
  startWait(tty) {
    let child: ChildProcess | undefined;
    const result = new Promise<string>((resolve) => {
      let out = '';
      child = spawn('osascript', ['-l', 'JavaScript', '-e', WAIT_SCRIPT, tty], { stdio: ['ignore', 'pipe', 'pipe'] });
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
 * its window opens.
 */
export async function waitForTerminalDesktop(stop: Promise<unknown>, io: DesktopWaitIo = systemIo): Promise<string> {
  if (io.platform !== 'darwin') return 'skipped: not macOS';
  if (io.env.CDP_TOOLS_DESKTOP_WAIT === '0') return 'skipped: CDP_TOOLS_DESKTOP_WAIT=0';
  const tty = ancestorTty(await io.psTable().catch(() => ''), io.pid);
  if (!tty) {
    await debugLog('TerminalDesktop', 'No ancestor holds a tty; opening the window at once');
    return 'skipped: no tty';
  }
  const wait = io.startWait(tty);
  await debugLog('TerminalDesktop', `Holding the first window until the desktop of the Terminal on ${tty} is showing`);
  const reading = await Promise.race([wait.result, stop.then(() => 'stopped')]);
  wait.kill();
  await debugLog('TerminalDesktop', `Desktop wait for ${tty} returned: ${reading}`);
  return reading;
}
