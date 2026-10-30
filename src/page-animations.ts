/**
 * The page's animations as the page itself holds them, put in beside the clock.
 *
 * Chrome's Animation domain names an animation by an id it cannot resolve
 * until the animation starts, and a held page starts none: a transition a
 * held step creates stands pending, and every read of it by that id fails.
 * `document.getAnimations()` returns the pending ones too, so the page lists
 * them here and hands each `Animation` object an id of devharness's own, kept
 * in a WeakMap. A start report Chrome sends while the page runs resolves its
 * object and takes the same id, so both ways in name one animation once.
 *
 * The document's list leaves out animations in shadow roots, so a sweep walks
 * every open shadow root as well.
 */

/** Where the controls stand on the page's global, out of the app's way. */
export const ANIMATIONS_KEY = 'devharness.animations';

/** One animation as a sweep reads it. */
/**
 * One mark on the way from a motion's cause back to its root, as the trigger
 * tracker held it; `motion` a motion whose end the mark before it stands for.
 * The last link carries its root where it has one.
 */
export interface MotionLink { id: string; kind: string; words?: string; root?: { id: string; step?: string } }

export interface PageAnimation {
  id: number;
  /** The document the id was given in: ids count from 1 again in each new document. */
  doc: string;
  /** The animation-name, transition-property or web animation id. */
  name: string;
  type: 'CSSTransition' | 'CSSAnimation' | 'WebAnimation' | MotionType;
  /** The animated element as `#id`, else its tag and first two classes: the key a comparison across runs reads. */
  element?: string;
  duration: number;
  delay: number;
  easing: string;
  looping: boolean;
  playState: string;
  currentTime: number;
  /** The value it started and ended at: a transition's keyframes, or a motion with no Animation object as it changed. Frames only on the latter. */
  from?: string;
  to?: string;
  frames?: number;
  /** A motion with no Animation object: how long it ran on wall time, ms, where `duration` is page time and a slower rate stretches the one past the other. */
  wallDuration?: number;
  /** What set it going, as the page's trigger tracker read it. */
  trigger?: string;
  /** Who made it - CSS, JS, SVG, MEDIA, ME, HARNESS, BROWSER - with the page's ref to what made it and that thing's name. */
  maker?: string;
  makerRef?: number;
  makerName?: string;
  /** Where a call that made it stands, when the page holds its script and line but not its function. */
  makerAt?: { url: string; line: number };
  /** The input at the head of the chain that started it, as the page's trigger tracker carried it. */
  root?: { id: string; step?: string };
  /** See `MotionReport.rootFrom`. */
  rootFrom?: 'property';
  /** The motion on its element and property it cut short, whose state it started from: that one's trigger, root and id. */
  cuts?: { trigger: string; root?: { id: string; step?: string }; motion?: number };
  /** The marks from its cause back to its root, newest first: where two motions' chains share a mark, one cause forked into both. */
  chain?: MotionLink[];
}

/** Motion the page makes with no Animation object (`page-motion.ts`), named by what carried it. */
export type MotionType = 'StyleWrites' | 'AttributeWrites' | 'TextWrites' | 'Canvas' | 'Media' | 'SMIL' | 'Scroll' | 'ClassChange' | 'Playback';

/** What a sweep found since the one before it. */
export interface SweepReading {
  doc: string;
  created: PageAnimation[];
  /** Ids no longer listed: `finished` ran to its end, `canceled` was removed before it. */
  gone: Array<{ id: number; how: 'finished' | 'canceled' }>;
}

