/**
 * Server Manager
 * Manages development servers (any language/framework) - start, stop, restart, and monitor
 * Supports multiple runner types: native (spawn), docker, docker-compose
 * Persists state to .devharness/servers.json for recovery and auto-run
 * Logs to .devharness/logs/<server-id>/ for cross-MCP access (native runner only)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { debugLog } from './debug-logger.js';
import { getOutputPath, registerRootBound, unregisterRootBound } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { configManager } from './config.js';
import { ServerFileWatcher } from './server-watcher.js';
import { serverClaims, type ServerClaimsStore } from './server-claims.js';
import {
  type Runner,
  type RunnerType,
  type PersistedRunnerState,
  detectRunnerType,
  createRunner,
  resetDockerCaches,
  NativeRunner,
  DockerRunner,
  DockerComposeRunner,
} from './runners/index.js';

/**
 * Patterns for commands that auto-restart their own process on file changes
 * (Node's --watch, nodemon, etc.). Pairing one of these with an attached CDP
 * debugger on the same process is a known-bad combination: the auto-restart
 * supervisor races with a paused (frozen) process, which can produce
 * EADDRINUSE crash-loops and ambiguous "failed but still listening" states,
 * since the restart happens entirely outside anything devharness tracks.
 */
const AUTO_RESTART_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: '--watch', regex: /(^|\s)--watch(\b|=)/ },
  { name: 'nodemon', regex: /\bnodemon\b/ },
  { name: 'tsx watch', regex: /\btsx\s+watch\b/ },
  { name: 'ts-node-dev', regex: /\bts-node-dev\b/ },
  { name: 'node-dev', regex: /\bnode-dev\b/ },
  { name: 'bun --hot/--watch', regex: /\bbun\b.*(--hot\b|--watch\b)/ },
  { name: 'deno run --watch', regex: /\bdeno\s+run\b.*--watch\b/ },
];

/**
 * Returns the matched auto-restart pattern name if `command` looks like it
 * self-restarts on file changes, or null otherwise.
 */
export function detectAutoRestartCommand(command: string): string | null {
  for (const { name, regex } of AUTO_RESTART_PATTERNS) {
    if (regex.test(command)) {
      return name;
    }
  }
  return null;
}

/**
 * Extract the Node inspector port from a `--inspect`/`--inspect-brk` flag in
 * a command string, if present. Falls back to Node's default port (9229)
 * when the flag is given with no explicit port. Does not handle a separate
 * `--inspect-port=` flag overriding a bare `--inspect`'s port - a rare
 * combination not worth the extra complexity here.
 */
export function extractInspectorPort(command: string): number | null {
  const match = command.match(/--inspect(?:-brk)?(?:=(?:[\w.]+:)?(\d+))?/);
  if (!match) {
    return null;
  }
  return match[1] ? parseInt(match[1], 10) : 9229;
}

/**
 * Validate server ID to prevent security issues.
 * Server IDs are used in container names, file paths, and project names.
 * Only alphanumeric characters, dashes, and underscores are allowed.
 */
function validateServerId(id: string): void {
  if (!id || id.length === 0) {
    throw new Error('Server ID cannot be empty');
  }
  if (id.length > 64) {
    throw new Error('Server ID cannot exceed 64 characters');
  }
  // Only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      `Invalid server ID "${id}". Server IDs can only contain letters, numbers, dashes, and underscores.`
    );
  }
  // Cannot start with a dash (would cause issues with CLI args)
  if (id.startsWith('-')) {
    throw new Error('Server ID cannot start with a dash');
  }
}

export interface ServerStatus {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  containerId?: string;
  startedAt: Date;
  uptime: string;
  port?: number;
  running: boolean;
  autoRun: boolean;
  runnerType: RunnerType;
  global: boolean;
  watch: boolean;
  /** Where a change restarts it, for a server started with `watch`. */
  watchPaths?: string[];
}

export interface StartServerOptions {
  command: string;
  cwd: string;
  id: string;
  autoRun?: boolean;
  env?: Record<string, string>;
  port?: number;
  /** Runner type - auto-detected from command if not specified */
  runner?: RunnerType;
  /** If true, auto-add detected port to monitoredPorts with default level 'block' */
  monitorPort?: boolean;
  /** If true, store server state in global ~/.devharness/ instead of project directory */
  global?: boolean;
  /** If true, watch this server's files and auto-restart it (pause-aware) on change instead of relying on --watch/nodemon */
  watch?: boolean;
  /** Paths to watch when `watch` is true (default: [cwd]) */
  watchPaths?: string[];
  /** Empty the server's log files before it starts (native runner) */
  clearLogs?: boolean;
}

export interface LogStats {
  serverId: string;
  newStdout: number;
  newStderr: number;
}

interface ManagedServer {
  id: string;
  runner: Runner;
  autoRun: boolean;
  monitorPort?: boolean;
  global?: boolean; // Whether this server is stored in global ~/.devharness/
  watch?: boolean;
  watchPaths?: string[];
  // In-memory only. Owned by the current ManagedServer instance since a
  // fresh one is created by every startServer() call (including the one
  // inside restartServer()), and a fresh watcher should indeed be created
  // each time. Restart-guard/pending-restart state is deliberately NOT
  // stored here - see `watchState` below - because it needs to survive
  // exactly the restartServer() call that replaces this object.
  watcher?: ServerFileWatcher;
}

/**
 * Watch-mode restart coordination state, keyed by serverId (stable across
 * restarts, unlike the ManagedServer object itself which restartServer()
 * replaces wholesale on every restart).
 */
interface WatchRestartState {
  restarting: boolean;
  restartQueued: boolean;
  pendingRestart?: { queuedAt: Date };
  /** The in-flight restart's own promise, so a second caller (watch-triggered
   * or explicit) arriving mid-restart can share it instead of racing it. */
  inFlight?: Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }>;
}

/** A watch-triggered restart that's queued behind a paused breakpoint debugger. */
export interface PendingRestartInfo {
  serverId: string;
  queuedAt: Date;
}

// ============================================================================
// Port Monitoring Types and Class
// ============================================================================

export type MonitoringLevel = 'inform' | 'error' | 'block';

export interface PersistedMonitoredPort {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number; // Custom interval in ms (overrides config)
}

export interface MonitoredPort {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number; // Custom interval in ms (overrides config)
  status: 'up' | 'down' | 'connecting';
  socket: net.Socket | null;
  failedAt?: Date;
  acknowledged: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface MonitoredPortStatus {
  port: number;
  level: MonitoringLevel;
  description?: string;
  interval?: number;
  status: 'up' | 'down' | 'connecting';
  failedAt?: Date;
  acknowledged: boolean;
}

export interface PortFailureInfo {
  port: number;
  level: MonitoringLevel;
  description?: string;
  failedAt: Date;
}

/** Function type for getting interval for a monitoring level */
export type GetIntervalForLevel = (level: MonitoringLevel) => number;

// ============================================================================
// Pending Startup Types (for startup timeout tracking)
// ============================================================================

export type PendingStartupReason = 'timeout' | 'died';

export interface PendingStartup {
  serverId: string;
  startedAt: Date;
  timeoutAt: Date;
  acknowledged: boolean;
  reason?: PendingStartupReason;  // Set when blocking is triggered
}

export interface PersistedPendingStartup {
  serverId: string;
  startedAt: string;  // ISO date
  timeoutAt: string;  // ISO date
  acknowledged: boolean;
  reason?: PendingStartupReason;
}

export interface PendingStartupFailureInfo {
  serverId: string;
  startedAt: Date;
  reason: PendingStartupReason;
}

/**
 * Port Monitor - monitors ports using persistent TCP connections
 */
export class PortMonitor {
  private ports: Map<number, MonitoredPort> = new Map();
  private onFailureCallback?: (port: number, level: MonitoringLevel) => void;
  private getIntervalForLevel: GetIntervalForLevel;
  // Refcount so multiple paused CDP connections can share one PortMonitor safely:
  // monitoring only actually stops on the first pause and only actually resumes
  // once every pause has a matching resume.
  private pauseCount = 0;

  constructor(getIntervalForLevel?: GetIntervalForLevel) {
    // Default intervals if no config provided
    this.getIntervalForLevel = getIntervalForLevel ?? ((level) => {
      switch (level) {
        case 'block': return 1000;
        case 'error': return 2000;
        case 'inform': return 5000;
        default: return 2000;
      }
    });
  }

  onFailure(callback: (port: number, level: MonitoringLevel) => void): void {
    this.onFailureCallback = callback;
  }

