import { getProxy } from '../proxy/registry.js';
import { levelOf, causeOf, type ProxyEvent } from '../proxy/intercept-proxy.js';
import type { StepTraffic } from '../annotation.js';
import type { BoundaryEvent, BoundaryTotals } from '../bench/wire.js';
import { writeKey, writeLine } from '../write-watch.js';
import { recordKinds } from '../bench/step-compare.js';
import { type BenchSession, sessions } from './session.js';

/**
 * What the boundary holds, in the counts a reader needs at a glance.
 *
 * Four questions, in the order they are asked of a run: how much crossed, how
 * much of it any step owns, what the attribution rests on, and what the sockets
 * are doing. A reader who cannot answer the second from the list alone reads
 * every row looking for it.
 */
export function summariseBoundary(
  events: ProxyEvent[],
  rules: Record<string, string>,
  sockets: Array<{ shape: string }>,
  open: number,
  holds: number
): BoundaryTotals {
  const levels = { observed: 0, likely: 0, positional: 0, unprompted: 0 };
  const roots: Record<string, number> = {};
  const shapes = { idle: 0, reply: 0, push: 0 };
  let requests = 0;
  let failed = 0;
  let out = 0;
  let incoming = 0;
  let owned = 0;
  let ruled = 0;

  for (const event of events) {
    if (event.kind === 'request') {
      requests += 1;
      if ((event.status ?? 0) >= 400 || event.status === 0) failed += 1;
    } else if (event.direction === 'out') out += 1;
    else incoming += 1;
    levels[levelOf(event)] += 1;
    if (causeOf(event)) owned += 1;
    const root = event.evidence?.initiator;
    if (root) roots[root] = (roots[root] ?? 0) + 1;
    const verdict = event.evidence?.shape ? rules[event.evidence.shape] : undefined;
    if (verdict === 'background' || verdict === 'unknown') ruled += 1;
  }
  for (const socket of sockets) {
    if (socket.shape === 'idle' || socket.shape === 'reply' || socket.shape === 'push') {
      shapes[socket.shape] += 1;
    }
  }
  return {
    events: events.length, requests, failed, out, in: incoming,
    owned, free: events.length - owned, levels, roots,
    sockets: { ...shapes, open }, holds, ruled,
    shapesRuled: Object.keys(rules).length,
  };
}

/** The open sequence's positions, which a rule can be bound to. */
export function openSteps(connection: string): Array<{ index: number; label: string }> {
  const steps = sessions.get(connection)?.sequences?.active()?.steps ?? [];
  return steps.map((step, index) => ({ index, label: step.label }));
}

/**
 * The recorded step a crossing falls under, by time, while a recording runs.
 *
 * Positional: the crossing is placed in the window between one step and the
 * next, which is the attribution the file's per-step traffic already uses. A
 * crossing a command stamped keeps its stamp; one from before the recording
 * began belongs to no step of it.
 */
export function recordedStepOf(connection: string, event: ProxyEvent): Partial<BoundaryEvent> {
  const session = sessions.get(connection);
  const times = session?.recordingStepTimes;
  const ended = !session?.recordingSequence && session?.recordingEndedAt !== undefined
    && event.at < session.recordingEndedAt && openSequence(connection) === session.recordedName;
  if (!(session?.recordingSequence || ended) || !times?.length || (event as { step?: number }).step !== undefined) return {};
  if (session.recordingStartedAt !== undefined && event.at < session.recordingStartedAt) return {};
  let step: number | undefined;
  for (let index = 0; index < times.length; index++) {
    // The opening step is the page the recording started on, so its window
    // opens with the recording rather than at the first click it is timed by.
    const from = index === 0 ? session.recordingStartedAt ?? times[0] : times[index];
    if (from !== undefined && from <= event.at) step = index;
  }
  // The recording is the pass these rows read, which is what the step list
  // keeps a row by: a crossing with no pass is read as left over from none.
  return step === undefined ? {} : {
    step, owned: true, level: 'positional', runId: `recording-${session.recordingStartedAt ?? 0}`,
  };
}

/** The most of one payload a recording keeps, the proxy's own body cap. */
export const RECORDED_BODY_CAP = 64 * 1024;

/**
 * A step's traffic with the storage writes its window holds.
 *
 * The network log counts local and session storage writes and nothing else
 * the page changes; the watch holds every store, so its count replaces the
 * log's, and a few of its lines join the requests', which is what a later run
 * of the sequence is compared against.
 */
export function withWrites(session: BenchSession, traffic: StepTraffic, from: number, to: number): StepTraffic {
  const writes = session.writeWatch?.between(from, to) ?? [];
  // Counted by kind from what the proxy and the write watch hold for the
  // window, which is what a replay of the step is compared against.
  const proxy = getProxy(session.connection);
  const crossed = (proxy?.eventsIn() ?? []).filter(event => event.at >= from && event.at < to);
  const written = writeEvents(session.connection).filter(event => event.at >= from && event.at < to);
  // The proxy holds its bodies in memory for this session only, so the
  // payload each kind is compared on is stored with the recording.
  const values = new Map((session.writeWatch?.writes ?? []).map(write => [write.id, write.value]));
  const kinds = recordKinds([...crossed, ...written],
    event => (event.kind === 'write' ? values.get(event.id) : proxy?.bodyOf(event.id)), RECORDED_BODY_CAP);
  // Stored empty too: a step that caused nothing is compared, so traffic it
  // starts causing reads as new rather than as a step with no record.
  traffic = { ...traffic, kinds };
  if (!writes.length) return traffic;
  // The log's own storage lines say less than the watch's and would list
  // each local or session write twice.
  const others = traffic.lines.filter(line => !/^(local|session)Storage /.test(line));
  return {
    ...traffic,
    writes: Math.max(traffic.writes, writes.length),
    lines: [...others, ...writes.slice(0, 4).map(writeLine)],
  };
}

/**
 * The page's storage writes as rows beside the traffic.
 *
 * Stamped with a replay's step where one was in flight when the write landed,
 * placed by time while a recording runs, and otherwise the app's own.
 */
export function writeEvents(connection: string, after = 0): BoundaryEvent[] {
  const watch = sessions.get(connection)?.writeWatch;
  if (!watch) return [];
  return watch.writes.filter(write => write.at > after).map(write => {
    const row = {
      id: write.id, at: write.at, kind: 'write' as const, direction: 'out' as const,
      url: writeKey(write), method: write.store,
      preview: writeLine(write).slice(write.store.length + 1),
      size: write.value?.length ?? 0, level: 'unprompted' as const, owned: false,
    };
    if (write.cursor?.kind === 'replay') {
      return {
        ...row, step: write.cursor.step, runId: write.cursor.runId,
        ...(write.cursor.within ? { within: write.cursor.within } : {}),
        ...(write.cursor.entry !== undefined ? { entry: write.cursor.entry } : {}),
        ...(write.cursor.paused ? { paused: true as const } : {}),
        owned: true, level: 'positional' as const,
      };
    }
    return {
      ...row, ...recordedStepOf(connection, { at: write.at } as ProxyEvent),
      ...(write.cursor?.kind === 'command' ? { commandIndex: write.cursor.index } : {}),
    } as BoundaryEvent;
  });
}

/** The sequence those positions count within. */
export function openSequence(connection: string): string | undefined {
  return sessions.get(connection)?.sequences?.active()?.name;
}
