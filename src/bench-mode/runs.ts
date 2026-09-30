import { getOutputPath } from '../helpers/paths.js';
import { debugLog } from '../debug-logger.js';
import { getProxy } from '../proxy/registry.js';
import type { StepTraffic } from '../annotation.js';
import type { SequenceState, RunRow, RunsView } from '../bench/wire.js';
import { listSuites, readRuns } from '../run-log.js';
import { runRegistry } from '../tools/replay-run-registry.js';
import { renameSequence } from '../sequence-rename.js';
import { countKinds, kindOf } from '../bench/kinds.js';
import { haltSequence } from './controls.js';
import { letGoForRun } from './page-hold.js';
import { getSequenceState, gotoSequenceStep, playSequence, selectSequence } from './sequence.js';
import { sessions } from './session.js';
import { stepTimes, withTallies } from './tallies.js';
import { RECORDED_BODY_CAP, writeEvents } from './traffic.js';

/**
 * Every run going now - each replay run in the registry and each bench's own
 * play - the suites, and the runs the log holds as ended.
 */
export async function runsView(): Promise<RunsView> {
  const running: RunRow[] = runRegistry.active().map(record => ({
    runId: record.runId, sequence: record.sequenceName,
    ...(record.connectionReason ? { connection: record.connectionReason } : {}),
    via: 'replay' as const, status: record.status, step: record.currentStep, total: record.totalSteps,
    ...(record.currentTool ? { tool: record.currentTool } : {}),
    startedAt: record.startedAt,
    ...(record.suite ? { suite: record.suite } : {}),
    ...withTallies(record.connectionReason, record.startedAt, record.totalSteps, undefined, stepTimes(record.stepStarts ?? [], Date.now())),
  }));
  for (const [connection, session] of sessions) {
    const active = session.sequencePlaying ? session.sequences?.active() : null;
    if (!active) continue;
    running.push({
      sequence: active.name, connection, via: 'bench', status: 'running',
      step: Math.min(active.currentStep + 1, active.total), total: active.total,
      ...(active.steps[active.currentStep]?.tool ? { tool: active.steps[active.currentStep].tool } : {}),
      startedAt: session.playStartedAt ?? Date.now(),
      ...withTallies(connection, session.playStartedAt ?? Date.now(), active.total, undefined,
        stepTimes(session.playStepStarts ?? [], Date.now())),
    });
  }
  return { running, suites: listSuites(), finished: await readRuns(50) };
}

/** Headless browsers the home page has started runs in, for a reference each one does not share. */
let homeRuns = 0;

/**
 * Run a sequence from the home page in a browser of its own: headless, through
 * a proxy so its traffic is counted, and closed when the run ends. The bench's
 * own browser stays on what it holds, and several runs go at once. Answers
 * with the failure text, or nothing once the run has started.
 */
export async function runFromHome(connection: string, name: string): Promise<string | undefined> {
  const sequences = sessions.get(connection)?.sequences;
  if (!sequences) return 'this bench holds no replay side to run with';
  const reference = `home-run-${++homeRuns}`;
  const launched = await sequences.callTool('connection', { action: 'launch', name: reference, headless: true, proxy: true, forceNewInstance: true });
  if (launched.failed) return launched.result;
  const started = await sequences.callTool('replay', { action: 'run', name, connectionReason: reference, killChromeOnFinish: true });
  return started.failed ? started.result : undefined;
}

/**
 * Play a sequence in the bench's own browser from the home page, from step 1,
 * as the bench's Replay does: the bench opens the sequence and plays it there.
 */
export async function playHere(connection: string, name: string): Promise<void> {
  const session = sessions.get(connection);
  if (session) await letGoForRun(session);
  await selectSequence(connection, name);
  void (async () => {
    await gotoSequenceStep(connection, 0);
    await playSequence(connection);
  })().catch(error => debugLog('bench', `playing ${name} here failed: ${error}`));
}

/**
 * Open a sequence in the bench's own browser and run it through one step,
 * then hold there, as an issue's note is gone to: the page stands where the
 * note was written. `step` is 0-based. The run goes on after the answer, so
 * the bench shows it arriving.
 */
