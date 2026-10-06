import { getProxy, checkOutcomesFor, type CheckOutcome } from '../proxy/registry.js';
import type { SequenceState, StepCheck, StepTally } from '../bench/wire.js';
import { sessions } from './session.js';
import { writeEvents } from './traffic.js';
import * as stepCompare from '../bench/step-compare.js';

/**
 * The pass a run produced on a browser: a replay stamps what it caused with
 * `run-<start time>`, taken as it starts, which is at or after the run's own
 * start and before its end. The earliest such pass is the run's own; a nested
 * sequence shares it.
 */
function passOf(connection: string, startedAt: number, endedAt: number): string | undefined {
  const ids = new Set<string>();
  for (const event of getProxy(connection)?.eventsIn(startedAt) ?? []) if (event.runId) ids.add(event.runId);
  for (const outcome of checkOutcomesFor(connection)) ids.add(outcome.runId);
  for (const write of writeEvents(connection, startedAt - 1)) if (write.runId) ids.add(write.runId);
  let best: { id: string; at: number } | undefined;
  for (const id of ids) {
    const at = /^run-([0-9a-z]+)$/.exec(id) ? parseInt(id.slice(4), 36) : NaN;
    if (!(at >= startedAt && at <= endedAt)) continue;
    if (!best || at < best.at) best = { id, at };
  }
  return best?.id;
}

/** A check step's stored outcome as a step's reading. */
function readingOf(outcome: CheckOutcome): StepCheck {
  const ran = outcome.ran
    ? { name: outcome.ran, steps: outcome.ranSteps?.length ?? outcome.steps ?? 0, failed: (outcome.ranSteps ?? []).filter(step => !step.success).length }
    : undefined;
  return {
    outcome: outcome.outcome, action: outcome.action, subject: outcome.subject,
    ...(outcome.found !== undefined ? { found: outcome.found } : {}),
    ...(outcome.waitedMs !== undefined ? { waitedMs: outcome.waitedMs } : {}),
    ...(outcome.limitMs !== undefined ? { limitMs: outcome.limitMs } : {}),
    ...(ran ? { ran } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

/**
 * What each step of a run did on its browser, counted by category. A check
 * step's reading comes from the outcomes the run stored; `readings`, by
 * position, replaces them where the caller holds the run's own results.
 */
export function stepTallies(
  connection: string, startedAt: number, endedAt: number, total: number,
  readings?: Array<StepCheck | undefined>,
  times?: Array<number | undefined>,
): StepTally[] | undefined {
  if (total <= 0) return undefined;
  // A run that stamped nothing crossed nothing, wrote nothing and read no
  // check: its counts are zeros, and its times and readings still stand.
  const pass = passOf(connection, startedAt, endedAt);
  const watched = !!sessions.get(connection)?.writeWatch;
  const tallies: StepTally[] = Array.from({ length: total }, () => ({ requests: 0, frames: 0, intercepted: 0, ...(watched ? { state: 0 } : {}) }));
  const events = getProxy(connection)?.eventsIn(startedAt) ?? [];
  // A step run twice counts its newest attempt, and a pause counts against no step.
  const attempts = stepCompare.passOf(events.filter(event => event.runId === pass));
  for (const event of events) {
    const tally = stepCompare.countsForStep(event, attempts) ? tallies[event.step!] : undefined;
    if (!tally) continue;
    if (event.kind === 'request') tally.requests += 1;
    else tally.frames += 1;
    if (event.answeredAs) tally.intercepted += 1;
  }
  for (const write of writeEvents(connection, startedAt - 1)) {
    const tally = write.runId === pass && write.step !== undefined ? tallies[write.step] : undefined;
    if (tally && tally.state !== undefined) tally.state += 1;
  }
  for (const outcome of checkOutcomesFor(connection)) {
    const tally = outcome.runId === pass ? tallies[outcome.step] : undefined;
    if (tally) tally.check = readingOf(outcome);
  }
  readings?.forEach((reading, index) => { if (reading && tallies[index]) tallies[index].check = reading; });
  times?.forEach((ms, index) => { if (ms !== undefined && tallies[index]) tallies[index].ms = ms; });
  return tallies;
}

export function withTallies(
  connection: string | undefined, startedAt: number, total: number,
  readings?: Array<StepCheck | undefined>, times?: Array<number | undefined>,
): { steps?: StepTally[] } {
  const steps = connection ? stepTallies(connection, startedAt, Date.now(), total, readings, times) : undefined;
  return steps ? { steps } : {};
}

/**
 * Each step's time from when each step started: up to the next step's start,
 * and the last one started up to `until`, the run's end or now.
 */
export function stepTimes(starts: Array<number | undefined>, until: number): Array<number | undefined> {
  return starts.map((start, index) => {
    if (start === undefined) return undefined;
    const next = starts.slice(index + 1).find(at => at !== undefined);
    return (next ?? until) - start;
  });
}

/**
 * A bench play's assert and wait steps, which store no reading: each one
 * passed held, and the one the play failed on failed and stopped it.
 */
export function benchReadings(ended: SequenceState): Array<StepCheck | undefined> {
  return ended.steps.map((step, index) => {
    if (step.tool !== 'assert' && step.tool !== 'wait') return undefined;
    if (step.failed) return { outcome: 'failed', action: 'stop', ...(ended.failure ? { error: ended.failure } : {}) };
    return index < ended.currentStep ? { outcome: 'held', action: 'continue' } : undefined;
  });
}
