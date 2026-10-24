/**
 * The page's CSS transitions, CSS animations and web animations, as the
 * Animation domain reports them, and the two moves on them a hold allows.
 *
 * A screen hold stops the document timeline (playback rate 0), so every
 * animation stands where it was. A seek moves each running one on by a given
 * amount of its own time, and the compositor paints the new frame while the
 * page's JS stays stopped: a 420ms settle is read at 0, 105, 210 and 420ms
 * with a capture at each. The JS that drives a follow is not an animation and
 * does not move with it; a tick moves that.
 */

import type { CDPSession } from 'puppeteer-core';
import type { BenchSession } from './session.js';
import { request, send } from './cdp.js';
import { CLOCK_KEY } from '../page-clock.js';
import { ownScript } from '../utils/own-script.js';
import { applyMotionRules } from './motion-rules.js';

export interface TrackedAnimation {
  id: string;
  /** The animation-name or transition-property, or the web animation's id; the id alone until it starts. */
  name: string;
  type: 'CSSTransition' | 'CSSAnimation' | 'WebAnimation';
  /** ms of one iteration, with its delay; absent until the domain reports the start or a seek resolves them. */
  duration?: number;
  delay?: number;
  /** The animated element, as the DOM domain names it. */
  backendNodeId?: number;
  /** The timing function, and the element as `#id` or `tag.class`, once read off the animation object. */
  easing?: string;
  element?: string;
  startedAt: number;
}

/** One animation of a group, where it stands. */
export interface GroupAnimation {
  id: string;
  name: string;
  type: TrackedAnimation['type'];
  element?: string;
  delayMs: number;
  durationMs: number;
  easing: string;
  currentMs: number;
}

export interface SeekReading {
  id: string;
  name: string;
  type: TrackedAnimation['type'];
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** 0 to 1 of the animation's active span, after the seek. */
  progress: number;
}

/**
 * Keep the session's list of animations current from the domain's events.
 *
 * A transition starts on the frame after the style change, and a hold taken
 * within a few ms of the change lands before that frame: the domain has
 * reported the animation created, with no timing, and reports it started only
 * once the frame comes. The created id is kept so a seek reaches it, and its
 * timing is resolved from the animation object when the start has not been
 * reported.
 */
export function watchAnimations(session: BenchSession): void {
  const { client } = session;
  client.on('Animation.animationCreated', (event: any) => {
    if (!event?.id || session.animations.has(event.id)) return;
    session.animations.set(event.id, { id: event.id, name: event.id, type: 'WebAnimation', startedAt: Date.now() });
  });
  client.on('Animation.animationStarted', (event: any) => {
    const animation = event?.animation;
    if (!animation?.id) return;
    if (session.motionRules?.length) {
      void applyMotionRules(session, animation).then(applied => {
        if (!applied) return;
        session.motionApplied = [...(session.motionApplied ?? []), applied].slice(-50);
      }).catch(() => {});
    }
    session.animations.set(animation.id, {
      id: animation.id,
      name: animation.name || animation.cssId || animation.id,
      type: animation.type ?? 'WebAnimation',
      duration: animation.source?.duration ?? 0,
      delay: animation.source?.delay ?? 0,
      ...(animation.source?.backendNodeId ? { backendNodeId: animation.source.backendNodeId } : {}),
      startedAt: Date.now(),
    });
  });
  client.on('Animation.animationCanceled', (event: any) => {
    if (event?.id && !session.motionTouched?.has(event.id)) session.animations.delete(event.id);
  });
}

/**
 * Move every animation the session has seen on by `ms` of its own time. One
 * that has ended or been released answers with an error, and is dropped.
 */
export async function seekAnimations(session: BenchSession, ms: number): Promise<SeekReading[]> {
  // A transition is created at the style recalc after the change, and a hold
  // taken before that frame leaves it uncreated; getAnimations forces the
  // recalc, which creates it and has the domain report it.
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('bench-animations', 'document.getAnimations().length'),
    returnByValue: true,
  }).catch(() => undefined);
  const readings: SeekReading[] = [];
  for (const tracked of [...session.animations.values()]) {
    if (tracked.duration === undefined) {
      const timing = await resolveTiming(session, tracked.id);
      if (!timing) { session.animations.delete(tracked.id); continue; }
      Object.assign(tracked, timing);
    }
    let fromMs: number;
    try {
      const { currentTime } = await request(session.client, 'Animation.getCurrentTime', { id: tracked.id });
      // A transition held before its first frame has no start time yet, and
      // the domain answers with the timeline's zero as a large negative: it
      // stands at 0.
      fromMs = typeof currentTime === 'number' && currentTime > 0 ? currentTime : 0;
    } catch {
      session.animations.delete(tracked.id);
      continue;
    }
    const span = (tracked.delay ?? 0) + (tracked.duration ?? 0);
    if (span > 0 && fromMs >= span) {
      session.animations.delete(tracked.id);
      continue;
    }
    const toMs = Math.max(0, fromMs + ms);
    try {
      await send(session.client, 'Animation.seekAnimations', { animations: [tracked.id], currentTime: toMs });
    } catch {
      session.animations.delete(tracked.id);
      continue;
    }
    readings.push({
      id: tracked.id, name: tracked.name, type: tracked.type, fromMs, toMs, durationMs: tracked.duration ?? 0,
      progress: span > 0 ? Math.max(0, Math.min(1, (toMs - (tracked.delay ?? 0)) / Math.max(1, tracked.duration ?? 0))) : 0,
    });
  }
  return readings;
}

