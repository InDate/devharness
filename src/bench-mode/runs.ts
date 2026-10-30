import { entrySettled, onEntrySettled, whenSettled } from '../root-credit.js';
import { getOutputPath } from '../helpers/paths.js';
import { debugLog } from '../debug-logger.js';
import { getProxy } from '../proxy/registry.js';
import { getMessage } from '../messages.js';
import type { ProxyEvent } from '../proxy/intercept-proxy.js';
import type { StepTraffic } from '../annotation.js';
import type { SequenceState, RunRow, RunsView } from '../bench/wire.js';
import { listSuites, readRuns } from '../run-log.js';
import { runRegistry } from '../tools/replay-run-registry.js';
import { renameSequence } from '../sequence-rename.js';
import { recordKinds } from '../bench/step-compare.js';
import { haltSequence } from './controls.js';
import { letGoForRun } from './page-hold.js';
import { getSequenceState, gotoSequenceStep, playSequence, selectSequence } from './sequence.js';
import { sessions } from './session.js';
import { stepTimes, withTallies } from './tallies.js';
import { RECORDED_BODY_CAP } from './traffic.js';
import { crossingsOf, sliceOf } from '../step-slice.js';
import { ARRIVING_BOUND_MS } from '../tools/run-table.js';

/**
 * Every run going now - each run sequence in the registry and each bench's own
 * play - the suites, and the runs the log holds as ended.
 */
export async function runsView(): Promise<RunsView> {
  const running: RunRow[] = runRegistry.active().map(record => ({
    runId: record.runId, sequence: record.sequenceName,
    ...(record.connection ? { connection: record.connection } : {}),
    via: 'replay' as const, status: record.status, step: record.currentStep, total: record.totalSteps,
    ...(record.currentTool ? { tool: record.currentTool } : {}),
    startedAt: record.startedAt,
    ...(record.suite ? { suite: record.suite } : {}),
    ...withTallies(record.connection, record.startedAt, record.totalSteps, undefined, stepTimes(record.stepStarts ?? [], Date.now())),
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
  const launched = await sequences.callTool('connection', { action: 'launch', connection: reference, headless: true, proxy: true, forceNewInstance: true });
  if (launched.failed) return launched.result;
  const started = await sequences.callTool('run', { action: 'sequence', name, connection: reference, killChromeOnFinish: true });
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
  void playSequence(connection, { fromStart: true })
    .catch(error => debugLog('bench', `playing ${name} here failed: ${error}`));
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

/** Stop one run going now: a run sequence by its id, a bench play by its connection. */
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
    session.sequenceFailure = getMessage('BENCH_BASELINE_NO_PROXY').trim();
    return getSequenceState(connection);
  }
  await letGoForRun(session);
  const played = await playSequence(connection, { throughHolds: true, fromStart: true, compare: false });
  if (!played || played.failure || played.currentStep < played.total) {
    const why = played?.failure ?? `the run stopped at step ${(played?.currentStep ?? 0) + 1} of ${played?.total ?? 0}`;
    session.sequenceFailure = `baseline not taken, and the one before it stands: ${why}`;
    return getSequenceState(connection);
  }

  // Each step is read from the observation log by the History entry of its
  // newest attempt in this play, the set a replay of it is compared on.
  const sequenceName = played.name ?? session.sequences.active()?.name;
  const history = session.sequences.history();
  const at = Date.now();
  const sequences = session.sequences;
  const fingerprints = sequenceName && session.playStepStarts
    ? sequences.clickFingerprints(sequenceName, Array.from({ length: played.total }, (_, i) => session.playStepStarts?.[i] ?? at), Date.now())
    : [];
  const stepEntries = Array.from({ length: played.total }, (_, index) => history.find(one => one.run === sequenceName && one.runStep === index)?.index);
  const take = () => Array.from({ length: played.total }, (_, index) => {
    const call = history.find(one => one.run === sequenceName && one.runStep === index);
    const entry = call?.index;
    const { crossings: crossed, bodyOf } = entry !== undefined ? crossingsOf(entry, connection) : { crossings: [], bodyOf: () => undefined };
    const kinds = recordKinds(crossed, bodyOf, RECORDED_BODY_CAP);
    const requests = crossed.filter(event => event.kind === 'request');
    // A transport is a socket upgrade or an event stream, as `countStepTraffic`
    // counts them for a recording: counted by 101 alone, a stream the step
    // opened read as no transport, and the two records of one step disagreed.
    const opened = requests.filter(event => event.status === 101 || (event as ProxyEvent).contentType === 'text/event-stream');
    const traffic: StepTraffic = {
      requests: requests.length,
      failed: requests.filter(event => (event.status ?? 0) >= 400).length,
      opened: opened.length,
      writes: crossed.filter(event => event.kind === 'write').length,
      lines: [
        ...requests.slice(0, 8).map(event => `${event.method ?? 'GET'} ${pathOf(event.url)} ${event.status ?? 'pending'}`),
        ...opened.slice(0, 4).map(event => `opened ${event.url}`),
      ],
      kinds,
      ...(entry !== undefined ? { observations: sliceOf(entry, connection, call!.at, RECORDED_BODY_CAP) } : {}),
      recordedAt: at,
    };
    return { index, traffic, ...(fingerprints[index] ? { fingerprint: fingerprints[index] } : {}) };
  });
  session.sequenceFailure = await sequences.saveStepTraffic(take()).catch(error => String(error));
  // What a step caused keeps landing after the play ends, on the entry of
  // the step whose input caused it, until the step's roots settle. The reply
  // waits for those steps, as a run's reply does, up to the same bound: a
  // play started straight after it navigated away from the last step's
  // scroll, and the baseline kept that step mid-scroll with its later motion
  // missing (30 Oct). The baseline is taken again whenever one of its steps
  // settles - one still open at the bound, and one that reopens after it
  // read as settled - and the bench lists the steps still open. The next
  // baseline of this browser replaces the subscription.
  const open = () => stepEntries.flatMap((entry, index) => (entry !== undefined && !entrySettled(entry) ? [index + 1] : []));
  const arriving = stepEntries.filter((entry): entry is number => entry !== undefined && !entrySettled(entry));
  if (arriving.length) {
    await Promise.all(arriving.map(entry => whenSettled(entry, ARRIVING_BOUND_MS)));
    session.sequenceFailure = await sequences.saveStepTraffic(take()).catch(error => String(error));
  }
  retaking.get(connection)?.();
  retaking.delete(connection);
  session.baselineFilling = open().length ? { steps: open(), retakes: 0 } : undefined;
  const entries = new Set(stepEntries.filter((entry): entry is number => entry !== undefined));
  retaking.set(connection, onEntrySettled(entry => {
    if (!entries.has(entry)) return;
    void sequences.saveStepTraffic(take()).catch(() => undefined);
    const steps = open();
    session.baselineFilling = steps.length ? { steps, retakes: (session.baselineFilling?.retakes ?? 0) + 1 } : undefined;
  }));
  return getSequenceState(connection);
}

/** Each browser's subscription that takes its last baseline again as its steps settle; the next baseline replaces it. */
const retaking = new Map<string, () => void>();

/** A URL's path, or the URL where it does not parse as one. */
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}
