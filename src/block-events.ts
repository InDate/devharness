/**
 * Block events - one line per new guard block on the session's event stream.
 *
 * Guards only surface on the *next* tool call, so a session doing unrelated
 * work never learns its dev server died until it happens to call a devharness
 * tool again. This is the push side of that: a watch reading the stream is
 * notified the moment a block appears.
 *
 * Deduplicated by key - a block that keeps firing on every subsequent tool call
 * writes one line, not one per call. The active set clears once a call gets
 * through all guards.
 */

import { appendEvent } from './session-events.js';
import { resolveSessionName } from './session-identity.js';

export type BlockGuard =
  | 'port'
  | 'breakpoint'
  | 'pendingStartup'
  | 'bug'
  | 'duplicateSession';

/**
 * Identity and summary of a block, attached to the BlockingResponse that
 * carries it so index.ts can log it without re-deriving the reason.
 */
export interface BlockEventInfo {
  guard: BlockGuard;
  /** Dedupe identity - same key while the same block persists. */
  key: string;
  /** One-line summary of what is blocked. */
  detail: string;
  /** The call that clears it. */
  resolve: string;
}

// Keys currently blocking. Written once per key, cleared when a tool call
// passes every guard.
const activeKeys = new Set<string>();

/**
 * Append a block event if this block is new. No-op for a block already logged.
 */
export async function recordBlockEvent(
  info: BlockEventInfo | undefined,
  tool: string
): Promise<void> {
  if (!info) return;

  const dedupeKey = `${info.guard}:${info.key}`;
  if (activeKeys.has(dedupeKey)) {
    return;
  }
  activeKeys.add(dedupeKey);

  await appendEvent(resolveSessionName(), 'block', {
    guard: info.guard,
    tool,
    detail: info.detail,
    resolve: info.resolve,
  });
}

/**
 * Forget every active block. Called when a tool call clears all guards, so a
 * block that recurs later gets logged again.
 */
export function clearBlockEvents(): void {
  activeKeys.clear();
}

/**
 * Test/debug helper - which blocks are currently deduped out.
 */
export function getActiveBlockKeys(): string[] {
  return [...activeKeys];
}
