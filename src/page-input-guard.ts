/**
 * The page's guard of a person's input, put in before the app's first script.
 *
 * A screen hold stops page time and leaves the page's main thread running, so
 * the screen keeps painting, the picker keeps outlining, and reads keep
 * matching what is shown. A running main thread also hands a person's click
 * or key to the app, which would change the state the hold stands on. This
 * guard is the first listener the page has, on the window in the capture
 * phase, and while the screen is held it stops every trusted input before an
 * app listener runs: clicks, keys and pointer events lose their default as
 * well, while wheel and scroll keep theirs, so the page scrolls for looking
 * around and no app scroll handler sees it. Chrome's picker takes its click in
 * the browser, before the page, so picking passes untouched; Chrome's own
 * `Input.setIgnoreInputEvents` dropped the picker's hover and pick with the
 * rest (26 Oct, `page-side-input-guard-spares-picker`).
 *
 * Taking the hold cuts a smooth scroll where it stands, which a running main
 * thread commits to the screen. A person who scrolls to look around moves the
 * page under an app whose scroll handlers never ran, so the release puts the
 * page back where it stood before their first scroll; a page nobody scrolled
 * stays where it is, since the cut can land frames after the hold is taken.
 */

/** Where the guard's controls stand on the page's global, out of the app's way. */
export const INPUT_GUARD_KEY = 'devharness.input';

function installPageInputGuard(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.input')]) return;

  const GUARDED = [
    'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'wheel', 'scroll',
  ];
  const KEEPS_DEFAULT = new Set(['wheel', 'scroll']);
  // Input that scrolls the page; its first event arrives before the scroll it causes.
  const SCROLLS = new Set(['wheel', 'touchmove', 'keydown']);

  let held = false;
  let heldAt: { x: number; y: number } | undefined;
  let stopped: Record<string, number> = {};

  const guard = (event: any) => {
    if (!held || !event.isTrusted) return;
    if (!heldAt && SCROLLS.has(event.type)) heldAt = { x: g.scrollX, y: g.scrollY };
    stopped[event.type] = (stopped[event.type] || 0) + 1;
    event.stopImmediatePropagation();
    if (!KEEPS_DEFAULT.has(event.type) && event.cancelable) event.preventDefault();
  };
  // Registered as devharness's own, so the trigger tracker leaves it unwrapped.
  const tracker = g[Symbol.for('devharness.trigger')];
  for (const type of GUARDED) g.addEventListener(type, tracker?.own ? tracker.own(guard) : guard, { capture: true, passive: false });

  const scrollTo = (at: { x: number; y: number }) => {
    const hold = () => g.scrollTo({ left: at.x, top: at.y, behavior: 'instant' });
    try { if (tracker?.quietly) tracker.quietly(hold, 'hold'); else hold(); } catch { /* a document with nothing to scroll */ }
  };

  g[Symbol.for('devharness.input')] = {
    /** Stop a person's input and cut any smooth scroll where it stands; answers where the page stands. */
    hold() {
      if (!held) {
        held = true;
        stopped = {};
        heldAt = undefined;
        scrollTo({ x: g.scrollX, y: g.scrollY });
      }
      return { x: g.scrollX, y: g.scrollY };
    },
    /** Let input through again, the page put back where it stood before a person scrolled it; answers what was stopped. */
    release() {
      if (!held) return null;
      held = false;
      if (heldAt) scrollTo(heldAt);
      heldAt = undefined;
      return { stopped };
    },
    state() { return { held, heldAt: heldAt ?? null, stopped }; },
  };
}

/** The guard as page source, run before the app's first script. */
export const PAGE_INPUT_GUARD_SOURCE = `(${installPageInputGuard.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
