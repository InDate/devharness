/**
 * Native Runner
 * Runs processes directly using Node.js spawn (the original behavior)
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../debug-logger.js';
import { getOutputPath } from '../helpers/paths.js';
import { readProcessStartTime } from '../server-claims.js';
import type {
  Runner,
  RunnerType,
  RunnerStartOptions,
  RunnerStartResult,
  RunnerStopOptions,
  RunnerLogOptions,
  RunnerStatus,
  PersistedRunnerState,
} from './types.js';

export class NativeRunner implements Runner {
  readonly type: RunnerType = 'native';

  private id: string;
  private command: string = '';
  private cwd: string = '';
  private process: ChildProcess | null = null;
  private pid: number = -1;
  private port: number | null = null;
  private startedAt: Date | null = null;
  /** OS-reported start time of `pid`, to detect a recycled pid. */
  private pidStartedAt: string = '';
  private logCursor = { stdout: 0, stderr: 0 };
  /**
   * Separate from logCursor so the status line reports the change since the
   * last tool call, and a later log read still returns everything unread.
   */
  private statusCursor = { stdout: 0, stderr: 0 };
  private global: boolean = false;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Set whether this runner uses global storage
   */
  setGlobal(global: boolean): void {
    this.global = global;
  }

  /**
   * Restore state from persisted data (for recovery)
   */
  restore(data: PersistedRunnerState): void {
    this.command = data.command;
    this.cwd = data.cwd;
    this.pid = data.pid;
    this.pidStartedAt = data.pidStartedAt ?? '';
    this.port = data.port ?? null;
    this.startedAt = new Date(data.startedAt);
    this.global = data.global ?? false;
    this.process = null; // Attached, not owned
  }

  private getLogDir(): string {
    return getOutputPath('logs', this.id, { global: this.global });
  }

  private getStdoutLogPath(): string {
    return path.join(this.getLogDir(), 'stdout.log');
  }

  private getStderrLogPath(): string {
    return path.join(this.getLogDir(), 'stderr.log');
  }

  private async ensureLogDir(): Promise<void> {
    const dir = this.getLogDir();
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /**
   * PROCESS IDENTITY
   *
   * `kill(pid, 0)` only answers "is some process wearing this number", which
   * is not the same question. A dev server that crashed leaves its pid behind
   * in servers.json, and once the OS recycles that number the dead server
   * reads as running: it gets recovered instead of restarted, autoRun never
   * fires, and `server list` reports a corpse as live.
   *
   * So a pid recovered from disk is only trusted when the OS still reports the
   * same start time for it. An unreadable start time on either side cannot
   * disprove anything, so it counts as alive - the cost of being wrong that way
   * is a server we decline to touch, rather than one we wrongly declare dead.
   */
  private isProcessRunning(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      // EPERM means it exists but belongs to another user - still running.
      if (err?.code !== 'EPERM') return false;
    }

    if (!this.pidStartedAt) return true;
    const currentStart = readProcessStartTime(pid);
    if (!currentStart) return true;
    return currentStart === this.pidStartedAt;
  }

  private detectPortFromLine(line: string): number | null {
    const patterns = [
      /(?:port|listening on|localhost:|127\.0\.0\.1:)\s*(\d{4,5})/i,
      /http:\/\/(?:localhost|127\.0\.0\.1):(\d{4,5})/i,
      /Local:\s*http:\/\/[^:]+:(\d{4,5})/i,
      /ready on\s+.*:(\d{4,5})/i,
      /->\s*http:\/\/[^:]+:(\d{4,5})/i,
      /server.*running.*:(\d{4,5})/i,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  async start(options: RunnerStartOptions): Promise<RunnerStartResult> {
    const { command, cwd, env } = options;

    this.command = command;
    this.cwd = cwd;

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    await debugLog('NativeRunner', `Starting: ${command} in ${cwd}`);

    // Ensure log directory exists
    await this.ensureLogDir();

    // Open log files for writing
    const stdoutPath = this.getStdoutLogPath();
    const stderrPath = this.getStderrLogPath();

    // Add restart marker to logs
    const timestamp = new Date().toISOString();
    const marker = `\n--- Server ${this.id} started at ${timestamp} ---\n`;
    await fs.promises.appendFile(stdoutPath, marker, 'utf-8');
    await fs.promises.appendFile(stderrPath, marker, 'utf-8');

    const stdoutFd = fs.openSync(stdoutPath, 'a');
    const stderrFd = fs.openSync(stderrPath, 'a');

    // Spawn with stdio redirected to files
    const serverProcess = spawn(command, [], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', stdoutFd, stderrFd],
      shell: true,
      detached: true,
    });

    // Close file descriptors in parent process
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    const pid = serverProcess.pid || -1;
    if (pid === -1) {
      throw new Error('Failed to spawn server process');
    }

    // Unref so parent can exit independently
    serverProcess.unref();

    this.process = serverProcess;
    this.pid = pid;
    this.pidStartedAt = readProcessStartTime(pid);
    this.startedAt = new Date();
    this.logCursor = { stdout: 0, stderr: 0 };
    this.statusCursor = { stdout: 0, stderr: 0 };

    await debugLog('NativeRunner', `Started: ${this.id} (PID: ${pid})`);

    return { pid };
  }

  async stop(options?: RunnerStopOptions): Promise<void> {
    const timeout = options?.timeout ?? 3000;

    if (!this.isProcessRunning(this.pid)) {
      this.pid = -1;
      this.pidStartedAt = '';
      this.process = null;
      return;
    }

    await debugLog('NativeRunner', `Stopping ${this.id} (PID: ${this.pid})`);

    // Kill process group
    try {
      process.kill(-this.pid, 'SIGTERM');
      await debugLog('NativeRunner', `Sent SIGTERM to process group -${this.pid}`);
    } catch (err) {
      await debugLog('NativeRunner', `Process group kill failed, trying single process: ${err}`);
      try {
        process.kill(this.pid, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    // Wait for exit or force kill
    await new Promise<void>((resolve) => {
      const checkDead = () => {
        if (!this.isProcessRunning(this.pid)) {
          resolve();
          return true;
        }
        return false;
      };

      if (checkDead()) return;

      const timeoutId = setTimeout(async () => {
        clearInterval(interval);
        if (this.isProcessRunning(this.pid)) {
          await debugLog('NativeRunner', `${this.id} didn't exit gracefully, sending SIGKILL`);
          try {
            process.kill(-this.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(this.pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
        }
        resolve();
      }, timeout);

      const interval = setInterval(() => {
        if (checkDead()) {
          clearTimeout(timeoutId);
          clearInterval(interval);
        }
      }, 100);
    });

    this.pid = -1;
    this.pidStartedAt = '';
    this.process = null;
    await debugLog('NativeRunner', `Stopped ${this.id}`);
  }

  async isRunning(): Promise<boolean> {
    return this.isProcessRunning(this.pid);
  }

  async getStatus(): Promise<RunnerStatus> {
    const running = this.isProcessRunning(this.pid);

    // A pid that no longer names this server is worse than no pid at all: it
    // is what gets persisted to servers.json, shown in `server list`, and read
    // back by the next session. Forget it the moment we know it is stale, so
    // the recorded state stops pointing at a process that isn't there.
    if (!running && this.pid > 0) {
      void debugLog('NativeRunner', `${this.id} is no longer running as PID ${this.pid}; clearing it`);
      this.pid = -1;
      this.pidStartedAt = '';
    }

    return {
      running,
      pid: this.pid,
      pidStartedAt: this.pidStartedAt || undefined,
      port: this.port ?? undefined,
      startedAt: this.startedAt ?? undefined,
    };
  }

  async getLogs(options?: RunnerLogOptions): Promise<string[]> {
    const { type = 'all', lines, since } = options ?? {};

    const readLogFile = (filePath: string, cursorPos: number): string[] => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n').filter(l => l.length > 0);

        if (lines !== undefined) {
          return allLines.slice(-lines);
        } else if (since !== undefined) {
          return allLines.slice(since);
        } else {
          // Delta mode - return lines since cursor
          return allLines.slice(cursorPos);
        }
      } catch {
        return [];
      }
    };

    let result: string[] = [];

    if (type === 'stdout' || type === 'all') {
      const stdoutLogs = readLogFile(this.getStdoutLogPath(), this.logCursor.stdout);
      result = result.concat(stdoutLogs.map(l => type === 'all' ? `[out] ${l}` : l));
    }

    if (type === 'stderr' || type === 'all') {
      const stderrLogs = readLogFile(this.getStderrLogPath(), this.logCursor.stderr);
      result = result.concat(stderrLogs.map(l => type === 'all' ? `[err] ${l}` : l));
    }

    // Update cursor if delta mode
    if (lines === undefined && since === undefined) {
      this.logCursor.stdout = this.countFileLines(this.getStdoutLogPath());
      this.logCursor.stderr = this.countFileLines(this.getStderrLogPath());
    }

    return result;
  }

  private countFileLines(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter(l => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  async detectPort(): Promise<number | null> {
    // Always scan logs for the latest port (in case server picked a different port on restart)
    for (const logPath of [this.getStdoutLogPath(), this.getStderrLogPath()]) {
      try {
        if (fs.existsSync(logPath)) {
          const content = await fs.promises.readFile(logPath, 'utf-8');
          // Scan from the end to find the most recent port
          const lines = content.split('\n').reverse();
          for (const line of lines) {
            const port = this.detectPortFromLine(line);
            if (port) {
              this.port = port;
              return port;
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return this.port;
  }

  async cleanup(): Promise<void> {
    // Nothing special to clean up for native runner
  }

  /**
   * Initialize cursor to end of file (for recovered servers)
   */
  async initializeCursorToEOF(): Promise<void> {
    this.logCursor.stdout = this.countFileLines(this.getStdoutLogPath());
    this.logCursor.stderr = this.countFileLines(this.getStderrLogPath());
  }

  /**
   * Clear log files
   */
  async clearLogs(): Promise<{ logDir: string; stdoutPath: string; stderrPath: string }> {
    const logDir = this.getLogDir();
    const stdoutPath = this.getStdoutLogPath();
    const stderrPath = this.getStderrLogPath();

    await fs.promises.writeFile(stdoutPath, '', 'utf-8');
    await fs.promises.writeFile(stderrPath, '', 'utf-8');

    this.logCursor = { stdout: 0, stderr: 0 };
    this.statusCursor = { stdout: 0, stderr: 0 };

    return { logDir, stdoutPath, stderrPath };
  }

  /**
   * Get log access info
   */
  getLogAccess(): { type: 'file'; logDir: string; stdoutPath: string; stderrPath: string } {
    return {
      type: 'file',
      logDir: this.getLogDir(),
      stdoutPath: this.getStdoutLogPath(),
      stderrPath: this.getStderrLogPath(),
    };
  }

  /**
   * Get log stats for status line
   */
  getLogStats(): { newStdout: number; newStderr: number } {
    const stdoutLines = this.countFileLines(this.getStdoutLogPath());
    const stderrLines = this.countFileLines(this.getStderrLogPath());

    const stats = {
      newStdout: Math.max(0, stdoutLines - this.statusCursor.stdout),
      newStderr: Math.max(0, stderrLines - this.statusCursor.stderr),
    };
    this.statusCursor = { stdout: stdoutLines, stderr: stderrLines };
    return stats;
  }

  /** Getters for state persistence */
  getId(): string { return this.id; }
  getCommand(): string { return this.command; }
  getCwd(): string { return this.cwd; }
  getPid(): number { return this.pid; }
  getPidStartedAt(): string { return this.pidStartedAt; }
  getPort(): number | null { return this.port; }
  getStartedAt(): Date | null { return this.startedAt; }

  /** Setters for port (when detected externally) */
  setPort(port: number): void { this.port = port; }
}
