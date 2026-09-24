/**
 * How much of an event a step owns, and what a step's traffic looks like as
 * weighted shapes rather than as a count.
 */
import { describe, it, expect } from 'vitest';
import { ownershipWeight, weighShapes, tallyShapes, payloadShape, type ProxyEvent, type ShapeRules } from './intercept-proxy.js';

function frame(evidence: ProxyEvent['evidence']): ProxyEvent {
  return {
    id: 'ev', at: 0, kind: 'frame', direction: 'in',
    url: 'ws://app.test/live', size: 10, evidence,
  };
}

describe('how much of an event a step owns', () => {
  it('grades ownership by what backs the level', () => {
    const byId = frame({ shape: 'json:id,result', pairing: { how: 'id', afterMs: 5 } });
    const byAllowance = frame({ shape: 'json:id,result', pairing: { how: 'allowance', afterMs: 5 } });
    const late = frame({ shape: 'json:id,result', agedOut: 1 });
    const unaccounted = frame({ shape: 'json:tick' });

    expect(ownershipWeight(byId)).toBe(1);
    expect(ownershipWeight(byAllowance)).toBe(0.7);
    expect(ownershipWeight(late)).toBe(0.3);
    expect(ownershipWeight(unaccounted)).toBe(0);
  });

  it('contributes nothing for an arrival nothing accounts for', () => {
    // A heartbeat is not assigned to a step for tidiness. It weighs nothing,
    // so a step running longer than its recording does not read as drift.
    expect(weighShapes([frame({ shape: 'json:tick' }), frame({ shape: 'json:tick' })])).toEqual({});
  });
});

describe('a verdict a person assigned', () => {
  const tick = frame({ shape: 'json:tick' });
  const answer = frame({ shape: 'json:id,result', pairing: { how: 'allowance', afterMs: 5 } });

  it('outranks what the wire says, in both directions', () => {
    // The wire calls a heartbeat unaccounted-for and weighs it nothing. A
    // person who watched it says the step caused it, and that stands.
    expect(ownershipWeight(tick, { 'json:tick': 'step' })).toBe(1);
    // The wire settles this against a send at 0.7. A person says the app
    // produces it on its own, and it drops out of the step entirely.
    expect(ownershipWeight(answer, { 'json:id,result': 'background' })).toBe(0);
  });

  it('keeps unknown as an answer rather than a gap', () => {
    // Recorded as ruled-on and weighing nothing, which is different from a
    // shape nobody has looked at yet - that one still reads off the wire.
    const rules: ShapeRules = { 'json:tick': 'unknown' };
    expect(ownershipWeight(tick, rules)).toBe(0);
    expect(weighShapes([answer], rules)['json:id,result']).toBe(0.7);
  });

  it('settles every frame of that shape, not the one that was looked at', () => {
    const rules: ShapeRules = { 'json:tick': 'background' };
    const ticks = [frame({ shape: 'json:tick' }), frame({ shape: 'json:tick' }), tick];
    expect(weighShapes(ticks, rules)).toEqual({});
  });
});

describe('a step as weighted shapes', () => {
  it('separates traffic that changed entirely under an unchanged count', () => {
    const before = weighShapes([
      frame({ shape: 'json:id,result', pairing: { how: 'id', afterMs: 1 } }),
      frame({ shape: 'json:id,result', pairing: { how: 'id', afterMs: 1 } }),
    ]);
    const after = weighShapes([
      frame({ shape: 'json:id,error', pairing: { how: 'id', afterMs: 1 } }),
      frame({ shape: 'json:id,error', pairing: { how: 'id', afterMs: 1 } }),
    ]);

    // Two events either side. A count of four fields reads no drift here.
    expect(before).toEqual({ 'json:id,result': 2 });
    expect(after).toEqual({ 'json:id,error': 2 });
    expect(before).not.toEqual(after);
  });

  it('costs a false pairing a fraction rather than a whole event', () => {
    const paired = weighShapes([frame({ shape: 'json:tick', pairing: { how: 'allowance', afterMs: 9 } })]);
    const notPaired = weighShapes([frame({ shape: 'json:tick' })]);
    expect(paired['json:tick']).toBe(0.7);
    expect(notPaired['json:tick']).toBeUndefined();
  });

  it('names a request by its method and path, so two endpoints are two shapes', () => {
    const save: ProxyEvent = {
      id: 'ev-1', at: 0, kind: 'request', direction: 'out',
      url: 'http://app.test/draft?v=2', method: 'POST', size: 22,
      evidence: { protocolPaired: true },
    };
    const load: ProxyEvent = { ...save, id: 'ev-2', url: 'http://app.test/list', method: 'GET' };
    // Keyed by method alone, a step hitting an entirely different set of URLs
    // at the same count reads identical. The query string is left off so a
    // cache-buster does not make every request its own shape.
    expect(weighShapes([save, load])).toEqual({
      'http:POST /draft': 0.3,
      'http:GET /list': 0.3,
    });
  });

  it('leaves a Socket.IO event one shape whatever it carries', () => {
    // [event, ...args]. Joining the args gave every message its own shape, so
    // a rule assigned to one never applied to the next.
    const hi = payloadShape('42["chat message","hi"]', false, 23);
    const bye = payloadShape('42["chat message","bye"]', false, 24);
    expect(hi).toBe(bye);
    expect(hi).toBe('eio42:arr:chat message');
  });

  it('keeps a shape that crossed but was owned by nobody', () => {
    const push = frame({ shape: 'json:event,payload' });
    const { weight, seen } = tallyShapes([push, push]);
    // Owned by no step, so it weighs nothing - and it still crossed, which is
    // what makes a server that stops pushing visible on replay.
    expect(weight).toEqual({});
    expect(seen).toEqual({ 'json:event,payload': 2 });
  });

  it('leaves a ruled-background shape out of the count as well as the weight', () => {
    const beat = frame({ shape: 'json:type' });
    const ruled: ShapeRules = { 'json:type': 'background' };
    // Counted, a heartbeat's number moves with how long a step happened to
    // take, so a step that ran longer on replay would read as drift.
    expect(tallyShapes([beat, beat, beat], ruled)).toEqual({ weight: {}, seen: {} });
    // Unruled, it still counts - nothing has said it is the app's own chatter.
    expect(tallyShapes([beat, beat]).seen).toEqual({ 'json:type': 2 });
  });

  it('separates a Phoenix heartbeat from a Phoenix message', () => {
    // Both are arrays, so a size band would put them in one bucket and one
    // rule would zero the socket.
    const beat = payloadShape('[null,"1","phoenix","heartbeat",{}]', false, 34);
    const message = payloadShape('[null,"2","room:1","new_msg",{"body":"hi"}]', false, 43);
    expect(beat).toBe('arr:phoenix,heartbeat');
    // The topic's entity id is stripped, so a rule assigned in one room
    // applies in the next rather than every room being its own shape.
    expect(message).toBe('arr:room,new_msg');
    expect(payloadShape('[null,"9","room:88","new_msg",{"body":"yo"}]', false, 43)).toBe(message);
    // And two heartbeats share a shape despite carrying different refs.
    expect(payloadShape('[null,"7","phoenix","heartbeat",{}]', false, 34)).toBe(beat);
  });
});
