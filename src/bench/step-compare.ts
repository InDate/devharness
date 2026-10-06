/**
 * A pass's crossings placed on its steps, and each step compared with its
 * recording, kind by kind.
 *
 * One definition for the bench, which draws a verdict on each row, and the
 * server, which reports a run's matched count: two comparisons drifted apart,
 * and a run read a step as mismatched that the bench's rows showed matching.
 */
import type { BoundaryEvent, HiddenKind } from './wire.js';
import {
  countKinds, ignoreCoversKind, ignoreMatches, kindOf, sizeBand, verdictOf,
  type Crossed, type ExpectedValue, type KindCount, type Verdict,
} from './kinds.js';

/** The fields placement and comparison read off a crossing. */
export type Crossing = Pick<BoundaryEvent, 'id' | 'at' | 'kind' | 'url' | 'direction'>
  & Partial<Pick<BoundaryEvent, 'method' | 'preview' | 'status' | 'answeredAs' | 'runId' | 'step' | 'within' | 'paused' | 'entry'
    | 'payloadClass' | 'sent' | 'size'>>;

/** What of a crossing the comparison reads beside its kind's count: what it sent, and a binary body's size band. */
function crossedOf(event: Crossing): Crossed {
  return {
    ...(event.payloadClass ? { payloadClass: event.payloadClass } : {}),
    ...(event.sent !== undefined ? { sent: event.sent } : {}),
    ...(event.payloadClass === 'binary' ? { band: sizeBand(event.size ?? 0) } : {}),
  };
}

/** Where in a pass a crossing was stamped: its step, and its place in a sequence that step ran. */
function positionKey(event: Crossing): string {
  return [event.step, ...(event.within ?? [])].join('.');
}

/**
 * The newest pass among `events`, and the newest History entry each of its
 * positions was stamped with. A step run again - resumed after an abort, or
 * repaired - is a new call with a new entry, and its first attempt's
 * crossings carry the old one; counted together, the step read as having
 * crossed both attempts' traffic.
 */
export function passOf(events: Crossing[]): { pass?: string; latest?: Map<string, number> } {
  let pass: string | undefined;
  for (const event of events) if (event.runId !== undefined) pass = event.runId;
  if (pass === undefined) return {};
  const latest = new Map<string, number>();
  for (const event of events) {
    if (event.runId !== pass || event.entry === undefined || event.paused) continue;
    const key = positionKey(event);
    if (event.entry > (latest.get(key) ?? -1)) latest.set(key, event.entry);
  }
  return { pass, latest };
}

/**
 * Where one crossing of `pass` is listed: the step it was stamped with.
 * `placements` moves a kind from where it crossed to where the sequence lists
 * it, the step count being the gutter after the last step; `origin` is where
 * it crossed, which a move is saved against.
 *
 * A pass ends at its last step's release. An unstamped crossing - after that
 * line, or between calls outside any run - belongs to no step, and a crossing
 * stamped in a pause belongs to the pause, which `pausesOf` lists.
 */
export function placementOf(
  event: Crossing,
  at: { pass?: string; latest?: Map<string, number> },
  placements: Record<string, number> | undefined,
  _stepCount: number,
): { step: number; origin: string } | undefined {
  if (!countsForStep(event, at)) return undefined;
  const step = event.step!;
  const origin = String(step);
  return { origin, step: placements?.[`${origin}|${kindOf(event)}`] ?? step };
}

/**
 * Whether a crossing of `pass` counts against the step it is stamped with:
 * stamped in a step's window rather than a pause, by that step's newest attempt.
 */
export function countsForStep(event: Crossing, at: { pass?: string; latest?: Map<string, number> }): boolean {
  if (event.runId !== at.pass || event.step === undefined || event.paused) return false;
  const newest = at.latest?.get(positionKey(event));
  return event.entry === undefined || newest === undefined || event.entry >= newest;
}

/** What crossed in each pause of the newest pass, by the 0-based step the pause stood before. */
export function pausesOf<T extends Crossing>(events: T[]): Map<number, T[]> {
  const { pass } = passOf(events);
  const pauses = new Map<number, T[]>();
  for (const event of events) {
    if (!event.paused || event.runId !== pass || event.step === undefined || event.within?.length) continue;
    pauses.set(event.step, [...(pauses.get(event.step) ?? []), event]);
  }
  return pauses;
}

