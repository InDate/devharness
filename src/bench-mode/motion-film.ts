/**
 * One motion filmed through a step, as the person marked it on its row.
 *
 * A mark is taken once: the step that next runs with it starts the film and
 * clears it, so later plays run unfilmed. The screencast records each frame
 * the compositor swaps with the time it was swapped; the page samples the
 * element on every native frame - its value and where it stands - on the same
 * wall clock, so each frame carries the value it shows. The film ends
 * QUIET_MS after the last animation of the kind ends: at its end report, or
 * where none arrives - a finished transition can go unreported - once its own
 * duration has run out.
 *
 * Frames are taken as JPEG and written as they came, uncropped: a PNG per
 * frame, decoded and cropped here, loaded the page enough to change the motion
 * filmed - a stream read in fewer, larger chunks drew 4 transitions where an
 * unfilmed play drew 17. The film carries the crop for the viewer to apply.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { CDPSession } from 'puppeteer-core';
import { getOutputPath } from '../helpers/paths.js';
import { openSession } from '../utils/own-session.js';
import { ownScript } from '../utils/own-script.js';
import { animationKind, animationRecordOf, type RecordedAnimation } from '../animation-record.js';
import { observationsIn } from '../observation-log.js';
import { appendEvent } from '../session-events.js';
import { resolveSessionName } from '../session-identity.js';
import { targetOfKind } from './motion-rules.js';
import { sessions, type BenchSession } from './session.js';
import type { FilmFrame, FilmView } from '../bench/wire.js';
import type { FilmSummary } from '../tool-response.js';

const QUIET_MS = 400;
/** A mark whose motion never starts gives up after this long. */
const NOTHING_MS = 5000;
const CAP_MS = 20000;
const MAX_FRAMES = 1200;
/** Traffic and writes within this distance of a frame are listed on it. */
const NEAR_MS = 60;
const PAD = 8;
const FILM_KEY = 'devharness.film';
// Two films can run at once, on one step's two motions; each keeps its sampler under a name of its own.
let nextFilm = 1;

export interface Box { x: number; y: number; width: number; height: number }
export interface Sample { wallMs: number; value: string; box: Box }
export interface RawFrame { data: Buffer; wallMs: number; deviceWidth: number; deviceHeight: number }
interface Repeat { key: string; startedAt: number; durationMs: number; from?: string; to?: string; endedAt?: number; cause?: string }

/** The key a mark and a film are kept under. */
export const filmKey = (step: number, kind: string) => `${step}|${kind}`;

/**
 * Hand the frames `from` to `to` of a film to the session: each frame's file
 * and what the page held as it was drawn, so the session opens the pictures
 * the person picked and reads them against their details.
 */
export async function shareFilm(dir: string, from: number, to: number): Promise<void> {
  const view = JSON.parse(await fs.readFile(path.join(dir, 'film.json'), 'utf8')) as FilmView;
  const first = Math.max(0, Math.min(from, to));
  const last = Math.min(view.frames.length - 1, Math.max(from, to));
  const frames = view.frames.slice(first, last + 1).map((frame, i) => ({ frame: first + i + 1, ...frame }));
  await appendEvent(resolveSessionName(), 'film', {
    detail: `frames ${first + 1}-${last + 1} of ${view.frames.length} of ${view.kind} at step ${view.step + 1}, shared from the bench`,
    motion: view.kind, step: view.step + 1, dir, of: view.frames.length,
    ...(view.cause ? { cause: view.cause } : {}),
    frames,
  });
}

/** How long a listing waits on films still recording: past the longest a film runs. */
const SETTLE_WAIT_MS = 25000;

