/**
 * Motion the page makes with no `Animation` object, put in beside the clock.
 *
 * Chrome's Animation domain reports CSS transitions, CSS animations and Web
 * Animations, and nothing else: a frame loop writing styles, a library ticker,
 * a timer writing text, a canvas, a video, SVG SMIL and a smooth scroll pass
 * unseen. Each reaches the page somewhere this script can read it: a style or
 * SVG attribute write produces a mutation record (19 records for the catalog's
 * 300ms Details loop, one a frame, 26 Oct), a text change a character or child
 * record, a canvas a call on its context, a video and SMIL their own events,
 * a scroll its scroll event.
 *
 * Changes to one element's one property in a row are one motion: it opens at
 * the first change and closes once no change has come for QUIET_MS of page
 * time, so a 60-frame loop reads as one row and not sixty. A held page's time
 * stands still, so a motion it interrupts stays open until the page runs on.
 * Each closed motion is reported once, through the binding devharness adds.
 *
 * It watches only while started, as the bench's motion detection is.
 */

/** Where the controls stand on the page's global, out of the app's way. */
export const MOTION_KEY = 'devharness.motion';

/** The binding each closed motion is reported through. */
export const MOTION_BINDING = '__devharnessMotion';

/** One closed motion, as the page reports it. */
export interface MotionReport {
  source: 'style' | 'attribute' | 'text' | 'canvas' | 'media' | 'smil' | 'scroll';
  element: string;
  property: string;
  from: string;
  to: string;
  /** Page time the motion opened and last changed, ms. */
  startMs: number;
  endMs: number;
  /** Frames it changed in. */
  frames: number;
  /** Page time the report was sent, ms: devharness places the motion on wall time from it. */
  sentMs: number;
}

