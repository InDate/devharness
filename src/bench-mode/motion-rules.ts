/**
 * Rules that act on one animation at a time: switch it off, play it alone,
 * hold it at a point, or give it other timing. Speed is not among them: the
 * page's speed, set by `hold rate`, covers its JS through the page clock as
 * well as its CSS, where a per-animation speed reached CSS alone and
 * multiplied with the page's.
 *
 * A rule acts on Chrome's animation objects - CSS transitions, CSS animations
 * and web animations. Motion a page drives from its own frame callbacks is
 * no such object, and no rule reaches it.
 *
 * A rule is applied as the page's animation record takes the animation: at
 * the end of the held step that created it, before its first painted frame,
 * or at its start on a running page. It is matched by what animates and by a
 * selector the animated element matches -
 * `#panel`, or `div.item:nth-child(4)` for one of several alike - and stays
 * in force across replays until cleared, so a replayed step meets it again.
 */

import type { BenchSession } from './session.js';
import { hold } from '../hold.js';
import { animationRecordOf, inPage } from '../animation-record.js';
import { actOn, readNow } from './animations.js';
import { sessions } from './session.js';
import type { MotionSetting } from '../bench/kinds.js';

export interface MotionRule {
  /** The animation-name, transition-property or web animation id; absent matches any. */
  animation?: string;
  /** A selector the animated element matches - `#id`, `tag.class`, `div.item:nth-child(4)`; absent matches any. */
  element?: string;
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

/** The freeze point in the animation's active time. */
function pointIn(rule: MotionRule): number {
  return Math.max(0, rule.freezeAt ?? 0);
}

const TOUCHED_KEPT = 500;

/** Mark an animation a rule acted on, the oldest marks dropped past the cap. */
function touch(session: BenchSession, id: string): void {
  const touched = session.motionTouched ??= new Set();
  touched.add(id);
  if (touched.size > TOUCHED_KEPT) touched.delete(touched.values().next().value as string);
}

function matches(rule: MotionRule, animation: string, matchesElement: (selector: string) => boolean): boolean {
  return (rule.animation === undefined || rule.animation === animation)
    && (rule.element === undefined || matchesElement(rule.element));
}

/**
 * One animation as the page reads it now: what animates, the element as the
 * rows name it, its timing, and which of `selectors` the element matches. An
 * animation gone, or a selector that does not parse, matches nothing.
 */
async function readAnimation(session: BenchSession, key: string, selectors: string[]): Promise<
  { animation: string; element?: string; delay: number; duration: number; matched: Record<string, boolean> } | undefined
> {
  const entry = animationRecordOf(session.connection).get(key);
  if (!entry?.read) return undefined;
  const now = await readNow(session, entry);
  if (!now) return undefined;
  const matched = (await inPage<Record<string, boolean>>(session.client, entry.read.doc, `matches(${entry.read.id}, ${JSON.stringify(selectors)})`)) ?? {};
  return { animation: now.name, ...(now.element ? { element: now.element } : {}), delay: now.delay, duration: now.duration, matched };
}

/** The same rule: what it matches, ignoring what it does. */
export function sameTarget(a: MotionRule, b: MotionRule): boolean {
  return a.animation === b.animation && a.element === b.element;
}

/** Animations whose page timing is kept for a rule to work from, at most. */
const BASES_KEPT = 500;

/**
 * Apply the session's rules to one animation, by its record key, and pause it
 * where an `alone` rule stands for another. Called as the record takes the
 * animation; `again` applies the rules to one
 * already acted on - a rule set while its group is held. The timing the page
 * first gave it is kept, so a rule applied again works from the page's
 * timing. Returns what was done.
 */
export async function applyMotionRules(session: BenchSession, id: string, again = false): Promise<MotionApplied | undefined> {
  const rules = session.motionRules ?? [];
  const bases = session.motionBases ??= new Map();
  if (!rules.length || !id || (bases.has(id) && !again)) return undefined;
  const selectors = [...new Set(rules.map(rule => rule.element).filter((one): one is string => one !== undefined))];
  const read = await readAnimation(session, id, selectors);
  if (!read) return undefined;
  const base = bases.get(id) ?? { delay: read.delay, duration: read.duration };
  bases.set(id, base);
  if (bases.size > BASES_KEPT) bases.delete(bases.keys().next().value as string);
  const { animation, element } = read;
  const entry = animationRecordOf(session.connection).get(id)!;
  const act = (call: (pageId: number) => string) => actOn(session, entry, call);
  const own = rules.filter(rule => matches(rule, animation, selector => read.matched[selector] === true));
  const did: string[] = [];

  if (!own.length) {
    if (rules.some(rule => rule.alone)) {
      touch(session, id);
      await act(pageId => `pause(${pageId})`);
      (session.motionPaused ??= new Set()).add(id);
      did.push('paused for an animation playing alone');
    }
    return did.length ? { id, animation, ...(element ? { element } : {}), did, delay: base.delay, duration: base.duration } : undefined;
  }

  const rule = Object.assign({}, ...own) as MotionRule;
  touch(session, id);
  const duration = typeof rule.duration === 'number' ? rule.duration : base.duration;
  const delay = typeof rule.delay === 'number' ? rule.delay : base.delay;
  if (typeof rule.duration === 'number' || typeof rule.delay === 'number') {
    await act(pageId => `retime(${pageId}, ${JSON.stringify({ duration, delay })})`);
    did.push(`timing ${Math.round(duration)}ms after ${Math.round(delay)}ms`);
  }
  if (rule.off) {
    await act(pageId => `seek(${pageId}, ${delay + duration})`);
    did.push('off: jumped to its end');
  } else if (typeof rule.freezeAt === 'number' && rule.whole) {
    // The page holds as the animation is created, its clock and every other
    // animation with it, and the animation is set to the point.
    const point = delay + pointIn(rule);
    session.pendingFreeze = hold(session.connection, { owner: { kind: 'rule' }, layers: ['ui'] })
      .then(async () => { await act(pageId => `seek(${pageId}, ${point})`); })
      .catch(() => undefined)
      .finally(() => { session.pendingFreeze = undefined; });
    did.push(`page held, it at ${Math.round(rule.freezeAt)}ms`);
  } else if (typeof rule.freezeAt === 'number') {
    await act(pageId => `pause(${pageId})`);
    await act(pageId => `seek(${pageId}, ${delay + pointIn(rule)})`);
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
    const record = animationRecordOf(session.connection);
    for (const key of session.motionPaused) {
      const entry = record.get(key);
      if (entry) await actOn(session, entry, pageId => `play(${pageId})`);
    }
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
