/**
 * The animations one page created, held once per page beside its time and its
 * holds: the list the evidence credits to steps and the bench's controls act
 * on.
 *
 * Two ways fill it, each naming an animation by the id the page gave it
 * (`page-animations.ts`), so one animation stands once whichever way first
 * reached it:
 *
 * - a held step's sweep, which the clock runs at the end of each `frame` and
 *   callback step, and which reaches the animations Chrome cannot resolve
 *   while they are pending;
 * - Chrome's Animation domain while the page runs: its creation report marks
 *   the step the animation was created in, and its start report, the first
 *   moment Chrome can resolve the object, reads it and takes its page id.
 *
 * An animation is credited, as it is captured, to the step running when it
 * was created; nothing is credited by a window of time after a step ends. One
 * Chrome reports created and cancelled before it could be read stands with no
 * name: the page let it go before its object could be reached.
 *
 * Chrome's `Animation.resolveAnimation` releases the object every earlier
 * resolve on the session returned (its "animation" object group), so a
 * resolve and the read of what it returned run as one unit, one at a time,
 * through this record alone.
 */

import type { CDPSession } from 'puppeteer-core';
import { currentCursor } from './proxy/registry.js';
import type { ProxyCursor } from './proxy/intercept-proxy.js';
import { ANIMATIONS_KEY, type PageAnimation, type SweepReading } from './page-animations.js';
import { debugLog } from './debug-logger.js';
import { causeAt, causeBefore } from './proxy/cause-timeline.js';
import type { MotionReport, MotionStop } from './page-motion.js';
import type { MotionType } from './page-animations.js';

/** The history entry a cursor stands for: one step can stand under more than one cursor object. */
function entryOfCursor(cursor: ProxyCursor | undefined): number | undefined {
  return cursor?.kind === 'command' ? cursor.index : cursor?.kind === 'replay' ? cursor.entry : undefined;
}

const MOTION_TYPES: Record<MotionReport['source'], MotionType> = {
  style: 'StyleWrites', attribute: 'AttributeWrites', text: 'TextWrites', canvas: 'Canvas', media: 'Media', smil: 'SMIL', scroll: 'Scroll',
};
import { ownFunction, ownScript } from './utils/own-script.js';

export interface RecordedAnimation {
  /** `<doc>:<page id>`, or `chrome:<id>` for one no read reached. */
  key: string;
  /** What animates and on which element: the name a comparison across runs reads. */
  kind: string;
  read?: PageAnimation;
  /** Chrome's id for it, once a report of Chrome's named it. */
  chromeId?: string;
  /** The step running when it was created; absent outside any step. */
  createdIn?: ProxyCursor;
  createdAt: number;
  via: 'sweep' | 'chrome' | 'motion';
  gone?: 'finished' | 'canceled';
  /** A motion that ended under another step than it began in: when, and which step. */
  endedAt?: number;
  endedIn?: ProxyCursor;
  /** What ended it, where the page read one: a pause call, or the media's own end. */
  stoppedBy?: MotionStop;
}

/** What a listener hears: an animation added, a motion's reading updated as it closes, an animation ended. */
export type AnimationChange = 'added' | 'updated' | 'gone';

/** An animation kind as rows and comparisons name it: `opacity #toast`. */
export function animationKind(read: Pick<PageAnimation, 'name' | 'element'>): string {
  return read.element ? `${read.name} ${read.element}` : read.name;
}

/** Most entries a page keeps; the oldest go first. */
const KEPT = 2000;
/** Longest a step's settle waits on a sweep or on queued reads. */
const SETTLE_MS = 1000;

export class AnimationRecord {
  private readonly entries = new Map<string, RecordedAnimation>();
  private readonly byChrome = new Map<string, string>();
  /** Chrome's creation reports not yet read: the step and moment each was created in. */
  private readonly created = new Map<string, { at: number; cursor: ProxyCursor | undefined }>();
  private readonly listeners = new Set<(entry: RecordedAnimation, change: AnimationChange) => void>();
  private reads: Promise<unknown> = Promise.resolve();

