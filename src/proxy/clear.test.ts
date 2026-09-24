/**
 * Clearing the boundary.
 *
 * The events are a reading of what has happened; the pins and the allow list
 * are decisions about what happens next. Clearing the reading must not disarm
 * the decisions, or a run started after a clear reaches hosts it was scoped
 * away from and gets answers the sequence was told to replace.
 */
import { describe, it, expect } from 'vitest';
import { InterceptProxy } from './intercept-proxy.js';

describe('clearing what the boundary holds', () => {
  it('drops the events and keeps every decision', () => {
    const proxy = new InterceptProxy();
    proxy.allowOnly(['localhost:3102']);
    const pin = proxy.pin({ urlIncludes: '/orders', body: '{"ok":true}' });
    const framePin = proxy.pinFrame({ textIncludes: 'saved', replaceWith: 'x' });

    proxy.clear();

    expect(proxy.eventsIn()).toEqual([]);
    expect(proxy.listAllowedHosts()).toEqual(['localhost:3102']);
    expect(proxy.listPins().map(p => p.id)).toContain(pin.id);
    expect(proxy.listFramePins().map(p => p.id)).toContain(framePin.id);
  });

  it('reports nothing held as measurable once it is cleared', () => {
    // A step whose events were dropped is left out of a comparison rather than
    // compared against nothing, so the clear has to mark the eviction.
    const proxy = new InterceptProxy();
    expect(proxy.eventsIn()).toEqual([]);
    proxy.clear();
    expect(proxy.measurable(0)).toBe(true);
  });

  it('forgets the refusals with the events that prompted them', () => {
    // The count and the per-host list are one reading in two shapes. Clearing
    // one and not the other leaves a refusal total with nothing behind it,
    // which reads as a black hole the list cannot name.
    const proxy = new InterceptProxy();
    (proxy as unknown as { refusedHosts: Map<string, number> })
      .refusedHosts.set('www.google.com', 11);
    (proxy as unknown as { blockedCount: number }).blockedCount = 11;

    proxy.clear();

    expect(proxy.refusals()).toEqual([]);
    expect(proxy.blocked).toBe(0);
  });
});
