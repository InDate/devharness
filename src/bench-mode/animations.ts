/**
 * The page's CSS transitions, CSS animations and web animations, as the page's
 * animation record holds them, and the two moves on them a hold allows.
 *
 * A screen hold stops the document timeline (playback rate 0), so every
 * animation stands where it was. A seek moves each running one on by a given
 * amount of its own time, and the compositor paints the new frame while the
 * page's JS stays stopped: a 420ms settle is read at 0, 105, 210 and 420ms
 * with a capture at each. The JS that drives a follow is not an animation and
 * does not move with it; a tick moves that.
 *
 * Each animation is read and moved through the page's own list by the id the
 * record names it by, which reaches one a held step created and Chrome cannot
 * resolve yet.
 */

import type { BenchSession } from './session.js';
import { applyMotionRules } from './motion-rules.js';
import { animationRecordOf, inPage, type RecordedAnimation } from '../animation-record.js';
import type { PageAnimation } from '../page-animations.js';

/** One animation of a group, where it stands. */
export interface GroupAnimation {
  /** The record's key for it. */
  id: string;
  name: string;
  type: PageAnimation['type'];
  element?: string;
  delayMs: number;
  durationMs: number;
  easing: string;
  currentMs: number;
}

export interface SeekReading {
  id: string;
  name: string;
  type: PageAnimation['type'];
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** 0 to 1 of the animation's active span, after the seek. */
  progress: number;
}

/** The animation an entry names, read where it stands now; undefined once the page has let it go. */
export async function readNow(session: BenchSession, entry: RecordedAnimation): Promise<PageAnimation | undefined> {
  if (!entry.read) return undefined;
  return (await inPage<PageAnimation | null>(session.client, entry.read.doc, `read(${entry.read.id})`)) ?? undefined;
}

/** Call one of the page list's controls on the animation an entry names; false where it is gone. */
export async function actOn(session: BenchSession, entry: RecordedAnimation, call: (id: number) => string): Promise<boolean> {
  if (!entry.read) return false;
  return (await inPage<boolean>(session.client, entry.read.doc, call(entry.read.id))) === true;
}

/** Apply the motion rules to each animation the record takes, as it takes it. */
export function watchAnimations(session: BenchSession): void {
  session.detachRules = animationRecordOf(session.connection).watch((entry, change) => {
    if (change !== 'added' || !entry.read || !session.motionRules?.length) return;
    void applyMotionRules(session, entry.key).then(applied => {
      if (applied) session.motionApplied = [...(session.motionApplied ?? []), applied].slice(-50);
    }).catch(() => {});
  });
}

/**
 * Move every animation the page still runs on by `ms` of its own time. One
 * that has ended, or that the page has let go, is passed over.
 */
export async function seekAnimations(session: BenchSession, ms: number): Promise<SeekReading[]> {
  const record = animationRecordOf(session.connection);
  // A transition is created at the style recalc after the change; the sweep
  // brings style up to date, which creates it, and takes it into the record.
  await record.settle(session.client);
  const readings: SeekReading[] = [];
  for (const entry of record.live()) {
    const now = await readNow(session, entry);
    if (!now) continue;
    const span = now.delay + now.duration;
    if (span > 0 && now.currentTime >= span) continue;
    const toMs = Math.max(0, now.currentTime + ms);
    if (!await actOn(session, entry, id => `seek(${id}, ${toMs})`)) continue;
    readings.push({
      id: entry.key, name: now.name, type: now.type, fromMs: now.currentTime, toMs, durationMs: now.duration,
      progress: span > 0 ? Math.max(0, Math.min(1, (toMs - now.delay) / Math.max(1, now.duration))) : 0,
    });
  }
  return readings;
}

/**
 * The animations an input started, read where they stand: those the record
 * took since the frame stop in front of it was armed.
 */
export async function readGroup(session: BenchSession): Promise<GroupAnimation[]> {
  const since = session.groupSince;
  if (since === undefined) return [];
  const record = animationRecordOf(session.connection);
  await record.settle(session.client);
  const group: GroupAnimation[] = [];
  for (const entry of record.live()) {
    if (entry.createdAt < since) continue;
    const now = await readNow(session, entry);
    if (!now) continue;
    group.push({
      id: entry.key, name: now.name, type: now.type,
      ...(now.element ? { element: now.element } : {}),
      delayMs: now.delay, durationMs: now.duration, easing: now.easing, currentMs: now.currentTime,
    });
  }
  return group.sort((a, b) => a.delayMs - b.delayMs || (a.element ?? '').localeCompare(b.element ?? '') || a.name.localeCompare(b.name));
}

/** The page's speed, for its clock and its CSS animations; a hold leaves it as it is. */
export async function setPlaybackRate(session: BenchSession, playbackRate: number): Promise<void> {
  await session.time.setRate(playbackRate);
}