function installPageMotion(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.motion')]) return;

  const QUIET_MS = 120;
  // Changes closer than this fall in one frame.
  const FRAME_GAP_MS = 8;
  const SVG_ATTRIBUTES = ['transform', 'd', 'opacity', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'points', 'fill', 'stroke', 'stroke-dashoffset', 'viewBox'];

  const timers = g[Symbol.for('devharness.clock')]?.native ?? { setTimeout: g.setTimeout.bind(g), clearTimeout: g.clearTimeout.bind(g) };
  const now = (): number => g.performance.now();
  const nameOf = (element: any): string => {
    const named = g[Symbol.for('devharness.animations')]?.name?.(element);
    if (named) return named;
    return element && element.tagName ? String(element.tagName).toLowerCase() : 'window';
  };

  let on = false;
  interface Run { source: string; element: string; property: string; from: string; to: string; startMs: number; endMs: number; frames: number }
  const runs = new Map<string, Run>();
  let sweepTimer: unknown;

  const report = (run: Run) => {
    const send = g.__devharnessMotion;
    if (typeof send !== 'function') return;
    try { send(JSON.stringify({ ...run, sentMs: now() })); } catch { /* the binding went with a navigation */ }
  };
  const closeQuiet = (all = false) => {
    sweepTimer = undefined;
    const t = now();
    for (const [key, run] of runs) {
      if (all || t - run.endMs >= QUIET_MS) { runs.delete(key); report(run); }
    }
    if (runs.size && !all) sweepTimer = timers.setTimeout(() => closeQuiet(), QUIET_MS);
  };
  const note = (source: string, element: any, property: string, from: string, to: string) => {
    if (!on) return;
    const t = now();
    const name = nameOf(element);
    const key = `${source}|${name}|${property}`;
    const run = runs.get(key);
    if (run && t - run.endMs < QUIET_MS) {
      if (t - run.endMs >= FRAME_GAP_MS) run.frames++;
      run.to = to;
      run.endMs = t;
    } else {
      if (run) { runs.delete(key); report(run); }
      runs.set(key, { source, element: name, property, from, to, startMs: t, endMs: t, frames: 1 });
    }
    if (sweepTimer === undefined) sweepTimer = timers.setTimeout(() => closeQuiet(), QUIET_MS);
  };

  const declarations = (text: string | null): Map<string, string> => {
    const map = new Map<string, string>();
    for (const part of String(text ?? '').split(';')) {
      const colon = part.indexOf(':');
      if (colon > 0) map.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    return map;
  };
  const textOf = (element: any): string | undefined => {
    if (!element || !element.childNodes || element.childNodes.length === 0) return undefined;
    for (const child of element.childNodes) if (child.nodeType !== 3) return undefined;
    return element.textContent ?? '';
  };

  const observer = typeof g.MutationObserver === 'function' ? new g.MutationObserver((records: any[]) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'style') {
        const before = declarations(record.oldValue);
        const after = declarations(record.target.getAttribute('style'));
        for (const [property, value] of after) if (before.get(property) !== value) note('style', record.target, property, before.get(property) ?? '', value);
      } else if (record.type === 'attributes') {
        note('attribute', record.target, record.attributeName, record.oldValue ?? '', record.target.getAttribute(record.attributeName) ?? '');
      } else if (record.type === 'characterData') {
        note('text', record.target.parentElement, 'text', record.oldValue ?? '', record.target.data ?? '');
      } else if (record.type === 'childList') {
        const text = textOf(record.target);
        if (text === undefined) continue;
        const removed = [...record.removedNodes].map((node: any) => node.textContent ?? '').join('');
        note('text', record.target, 'text', removed, text);
      }
    }
  }) : undefined;

  // A canvas changes no DOM: its context's drawing calls are what show it moving.
  const drawing = (proto: any, methods: string[]) => {
    if (!proto) return;
    for (const method of methods) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (this: any, ...args: unknown[]) {
        if (on && this && this.canvas) note('canvas', this.canvas, 'pixels', '', '');
        return original.apply(this, args);
      };
    }
  };
  drawing(g.CanvasRenderingContext2D?.prototype, ['fillRect', 'strokeRect', 'clearRect', 'fill', 'stroke', 'drawImage', 'putImageData', 'fillText', 'strokeText']);
  drawing(g.WebGLRenderingContext?.prototype, ['drawArrays', 'drawElements', 'clear']);
  drawing(g.WebGL2RenderingContext?.prototype, ['drawArrays', 'drawElements', 'clear', 'drawArraysInstanced', 'drawElementsInstanced']);

  // Media and SMIL events do not bubble; a capture listener on the document hears them.
  // One play is one motion from its play event to its pause or end: the frames
  // it shows change no DOM, so the run is bounded by the element's own events.
  const playing = new Map<any, { from: number; startMs: number }>();
  const onMedia = (event: any) => {
    const element = event.target;
    if (!on || !element || typeof element.currentTime !== 'number') return;
    if (event.type === 'play') { playing.set(element, { from: element.currentTime, startMs: now() }); return; }
    const started = playing.get(element);
    if (!started) return;
    playing.delete(element);
    report({ source: 'media', element: nameOf(element), property: 'currentTime', from: started.from.toFixed(3), to: Number(element.currentTime).toFixed(3), startMs: started.startMs, endMs: now(), frames: 0 });
  };
  // One SMIL run is one motion from its begin event to its end event, however
  // long it runs: its frames change the animated value, which no record shows.
  const begun = new Map<any, number>();
  const onSmil = (event: any) => {
    const animate = event.target;
    if (!on || !animate) return;
    if (event.type === 'beginEvent') { begun.set(animate, now()); return; }
    const startMs = begun.get(animate);
    if (startMs === undefined) return;
    begun.delete(animate);
    const target = animate.targetElement ?? animate.parentElement;
    report({ source: 'smil', element: nameOf(target), property: animate.getAttribute?.('attributeName') ?? 'smil', from: animate.getAttribute?.('from') ?? '', to: animate.getAttribute?.('to') ?? '', startMs, endMs: now(), frames: 0 });
  };
  let lastScroll = { x: g.scrollX ?? 0, y: g.scrollY ?? 0 };
  const onScroll = () => {
    const at = { x: g.scrollX ?? 0, y: g.scrollY ?? 0 };
    if (at.y !== lastScroll.y) note('scroll', g.document.scrollingElement ?? g.document.documentElement, 'scrollY', String(Math.round(lastScroll.y)), String(Math.round(at.y)));
    if (at.x !== lastScroll.x) note('scroll', g.document.scrollingElement ?? g.document.documentElement, 'scrollX', String(Math.round(lastScroll.x)), String(Math.round(at.x)));
    lastScroll = at;
  };

  g[Symbol.for('devharness.motion')] = {
    /** Watch the page's motion from now on. */
    start() {
      if (on) return true;
      on = true;
      lastScroll = { x: g.scrollX ?? 0, y: g.scrollY ?? 0 };
      observer?.observe(g.document, {
        subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', ...SVG_ATTRIBUTES],
        characterData: true, characterDataOldValue: true, childList: true,
      });
      for (const type of ['play', 'pause', 'ended']) g.document.addEventListener(type, onMedia, true);
      for (const type of ['beginEvent', 'endEvent']) g.document.addEventListener(type, onSmil, true);
      g.addEventListener('scroll', onScroll, { passive: true });
      return true;
    },
    /** Stop watching; open motions close and report as they stand. */
    stop() {
      if (!on) return false;
      observer?.disconnect();
      for (const type of ['play', 'pause', 'ended']) g.document.removeEventListener(type, onMedia, true);
      for (const type of ['beginEvent', 'endEvent']) g.document.removeEventListener(type, onSmil, true);
      g.removeEventListener('scroll', onScroll);
      closeQuiet(true);
      on = false;
      return true;
    },
    state() { return { on, open: runs.size }; },
  };
}

/** The motion watch as page source, run beside the clock before the app's first script. */
export const PAGE_MOTION_SOURCE = `(${installPageMotion.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