  async startMonitoring(port: number, level: MonitoringLevel, description?: string, interval?: number): Promise<void> {
    const existing = this.ports.get(port);
    if (existing) {
      existing.level = level;
      existing.description = description;
      existing.interval = interval;
      if (existing.status === 'down' && existing.acknowledged) {
        existing.acknowledged = false;
      }
      // Self-heal: if this port's monitor is dormant (no active socket and no
      // pending reconnect - e.g. left stuck by an imbalanced pause/resume),
      // reconnect it rather than silently staying dead.
      if (!existing.socket && !existing.reconnectTimer) {
        this.connectToPort(port);
      }
      await debugLog('PortMonitor', `Updated monitoring for port ${port}: level=${level}, interval=${interval ?? 'default'}`);
      return;
    }

    const monitored: MonitoredPort = {
      port,
      level,
      description,
      interval,
      status: 'connecting',
      socket: null,
      acknowledged: false,
    };

    this.ports.set(port, monitored);
    await debugLog('PortMonitor', `Starting monitoring for port ${port} (level: ${level}, interval: ${interval ?? 'default'})`);
    this.connectToPort(port);
  }

  private connectToPort(port: number): void {
    const monitored = this.ports.get(port);
    if (!monitored) return;

    if (monitored.reconnectTimer) {
      clearTimeout(monitored.reconnectTimer);
      monitored.reconnectTimer = undefined;
    }

    if (monitored.socket) {
      monitored.socket.removeAllListeners();
      monitored.socket.destroy();
      monitored.socket = null;
    }

    if (monitored.status !== 'up') {
      monitored.status = 'connecting';
    }

    const socket = new net.Socket();
    socket.setTimeout(5000);
    let hadError = false;

    socket.on('connect', async () => {
      const wasDown = monitored.status === 'down' || monitored.status === 'connecting';
      monitored.status = 'up';
      monitored.socket = socket;
      monitored.failedAt = undefined;
      monitored.acknowledged = false;
      if (wasDown) {
        await debugLog('PortMonitor', `Port ${port} is UP`);
      }
      socket.destroy();
    });

    socket.on('close', async () => {
      monitored.socket = null;
      if (!hadError) {
        this.scheduleReconnect(port);
      }
    });

    socket.on('error', async (err: NodeJS.ErrnoException) => {
      hadError = true;
      const wasUp = monitored.status === 'up';

      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        if (wasUp || monitored.status === 'connecting') {
          monitored.status = 'down';
          monitored.failedAt = monitored.failedAt || new Date();
          monitored.socket = null;

          if (wasUp) {
            await debugLog('PortMonitor', `Port ${port} went DOWN: ${err.message}`);
            if (this.onFailureCallback) {
              this.onFailureCallback(port, monitored.level);
            }
          } else {
            await debugLog('PortMonitor', `Port ${port} is down: ${err.message}`);
          }
        }
      } else {
        await debugLog('PortMonitor', `Port ${port} connection error (ignoring): ${err.message}`);
      }

      this.scheduleReconnect(port);
    });

    socket.on('timeout', () => {
      hadError = true;
      socket.destroy();

      if (monitored.status === 'connecting' || monitored.status === 'up') {
        const wasUp = monitored.status === 'up';
        monitored.status = 'down';
        monitored.failedAt = monitored.failedAt || new Date();

        if (wasUp) {
          debugLog('PortMonitor', `Port ${port} went DOWN: connection timeout`);
          if (this.onFailureCallback) {
            this.onFailureCallback(port, monitored.level);
          }
        }
      }

      this.scheduleReconnect(port);
    });

    socket.connect(port, 'localhost');
  }

  private scheduleReconnect(port: number): void {
    const monitored = this.ports.get(port);
    if (!monitored || monitored.reconnectTimer) return;

    // Use per-port interval if set, otherwise get from config based on level
    const interval = monitored.interval ?? this.getIntervalForLevel(monitored.level);

    monitored.reconnectTimer = setTimeout(() => {
      monitored.reconnectTimer = undefined;
      if (this.ports.has(port)) {
        this.connectToPort(port);
      }
    }, interval);
  }

  async stopMonitoring(port: number): Promise<boolean> {
    const monitored = this.ports.get(port);
    if (!monitored) return false;

    if (monitored.socket) {
      monitored.socket.removeAllListeners();
      monitored.socket.destroy();
    }
    if (monitored.reconnectTimer) {
      clearTimeout(monitored.reconnectTimer);
    }

    this.ports.delete(port);
    await debugLog('PortMonitor', `Stopped monitoring port ${port}`);
    return true;
  }

  async acknowledgeFailure(port: number): Promise<boolean> {
    const monitored = this.ports.get(port);
    if (!monitored || monitored.status !== 'down') return false;

    monitored.acknowledged = true;
    await debugLog('PortMonitor', `Acknowledged failure for port ${port}`);
    return true;
  }

  getFailedPorts(): PortFailureInfo[] {
    const failed: PortFailureInfo[] = [];
    for (const [port, monitored] of this.ports) {
      if (monitored.status === 'down' && !monitored.acknowledged && monitored.failedAt) {
        failed.push({
          port,
          level: monitored.level,
          description: monitored.description,
          failedAt: monitored.failedAt,
        });
      }
    }
    return failed;
  }

  getFailedPortsByLevel(level: MonitoringLevel): PortFailureInfo[] {
    return this.getFailedPorts().filter(p => p.level === level);
  }

  hasBlockingFailures(): boolean {
    return this.getFailedPortsByLevel('block').length > 0;
  }

  isMonitoring(port: number): boolean {
    return this.ports.has(port);
  }

  getStatus(port?: number): MonitoredPortStatus[] {
    if (port !== undefined) {
      const monitored = this.ports.get(port);
      if (!monitored) return [];
      return [{
        port: monitored.port,
        level: monitored.level,
        description: monitored.description,
        interval: monitored.interval,
        status: monitored.status,
        failedAt: monitored.failedAt,
        acknowledged: monitored.acknowledged,
      }];
    }

    return Array.from(this.ports.values()).map(m => ({
      port: m.port,
      level: m.level,
      description: m.description,
      interval: m.interval,
      status: m.status,
      failedAt: m.failedAt,
      acknowledged: m.acknowledged,
    }));
  }

  getPersistedState(): PersistedMonitoredPort[] {
    return Array.from(this.ports.values()).map(m => ({
      port: m.port,
      level: m.level,
      description: m.description,
      interval: m.interval,
    }));
  }

  async restoreFromState(ports: PersistedMonitoredPort[]): Promise<void> {
    for (const p of ports) {
      await this.startMonitoring(p.port, p.level, p.description, p.interval);
    }
  }

  async stopAll(): Promise<void> {
    for (const port of this.ports.keys()) {
      await this.stopMonitoring(port);
    }
  }

  /**
   * Pause all port monitoring (e.g., when paused at a breakpoint)
   * Stops reconnection attempts but preserves port state
   */
  pauseMonitoring(): void {
    this.pauseCount++;
    if (this.pauseCount > 1) {
      // Another connection already has monitoring paused; nothing new to do.
      debugLog('PortMonitor', `Port monitoring pause count now ${this.pauseCount}`);
      return;
    }
    for (const monitored of this.ports.values()) {
      // Clear any pending reconnect timers
      if (monitored.reconnectTimer) {
        clearTimeout(monitored.reconnectTimer);
        monitored.reconnectTimer = undefined;
      }
      // Close any active socket connections
      if (monitored.socket) {
        monitored.socket.removeAllListeners();
        monitored.socket.destroy();
        monitored.socket = null;
      }
    }
    debugLog('PortMonitor', 'Port monitoring paused');
  }

  /**
   * Resume all port monitoring (e.g., when resuming from a breakpoint)
   * Restarts connection attempts for all monitored ports, once every
   * outstanding pauseMonitoring() call has a matching resumeMonitoring().
   */
  resumeMonitoring(): void {
    if (this.pauseCount === 0) {
      // Unbalanced resume (shouldn't normally happen) - nothing to do.
      return;
    }
    this.pauseCount--;
    if (this.pauseCount > 0) {
      debugLog('PortMonitor', `Port monitoring still paused by ${this.pauseCount} other connection(s)`);
      return;
    }
    for (const port of this.ports.keys()) {
      this.connectToPort(port);
    }
    debugLog('PortMonitor', 'Port monitoring resumed');
  }
}

// ============================================================================
// Server Manager
// ============================================================================

/**
 * Registry key for a running server's veto. The `server:` prefix keeps a
 * server id from landing on the manager's own `server-manager` entry, which
 * a bare id would replace - the registry is last-write-wins per name, so the
 * collision would drop the rebind with nothing reported.
 */