/** The films this bench holds, oldest first, once none is still recording. */
export async function settledFilms(session: BenchSession): Promise<FilmSummary[]> {
  const until = Date.now() + SETTLE_WAIT_MS;
  while (session.filming?.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  return Object.values(session.films ?? {})
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map(view => ({
      step: view.step, kind: view.kind, frames: view.frames.length,
      slides: Math.max(0, ...view.frames.map(one => one.repeat?.of ?? 0)),
      endedBy: view.endedBy, ...(view.outside ? { outside: view.outside } : {}), dir: view.dir,
    }));
}

/** Mark one motion of one step for filming on its next run, or take the mark away. */
export function markFilm(session: BenchSession, step: number, kind: string, on: boolean): void {
  const marks = session.filmMarks ??= new Set();
  if (on) marks.add(filmKey(step, kind));
  else marks.delete(filmKey(step, kind));
}

/** Start the films marked on `step`, clearing each mark; the films run on past the step and land on the session when they end. */
export async function startStepFilms(connection: string, step: number): Promise<void> {
  const session = sessions.get(connection);
  const marked = [...session?.filmMarks ?? []].filter(key => key.startsWith(`${step}|`));
  if (!session || !marked.length) return;
  for (const key of marked) {
    session.filmMarks!.delete(key);
    const kind = key.slice(`${step}|`.length);
    const filming = session.filming ??= new Set();
    filming.add(key);
    void film(session, connection, step, kind)
      .then(view => { if (view) (session.films ??= {})[key] = view; })
      .catch(() => undefined)
      .finally(() => filming.delete(key));
  }
}

/** The page script that samples the element each native frame, found by `selector` once it exists, kept under `name`. */
function samplerSource(name: string, selector: string, property: string): string {
  return ownScript('motion-film', `(() => {
    const g = globalThis;
    const clock = g[Symbol.for('devharness.clock')];
    const now = clock?.native?.perfNow ?? g.performance.now.bind(g.performance);
    const frame = clock?.native?.requestAnimationFrame ?? g.requestAnimationFrame.bind(g);
    const props = g.CSS && g.CSS.supports(${JSON.stringify(property)}, 'inherit') ? [${JSON.stringify(property)}] : ['transform', 'opacity'];
    const samples = [];
    let on = true;
    const tick = () => {
      if (!on) return;
      const element = g.document.querySelector(${JSON.stringify(selector)});
      if (element) {
        const style = g.getComputedStyle(element);
        const r = element.getBoundingClientRect();
        samples.push({
          wallMs: g.performance.timeOrigin + now(),
          value: props.length === 1 ? style.getPropertyValue(props[0]) : props.map(p => p + ': ' + style.getPropertyValue(p)).join('; '),
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        });
      }
      if (samples.length < ${MAX_FRAMES * 4}) frame(tick);
    };
    frame(tick);
    g[Symbol.for(${JSON.stringify(name)})] = { stop() { on = false; return samples; } };
    return true;
  })()`);
}

async function evaluate<T>(client: CDPSession, expression: string): Promise<T | undefined> {
  const reply: any = await client.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => undefined);
  return reply?.result?.value ?? undefined;
}

