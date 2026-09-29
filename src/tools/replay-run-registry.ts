/**
 * Run Registry - tracks background sequence runs by run id.
 *
 * `replay({ action: 'run' })` returns a run id immediately and executes in the
 * background; this registry is what `status` and `cancel` use to address a
 * specific run. Held in memory only: a server restart (e.g. the supervisor's
 * hot-restart on rebuild) kills any in-flight run with the process and
 * forgets every id - callers polling an old id get REPLAY_RUN_NOT_FOUND.
 */

import type { StepResult } from './replay-executor.js';

export type RunStatus =
  | 'running'     // executing steps
  | 'cancelling'  // cancel requested; steps that honour the signal stop promptly, others at the next step boundary
  | 'paused'      // stopped mid-sequence (stepTo / breakpoint / click validation) - drive with step/finish
  | 'completed'   // finished, all steps succeeded
  | 'failed'      // finished, at least one step failed (or setup failed)
  | 'cancelled';  // stopped by cancel

export interface RunRecord {
  runId: string;
  sequenceId: string;
  sequenceName: string;
  connectionReason?: string;
  status: RunStatus;
  startedAt: number;
  /** Set when the background execution settles (including on pause). */
  endedAt?: number;
  totalSteps: number;
  /** 1-based step currently executing (or last reached). 0 = setup phase. */
  currentStep: number;
  currentTool?: string;
  /** Top-level step results, populated when the run settles. */
  results: StepResult[];
  controller: AbortController;
  /** The full tool response the old blocking `run` would have returned. */
  finalResponse?: any;
  /** Failure that escaped the run path itself (not a step failure). */
  error?: string;
  /** When each top-level step started, by position. */
  stepStarts?: Array<number | undefined>;
  /** The `runAll` suite this run is one sequence of. */
  suite?: { id: string; label: string };
}

/** How long a settled run (completed/failed/cancelled/paused) stays retrievable. */
export const RUN_RETENTION_MS = 30 * 60 * 1000;
/** Hard cap on records; oldest settled runs are evicted first. */
export const MAX_RUN_RECORDS = 50;

class RunRegistry {
  private runs = new Map<string, RunRecord>();
  private counter = 0;

  /** Ids are unique per process; the timestamp suffix keeps an id from a
   *  previous server process from accidentally resolving after a restart. */
  newRunId(): string {
    return `run-${++this.counter}-${Date.now().toString(36)}`;
  }

  register(record: RunRecord): void {
    this.runs.set(record.runId, record);
    this.prune();
  }

  /** Drop a run whose caller already has its result, so it is not listed as one to read. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  get(runId: string): RunRecord | undefined {
    this.prune();
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    this.prune();
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Runs that are still executing (running or cancelling). */
  active(): RunRecord[] {
    return this.list().filter(r => r.status === 'running' || r.status === 'cancelling');
  }

  isSettled(record: RunRecord): boolean {
    return record.status !== 'running' && record.status !== 'cancelling';
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.runs) {
      if (this.isSettled(record) && record.endedAt !== undefined && now - record.endedAt > RUN_RETENTION_MS) {
        this.runs.delete(id);
      }
    }
    if (this.runs.size > MAX_RUN_RECORDS) {
      const settled = [...this.runs.values()]
        .filter(r => this.isSettled(r))
        .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
      for (const record of settled) {
        if (this.runs.size <= MAX_RUN_RECORDS) break;
        this.runs.delete(record.runId);
      }
    }
  }

  /** Test hook. */
  clear(): void {
    this.runs.clear();
  }
}

export const runRegistry = new RunRegistry();
