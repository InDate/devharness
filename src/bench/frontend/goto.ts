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
    there.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  asked = id;
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
