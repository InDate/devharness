/**
 * A call that redoes one already in this session's history.
 *
 * History holds every call with its index, and `run repeat` runs one again
 * from it - its recorded arguments, so nothing is retyped and nothing drifts
 * from what ran. A session that retypes the call pays its arguments again in
 * output. The first such redo of a session names the entry it repeats and
 * the repeat call that does the same, with `params` carrying the fields that
 * changed where only a few did.
 */
import type { HistoryCommand } from './command-recorder.js';
import { withOnce } from './messages.js';

/** Calls shorter than this cost no more to retype than the repeat call does. */
const MIN_ARGS_CHARS = 80;
/** A changed value counts as an edit of the earlier one only this close to it. */
const SIMILAR = 0.8;
/** Most fields an edit changes and still reads as a redo. */
const MAX_CHANGED = 2;

export interface Redo {
  /** The history index the call repeats. */
  index: number;
  /** The fields whose value differs from that entry, each with this call's value; empty for an exact redo. */
  changed: Record<string, unknown>;
}

/** How alike two strings are, 0 to 1, from their longest common prefix and suffix against the longer. */
function likeness(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (head + tail) / longest;
}

/**
 * The latest earlier entry this call redoes: the same tool, the same fields,
 * and every value equal or, for up to two fields, an edit of the earlier one.
 * Undefined for a short call, or one no entry matches.
 */
export function findRedo(history: HistoryCommand[], tool: string, params: Record<string, unknown>, index: number): Redo | undefined {
  if (JSON.stringify(params).length < MIN_ARGS_CHARS) return undefined;
  const keys = Object.keys(params).sort().join(',');
  const earlier = history.filter(entry => entry.index < index && entry.tool === tool).sort((a, b) => b.index - a.index);
  for (const entry of earlier) {
    const recorded = entry.params ?? {};
    if (Object.keys(recorded).sort().join(',') !== keys) continue;
    const changed: Record<string, unknown> = {};
    let close = true;
    for (const key of Object.keys(params)) {
      const now = JSON.stringify(params[key]);
      const then = JSON.stringify(recorded[key]);
      if (now === then) continue;
      changed[key] = params[key];
      if (likeness(now, then) < SIMILAR) close = false;
    }
    if (close && Object.keys(changed).length <= MAX_CHANGED) return { index: entry.index, changed };
  }
  return undefined;
}

/** The repeat call that does what a redo did. */
export function repeatCall(redo: Redo): string {
  const fields = Object.keys(redo.changed).length ? `, params: ${JSON.stringify(redo.changed)}` : '';
  return `run({ action: 'repeat', indices: [${redo.index}]${fields} })`;
}

/** The note the session's first redo carries; empty for any later one, or where the call redoes nothing. */
export function redoNote(history: HistoryCommand[], tool: string, params: Record<string, unknown>, index: number): string {
  const redo = findRedo(history, tool, params, index);
  if (!redo) return '';
  return withOnce('', 'REDO_NAMES_REPEAT', { index: redo.index, call: repeatCall(redo) }).trim();
}
