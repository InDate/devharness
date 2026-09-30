/**
 * Whether the variables at the head of the Sequence tab list their rows.
 *
 * The footing's variables button sets it and the Sequence tab reads it: they are
 * separate components, and the button is on screen on every tab.
 */
import { useEffect, useState } from 'preact/hooks';

let hidden = false;
const listeners = new Set<(hidden: boolean) => void>();

export function toggleVariables(): void {
  hidden = !hidden;
  for (const listener of listeners) listener(hidden);
}

/** Whether the rows are hidden, redrawn as the button changes it; `onToggle` runs on each change. */
export function useVariablesHidden(onToggle?: (hidden: boolean) => void): boolean {
  const [now, setNow] = useState(hidden);
  useEffect(() => {
    const listener = (next: boolean) => { setNow(next); onToggle?.(next); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return now;
}
