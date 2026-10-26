/**
 * The bench's motion controls on the page as it stands: the speed the page's
 * animations run at, and a seek on them while the screen is held. Freezing
 * and filming a motion belong to the step whose input starts it, where they
 * act inside that input's own call.
 */

import { promises as fs } from 'fs';
import type { BenchSession } from './session.js';
import { sessions } from './session.js';
import { actOn, readNow, seekAnimations, setPlaybackRate } from './animations.js';
import { animationRecordOf } from '../animation-record.js';
import { recordBenchCall } from '../person-watch.js';
import type { AnimationView, MotionView } from '../bench/wire.js';

/** Each running animation and how far through it stands, read without moving it. */
export async function animationsOf(session: BenchSession): Promise<AnimationView[]> {
  const views: AnimationView[] = [];
  for (const entry of animationRecordOf(session.connection).live()) {
    const now = await readNow(session, entry);
    // Only an Animation object stands still to be seeked; page motion is recorded, not driven.
    if (!now || (now.type !== 'CSSTransition' && now.type !== 'CSSAnimation' && now.type !== 'WebAnimation')) continue;
    // A rule may have given it other timing; it runs to that.
    const applied = session.motionApplied?.find(one => one.id === entry.key);
    const duration = applied?.duration || now.duration;
    const delay = applied ? applied.delay : now.delay;
    const span = delay + duration;
    if (span > 0 && now.currentTime >= span) continue;
    const progress = duration ? Math.max(0, Math.min(1, (now.currentTime - delay) / duration)) : 0;
    views.push({
      id: entry.key, name: now.name, ...(now.element ? { element: now.element } : {}), type: now.type,
      currentMs: Math.round(now.currentTime), durationMs: duration, ownDurationMs: entry.read?.duration ?? now.duration, delayMs: delay, progress,
    });
  }
  return views;
}

/** The motion part of the bench's view: the speed, and the animations while the screen is held. */
export async function motionOf(session: BenchSession): Promise<MotionView> {
  const reading = await session.time.reading();
  return {
    playbackRate: session.time.playbackRate,
    // Read while something holds them: the screen, or a rule freezing one animation.
    animations: session.frozen || session.motionPaused?.size ? await animationsOf(session) : [],
    ...(reading ? { clock: { now: reading.now, behind: Number(reading.behind) || 0, paused: reading.paused, rate: reading.rate } } : {}),
  };
}

export async function seekBench(connection: string, ms: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const moved = await seekAnimations(session, ms);
  const line = moved.length
    ? `moved ${moved.length} animation${moved.length === 1 ? '' : 's'} on by ${ms}ms`
    : `moved nothing: no animation was running`;
  await recordBenchCall(connection, 'hold', { action: 'seek', ms }, line);
}

export async function setBenchRate(connection: string, playbackRate: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  await setPlaybackRate(session, playbackRate);
  await recordBenchCall(connection, 'hold', { action: 'rate', playbackRate }, `animations run at ${playbackRate}×`);
}

/** Put one animation at `currentMs` of its own time, as the hold strip's line is dragged. */
export async function seekOne(connection: string, id: string, currentMs: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const entry = animationRecordOf(connection).get(id);
  if (entry) await actOn(session, entry, pageId => `seek(${pageId}, ${Math.max(0, currentMs)})`);
}

/** Close the burst sheet; `drop` deletes its frames from disk. */
export async function dismissBurst(connection: string, drop: boolean): Promise<void> {
  const session = sessions.get(connection);
  const burst = session?.burst;
  if (!session || !burst) return;
  session.burst = undefined;
  if (drop) await fs.rm(burst.dir, { recursive: true, force: true }).catch(() => undefined);
}
