#!/usr/bin/env node
/**
 * Stress harness for idle suspend and orphan reaping (issue #138).
 *
 * The unit tests cover the state machine with injected fakes; this drives the
 * real supervisor process over real stdio, with real signals and real timing,
 * because the things most likely to break are the ones fakes cannot show you:
 * a request landing inside the teardown window, a timer or fd that survives
 * 200 cycles, a child that ignores its suspend signal while holding a browser.
 *
 * Not part of `npm test` - it spawns dozens of processes and takes minutes.
 *
 *   npm run stress:suspend                 # every scenario
 *   npm run stress:suspend -- race leak    # named scenarios only
 *   npm run stress:suspend -- --cycles=200 # longer race/leak runs
 *   npm run stress:suspend -- --skip=release
 *
 * Scenarios use a sub-minute idle threshold: the supervisor takes fractional
 * minutes in CDP_TOOLS_IDLE_SUSPEND_MINUTES, so 0.03 is 1.8 seconds and the
 * two-hour production default never has to be waited out.
 */
import { spawn, execFileSync, execSync } from 'child_process';
import { mkdtempSync, symlinkSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { connect } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SUPERVISOR = join(REPO_ROOT, 'build', 'mcp-supervisor.js');
const FAKE_CHILD = join(__dirname, 'stress-fixtures', 'fake-mcp-child.mjs');

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

function childrenOf(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function descendantsOf(pid) {
  const direct = childrenOf(pid);
  return direct.flatMap((child) => [child, ...descendantsOf(child)]);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function rssKb(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim());
  } catch {
    return 0;
  }
}

function fdCount(pid) {
  try {
    return execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: 'utf-8' }).trim() * 1;
  } catch {
    return 0;
  }
}

/** The human-readable text of a tools/call answer, error or not. */
function toolText(response) {
  if (response?.error) return JSON.stringify(response.error);
  return (response?.result?.content ?? []).map((part) => part.text ?? '').join(' ').trim() || JSON.stringify(response?.result ?? {});
}

/**
 * Whether something is actually listening, tested by connecting rather than by
 * binding: a server on `::` leaves `127.0.0.1` bindable on macOS, so a bind
 * probe reports "free" for a port that is very much in use.
 */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 50; port++) {
    if (!(await isListening(port))) return port;
  }
  throw new Error(`No free port in ${startPort}..${startPort + 50}`);
}

/**
 * A supervisor under test, with the host side of its stdio wired up so the
 * harness can act as Claude Code would.
 */
function startSupervisor({
  idleMinutes = 0.03,
  pollSeconds = 2,
  childScript = FAKE_CHILD,
  childModes = [],
  suspendGraceMs,
  cwd = tmpdir(),
  parent = null, // { execPath, args } to launch under a fake client instead
} = {}) {
  const env = {
    ...process.env,
    CDP_TOOLS_IDLE_SUSPEND_MINUTES: String(idleMinutes),
    CDP_TOOLS_CLIENT_POLL_SECONDS: String(pollSeconds),
  };
  if (childScript) env.MCP_SUPERVISOR_CHILD_SCRIPT = childScript;
  if (suspendGraceMs !== undefined) env.CDP_TOOLS_SUSPEND_GRACE_MS = String(suspendGraceMs);

  // Detached so it leads its own process group: stop() kills the group, and
  // without this the group kill throws ESRCH and strands the supervisor's own
  // (detached) child - a process-leak harness that leaks processes.
  const proc = spawn(process.execPath, [SUPERVISOR, ...childModes], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  const stderr = [];
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr.push(text);
    if (process.env.STRESS_VERBOSE) process.stderr.write(`  [sup ${proc.pid}] ${text}`);
  });

  const pending = new Map();
  const notifications = [];
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        notifications.push(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params = {}, { timeoutMs = 20_000 } = {}) => {
    const id = nextId++;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No response to ${method} (id ${id}) within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return answered;
  };

  const notify = (method, params = {}) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  return {
    proc,
    pid: proc.pid,
    stderr,
    notifications,
    request,
    notify,
    children: () => childrenOf(proc.pid),
    stderrText: () => stderr.join(''),
    async handshake() {
      const result = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stress-harness', version: '1.0.0' },
      });
      notify('notifications/initialized');
      return result;
    },
    async stop() {
      if (!proc.killed) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      await sleep(150);
    },
  };
}

