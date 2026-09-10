#!/usr/bin/env node
/**
 * Dependency-free MCP hot-reload supervisor.
 *
 * This is the package's `bin` entry point - both this repo's own .mcp.json
 * and every other project's `npx devharness@latest` launch THIS process
 * instead of the real server directly. This process keeps that stdio
 * connection alive forever and manages the real server (index.js, resolved
 * next to this file - see below) as a restartable child, so:
 * - a crash gets auto-relaunched with backoff, instead of leaving every
 *   project's MCP connection dead until a manual /mcp reconnect;
 * - in this repo specifically, a rebuild (package.json's `postbuild` script)
 *   or a manual `kill -USR2 <pid>` restarts the real server live;
 * - an idle session's server can be dropped entirely - along with its Chrome
 *   instances, dev servers and monitor buffers - while this process keeps the
 *   client's connection alive and respawns on the next request (issue #138);
 * - a tree whose client is gone shuts itself down instead of living for days.
 *
 * The child script path is resolved relative to THIS file's own location
 * (__dirname), not process.cwd() - process.cwd() is this repo's root when
 * launched via its own .mcp.json, but is whatever *other* project's
 * directory Claude Code happened to launch from when installed globally/via
 * npx, which has no build/index.js of its own. Same-directory resolution
 * works correctly in both cases, since index.js always ships right next to
 * this file. Override with MCP_SUPERVISOR_CHILD_SCRIPT for testing; every
 * other argv is passed straight through to the child.
 *
 * See /Users/joshua/.claude/plans/zesty-coalescing-tome.md for the full
 * design and its rationale.
 *
 * Usage: node build/mcp-supervisor.js [...extraChildArgs]
 */
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { getOutputPath, getConfigPath, getGlobalBase } from './helpers/paths.js';
import { ChildManager } from './supervisor/child-manager.js';
import { RestartCoordinator } from './supervisor/restart-coordinator.js';
import { NdjsonReader } from './supervisor/ndjson-reader.js';
import { recordOwnSupervisor, removeOwnPidFile } from './supervisor/pidfile.js';
import { ClientWatcher } from './supervisor/client-watcher.js';
import { readSupervisorSessionConfig, idleCheckIntervalMs } from './supervisor/idle-config.js';
import { createStderrLog } from './supervisor/stderr-log.js';
import { runCli, isCliCommand, isVersionFlag, readPackageVersion, CLI_COMMANDS } from './cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set once main() has a shutdown to run. A write that fails on either host
// pipe means the host's end closed, which is the client being gone.
let onHostPipeBroken: (() => void) | undefined;

const stderrLog = createStderrLog('[mcp-supervisor]', process.stderr, () => {
  if (onHostPipeBroken) onHostPipeBroken();
});

// The host holds the read end of stdout. Its exit closes that end and the next
// frame write returns EPIPE, which without a listener reaches the
// uncaughtException handler - the same loop the stderr latch closes. This
// listener takes it off that path; the latch bounds the writes that follow.
let hostStdoutBroken = false;
process.stdout.on('error', () => {
  if (hostStdoutBroken) return;
  hostStdoutBroken = true;
  if (onHostPipeBroken) onHostPipeBroken();
});

function writeToHostStdout(line: string): void {
  if (hostStdoutBroken) return;
  try {
    process.stdout.write(line.endsWith('\n') ? line : line + '\n');
  } catch {
    hostStdoutBroken = true;
    if (onHostPipeBroken) onHostPipeBroken();
  }
}

function logStderr(message: string): void {
  stderrLog.write(message);
}

