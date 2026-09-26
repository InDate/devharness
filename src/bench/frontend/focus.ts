import { useEffect, useState } from 'preact/hooks';
/**
 * A rule the proxy panel asked to see on its traffic row.
 *
 * The panel lives in the footing and the rows on STEPS, which may not be
 * mounted when the panel asks: it switches to STEPS in the same click. So the
 * request is held until a listener takes it, and taken once.
 */
export interface RuleFocus {
  key: string;
  step?: number;
}

let held: RuleFocus | null = null;
const listeners = new Set<(focus: RuleFocus) => void>();

export function focusRule(focus: RuleFocus): void {
  held = focus;
  for (const listener of listeners) listener(focus);
}

/** Subscribe; a request made before subscribing is delivered at once. Returns the unsubscribe. */
export function onFocusRule(listener: (focus: RuleFocus) => void): () => void {
  listeners.add(listener);
  if (held) listener(held);
  return () => { listeners.delete(listener); };
}

/** Mark the request as met, so a later mount does not reopen it. */
export function settleFocus(): void {
  held = null;
}

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
