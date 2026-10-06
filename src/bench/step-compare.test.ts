/**
 * Where a pass's crossings are listed: a step's own window, a pause between
 * steps, or nowhere once the pass has crossed its finish line.
 */
import { describe, it, expect } from 'vitest';
import { passOf, pausesOf, placementOf, type Crossing } from './step-compare.js';
import { kindOf } from './kinds.js';

let seq = 0;
function crossing(fields: Partial<Crossing>): Crossing {
  seq += 1;
  return { id: `ev-${seq}`, at: seq, kind: 'frame', url: 'http://app.test/sse', direction: 'in', ...fields };
}

describe('placing a crossing of the newest pass', () => {
  it('lists a stamped crossing under the step it crossed in', () => {
    const events = [crossing({ runId: 'run-a', step: 1 })];
    expect(placementOf(events[0], passOf(events), undefined, 4)).toEqual({ origin: '1', step: 1 });
  });

  it('lists an unstamped crossing after the last step under no step', () => {
    const events = [crossing({ runId: 'run-a', step: 3 }), crossing({})];
    expect(placementOf(events[1], passOf(events), undefined, 4)).toBeUndefined();
  });

  it('lists a crossing stamped in a pause under no step', () => {
    const events = [crossing({ runId: 'run-a', step: 2, paused: true })];
    expect(placementOf(events[0], passOf(events), undefined, 4)).toBeUndefined();
  });

  it('lists an older pass under no step', () => {
    const events = [crossing({ runId: 'run-a', step: 0 }), crossing({ runId: 'run-b', step: 0 })];
    expect(placementOf(events[0], passOf(events), undefined, 4)).toBeUndefined();
  });

  it('moves a kind to where the sequence lists it', () => {
    const events = [crossing({ runId: 'run-a', step: 1 })];
    const placed = placementOf(events[0], passOf(events), { [`1|${kindOf(events[0])}`]: 2 }, 4);
    expect(placed).toEqual({ origin: '1', step: 2 });
  });
});

describe('the pauses of the newest pass', () => {
  it('groups what crossed in each pause by the step it stood before', () => {
    const events = [
      crossing({ runId: 'run-a', step: 1 }),
      crossing({ runId: 'run-a', step: 2, paused: true }),
      crossing({ runId: 'run-a', step: 2, paused: true }),
      crossing({ runId: 'run-a', step: 3, paused: true }),
    ];
    const pauses = pausesOf(events);
    expect([...pauses.keys()]).toEqual([2, 3]);
    expect(pauses.get(2)).toHaveLength(2);
  });

  it('leaves out an older pass and a pause inside a nested sequence', () => {
    const events = [
      crossing({ runId: 'run-a', step: 2, paused: true }),
      crossing({ runId: 'run-b', step: 1, paused: true, within: [0] }),
      crossing({ runId: 'run-b', step: 1 }),
    ];
    expect(pausesOf(events).size).toBe(0);
  });
});
