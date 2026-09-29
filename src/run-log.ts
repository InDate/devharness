/**
 * Every sequence run that ended, one JSON line each in `.devharness/runs.jsonl`,
 * and the suites running now.
 *
 * The run registry holds a run for 30 minutes and loses it on every restart,
 * and a rebuild restarts the server, so a run that ended before the last
 * rebuild has no record anywhere else. A bench play is in neither the
 * registry nor the history of tool calls. Both land here as they end.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getProjectDir } from './helpers/paths.js';
import { debugLog } from './debug-logger.js';
import type { StepTally } from './bench/wire.js';

export interface RunEntry {
  /** The registry's id for a replay run; a bench play has none. */
  runId?: string;
  sequence: string;
  connection?: string;
  via: 'replay' | 'bench';
  status: string;
  startedAt: number;
  endedAt?: number;
  /** 1-based step reached. */
  step: number;
  total: number;
  /** The tool the step reached calls. */
  tool?: string;
  failure?: string;
  suite?: { id: string; label: string };
  /** Per step, by position, what it did: the counts a finished run keeps after the proxy's memory is gone. */
  steps?: StepTally[];
}

export interface SuiteEntry {
  id: string;
  /** What chose the sequences: the folder, the tags, or both. */
  label: string;
  names: string[];
  done: number;
  failed: number;
  startedAt: number;
  endedAt?: number;
}

/** Lines read back for the bench; older ones stay in the file. */
const READ_LIMIT = 200;

function logPath(): string {
  return join(getProjectDir(), '.devharness', 'runs.jsonl');
}

/**
 * Set by the server as it starts. A test drives runs through the same code in
 * the project directory, and its fake runs would otherwise land in the log a
 * person reads.
 */
let writing = false;

export function enableRunLog(): void {
  writing = true;
}

export async function appendRun(entry: RunEntry): Promise<void> {
  if (!writing) return;
  try {
    await fs.mkdir(join(getProjectDir(), '.devharness'), { recursive: true });
    await fs.appendFile(logPath(), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    await debugLog('run-log', `writing a run failed: ${error}`);
  }
}

/** The runs that ended, newest first. A line that does not parse is skipped. */
export async function readRuns(limit = READ_LIMIT): Promise<RunEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(logPath(), 'utf-8');
  } catch {
    return [];
  }
  const entries: RunEntry[] = [];
  for (const line of text.trimEnd().split('\n').reverse()) {
    if (entries.length >= limit) break;
    try {
      entries.push(JSON.parse(line));
    } catch { /* a torn or hand-edited line */ }
  }
  return entries;
}

const suites = new Map<string, SuiteEntry>();
const SUITES_KEPT = 10;

export function beginSuite(label: string, names: string[]): SuiteEntry {
  const suite: SuiteEntry = { id: `suite-${Date.now().toString(36)}`, label, names, done: 0, failed: 0, startedAt: Date.now() };
  suites.set(suite.id, suite);
  for (const id of [...suites.keys()].slice(0, Math.max(0, suites.size - SUITES_KEPT))) suites.delete(id);
  return suite;
}

/** Suites running now and those that ended since the server started, newest first. */
export function listSuites(): SuiteEntry[] {
  return [...suites.values()].sort((a, b) => b.startedAt - a.startedAt);
}
