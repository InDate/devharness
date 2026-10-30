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
 * Each motion is reported twice through the binding devharness adds: as it
 * opens, so its step reads it while the step's comparison runs, and as it
 * closes, with its duration, frames and last value.
 *
 * It watches only while started, as the bench's motion detection is.
 */

/** Where the controls stand on the page's global, out of the app's way. */
export const MOTION_KEY = 'devharness.motion';

/** The binding each closed motion is reported through. */
export const MOTION_BINDING = '__devharnessMotion';

/** One motion as the page reports it, opening or closing. */
export interface MotionReport {
  /** The page's own number for it, in document `doc`: its open and close reports share it. */
  id: number;
  doc: string;
  /** `open` at its first change; `close` once it has stopped, with how it ran. */
  phase: 'open' | 'close';
  source: 'style' | 'attribute' | 'text' | 'canvas' | 'media' | 'smil' | 'scroll' | 'class';
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
  /** What set it going, as the page's trigger tracker read it when it opened. */
  trigger?: string;
  /** Who made it - CSS, JS, SVG, MEDIA, ME, HARNESS, BROWSER - with the page's ref to what made it and that thing's name. */
  maker?: string;
  makerRef?: number;
  makerName?: string;
  /** Where a call that made it stands, when the page holds its script and line but not its function. */
  makerAt?: { url: string; line: number };
  /** The input at the head of the chain that started it, as the page's trigger tracker carried it. */
  root?: { id: string; step?: string };
  /** `property`: the run began under no root of its own and took the root of the input whose call last wrote this property on this element. */
  rootFrom?: 'property';
  /** On a close that something ended - a media element paused or reaching its end - what ended it, in the maker's terms. */
  stoppedBy?: MotionStop;
}

/** What ended a motion: the trigger and maker of the pause, or the media's own end. */
export interface MotionStop {
  trigger?: string;
  maker?: string;
  makerRef?: number;
  makerName?: string;
  makerAt?: { url: string; line: number };
  /** The root of the input whose call stopped it. */
  root?: { id: string; step?: string };
}

