/**
 * Ends a blocking call before its caller's prompt cache runs out.
 *
 * `wait`, `check` and `modal wait` block for up to 5 or 10 minutes, and a
 * subagent's cache lasts 5. The call is aborted MARGIN_MS before the caller's
 * cache expires, as `prompt-cache.ts` reads it when the call arrives, and
 * returns a reply in place of the abort: the request that reply produces reads
 * the cache back to its full lifetime, and a repeat of the call waits on from
 * there. Where requests overlap and the caller is still one of several parts,
 * the earliest of their expiries holds until the claim narrows.
 */

import { AbortError, linkSignals } from './utils/abort.js';
import type { CallerClaim, SessionPart } from './prompt-cache.js';

const MARGIN_MS = 30_000;

/** Tools whose calls can block past a 5-minute cache. */
const BLOCKING_TOOLS = new Set(['wait', 'check', 'modal']);

export class CacheDeadlineStop extends AbortError {
  constructor(readonly party: SessionPart, readonly startedAt: number) {
    super(`Stopped before the prompt cache of ${party.label} runs out`);
  }
}

export interface CacheDeadline {
  signal: AbortSignal | undefined;
  dispose(): void;
}

/**
 * A signal that aborts MARGIN_MS before the earliest cache among the claim's
 * callers runs out, moved later each time the claim narrows.
 */
export function cacheDeadlineFor(toolName: string, signal: AbortSignal | undefined, claim: CallerClaim, startedAt: number = Date.now()): CacheDeadline {
  if (!BLOCKING_TOOLS.has(toolName) || claim.callers.length === 0) return { signal, dispose: () => {} };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    const party = [...claim.callers].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    timer = setTimeout(() => controller.abort(new CacheDeadlineStop(party, startedAt)), Math.max(0, party.expiresAt - MARGIN_MS - Date.now()));
  };
  schedule();
  const stopListening = claim.onChange(schedule);
  const linked = linkSignals(signal, controller.signal);
  return {
    signal: linked.signal,
    dispose: () => { if (timer) clearTimeout(timer); stopListening(); linked.dispose(); },
  };
}

/** The CacheDeadlineStop an abort carries, where the deadline is what ended the call. */
export function cacheDeadlineStopOf(error: unknown): CacheDeadlineStop | undefined {
  if (error instanceof CacheDeadlineStop) return error;
  const reason = (error as { reason?: unknown } | undefined)?.reason;
  return reason instanceof CacheDeadlineStop ? reason : undefined;
}
