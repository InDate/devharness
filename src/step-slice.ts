/**
 * A step's traffic as the observation log holds it: the observations stamped
 * to its history entry, as the crossings a comparison counts and as the slice
 * a recording keeps.
 *
 * One source for both sides of a comparison. A recording that gathered its
 * step from the proxy and the write watch by one filter, and a replay that
 * gathered it by another, reported drift where the app did nothing different;
 * read from the log, both sides count the same set by the same `recordKinds`.
 *
 * Only stamped observations count. One placed by time stands after the action
 * it followed and was caused by nothing that action did, and a pause's
 * crossings name no entry, so neither reaches a step's count.
 */
import { observationsIn, stampedOf, recordOf, type Observation, type ObservationKind } from './observation-log.js';
import { getProxy } from './proxy/registry.js';
import type { ProxyEvent } from './proxy/intercept-proxy.js';
import type { PageWrite, WriteMotion } from './write-watch.js';
import { recordKinds, type Crossing } from './bench/step-compare.js';
import type { KindCount } from './bench/kinds.js';
import type { BoundaryEvent } from './bench/wire.js';
import { writeKey, writeLine } from './write-watch.js';

/** One observation as a recording keeps it, timed from the start of its step. */
export interface SavedObservation {
  kind: ObservationKind;
  text: string;
  key: string;
  /** Milliseconds after the step began. */
  atMs: number;
  owned?: string;
  rule?: string;
  failed?: boolean;
  connection?: string;
  motion?: WriteMotion;
  /** The payload, capped: a response or frame body, or the value written. */
  body?: string;
}

interface Taken {
  observation: Observation;
  crossing: Crossing;
  body: string | undefined;
}

function isWrite(record: ProxyEvent | PageWrite): record is PageWrite {
  return 'store' in record;
}

/** The observations made on `connection`, each with its crossing and payload. */
function taken(observations: Observation[], connection: string | undefined): Taken[] {
  return observations.flatMap((observation): Taken[] => {
    if (connection !== undefined && observation.connection !== undefined && observation.connection !== connection) return [];
    const record = recordOf(observation);
    if (!record) return [];
    if (isWrite(record)) return [{ observation, crossing: writeCrossing(record), body: record.value }];
    const proxy = observation.connection ? getProxy(observation.connection) : undefined;
    return [{ observation, crossing: record, body: proxy?.bodyOf(record.id) }];
  });
}

/** The crossings stamped to `entry` on `connection`, with the payload a comparison reads of each. */
export function crossingsOf(entry: number, connection?: string): { crossings: Crossing[]; bodyOf: (crossing: Crossing) => string | undefined } {
  return crossingsAmong(taken(stampedOf(entry), connection));
}

/**
 * What arrived on `connection` from `from` up to `to`: a step a person's click
 * made while recording, which no History entry stands behind, is bounded by
 * the clicks either side of it.
 */
export function crossingsIn(from: number, to: number, connection: string): { crossings: Crossing[]; bodyOf: (crossing: Crossing) => string | undefined } {
  return crossingsAmong(taken(observationsIn(from, to), connection));
}

function crossingsAmong(all: Taken[]): { crossings: Crossing[]; bodyOf: (crossing: Crossing) => string | undefined } {
  const bodies = new Map(all.map(one => [one.crossing, one.body]));
  return { crossings: all.map(one => one.crossing), bodyOf: crossing => bodies.get(crossing) };
}

/** What `entry` crossed on `connection`, counted by kind as a recording stores it. */
export function kindsOf(entry: number, connection: string | undefined, cap: number): Record<string, KindCount> {
  const { crossings, bodyOf } = crossingsOf(entry, connection);
  return recordKinds(crossings, bodyOf, cap);
}

/** The observations of `entry` on `connection` as a recording keeps them, timed from `startedAt`. */
export function sliceOf(entry: number, connection: string | undefined, startedAt: number, cap: number): SavedObservation[] {
  return saved(taken(stampedOf(entry), connection), startedAt, cap);
}

/** What arrived on `connection` from `from` up to `to`, as a recording keeps it. */
export function sliceIn(from: number, to: number, connection: string, cap: number): SavedObservation[] {
  return saved(taken(observationsIn(from, to), connection), from, cap);
}

function saved(all: Taken[], startedAt: number, cap: number): SavedObservation[] {
  return all.map(({ observation: one, body }) => ({
    kind: one.kind, text: one.text, key: one.key, atMs: Math.max(0, Math.round(one.at - startedAt)),
    ...(one.owned ? { owned: one.owned } : {}),
    ...(one.rule ? { rule: one.rule } : {}),
    ...(one.failed ? { failed: true } : {}),
    ...(one.connection ? { connection: one.connection } : {}),
    ...(one.motion ? { motion: one.motion } : {}),
    ...(body !== undefined ? { body: body.slice(0, cap) } : {}),
  }));
}

/** A page write as a row and a comparison read it, stamped with the step its cursor names. */
export function writeCrossing(write: PageWrite): BoundaryEvent {
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
  return { ...row, ...(write.cursor?.kind === 'command' ? { commandIndex: write.cursor.index } : {}) } as BoundaryEvent;
}
