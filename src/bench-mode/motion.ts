/**
 * The bench's motion controls on the page as it stands: the speed the page's
 * animations run at, and a seek on them while the screen is held. Freezing
 * and filming a motion belong to the step whose input starts it, where they
 * act inside that input's own call.
 */

import { promises as fs } from 'fs';
import type { BenchSession } from './session.js';
import { sessions } from './session.js';
import { request, send } from './cdp.js';
import { seekAnimations, setPlaybackRate } from './animations.js';
import { recordBenchCall } from '../person-watch.js';
import type { AnimationView, MotionView } from '../bench/wire.js';

/** Each running animation and how far through it stands, read without moving it. */
export async function animationsOf(session: BenchSession): Promise<AnimationView[]> {
  const views: AnimationView[] = [];
  for (const tracked of [...session.animations.values()]) {
    if (tracked.duration === undefined) continue;
    let currentMs: number;
    try {
      const { currentTime } = await request(session.client, 'Animation.getCurrentTime', { id: tracked.id }, 500);
      currentMs = typeof currentTime === 'number' && currentTime > 0 ? currentTime : 0;
    } catch {
      session.animations.delete(tracked.id);
      continue;
    }
    // A rule may have given it other timing, slowed or retimed; it runs to that.
    const applied = session.motionApplied?.find(one => one.id === tracked.id);
    const duration = applied?.duration || tracked.duration;
    const delay = applied ? applied.delay : tracked.delay ?? 0;
    const span = delay + duration;
    if (span > 0 && currentMs >= span) {
      session.animations.delete(tracked.id);
      continue;
    }
    const progress = duration ? Math.max(0, Math.min(1, (currentMs - delay) / duration)) : 0;
    views.push({
      id: tracked.id, name: tracked.name, ...(applied?.element ? { element: applied.element } : {}), type: tracked.type,
      currentMs: Math.round(currentMs), durationMs: duration, ownDurationMs: tracked.duration, delayMs: delay, progress,
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
  await send(session.client, 'Animation.seekAnimations', { animations: [id], currentTime: Math.max(0, currentMs) }).catch(() => {});
}

/** Close the burst sheet; `drop` deletes its frames from disk. */
export async function dismissBurst(connection: string, drop: boolean): Promise<void> {
  const session = sessions.get(connection);
  const burst = session?.burst;
  if (!session || !burst) return;
  session.burst = undefined;
  if (drop) await fs.rm(burst.dir, { recursive: true, force: true }).catch(() => undefined);
}