async function main(): Promise<void> {
  // A CLI command runs here, in this process, and exits. Supervising a child
  // for it would pipe the child's stdout into the MCP frame forwarder and end
  // the moment stdin closed, so the command's output would never reach the
  // terminal - and a pidfile entry would be left behind for a process that
  // serves no session.
  if (isVersionFlag(process.argv[2])) {
    console.log(readPackageVersion());
    process.exit(0);
  }

  if (isCliCommand(process.argv[2])) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  // `run` replays a saved sequence in a one-shot child that launches its own
  // Chrome. Supervising it forwards the child's stdout into the MCP frame
  // reader and ends the run when stdin closes, so on a terminal it produced no
  // output and hung. Spawned directly with inherited stdio, the child's own
  // output and exit code reach the caller.
  if (process.argv[2] === 'run') {
    const scriptPath = process.env.MCP_SUPERVISOR_CHILD_SCRIPT
      ? path.resolve(process.cwd(), process.env.MCP_SUPERVISOR_CHILD_SCRIPT)
      : path.join(__dirname, 'index.js');
    const child = spawn(process.execPath, [scriptPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
    return;
  }

  // A word that is neither a flag nor a known command is a mistyped command,
  // not a server launch. Spawning a supervisor for it produces no output and
  // waits on a stdin no MCP client is holding, which on a terminal is a hang.
  //
  // Only when stdin is a terminal. Every other argv is passed straight through
  // to the child - the stress harness drives the supervisor with child modes
  // that way - and an MCP client holds a pipe, not a tty.
  const firstArg = process.argv[2];
  if (process.stdin.isTTY && firstArg !== undefined && !firstArg.startsWith('-')) {
    process.stderr.write(
      `devharness: unknown command "${firstArg}"\n` +
      `Commands: ${CLI_COMMANDS.join(', ')}, run, --version\n` +
      `To call any tool: devharness call <tool> '<json>'\n`
    );
    process.exit(1);
  }

  const scriptPath = process.env.MCP_SUPERVISOR_CHILD_SCRIPT
    ? path.resolve(process.cwd(), process.env.MCP_SUPERVISOR_CHILD_SCRIPT)
    : path.join(__dirname, 'index.js');
  const extraArgs = process.argv.slice(2);

  const pidFilePath = getOutputPath('mcp-supervisor.pid');
  // __filename, not scriptPath: the entry a rebuild of THIS tree changes is
  // the supervisor's own file, and that is what postbuild matches on.
  await recordOwnSupervisor(pidFilePath, { pid: process.pid, script: __filename });

  // Overridable so the stress harness can watch the escalation path without
  // sitting out the full grace period (scripts/stress-suspend.mjs).
  const suspendGraceMs = Number(process.env.CDP_TOOLS_SUSPEND_GRACE_MS);

  const childManager = new ChildManager({
    execPath: process.execPath,
    scriptPath,
    extraArgs,
    cwd: process.cwd(),
    suspendGraceMs: Number.isFinite(suspendGraceMs) && suspendGraceMs > 0 ? suspendGraceMs : undefined,
  });

  // Always points at the currently-running child's stdin, so writeToChild
  // routes to whichever process is actually alive right now.
  let currentChildStdin: NodeJS.WritableStream | null = null;

  // Last time this session did anything at all, in either direction - what the
  // idle-suspend timer measures against.
  let lastActivityAt = Date.now();

  const coordinator: RestartCoordinator = new RestartCoordinator(
    {
      writeToChild: (line) => {
        if (!currentChildStdin) {
          logStderr('Dropping message meant for child - no child is currently running');
          return;
        }
        currentChildStdin.write(line + (line.endsWith('\n') ? '' : '\n'));
      },
      writeToHost: (line) => {
        // Traffic in either direction means the session is working, so a tool
        // call that runs longer than the idle threshold isn't suspended the
        // moment it finally answers.
        lastActivityAt = Date.now();
        writeToHostStdout(line);
      },
      killChild: () => childManager.kill(),
      suspendChild: () => childManager.suspend(),
      spawnChild: () => spawnAndWireChild(),
      logStderr,
    },
    {}
  );

  function spawnAndWireChild(): void {
    const { stdout, stdin } = childManager.spawn();
    currentChildStdin = stdin;
    stdin.on('error', (err) => logStderr(`Child stdin error (ignored): ${err}`));

    const reader = new NdjsonReader();
    stdout.on('data', (chunk: Buffer) => {
      reader.push(chunk);
      for (const line of reader.readAllLines()) {
        coordinator.handleChildLine(line);
      }
    });
    stdout.on('close', () => {
      if (currentChildStdin === stdin) {
        currentChildStdin = null;
      }
      coordinator.onChildStdoutClosed();
    });
  }

  childManager.onExit(({ code, signal }) => {
    logStderr(`Child exited (code=${code}, signal=${signal})`);
    coordinator.onChildExit();
  });

  // Host (Claude Code) -> supervisor -> child
  const hostReader = new NdjsonReader();
  process.stdin.on('data', (chunk: Buffer) => {
    hostReader.push(chunk);
    for (const line of hostReader.readAllLines()) {
      lastActivityAt = Date.now();
      coordinator.handleHostLine(line);
    }
  });

  const sessionConfig = readSupervisorSessionConfig({
    configPath: getConfigPath(),
    globalConfigPath: path.join(getGlobalBase(), 'config.json'),
  });

  // Suspend an idle session. The editor window this was launched from is often
  // left open for days; without this the child sits on its Chrome instances,
  // dev servers and monitor buffers for all of that time (issue #138). The
  // supervisor itself stays on the host's stdio, so the connection survives
  // and the next request spawns a fresh child.
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  if (sessionConfig.idleSuspendMinutes > 0) {
    const idleThresholdMs = sessionConfig.idleSuspendMinutes * 60_000;
    const checkIntervalMs = idleCheckIntervalMs(idleThresholdMs);
    logStderr(`Idle suspend after ${sessionConfig.idleSuspendMinutes} minute(s) without host activity`);

    idleCheckTimer = setInterval(() => {
      if (!childManager.isRunning()) return;
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < idleThresholdMs) return;
      coordinator.suspend(`idle for ${Math.round(idleMs / 60_000)} minute(s)`);
    }, checkIntervalMs);
    idleCheckTimer.unref?.();
  } else {
    logStderr('Idle suspend disabled by config');
  }

  // Reap the whole tree when the client that launched it is gone. stdin
  // end/close is supposed to catch that, but never fires when an `npm exec`
  // wrapper sits in between and outlives the client still holding our pipe -
  // which is how trees end up alive for days after their window closed.
  const clientWatcher = new ClientWatcher({
    pollIntervalMs: sessionConfig.clientPollSeconds * 1000,
    logStderr,
  });
  clientWatcher.start(process.pid, (client) => {
    void shutdown(`client PID ${client.pid} exited`);
  });

  // Manual restart trigger (also wired to package.json's `postbuild` script).
  process.on('SIGUSR2', () => {
    logStderr('Received SIGUSR2, restarting child');
    coordinator.requestRestart('signal');
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStderr(`Shutting down (${reason})`);
    clientWatcher.stop();
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    coordinator.prepareForShutdown();
    try {
      // Every path into here means the session itself is over - a signal, the
      // host's stdin closing, or the client being gone - so the child gets the
      // release teardown rather than a bare kill, and takes the dev servers it
      // owns with it. A rebuild restart does NOT come through here: it goes via
      // requestRestart(), which kills shallowly so the next child can reattach.
      await childManager.suspend();
    } catch (err) {
      logStderr(`Error stopping child during shutdown: ${err}`);
    }
    // Only if it is still OURS: a newer supervisor may own it by now, and
    // taking that one's pidfile away silently breaks its hot reload.
    await removeOwnPidFile(pidFilePath, process.pid);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Claude Code exiting without sending a signal still closes its end of stdin.
  process.stdin.on('end', () => void shutdown('host stdin ended'));
  process.stdin.on('close', () => void shutdown('host stdin closed'));

  // A closed host pipe - stderr or stdout - means the session that launched
  // this supervisor is gone. Shutdown from here releases the child and its
  // dev servers and removes the pidfile entry, in place of running on
  // unattached: 12 such
  // supervisors were found alive on one machine, the oldest 5 days 16 hours
  // past its session's exit, each holding a pidfile slot and a child slot.
  onHostPipeBroken = () => void shutdown('host pipe closed');

  // Repeats of one exception are counted and capped. The stderr latch already
  // bounds the EPIPE loop this handler used to feed, so a storm reaching this
  // count originates elsewhere; the exit stops it holding a core either way.
  // Same shape as the child's handler in index.ts (issue #74).
  let lastUncaughtMessage = '';
  let lastUncaughtAt = 0;
  let repeatCount = 0;
  process.on('uncaughtException', (error) => {
    const now = Date.now();
    const message = error?.message ?? String(error);
    if (message === lastUncaughtMessage && now - lastUncaughtAt < 1000) {
      if (++repeatCount > 50) {
        logStderr('Same uncaught exception >50x in <1s, exiting to break the loop');
        process.exit(1);
      }
      return;
    }
    lastUncaughtMessage = message;
    lastUncaughtAt = now;
    repeatCount = 0;
    logStderr(`Uncaught exception: ${error?.stack || error}`);
  });
  process.on('unhandledRejection', (reason) => {
    logStderr(`Unhandled rejection: ${reason}`);
  });

  logStderr(`Starting (PID: ${process.pid}), child script: ${scriptPath}`);
  spawnAndWireChild();
}

main().catch((error) => {
  logStderr(`Fatal error during startup: ${error?.stack || error}`);
  process.exit(1);
});
