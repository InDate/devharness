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
import { stampedOf, recordOf, type Observation, type ObservationKind } from './observation-log.js';
import { getProxy } from './proxy/registry.js';
import type { ProxyEvent } from './proxy/intercept-proxy.js';
import type { PageWrite, WriteMotion } from './write-watch.js';
import { recordKinds, type Crossing } from './bench/step-compare.js';
import type { KindCount } from './bench/kinds.js';
import { writeCrossing } from './bench-mode/traffic.js';

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

/** The stamped observations of `entry` made on `connection`, each with its crossing and payload. */
function taken(entry: number, connection: string | undefined): Taken[] {
  return stampedOf(entry).flatMap((observation): Taken[] => {
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
  const all = taken(entry, connection);
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
  return taken(entry, connection).map(({ observation: one, body }) => ({
    kind: one.kind, text: one.text, key: one.key, atMs: Math.max(0, Math.round(one.at - startedAt)),
    ...(one.owned ? { owned: one.owned } : {}),
    ...(one.rule ? { rule: one.rule } : {}),
    ...(one.failed ? { failed: true } : {}),
    ...(one.connection ? { connection: one.connection } : {}),
    ...(one.motion ? { motion: one.motion } : {}),
    ...(body !== undefined ? { body: body.slice(0, cap) } : {}),
  }));
}
