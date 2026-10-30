/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';

/**
 * Which browser of the bench connection's group the tabs read: a member's
 * name, or null for every browser. Held in the address under `browser`, so a
 * reload and Back return the same reading; held here as well, since the
 * header sets it and every tab reads it.
 */
let chosen: string | null = new URLSearchParams(location.search).get('browser') || null;
const listeners = new Set<(choice: string | null) => void>();

export function browserChoice(): string | null {
  return chosen;
}

/**
 * Sets the choice. `push` adds an address entry for it, as a move between
 * tabs does; `replace` rewrites the current entry; `none` leaves the address,
 * for a choice read back from it.
 */
export function setBrowserChoice(next: string | null, address: 'push' | 'replace' | 'none' = 'push'): void {
  if (next === chosen) return;
  chosen = next;
  if (address !== 'none') {
    const query = new URLSearchParams(location.search);
    if (next) query.set('browser', next); else query.delete('browser');
    const search = query.toString();
    const url = `${location.pathname}${search ? `?${search}` : ''}`;
    if (address === 'push') history.pushState(null, '', url); else history.replaceState(null, '', url);
  }
  for (const listener of listeners) listener(next);
}

/** Reads the choice back from the address, after Back or Forward moved it. */
export function readBrowserChoice(): void {
  setBrowserChoice(new URLSearchParams(location.search).get('browser') || null, 'none');
}

export function useBrowserChoice(): string | null {
  const [choice, setChoice] = useState(chosen);
  useEffect(() => {
    listeners.add(setChoice);
    setChoice(chosen);
    return () => { listeners.delete(setChoice); };
  }, []);
  return choice;
}

/**
 * The `browser` query a boundary read takes: the chosen member, `*` for every
 * member, or nothing where `ownWhenAll` holds and every browser is chosen,
 * which reads the bench's own browser alone.
 */
export function browserQuery(choice: string | null, ownWhenAll = false): string {
  if (choice) return `&browser=${encodeURIComponent(choice)}`;
  return ownWhenAll ? '' : '&browser=*';
}