function rootBoundServerName(serverId: string): string {
  return `server:${serverId}`;
}

export class ServerManager {
  private servers: Map<string, ManagedServer> = new Map();
  private portMonitor: PortMonitor | null = null;
  private pendingStartups: Map<string, PendingStartup> = new Map();
  /** Mutex to serialize saveState calls - prevents concurrent file writes */
  private saveMutex: Promise<void> = Promise.resolve();
  /** Injected from index.ts - decouples ServerManager from ConnectionManager directly */
  private pauseChecker: ((inspectorPort: number) => boolean) | null = null;
  /** Watch-mode restart coordination, keyed by serverId - see WatchRestartState */
  private watchState: Map<string, WatchRestartState> = new Map();
  /** Ownership claims - who may stop a shared dev server (see server-claims.ts) */
  private readonly claims: ServerClaimsStore;

  constructor(claimsStore: ServerClaimsStore = serverClaims) {
    this.claims = claimsStore;
    // Local server records derive from the state root, so a relocation leaves
    // this map describing the previous root. registerRootBound is
    // last-write-wins per name, so the rebind belongs to the most recently
    // constructed manager - the one a tool call reaches.
    registerRootBound({
      name: 'server-manager',
      rebind: () => this.rebindToRoot(),
    });
  }

  /**
   * Set the function used to check whether a CDP connection at a given
   * inspector port is currently paused at a breakpoint. Mirrors the existing
   * setChromeLauncher() injection pattern.
   */
  setPauseChecker(fn: (inspectorPort: number) => boolean): void {
    this.pauseChecker = fn;
  }

  /**
   * Get the port monitor instance (lazy-initialized)
   * Must be called after configManager.load() for config values to be used
   */
  getPortMonitor(): PortMonitor {
    if (!this.portMonitor) {
      // Lazy init - ensures config is loaded before we read intervals
      this.portMonitor = new PortMonitor((level) => configManager.getIntervalForLevel(level));
    }
    return this.portMonitor;
  }

  private getServersFilePath(global?: boolean): string {
    return getOutputPath('servers.json', { global: global ?? false });
  }

