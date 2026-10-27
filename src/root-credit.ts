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

/**
 * Whether each root still has work outstanding in the page: callbacks
 * scheduled under it, replies and body reads, animations and motion runs.
 * The page reports each change between open and settled; a History entry has
 * settled once every root credited to it has, and what the step caused has
 * then all landed. A root the page never reported open started nothing.
 */
const roots = new Map<string, { root: PageRoot; connection: string; open: boolean }>();
const settledListeners = new Set<(entry: number) => void>();
/** Per browser: what drains the reports already received before a settle is announced. */
const gates = new Map<string, () => Promise<void>>();

function entryOf(cursor: ProxyCursor | undefined): number | undefined {
  return cursor?.kind === 'command' ? cursor.index : cursor?.kind === 'replay' ? cursor.entry : undefined;
}

/** The page reported `root` open or settled on `connection`. */
export function noteRoot(connection: string, root: PageRoot, open: boolean): void {
  roots.set(root.id, { root, connection, open });
  if (roots.size > KEPT) {
    for (const [id, held] of roots) { if (!held.open) { roots.delete(id); break; } }
  }
  if (open) return;
  const entry = entryOf(rootCursor(root));
  if (entry === undefined || !entrySettled(entry)) return;
  void (gates.get(connection)?.() ?? Promise.resolve()).catch(() => undefined).then(() => {
    if (!entrySettled(entry)) return;
    for (const listener of settledListeners) listener(entry);
  });
}

/** Whether every root credited to `entry` has settled. */
export function entrySettled(entry: number): boolean {
  for (const held of roots.values()) {
    if (held.open && entryOf(rootCursor(held.root)) === entry) return false;
  }
  return true;
}

/** Called with each entry as its last open root settles; returns the unsubscribe. */
export function onEntrySettled(listener: (entry: number) => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

/** What drains `connection`'s reports already received, run before a settle there is announced. */
export function setSettleGate(connection: string, drain: () => Promise<void>): () => void {
  gates.set(connection, drain);
  return () => { if (gates.get(connection) === drain) gates.delete(connection); };
}

/** Resolves true once every root credited to `entry` has settled, or false at `boundMs` with one still open. */
export function whenSettled(entry: number, boundMs: number): Promise<boolean> {
  if (entrySettled(entry)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { stop(); resolve(false); }, boundMs);
    const stop = onEntrySettled(settled => {
      if (settled !== entry) return;
      clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}