export async function playToStep(connection: string, name: string, step: number): Promise<void> {
  const session = sessions.get(connection);
  if (session) await letGoForRun(session);
  await selectSequence(connection, name);
  void gotoSequenceStep(connection, step)
    .catch(error => debugLog('bench', `running ${name} to step ${step + 1} failed: ${error}`));
}

/**
 * Rename a saved sequence, its activity file and every step that runs it, and
 * drop the copy held in memory under the old name. Answers with the failure
 * text, or with how many steps elsewhere now name it.
 */
export async function renameFromHome(connection: string, from: string, to: string): Promise<{ failure?: string; references: number }> {
  const renamed = await renameSequence(
    [getOutputPath('sequences', { global: false }), getOutputPath('sequences', { global: true })], from, to.trim(),
  ).catch(error => ({ failure: String(error), references: 0 }));
  if (!renamed.failure) await sessions.get(connection)?.sequences?.callTool('replay', { action: 'delete', name: from }).catch(() => undefined);
  return renamed;
}

/** Stop one run going now: a replay run by its id, a bench play by its connection. */
export async function stopRun(target: { runId?: string; connection?: string }): Promise<void> {
  if (target.runId) {
    const record = runRegistry.get(target.runId);
    if (record && (record.status === 'running' || record.status === 'cancelling')) {
      record.status = 'cancelling';
      record.controller.abort();
    }
    return;
  }
  if (target.connection) await haltSequence(target.connection);
}

/**
 * Play the open sequence from its first step and keep what crossed under each
 * step as that step's recorded traffic, replacing what it held: the baseline
 * later plays are compared against.
 *
 * Taken by the step each crossing and storage write was stamped with in this
 * play, not by a window of time, since a play knows which step each belongs
 * to. A step that caused nothing is kept as having caused nothing, so traffic
 * on it later reads as new. A play that fails or stops short leaves the
 * baseline before it standing: half a baseline would read the unreached steps
 * as having caused nothing.
 */
export async function baselineSequence(connection: string): Promise<SequenceState | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;
  const proxy = getProxy(connection);
  if (!proxy) {
    session.sequenceFailure = 'a baseline keeps what crosses the proxy, and this browser was not launched through one';
    return getSequenceState(connection);
  }
  const passesBefore = new Set([...proxy.eventsIn(), ...writeEvents(connection)].map(event => event.runId));
  await letGoForRun(session);
  await gotoSequenceStep(connection, 0);
  const played = await playSequence(connection);
  if (!played || played.failure || played.currentStep < played.total) {
    const why = played?.failure ?? `the run stopped at step ${(played?.currentStep ?? 0) + 1} of ${played?.total ?? 0}`;
    session.sequenceFailure = `baseline not taken, and the one before it stands: ${why}`;
    return getSequenceState(connection);
  }

  const all = [...proxy.eventsIn(), ...writeEvents(connection)];
  const pass = [...all].reverse().find(event => event.runId && !passesBefore.has(event.runId))?.runId;
  const values = new Map((session.writeWatch?.writes ?? []).map(write => [write.id, write.value]));
  const at = Date.now();
  const entries = Array.from({ length: played.total }, (_, index) => {
    const crossed = pass ? all.filter(event => event.runId === pass && event.step === index) : [];
    const kinds = countKinds(crossed);
    // The payload of the last of each kind, which a later play's row is compared against.
    for (const event of crossed) {
      const count = kinds[kindOf(event)];
      if (!count || count.presence) continue;
      const body = event.kind === 'write' ? values.get(event.id) : proxy.bodyOf(event.id);
      if (body !== undefined) count.body = body.slice(0, RECORDED_BODY_CAP);
    }
    const requests = crossed.filter(event => event.kind === 'request');
    const traffic: StepTraffic = {
      requests: requests.length,
      failed: requests.filter(event => (event.status ?? 0) >= 400).length,
      opened: requests.filter(event => event.status === 101).length,
      writes: crossed.filter(event => event.kind === 'write').length,
      lines: requests.slice(0, 8).map(event => `${event.method ?? 'GET'} ${pathOf(event.url)} ${event.status ?? 'pending'}`),
      kinds,
      recordedAt: at,
    };
    return { index, traffic };
  });
  session.sequenceFailure = await session.sequences.saveStepTraffic(entries).catch(error => String(error));
  return getSequenceState(connection);
}

/** A URL's path, or the URL where it does not parse as one. */
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}
