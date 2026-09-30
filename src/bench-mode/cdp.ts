import type { CDPSession } from 'puppeteer-core';
import { debugLog } from '../debug-logger.js';
import { type BenchSession } from './session.js';

export const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.5 },
};

/**
 * Arm or disarm Chrome's picker. Disarming matters: while it is armed every
 * click is a pick, so the app cannot be driven at all.
 */
export async function setInspectMode(session: BenchSession, armed: boolean): Promise<void> {
  await send(session.client, 'Overlay.setInspectMode', {
    mode: armed ? 'searchForNode' : 'none',
    highlightConfig: HIGHLIGHT_CONFIG,
  });
  session.pickerArmed = armed;
}

/**
 * Does the page execute? A held page still answers anything synchronous, so
 * the only honest test is whether scheduled work runs.
 */
export async function isRunning(client: CDPSession, timeoutMs = 600): Promise<boolean> {
  const ran = client
    .send('Runtime.evaluate', {
      expression: 'new Promise(resolve => setTimeout(() => resolve(true), 20))',
      awaitPromise: true,
      returnByValue: true,
    } as any)
    .then(() => true)
    .catch(() => false);
  return Promise.race([ran, new Promise<boolean>(r => setTimeout(() => r(false), timeoutMs))]);
}

/**
 * Every CDP call in the hold path is bounded.
 *
 * A call that rejects is survivable; one that never returns is not - it leaves
 * the drive suspended before its `finally`, so `sequenceBusy` stays latched and
 * every later press in the bench silently does nothing. A paused or
 * mid-navigation target can leave a send unanswered, so none of them are
 * awaited without a limit.
 */
export async function send(client: CDPSession, method: string, params?: any, timeoutMs = 3000): Promise<void> {
  try {
    await Promise.race([
      client.send(method as any, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
    ]);
  } catch (error) {
    debugLog('bench', `${method}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Like `send`, for the calls whose answer is the point.
 *
 * `send` discards the result and swallows the error, which is right for the
 * commands that only need to have been issued. A lookup needs both back: the
 * caller decides what a missing node or a refused selector means.
 */
export async function request(client: CDPSession, method: string, params?: any, timeoutMs = 3000): Promise<any> {
  return Promise.race([
    client.send(method as any, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}

/** Resolve on the next Debugger.paused, or on timeout. */
export function nextPause(client: CDPSession, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    const done = (event: any | null) => {
      clearTimeout(timer);
      client.off('Debugger.paused', handler);
      resolve(event);
    };
    const handler = (event: any) => done(event);
    const timer = setTimeout(() => done(null), timeoutMs);
    client.on('Debugger.paused', handler);
  });
}

/** The page's own clock. Readable while paused: V8 evaluates on the paused isolate. */
export async function pageTime(client: CDPSession): Promise<number> {
  try {
    const result = (await client.send('Runtime.evaluate', {
      expression: 'performance.now()',
      returnByValue: true,
    } as any)) as any;
    return typeof result.result?.value === 'number' ? result.result.value : 0;
  } catch {
    return 0;
  }
}

/**
 * Evaluate in the page over CDP rather than through Puppeteer.
 *
 * page.evaluate never returns while the isolate is paused, and every call
 * after it queues behind that one - which takes the bench's own polling
 * down with it. These run on the bench's own client, which answers while held.
 */
export async function evaluateInPage(session: BenchSession, expression: string): Promise<any> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result?.value;
}
