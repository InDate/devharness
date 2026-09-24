/**
 * What a frame rule matches on.
 *
 * A frame carries no path, so a rule is keyed on what it said - and what it
 * said usually carries something that moves. `{"tag":"ready","at":179014...}`
 * kept whole matches the frame that produced it and never another, so the rule
 * reads `never fired` on every run after the one that made it.
 */
import { describe, it, expect } from 'vitest';
import { frameMatch } from './crossing.js';

describe('the part of a payload that names it', () => {
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

  it('falls back to the payload where there is nothing to name it by', () => {
    // A number-only object names nothing, so the whole head is all there is.
    expect(frameMatch('{"i":1,"n":5}')).toBe('"i"');
    expect(frameMatch('not json at all')).toBe('not json at all');
  });
});