const waitForSuspend = (supervisor, timeoutMs = 20_000) =>
  waitUntil(() => supervisor.children().length === 0, { timeoutMs, what: 'the child to be suspended' });

const waitForChild = (supervisor, timeoutMs = 20_000) =>
  waitUntil(() => supervisor.children().length > 0, { timeoutMs, what: 'a child to be running' });

/** Samples child count continuously so a transient double-spawn cannot hide. */
function watchChildCount(supervisor, intervalMs = 20) {
  let max = 0;
  const timer = setInterval(() => {
    max = Math.max(max, supervisor.children().length);
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return max;
    },
  };
}

// ---------------------------------------------------------------- scenarios

/**
 * 1. A request landing at every point around the teardown window. The child
 *    takes 300ms to release, so requests are aimed across that window plus its
 *    edges: too early is a normal call, too late is a normal resume, inside it
 *    is the queue path that must not spawn a second child or drop the request.
 */
async function scenarioRace({ cycles }) {
  const supervisor = startSupervisor({ idleMinutes: 0.03, childModes: ['slow-suspend=300'] });
  const watcher = watchChildCount(supervisor);
  const failures = [];
  let hitTeardownWindow = 0;

  try {
    await supervisor.handshake();
    await waitForChild(supervisor);

    for (let cycle = 0; cycle < cycles; cycle++) {
      const suspendedAt = Date.now();
      await waitForSuspend(supervisor);
      const teardownStarted = Date.now() - suspendedAt;

      // Aim across [-150ms, +350ms] relative to the moment the child went away.
      const offset = Math.round((Math.random() - 0.3) * 500);
      if (offset < 0) await sleep(Math.max(0, 300 + offset));
      else await sleep(offset);
      if (offset < 200) hitTeardownWindow++;

      try {
        const response = await supervisor.request('tools/call', { name: 'noop', arguments: {} }, { timeoutMs: 15_000 });
        if (response.error) failures.push(`cycle ${cycle}: error ${JSON.stringify(response.error)}`);
      } catch (err) {
        failures.push(`cycle ${cycle}: ${err.message} (teardown started after ${teardownStarted}ms)`);
      }
    }

    const maxChildren = watcher.stop();
    if (maxChildren > 1) failures.push(`saw ${maxChildren} children alive at once`);

    return {
      passed: failures.length === 0,
      detail: `${cycles} cycles, ~${hitTeardownWindow} aimed inside the teardown window, max children ${maxChildren}`,
      failures,
    };
  } finally {
    watcher.stop();
    await supervisor.stop();
  }
}

/**
 * 2. Repeated suspend/resume, watching the supervisor's own footprint. Timers,
 *    the NDJSON buffer and the queued-line array all live across cycles, so a
 *    leak here would show as steady growth rather than a crash.
 */
async function scenarioLeak({ cycles }) {
  const supervisor = startSupervisor({ idleMinutes: 0.03 });
  const samples = [];

  try {
    await supervisor.handshake();
    await waitForChild(supervisor);

    for (let cycle = 0; cycle < cycles; cycle++) {
      await waitForSuspend(supervisor);
      const response = await supervisor.request('tools/call', { name: 'noop', arguments: {} });
      if (response.error) throw new Error(`cycle ${cycle}: ${JSON.stringify(response.error)}`);
      if (cycle % 10 === 0 || cycle === cycles - 1) {
        samples.push({ cycle, rssKb: rssKb(supervisor.pid), fds: fdCount(supervisor.pid) });
      }
    }

    const first = samples[0];
    const last = samples.at(-1);
    const rssGrowthKb = last.rssKb - first.rssKb;
    const fdGrowth = last.fds - first.fds;
    const failures = [];
    // Node's heap wanders; anything under ~8MB across this many cycles is noise.
    if (rssGrowthKb > 8192) failures.push(`RSS grew ${Math.round(rssGrowthKb / 1024)}MB across ${cycles} cycles`);
    if (fdGrowth > 10) failures.push(`fd count grew by ${fdGrowth} across ${cycles} cycles`);

    return {
      passed: failures.length === 0,
      detail: samples.map((s) => `c${s.cycle}:${Math.round(s.rssKb / 1024)}MB/${s.fds}fd`).join(' '),
      failures,
    };
  } finally {
    await supervisor.stop();
  }
}

/**
 * 3. What a suspend releases, checked against the real server rather than a
 *    fixture: the Chrome it launched and the dev server it owns must both be
 *    gone. "Owns" is the whole subtlety - see the `shared` scenario for the
 *    other half of the rule.
 */