/** Every crossing of the newest pass, by the step it is placed on; the gutter at the step count. */
export function placePass<T extends Crossing>(events: T[], placements: Record<string, number> | undefined, stepCount: number): Map<number, T[]> {
  const at = passOf(events);
  const ran = new Map<number, T[]>();
  for (const event of events) {
    const placed = placementOf(event, at, placements, stepCount);
    if (placed) ran.set(placed.step, [...(ran.get(placed.step) ?? []), event]);
  }
  return ran;
}

/** One kind a step produced, against the recording of its kind there. */
export interface KindVerdict<T extends Crossing = Crossing> {
  kind: string;
  /** The newest crossing of the kind, whose payload was compared. */
  event: T;
  recorded?: KindCount;
  /** Absent while the payload a verdict needs is still being read. */
  verdict?: Verdict;
  reasons: string[];
}

export interface StepVerdicts<T extends Crossing = Crossing> {
  kinds: Array<KindVerdict<T>>;
  /** Recorded kinds the step did not produce, an ignored kind left out. */
  missing: Array<{ kind: string; recorded: KindCount }>;
}

/**
 * One step's crossings against its recording.
 *
 * An ignored crossing is listed and compared with nothing; a recorded kind an
 * ignore rule covers is not missing. `bodyOf` returns the payload a kind is
 * compared on, or undefined while it is still being read.
 */
export function compareStep<T extends Crossing>(input: {
  recorded: Record<string, KindCount>;
  ran: T[];
  step: number;
  ignores: HiddenKind[];
  expected?: Record<string, ExpectedValue>;
  bodyOf: (event: T) => string | undefined;
  /** A crossing whose payload shape a person ruled background or unknown, which no step owns. */
  ruledOut?: (event: T) => boolean;
}): StepVerdicts<T> {
  const ran = input.ruledOut ? input.ran.filter(event => !input.ruledOut!(event)) : input.ran;
  const observed = countKinds(ran);
  const newest = new Map<string, T>();
  for (const event of ran) {
    if (input.ignores.some(rule => ignoreMatches(rule, event as unknown as BoundaryEvent))) continue;
    const kind = kindOf(event);
    const standing = newest.get(kind);
    if (!standing || event.at >= standing.at) newest.set(kind, event);
  }
  const kinds = [...newest].map(([kind, event]) => {
    const recorded = input.recorded[kind];
    const read = verdictOf(recorded, observed[kind] ?? { n: 0 }, input.bodyOf(event), input.expected?.[kind], event.kind === 'write', crossedOf(event));
    return {
      kind, event, reasons: read?.reasons ?? [],
      ...(recorded ? { recorded } : {}),
      ...(read ? { verdict: read.verdict } : {}),
    };
  });
  const missing = Object.entries(input.recorded)
    .filter(([kind]) => !observed[kind] && !input.ignores.some(rule => ignoreCoversKind(rule, kind, input.step)))
    .map(([kind, recorded]) => ({ kind, recorded }));
  return { kinds, missing };
}

/**
 * A step's crossings as its recording keeps them: counted by kind, with the
 * payload of the last of each kind, which a later run's row is compared on.
 */
export function recordKinds<T extends Crossing>(events: T[], bodyOf: (event: T) => string | undefined, cap: number): Record<string, KindCount> {
  const kinds = countKinds(events);
  for (const event of events) {
    const count = kinds[kindOf(event)];
    if (!count || count.presence) continue;
    // A document's content changes with every build and a binary body is
    // never decoded, so neither is stored to compare against.
    const crossed = crossedOf(event);
    if (crossed.payloadClass === 'document' || crossed.payloadClass === 'binary') delete count.body;
    else {
      const body = bodyOf(event);
      if (body !== undefined) count.body = body.slice(0, cap);
    }
    if (crossed.sent !== undefined) count.sent = crossed.sent.slice(0, cap);
    if (crossed.band !== undefined) count.band = crossed.band;
  }
  return kinds;
}