async function film(session: BenchSession, connection: string, step: number, kind: string): Promise<FilmView | undefined> {
  const target = targetOfKind(kind);
  if (!target?.element) return undefined;
  const ownKind = animationKind({ name: target.animation, element: target.element });
  const name = `${FILM_KEY}:${nextFilm++}`;
  const client = await openSession(session.page);
  const raw: RawFrame[] = [];
  const repeats = new Map<string, Repeat>();
  const startedAt = Date.now();
  let endedBy: FilmView['endedBy'] = 'quiet';
  let end: () => void = () => {};
  const ended = new Promise<void>(resolve => { end = resolve; });
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    clearTimeout(quiet);
    if (!repeats.size) return;
    const lastEnd = Math.max(...[...repeats.values()].map(one => one.endedAt ?? one.startedAt + one.durationMs));
    quiet = setTimeout(end, Math.max(0, lastEnd - Date.now()) + QUIET_MS);
  };
  const nothing = setTimeout(() => { if (!repeats.size) { endedBy = 'nothing'; end(); } }, NOTHING_MS);
  const cap = setTimeout(() => { endedBy = 'cap'; end(); }, CAP_MS);

  const onFrame = (event: any) => {
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    if (raw.length >= MAX_FRAMES) { endedBy = 'frames'; end(); return; }
    raw.push({
      data: Buffer.from(event.data, 'base64'),
      wallMs: event.metadata?.timestamp ? event.metadata.timestamp * 1000 : Date.now(),
      deviceWidth: event.metadata?.deviceWidth ?? 0,
      deviceHeight: event.metadata?.deviceHeight ?? 0,
    });
  };
  const unwatch = animationRecordOf(connection).watch((entry: RecordedAnimation, change) => {
    if (entry.kind !== ownKind || entry.createdAt < startedAt - 50) return;
    const known = repeats.get(entry.key);
    if (!known && entry.read) {
      repeats.set(entry.key, {
        key: entry.key, startedAt: entry.createdAt, durationMs: entry.read.duration,
        ...(entry.read.from !== undefined ? { from: entry.read.from } : {}),
        ...(entry.read.to !== undefined ? { to: entry.read.to } : {}),
        ...(entry.read.trigger ? { cause: entry.read.trigger } : {}),
      });
    }
    const one = repeats.get(entry.key);
    if (one && change === 'gone' && one.endedAt === undefined) one.endedAt = Date.now();
    settle();
  });

  client.on('Page.screencastFrame', onFrame);
  let samples: Sample[] = [];
  try {
    await client.send('Runtime.enable').catch(() => {});
    await evaluate(client, samplerSource(name, target.element, target.animation));
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    await ended;
  } finally {
    clearTimeout(quiet); clearTimeout(nothing); clearTimeout(cap);
    unwatch();
    client.off('Page.screencastFrame', onFrame);
    await client.send('Page.stopScreencast').catch(() => {});
    samples = (await evaluate<Sample[]>(client, ownScript('motion-film', `globalThis[Symbol.for(${JSON.stringify(name)})]?.stop() ?? []`))) ?? [];
    await client.detach().catch(() => {});
  }
  return write(step, kind, startedAt, endedBy, raw, samples, [...repeats.values()].sort((a, b) => a.startedAt - b.startedAt), ownKind);
}

/** The latest sample at or before `wallMs`. */
function sampleAt(samples: Sample[], wallMs: number): Sample | undefined {
  let found: Sample | undefined;
  for (const one of samples) {
    if (one.wallMs > wallMs) break;
    found = one;
  }
  return found ?? samples[0];
}

/** The crop each viewport size of a film takes, and whether the element stood outside the viewport for some or all of it. */
export function cropsBySize(raw: Array<Pick<RawFrame, 'wallMs' | 'deviceWidth' | 'deviceHeight'>>, samples: Sample[]) {
  // The page can change size while a film runs - a step setting the viewport
  // runs while the motion before it plays - and the element moves with the
  // layout. Frames are grouped by the viewport they show, and each group takes
  // one crop, so its frames line up: every place the element stood in that
  // span, padded and cut to the viewport, since a frame holds only what the
  // viewport shows. A group with nothing left in its viewport takes no crop.
  const sizeOf = (frame: Pick<RawFrame, 'deviceWidth' | 'deviceHeight'>) => `${frame.deviceWidth}x${frame.deviceHeight}`;
  const spans = new Map<string, { width: number; height: number }>();
  for (const frame of raw) {
    if (!spans.has(sizeOf(frame))) spans.set(sizeOf(frame), { width: frame.deviceWidth, height: frame.deviceHeight });
  }
  const crops = new Map<string, { clip?: Box; outside?: 'all' | 'part' }>();
  // A sample shows in the first frame drawn at or after it, so it counts toward that frame's size.
  const sizeTakenBy = (one: Sample) => {
    const shown = raw.find(frame => frame.wallMs >= one.wallMs) ?? raw[raw.length - 1];
    return shown ? sizeOf(shown) : undefined;
  };
  for (const [size, span] of spans) {
    const boxes = samples.filter(one => sizeTakenBy(one) === size)
      .map(one => one.box).filter(box => box.width > 0 || box.height > 0);
    if (!boxes.length) { crops.set(size, {}); continue; }
    const left = Math.max(0, Math.min(...boxes.map(box => box.x)) - PAD);
    const top = Math.max(0, Math.min(...boxes.map(box => box.y)) - PAD);
    const right = Math.min(span.width || Infinity, Math.max(...boxes.map(box => box.x + box.width)) + PAD);
    const bottom = Math.min(span.height || Infinity, Math.max(...boxes.map(box => box.y + box.height)) + PAD);
    const inside = right > left && bottom > top;
    const cut = boxes.some(box => box.x < 0 || box.y < 0 || box.x + box.width > span.width || box.y + box.height > span.height);
    crops.set(size, inside
      ? { clip: { x: left, y: top, width: right - left, height: bottom - top }, ...(cut ? { outside: 'part' as const } : {}) }
      : { outside: 'all' });
  }
  const outcomes = [...crops.values()].filter(one => one.clip || one.outside);
  const outside: FilmView['outside'] = outcomes.length && outcomes.every(one => one.outside === 'all') ? 'all'
    : outcomes.some(one => one.outside) ? 'part'
    : undefined;
  return { sizeOf, crops, outside };
}

