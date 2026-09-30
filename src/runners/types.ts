/**
 * Runner Types
 * Common interfaces and types for process runners (native, docker, docker-compose, etc.)
 */

export type RunnerType = 'native' | 'docker' | 'docker-compose';

export interface RunnerStartOptions {
  command: string;
  cwd: string;
  id: string;
  env?: Record<string, string>;
  port?: number;
  /** Empty the log files before this start writes to them (native runner; docker reads its logs from docker). */
  clearLogs?: boolean;
}

export interface RunnerStartResult {
  /** Process ID (for native) or container ID (for docker) */
  pid: number;
  /** Container ID for docker runners */
  containerId?: string;
  /** Detected port, if any */
  port?: number;
}

export interface RunnerStopOptions {
  /** Timeout in ms before force kill */
  timeout?: number;
}

export interface RunnerLogOptions {
  type?: 'stdout' | 'stderr' | 'all';
  lines?: number;
  /** For native runner: return lines since cursor */
  since?: number;
  /** Follow mode (tail -f style) - not implemented yet */
  follow?: boolean;
}

export interface RunnerStatus {
  running: boolean;
  pid: number;
  /**
   * When the OS says `pid` started, so a recycled pid cannot pass for the
   * server that used to hold it. Empty when unreadable; see
   * PROCESS IDENTITY in native-runner.ts.
   */
  pidStartedAt?: string;
  containerId?: string;
  port?: number;
  startedAt?: Date;
  /** Additional status info from docker inspect, etc. */
  details?: Record<string, unknown>;
}

/**
 * Runner interface - abstraction over different process models
 */
export interface Runner {
  readonly type: RunnerType;

  /**
   * Start the process/container
   */
  start(options: RunnerStartOptions): Promise<RunnerStartResult>;

  /**
   * Stop the process/container
   */
  stop(options?: RunnerStopOptions): Promise<void>;

  /**
   * Check if process/container is running
   */
  isRunning(): Promise<boolean>;

  /**
   * Get current status
   */
  getStatus(): Promise<RunnerStatus>;

  /**
   * Get logs from the process/container
   */
  getLogs(options?: RunnerLogOptions): Promise<string[]>;

  /**
   * Detect port from logs or container inspection
   */
  detectPort(): Promise<number | null>;

  /**
   * Clean up resources (close file handles, etc.)
   */
  cleanup(): Promise<void>;

  /**
   * Restore state from persisted data (for recovery after MCP restart)
   */
  restore(data: PersistedRunnerState): void;

  /**
   * Get the command used to start this runner
   */
  getCommand(): string;

  /**
   * Get the working directory for this runner
   */
  getCwd(): string;

  /**
   * Clear logs (optional - only native runner supports this)
   */
  clearLogs?(): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }>;

  /**
   * Get log access info - file paths for native runner, command for docker
   */
  getLogAccess?(): { type: 'file'; logDir: string; stdoutPath: string; stderrPath: string } | { type: 'command'; command: string };
}

/**
 * Runner state that can be persisted and restored
 */
export interface PersistedRunnerState {
  type: RunnerType;
  id: string;
  command: string;
  cwd: string;
  pid: number;
  /**
   * When the OS says `pid` started. A pid alone cannot be trusted across a
   * restart: a crashed server leaves its pid here, and once the OS recycles
   * that number the dead server reads as running. See PROCESS IDENTITY in
   * native-runner.ts. Absent for records written before this existed, which
   * are treated as unverifiable rather than dead.
   */
  pidStartedAt?: string;
  containerId?: string;
  port?: number;
  autoRun: boolean;
  startedAt: string;
  monitorPort?: boolean;
  /** Whether this server is stored in global ~/.devharness/ */
  global?: boolean;
  /** Whether devharness watches this server's files and auto-restarts it on change */
  watch?: boolean;
  /** Paths to watch when `watch` is true (default: [cwd]) */
  watchPaths?: string[];
}

/**
 * Auto-detect runner type from command string
 */
export function detectRunnerType(command: string): RunnerType {
  const trimmed = command.trim().toLowerCase();

  // Docker Compose patterns
  if (
    trimmed.startsWith('docker-compose ') ||
    trimmed.startsWith('docker compose ') ||
    /^docker\s+compose\s+/.test(trimmed)
  ) {
    return 'docker-compose';
  }

  // Docker patterns
  if (
    trimmed.startsWith('docker run ') ||
    trimmed.startsWith('docker start ') ||
    /^docker\s+run\s+/.test(trimmed)
  ) {
    return 'docker';
  }

  // Default to native
  return 'native';
}
