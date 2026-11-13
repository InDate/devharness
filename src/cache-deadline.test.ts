import { describe, it, expect, vi, afterEach } from 'vitest';
import { cacheDeadlineFor, cacheDeadlineStopOf } from './cache-deadline.js';
import { CallerClaim, type SessionPart } from './prompt-cache.js';
import { createSuccessResponse } from './messages.js';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

function part(id: string, expiresInMs: number, lifetimeMs = 300_000): SessionPart {
  return { kind: 'agent', id, label: `agent ${id}`, pendingSince: NOW, expiresAt: NOW + expiresInMs, lifetimeMs };
}

afterEach(() => { vi.useRealTimers(); });

describe('a blocking call under a prompt cache', () => {
  it('stops 30s before the earliest cache among its callers runs out', () => {
    vi.useFakeTimers({ now: NOW });
    const claim = new CallerClaim([part('late', 280_000), part('soon', 200_000)]);
    const deadline = cacheDeadlineFor('wait', undefined, claim, NOW);

    vi.advanceTimersByTime(169_999);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    expect(cacheDeadlineStopOf(deadline.signal!.reason)?.party.id).toBe('soon');
    deadline.dispose();
  });

  it('moves the stop to the caller once the claim narrows to it', () => {
    vi.useFakeTimers({ now: NOW });
    const late = part('late', 280_000);
    const claim = new CallerClaim([late, part('soon', 200_000)]);
    const deadline = cacheDeadlineFor('check', undefined, claim, NOW);

    claim.narrow([late], new Set());
    vi.advanceTimersByTime(170_000);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(80_000);
    expect(cacheDeadlineStopOf(deadline.signal!.reason)?.party.id).toBe('late');
    deadline.dispose();
  });

  it('leaves a call that returns quickly, and a call with no caller, on its own signal', () => {
    const outer = new AbortController().signal;
    expect(cacheDeadlineFor('navigate', outer, new CallerClaim([part('a', 100_000)])).signal).toBe(outer);
    expect(cacheDeadlineFor('wait', outer, new CallerClaim([])).signal).toBe(outer);
  });

  it('replies that the cache was kept and the call can be made again', () => {
    const text = (createSuccessResponse('CACHE_DEADLINE_STOP', { party: 'agent soon', waitedS: 170, lifetimeMin: 5 }) as any).content[0].text;
    expect(text).toContain('agent soon');
    expect(text).toContain('call again');
  });
});
