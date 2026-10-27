import type { ProxyCursor } from './proxy/intercept-proxy.js';

/**
 * Where the input at the head of a chain stands in History.
 *
 * The page's trigger tracker gives each input an id and carries it down the
 * chain the input starts - timers, frames, replies, animations and their
 * ends - so a motion reports the id of the input that started it. A driven
 * input carries the step devharness dispatched it under, set in the page
 * around the dispatch. A person's input carries none: the person watch
 * reports the id with the input, and the History entry it becomes names it.
 * A motion is then credited by the identity of its cause, not by when its
 * report arrives, which no pacing of the steps moves.
 */
export interface PageRoot { id: string; step?: string }

const named = new Map<string, ProxyCursor>();
const KEPT = 2000;
const listeners = new Set<(id: string, cursor: ProxyCursor) => void>();

/** The step a root stands for: the one it was driven under, else the History entry it was named as. */
export function rootCursor(root: PageRoot | undefined): ProxyCursor | undefined {
  if (!root) return undefined;
  if (root.step) {
    try { return JSON.parse(root.step) as ProxyCursor; } catch { /* a step this build did not write */ }
  }
  return named.get(root.id);
}

/** The cursor a driven input's root carries, written into the page around its dispatch. */
export function stepToken(cursor: ProxyCursor | undefined): string | undefined {
  return cursor ? JSON.stringify(cursor) : undefined;
}

/** A person's input recorded in History: its root takes that entry, and what it started already is credited again. */
export function nameRoot(id: string, cursor: ProxyCursor): void {
  named.set(id, cursor);
  if (named.size > KEPT) named.delete(named.keys().next().value as string);
  for (const listener of listeners) listener(id, cursor);
}

/** Called with each root a person's input names; returns the unsubscribe. */
export function onRootNamed(listener: (id: string, cursor: ProxyCursor) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
