/**
 * A replayed payload against the fields marked on its kind: a field matched
 * by shape holds whatever it carries so long as it is there as the same type,
 * and a field matched by value holds only when it carries the same value.
 */
import { describe, it, expect } from 'vitest';
import { compareExpected, compareKinds, countKinds, frameMatch, sentDiffers, verdictOf } from './kinds.js';

const recorded = { n: 1, statuses: [200], body: '{"token":"s-old","ok":true}' };
const observed = { n: 1, statuses: [200] };

describe('fields matched by shape', () => {
  it('holds a token that is new on every run, when it is there as a string', () => {
    expect(compareExpected('', { shape: { token: 'string' } }, '{"token":"s-new"}')).toEqual([]);
    expect(verdictOf(recorded, observed, '{"token":"s-new","ok":true}', { shape: { token: 'string' } })?.verdict).toBe('match');
  });

  it('fails a field that is absent, or there as another type', () => {
    expect(compareExpected('', { shape: { token: 'string' } }, '{"ok":true}')).toEqual([' .token: absent, expected a string']);
    expect(compareExpected('', { shape: { token: 'string' } }, '{"token":42}')).toEqual([' .token: a number, expected a string']);
  });
});

describe('fields matched by value', () => {
  it('fails a field whose value changed, beside one matched by shape', () => {
    const mark = { shape: { token: 'string' }, fields: { ok: true } };
    expect(compareExpected('', mark, '{"token":"s-new","ok":true}')).toEqual([]);
    expect(compareExpected('', mark, '{"token":"s-new","ok":false}')).toEqual([' .ok: false, expected true']);
  });

  it('compares the whole payload when no field is marked, so a new token differs', () => {
    expect(verdictOf(recorded, observed, '{"token":"s-new","ok":true}')?.reasons).toEqual(['payload differs']);
  });
});

describe('a step flagged in the comparison', () => {
  it('matches a pushed kind whose count differs, since the server sets its pace', () => {
    expect(verdictOf({ n: 3, presence: true }, { n: 4 }, undefined)).toEqual({ verdict: 'match', reasons: [] });
  });

  it('names what differs whenever it reads a mismatch', () => {
    const counted = verdictOf({ n: 1, statuses: [200] }, { n: 2, statuses: [200, 200] }, undefined);
    expect(counted).toEqual({ verdict: 'mismatch', reasons: ['×2, recorded ×1', 'status 200/200, recorded 200'] });
    const payload = verdictOf({ n: 1, body: '{"dark":true}' }, { n: 1 }, '{"compact":true}');
    expect(payload).toEqual({ verdict: 'mismatch', reasons: ['payload differs'] });
  });
});

describe('what a request sent', () => {
  it('names each field that differs from the recording', () => {
    expect(sentDiffers('{"dark":true}', '{"compact":true}')).toEqual(['sent compact added', 'sent dark missing']);
    expect(sentDiffers('{"theme":"dark"}', '{"theme":"light"}')).toEqual(['sent theme "light", recorded "dark"']);
    expect(sentDiffers('{"a":1}', '{"a":1}')).toEqual([]);
  });

  it('reads a mismatch on the request whose fields changed', () => {
    const read = verdictOf({ n: 1, statuses: [200], sent: '{"dark":true}' }, { n: 1, statuses: [200] }, undefined, undefined, false, { sent: '{"compact":true}' });
    expect(read).toEqual({ verdict: 'mismatch', reasons: ['sent compact added', 'sent dark missing'] });
  });
});

describe('a document or binary body', () => {
  it('is compared on arriving, not on a body a recording kept', () => {
    expect(verdictOf({ n: 1, statuses: [200], body: '<html>v1' }, { n: 1, statuses: [200] }, '<html>v2', undefined, false, { payloadClass: 'document' }))
      .toEqual({ verdict: 'match', reasons: [] });
  });

  it('is compared on its size band where binary', () => {
    expect(verdictOf({ n: 1, statuses: [200], band: 's' }, { n: 1, statuses: [200] }, undefined, undefined, false, { payloadClass: 'binary', band: 'l' }))
      .toEqual({ verdict: 'mismatch', reasons: ['size l, recorded s'] });
  });
});

describe('a motion paced by a clock outside the step', () => {
  const motion = (url: string, trigger?: string) => ({ kind: 'write' as const, direction: 'in' as const, url, ...(trigger ? { trigger } : {}) });

  it('is counted by presence when a reply, push, timer or the browser drives it, and so is its stopped row', () => {
    const kinds = countKinds([
      motion('animation:transform #progress', 'reply GET /api/sync'),
      motion('animation:transform #progress', 'reply GET /api/sync'),
      motion('animation:transform #progress stopped'),
      motion('animation:transform #hero-bg', 'scroll · hover #card'),
      motion('animation:transform #hero-bg', 'scroll · browser'),
    ]);
    expect(kinds['animation transform #progress'].presence).toBe(true);
    expect(kinds['animation transform #progress stopped'].presence).toBe(true);
    expect(kinds['animation transform #hero-bg'].presence).toBe(true);
  });

  it('keeps its count when the step\'s input starts it directly', () => {
    const kinds = countKinds([motion('animation:scale .like', 'key l'), motion('animation:scale .like', 'key l')]);
    expect(kinds['animation scale .like'].presence).toBeUndefined();
    expect(compareKinds({ 'animation scale .like': { n: 1 } }, kinds)).toEqual(['animation scale .like ×2, recorded ×1']);
  });

  it('matches a recording counted by number once the replay finds its pace outside the step', () => {
    const replayed = countKinds([motion('animation:transform #hero-bg', 'scroll · wheel'), motion('animation:transform #hero-bg', 'scroll · browser')]);
    expect(compareKinds({ 'animation transform #hero-bg': { n: 1 } }, replayed)).toEqual([]);
    expect(verdictOf({ n: 1 }, replayed['animation transform #hero-bg'], undefined)?.verdict).toBe('match');
  });
});

/**
 * A frame carries no path, so a frame rule is keyed on what the payload said,
 * and a payload usually carries a value that moves between runs. Kept whole,
 * `{"tag":"ready","at":179014...}` matches the frame that produced it and no
 * later one, so the rule reads `never fired` on every run after the first.
 */
describe('the part of a frame payload that names it', () => {
  it('drops a clock that moves between runs', () => {
    const first = frameMatch('{"tag":"ready","at":1790148730882}');
    const later = '{"tag":"ready","at":1790148999111}';

    expect(first).toBe('"tag":"ready"');
    expect(later.includes(first)).toBe(true);
  });

  it('keeps the name and not the counter', () => {
    const match = frameMatch('{"tag":"push","i":3,"of":5}');
    expect(match).toBe('"tag":"push"');
    expect('{"tag":"push","i":5,"of":5}'.includes(match)).toBe(true);
  });

  it('takes the event name out of a Socket.IO style array', () => {
    expect(frameMatch('["order:saved",{"id":42}]')).toBe('"order:saved"');
  });

  it('returns the first key of an object holding no string value', () => {
    expect(frameMatch('{"i":1,"n":5}')).toBe('"i"');
  });

  it('returns the payload itself where it is not JSON', () => {
    expect(frameMatch('not json at all')).toBe('not json at all');
  });
});
