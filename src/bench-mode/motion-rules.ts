/**
 * Rules that act on one animation at a time, as it starts: slow it, switch it
 * off, play it alone, hold it at a point, or give it other timing.
 *
 * Chrome's Animation domain reports an animation once it has started, after
 * the frame that started it, so a rule takes hold a frame or two into the
 * motion. A rule is matched by what animates and on which element, the key
 * the bench's ACTION rows carry, and stays in force across replays until it
 * is cleared, so a replayed step meets it again.
 */

import type { BenchSession } from './session.js';
import { send } from './cdp.js';
import { elementName } from '../write-watch.js';
import { hold } from '../hold.js';
import { sessions } from './session.js';
import type { MotionSetting } from '../bench/kinds.js';

export interface MotionRule {
  /** The animation-name, transition-property or web animation id; absent matches any. */
  animation?: string;
  /** The element as the rows name it, `#id` or `tag.class`; absent matches any. */
  element?: string;
  /** Run this animation at this multiple of real time, by scaling its duration and delay: below 1 slower, above 1 faster. */
  slow?: number;
  /** Jump this animation to its end as it starts: the element lands where the app put it, with no motion. */
  off?: boolean;
  /** Pause every other animation that starts while this rule stands. */
  alone?: boolean;
  /** Hold this animation this many ms into its active time, the rest of the page running. */
  freezeAt?: number;
  /** Its duration and delay, in ms, in place of the page's. */
  duration?: number;
  delay?: number;
  /** With `freezeAt`: the whole page holds at that point, in place of this animation alone. */
  whole?: boolean;
  /** Set from a step's stored motion, and cleared when the next step starts. */
  fromStep?: boolean;
}

export interface MotionApplied {
  id: string;
  animation: string;
  element?: string;
  did: string[];
  /** The timing it ran with, for a scrub to seek within. */
  delay: number;
  duration: number;
}

/** The freeze point in the animation's running time: given in its own time, and stretched where it is slowed. */
function pointIn(rule: MotionRule): number {
  const slow = typeof rule.slow === 'number' && rule.slow > 0 ? rule.slow : 1;
  return Math.max(0, rule.freezeAt ?? 0) / slow;
}

const TOUCHED_KEPT = 500;

/** Mark an animation a rule acted on, the oldest marks dropped past the cap. */
function touch(session: BenchSession, id: string): void {
  const touched = session.motionTouched ??= new Set();
  touched.add(id);
  if (touched.size > TOUCHED_KEPT) touched.delete(touched.values().next().value as string);
}

function matches(rule: MotionRule, animation: string, element: string | undefined): boolean {
  return (rule.animation === undefined || rule.animation === animation)
    && (rule.element === undefined || rule.element === element);
}

/** The same rule: what it matches, ignoring what it does. */
export function sameTarget(a: MotionRule, b: MotionRule): boolean {
  return a.animation === b.animation && a.element === b.element;
}

/**
 * Apply the session's rules to an animation that has just started, and
 * pause it where an `alone` rule stands for another. Returns what was done.
 */