/**
 * The animations an input started, read where they stand: those created since
 * the frame stop in front of it was armed. Held at that stop they are created
 * and not yet started, so the start report carries none of them, and each is
 * read off its animation object.
 */
export async function readGroup(session: BenchSession): Promise<GroupAnimation[]> {
  const since = session.groupSince;
  if (since === undefined) return [];
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('bench-animations', 'document.getAnimations().length'),
    returnByValue: true,
  }).catch(() => undefined);
  const group: GroupAnimation[] = [];
  for (const tracked of [...session.animations.values()]) {
    if (tracked.startedAt < since) continue;
    if (tracked.easing === undefined) {
      const timing = await resolveTiming(session, tracked.id);
      if (!timing) continue;
      Object.assign(tracked, timing);
    }
    let currentMs: number;
    try {
      const { currentTime } = await request(session.client, 'Animation.getCurrentTime', { id: tracked.id });
      currentMs = typeof currentTime === 'number' && currentTime > 0 ? currentTime : 0;
    } catch {
      continue;
    }
    group.push({
      id: tracked.id, name: tracked.name, type: tracked.type,
      ...(tracked.element ? { element: tracked.element } : {}),
      delayMs: tracked.delay ?? 0, durationMs: tracked.duration ?? 0, easing: tracked.easing ?? 'linear', currentMs,
    });
  }
  return group.sort((a, b) => a.delayMs - b.delayMs || (a.element ?? '').localeCompare(b.element ?? '') || a.name.localeCompare(b.name));
}

/** The timing of an animation the domain has created and not yet reported started, read off the animation object. */
async function resolveTiming(session: BenchSession, id: string): Promise<Pick<TrackedAnimation, 'name' | 'type' | 'duration' | 'delay' | 'easing' | 'element'> | undefined> {
  try {
    const { remoteObject } = await request(session.client, 'Animation.resolveAnimation', { animationId: id });
    if (!remoteObject?.objectId) return undefined;
    const { result } = await request(session.client, 'Runtime.callFunctionOn', {
      objectId: remoteObject.objectId,
      functionDeclaration: `function () {
        const timing = this.effect && this.effect.getComputedTiming ? this.effect.getComputedTiming() : {};
        const type = this.transitionProperty !== undefined ? 'CSSTransition' : this.animationName !== undefined ? 'CSSAnimation' : 'WebAnimation';
        const name = this.transitionProperty || this.animationName || this.id || '';
        const target = this.effect && this.effect.target;
        const classes = target && typeof target.className === 'string' ? target.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
        const element = !target ? '' : target.id ? '#' + target.id : target.tagName.toLowerCase() + classes.map(function (c) { return '.' + c; }).join('');
        const easing = this.effect && this.effect.getTiming ? this.effect.getTiming().easing : 'linear';
        return { name, type, duration: typeof timing.duration === 'number' ? timing.duration : 0, delay: timing.delay || 0, easing, element };
      }`,
      returnByValue: true,
    });
    const value = result?.value;
    if (!value) return undefined;
    return { name: value.name || id, type: value.type, duration: value.duration, delay: value.delay, easing: value.easing || 'linear', ...(value.element ? { element: value.element } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The rate the page's animations run at while the screen is released. A hold
 * sets 0 and a release puts this back, so a settle watched at a fifth speed
 * stays at a fifth speed across a hold.
 */
export async function setPlaybackRate(session: BenchSession, playbackRate: number): Promise<void> {
  session.playbackRate = playbackRate;
  if (!session.frozen) await send(session.client, 'Animation.setPlaybackRate', { playbackRate });
  // The page's clock runs at the same rate, so its timers, its frame times and
  // the JS animations that read them slow with the CSS ones; a held clock
  // takes the rate up when it runs again.
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.rate(${Number(playbackRate)})`), returnByValue: true,
  }, 1000).catch(() => undefined);
}

export function releasedRate(session: BenchSession): number {
  return session.playbackRate ?? 1;
}

export type { CDPSession };
