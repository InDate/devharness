/**
 * `close()` bounds a ServerManager's writes: once it returns, no
 * port-detection loop the manager started saves servers.json again, wherever
 * the working directory has moved to since.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerManager } from './server-manager.js';
import { ServerClaimsStore } from './server-claims.js';
import { initializePaths } from './helpers/paths.js';
import { isProcessAlive } from './helpers/process-liveness.js';
import { trackedManagers } from './test-support/server-managers.js';

let workDir: string;
let laterDir: string;
let originalCwd: string;
let originalGlobalDir: string | undefined;
let serverScript: string;

const OWN_SUPERVISOR = 1001;
const managers = trackedManagers();

function manager(): ServerManager {
  return managers.track(new ServerManager(new ServerClaimsStore({
    supervisorPid: OWN_SUPERVISOR,
    isAlive: (pid) => pid === OWN_SUPERVISOR,
    startTimeReader: () => 'start-own',
  })));
}

function enter(dir: string): void {
  process.chdir(dir);
  process.env.CDP_TOOLS_DIR = join(dir, 'global');
  initializePaths();
}

async function waitForExit(pid: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  workDir = mkdtempSync(join(tmpdir(), 'cdp-close-test-'));
  laterDir = mkdtempSync(join(tmpdir(), 'cdp-close-later-'));
  enter(workDir);
  serverScript = join(workDir, 'stay-alive.mjs');
  writeFileSync(serverScript, 'setInterval(() => {}, 60000);\n');
});

afterEach(async () => {
  await managers.closeAll();
  process.chdir(originalCwd);
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(laterDir, { recursive: true, force: true });
});

describe('ServerManager.close', () => {
  it('leaves no write for a server that died during startup to land in the next working directory', async () => {
    const serverManager = manager();
    const { pid } = await serverManager.startServer({
      id: 'crashed',
      command: `node ${serverScript}`,
      cwd: workDir,
      autoRun: false,
    });
    process.kill(pid, 'SIGKILL');
    await waitForExit(pid);

    await serverManager.close();
    enter(laterDir);
    // One detection tick is 1000ms; a loop still running saves `died` within it.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(existsSync(join(laterDir, '.devharness', 'servers.json'))).toBe(false);
  }, 20000);

  it('refuses to start a server once closed', async () => {
    const serverManager = manager();
    await serverManager.close();

    await expect(serverManager.startServer({
      id: 'after-close',
      command: `node ${serverScript}`,
      cwd: workDir,
      autoRun: false,
    })).rejects.toThrow(/closed/);
  });
});
