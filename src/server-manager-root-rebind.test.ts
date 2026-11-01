/**
 * Local server records derive from the state root, so `relocateRoot` has to
 * re-read them: without it the map built at startup keeps serving the
 * previous root's servers, and the next `saveState` writes those records into
 * the new root's file.
 *
 * Global records come from ~/.devharness, which no relocation moves, so they
 * survive the rebind untouched.
 *
 * The relocation runs through `relocateRoot` (the production transaction in
 * paths.ts), not through a hand-registered resource, so a missing
 * registration in ServerManager fails here rather than passing on test-only
 * wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { setWorkingDirOverride, initializePaths, getOutputPath, relocateRoot } from './helpers/paths.js';
import { ServerManager } from './server-manager.js';

let rootA: string;
let rootB: string;
let localFileA: string;
let localFileB: string;
let globalFile: string;
let originalGlobalDir: string | undefined;

function persistedServer(id: string, cwd: string, pid: number = -1) {
  return {
    type: 'native',
    id,
    command: 'node -e "setInterval(() => {}, 60000)"',
    cwd,
    pid,
    autoRun: false,
    startedAt: '2026-08-19T00:00:00.000Z',
    monitorPort: false,
    watch: false,
    watchPaths: [] as string[],
  };
}

function writeServersFile(
  filePath: string,
  servers: ReturnType<typeof persistedServer>[],
  monitoredPorts: Array<{ port: number; level: string; description: string }> = []
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ version: 4, servers, monitoredPorts, pendingStartups: [] }, null, 2)
  );
}

async function serverIds(manager: ServerManager): Promise<string[]> {
  return (await manager.getStatus()).map(status => status.id).sort();
}

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-sm-rebind-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-sm-rebind-b-'));
  // Isolate the global store from the real ~/.devharness -
  // saveState() writes the global file unconditionally.
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(rootA, '__global__');
  initializePaths();

  setWorkingDirOverride(rootB);
  localFileB = getOutputPath('servers.json');
  setWorkingDirOverride(rootA);
  localFileA = getOutputPath('servers.json');
  globalFile = getOutputPath('servers.json', { global: true });
});

afterEach(() => {
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe('relocateRoot: local server records follow the root', () => {
  it('serves the new root\'s records and drops the old root\'s', async () => {
    writeServersFile(localFileA, [persistedServer('a-only', rootA)]);
    writeServersFile(localFileB, [persistedServer('b-only', rootB)]);

    const manager = new ServerManager();
    await manager.initialize();
    expect(await serverIds(manager)).toEqual(['a-only']);

    await relocateRoot(rootB);
    expect(await serverIds(manager)).toEqual(['b-only']);

    await relocateRoot(rootA);
    expect(await serverIds(manager)).toEqual(['a-only']);
  }, 20000);

  it('serves nothing local when the new root has no records', async () => {
    writeServersFile(localFileA, [persistedServer('a-only', rootA)]);

    const manager = new ServerManager();
    await manager.initialize();

    await relocateRoot(rootB);
    expect(await serverIds(manager)).toEqual([]);
  }, 20000);

  it('keeps global records, which no relocation moves', async () => {
    writeServersFile(localFileA, [persistedServer('a-only', rootA)]);
    writeServersFile(globalFile, [persistedServer('global-one', rootA)]);

    const manager = new ServerManager();
    await manager.initialize();
    expect(await serverIds(manager)).toEqual(['a-only', 'global-one']);

    await relocateRoot(rootB);
    expect(await serverIds(manager)).toEqual(['global-one']);
  }, 20000);
});

describe('relocateRoot: monitored ports follow the root', () => {
  const portA = 39771;
  const portB = 39772;

  it('monitors the new root\'s ports and stops the old root\'s', async () => {
    writeServersFile(localFileA, [persistedServer('a-only', rootA)], [
      { port: portA, level: 'inform', description: 'Server: a-only' },
    ]);
    writeServersFile(localFileB, [persistedServer('b-only', rootB)], [
      { port: portB, level: 'inform', description: 'Server: b-only' },
    ]);

    const manager = new ServerManager();
    await manager.initialize();
    const monitor = manager.getPortMonitor();

    try {
      expect(monitor.isMonitoring(portA)).toBe(true);
      expect(monitor.isMonitoring(portB)).toBe(false);

      await relocateRoot(rootB);
      expect(monitor.isMonitoring(portB)).toBe(true);
      expect(monitor.isMonitoring(portA)).toBe(false);
    } finally {
      await monitor.stopAll();
    }
  }, 20000);
});

describe('relocateRoot: a running server recorded under the new root', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already gone - the test that owns it stopped it through ServerManager.
      }
    }
    child = null;
  });

  it('takes the veto, so relocating away from that root is refused', async () => {
    writeServersFile(localFileA, [persistedServer('a-only', rootA)]);

    // A process this ServerManager never started, the way a record left by
    // another session names one: its log fds pin rootB all the same.
    child = spawn('node', ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise<void>(resolve => child!.once('spawn', () => resolve()));
    writeServersFile(localFileB, [persistedServer('b-live', rootB, child.pid!)]);

    const manager = new ServerManager();
    await manager.initialize();

    await relocateRoot(rootB);
    expect(await serverIds(manager)).toEqual(['b-live']);

    await expect(relocateRoot(rootA)).rejects.toThrow(/b-live/);
    expect(getOutputPath().startsWith(rootB)).toBe(true);

    // Stopping it drops the veto, so the root can move again.
    await manager.stopServer('b-live');
    await relocateRoot(rootA);
    expect(await serverIds(manager)).toEqual(['a-only']);
  }, 20000);
});

describe('relocateRoot: a server this manager started', () => {
  function stayAlive(): string {
    const script = join(rootA, 'stay-alive.mjs');
    writeFileSync(script, 'setInterval(() => {}, 60000);\n');
    return script;
  }

  it('refuses relocation while the server runs, naming it, and leaves the root where it was', async () => {
    const manager = new ServerManager();
    await manager.startServer({ id: 'fitness-demo', command: `node ${stayAlive()}`, cwd: rootA, autoRun: false });

    try {
      await expect(relocateRoot(rootB)).rejects.toThrow(/fitness-demo/);
      expect(getOutputPath().startsWith(rootA)).toBe(true);
    } finally {
      await manager.stopAll();
    }
  }, 20000);

  it('allows relocation once the server has been stopped', async () => {
    const manager = new ServerManager();
    await manager.startServer({ id: 'fitness-demo', command: `node ${stayAlive()}`, cwd: rootA, autoRun: false });
    await manager.stopServer('fitness-demo');

    await expect(relocateRoot(rootB)).resolves.toBeUndefined();
    expect(getOutputPath().startsWith(rootB)).toBe(true);
  }, 20000);
});