function installPageAnimations(g: any): void {
  if (typeof g.document === 'undefined' || g[Symbol.for('devharness.animations')]) return;

  const ids = new WeakMap<object, number>();
  // Taken before the motion watch wraps them, so a pause devharness makes
  // reads as no playback change of the app's.
  const nativePause = g.Animation?.prototype?.pause;
  const nativePlay = g.Animation?.prototype?.play;
  // Held weakly so a finished animation the page dropped is collected; a
  // WeakRef-less engine keeps them, bounded by `live`.
  const Ref = typeof g.WeakRef === 'function' ? g.WeakRef : class { constructor(private value: object) {} deref() { return this.value; } };
  const byId = new Map<number, { deref(): any }>();
  let live = new Set<number>();
  let nextId = 1;
  const doc = Math.random().toString(36).slice(2, 10);

  const idOf = (animation: object): number => {
    let id = ids.get(animation);
    if (id === undefined) {
      id = nextId++;
      ids.set(animation, id);
      byId.set(id, new Ref(animation));
    }
    return id;
  };

  const ownName = (target: any): string => {
    if (target.id) return `#${target.id}`;
    const classes = typeof target.className === 'string' ? target.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return target.tagName.toLowerCase() + classes.map((one: string) => `.${one}`).join('');
  };
  // An element inside a shadow root is named through its host, and the
  // host's host outward: the Drafts chip's ping read as span.ping alone,
  // which names no element a reader can find in the document.
  const elementName = (target: any): string | undefined => {
    if (!target || typeof target.tagName !== 'string') return undefined;
    const names = [ownName(target)];
    for (let host = target.getRootNode?.()?.host; host && typeof host.tagName === 'string'; host = host.getRootNode?.()?.host) names.unshift(ownName(host));
    return names.join(' › ');
  };

  // A transition's keyframes hold its start and end values, keyed by the property in camel case.
  const transitionEnds = (effect: any, property: string): { from: string; to: string } | undefined => {
    const frames: any[] = effect && typeof effect.getKeyframes === 'function' ? effect.getKeyframes() : [];
    const key = property.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
    const from = frames[0]?.[key];
    const to = frames[frames.length - 1]?.[key];
    return typeof from === 'string' && typeof to === 'string' ? { from, to } : undefined;
  };

  const describe = (animation: any): PageAnimation => {
    const effect = animation.effect;
    const timing = effect && typeof effect.getComputedTiming === 'function' ? effect.getComputedTiming() : {};
    const specified = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : {};
    const type = animation.transitionProperty !== undefined ? 'CSSTransition' : animation.animationName !== undefined ? 'CSSAnimation' : 'WebAnimation';
    const element = elementName(effect && effect.target);
    const tracker = g[Symbol.for('devharness.trigger')];
    const trigger = tracker?.ofAnimation?.(animation);
    const maker = tracker?.animationMaker?.(animation) ?? {};
    const root = tracker?.rootOfAnimation?.(animation);
    const cut = tracker?.cutOf?.(animation);
    const chain = tracker?.chainOfAnimation?.(animation);
    const ends = type === 'CSSTransition' ? transitionEnds(effect, String(animation.transitionProperty)) : undefined;
    return {
      id: idOf(animation),
      doc,
      name: animation.transitionProperty || animation.animationName || animation.id || 'animation',
      type,
      ...(element ? { element } : {}),
      duration: typeof timing.duration === 'number' ? timing.duration : 0,
      delay: Number(timing.delay) || 0,
      easing: specified.easing || 'linear',
      looping: timing.iterations === Infinity,
      playState: String(animation.playState),
      currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : 0,
      ...(ends ?? {}),
      ...(trigger ? { trigger } : {}),
      ...maker,
      ...(root ? { root } : {}),
      ...(cut ? { cuts: { trigger: cut.words, ...(cut.root ? { root: cut.root } : {}), ...(cut.motion !== undefined ? { motion: cut.motion } : {}) } } : {}),
      ...(chain?.length ? { chain } : {}),
    };
  };

  /** Every animation the document and its open shadow roots list, in tree order. */
  const listed = (): any[] => {
    const all: any[] = [...g.document.getAnimations()];
    const walk = (root: any) => {
      for (const element of root.querySelectorAll('*')) {
        const shadow = element.shadowRoot;
        if (!shadow) continue;
        all.push(...shadow.getAnimations());
        walk(shadow);
      }
    };
    walk(g.document);
    return all;
  };

  const sweep = (): SweepReading => {
    const now = new Set<number>();
    const created: PageAnimation[] = [];
    for (const animation of listed()) {
      const known = ids.has(animation);
      const id = idOf(animation);
      now.add(id);
      if (!known) created.push(describe(animation));
    }
    const gone: SweepReading['gone'] = [];
    for (const id of live) {
      if (now.has(id)) continue;
      const animation = byId.get(id)?.deref();
      gone.push({ id, how: animation && animation.playState === 'finished' ? 'finished' : 'canceled' });
      byId.delete(id);
    }
    live = now;
    return { doc, created, gone };
  };

  const animationOf = (id: number): any => byId.get(Number(id))?.deref();

  g[Symbol.for('devharness.animations')] = {
    /** The document these ids were given in; a call naming another document's id acts on nothing. */
    doc,
    /** An element's name as every reading of the page gives it: `#id`, else its tag and first two classes. */
    name: elementName,
    sweep,
    /** The animation the id names, read now; null once the page has let it go. */
    read(id: number) { const animation = animationOf(id); return animation ? describe(animation) : null; },
    /** Which of `selectors` the animated element matches; a selector that does not parse matches nothing. */
    matches(id: number, selectors: string[]) {
      const animation = animationOf(id);
      const target = animation && animation.effect && animation.effect.target;
      const matched: Record<string, boolean> = {};
      for (const selector of selectors) {
        try { matched[selector] = !!target && target.matches(selector); } catch { matched[selector] = false; }
      }
      return matched;
    },
    /** The id an animation object carries, given it here where it has none: a start report's way in. */
    idOf(animation: object) { return idOf(animation); },
    /** Read an animation object a start report resolved, under the id the sweep would give it. */
    describe(animation: object) { return describe(animation); },
    /** Put an animation at `ms` of its own time. */
    seek(id: number, ms: number) { const animation = animationOf(id); if (!animation) return false; animation.currentTime = Math.max(0, Number(ms) || 0); return true; },
    pause(id: number) { const animation = animationOf(id); if (!animation) return false; (nativePause ?? animation.pause).call(animation); return true; },
    play(id: number) { const animation = animationOf(id); if (!animation) return false; (nativePlay ?? animation.play).call(animation); return true; },
    /** Give an animation other duration and delay, in ms. */
    retime(id: number, timing: { duration?: number; delay?: number }) {
      const animation = animationOf(id);
      if (!animation || !animation.effect || typeof animation.effect.updateTiming !== 'function') return false;
      animation.effect.updateTiming({
        ...(typeof timing.duration === 'number' ? { duration: timing.duration } : {}),
        ...(typeof timing.delay === 'number' ? { delay: timing.delay } : {}),
      });
      return true;
    },
  };
}

/** The page's animation list as page source, run beside the clock before the app's first script. */
export const PAGE_ANIMATIONS_SOURCE = `(${installPageAnimations.toString()})(typeof globalThis !== 'undefined' ? globalThis : self);`;