function installPageMotion(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.motion')]) return;

  const QUIET_MS = 120;
  // Changes closer than this fall in one frame.
  const FRAME_GAP_MS = 8;
  const SVG_ATTRIBUTES = ['transform', 'd', 'opacity', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'points', 'fill', 'stroke', 'stroke-dashoffset', 'viewBox'];

  const timers = g[Symbol.for('devharness.clock')]?.native ?? { setTimeout: g.setTimeout.bind(g), clearTimeout: g.clearTimeout.bind(g) };
  const frame: ((run: () => void) => unknown) | undefined = g[Symbol.for('devharness.clock')]?.native?.requestAnimationFrame
    ?? (typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g) : undefined);
  const now = (): number => g.performance.now();
  const nameOf = (element: any): string => {
    const named = g[Symbol.for('devharness.animations')]?.name?.(element);
    if (named) return named;
    return element && element.tagName ? String(element.tagName).toLowerCase() : 'window';
  };

  let on = false;
  interface Run { id: number; source: string; element: string; property: string; from: string; to: string; startMs: number; endMs: number; frames: number; trigger?: string; maker?: string; makerRef?: number; makerName?: string; makerAt?: { url: string; line: number }; stoppedBy?: MotionStop; root?: { id: string; step?: string }; rootFrom?: 'property' }
  // Numbers each motion in this document; the document's own id names which.
  let nextRun = 1;
  const doc = Math.random().toString(36).slice(2, 10);
  const tracker = () => g[Symbol.for('devharness.trigger')];
  const triggerOf = (source: string): string | undefined => (source === 'scroll' ? tracker()?.scrollCause?.() : tracker()?.current?.());
  const runs = new Map<string, Run>();
  let sweepTimer: unknown;

  // An open run is work outstanding under its root, reported before the
  // root's count changes so its open report reaches the record first.
  const report = (run: Run, phase: 'open' | 'close') => {
    const send = g.__devharnessMotion;
    if (typeof send === 'function') {
      try { send(JSON.stringify({ ...run, doc, phase, sentMs: now() })); } catch { /* the binding went with a navigation */ }
    }
    if (phase === 'open') tracker()?.hold?.(run.root);
    else tracker()?.release?.(run.root);
  };
  // The callback whose frames drew each open run, for the cancel that ends it.
  const drawnBy = new Map<Run, any>();
  const closeRun = (run: Run) => {
    const cancel = tracker()?.cancelOf?.(drawnBy.get(run), run.startMs);
    drawnBy.delete(run);
    report(cancel ? { ...run, stoppedBy: { ...cancel.maker, trigger: cancel.trigger, ...(cancel.root ? { root: cancel.root } : {}) } } : run, 'close');
    // The cancelling root was held open for this stop, once however many runs one loop drew.
    if (cancel?.held) { cancel.held = undefined; tracker()?.release?.(cancel.root); }
  };
  const closeQuiet = (all = false) => {
    sweepTimer = undefined;
    const t = now();
    for (const [key, run] of runs) {
      if (all || t - run.endMs >= QUIET_MS) { runs.delete(key); closeRun(run); }
    }
    if (runs.size && !all) sweepTimer = timers.setTimeout(() => closeQuiet(), QUIET_MS);
  };
  const rootedWrites = new Map<string, { id: string; step?: string }>();
  // Roots are numbered in the order this document made them: a cause that
  // takes a run over is one made after the run's own, never an older cause
  // a recent-cause read turns up again.
  const newerRoot = (id: string, than: string | undefined): boolean => {
    if (than === undefined) return true;
    const [prefix, n] = [id.slice(0, id.lastIndexOf(':')), Number(id.slice(id.lastIndexOf(':') + 1))];
    const [thanPrefix, thanN] = [than.slice(0, than.lastIndexOf(':')), Number(than.slice(than.lastIndexOf(':') + 1))];
    return prefix === thanPrefix && n > thanN;
  };
  const note = (source: string, element: any, property: string, from: string, to: string) => {
    if (!on) return;
    const t = now();
    const name = nameOf(element);
    const key = `${source}|${name}|${property}`;
    const run = runs.get(key);
    // A run whose frames start arriving under another input's root - a
    // scroll call taking over a wheel's scroll - splits there, each part
    // under its own cause, and the new part's from-value is where it was.
    const taken = run && t - run.endMs < QUIET_MS ? (source === 'scroll' ? tracker()?.rootOfScroll?.() : tracker()?.rootNow?.()) : undefined;
    // Inputs of one step - the wheel ticks of one scroll step - carry one run.
    const split = run !== undefined && taken !== undefined && newerRoot(taken.id, run.root?.id) && (taken.step === undefined || taken.step !== run.root?.step);
    if (split) from = run!.to;
    if (run && t - run.endMs < QUIET_MS && !split) {
      if (t - run.endMs >= FRAME_GAP_MS) run.frames++;
      run.to = to;
      run.endMs = t;
    } else {
      if (run) { runs.delete(key); closeRun(run); }
      const trigger = triggerOf(source);
      const maker = (source === 'scroll' ? tracker()?.scrollMaker?.() : tracker()?.runningMaker?.()) ?? {};
      // A library's ticker runs one frame loop from load, so a tween it starts
      // later runs under no root of its own; the input whose call last wrote
      // this property on this element - the tween's from-value - roots it.
      // Only a run whose trigger names no cause but a frame loop inherits: a
      // run the browser or another cause set going is that cause's.
      const live = source === 'scroll' ? tracker()?.rootOfScroll?.() : tracker()?.rootNow?.();
      const inherited = live || source === 'scroll' || (trigger !== undefined && trigger !== 'frame loop') ? undefined : rootedWrites.get(key);
      const root = live ?? inherited;
      if (root && source !== 'scroll') rootedWrites.set(key, root);
      const opened: Run = { id: nextRun++, source, element: name, property, from, to, startMs: t, endMs: t, frames: 1, ...(trigger ? { trigger } : {}), ...maker, ...(root ? { root } : {}), ...(inherited ? { rootFrom: 'property' as const } : {}) };
      runs.set(key, opened);
      const callback = tracker()?.runningCallback?.();
      if (callback) drawnBy.set(opened, callback);
      report(opened, 'open');
    }
    if (sweepTimer === undefined) sweepTimer = timers.setTimeout(() => closeQuiet(), QUIET_MS);
  };

  // A class change that starts no animation still changes what the page
  // shows, at once: a row collapsed under `transition: none` reports nothing
  // else. A transition or keyframe animation it starts is created at the next
  // style recalc and its run event dispatched in the frame after, so the
  // change is judged two frames on, against the run events since.
  const runEvents: Array<{ target: any; at: number }> = [];
  const onRunEvent = (event: any) => {
    if (!on) return;
    runEvents.push({ target: event.target, at: now() });
    if (runEvents.length > 200) runEvents.shift();
  };
  const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean);
  const classChanged = (element: any, from: string, to: string) => {
    const before = tokens(from), after = tokens(to);
    const diff = [...after.filter(one => !before.includes(one)).map(one => `+${one}`), ...before.filter(one => !after.includes(one)).map(one => `-${one}`)];
    if (diff.length === 0) return;
    const t = now();
    const trigger = tracker()?.current?.();
    const root = tracker()?.rootNow?.();
    const maker = tracker()?.runningMaker?.() ?? {};
    tracker()?.hold?.(root);
    const judge = () => {
      const animated = runEvents.some(one => one.at >= t && (one.target === element || element.contains?.(one.target)));
      if (on && !animated) {
        const run: Run = { id: nextRun++, source: 'class', element: nameOf(element), property: 'class', from: before.join(' '), to: diff.join(' '), startMs: t, endMs: t, frames: 1, ...(trigger ? { trigger } : {}), ...maker, ...(root ? { root } : {}) };
        report(run, 'open');
        report(run, 'close');
      }
      tracker()?.release?.(root);
    };
    if (frame) frame(() => frame(() => timers.setTimeout(judge, 0))); else timers.setTimeout(judge, 0);
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
      if (record.type === 'attributes' && record.attributeName === 'class') {
        classChanged(record.target, record.oldValue ?? '', record.target.getAttribute('class') ?? '');
      } else if (record.type === 'attributes' && record.attributeName === 'style') {
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
  const playing = new Map<any, Run>();
  const withRoot = (root: { id: string; step?: string } | undefined) => (root ? { root } : {});
  const onMedia = (event: any) => {
    const element = event.target;
    if (!on || !element || typeof element.currentTime !== 'number') return;
    if (event.type === 'play') {
      const at = Number(element.currentTime).toFixed(3);
      const trigger = tracker()?.ofCall?.(['play'], tracker()?.current?.() ?? 'autoplay');
      const root = tracker()?.rootOfCall?.(['play']);
      const opened: Run = { id: nextRun++, source: 'media', element: nameOf(element), property: 'currentTime', from: at, to: at, startMs: now(), endMs: now(), frames: 0, ...(trigger ? { trigger } : {}), ...(tracker()?.mediaMaker?.(element) ?? {}), ...(root ? { root } : {}) };
      playing.set(element, opened);
      report(opened, 'open');
      return;
    }
    const started = playing.get(element);
    if (!started) return;
    playing.delete(element);
    // A media element reaching its end fires pause, then ended; either reads as the end.
    const stoppedBy: MotionStop = element.ended
      ? { ...(tracker()?.maker?.('MEDIA', element) ?? { maker: 'MEDIA' }), trigger: 'ended' }
      : { ...(tracker()?.mediaMaker?.(element, 'pause') ?? { maker: 'MEDIA' }), trigger: tracker()?.ofCall?.(['pause'], 'paused') ?? 'paused', ...withRoot(tracker()?.rootOfCall?.(['pause'])) };
    report({ ...started, to: Number(element.currentTime).toFixed(3), endMs: now(), stoppedBy }, 'close');
  };
  // One SMIL run is one motion from its begin event to its end event, however
  // long it runs: its frames change the animated value, which no record shows.
  const begun = new Map<any, Run>();
  const svgMaker = (animate: any) => tracker()?.maker?.('SVG', animate.targetElement ?? animate.parentElement) ?? { maker: 'SVG' };
  const onSmil = (event: any) => {
    const animate = event.target;
    if (!on || !animate) return;
    // Begun by a call, else by its own begin attribute: a time or an event the markup names.
    const declared = `begin ${animate.getAttribute?.('begin') || '0s'}`;
    if (event.type === 'beginEvent') {
      const target = animate.targetElement ?? animate.parentElement;
      const trigger = tracker()?.ofCall?.(['beginElement', 'beginElementAt'], declared);
      const root = tracker()?.rootOfCall?.(['beginElement', 'beginElementAt']);
      const opened: Run = { id: nextRun++, source: 'smil', element: nameOf(target), property: animate.getAttribute?.('attributeName') ?? 'smil', from: animate.getAttribute?.('from') ?? '', to: animate.getAttribute?.('to') ?? '', startMs: now(), endMs: now(), frames: 0, ...(trigger ? { trigger } : {}), ...svgMaker(animate), ...(root ? { root } : {}) };
      begun.set(animate, opened);
      report(opened, 'open');
      return;
    }
    const opened = begun.get(animate);
    if (opened === undefined) return;
    begun.delete(animate);
    report({ ...opened, endMs: now() }, 'close');
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
        subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class', ...SVG_ATTRIBUTES],
        characterData: true, characterDataOldValue: true, childList: true,
      });
      // Registered as devharness's own, so the trigger tracker leaves them unwrapped.
      tracker()?.own?.(onMedia); tracker()?.own?.(onSmil); tracker()?.own?.(onScroll); tracker()?.own?.(onRunEvent);
      for (const type of ['play', 'pause', 'ended']) g.document.addEventListener(type, onMedia, true);
      for (const type of ['beginEvent', 'endEvent']) g.document.addEventListener(type, onSmil, true);
      for (const type of ['transitionrun', 'animationstart']) g.document.addEventListener(type, onRunEvent, true);
      g.addEventListener('scroll', onScroll, { passive: true });
      return true;
    },
    /** Stop watching; open motions close and report as they stand. */
    stop() {
      if (!on) return false;
      observer?.disconnect();
      for (const type of ['play', 'pause', 'ended']) g.document.removeEventListener(type, onMedia, true);
      for (const type of ['beginEvent', 'endEvent']) g.document.removeEventListener(type, onSmil, true);
      for (const type of ['transitionrun', 'animationstart']) g.document.removeEventListener(type, onRunEvent, true);
      g.removeEventListener('scroll', onScroll);
      closeQuiet(true);
      on = false;
      return true;
    },
    state() { return { on, open: runs.size }; },
    /** Whether `fn`'s frames are drawing a run still open: a cancel of its loop ends that run. */
    drawing(fn: any): boolean { return [...drawnBy.values()].includes(fn); },
  };
}

/** The motion watch as page source, run beside the clock before the app's first script. */
export const PAGE_MOTION_SOURCE = `(${installPageMotion.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
