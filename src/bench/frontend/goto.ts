import { useEffect, useRef } from 'preact/hooks';

/**
 * A section a go-to asked for that was not on screen when asked.
 *
 * A go-to switches tab and names a section of it; the section exists only
 * once the tab has drawn. Held here, it is taken by the section itself as it
 * mounts, so the scroll follows the render rather than a guess at its timing.
 */
let asked: string | null = null;

/** Scroll to the section now where it is on screen, or as it mounts where it is not. */
export function goToSection(id: string): void {
  const there = document.getElementById(id);
  if (there) {
    asked = null;
    there.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  asked = id;
}

/**
 * Ask for a section on a tab about to be shown. Not scrolled now: the tab
 * being left can hold an element of the same id, such as a crossing History
 * lists under the call that caused it.
 */
export function askSection(id: string): void {
  asked = id;
}

/** The section a go-to is waiting on; a list that resolves it to another id asks again with `goToSection`. */
export function askedSection(): string | null {
  return asked;
}

/**
 * Scroll to an asked-for element once a list draws it. A list whose items
 * appear on a later render than the one that mounted it - the steps, read in
 * after the tab opens - calls this on every render; it acts once, on the
 * render the element exists in.
 */
export function useGoToAnyTarget(): void {
  useEffect(() => {
    if (!asked) return;
    const there = document.getElementById(asked);
    if (!there) return;
    asked = null;
    there.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

/** The ref a section named `id` carries, which scrolls it into view on mount when a go-to asked for it. */
export function useGoToTarget<T extends HTMLElement>(id: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (asked !== id) return;
    asked = null;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  return ref;
}

/** The nearest ancestor that scrolls its content, or null where the page itself scrolls. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/**
 * Scroll the element of this id to the middle of the pane that holds it, where
 * any part of it lies outside that pane; one wholly in view stays where it is,
 * so a person reading near it is not moved.
 */
export function bringOnScreen(id: string): void {
  requestAnimationFrame(() => {
    const there = document.getElementById(id);
    if (!there) return;
    const box = there.getBoundingClientRect();
    const scroller = scrollerOf(there);
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (box.top >= view.top && box.bottom <= view.bottom) return;
    there.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