  constructor(readonly connection: string) {}

  /** Run `read` after every read queued before it; nothing else resolves an animation in between. */
  queueRead<T>(read: () => Promise<T>): Promise<T | undefined> {
    const next = this.reads.then(read, read).catch(() => undefined);
    this.reads = next;
    return next;
  }

  /** Resolves once every read queued so far has landed. */
  async idle(): Promise<void> {
    await this.reads;
  }

  /**
   * Sweep the page's own list now, credited to the step running, and wait for
   * Chrome's reads queued so far: a step's comparison reads what the step
   * created, pending ones included, rather than what Chrome has reported by
   * then. A page whose code is stopped answers no evaluate, so the sweep is
   * given up on after `boundMs`.
   */
  async settle(client: CDPSession, boundMs = SETTLE_MS, credited?: ProxyCursor): Promise<void> {
    const cursor = credited ?? currentCursor();
    const swept = client.send('Runtime.evaluate', {
      expression: ownScript('animation-sweep', `globalThis[Symbol.for('${ANIMATIONS_KEY}')]?.sweep() ?? null`), returnByValue: true,
    }).then((answer: any) => this.takeSweep(answer?.result?.value ?? undefined, cursor)).catch(() => undefined);
    await Promise.race([swept, new Promise(resolve => setTimeout(resolve, boundMs))]);
    await Promise.race([this.idle(), new Promise(resolve => setTimeout(resolve, boundMs))]);
  }

  list(): RecordedAnimation[] {
    return [...this.entries.values()];
  }

  get(key: string): RecordedAnimation | undefined {
    return this.entries.get(key);
  }

  /** The animations read and not yet ended. */
  live(): RecordedAnimation[] {
    return this.list().filter(entry => entry.read && !entry.gone);
  }

