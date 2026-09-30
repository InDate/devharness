/**
 * Simple debug logger for troubleshooting
 * Writes to .devharness/logs/debug.log when enabled
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';
import { translateCall } from './tools/legacy-steps.js';

// Computed fresh on each call (not cached) so they follow a later
// setWorkingDirOverride() / config useLocal(path) switch.
function getLogDir(): string {
  return getOutputPath('logs');
}
/** Where debug logging writes: the project's state directory, or the global one when there is none. */
export function getLogFile(): string {
  return join(getLogDir(), 'debug.log');
}
function getHistoryFile(): string {
  return join(getLogDir(), 'history.log');
}

// Global debug state - can be toggled via MCP tool or config
let debugEnabled = false;
// History log state - can be enabled separately from debug logging
let historyLogEnabled = false;

// Startup metrics storage - captured during startup, logged when debug is enabled
interface StartupMetrics {
  totalMs: number;
  importMs: number;
  portReservationMs: number;
  portAttempts: number;
  serverCreationMs: number;
  toolRegistrationMs: number;
  transportMs: number;
  capturedAt: string;
}

let startupMetrics: StartupMetrics | null = null;

/**
 * Store startup metrics for later logging
 */
export function setStartupMetrics(metrics: StartupMetrics): void {
  startupMetrics = metrics;
}

/**
 * Get stored startup metrics
 */
export function getStartupMetrics(): StartupMetrics | null {
  return startupMetrics;
}

/**
 * Enable debug logging
 */
export async function enableDebugLogging(options?: { clearOnStartup?: boolean }): Promise<void> {
  debugEnabled = true;
  if (options?.clearOnStartup) {
    try { await fs.writeFile(getLogFile(), ''); } catch { /* best-effort truncate */ }
  }
  console.error('[DebugLogger] Debug logging enabled');

  // Log startup metrics if available
  if (startupMetrics) {
    await debugLog('startup', `=== Startup metrics (captured at ${startupMetrics.capturedAt}) ===`);
    await debugLog('startup', `Total startup time: ${startupMetrics.totalMs}ms`);
    await debugLog('startup', `  - Imports: ${startupMetrics.importMs}ms`);
    await debugLog('startup', `  - Port reservation: ${startupMetrics.portReservationMs}ms (${startupMetrics.portAttempts} attempt(s))`);
    await debugLog('startup', `  - Server creation: ${startupMetrics.serverCreationMs}ms`);
    await debugLog('startup', `  - Tool registration: ${startupMetrics.toolRegistrationMs}ms`);
    await debugLog('startup', `  - Transport: ${startupMetrics.transportMs}ms`);
  }
}

/**
 * Disable debug logging
 */
export function disableDebugLogging(): void {
  debugEnabled = false;
  console.error('[DebugLogger] Debug logging disabled');
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Enable history logging (can be enabled independently of debug logging)
 */
export function enableHistoryLogging(): void {
  historyLogEnabled = true;
  console.error('[DebugLogger] History logging enabled');
}

/**
 * Disable history logging
 */
export function disableHistoryLogging(): void {
  historyLogEnabled = false;
  console.error('[DebugLogger] History logging disabled');
}

/**
 * Check if history logging is enabled
 */
export function isHistoryLogEnabled(): boolean {
  return historyLogEnabled;
}

/**
 * Write a debug log entry (only if debug logging is enabled)
 * Format: [TIMESTAMP] [MODULE] message
 */
export async function debugLog(module: string, message: string): Promise<void> {
  if (!debugEnabled) {
    return; // Skip logging if disabled
  }

  try {
    // Ensure log directory exists
    await fs.mkdir(getLogDir(), { recursive: true });

    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${module}] ${message}\n`;

    // Append to log file
    await fs.appendFile(getLogFile(), logEntry);

    // Also write to stderr for immediate visibility
    console.error(logEntry.trim());
  } catch (error) {
    // Don't let logging failures crash the server
    console.error(`[DebugLogger] Failed to write log: ${error}`);
  }
}

/**
 * Write a command to history.log in replay-compatible format (only if history logging is enabled)
 * Each line is a JSON object matching RecordedCommand: { tool, params }
 * New commands are prepended (newest first) so line 1 is always the most recent command
 */
export async function logToHistoryFile(entry: string): Promise<void> {
  if (!historyLogEnabled) {
    return;
  }

  try {
    await fs.mkdir(getLogDir(), { recursive: true });

    // Read existing content and prepend new entry
    let existingContent = '';
    try {
      existingContent = await fs.readFile(getHistoryFile(), 'utf-8');
    } catch {
      // File doesn't exist yet, that's fine
    }

    await fs.writeFile(getHistoryFile(), entry + '\n' + existingContent);
  } catch (error) {
    console.error(`[DebugLogger] Failed to write history: ${error}`);
  }
}

/**
 * Get the path to the history log file
 */
export function getHistoryFilePath(): string {
  return getHistoryFile();
}

/**
 * Read a specific line from the history log file (1-indexed)
 * Returns the parsed command or null if line doesn't exist
 */
export async function readHistoryLine(lineNumber: number): Promise<{ tool: string; params: Record<string, any> } | null> {
  if (lineNumber < 1) {
    return null;
  }

  try {
    const content = await fs.readFile(getHistoryFile(), 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lineNumber > lines.length) {
      return null;
    }

    const line = lines[lineNumber - 1];
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}

/**
 * Read multiple lines from the history log file (1-indexed)
 * Returns array of parsed commands
 */
export async function readHistoryLines(lineNumbers: number[]): Promise<Array<{ line: number; tool: string; params: Record<string, any> } | { line: number; error: string }>> {
  const results: Array<{ line: number; tool: string; params: Record<string, any> } | { line: number; error: string }> = [];

  try {
    const content = await fs.readFile(getHistoryFile(), 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const lineNum of lineNumbers) {
      if (lineNum < 1 || lineNum > lines.length) {
        results.push({ line: lineNum, error: `Line ${lineNum} does not exist (file has ${lines.length} lines)` });
        continue;
      }

      try {
        const parsed = JSON.parse(lines[lineNum - 1]);
        // A line logged against a removed tool replays as the call that replaced it.
        const { tool, params } = translateCall(parsed.tool, parsed.params);
        results.push({ line: lineNum, tool, params });
      } catch {
        results.push({ line: lineNum, error: 'Invalid JSON on this line' });
      }
    }
  } catch (error) {
    return lineNumbers.map(n => ({ line: n, error: 'Could not read history file' }));
  }

  return results;
}
