import { useRef, useState } from 'preact/hooks';
import type { SequenceStep } from '../wire.js';

/**
 * How many times slower every step animation plays: `?motion=4` on the bench
 * URL, kept for later loads, and `?motion=1` back to normal. The stylesheet
 * reads the same factor through `--motion`, so its durations and these waits
 * stay in step.
 */
const MOTION = (() => {
  try {
    const asked = new URLSearchParams(location.search).get('motion');
    if (asked !== null) localStorage.setItem('bench-motion', asked);
    const factor = Number(localStorage.getItem('bench-motion') ?? 1);
    return factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
})();
document.documentElement.style.setProperty('--motion', String(MOTION));

/** How long one step number pulses, and how far behind the one before it each starts. */
export const RIPPLE_PULSE_MS = 1050 * MOTION;
export const RIPPLE_STEP_MS = 240 * MOTION;
/** The rows folding, the gap parting, and a step entering or leaving it. */
const FOLD_MS = 380 * MOTION;
const PART_MS = 240 * MOTION;
const ENTER_MS = 420 * MOTION;
/** The steps below a change sliding from where they stood to where they now stand. */
const SLIDE_MS = 320 * MOTION;
/** The pulse a landed step holds, which a short renumbering would otherwise cut. */
const LANDED_MS = 1400 * MOTION;

/**
 * A change to the step list, as positions. `was` maps each renumbered step's
 * new position to its old one; entering steps have no old position and leaving
 * steps no new one, so each is listed on its own side.
 */
export interface Shift {
  was: ReadonlyMap<number, number>;
  /** New positions of steps that were not in the list before. */
  entering: number[];
  /** Old positions of steps that are not in the list after. */
  leaving: number[];
  /** The new position of the one step that was moved. */
  landed?: number;
  /** Where a fold set on an old position stands after the change; undefined when its step left. */
  place: (old: number) => number | undefined;
}

/** `count` steps from `from` on moved together, the first landing at `to`. */
export function moveShift(from: number, to: number, count = 1): Shift {
  const place = (old: number) => {
    if (old >= from && old < from + count) return to + (old - from);
    // Where it stands among the steps that did not move, then past the run where it lands.
    const among = old < from ? old : old - count;
    return among < to ? among : among + count;
  };
  const was = new Map<number, number>();
  for (let old = Math.min(from, to); old < Math.max(from, to) + count; old++) was.set(place(old), old);
  return { was, entering: [], leaving: [], landed: to, place };
}

/** `count` steps put in at `at` when positive, taken out from `at` when negative. */
export function spliceShift(at: number, count: number, length: number): Shift {
  const span = Math.abs(count);
  const place = (old: number) => old < at ? old
    : count > 0 ? old + count
    : old < at + span ? undefined : old - span;
  const was = new Map<number, number>();
  for (let now = at + Math.max(0, count); now < length; now++) was.set(now, now - count);
  const run = Array.from({ length: span }, (_, k) => at + k);
  return { was, entering: count > 0 ? run : [], leaving: count < 0 ? run : [], place };
}

/**
 * Where a poll's steps gained or lost one run of steps: the first position
 * whose label changed, and how many went in (positive) or came out (negative),
 * when every step after them is the old list shifted. Undefined for a move, an
 * edit, or a change that is not one contiguous run.
 */
export function spliceIn(was: SequenceStep[], now: SequenceStep[]): { at: number; count: number } | undefined {
  const count = now.length - was.length;
  if (count === 0) return undefined;
  const [longer, shorter] = count > 0 ? [now, was] : [was, now];
  const span = Math.abs(count);
  let at = 0;
  while (at < shorter.length && shorter[at].label === longer[at].label) at++;
  for (let k = at; k < shorter.length; k++) {
    if (shorter[k].label !== longer[k + span].label) return undefined;
  }
  return { at, count };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** A step's marker, which slides when the step moves. */
const SLIDING = '.mark[data-step]';
const stepOf = (element: HTMLElement) => Number(element.dataset.step);

/** Where each step's marker and lines stand, by step position and kind. */
function standing(): Map<string, number> {
  const tops = new Map<string, number>();
  for (const element of document.querySelectorAll<HTMLElement>(SLIDING)) {
    tops.set(`${element.dataset.step !== undefined ? 'mark' : 'why'}|${stepOf(element)}`, element.getBoundingClientRect().top);
  }
  return tops;
}

/**
 * The list redrawn on the change jumps every step below it by a row's height.
 * Each is put back where it stood, then let go, so the steps slide into their
 * new places rather than appear there.
 */
function slide(before: Map<string, number>, place: (old: number) => number | undefined) {
  const from = new Map<string, number>();
  for (const [id, top] of before) {
    const [kind, old] = id.split('|');
    const now = place(Number(old));
    if (now !== undefined) from.set(`${kind}|${now}`, top);
  }
  const moved: HTMLElement[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(SLIDING)) {
    const top = from.get(`${element.dataset.step !== undefined ? 'mark' : 'why'}|${stepOf(element)}`);
    const offset = top === undefined ? 0 : top - element.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    element.style.transition = 'none';
    element.style.translate = `0 ${offset}px`;
    moved.push(element);
  }
  if (!moved.length) return;
  void document.body.offsetHeight;
  for (const element of moved) {
    element.style.transition = `translate ${SLIDE_MS}ms ease-in-out`;
    element.style.translate = '';
  }
  setTimeout(() => { for (const element of moved) element.style.transition = ''; }, SLIDE_MS);
}

/**
 * One path for every change to the step list - an arrow, a drag, a step put in
 * or taken out from anywhere - so each plays the same way: the rows fold, the
 * gap parts or the step leaves, the change lands, the numbers after it swap
 * over in turn from the lowest, and the rows open back out.
 */
export function useStepMotion(setFolded: (update: (was: ReadonlySet<number>) => ReadonlySet<number>) => void) {
  // Every step's rows held folded while a change plays, on top of the folds set by hand.
  const [settling, setSettling] = useState(false);
  const [split, setSplit] = useState<{ above?: number; below?: number; from?: number } | null>(null);
  const [shift, setShift] = useState<{ shift: Shift; phase: 'leaving' | 'settled' } | null>(null);
  // The row under the pointer after a change holds another step; its tools
  // stay down until the pointer leaves it.
  const [quietAt, setQuietAt] = useState<number | null>(null);
  const playing = useRef(false);

  const play = async ({ shift: next, fold, part, apply }: {
    shift: Shift;
    /** Fold every step's rows first and wait for them to close; hold them folded
     *  without waiting when a drag has folded them already; or leave them be. */
    fold: 'fold' | 'hold' | 'none';
    /** The markers either side of the gap to part before the change lands. */
    part?: { above?: number; below?: number; from?: number };
    /** Makes the change and brings the list that holds it. */
    apply: () => Promise<void> | void;
  }) => {
    playing.current = true;
    if (fold !== 'none') setSettling(true);
    if (fold === 'fold') await pause(FOLD_MS);
    if (part) {
      setSplit(part);
      await pause(PART_MS);
    }
    if (next.leaving.length) {
      setShift({ shift: next, phase: 'leaving' });
      await pause(ENTER_MS);
    }
    const before = standing();
    await apply();
    setSplit(null);
    setFolded(was => new Set([...was].map(next.place).filter((at): at is number => at !== undefined)));
    setShift({ shift: next, phase: 'settled' });
    if (next.landed !== undefined) setQuietAt(next.landed);
    await painted();
    slide(before, next.place);
    await pause(Math.max(next.landed !== undefined ? LANDED_MS : 0,
      (next.entering.length ? ENTER_MS : 0) + RIPPLE_PULSE_MS + next.was.size * RIPPLE_STEP_MS));
    setShift(null);
    setSettling(false);
    playing.current = false;
  };

  const settled = shift?.phase === 'settled' ? shift.shift : undefined;
  const order = settled ? [...settled.was.keys()].sort((a, b) => a - b) : [];
  const wasAt = (index: number) => settled?.was.get(index);

  return {
    play,
    /** A change is playing, or rows are held folded for one. */
    playing,
    settling,
    split,
    wasAt,
    quietAt,
    release: (index: number) => { if (quietAt === index) setQuietAt(null); },
    classesOf: (index: number) => [
      settled?.landed === index ? 'moved' : '',
      quietAt === index ? 'quiet' : '',
      split?.from === index ? 'dragged' : '',
      split?.above === index ? 'splitabove' : '',
      split?.below === index ? 'splitbelow' : '',
      wasAt(index) !== undefined ? 'renumbered' : '',
      settled?.entering.includes(index) ? 'entering' : '',
      shift?.phase === 'leaving' && shift.shift.leaving.includes(index) ? 'leaving' : '',
    ],
    styleOf: (index: number) => (settled && settled.was.has(index)
      ? {
        '--ripple-delay': `${(settled.entering.length ? ENTER_MS : 0) + order.indexOf(index) * RIPPLE_STEP_MS}ms`,
        '--ripple-pulse': `${RIPPLE_PULSE_MS}ms`,
      }
      : undefined),
  };
}