  /** Each animation added, each motion's reading updated as it closes, and each that ends, as it happens. */
  watch(listener: (entry: RecordedAnimation, change: AnimationChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A held step's sweep, credited to the step that ran it. */
  takeSweep(reading: SweepReading | undefined, cursor: ProxyCursor | undefined = currentCursor()): void {
    if (!reading) return;
    const at = Date.now();
    for (const read of reading.created) this.add({ read, at, cursor, via: 'sweep' });
    for (const gone of reading.gone) this.end(`${reading.doc}:${gone.id}`, gone.how);
  }

  /**
   * A motion the page made with no Animation object behind it: a row of its
   * step, and no animation to seek or pause. Its open report adds it, credited
   * to the step in effect when it began, so that step reads it while it is
   * still moving; its close report fills in how it ran and ends it. Each is
   * placed on wall time from the page time its report carries. A close whose
   * open never arrived - motion detection turned on part-way through - adds it
   * already ended.
   */
  takeMotion(report: MotionReport, arrivedAt: number): void {
    const key = `motion:${report.doc}:${report.id}`;
    const startedAt = arrivedAt - Math.max(0, report.sentMs - report.startMs);
    const ran = Math.max(0, Math.round(report.endMs - report.startMs));
    const closing = report.phase === 'close';
    const read: PageAnimation = {
      id: report.id, doc: 'motion', name: report.property, type: MOTION_TYPES[report.source],
      ...(report.element ? { element: report.element } : {}),
      duration: ran, delay: 0, easing: '', looping: false,
      playState: closing ? 'finished' : 'running', currentTime: ran,
      from: report.from, to: report.to, frames: report.frames,
      ...(report.trigger ? { trigger: report.trigger } : {}),
      ...(report.maker ? { maker: report.maker } : {}),
      ...(report.makerRef !== undefined ? { makerRef: report.makerRef } : {}),
      ...(report.makerName ? { makerName: report.makerName } : {}),
      ...(report.makerAt ? { makerAt: report.makerAt } : {}),
    };
    // Start and end are each placed after the action they followed, by the
    // same rule, so the two compare as history entries.
    const namesEntry = (one: ProxyCursor) => entryOfCursor(one) !== undefined;
    const known = this.entries.get(key);
    const cursor = known ? known.createdIn : causeBefore(startedAt, namesEntry) ?? currentCursor();
    // A motion stopped by a later step - a pause press, a toggle - ends under
    // that step; the step it ended in is read the same way as the one it began in.
    const endedAt = arrivedAt - Math.max(0, report.sentMs - report.endMs);
    const endedIn = closing ? causeBefore(endedAt, namesEntry) : undefined;
    const ending = endedIn && entryOfCursor(endedIn) !== entryOfCursor(cursor)
      ? { endedAt, endedIn, ...(report.stoppedBy ? { stoppedBy: report.stoppedBy } : {}) }
      : {};
    if (known) {
      Object.assign(known, { read, ...(closing ? { gone: 'finished' as const } : {}), ...ending });
      this.emit(known, 'updated');
      return;
    }
    const entry: RecordedAnimation = {
      key, kind: animationKind(read), read, createdAt: startedAt,
      ...(cursor ? { createdIn: cursor } : {}), via: 'motion', ...(closing ? { gone: 'finished' as const } : {}),
      ...ending,
    };
    this.store(entry);
    this.emit(entry, 'added');
  }

  /** Chrome reported an animation created: the step it belongs to is the one running now. */
  chromeCreated(chromeId: string, cursor: ProxyCursor | undefined = currentCursor()): void {
    if (this.byChrome.has(chromeId) || this.created.has(chromeId)) return;
    this.created.set(chromeId, { at: Date.now(), cursor });
    if (this.created.size > KEPT) this.created.delete(this.created.keys().next().value as string);
  }

  /** Chrome reported it started, and the object it resolved to read as `read`. */
  chromeStarted(chromeId: string, read: PageAnimation | undefined): void {
    if (this.byChrome.has(chromeId)) return;
    const created = this.created.get(chromeId);
    this.created.delete(chromeId);
    if (!read) return;
    const key = `${read.doc}:${read.id}`;
    const known = this.entries.get(key);
    if (known) {
      known.chromeId = chromeId;
      this.byChrome.set(chromeId, key);
      return;
    }
    this.add({ read, at: created?.at ?? Date.now(), cursor: created ? created.cursor : currentCursor(), via: 'chrome', chromeId });
  }

  /** Chrome reported it cancelled; one no read reached stands with no name. */
  chromeCanceled(chromeId: string): void {
    const key = this.byChrome.get(chromeId);
    if (key) { this.end(key, 'canceled'); return; }
    const created = this.created.get(chromeId);
    if (!created) return;
    this.created.delete(chromeId);
    const entry: RecordedAnimation = {
      key: `chrome:${chromeId}`, kind: 'animation (unread)', chromeId, createdAt: created.at,
      ...(created.cursor ? { createdIn: created.cursor } : {}), via: 'chrome', gone: 'canceled',
    };
    this.store(entry);
    this.emit(entry, 'added');
  }

  private add(input: { read: PageAnimation; at: number; cursor: ProxyCursor | undefined; via: 'sweep' | 'chrome'; chromeId?: string }): void {
    const key = `${input.read.doc}:${input.read.id}`;
    if (this.entries.has(key)) return;
    const entry: RecordedAnimation = {
      key, kind: animationKind(input.read), read: input.read, createdAt: input.at,
      ...(input.cursor ? { createdIn: input.cursor } : {}), via: input.via,
      ...(input.chromeId ? { chromeId: input.chromeId } : {}),
    };
    if (input.chromeId) this.byChrome.set(input.chromeId, key);
    this.store(entry);
    this.emit(entry, 'added');
  }

  private end(key: string, how: 'finished' | 'canceled'): void {
    const entry = this.entries.get(key);
    if (!entry || entry.gone) return;
    entry.gone = how;
    this.emit(entry, 'gone');
  }

  private store(entry: RecordedAnimation): void {
    this.entries.set(entry.key, entry);
    if (this.entries.size <= KEPT) return;
    const oldest = this.entries.values().next().value as RecordedAnimation;
    this.entries.delete(oldest.key);
    if (oldest.chromeId) this.byChrome.delete(oldest.chromeId);
  }

  private emit(entry: RecordedAnimation, change: AnimationChange): void {
    debugLog('animation-record', `${change} ${entry.key} ${entry.kind} via ${entry.via}${entry.gone ? ` ${entry.gone}` : ''} in ${JSON.stringify(entry.createdIn ?? null)}`);
    for (const listener of this.listeners) {
      try { listener(entry, change); } catch { /* one listener's failure leaves the others fed */ }
    }
  }
}

const records = new Map<string, AnimationRecord>();

/** The record of a page, made the first time anything asks for it. */
export function animationRecordOf(connection: string): AnimationRecord {
  let record = records.get(connection);
  if (!record) {
    record = new AnimationRecord(connection);
    records.set(connection, record);
  }
  return record;
}

export function forgetAnimationRecord(connection: string): void {
  records.delete(connection);
}

/**
 * Feed a record from Chrome's Animation domain on a session that has it
 * enabled; returns the detach. A start report's object is read by the page's
 * own list, so it takes the id a sweep gives it.
 */
export function feedFromChrome(record: AnimationRecord, client: CDPSession): () => void {
  const created = (event: any) => { if (event?.id) record.chromeCreated(String(event.id)); };
  const started = (event: any) => {
    const chromeId = event?.animation?.id;
    if (!chromeId) return;
    void record.queueRead(async () => {
      const read = await readStarted(client, String(chromeId))
        .catch(error => { debugLog('animation-record', `reading ${chromeId} at its start failed: ${error}`); return undefined; });
      record.chromeStarted(String(chromeId), read);
    });
  };
  const canceled = (event: any) => { if (event?.id) record.chromeCanceled(String(event.id)); };
  client.on('Animation.animationCreated', created);
  client.on('Animation.animationStarted', started);
  client.on('Animation.animationCanceled', canceled);
  return () => {
    client.off('Animation.animationCreated', created);
    client.off('Animation.animationStarted', started);
    client.off('Animation.animationCanceled', canceled);
  };
}

/**
 * Call one of the page list's controls on an animation of document `doc`,
 * through the page itself: it reaches a pending animation, which Chrome's
 * commands by id do not. A page whose code is stopped outside devharness's
 * own hold answers no evaluate, so the call is given up on after `boundMs`;
 * undefined answers a call given up on, or one on another document.
 */
export async function inPage<T>(client: CDPSession, doc: string, call: string, boundMs = SETTLE_MS): Promise<T | undefined> {
  const answer = client.send('Runtime.evaluate', {
    expression: ownScript('animation-list', `(() => { const list = globalThis[Symbol.for('${ANIMATIONS_KEY}')]; return list && list.doc === ${JSON.stringify(doc)} ? list.${call} : null; })()`),
    returnByValue: true,
  }).then((reply: any) => reply?.result?.value ?? undefined).catch(() => undefined);
  return Promise.race([answer, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), boundMs))]);
}

/** The started animation read by the page's own list, under its page id. */
async function readStarted(client: CDPSession, chromeId: string): Promise<PageAnimation | undefined> {
  const { remoteObject } = await client.send('Animation.resolveAnimation', { animationId: chromeId });
  if (!remoteObject?.objectId) return undefined;
  try {
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: remoteObject.objectId,
      functionDeclaration: ownFunction('animation-read', `function () { var list = globalThis[Symbol.for('${ANIMATIONS_KEY}')]; return list ? list.describe(this) : null; }`),
      returnByValue: true,
    });
    return result?.value ?? undefined;
  } finally {
    await client.send('Runtime.releaseObject', { objectId: remoteObject.objectId }).catch(() => {});
  }
}