  /**
   * Initialize - load state and recover/start auto-run servers
   * Loads from both local (project) and global (~/.devharness/) storage
   */
  async initialize(): Promise<{ recovered: string[]; started: string[]; failed: string[]; monitoredPorts: number[]; collected: string[] }> {
    const recovered: string[] = [];
    const started: string[] = [];
    const failed: string[] = [];
    const monitoredPorts: number[] = [];

    // Load from both local and global storage
    const localPersisted = await this.loadState(false);
    const globalPersisted = await this.loadState(true);

    // Combine servers from both sources (local servers marked with global=false, global with global=true)
    const allServers = [
      ...localPersisted.servers.map(s => ({ ...s, global: false })),
      ...globalPersisted.servers.map(s => ({ ...s, global: true })),
    ];

    // Restore monitored ports from local config
    if (localPersisted.monitoredPorts.length > 0) {
      await this.getPortMonitor().restoreFromState(localPersisted.monitoredPorts);
      monitoredPorts.push(...localPersisted.monitoredPorts.map(p => p.port));
      await debugLog('ServerManager', `Restored ${monitoredPorts.length} monitored ports`);
    }

    // Restore pending startups from both local and global
    const allPendingStartups = [
      ...localPersisted.pendingStartups,
      ...globalPersisted.pendingStartups,
    ];
    for (const persisted of allPendingStartups) {
      const pending: PendingStartup = {
        serverId: persisted.serverId,
        startedAt: new Date(persisted.startedAt),
        timeoutAt: new Date(persisted.timeoutAt),
        acknowledged: persisted.acknowledged,
        reason: persisted.reason,
      };
      this.pendingStartups.set(persisted.serverId, pending);
      await debugLog('ServerManager', `Restored pending startup: ${persisted.serverId}`);
    }

    // Reset Docker caches before processing servers - ensures we check Docker availability
    // fresh on each startup, catching cases where Docker stopped since last run
    resetDockerCaches();

    // Read before the loop below claims anything: a server we are about to
    // claim during recovery would otherwise look owned by us and never be
    // collected, no matter how long ago its real owners died (issue #139).
    const abandoned = this.findAbandonedServerIds();
    const collected: string[] = [];

    for (const server of allServers) {
      const runnerType = server.type || 'native';
      const runner = createRunner(runnerType, server.id);

      // Restore runner state using the interface method (pass PersistedRunnerState directly)
      runner.restore(server);

      const isRunning = await runner.isRunning();

      if (isRunning) {
        const managed: ManagedServer = {
          id: server.id,
          runner,
          autoRun: server.autoRun,
          monitorPort: server.monitorPort,
          global: server.global,
          watch: server.watch,
          watchPaths: server.watchPaths,
        };
        this.servers.set(server.id, managed);
        this.registerRunningServerVeto(server.id);

        // The process survived, but any watcher was tied to the previous
        // ServerManager instance (e.g. before devharness's own supervisor
        // restarted it) - re-establish it now.
        if (server.watch) {
          this.startWatcher(managed, server.watchPaths && server.watchPaths.length > 0 ? server.watchPaths : [server.cwd]);
        }

        // For native runner, init cursor to EOF (native-specific method)
        if (runner.type === 'native' && 'initializeCursorToEOF' in runner) {
          await (runner as any).initializeCursorToEOF();
        }

        // Every session that ever claimed this server is gone, so nobody is
        // coming back for it - this is the closed-window leak, collected at
        // the first opportunity rather than left running until reboot.
        // Another window on this project may be using it even though it never
        // claimed it - only the last session out collects.
        if (
          abandoned.get(server.global ?? false)?.has(server.id) &&
          !this.claims.hasOtherLiveSessionIn(server.cwd)
        ) {
          try {
            await debugLog('ServerClaims', `Collecting abandoned server ${server.id}`);
            await this.stopServer(server.id);
            collected.push(server.id);
            continue;
          } catch (error) {
            await debugLog('ServerClaims', `Failed to collect ${server.id}: ${error}`);
          }
        }

        // Reattaching is use: this session now depends on the server, so it
        // takes a claim alongside whoever else already holds one.
        await this.claims.claim(server.id, server.cwd, server.global ?? false);

        recovered.push(server.id);
        await debugLog('ServerManager', `Recovered running server: ${server.id} (${runnerType}, global=${server.global})`);
      } else if (server.autoRun) {
        // Not running but autoRun - restart
        let success = false;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries && !success; attempt++) {
          try {
            if (server.port) {
              await this.waitForPortRelease(server.port, 5);
            }

            await this.startServer({
              command: server.command,
              cwd: server.cwd,
              id: server.id,
              autoRun: true,
              runner: runnerType,
              monitorPort: server.monitorPort,
              global: server.global,
              watch: server.watch,
              watchPaths: server.watchPaths,
            });
            started.push(server.id);
            success = true;
            await debugLog('ServerManager', `Auto-started server: ${server.id} (attempt ${attempt})`);
          } catch (err) {
            await debugLog('ServerManager', `Auto-start attempt ${attempt}/${maxRetries} failed for ${server.id}: ${err}`);
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
            }
          }
        }

        if (!success) {
          failed.push(server.id);
          // Still add to map so it can be manually restarted
          this.servers.set(server.id, {
            id: server.id,
            runner,
            autoRun: server.autoRun,
            monitorPort: server.monitorPort,
            global: server.global,
            watch: server.watch,
            watchPaths: server.watchPaths,
          });

          // Create a pending startup failure to block tools until acknowledged
          const now = new Date();
          this.pendingStartups.set(server.id, {
            serverId: server.id,
            startedAt: now,
            timeoutAt: now, // Already timed out
            acknowledged: false,
            reason: 'died', // Failed to start = died
          });
          await debugLog('ServerManager', `Created blocking failure for autoRun server: ${server.id}`);
        }
      } else {
        // Not running and not autoRun - keep config for manual restart
        this.servers.set(server.id, {
          id: server.id,
          runner,
          autoRun: false,
          monitorPort: server.monitorPort,
          global: server.global,
          watch: server.watch,
          watchPaths: server.watchPaths,
        });
      }
    }

    // Process restored pending startups
    // For each pending startup, check if server is still running and if timeout has passed
    for (const [serverId, pending] of this.pendingStartups) {
      const managed = this.servers.get(serverId);
      if (!managed) {
        // Server no longer exists, remove pending state
        this.pendingStartups.delete(serverId);
        await debugLog('ServerManager', `Removed pending startup for non-existent server: ${serverId}`);
        continue;
      }

      const isRunning = await managed.runner.isRunning();
      const now = new Date();

      if (!isRunning) {
        // Server died - set reason, but respect existing acknowledgment
        pending.reason = 'died';
        // Only reset acknowledged if it wasn't already acknowledged
        // (user already dealt with this failure before MCP restart)
        await debugLog('ServerManager', `Pending startup server died: ${serverId} (acknowledged: ${pending.acknowledged})`);
      } else if (now >= pending.timeoutAt) {
        // Timeout already passed - set reason, but respect existing acknowledgment
        pending.reason = 'timeout';
        await debugLog('ServerManager', `Pending startup already timed out: ${serverId} (acknowledged: ${pending.acknowledged})`);
      } else {
        // Still within timeout window - resume background detection
        const remainingMs = pending.timeoutAt.getTime() - now.getTime();
        await debugLog('ServerManager', `Resuming port detection for ${serverId}, ${Math.round(remainingMs / 1000)}s remaining`);
        this.resumePortDetection(serverId, remainingMs);
      }
    }

    if (collected.length > 0) {
      console.error(`[devharness] Collected ${collected.length} abandoned dev server(s): ${collected.join(', ')}`);
    }

    await this.saveState();
    return { recovered, started, failed, monitoredPorts, collected };
  }

  /**
   * Resume port detection for a server after MCP restart
   * @param serverId The server to resume detection for
   * @param remainingMs Time remaining until timeout
   */
  private resumePortDetection(serverId: string, remainingMs: number): void {
    // Run detection in background (don't await)
    this.detectPortInBackgroundWithTimeout(serverId, remainingMs);
  }

  private async loadState(global?: boolean): Promise<{ servers: PersistedRunnerState[]; monitoredPorts: PersistedMonitoredPort[]; pendingStartups: PersistedPendingStartup[] }> {
    const filePath = this.getServersFilePath(global);

    try {
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Handle migration from old format (no runner type)
        const servers = (data.servers || []).map((s: any) => ({
          ...s,
          type: s.type || 'native',
          global: global ?? false,
        }));

        return {
          servers,
          monitoredPorts: data.monitoredPorts || [],
          pendingStartups: data.pendingStartups || [],
        };
      }
    } catch (err) {
      await debugLog('ServerManager', `Failed to load state from ${filePath}: ${err}`);
    }

    return { servers: [], monitoredPorts: [], pendingStartups: [] };
  }

  /**
   * Save state to disk - serialized through mutex to prevent concurrent writes
   */
  async saveState(): Promise<void> {
    // Queue behind any pending save to serialize all writes
    this.saveMutex = this.saveMutex.then(() => this.doSaveState()).catch(() => {});
    return this.saveMutex;
  }

  /**
   * Internal save implementation - uses atomic writes to prevent corruption
   */
  private async doSaveState(): Promise<void> {
    // Split servers by global flag
    const localServers: PersistedRunnerState[] = [];
    const globalServers: PersistedRunnerState[] = [];

    for (const [id, managed] of this.servers) {
      const runner = managed.runner;
      const status = await runner.getStatus();

      let containerId: string | undefined;
      if (runner instanceof DockerRunner) {
        containerId = runner.getContainerId() ?? undefined;
      }

      const serverData: PersistedRunnerState = {
        type: runner.type,
        id,
        command: this.getRunnerCommand(runner),
        cwd: this.getRunnerCwd(runner),
        pid: status.pid,
        pidStartedAt: status.pidStartedAt,
        containerId,
        port: status.port,
        autoRun: managed.autoRun,
        startedAt: status.startedAt?.toISOString() ?? new Date().toISOString(),
        monitorPort: managed.monitorPort,
        watch: managed.watch,
        watchPaths: managed.watchPaths,
      };

      if (managed.global) {
        globalServers.push(serverData);
      } else {
        localServers.push(serverData);
      }
    }

    const monitoredPorts = this.getPortMonitor().getPersistedState();

    // Convert pending startups to persisted format, split by server's global flag
    const localPendingStartups: PersistedPendingStartup[] = [];
    const globalPendingStartups: PersistedPendingStartup[] = [];
    for (const [serverId, pending] of this.pendingStartups) {
      const managed = this.servers.get(serverId);
      const persisted: PersistedPendingStartup = {
        serverId: pending.serverId,
        startedAt: pending.startedAt.toISOString(),
        timeoutAt: pending.timeoutAt.toISOString(),
        acknowledged: pending.acknowledged,
        reason: pending.reason,
      };
      if (managed?.global) {
        globalPendingStartups.push(persisted);
      } else {
        localPendingStartups.push(persisted);
      }
    }

    // Save local servers to project directory (atomic write prevents corruption)
    const localPath = this.getServersFilePath(false);
    await atomicWriteFile(
      localPath,
      JSON.stringify({
        version: 4,
        updatedAt: new Date().toISOString(),
        servers: localServers,
        monitoredPorts, // Port monitoring stays in local config
        pendingStartups: localPendingStartups,
      }, null, 2)
    );

    // Save global servers to ~/.devharness/ (atomic write prevents corruption)
    const globalPath = this.getServersFilePath(true);
    await atomicWriteFile(
      globalPath,
      JSON.stringify({
        version: 4,
        updatedAt: new Date().toISOString(),
        servers: globalServers,
        monitoredPorts: [], // Global doesn't track port monitoring
        pendingStartups: globalPendingStartups,
      }, null, 2)
    );
  }

  private getRunnerCommand(runner: Runner): string {
    if (runner instanceof NativeRunner) return runner.getCommand();
    if (runner instanceof DockerRunner) return runner.getCommand();
    if (runner instanceof DockerComposeRunner) return runner.getCommand();
    return '';
  }

  private getRunnerCwd(runner: Runner): string {
    if (runner instanceof NativeRunner) return runner.getCwd();
    if (runner instanceof DockerRunner) return runner.getCwd();
    if (runner instanceof DockerComposeRunner) return runner.getCwd();
    return '';
  }

  /**
   * Find the managed server whose command's --inspect/--inspect-brk port
   * matches `port` - i.e. the server a CDP debugger connection at that port
   * actually belongs to. This is deliberately NOT the server's own detected
   * app/service port (e.g. an HTTP port parsed from "listening on port
   * 3000") - a Node process's inspector port and its own app port are
   * normally different numbers, so matching on the app port would almost
   * never find anything real.
   */
  async getManagedServerByInspectorPort(port: number): Promise<{ id: string; command: string } | null> {
    return this.findManagedServerByInspectorPortSync(port);
  }

  /** Sync core of getManagedServerByInspectorPort() - reused by watch-restart lookups, which run in a sync pre-execution hot path (checkBreakpointPause) and can't await. */
  private findManagedServerByInspectorPortSync(port: number): { id: string; command: string } | null {
    for (const managed of this.servers.values()) {
      const command = this.getRunnerCommand(managed.runner);
      if (extractInspectorPort(command) === port) {
        return { id: managed.id, command };
      }
    }
    return null;
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, 'localhost');
    });
  }

  /**
   * Find PIDs of processes listening on a port using lsof
   */
  private async findProcessesOnPort(port: number): Promise<number[]> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`lsof -ti :${port}`, (error: any, stdout: string) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        const pids = stdout.trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0);
        resolve(pids);
      });
    });
  }

  /**
   * Get the working directory of a process by PID
   */
  private async getProcessCwd(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      // Use lsof to get the cwd of the process (works on macOS and Linux)
      exec(`lsof -p ${pid} | grep cwd | awk '{print $NF}'`, (error: any, stdout: string) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Kill orphan processes holding a port, but only if they're in the expected directory
   * Returns: { killed: PIDs killed, foreign: PIDs that are from a different directory }
   */
  private async killOrphanProcessesOnPort(port: number, expectedCwd: string, expectedPid?: number): Promise<{ killed: number[]; foreign: number[] }> {
    const pids = await this.findProcessesOnPort(port);
    const killed: number[] = [];
    const foreign: number[] = [];

    for (const pid of pids) {
      // Skip if this is the expected process
      if (expectedPid && pid === expectedPid) continue;

      // Check if process is running from the expected directory
      const processCwd = await this.getProcessCwd(pid);

      if (!processCwd || !processCwd.startsWith(expectedCwd)) {
        // Process is from a different directory - don't kill it
        await debugLog('ServerManager', `Process ${pid} on port ${port} is from different directory (${processCwd}), not killing`);
        foreign.push(pid);
        continue;
      }

      try {
        await debugLog('ServerManager', `Killing orphan process ${pid} on port ${port} (cwd: ${processCwd})`);
        process.kill(pid, 'SIGTERM');
        killed.push(pid);

        // Wait briefly then force kill if needed
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(pid, 'SIGKILL');
          await debugLog('ServerManager', `Force killed orphan process ${pid}`);
        } catch {
          // Process already dead
        }
      } catch (err) {
        await debugLog('ServerManager', `Failed to kill process ${pid}: ${err}`);
      }
    }

    return { killed, foreign };
  }

  private async waitForPortRelease(port: number, maxAttempts: number = 10): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const inUse = await this.isPortInUse(port);
      if (!inUse) {
        await debugLog('ServerManager', `Port ${port} released after ${attempt + 1} attempts`);
        return true;
      }

      const delay = Math.min(100 * Math.pow(2, attempt), 3000);
      await debugLog('ServerManager', `Port ${port} still in use, waiting ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    await debugLog('ServerManager', `Port ${port} still in use after ${maxAttempts} attempts`);
    return false;
  }

  /**
   * A running NativeRunner has already opened its stdout/stderr file
   * descriptors against the current root (NativeRunner.start()) - an
   * OS-level fact no relocation can redirect. Registering this for as long
   * as the server is tracked as running turns a relocation attempt into a
   * rejection instead of a server silently logging into a directory nothing
   * else points at any more.
   */
  private registerRunningServerVeto(serverId: string): void {
    registerRootBound({
      name: rootBoundServerName(serverId),
      rebind: () => {}, // unreachable: this resource's own veto blocks every relocation while registered
      veto: () => `managed server "${serverId}" is running and its log files cannot follow a relocated root`,
    });
  }

  /**
   * Re-read local server records from the relocated root. `getServersFilePath`
   * resolves through `getOutputPath`, so the map built at startup describes
   * the previous root once the root moves; a list served from it names servers
   * belonging to a directory nothing points at any more, and the next
   * `saveState` writes those records into the new root's file. Every running
   * server vetoes the relocation, so no local entry dropped here owns a live
   * process. Global records live under ~/.devharness and stay put.
   */
  private async rebindToRoot(): Promise<void> {
    for (const [serverId, managed] of [...this.servers]) {
      if (managed.global) continue;
      this.stopWatcher(managed);
      unregisterRootBound(rootBoundServerName(serverId));
      this.pendingStartups.delete(serverId);
      this.servers.delete(serverId);
    }

    // Monitored ports are local-scope state (doSaveState writes them to the
    // local file only), so they belong to the root that just went away.
    await this.getPortMonitor().stopAll();

    const persisted = await this.loadState(false);

    for (const server of persisted.servers) {
      const runner = createRunner(server.type || 'native', server.id);
      runner.restore(server);
      this.servers.set(server.id, {
        id: server.id,
        runner,
        autoRun: server.autoRun,
        monitorPort: server.monitorPort,
        global: false,
        watch: server.watch,
        watchPaths: server.watchPaths,
      });

      // A record under this root can name a process another session started
      // and left running; its log fds pin this root exactly as a server
      // started here does, so it takes the same veto.
      if (await runner.isRunning()) {
        this.registerRunningServerVeto(server.id);
      }
    }

    for (const pending of persisted.pendingStartups) {
      if (!this.servers.has(pending.serverId)) continue;
      this.pendingStartups.set(pending.serverId, {
        serverId: pending.serverId,
        startedAt: new Date(pending.startedAt),
        timeoutAt: new Date(pending.timeoutAt),
        acknowledged: pending.acknowledged,
        reason: pending.reason,
      });
    }

    if (persisted.monitoredPorts.length > 0) {
      await this.getPortMonitor().restoreFromState(persisted.monitoredPorts);
    }
  }

  /**
   * Start a server
   */
  async startServer(options: StartServerOptions): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string; autoRestartWarning?: string }> {
    const { command, cwd, id: serverId, autoRun, env, port, monitorPort, global: isGlobal, watch, watchPaths, clearLogs } = options;

    // Validate server ID for security (prevents command injection via container names)
    validateServerId(serverId);

    // Auto-detect runner type if not specified
    const runnerType = options.runner ?? detectRunnerType(command);

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Check if already running
    const existing = this.servers.get(serverId);
    if (existing) {
      const isRunning = await existing.runner.isRunning();
      if (isRunning) {
        throw new Error(`Server "${serverId}" is already running. Stop it first or use restart.`);
      }
      this.servers.delete(serverId);
    }

    // Check port availability
    const existingStatus = existing ? await existing.runner.getStatus() : null;
    const portToCheck = port || existingStatus?.port;
    if (portToCheck) {
      const inUse = await this.isPortInUse(portToCheck);
      if (inUse) {
        throw new Error(`Port ${portToCheck} is already in use.`);
      }
    }

    await debugLog('ServerManager', `Starting server: ${command} (runner: ${runnerType}, global: ${isGlobal ?? false})`);

    // Create and start runner
    const runner = createRunner(runnerType, serverId);

    // Set global flag on native runner for log storage location
    if (runner instanceof NativeRunner) {
      runner.setGlobal(isGlobal ?? false);
    }

    const result = await runner.start({ command, cwd, id: serverId, env, port, clearLogs });

    const resolvedWatchPaths = watchPaths && watchPaths.length > 0 ? watchPaths : [cwd];
    const managed: ManagedServer = {
      id: serverId,
      runner,
      autoRun: autoRun ?? false,
      monitorPort: monitorPort ?? true, // Default to monitoring server port
      global: isGlobal ?? false,
      watch: watch ?? false,
      watchPaths: resolvedWatchPaths,
    };
    this.servers.set(serverId, managed);
    this.registerRunningServerVeto(serverId);

    if (watch) {
      this.startWatcher(managed, resolvedWatchPaths);
    }

    const autoRestartMatch = detectAutoRestartCommand(command);
    if (autoRestartMatch) {
      await debugLog('ServerManager', `Server ${serverId} command looks auto-restarting (matched: ${autoRestartMatch}) - flagging as risky to pair with an attached breakpoint debugger`);
    }

    // Create pending startup entry for timeout tracking
    const now = new Date();
    const timeoutMs = 30000; // 30 seconds
    this.pendingStartups.set(serverId, {
      serverId,
      startedAt: now,
      timeoutAt: new Date(now.getTime() + timeoutMs),
      acknowledged: false,
    });

    // Start port detection in background
    this.detectPortInBackgroundWithTimeout(serverId, timeoutMs);

    await this.saveState();

    // Starting a server is what makes this session its owner. Without a claim
    // nothing can tell it apart from a server another window is using, so
    // nobody may ever stop it (issue #139).
    await this.claims.claim(serverId, cwd, isGlobal ?? false);

    await debugLog('ServerManager', `Server started: ${serverId} (${runnerType}, PID: ${result.pid})`);

    let autoRestartWarning: string | undefined;
    if (autoRestartMatch && watch) {
      autoRestartWarning = `Command matches "${autoRestartMatch}" AND devharness' own watch mode is also enabled for this server - that's redundant and risky, since both could try to restart the process at once. Recommend removing "${autoRestartMatch}" from the command and relying on devharness' watch mode instead, which already coordinates safely with an attached breakpoint debugger.`;
    } else if (autoRestartMatch) {
      autoRestartWarning = `Command matches "${autoRestartMatch}", which auto-restarts its own process on file changes. Attaching a CDP debugger and pausing at a breakpoint while this is running is a known-bad combination (can cause EADDRINUSE crash-loops and ambiguous failed-but-still-listening states) - the restart happens entirely outside anything devharness tracks. Prefer disabling auto-restart and using devharness' own watch mode instead (server({ action: 'start', watch: true })), which coordinates safely with a paused debugger, or call server({ action: 'restart' }) explicitly.`;
    }

    return {
      id: serverId,
      pid: result.pid,
      runnerType,
      containerId: result.containerId,
      autoRestartWarning,
    };
  }

  /**
   * Background port detection with timeout management
   * @param serverId The server to detect port for
   * @param timeoutMs How long to wait before triggering blocking (default 30s)
   */
  private async detectPortInBackgroundWithTimeout(serverId: string, timeoutMs: number = 30000): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) return;

    const iterations = Math.ceil(timeoutMs / 1000);
    const checkInterval = 1000; // Check every second

    for (let i = 0; i < iterations; i++) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));

      const current = this.servers.get(serverId);
      if (!current) {
        // Server was removed, clean up pending state
        this.pendingStartups.delete(serverId);
        await this.saveState();
        break;
      }

      // Check if server is still running
      const isRunning = await current.runner.isRunning();
      if (!isRunning) {
        // Server died during startup - trigger blocking
        const pending = this.pendingStartups.get(serverId);
        if (pending) {
          pending.reason = 'died';
          pending.acknowledged = false;
          await this.saveState();
          await debugLog('ServerManager', `Server died during startup: ${serverId}`);
        }
        return; // Exit detection, blocking will be triggered by getPendingStartupFailures
      }

      // Check if port already in status
      const status = await current.runner.getStatus();
      if (status.port) {
        // Port already detected - remove from pending and set up monitoring
        this.pendingStartups.delete(serverId);
        if (current.monitorPort && !this.getPortMonitor().isMonitoring(status.port)) {
          await this.getPortMonitor().startMonitoring(
            status.port,
            'block',
            `Server: ${serverId}`
          );
          await debugLog('ServerManager', `Auto-started monitoring for port ${status.port}`);
        }
        await this.saveState();
        return;
      }

      // Try to detect port from logs
      const port = await current.runner.detectPort();
      if (port) {
        // Port detected - remove from pending and set up monitoring
        this.pendingStartups.delete(serverId);
        await debugLog('ServerManager', `Detected port ${port} for ${serverId}`);

        if (current.monitorPort && !this.getPortMonitor().isMonitoring(port)) {
          await this.getPortMonitor().startMonitoring(
            port,
            'block',
            `Server: ${serverId}`
          );
          await debugLog('ServerManager', `Auto-started monitoring for port ${port}`);
        }
        await this.saveState();
        return;
      }
    }

    // Timeout reached without port detection - trigger blocking
    const pending = this.pendingStartups.get(serverId);
    if (pending && !pending.reason) {
      pending.reason = 'timeout';
      pending.acknowledged = false;
      await this.saveState();
      await debugLog('ServerManager', `Port detection timeout for ${serverId}`);
    }
  }

  /**
   * @deprecated Use detectPortInBackgroundWithTimeout instead
   */
  private async detectPortInBackground(serverId: string): Promise<void> {
    await this.detectPortInBackgroundWithTimeout(serverId, 30000);
  }

  // ============================================================================
  // Pending Startup Management
  // ============================================================================

  /**
   * Get pending startup failures that should trigger blocking
   * Returns only startups that have timed out or died and are not acknowledged
   */
  getPendingStartupFailures(): PendingStartupFailureInfo[] {
    const failures: PendingStartupFailureInfo[] = [];

    for (const [, pending] of this.pendingStartups) {
      // Only return failures (has reason) that are not acknowledged
      if (pending.reason && !pending.acknowledged) {
        failures.push({
          serverId: pending.serverId,
          startedAt: pending.startedAt,
          reason: pending.reason,
        });
      }
    }

    return failures;
  }

  /**
   * Check if a server has a pending startup (regardless of state)
   */
  hasPendingStartup(serverId: string): boolean {
    return this.pendingStartups.has(serverId);
  }

  /**
   * Get pending startup status for a server
   */
  getPendingStartup(serverId: string): PendingStartup | undefined {
    return this.pendingStartups.get(serverId);
  }

  /**
   * Acknowledge a pending startup failure
   * Clears the blocking state and starts background health monitoring
   */
  async acknowledgeStartup(serverId: string): Promise<boolean> {
    const pending = this.pendingStartups.get(serverId);
    if (!pending) {
      return false;
    }

    // Clear pending state - no longer blocking
    this.pendingStartups.delete(serverId);
    await this.saveState();
    await debugLog('ServerManager', `Acknowledged pending startup: ${serverId}`);

    // A server that is already dead has nothing left to watch: the health
    // check would just re-create the same block on its next tick, so the
    // acknowledgement could never stick. Only arm it for a live server, where
    // it can still find the port (or catch a later death).
    const managed = this.servers.get(serverId);
    const isRunning = managed ? await managed.runner.isRunning() : false;
    if (!isRunning) {
      await debugLog('ServerManager', `Server ${serverId} is not running - skipping health monitor after acknowledgment`);
      return true;
    }

    // Start background health monitoring
    // This will detect port (and set up monitoring) or detect server death (and re-block)
    this.monitorServerHealth(serverId);

    return true;
  }

  /**
   * Monitor server health after acknowledgment
   * Checks every 5 seconds for:
   * - Port detection (sets up port monitoring when found)
   * - Server death (re-triggers blocking)
   * Runs until port is found, server dies, or server is removed
   */
  private async monitorServerHealth(serverId: string): Promise<void> {
    const checkInterval = 5000; // Check every 5 seconds

    while (true) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));

      const managed = this.servers.get(serverId);
      if (!managed) {
        // Server was removed - clean exit
        return;
      }

      // Check if server is still running
      const isRunning = await managed.runner.isRunning();
      if (!isRunning) {
        // Server died - create blocking entry
        const now = new Date();
        this.pendingStartups.set(serverId, {
          serverId,
          startedAt: now,
          timeoutAt: now,
          acknowledged: false,
          reason: 'died',
        });
        await this.saveState();
        await debugLog('ServerManager', `Server died (health check): ${serverId}`);
        return;
      }

      // Try to detect port if not already monitoring
      const status = await managed.runner.getStatus();
      let port: number | undefined = status.port ?? undefined;

      if (!port) {
        port = (await managed.runner.detectPort()) ?? undefined;
      }

      if (port && managed.monitorPort && !this.getPortMonitor().isMonitoring(port)) {
        // Port found - set up monitoring, then port monitor takes over
        await this.getPortMonitor().startMonitoring(
          port,
          'block',
          `Server: ${serverId}`
        );
        await debugLog('ServerManager', `Health check found port ${port} - monitoring started for ${serverId}`);
        await this.saveState();
        return; // Port monitor will handle it from here
      }

      // If port is being monitored, we can stop health checking
      if (port && this.getPortMonitor().isMonitoring(port)) {
        await debugLog('ServerManager', `Port ${port} already monitored, stopping health check for ${serverId}`);
        return;
      }
    }
  }

  /**
   * Extend the startup timeout by another 30 seconds
   * Resets the acknowledged flag and reason, resumes detection
   */
  async extendStartupTimeout(serverId: string): Promise<boolean> {
    const pending = this.pendingStartups.get(serverId);
    if (!pending) {
      return false;
    }

    // Check if server is still running
    const managed = this.servers.get(serverId);
    if (!managed) {
      return false;
    }

    const isRunning = await managed.runner.isRunning();
    if (!isRunning) {
      // Server died, can't extend
      pending.reason = 'died';
      pending.acknowledged = false;
      await this.saveState();
      return false;
    }

    // Reset timeout
    const now = new Date();
    const timeoutMs = 30000;
    pending.timeoutAt = new Date(now.getTime() + timeoutMs);
    pending.acknowledged = false;
    pending.reason = undefined;

    await this.saveState();
    await debugLog('ServerManager', `Extended startup timeout for ${serverId}`);

    // Resume background detection
    this.detectPortInBackgroundWithTimeout(serverId, timeoutMs);

    return true;
  }

  /**
   * Remove pending startup entry (called when server is stopped or removed)
   */
  private removePendingStartup(serverId: string): void {
    this.pendingStartups.delete(serverId);
  }

  /**
   * Stop a server
   */
  async stopServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found. Use list action to see servers.`);
    }

    // Clean up pending startup state
    this.removePendingStartup(serverId);

    // Stop watching and drop any queued/in-flight watch-restart state - a
    // leaked watcher could otherwise fire a restart on an already-stopped
    // server.
    this.stopWatcher(managed);

    const isRunning = await managed.runner.isRunning();
    if (!isRunning) {
      unregisterRootBound(rootBoundServerName(serverId));
      await this.stopMonitoringForServer(serverId);
      await this.saveState();
      return;
    }

    await debugLog('ServerManager', `Stopping server ${serverId}`);
    await this.stopMonitoringForServer(serverId);
    await managed.runner.stop();
    // The veto comes off once the child has exited and closed its log fds; a
    // relocation landing before that moves the root under fds still open.
    // A stop that throws leaves it on, since the child may still be running.
    unregisterRootBound(rootBoundServerName(serverId));
    this.claims.release(serverId, managed.global ?? false);
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} stopped`);
  }

  /**
   * Restart a server
   * Reloads config from persisted state to pick up any manual edits (e.g., port changes)
   */
  async restartServer(serverId: string): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    // Reload config from persisted state to pick up any manual edits
    const persistedConfig = await this.reloadServerConfig(serverId);

    // Use persisted config values if available, otherwise fall back to in-memory
    const command = persistedConfig?.command ?? this.getRunnerCommand(managed.runner);
    const cwd = persistedConfig?.cwd ?? this.getRunnerCwd(managed.runner);
    const port = persistedConfig?.port;
    const autoRun = persistedConfig?.autoRun ?? managed.autoRun;
    const monitorPort = persistedConfig?.monitorPort ?? managed.monitorPort;
    const runnerType = persistedConfig?.type ?? managed.runner.type;
    const watch = persistedConfig?.watch ?? managed.watch ?? false;
    const watchPaths = persistedConfig?.watchPaths ?? managed.watchPaths;

    // Get current status for the old port (to clean up if different from new port)
    const currentStatus = await managed.runner.getStatus();
    const oldPort = currentStatus.port;

    await this.stopServer(serverId);

    // Wait for old port to be released (if server was running)
    if (oldPort) {
      let released = await this.waitForPortRelease(oldPort, 3);

      if (!released) {
        // Kill any orphan processes holding the port, but only if they're from the same directory
        const { killed, foreign } = await this.killOrphanProcessesOnPort(oldPort, cwd, currentStatus.pid);

        if (foreign.length > 0 && oldPort === port) {
          // Foreign process on the port we want to use - error
          throw new Error(`Port ${oldPort} is in use by another application (PID: ${foreign.join(', ')}). Stop that process first or use a different port.`);
        }

        if (killed.length > 0) {
          await debugLog('ServerManager', `Killed ${killed.length} orphan process(es) on port ${oldPort}: ${killed.join(', ')}`);
          released = await this.waitForPortRelease(oldPort, 5);
        }
      }

      // Only error if we couldn't release the port AND it's the same port we want to use
      if (!released && oldPort === port) {
        throw new Error(`Port ${oldPort} is still in use after stopping server.`);
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Check if new port (from config) is available
    if (port && port !== oldPort) {
      const newPortInUse = await this.isPortInUse(port);
      if (newPortInUse) {
        const pids = await this.findProcessesOnPort(port);
        throw new Error(`Port ${port} is already in use (PID: ${pids.join(', ')}). Choose a different port.`);
      }
    }

    return await this.startServer({
      command,
      cwd,
      id: serverId,
      autoRun,
      runner: runnerType,
      monitorPort,
      watch,
      watchPaths,
    });
  }

  private getOrCreateWatchState(serverId: string): WatchRestartState {
    let state = this.watchState.get(serverId);
    if (!state) {
      state = { restarting: false, restartQueued: false };
      this.watchState.set(serverId, state);
    }
    return state;
  }

  private startWatcher(managed: ManagedServer, watchPaths: string[]): void {
    managed.watcher?.stop();
    managed.watcher = new ServerFileWatcher({
      paths: watchPaths,
      onChange: () => {
        void this.requestWatchRestart(managed.id);
      },
    });
    managed.watcher.start();
  }

  private stopWatcher(managed: ManagedServer): void {
    managed.watcher?.stop();
    managed.watcher = undefined;
    this.watchState.delete(managed.id);
  }

  /**
   * Single entry point for every watch-triggered restart (file-change,
   * resume-triggered auto-fire, and its own re-entrant re-check once an
   * in-flight restart finishes). Always re-checks pause state fresh rather
   * than trusting a cached value - see issue #88.
   */
  async requestWatchRestart(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      return;
    }
    const state = this.getOrCreateWatchState(serverId);

    if (state.restarting) {
      // Queue one more pass for after the in-flight restart finishes, rather
      // than piggybacking on it - the file that triggered THIS call might not
      // be reflected in whatever the in-flight restart already read from disk.
      state.restartQueued = true;
      return;
    }

    const command = this.getRunnerCommand(managed.runner);
    const inspectorPort = extractInspectorPort(command);
    const isPaused = inspectorPort !== null && this.pauseChecker ? this.pauseChecker(inspectorPort) : false;

    if (isPaused) {
      state.pendingRestart = { queuedAt: new Date() };
      return;
    }

    try {
      await this.performGuardedRestart(serverId);
    } catch (err) {
      await debugLog('ServerManager', `Watch-triggered restart of ${serverId} failed: ${err}`);
    }
  }

  /**
   * Explicit, forced restart (bypasses the pause-check entirely - the caller
   * has already decided to end any paused debug session). Shares the same
   * in-flight guard as requestWatchRestart(): if a watch-triggered restart is
   * already running, piggybacks on its result instead of racing it.
   */
  async forceRestart(serverId: string): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const state = this.getOrCreateWatchState(serverId);
    state.pendingRestart = undefined;
    if (state.restarting && state.inFlight) {
      return state.inFlight;
    }
    return await this.performGuardedRestart(serverId);
  }

  /** Shared restart guard used by both requestWatchRestart() and forceRestart(). */
  private async performGuardedRestart(serverId: string): Promise<{ id: string; pid: number; runnerType: RunnerType; containerId?: string }> {
    const state = this.getOrCreateWatchState(serverId);
    state.restarting = true;
    state.pendingRestart = undefined;
    const promise = this.restartServer(serverId).finally(() => {
      state.restarting = false;
      state.inFlight = undefined;
      if (state.restartQueued) {
        state.restartQueued = false;
        void this.requestWatchRestart(serverId);
      }
    });
    state.inFlight = promise;
    return promise;
  }

  /** For checkBreakpointPause's lookup (via a paused connection's inspector port). */
  getPendingRestartByInspectorPort(port: number): PendingRestartInfo | null {
    const managed = this.findManagedServerByInspectorPortSync(port);
    if (!managed) {
      return null;
    }
    const state = this.watchState.get(managed.id);
    return state?.pendingRestart ? { serverId: managed.id, queuedAt: state.pendingRestart.queuedAt } : null;
  }

  /** Discard a queued watch-restart without performing it - keep debugging. */
  cancelPendingRestart(serverId: string): boolean {
    const state = this.watchState.get(serverId);
    if (!state?.pendingRestart) {
      return false;
    }
    state.pendingRestart = undefined;
    return true;
  }

  /**
   * Re-check a port's pause state and let its queued watch-restart (if any)
   * fire now that the debugger has resumed. Call this after any resume that
   * un-pauses a connection - requestWatchRestart() only re-fires on the next
   * file change otherwise, so without this hook a restart deferred by a
   * pause would sit queued forever if no further edits happen.
   */
  retryPendingRestartByInspectorPort(port: number): void {
    const managed = this.findManagedServerByInspectorPortSync(port);
    if (managed && this.watchState.get(managed.id)?.pendingRestart) {
      void this.requestWatchRestart(managed.id);
    }
  }

  /**
   * Set autoRun flag
   */
  async setAutoRun(serverId: string, autoRun: boolean): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    managed.autoRun = autoRun;
    await this.saveState();
    await debugLog('ServerManager', `Set autoRun=${autoRun} for ${serverId}`);
  }

  /**
   * Get status of servers
   */
  async getStatus(serverId?: string): Promise<ServerStatus[]> {
    const formatUptime = (startedAt: Date): string => {
      const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const getServerStatus = async (managed: ManagedServer): Promise<ServerStatus> => {
      const status = await managed.runner.getStatus();
      return {
        id: managed.id,
        command: this.getRunnerCommand(managed.runner),
        cwd: this.getRunnerCwd(managed.runner),
        pid: status.pid,
        containerId: status.containerId,
        startedAt: status.startedAt ?? new Date(),
        uptime: status.startedAt ? formatUptime(status.startedAt) : '0s',
        port: status.port,
        running: status.running,
        autoRun: managed.autoRun,
        runnerType: managed.runner.type,
        global: managed.global ?? false,
        watch: managed.watch ?? false,
        ...(managed.watch && { watchPaths: managed.watchPaths?.length ? managed.watchPaths : [this.getRunnerCwd(managed.runner)] }),
      };
    };

    if (serverId) {
      const managed = this.servers.get(serverId);
      if (!managed) return [];
      return [await getServerStatus(managed)];
    }

    const results: ServerStatus[] = [];
    for (const managed of this.servers.values()) {
      results.push(await getServerStatus(managed));
    }
    return results;
  }

  /**
   * Get log stats (for native runner only)
   */
  getLogStats(): LogStats[] {
    const stats: LogStats[] = [];

    for (const [serverId, managed] of this.servers) {
      if (managed.runner instanceof NativeRunner) {
        const runnerStats = managed.runner.getLogStats();
        stats.push({
          serverId,
          newStdout: runnerStats.newStdout,
          newStderr: runnerStats.newStderr,
        });
      } else {
        stats.push({
          serverId,
          newStdout: 0,
          newStderr: 0,
        });
      }
    }

    return stats;
  }

  /**
   * Get logs from a server
   */
  async getLogs(serverId: string, options: { type?: 'stdout' | 'stderr' | 'all'; lines?: number; delta?: boolean } = {}): Promise<string[]> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found`);
    }

    const { type = 'all', lines } = options;
    return await managed.runner.getLogs({ type, lines });
  }

  /**
   * Clear logs (native runner only)
   */
  async clearLogs(serverId: string): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found`);
    }

    if (managed.runner instanceof NativeRunner) {
      return await managed.runner.clearLogs();
    }

    throw new Error(`clearLogs is only supported for native runner, not ${managed.runner.type}`);
  }

  /**
   * Get log access info (file paths for native, commands for docker)
   */
  getLogAccess(serverId: string): { type: 'file'; logDir: string; stdoutPath: string; stderrPath: string } | { type: 'command'; command: string } | null {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found`);
    }

    if (managed.runner.getLogAccess) {
      return managed.runner.getLogAccess();
    }

    return null;
  }

  /**
   * Stop every server this session owns outright - one no live session other
   * than this one claims. Used when the session is going away for good (an
   * idle suspend, or a client that closed), which is the only time it is safe
   * to take a dev server down.
   *
   * A server another window is still using is left alone, and so is one whose
   * ownership cannot be established: over-stopping destroys running work,
   * under-stopping leaves a process for the next `initialize()` to collect.
   */
  async stopOwnedServers(): Promise<{ stopped: string[]; keptForOthers: string[] }> {
    const stopped: string[] = [];
    const keptForOthers: string[] = [];

    for (const [serverId, managed] of this.servers) {
      const isGlobal = managed.global ?? false;
      try {
        if (!(await managed.runner.isRunning())) continue;

        const serverCwd = this.getRunnerCwd(managed.runner) ?? process.cwd();
        if (!this.claims.mayStop(serverId, serverCwd, isGlobal)) {
          keptForOthers.push(serverId);
          // Drop only OUR claim: the server keeps running for whoever else
          // holds one, and stays collectable once they are gone too.
          this.claims.release(serverId, isGlobal);
          continue;
        }

        await this.stopServer(serverId);
        stopped.push(serverId);
      } catch (error) {
        await debugLog('ServerManager', `Failed to release ${serverId}: ${error}`);
        keptForOthers.push(serverId);
      }
    }

    return { stopped, keptForOthers };
  }

  /**
   * Server ids whose every claim was dead, per storage scope, with those dead
   * claims deleted as a side effect.
   *
   * Must be read BEFORE this session claims anything during recovery -
   * otherwise our own fresh claim makes an orphan look owned, and nothing is
   * ever collected.
   *
   * A server with no claim file at all is absent from this: it predates
   * claims, or was started outside devharness, and neither is ours to kill.
   */
  private findAbandonedServerIds(): Map<boolean, Set<string>> {
    const byScope = new Map<boolean, Set<string>>();
    for (const isGlobal of [false, true]) {
      const { removed, unclaimedServerIds } = this.claims.collectDeadClaims(isGlobal);
      if (removed > 0) {
        void debugLog('ServerClaims', `Removed ${removed} dead claim(s) (global=${isGlobal})`);
      }
      byScope.set(isGlobal, new Set(unclaimedServerIds));
    }
    return byScope;
  }

  /**
   * Stop all servers
   */
  async stopAll(): Promise<string[]> {
    const stopped: string[] = [];
    for (const serverId of this.servers.keys()) {
      try {
        await this.stopServer(serverId);
        stopped.push(serverId);
      } catch (error) {
        await debugLog('ServerManager', `Failed to stop ${serverId}: ${error}`);
      }
    }
    return stopped;
  }

  /**
   * Remove a server from config
   */
  async removeServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (!managed) {
      throw new Error(`Server "${serverId}" not found.`);
    }

    const isRunning = await managed.runner.isRunning();
    if (isRunning) {
      await this.stopServer(serverId);
    } else {
      // stopServer() (which also closes the watcher and drops the relocation
      // veto) is only called above when running - make sure a leaked
      // watcher/veto/pending state can't outlive removal either way.
      this.stopWatcher(managed);
      unregisterRootBound(rootBoundServerName(serverId));
    }

    // stopServer() already drops this server's port monitors when it runs, but
    // removal has to cover the not-running path too - an orphaned block-level
    // monitor on a port nobody owns any more gates every later tool call.
    await this.stopMonitoringForServer(serverId);

    this.servers.delete(serverId);
    await this.saveState();
    await debugLog('ServerManager', `Server ${serverId} removed from config`);
  }

  /**
   * Stop monitoring every port that belongs to a server.
   *
   * Ports are matched by the `Server: <id>` description the manager stamps on
   * them at startMonitoring() time, plus the runner's currently reported port,
   * so a monitor survives neither a stop nor a remove.
   */
  private async stopMonitoringForServer(serverId: string): Promise<void> {
    const portMonitor = this.getPortMonitor();
    const ports = new Set<number>();

    for (const monitored of portMonitor.getStatus()) {
      if (monitored.description === `Server: ${serverId}`) {
        ports.add(monitored.port);
      }
    }

    const managed = this.servers.get(serverId);
    if (managed) {
      try {
        const status = await managed.runner.getStatus();
        if (status.port) {
          ports.add(status.port);
        }
      } catch {
        // Runner can't report a port (already gone) - description match stands.
      }
    }

    for (const port of ports) {
      if (await portMonitor.stopMonitoring(port)) {
        await debugLog('ServerManager', `Stopped monitoring port ${port} (owned by ${serverId})`);
      }
    }
  }

  /**
   * Get running server IDs
   */
  async getRunningServerIds(): Promise<string[]> {
    const running: string[] = [];
    for (const [id, managed] of this.servers) {
      if (await managed.runner.isRunning()) {
        running.push(id);
      }
    }
    return running;
  }

  /**
   * Cleanup - refresh status of all servers (no longer removes stopped servers)
   * Stopped servers remain in config and can be manually restarted
   */
  async cleanup(): Promise<number> {
    // Pick up servers another session started after this one loaded its state.
    // Without this a second editor window can neither see nor stop them - its
    // map was built once at startup - and, more importantly, it never claims
    // them, so it has no say in whether they are collected.
    await this.adoptNewlyPersistedServers();

    // Servers are only removed via the explicit 'remove' action
    return 0;
  }

  /**
   * Add running servers that appeared in persisted state since this session
   * loaded, claiming each one: seeing a server is enough to depend on it.
   */
  private async adoptNewlyPersistedServers(): Promise<void> {
    let persisted: Array<PersistedRunnerState & { global: boolean }>;
    try {
      const [local, global] = await Promise.all([this.loadState(false), this.loadState(true)]);
      persisted = [
        ...local.servers.map(server => ({ ...server, global: false })),
        ...global.servers.map(server => ({ ...server, global: true })),
      ];
    } catch {
      return; // Unreadable state is not worth failing a list over.
    }

    for (const server of persisted) {
      if (this.servers.has(server.id)) continue;

      try {
        const runner = createRunner(server.type || 'native', server.id);
        runner.restore(server);
        if (!(await runner.isRunning())) continue;

        this.servers.set(server.id, {
          id: server.id,
          runner,
          autoRun: server.autoRun,
          monitorPort: server.monitorPort,
          global: server.global,
          watch: server.watch,
          watchPaths: server.watchPaths,
        });
        this.registerRunningServerVeto(server.id);
        await this.claims.claim(server.id, server.cwd, server.global);
        await debugLog('ServerManager', `Adopted server started elsewhere: ${server.id}`);
      } catch (error) {
        await debugLog('ServerManager', `Could not adopt ${server.id}: ${error}`);
      }
    }
  }

  /** The entry saved for `serverId` in the local or global servers.json, or null. */
  async savedServer(serverId: string): Promise<PersistedRunnerState | null> {
    return this.reloadServerConfig(serverId);
  }

  /**
   * Reload a server's config from persisted state (for picking up manual edits)
   */
  private async reloadServerConfig(serverId: string): Promise<PersistedRunnerState | null> {
    const localPersisted = await this.loadState(false);
    const globalPersisted = await this.loadState(true);

    const allServers = [
      ...localPersisted.servers.map(s => ({ ...s, global: false })),
      ...globalPersisted.servers.map(s => ({ ...s, global: true })),
    ];

    return allServers.find(s => s.id === serverId) || null;
  }
}
