/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type preact from 'preact';
import type { FilmFrame, FilmView } from '../wire.js';

/**
 * A filmed motion, one frame at a time: the frame cut to its element, a track
 * across every frame with an orange handle at each end that trims the range,
 * and what the page held as the frame was drawn. Stepping, by the arrow keys
 * while the strip has focus or by the buttons, stays inside the range; Share
 * hands the range to the session.
 */
export function FilmStrip({ base, dir }: { base: string; dir: string }) {
  const [film, setFilm] = useState<FilmView | null>(null);
  const [at, setAt] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [shared, setShared] = useState(false);
  const sharedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(sharedTimer.current), []);
  useEffect(() => {
    setFilm(null);
    void fetch(`${base}/film?dir=${encodeURIComponent(dir)}`).then(reply => (reply.ok ? reply.json() : null), () => null).then((view: FilmView | null) => {
      setFilm(view);
      setAt(0);
      setRange([0, Math.max(0, (view?.frames.length ?? 1) - 1)]);
    });
  }, [base, dir]);
  if (!film) return <p class="hint">reading the film…</p>;
  if (!film.frames.length) return <p class="hint">{film.endedBy === 'nothing' ? 'The motion did not start within 5s of its step, so nothing was filmed.' : 'No frame was drawn while it ran: the app window may have been hidden.'}</p>;
  if (film.outside === 'all') {
    const first = film.frames.find(one => one.box);
    return <p class="hint">The element stood outside the visible page{first?.box ? ` (at ${Math.round(first.box.x)},${Math.round(first.box.y)}, the page showing ${first.viewport.width}×${first.viewport.height})` : ''}, so no frame shows it. Scroll it into view before its step and film it again.</p>;
  }
  const [from, to] = range;
  const frame = film.frames[Math.min(Math.max(at, from), to)];
  const shown = film.frames.indexOf(frame);
  const step = (by: number) => setAt(Math.max(from, Math.min(to, shown + by)));
  const share = () => {
    void fetch(`${base}/film/share`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, from, to }),
    }).then(() => {
      setShared(true);
      clearTimeout(sharedTimer.current);
      sharedTimer.current = setTimeout(() => setShared(false), 1600);
    }, () => undefined);
  };
  const repeat = frame.repeat;
  return (
    <div class="filmstrip" tabIndex={0}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      }}>
      <FrameCut src={`${base}/shot/img?p=${encodeURIComponent(frame.file)}`} alt={`frame ${shown + 1} of ${film.frames.length}`} frame={frame} />
      {film.outside === 'part' && <p class="hint">Part of the element fell outside the visible page; the frames show only the part inside it.</p>}
      <div class="filmcontrols">
        <button class="tool plain" title="previous frame (←)" onClick={() => step(-1)} disabled={shown <= from}>‹</button>
        <TrimTrack count={film.frames.length} at={shown} range={range}
          onAt={index => setAt(index)}
          onRange={next => { setRange(next); setAt(Math.min(Math.max(shown, next[0]), next[1])); }} />
        <button class="tool plain" title="next frame (→)" onClick={() => step(1)} disabled={shown >= to}>›</button>
        <span class="filmcount">{shown + 1} / {film.frames.length}</span>
      </div>
      <dl class="motionsource filmfacts">
        <dt>time</dt>
        <dd>+{frame.atMs} ms from the step{frame.sinceMotionMs !== undefined ? ` · ${frame.sinceMotionMs >= 0 ? '+' : ''}${frame.sinceMotionMs} ms from the motion's start` : ''}</dd>
        {frame.value !== undefined && <><dt>value</dt><dd><code>{frame.value}</code></dd></>}
        {repeat && <>
          <dt>animation</dt>
          <dd>
            {repeat.index} of {repeat.of} · {Math.min(repeat.elapsedMs, repeat.durationMs)} of {repeat.durationMs} ms
            {repeat.to !== undefined ? <> · heading to <code>{repeat.to}</code></> : null}
            {repeat.cutShort ? ' · cut short by the next' : ''}
          </dd>
        </>}
        {film.cause && <><dt>cause</dt><dd>{film.cause}</dd></>}
        {frame.box && <><dt>box</dt><dd>{Math.round(frame.box.width)}×{Math.round(frame.box.height)} at {Math.round(frame.box.x)},{Math.round(frame.box.y)}</dd></>}
        <dt>page</dt><dd>{frame.viewport.width}×{frame.viewport.height}{frame.resized ? ' · resized at this frame' : ''}</dd>
        {frame.near.length > 0 && <><dt>nearby</dt><dd>{frame.near.join(' · ')}</dd></>}
      </dl>
      <div class="filmshare">
        <span class="hint">frames {from + 1}–{to + 1}</span>
        <button class="chip-toggle" title="hand these frames, their pictures and details, to the session" onClick={share}>{shared ? 'shared' : 'Share'}</button>
      </div>
    </div>
  );
}

