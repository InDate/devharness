/** @jsxImportSource preact */
import type preact from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Glyph } from './glyph.js';

/**
 * One line in a step's list, whatever it lists: a crossing, a recorded kind
 * this run did not produce, a note.
 *
 * Every column sits at the same place on every row - where it went, which
 * way, what it was, and at the right end what came of it - so a column reads
 * down the list. The actions take the right end's place on pointing, in fixed
 * slots: an action a row does not have leaves its slot empty rather than
 * closing up, so each action is found at the same place on every row. The
 * swap changes what is visible and nothing's size, so no line moves.
 */
export interface RowSlots {
  /** Keep this kind out of the list, or list it again where it is hidden. */
  hide?: () => void;
  rename?: () => void;
  /** Take a capture for this row, where it can carry one. */
  capture?: () => void;
  send?: () => void;
  up?: () => void;
  down?: () => void;
  remove?: () => void;
}

/** What each slot says on pointing, for the rows whose remove means something narrower. */
export interface RowSlotTitles {
  remove?: string;
  send?: string;
  rename?: string;
  capture?: string;
  up?: string;
  down?: string;
  hide?: string;
}

/** The slots in their order; a mark is a glyph's name, or the text drawn in its place. */
const SLOTS: Array<{ key: keyof RowSlots; glyph?: string; text?: string; title: string }> = [
  { key: 'remove', glyph: 'cross', title: 'remove this' },
  { key: 'hide', glyph: 'eyeoff', title: 'hide this kind of traffic from the list' },
  { key: 'rename', glyph: 'pen', title: 'name this' },
  { key: 'capture', glyph: 'capture', title: 'take a capture for this' },
  { key: 'send', glyph: 'arrow', title: 'hand this to the session' },
  { key: 'up', glyph: 'up', title: 'list this under the step above, on every run' },
  { key: 'down', glyph: 'down', title: 'list this under the step below, on every run' },
];

export function Row({
  id, classes, source, sourceTitle, way, label, title, reading, slots, titles, open, onOpen,
  onMenu, onEnter, onLeave, extra, more, columns, glyphs, children,
}: {
  /** A slot's mark where this row's differs, such as an open eye on a hidden row. */
  glyphs?: Partial<Record<keyof RowSlots, string>>;
  /**
   * The slots this row's list uses, in their fixed order. A list whose rows
   * only ever remove has one slot, not six with five empty beside the one in
   * use; a list whose rows differ keeps every slot any of them uses, so each
   * action stays in one column down the list. All six when absent.
   */
  columns?: Array<keyof RowSlots>;
  /** Actions a row has beyond the fixed slots, drawn ahead of them on pointing. */
  more?: preact.ComponentChildren;
  id?: string;
  classes: string[];
  /**
   * The first column: a method, a store, a socket, or Note. Absent, with no
   * `way`, the row has no such columns and its label takes the line from the
   * start - for a row that is not traffic and has no source to line up.
   */
  source?: preact.ComponentChildren;
  sourceTitle?: string;
  /** The direction a frame went, or nothing. */
  way?: string;
  /** What it was, and any tags on it, which take the width left over. */
  label: preact.ComponentChildren;
  title?: string;
  /** What came of it, at the right end, while the row is not pointed at. */
  reading: preact.ComponentChildren;
  slots: RowSlots;
  titles?: RowSlotTitles;
  open: boolean;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  /** Anything the screen wants after the line, such as an arrival note. */
  extra?: preact.ComponentChildren;
  /** The row opened. */
  children?: preact.ComponentChildren;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  // Sending shows it went: the session is told, and nothing else on the page
  // changes, so without this the arrow reads as doing nothing.
  const [sent, setSent] = useState(false);
  const sentTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  const run = (key: keyof RowSlots) => () => {
    slots[key]?.();
    if (key !== 'send') return;
    setSent(true);
    clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(false), 1600);
  };
  return (
    <li
      id={id}
      class={['crossed', 'listrow', ...classes, open ? 'open' : ''].filter(Boolean).join(' ')}
      onContextMenu={onMenu
        ? (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }
        : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div class={source === undefined && way === undefined ? 'crossedhead rowhead bare' : 'crossedhead rowhead'}
        onClick={onOpen} title={title}>
        {(source !== undefined || way !== undefined) && <>
          <span class="dir" title={sourceTitle}>{source}</span>
          <span class="way">{way ?? ''}</span>
        </>}
        <span class="rowlabel">{label}</span>
        <span class="rowright" style={{ minWidth: `${(columns ? columns.length : SLOTS.length) * 22}px` }}>
          <span class="rowreading">{reading}</span>
          <span class="rowactions" onClick={stop}
            style={{ gridTemplateColumns: `repeat(${columns ? columns.length : SLOTS.length}, 22px)` }}>
            {more}
            {SLOTS.filter(slot => !columns || columns.includes(slot.key)).map(slot => {
              if (!slots[slot.key]) return <span key={slot.key} class="slot" />;
              const done = slot.key === 'send' && sent;
              return (
                <button key={slot.key} class={done ? 'tool done' : 'tool'} aria-label={slot.key}
                  title={done ? 'sent to the session' : (titles as Record<string, string | undefined> | undefined)?.[slot.key] ?? slot.title}
                  onClick={run(slot.key)}>
                  {done ? <Glyph of="tick" /> : slot.glyph ? <Glyph of={glyphs?.[slot.key] ?? slot.glyph} /> : <span>{slot.text}</span>}
                </button>
              );
            })}
          </span>
        </span>
      </div>
      {extra}
      {open && children}
    </li>
  );
}

/**
 * A row's label as a box, while it is being renamed.
 *
 * Saved on Enter or on leaving the box, and only when it changed, so opening
 * it and moving on writes nothing. Escape leaves it as it was.
 */
export function LabelInput({ value, placeholder, onSave, onDone }: {
  value: string;
  placeholder?: string;
  onSave: (value: string) => void;
  onDone: () => void;
}) {
  // Held here while typed: the bench redraws with every poll, and a box fed
  // from the saved value would be reset under the keystrokes.
  const [draft, setDraft] = useState(value);
  // Escape leaves the box too, and the blur it causes would otherwise save.
  const dropped = useRef(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { box.current?.focus(); box.current?.select(); }, []);
  const commit = () => {
    if (!dropped.current && draft.trim() !== value) onSave(draft.trim());
    onDone();
  };
  return (
    <input
      ref={box}
      class="rename"
      value={draft}
      placeholder={placeholder}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onInput={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { dropped.current = true; (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

/**
 * A panel section that folds to its heading: the title, a count, and at the
 * right end what it holds in a line, so a folded section still reads.
 */
export function Fold({ title, count, summary, open: initially = true, level = 'section', children }: {
  title: preact.ComponentChildren;
  count?: number;
  summary?: preact.ComponentChildren;
  open?: boolean;
  /** A section of the panel, or a group inside one. */
  level?: 'section' | 'group';
  children: preact.ComponentChildren;
}) {
  const [open, setOpen] = useState(initially);
  return (
    <section class={level === 'section' ? 'panelsec fold' : 'foldgroup'}>
      <h3 class="opens" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="fold">{open ? '▾' : '▸'}</span>
        <span class="foldtitle">{title}</span>
        {count !== undefined && count > 0 && <span class="foldcount">{count}</span>}
        <span class="grow" />
        {summary !== undefined && <span class="secsummary">{summary}</span>}
      </h3>
      {open && children}
    </section>
  );
}
