import { useEffect, useState } from 'preact/hooks';

/**
 * A saved response a traffic row asked to see in the proxy panel.
 *
 * The panel is the footing's, and the row is inside a tab, so the request
 * crosses as a window event: the footing opens the panel on it and the panel
 * opens that response.
 */
export function revealResponse(key: string): void {
  window.dispatchEvent(new CustomEvent('bench:reveal-response', { detail: key }));
}

/** Subscribe; returns the unsubscribe. */
export function onRevealResponse(listener: (key: string) => void): () => void {
  const heard = (event: Event) => listener(String((event as CustomEvent).detail ?? ''));
  window.addEventListener('bench:reveal-response', heard);
  return () => window.removeEventListener('bench:reveal-response', heard);
}

/**
 * Whether hidden traffic is listed after all, dimmed. Held here rather than
 * in a tab: the footing's button sets it and every list reads it, while
 * recording as much as while reading a run.
 */
let showingHidden = false;
const hiddenListeners = new Set<(on: boolean) => void>();

export function setShowHidden(on: boolean): void {
  showingHidden = on;
  for (const listener of hiddenListeners) listener(on);
}

export function useShowHidden(): boolean {
  const [on, setOn] = useState(showingHidden);
  useEffect(() => {
    hiddenListeners.add(setOn);
    return () => { hiddenListeners.delete(setOn); };
  }, []);
  return on;
}