/**
 * The frame track: a mark at the frame shown, and an orange handle at each end
 * of the range that drags along the frames. A press on the track away from
 * the handles moves to the frame under it, kept inside the range.
 */
function TrimTrack({ count, at, range, onAt, onRange }: {
  count: number; at: number; range: [number, number];
  onAt: (index: number) => void; onRange: (range: [number, number]) => void;
}): preact.JSX.Element {
  const track = useRef<HTMLDivElement>(null);
  const last = Math.max(1, count - 1);
  const percent = (index: number) => `${(index / last) * 100}%`;
  const indexAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * last);
  };
  const drag = (end: 0 | 1) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (moved: PointerEvent) => {
      const index = indexAt(moved.clientX);
      onRange(end === 0 ? [Math.min(index, range[1]), range[1]] : [range[0], Math.max(index, range[0])]);
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  return (
    <div class="filmtrack" ref={track}
      onPointerDown={(e: PointerEvent) => onAt(Math.min(Math.max(indexAt(e.clientX), range[0]), range[1]))}>
      <div class="filmrail" />
      <div class="filmkept" style={{ left: percent(range[0]), width: `calc(${percent(range[1])} - ${percent(range[0])})` }} />
      <div class="filmat" style={{ left: percent(at) }} />
      <div class="filmhandle" role="slider" aria-label="first frame of the range" aria-valuenow={range[0] + 1}
        title={`range starts at frame ${range[0] + 1}`} style={{ left: percent(range[0]) }} onPointerDown={drag(0)} />
      <div class="filmhandle" role="slider" aria-label="last frame of the range" aria-valuenow={range[1] + 1}
        title={`range ends at frame ${range[1] + 1}`} style={{ left: percent(range[1]) }} onPointerDown={drag(1)} />
    </div>
  );
}

/** Widest the cut is drawn, px; a smaller cut is drawn up to twice its size. */
const SHOWN_WIDTH = 560;

/**
 * One frame cut to its own region. The frames are saved whole, so the cut is
 * drawn here: the image is scaled so the region spans the shown width, and
 * shifted so the region sits in the box. Each frame carries its own viewport
 * and region, since a step can resize the page mid-film.
 */
function FrameCut({ src, alt, frame }: { src: string; alt: string; frame: FilmFrame }): preact.JSX.Element {
  const clip = frame.clip;
  if (!clip || !frame.viewport.width) return <img class="filmframe" src={src} alt={alt} />;
  const scale = Math.min(2, SHOWN_WIDTH / clip.width);
  return (
    <div class="filmframe filmcut" style={{ width: `${clip.width * scale}px`, height: `${clip.height * scale}px` }}>
      <img src={src} alt={alt} style={{
        width: `${frame.viewport.width * scale}px`,
        left: `${-clip.x * scale}px`,
        top: `${-clip.y * scale}px`,
      }} />
    </div>
  );
}
