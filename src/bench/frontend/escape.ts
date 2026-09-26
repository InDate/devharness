import { useEffect, useRef } from 'preact/hooks';

/**
 * Escape closes the thing opened last.
 *
 * Every open row, panel and dialog registers while it is open, and one Escape
 * closes only the newest: a panel opened over an open row closes first, and
 * the row on the next press. In a text field Escape leaves the field instead,
 * so a half-typed value is never discarded along with what holds it.
 */
const open: Array<() => void> = [];
let listening = false;

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
    target.blur();
    return;
  }
  const newest = open[open.length - 1];
  if (!newest) return;
  e.preventDefault();
  newest();
}

/** While `active`, Escape runs `close` - once it is the newest thing open. */
export function useEscape(active: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active) return;
    if (!listening) {
      addEventListener('keydown', onKey);
      listening = true;
    }
    const entry = () => latest.current();
    open.push(entry);
    return () => {
      const at = open.lastIndexOf(entry);
      if (at >= 0) open.splice(at, 1);
    };
  }, [active]);
}