async function scenarioRelease() {
  if (!existsSync(join(REPO_ROOT, 'build', 'index.js'))) {
    return { skipped: true, detail: 'build/index.js missing - run npm run build first' };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'cdp-stress-release-'));
  // A file rather than `node -e`: the command is handed to a shell, and the
  // quoting a one-liner needs does not survive that intact.
  const devServerScript = join(workDir, 'stress-dev-server.mjs');
  // Long enough to get Chrome and a dev server up before the clock runs out.
  const supervisor = startSupervisor({ idleMinutes: 0.5, childScript: null, cwd: workDir });
  // Picked from what is actually free: a fixed port turns a leftover process
  // from an earlier aborted run into a confusing EADDRINUSE failure here.
  const devServerPort = await findFreePort(39_517);
  const failures = [];

  try {
    writeFileSync(
      devServerScript,
      `import { createServer } from 'http';\n` +
        `createServer((req, res) => res.end('ok')).listen(${devServerPort}, () => console.log('listening on ${devServerPort}'));\n`
    );

    await supervisor.handshake();
    await waitForChild(supervisor);

    const launch = await supervisor.request(
      'tools/call',
      { name: 'connection', arguments: { action: 'launch', name: 'suspend stress release', headless: true } },
      { timeoutMs: 60_000 }
    );
    // A failing tool answers with a result carrying isError, not a JSON-RPC
    // error - checking only the latter would call a broken setup a pass.
    // A failing launch used to SKIP, which meant a regression that broke
    // Chrome entirely still exited 0 - the scenario exists to prove Chrome is
    // released, so it has to fail when Chrome never starts.
    if (launch.error || launch.result?.isError) {
      failures.push(`connection launch failed: ${toolText(launch).slice(0, 200)}`);
      return { passed: false, detail: 'could not launch Chrome to release', failures };
    }

    const startServer = await supervisor.request(
      'tools/call',
      {
        name: 'server',
        arguments: {
          action: 'start',
          id: 'stress-release-server',
          command: `node ${devServerScript}`,
          cwd: workDir,
          port: devServerPort,
        },
      },
      { timeoutMs: 60_000 }
    );
    if (startServer.error || startServer.result?.isError) {
      failures.push(`server start failed: ${toolText(startServer).slice(0, 300)}`);
    }

    await waitUntil(() => isListening(devServerPort), { timeoutMs: 20_000, what: 'the dev server to listen' });

    const chromePids = descendantsOf(supervisor.children()[0]).filter((pid) => {
      try {
        return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).includes('remote-debugging-port');
      } catch {
        return false;
      }
    });

    await waitForSuspend(supervisor, 60_000);
    await sleep(2000); // let the OS finish reaping what the child signalled

    // No pids found means the assertion below proves nothing - that is a
    // broken test, not a pass.
    if (chromePids.length === 0) failures.push('found no Chrome processes to check - the release assertion would be vacuous');
    for (const pid of chromePids) {
      if (isAlive(pid)) failures.push(`Chrome pid ${pid} survived the suspend`);
    }
    // Nobody else claims this one, so the suspend owns it and must release it.
    if (await isListening(devServerPort)) failures.push(`dev server on ${devServerPort} survived the suspend unclaimed`);
    if (supervisor.children().length > 0) failures.push('child still running after suspend');

    // And the connection itself must still work.
    const resumed = await supervisor.request('tools/list', {}, { timeoutMs: 60_000 });
    if (resumed.error || !resumed.result?.tools?.length) failures.push('tools/list did not answer after resume');

    return {
      passed: failures.length === 0,
      detail: `${chromePids.length} chrome pid(s) and the owned dev server on ${devServerPort} released`,
      failures,
    };
  } finally {
    await supervisor.stop();
    // A scenario that aborts mid-way must not leave a listener behind for the
    // next run to trip over.
    try {
      execSync(`pkill -f ${devServerScript} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // best effort
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 3b. The other half of the ownership rule, and the one that costs a user real
 *     work if it breaks: a dev server that a second, still-live session also
 *     claims must survive the first session's suspend. A regression here kills
 *     a dev server out from under an editor window that is actively using it.
 */
async function scenarioShared() {
  if (!existsSync(join(REPO_ROOT, 'build', 'index.js'))) {
    return { skipped: true, detail: 'build/index.js missing - run npm run build first' };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'cdp-stress-shared-'));
  const devServerScript = join(workDir, 'stress-dev-server.mjs');
  const devServerPort = await findFreePort(39_617);
  const failures = [];

  // Two sessions in one project: A suspends quickly, B stays awake.
  const sessionA = startSupervisor({ idleMinutes: 0.5, childScript: null, cwd: workDir });
  const sessionB = startSupervisor({ idleMinutes: 0, childScript: null, cwd: workDir });

  try {
    writeFileSync(
      devServerScript,
      `import { createServer } from 'http';\n` +
        `createServer((req, res) => res.end('ok')).listen(${devServerPort}, () => console.log('listening on ${devServerPort}'));\n`
    );

    await sessionA.handshake();
    await waitForChild(sessionA);

    const started = await sessionA.request(
      'tools/call',
      {
        name: 'server',
        arguments: {
          action: 'start',
          id: 'stress-shared-server',
          command: `node ${devServerScript}`,
          cwd: workDir,
          port: devServerPort,
        },
      },
      { timeoutMs: 60_000 }
    );
    if (started.error || started.result?.isError) {
      failures.push(`server start failed: ${toolText(started).slice(0, 300)}`);
      return { passed: false, detail: 'could not start the shared dev server', failures };
    }
    await waitUntil(() => isListening(devServerPort), { timeoutMs: 20_000, what: 'the dev server to listen' });

    // B is the second window on this project. It deliberately does NOT have to
    // know about the server: it was already running when the server started,
    // which is the ordering that claims alone cannot cover. Its presence in
    // the directory is what has to protect the server.
    await sessionB.handshake();
    await waitForChild(sessionB);
    await sessionB.request('tools/call', { name: 'server', arguments: { action: 'list' } }, { timeoutMs: 60_000 });

    await waitForSuspend(sessionA, 60_000);
    await sleep(2000);

    if (!(await isListening(devServerPort))) {
      failures.push(`dev server on ${devServerPort} was stopped despite a second live session claiming it`);
    }

    // And once B goes too, the server is collectable rather than pinned: B's
    // own suspend owns it now.
    await sessionB.request('tools/call', { name: 'server', arguments: { action: 'stop', serverId: 'stress-shared-server' } }, { timeoutMs: 60_000 });
    await waitUntil(async () => !(await isListening(devServerPort)), { timeoutMs: 20_000, what: 'the dev server to stop for its last owner' });

    return {
      passed: failures.length === 0,
      detail: `shared server on ${devServerPort} survived session A's suspend, stopped for session B`,
      failures,
    };
  } finally {
    await sessionA.stop();
    await sessionB.stop();
    try {
      execSync(`pkill -f ${devServerScript} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // best effort
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 4. Signals arriving at the worst possible moment: a rebuild trigger while
 *    the child is mid-teardown, a shutdown in the same window, and a child
 *    that is SIGKILLed exactly as the suspend lands. None may leave a second
 *    child, a crash-respawn storm, or an unanswered request behind.
 */
async function scenarioSignals() {
  const failures = [];

  // (a) SIGUSR2 (rebuild) during the teardown window.
  {
    const supervisor = startSupervisor({ idleMinutes: 0.03, childModes: ['slow-suspend=800'] });
    const watcher = watchChildCount(supervisor);
    try {
      await supervisor.handshake();
      await waitForChild(supervisor);
      await waitUntil(() => supervisor.stderrText().includes('Suspending idle child'), { timeoutMs: 20_000, what: 'the suspend to start' });
      process.kill(supervisor.pid, 'SIGUSR2');
      await sleep(2000);

      const response = await supervisor.request('tools/call', { name: 'noop', arguments: {} }, { timeoutMs: 20_000 });
      if (response.error) failures.push(`(a) rebuild-during-suspend: ${JSON.stringify(response.error)}`);
      const maxChildren = watcher.stop();
      if (maxChildren > 1) failures.push(`(a) rebuild-during-suspend spawned ${maxChildren} children`);
    } catch (err) {
      failures.push(`(a) rebuild-during-suspend: ${err.message}`);
    } finally {
      watcher.stop();
      await supervisor.stop();
    }
  }

  // (b) SIGTERM during the teardown window - must exit cleanly, leaving nothing.
  {
    const supervisor = startSupervisor({ idleMinutes: 0.03, childModes: ['slow-suspend=800'] });
    try {
      await supervisor.handshake();
      await waitForChild(supervisor);
      const childPid = supervisor.children()[0];
      await waitUntil(() => supervisor.stderrText().includes('Suspending idle child'), { timeoutMs: 20_000, what: 'the suspend to start' });
      process.kill(supervisor.pid, 'SIGTERM');

      await waitUntil(() => !isAlive(supervisor.pid), { timeoutMs: 15_000, what: 'the supervisor to exit' });
      if (childPid && isAlive(childPid)) failures.push('(b) shutdown-during-suspend left the child alive');
    } catch (err) {
      failures.push(`(b) shutdown-during-suspend: ${err.message}`);
    } finally {
      await supervisor.stop();
    }
  }

  // (c) child SIGKILLed exactly as the suspend lands - a kill the supervisor
  //     did not ask for, arriving where it expects a deliberate exit.
  {
    const supervisor = startSupervisor({ idleMinutes: 0.03, childModes: ['slow-suspend=500'] });
    const watcher = watchChildCount(supervisor);
    try {
      await supervisor.handshake();
      await waitForChild(supervisor);
      const childPid = supervisor.children()[0];
      await waitUntil(() => supervisor.stderrText().includes('Suspending idle child'), { timeoutMs: 20_000, what: 'the suspend to start' });
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // it beat us to it
      }
      await sleep(2500);

      const response = await supervisor.request('tools/call', { name: 'noop', arguments: {} }, { timeoutMs: 20_000 });
      if (response.error) failures.push(`(c) child-killed-during-suspend: ${JSON.stringify(response.error)}`);
      const maxChildren = watcher.stop();
      if (maxChildren > 1) failures.push(`(c) child-killed-during-suspend spawned ${maxChildren} children`);
    } catch (err) {
      failures.push(`(c) child-killed-during-suspend: ${err.message}`);
    } finally {
      watcher.stop();
      await supervisor.stop();
    }
  }

  return { passed: failures.length === 0, detail: '3 collisions: rebuild, shutdown, child SIGKILL', failures };
}

/**
 * 5. A child that ignores its suspend signal while holding a grandchild - the
 *    stand-in for a server wedged with a browser attached. The supervisor must
 *    escalate rather than wait forever, and the grandchild must not survive.
 */
async function scenarioEscalation() {
  const supervisor = startSupervisor({
    idleMinutes: 0.03,
    childModes: ['ignore-suspend', 'grandchild'],
    suspendGraceMs: 2000,
  });
  const failures = [];

  try {
    await supervisor.handshake();
    await waitForChild(supervisor);
    const childPid = supervisor.children()[0];
    const grandchildren = descendantsOf(childPid);

    const startedAt = Date.now();
    await waitForSuspend(supervisor, 30_000);
    const escalationMs = Date.now() - startedAt;

    await sleep(1000);
    if (isAlive(childPid)) failures.push(`child ${childPid} survived escalation`);
    for (const pid of grandchildren) {
      if (isAlive(pid)) failures.push(`grandchild ${pid} survived escalation`);
    }

    const response = await supervisor.request('tools/call', { name: 'noop', arguments: {} }, { timeoutMs: 20_000 });
    if (response.error) failures.push(`resume after escalation: ${JSON.stringify(response.error)}`);

    return {
      passed: failures.length === 0,
      detail: `escalated and resumed in ${escalationMs}ms (grace 2000ms), ${grandchildren.length} grandchild(ren) checked`,
      failures,
    };
  } finally {
    await supervisor.stop();
  }
}

/**
 * 6. Orphan reaping across a fan-out: one client, several supervisors. Nothing
 *    may die while the client lives, and everything must die once it doesn't -
 *    which is the failure that leaves 500MB of week-old trees behind.
 */
async function scenarioReaper() {
  const TREES = 6;
  const POLL_SECONDS = 2;
  const workDir = mkdtempSync(join(tmpdir(), 'cdp-stress-reaper-'));
  // The watcher walks past node/npm/shell ancestors, so a fake client has to
  // be something else: a differently-named symlink to Node reads as its own
  // program in `ps`, the way `claude` or an IDE helper does.
  const fakeClient = join(workDir, 'stress-fake-client');
  symlinkSync(process.execPath, fakeClient);

  const launcher = `
    const { spawn } = require('child_process');
    const kids = [];
    for (let i = 0; i < ${TREES}; i++) {
      kids.push(spawn(process.argv[0], [${JSON.stringify(SUPERVISOR)}], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env,
          MCP_SUPERVISOR_CHILD_SCRIPT: ${JSON.stringify(FAKE_CHILD)},
          CDP_TOOLS_IDLE_SUSPEND_MINUTES: '0',
          CDP_TOOLS_CLIENT_POLL_SECONDS: '${POLL_SECONDS}' },
      }));
    }
    process.stdout.write(kids.map(k => k.pid).join(',') + '\\n');
    setInterval(() => {}, 60000);
  `;

  const client = spawn(fakeClient, ['-e', launcher], { stdio: ['ignore', 'pipe', 'ignore'] });
  const failures = [];

  try {
    const supervisorPids = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake client never reported its supervisors')), 15_000);
      client.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(chunk.toString().trim().split(',').map(Number));
      });
    });

    // Give every tree a child, then confirm three polls pass with none reaped:
    // a watcher that fires while the client is alive is worse than none.
    await sleep(1500);
    const allPids = supervisorPids.flatMap((pid) => [pid, ...descendantsOf(pid)]);
    await sleep(POLL_SECONDS * 3 * 1000);
    const falsePositives = allPids.filter((pid) => !isAlive(pid));
    if (falsePositives.length > 0) failures.push(`${falsePositives.length} process(es) reaped while the client was alive`);

    process.kill(client.pid, 'SIGKILL');
    const killedAt = Date.now();

    try {
      await waitUntil(() => allPids.every((pid) => !isAlive(pid)), {
        timeoutMs: POLL_SECONDS * 4 * 1000,
        intervalMs: 200,
        what: 'every orphaned process to be reaped',
      });
    } catch (err) {
      const survivors = allPids.filter(isAlive);
      failures.push(`${survivors.length}/${allPids.length} process(es) survived the client: ${survivors.join(', ')}`);
      for (const pid of survivors) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // best effort cleanup
        }
      }
    }

    return {
      passed: failures.length === 0,
      detail: `${TREES} trees / ${allPids.length} processes, reaped ${Date.now() - killedAt}ms after the client died (poll ${POLL_SECONDS}s)`,
      failures,
    };
  } finally {
    try {
      process.kill(client.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- runner

const SCENARIOS = {
  race: { run: scenarioRace, description: 'requests landing across the teardown window' },
  leak: { run: scenarioLeak, description: 'supervisor RSS/fd across many suspend cycles' },
  release: { run: scenarioRelease, description: 'real Chrome and an owned dev server released' },
  shared: { run: scenarioShared, description: 'a dev server another live session claims is left alone' },
  signals: { run: scenarioSignals, description: 'rebuild/shutdown/child-kill during teardown' },
  escalation: { run: scenarioEscalation, description: 'child ignoring the suspend signal' },
  reaper: { run: scenarioReaper, description: 'orphan reaping across several trees' },
};

async function main() {
  const args = process.argv.slice(2);
  const cycles = Number(args.find((a) => a.startsWith('--cycles='))?.split('=')[1] ?? 40);
  const skip = (args.find((a) => a.startsWith('--skip='))?.split('=')[1] ?? '').split(',').filter(Boolean);
  const named = args.filter((a) => !a.startsWith('--'));

  const selected = (named.length > 0 ? named : Object.keys(SCENARIOS)).filter((name) => !skip.includes(name));
  const unknown = selected.filter((name) => !SCENARIOS[name]);
  if (unknown.length > 0) {
    console.error(`Unknown scenario(s): ${unknown.join(', ')}\nAvailable: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }

  if (!existsSync(SUPERVISOR)) {
    console.error(`Missing ${SUPERVISOR} - run npm run build first.`);
    process.exit(2);
  }

  console.log(`Stress: ${selected.join(', ')} (cycles=${cycles})\n`);

  const results = [];
  for (const name of selected) {
    const startedAt = Date.now();
    process.stdout.write(`▸ ${name}: ${SCENARIOS[name].description} ... `);
    let result;
    try {
      result = await SCENARIOS[name].run({ cycles });
    } catch (err) {
      result = { passed: false, failures: [err.message], detail: 'threw' };
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.skipped) {
      console.log(`SKIP (${seconds}s)\n    ${result.detail}`);
    } else if (result.passed) {
      console.log(`PASS (${seconds}s)\n    ${result.detail}`);
    } else {
      console.log(`FAIL (${seconds}s)\n    ${result.detail}`);
      for (const failure of result.failures ?? []) console.log(`    ✗ ${failure}`);
    }
    results.push({ name, ...result });
  }

  const failed = results.filter((r) => !r.passed && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
