/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Glyph } from './glyph.js';

/** What is drawn on a capture before it is saved, and the one that reshapes it. */
type Tool = 'pen' | 'box' | 'arrow' | 'crop';

/** A region of the capture, in the image's own pixels. */
interface Rect { x: number; y: number; w: number; h: number; }

/** The two corners a drag produced, as a rectangle with no negative sides. */
function rectOf(points: Array<{ x: number; y: number }>): Rect {
  const from = points[0];
  const to = points[points.length - 1];
  return {
    x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y),
  };
}

interface Mark {
  tool: Tool;
  points: Array<{ x: number; y: number }>;
}

/**
 * The capture being marked up, before it becomes a finding.
 *
 * The drawing is composited into the PNG on save rather than stored beside it:
 * what reaches whoever reads the file is the picture with the box around the
 * thing being pointed at, and a reader that knows nothing about marks still
 * sees them.
 */
export function Draft({
  shot, picked, onSave, onDiscard, onDropPick, onWiden, steps, filedAt, onStep,
}: {
  shot: { data: string; label: string; selector?: string; widen: number };
  /** An element pointed at while this capture was open; the note takes it too. */
  picked?: { tag: string; selector: string; text?: string } | null;
  onSave: (marked: string, words: string) => void;
  onDiscard: () => void;
  onDropPick?: () => void;
  /** Re-take an element capture with the crop widened to this many steps. */
  onWiden?: (widen: number) => void;
  /** The steps this capture can be filed against. */
  steps?: Array<{ index: number; label: string }>;
  /** The one it would land on as things stand. */
  filedAt?: number;
  onStep?: (step: number) => void;
}) {
  const [tool, setTool] = useState<Tool>('box');
  const [marks, setMarks] = useState<Mark[]>([]);
  // Held rather than applied on release: a crop discards what it cuts away,
  // and a stray drag would take part of the capture with it.
  const [crop, setCrop] = useState<Rect | null>(null);
  // The mark being drawn lives in a ref, not in state: a pointer move landing
  // in the same turn as the press would read a state that has not been applied
  // yet, and the start of every fast drag would be lost. State carries only
  // the repaint.
  const drawing = useRef<Mark | null>(null);
  const [, repaint] = useState(0);
  const [words, setWords] = useState('');
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);

  // Drawn at the image's own size, so a mark sits where it was put whatever
  // the column's width happens to be.
  useEffect(() => {
    const img = new Image();
    img.onload = () => { image.current = img; paint(); };
    img.src = `data:image/png;base64,${shot.data}`;
  }, [shot.data]);

  useEffect(paint, [marks, crop]);

  function paint() {
    const el = canvas.current;
    const img = image.current;
    if (!el || !img) return;
    el.width = img.naturalWidth;
    el.height = img.naturalHeight;
    const pen = el.getContext('2d');
    if (!pen) return;
    pen.drawImage(img, 0, 0);
    pen.lineWidth = Math.max(2, Math.round(img.naturalWidth / 400));
    pen.strokeStyle = '#e8453c';
    pen.fillStyle = '#e8453c';
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
    const held = drawing.current;
    const cutting = held?.tool === 'crop';
    for (const mark of cutting || !held ? marks : [...marks, held]) stroke(pen, mark);

    // What the capture would become: everything outside it dimmed, so the
    // region is read as what is kept rather than as another box drawn on it.
    const pending = cutting && held.points.length > 1 ? rectOf(held.points) : crop;
    if (pending && pending.w > 0 && pending.h > 0) {
      pen.save();
      pen.fillStyle = 'rgba(8, 10, 12, 0.62)';
      pen.beginPath();
      pen.rect(0, 0, el.width, el.height);
      pen.rect(pending.x, pending.y, pending.w, pending.h);
      pen.fill('evenodd');
      pen.strokeStyle = '#8ab4f8';
      pen.setLineDash([pen.lineWidth * 3, pen.lineWidth * 2]);
      pen.strokeRect(pending.x, pending.y, pending.w, pending.h);
      pen.restore();
    }
  }

  /**
   * Cut the capture down to the region held.
   *
   * The source image is replaced and the marks move with it, so a mark keeps
   * the thing it was put against and `undo` still reaches it. Compositing the
   * marks into the picture instead would bake them in at the crop.
   */
  function applyCrop() {
    const img = image.current;
    if (!img || !crop || crop.w < 8 || crop.h < 8) return;
    const off = document.createElement('canvas');
    off.width = Math.round(crop.w);
    off.height = Math.round(crop.h);
    const pen = off.getContext('2d');
    if (!pen) return;
    pen.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, off.width, off.height);
    const next = new Image();
    next.onload = () => { image.current = next; paint(); };
    next.src = off.toDataURL('image/png');
    setMarks(marks.map(mark => ({
      ...mark,
      points: mark.points.map(point => ({ x: point.x - crop.x, y: point.y - crop.y })),
    })));
    setCrop(null);
  }

  function stroke(pen: CanvasRenderingContext2D, mark: Mark) {
    const points = mark.points;
    if (points.length === 0) return;
    if (mark.tool === 'pen') {
      pen.beginPath();
      pen.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) pen.lineTo(point.x, point.y);
      pen.stroke();
      return;
    }
    const from = points[0];
    const to = points[points.length - 1];
    if (mark.tool === 'box') {
      pen.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
      return;
    }
    // An arrow says "this one" where a box says "this area", so the head is
    // drawn rather than left to the reader.
    pen.beginPath();
    pen.moveTo(from.x, from.y);
    pen.lineTo(to.x, to.y);
    pen.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(10, pen.lineWidth * 5);
    pen.beginPath();
    pen.moveTo(to.x, to.y);
    pen.lineTo(to.x - head * Math.cos(angle - 0.4), to.y - head * Math.sin(angle - 0.4));
    pen.lineTo(to.x - head * Math.cos(angle + 0.4), to.y - head * Math.sin(angle + 0.4));
    pen.closePath();
    pen.fill();
  }

  /** Pointer position in the image's own pixels, not the column's. */
  function at(e: PointerEvent): { x: number; y: number } {
    const el = canvas.current!;
    const box = el.getBoundingClientRect();
    return {
      x: (e.clientX - box.left) * (el.width / box.width),
      y: (e.clientY - box.top) * (el.height / box.height),
    };
  }

  return (
    <article class="draft">
      {/* The selector holds a row of its own: it is the only part of this head
          that runs to any length, and sharing a row with the controls pushes
          them about as it grows or wraps them onto a second line. */}
      <div class="draftname">{shot.label}</div>

      <div class="drafthead">
        {shot.selector && onWiden && (
          <div class="widen">
            <button
              class="tool"
              disabled={shot.widen === 0}
              title="crop back in"
              onClick={() => onWiden(Math.max(0, shot.widen - 1))}
            >−</button>
            <span class="quiet">{shot.widen ? `+${shot.widen} out` : 'the element'}</span>
            <button
              class="tool"
              title="take in more of what it sits in"
              onClick={() => onWiden(shot.widen + 1)}
            >+</button>
          </div>
        )}
        <span class="grow" />
        <div class="tools">
          {([
            ['box', 'draw a box around it'],
            ['arrow', 'point at it'],
            ['pen', 'draw on it freehand'],
            ['crop', 'cut the capture down to a region'],
          ] as Array<[Tool, string]>).map(([name, says]) => (
            <button
              key={name}
              class={tool === name ? 'tool on' : 'tool'}
              title={says}
              aria-label={name}
              onClick={() => setTool(name)}
            ><Glyph of={name} /></button>
          ))}
          <button class="tool" disabled={marks.length === 0}
            title="take back the last mark" aria-label="undo"
            onClick={() => setMarks(marks.slice(0, -1))}><Glyph of="undo" /></button>
          <button class="tool" disabled={marks.length === 0}
            title="take back every mark" aria-label="clear"
            onClick={() => setMarks([])}><Glyph of="clear" /></button>
        </div>
      </div>

      <div class="sheetwrap">
      <canvas
        class="sheet"
        ref={canvas}
        onPointerDown={(e: PointerEvent) => {
          (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
          drawing.current = { tool, points: [at(e)] };
          repaint(n => n + 1);
        }}
        onPointerMove={(e: PointerEvent) => {
          const held = drawing.current;
          if (!held) return;
          const point = at(e);
          held.points = held.tool === 'pen'
            ? [...held.points, point]
            : [held.points[0], point];
          paint();
        }}
        onPointerUp={() => {
          const held = drawing.current;
          drawing.current = null;
          if (!held || held.points.length < 2) { repaint(n => n + 1); return; }
          if (held.tool === 'crop') {
            const region = rectOf(held.points);
            setCrop(region.w >= 8 && region.h >= 8 ? region : null);
            return;
          }
          setMarks([...marks, held]);
        }}
      />
      {/* Placed at the region's own corner, in percentages of the image, so it
          stays on the region whatever width the canvas is drawn at. In the
          header row the eye has to leave the region to settle it. */}
      {crop && image.current && (
        <div
          class="cropsettle"
          style={{
            left: `${((crop.x + crop.w) / image.current.naturalWidth) * 100}%`,
            top: `${((crop.y + crop.h) / image.current.naturalHeight) * 100}%`,
          }}
        >
          <button class="tool on" title="cut it down to the region held"
            aria-label="crop to this" onClick={applyCrop}><Glyph of="tick" /></button>
          <button class="tool" title="leave the capture as it is"
            aria-label="cancel the crop" onClick={() => setCrop(null)}><Glyph of="cross" /></button>
        </div>
      )}
      </div>

      {picked && (
        <div class="picked">
          <span class="tag">{picked.tag}</span>
          <span class="selector">{picked.selector}</span>
          {onDropPick && (
            <button class="drop" title="keep the capture without the element" onClick={onDropPick}>×</button>
          )}
        </div>
      )}

      <textarea
        class="why"
        rows={2}
        value={words}
        placeholder="what's wrong here?"
        onInput={(e: Event) => setWords((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            onSave(canvas.current!.toDataURL('image/png').split(',')[1], words);
          }
        }}
      />
      <div class="draftfoot">
        {steps && steps.length > 0 && onStep && (
          <select
            class="movenote"
            title="the step this capture is filed against"
            value={String(filedAt ?? steps[0].index)}
            onChange={(e: Event) => onStep(Number((e.target as HTMLSelectElement).value))}
          >
            {steps.map(step => (
              <option key={step.index} value={String(step.index)}>
                step {step.index + 1}{step.label ? ` · ${step.label}` : ''}
              </option>
            ))}
          </select>
        )}
        <button
          class="save"
          onClick={() => onSave(canvas.current!.toDataURL('image/png').split(',')[1], words)}
        >SAVE</button>
        <button class="tool" onClick={onDiscard}>DELETE</button>
        <span class="hint grow">
          {marks.length ? `${marks.length} mark${marks.length === 1 ? '' : 's'} drawn on it` : ''}
        </span>
        <span class="hint">⌘↵</span>
      </div>
    </article>
  );
}
