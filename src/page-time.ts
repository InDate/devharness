/**
 * The page's time, owned in one place per page: the page clock that its
 * timers, Date, performance.now and frame times read (`page-clock.ts`), and
 * the rate its CSS animations run at, which Chrome's compositor keeps apart
 * from the page's JS. Both are driven through one Chrome session, the page's
 * debugger connection where there is one, so time is held, stepped and sped
 * the same whether the bench is open or not.
 *
 * Stopping time stops both: the CSS rate goes to 0 and the clock stops, and a
 * timer set before a stop fires as though the stop took no time. The speed
 * is the page's, for its JS timing and its CSS together; a stop does not
 * change it, and time runs at it again once started.
 */

import { CLOCK_KEY } from './page-clock.js';
import { ownScript } from './utils/own-script.js';

/** A Chrome session commands are sent through. */
export interface TimeChannel {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

/** Where page time stands, as the clock reports it. */
export interface ClockReading {
  now: number;
  /** How far behind wall time holds and slower speeds have left page time. */
  behind: number;
  paused: boolean;
  rate: number;
  timers: number;
  framesHeld: boolean;
  framesWaiting: number;
}

/** One frame step's outcome: page time reached, frame callbacks run, frame callbacks queued for the next. */
export interface FrameReading {
  now: number;
  ran: number;
  waiting: number;
}

/** What the clock's next held timer or frame was, run on a stopped page. */
export interface NextReading {
  kind: string;
  fn: string;
  now: number;
}

/** A command a held page does not answer is given up on after this; the page goes on. */
const COMMAND_MS = 3000;

export class PageTime {
  private speed = 1;
  private animationsHeld = false;
  private animationDomain?: Promise<unknown>;

  constructor(readonly connection: string, private readonly channel: TimeChannel) {}

  /** The page's speed: 1 is real time. A stop leaves it as it is. */
  get playbackRate(): number {
    return this.speed;
  }

  /** Whether the CSS animations stand still under a stop. */
  get stopped(): boolean {
    return this.animationsHeld;
  }

  /** Stop the CSS animations and the clock together. */
  async stop(): Promise<void> {
    await this.holdAnimations();
    await this.pauseClock();
  }

  /** Run the clock and the CSS animations on at the page's speed. */
  async start(): Promise<void> {
    await this.resumeClock();
    await this.releaseAnimations();
  }

  /** The CSS animations to rate 0, the clock left as it is. */
  async holdAnimations(): Promise<void> {
    this.animationsHeld = true;
    await this.animationRate(0);
  }

  /** The CSS animations back to the page's speed. */
  async releaseAnimations(): Promise<void> {
    this.animationsHeld = false;
    await this.animationRate(this.speed);
  }

  /** Stop page time where it stands. */
  async pauseClock(): Promise<void> {
    await this.control('pause()');
  }

  /** Run page time on from where it stopped, and the frames held with it. */
  async resumeClock(): Promise<void> {
    await this.control('resume()');
  }

  /** The page's speed, for its clock and its CSS animations; the CSS takes it now, or once a stop ends. */
  async setRate(playbackRate: number): Promise<void> {
    this.speed = playbackRate;
    if (!this.animationsHeld) await this.animationRate(playbackRate);
    await this.control(`rate(${Number(playbackRate)})`);
  }

  /** Queue the app's frame callbacks in place of Chrome's frames; false on a page with no clock. */
  async holdFrames(): Promise<boolean> {
    return (await this.control('holdFrames() === true')) === true;
  }

  /** One frame of the page's JS on a stopped clock; undefined on a page with no clock. */
  async frame(ms: number): Promise<FrameReading | undefined> {
    return (await this.control(`frame(${Number(ms)})`)) ?? undefined;
  }

  /** The next timer or held frame a stopped clock holds, run; undefined when it holds nothing. */
  async next(frameMs: number): Promise<NextReading | undefined> {
    return (await this.control(`next(${Number(frameMs)}) ?? null`)) ?? undefined;
  }

  /** Where page time stands; undefined on a page with no clock. */
  async reading(): Promise<ClockReading | undefined> {
    return (await this.control('state() ?? null')) ?? undefined;
  }

  private async animationRate(playbackRate: number): Promise<void> {
    this.animationDomain ??= this.command('Animation.enable');
    await this.animationDomain;
    await this.command('Animation.setPlaybackRate', { playbackRate });
  }

  /** Call one of the page clock's controls; a page with no clock answers undefined. */
  private async control(call: string): Promise<any> {
    const answer = await this.command('Runtime.evaluate', {
      expression: ownScript('clock', `globalThis[Symbol.for('${CLOCK_KEY}')]?.${call}`), returnByValue: true,
    });
    return answer?.result?.value;
  }

  private command(method: string, params?: Record<string, unknown>): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.channel.send(method, params),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), COMMAND_MS); }),
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
  }
}

const pageTimes = new Map<string, PageTime>();

/** The page time of a connection, by its name. */
export function pageTimeOf(connection: string): PageTime | undefined {
  return pageTimes.get(connection);
}

/** Make the page time of a connection, driven through `channel`; returns its detach. */
export function attachPageTime(connection: string, channel: TimeChannel): () => void {
  const time = new PageTime(connection, channel);
  pageTimes.set(connection, time);
  return () => { if (pageTimes.get(connection) === time) pageTimes.delete(connection); };
}
