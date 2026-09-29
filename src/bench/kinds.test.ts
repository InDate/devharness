/**
 * A replayed payload against the fields marked on its kind: a field matched
 * by shape holds whatever it carries so long as it is there as the same type,
 * and a field matched by value holds only when it carries the same value.
 */
import { describe, it, expect } from 'vitest';
import { compareExpected, verdictOf } from './kinds.js';

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