async function write(step: number, kind: string, startedAt: number, endedBy: FilmView['endedBy'], raw: RawFrame[], samples: Sample[], repeats: Repeat[], ownKind: string): Promise<FilmView> {
  const dir = getOutputPath('screenshots', new Date().toISOString().split('T')[0], `film-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  const { sizeOf, crops, outside } = cropsBySize(raw, samples);
  const firstMotion = repeats[0]?.startedAt;

  const frames: FilmFrame[] = [];
  let lastValue: string | undefined;
  let lastSize: string | undefined;
  for (const frame of raw) {
    const sample = sampleAt(samples, frame.wallMs);
    // Frames where the element held still are kept once: the first shows the
    // stillness, the rest repeat it. A frame at a new viewport size is kept
    // whatever the value, since the page around the element changed.
    if (sample && sample.value === lastValue && sizeOf(frame) === lastSize && frames.length) continue;
    const resized = lastSize !== undefined && sizeOf(frame) !== lastSize;
    lastValue = sample?.value;
    lastSize = sizeOf(frame);
    const crop = crops.get(sizeOf(frame)) ?? {};
    const file = path.join(dir, `frame-${String(frames.length).padStart(4, '0')}.jpg`);
    await fs.writeFile(file, frame.data);
    const index = repeats.filter(one => one.startedAt <= frame.wallMs).length - 1;
    const repeat = index >= 0 ? repeats[index] : undefined;
    const next = repeats[index + 1];
    const near = observationsIn(frame.wallMs - NEAR_MS, frame.wallMs + NEAR_MS)
      .filter(one => !one.text.includes(ownKind)).slice(0, 4).map(one => one.text);
    frames.push({
      file,
      atMs: Math.round(frame.wallMs - startedAt),
      viewport: { width: frame.deviceWidth, height: frame.deviceHeight },
      ...(crop.clip ? { clip: crop.clip } : {}),
      ...(resized ? { resized: true as const } : {}),
      ...(firstMotion !== undefined ? { sinceMotionMs: Math.round(frame.wallMs - firstMotion) } : {}),
      ...(sample ? { value: sample.value, box: sample.box } : {}),
      ...(repeat ? { repeat: {
        index: index + 1, of: repeats.length,
        elapsedMs: Math.round(frame.wallMs - repeat.startedAt), durationMs: Math.round(repeat.durationMs),
        ...(repeat.from !== undefined ? { from: repeat.from } : {}),
        ...(repeat.to !== undefined ? { to: repeat.to } : {}),
        cutShort: next !== undefined && next.startedAt - repeat.startedAt < repeat.durationMs,
      } } : {}),
      near,
    });
  }
  const view: FilmView = {
    step, kind, dir, endedBy, frames,
    ...(outside ? { outside } : {}),
    durationMs: Math.round((raw.at(-1)?.wallMs ?? startedAt) - startedAt),
    ...(repeats[0]?.cause ? { cause: repeats[0].cause } : {}),
  };
  await fs.writeFile(path.join(dir, 'film.json'), JSON.stringify(view, null, 2));
  return view;
}