export async function applyMotionRules(session: BenchSession, started: any): Promise<MotionApplied | undefined> {
  const rules = session.motionRules ?? [];
  if (!rules.length || !started?.id) return undefined;
  const source = started.source ?? {};
  const animation = String(started.name || started.cssId || started.id);
  const element = source.backendNodeId ? await elementName(session.client, source.backendNodeId) : undefined;
  const own = rules.filter(rule => matches(rule, animation, element));
  const did: string[] = [];
  const id = started.id as string;

  if (!own.length) {
    if (rules.some(rule => rule.alone)) {
      touch(session, id);
      await send(session.client, 'Animation.setPaused', { animations: [id], paused: true }).catch(() => {});
      (session.motionPaused ??= new Set()).add(id);
      did.push('paused for an animation playing alone');
    }
    return did.length ? { id, animation, ...(element ? { element } : {}), did, delay: Number(source.delay) || 0, duration: Number(source.duration) || 0 } : undefined;
  }

  const rule = Object.assign({}, ...own) as MotionRule;
  touch(session, id);
  let duration = typeof rule.duration === 'number' ? rule.duration : Number(source.duration) || 0;
  let delay = typeof rule.delay === 'number' ? rule.delay : Number(source.delay) || 0;
  if (typeof rule.slow === 'number' && rule.slow > 0 && rule.slow !== 1) {
    duration /= rule.slow;
    delay /= rule.slow;
    did.push(`speed ${rule.slow}×`);
  }
  if (typeof rule.duration === 'number' || typeof rule.delay === 'number' || did.length) {
    await send(session.client, 'Animation.setTiming', { animationId: id, duration, delay }).catch(() => {});
    if (typeof rule.duration === 'number' || typeof rule.delay === 'number') did.push(`timing ${Math.round(duration)}ms after ${Math.round(delay)}ms`);
  }
  if (rule.off) {
    await send(session.client, 'Animation.seekAnimations', { animations: [id], currentTime: delay + duration }).catch(() => {});
    did.push('off: jumped to its end');
  } else if (typeof rule.freezeAt === 'number' && rule.whole) {
    // The page holds when this animation reaches the point, timed from now,
    // which is a frame or two after it started.
    const at = Math.max(0, delay + pointIn(rule));
    session.pendingFreeze = new Promise<void>(resolve => setTimeout(() => {
      void hold(session.connection, { source: 'tool', layers: ['ui'] }).catch(() => undefined).finally(() => {
        session.pendingFreeze = undefined;
        resolve();
      });
    }, at));
    did.push(`page held at ${Math.round(rule.freezeAt)}ms`);
  } else if (typeof rule.freezeAt === 'number') {
    await send(session.client, 'Animation.setPaused', { animations: [id], paused: true }).catch(() => {});
    await send(session.client, 'Animation.seekAnimations', { animations: [id], currentTime: delay + pointIn(rule) }).catch(() => {});
    (session.motionPaused ??= new Set()).add(id);
    did.push(`held at ${Math.round(rule.freezeAt)}ms`);
  }
  return { id, animation, ...(element ? { element } : {}), did, delay, duration };
}

/** Set a rule in place of one with the same target, or clear the rules matching a target, all with none named. */
export async function changeMotionRules(session: BenchSession, change: { rule?: MotionRule; clear?: MotionRule }): Promise<MotionRule[]> {
  let rules = session.motionRules ?? [];
  if (change.clear) {
    const target = change.clear;
    const named = target.animation !== undefined || target.element !== undefined;
    rules = named ? rules.filter(rule => !sameTarget(rule, target)) : [];
  }
  if (change.rule) rules = [...rules.filter(rule => !sameTarget(rule, change.rule!)), change.rule];
  session.motionRules = rules;
  // The animations a rule paused run again once no rule holds them: a held
  // point or an animation playing alone ends with the rule that set it.
  const stillHolding = rules.some(rule => rule.alone || typeof rule.freezeAt === 'number');
  if (!stillHolding && session.motionPaused?.size) {
    await send(session.client, 'Animation.setPaused', { animations: [...session.motionPaused], paused: false }).catch(() => {});
    session.motionPaused.clear();
  }
  return rules;
}

/** The animation and element an animation row's kind names: `animation transform #box`. */
export function targetOfKind(kind: string): { animation: string; element?: string } | undefined {
  const named = kind.startsWith('animation ') ? kind.slice('animation '.length).trim() : '';
  if (!named) return undefined;
  const space = named.indexOf(' ');
  return space < 0 ? { animation: named } : { animation: named.slice(0, space), element: named.slice(space + 1) };
}

/**
 * The motion stored on the step about to run, as rules in place of the last
 * step's. A step's settings stand until the next step starts, so a freeze it
 * set holds while the run is paused there.
 */
export async function applyStepMotion(connection: string, motion: Record<string, MotionSetting> | undefined): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const kept = (session.motionRules ?? []).filter(rule => !rule.fromStep);
  const fromStep = Object.entries(motion ?? {}).flatMap(([kind, setting]) => {
    const target = targetOfKind(kind);
    if (!target) return [];
    const { only, ...rest } = setting;
    return [{
      ...target, ...rest, fromStep: true,
      ...(typeof setting.freezeAt === 'number' && !only ? { whole: true } : {}),
    } as MotionRule];
  });
  if (!fromStep.length && kept.length === (session.motionRules ?? []).length) return;
  session.motionRules = kept;
  await changeMotionRules(session, {});
  session.motionRules = [...kept, ...fromStep];
}

/** Clear the rules a step set, letting what they paused run: a release of the hold, or the run moving on. */
export async function clearStepMotion(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.motionRules?.some(rule => rule.fromStep)) return;
  session.motionRules = session.motionRules.filter(rule => !rule.fromStep);
  await changeMotionRules(session, {});
}
