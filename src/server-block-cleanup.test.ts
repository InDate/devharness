/**
 * The two ways a managed server could keep blocking every later tool call
 * after the user had already dealt with it:
 *
 * - acknowledgeStartup() on a server that is already dead used to re-arm the
 *   background health check, which noticed the same death 5s later and
 *   re-created the identical block. The acknowledgement could never stick.
 * - stop/remove left the server's `block`-level port monitor behind, so a port
 *   nobody owned any more went on gating tools (and survived in servers.json).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerManager } from './server-manager.js';
import { ServerClaimsStore } from './server-claims.js';
import { initializePaths } from './helpers/paths.js';
import { trackedManagers } from './test-support/server-managers.js';

let workDir: string;
let originalCwd: string;
let originalGlobalDir: string | undefined;
let stayAlive: string;
let diesFast: string;

const OWN_SUPERVISOR = 1001;

const managers = trackedManagers();

function manager(): ServerManager {
  return managers.track(new ServerManager(
    new ServerClaimsStore({
      supervisorPid: OWN_SUPERVISOR,
      isAlive: (pid) => pid === OWN_SUPERVISOR,
      startTimeReader: () => 'start-own',
    })
  ));
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'cdp-block-cleanup-test-'));
  process.chdir(workDir);
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(workDir, 'global');
  initializePaths();

  stayAlive = join(workDir, 'stay-alive.mjs');
  writeFileSync(stayAlive, 'setInterval(() => {}, 60000);\n');
  diesFast = join(workDir, 'dies-fast.mjs');
  writeFileSync(diesFast, 'setTimeout(() => process.exit(1), 100);\n');
});

afterEach(async () => {
  await managers.closeAll();
  process.chdir(originalCwd);
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(workDir, { recursive: true, force: true });
});

describe('acknowledgeStartup', () => {
  it('stays acknowledged for a server that is already dead', async () => {
    const mgr = manager();
    await mgr.startServer({
      id: 'dead-server',
      command: `node ${diesFast}`,
      cwd: workDir,
      autoRun: false,
    });

    // Let it die, then block on it the way the startup detector does.
    await new Promise((resolve) => setTimeout(resolve, 500));
    (mgr as any).pendingStartups.set('dead-server', {
      serverId: 'dead-server',
      startedAt: new Date(),
      timeoutAt: new Date(),
      acknowledged: false,
      reason: 'died',
    });
    expect(mgr.getPendingStartupFailures()).toHaveLength(1);

    expect(await mgr.acknowledgeStartup('dead-server')).toBe(true);
    expect(mgr.getPendingStartupFailures()).toHaveLength(0);

    // The old health check ran on a 5s tick and re-blocked on the first one.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    expect(mgr.getPendingStartupFailures()).toHaveLength(0);

    await mgr.stopAll();
  }, 20000);

  it('still watches a server that is alive, so a later death re-blocks', async () => {
    const mgr = manager();
    const { pid } = await mgr.startServer({
      id: 'live-server',
      command: `node ${stayAlive}`,
      cwd: workDir,
      autoRun: false,
    });

    (mgr as any).pendingStartups.set('live-server', {
      serverId: 'live-server',
      startedAt: new Date(),
      timeoutAt: new Date(),
      acknowledged: false,
      reason: 'timeout',
    });

    expect(await mgr.acknowledgeStartup('live-server')).toBe(true);
    expect(mgr.getPendingStartupFailures()).toHaveLength(0);

    process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 6500));

    expect(mgr.getPendingStartupFailures().map((f) => f.serverId)).toEqual(['live-server']);
  }, 20000);
});

describe('port monitor cleanup', () => {
  it('drops the server\'s port monitor on remove', async () => {
    const mgr = manager();
    await mgr.startServer({
      id: 'monitored',
      command: `node ${stayAlive}`,
      cwd: workDir,
      autoRun: false,
    });
    await mgr.getPortMonitor().startMonitoring(45671, 'block', 'Server: monitored');
    expect(mgr.getPortMonitor().isMonitoring(45671)).toBe(true);

    await mgr.removeServer('monitored');

    expect(mgr.getPortMonitor().isMonitoring(45671)).toBe(false);
  }, 20000);

  it('drops the server\'s port monitor on stop', async () => {
    const mgr = manager();
    await mgr.startServer({
      id: 'monitored',
      command: `node ${stayAlive}`,
      cwd: workDir,
      autoRun: false,
    });
    await mgr.getPortMonitor().startMonitoring(45672, 'block', 'Server: monitored');

    await mgr.stopServer('monitored');

    expect(mgr.getPortMonitor().isMonitoring(45672)).toBe(false);
  }, 20000);

  it('leaves another server\'s port monitor alone', async () => {
    const mgr = manager();
    await mgr.startServer({
      id: 'one',
      command: `node ${stayAlive}`,
      cwd: workDir,
      autoRun: false,
    });
    await mgr.getPortMonitor().startMonitoring(45673, 'block', 'Server: one');
    await mgr.getPortMonitor().startMonitoring(45674, 'block', 'Server: two');

    await mgr.removeServer('one');

    expect(mgr.getPortMonitor().isMonitoring(45673)).toBe(false);
    expect(mgr.getPortMonitor().isMonitoring(45674)).toBe(true);

    await mgr.getPortMonitor().stopMonitoring(45674);
    await mgr.stopAll();
  }, 20000);
});
