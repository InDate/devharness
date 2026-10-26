import { describe, it, expect, beforeEach } from 'vitest';
import { forgetObservations, fromEvent, fromWrite, linesOf, observation, observationsOf, observeEvent, observeWrite, record, stampedOf, summaryOf } from './observation-log.js';
import { activityOf, activitySummary, openerEntryOf } from './activity-index.js';
import { countsLine, formatEntries as formatHistoryEntries } from './tools/history-activity.js';
import { formatEntries } from './tools/history-activity.js';
import type { ProxyEvent } from './proxy/intercept-proxy.js';
import type { PageWrite } from './write-watch.js';
import { markedNow } from './proxy/cause-timeline.js';

const event = (fields: Partial<ProxyEvent>): ProxyEvent => ({ id: `ev-${Math.random()}`, at: 1000, kind: 'request', direction: 'out', url: 'http://localhost:7788/x', size: 0, ...fields } as ProxyEvent);
const write = (fields: Partial<PageWrite>): PageWrite => ({ id: `write-${Math.random()}`, at: 1000, store: 'localStorage', operation: 'set', ...fields } as PageWrite);

beforeEach(() => forgetObservations());

describe('the observation log - what an entry owns', () => {
  it('owns what an action initiates, with the page\'s cause where it reported one', () => {
    expect(fromEvent(event({ method: 'POST', url: 'http://h/session', status: 200, evidence: { initiator: 'input' } as any }), 8)).toMatchObject({ kind: 'request', text: 'POST /session 200', owned: 'input' });
    expect(fromEvent(event({ method: 'GET', url: 'http://h/', status: 200 }), 1)).toMatchObject({ owned: 'window' });
    expect(fromEvent(event({ kind: 'frame', direction: 'out', url: 'ws://h/live', size: 20 }), 3)).toMatchObject({ text: '→ /live 20b', owned: 'window' });
    expect(fromWrite(write({ key: 'draft' }), 4)).toMatchObject({ kind: 'storage', owned: 'window' });
  });

  it('reads a motion\'s end as its own line, owned by nothing', () => {
    const ended = fromWrite(write({ store: 'animation', operation: 'stopped', key: 'currentTime #promo', value: 'paused at 0.900', cursor: { kind: 'command', index: 11 } }), 11);
    expect(ended).toMatchObject({ kind: 'motion', key: 'currentTime #promo ended', text: 'currentTime #promo  paused at 0.900' });
    expect(ended.owned).toBeUndefined();
  });

  it('owns nothing a timer asked for, a push nobody paired, or a motion', () => {
    expect(fromEvent(event({ method: 'GET', url: 'http://h/poll', status: 200, evidence: { initiator: 'timer' } as any }), 2).owned).toBeUndefined();
    expect(fromEvent(event({ kind: 'frame', direction: 'in', url: 'ws://h/live', size: 34 }), 2).owned).toBeUndefined();
    expect(fromWrite(write({ store: 'animation', key: 'height #acc-body', value: 'js style → 58px over 300ms' }), 2)).toMatchObject({ kind: 'motion', text: 'height #acc-body  js style → 58px over 300ms' });
    expect(fromWrite(write({ store: 'animation', key: 'height #acc-body' }), 2).owned).toBeUndefined();
  });
});

describe('the observation log - ids, folding and kinds kept apart', () => {
  it('gives each kind its letter and finds an observation by its id or the record behind it', () => {
    const r = record(fromEvent(event({ id: 'ev-9', method: 'GET', url: 'http://h/', status: 200 }), 1));
    const m = record(fromWrite(write({ id: 'write-4', store: 'animation', key: 'opacity #toast' }), 1));
    expect([r.id, m.id]).toEqual(['r1', 'm1']);
    expect(observation('r1')).toBe(r);
    expect(observation('ev-9')).toBe(r);
    expect(observation('write-4')).toBe(m);
  });

  it('folds five alike in a row, and lists four one by one', () => {
    for (let i = 0; i < 5; i++) record(fromEvent(event({ kind: 'frame', direction: 'out', url: 'ws://h/live', size: 20 }), 3));
    for (let i = 0; i < 4; i++) record(fromEvent(event({ kind: 'frame', direction: 'in', url: 'ws://h/live', size: 27 }), 3));
    const lines = linesOf(observationsOf(3));
    expect(lines.map(line => line.count)).toEqual([5, 1, 1, 1, 1]);
    expect(summaryOf(observationsOf(3), 2)).toBe('→ /live 20b ×5; ← /live 27b; +3 more');
  });

  it('keeps each kind in its own bound, so motion cannot push requests out', () => {
    record(fromEvent(event({ method: 'GET', url: 'http://h/', status: 200 }), 1));
    for (let i = 0; i < 2001; i++) record(fromWrite(write({ store: 'animation', key: `k${i}` }), 2));
    expect(observation('r1')).toBeDefined();
    expect(observation('m1')).toBeUndefined();
  });
});

describe('a history entry as the log reads it', () => {
  it('prints the letters once, the call, what it owns indented with the evidence, and what followed', () => {
    record(fromEvent(event({ method: 'POST', url: 'http://h/session', status: 200, evidence: { initiator: 'input' } as any }), 99));
    record(fromWrite(write({ store: 'animation', key: 'opacity #toast', value: 'transition 300ms' }), 99));
    const text = formatEntries([{ index: 99, timestamp: 0, tool: 'input', params: { action: 'click', selector: 'button:text("POST /session")' }, from: 'mcp', run: 'socket-live-lifecycle', runStep: 7 } as any]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('r request · m motion');
    expect(lines[1]).toMatch(/^#99 {2}click button:text\("POST \/session"\).*socket-live-lifecycle step 8 · 1 owned, 1 after$/);
    expect(lines[2]).toMatch(/^ {7}POST \/session 200 +r1 +<input>$/);
    expect(lines[3]).toMatch(/^ {5}opacity #toast {2}transition 300ms +m1$/);
    expect(lines[2].indexOf('r1')).toBe(lines[3].indexOf('m1'));
  });
});

describe('an observation stamped under no call', () => {
  it('stands after the action it followed in time, owned by nothing', () => {
    markedNow({ kind: 'command', index: 41 }, 10_000);
    markedNow(undefined, 10_050);
    observeWrite(write({ store: 'animation', key: 'height #acc-body', at: 10_400 }));

    expect(observationsOf(41)).toEqual([expect.objectContaining({ kind: 'motion', key: 'height #acc-body' })]);
    expect(observationsOf(41)[0].owned).toBeUndefined();
  });
});

describe('the stores writing into the log', () => {
  it('moves an observation a late cause restamps, so one record reads as one line', () => {
    markedNow({ kind: 'command', index: 50 }, 20_000);
    markedNow(undefined, 20_010);
    const pushed = write({ id: 'write-late', at: 20_100 });
    const first = observeWrite(pushed);
    expect(first.entry).toBe(50);
    expect(first.stamped).toBeUndefined();

    pushed.cursor = { kind: 'command', index: 51 };
    const moved = observeWrite(pushed);
    expect(moved).toBe(first);
    expect(observationsOf(50)).toEqual([]);
    expect(observationsOf(51)).toEqual([expect.objectContaining({ id: first.id, stamped: true, owned: 'window' })]);
  });

  it('counts a pushed frame on the call that opened its socket, and leaves time placements out of a step\'s traffic', () => {
    const socket = event({ id: 'ev-open', url: 'ws://h/live', status: 101, commandIndex: 60 });
    observeEvent(socket);
    markedNow({ kind: 'command', index: 61 }, 30_000);
    markedNow(undefined, 30_010);
    observeEvent(event({ id: 'ev-push', kind: 'frame', direction: 'in', url: 'ws://h/live', size: 9, at: 30_200 }));

    expect(openerEntryOf('ev-push')).toBe(60);
    expect(stampedOf(60).map(one => one.ref.id)).toEqual(['ev-open', 'ev-push']);
    expect(observationsOf(61).map(one => one.ref.id)).toEqual(['ev-push']);
    expect(activityOf(61)).toEqual([]);
    expect(activityOf(60).map(line => line.line)).toEqual(['GET /live 101', '← frame /live']);
  });

  it('carries a motion\'s reading in fields', () => {
    const motion = { type: 'StyleWrites' as const, durationMs: 299, frames: 19, to: '58px', set: false };
    expect(fromWrite(write({ store: 'animation', operation: 'started', key: 'height #acc-body', motion }), 2).motion).toEqual(motion);
  });
});

describe('two browsers in one log', () => {
  it('keeps two proxies\' events of the same id apart, each under its own entry and connection', () => {
    const catalog = event({ id: 'ev-22', method: 'GET', url: 'http://127.0.0.1:4721/catalog.html', status: 200, commandIndex: 40 });
    const socket = event({ id: 'ev-22', method: 'GET', url: 'http://localhost:7788/', status: 200, commandIndex: 70 });
    observeEvent(catalog, 'motion-catalog-page');
    observeEvent(socket, 'socket-live-lifecycle');

    expect(observationsOf(40)).toEqual([expect.objectContaining({ text: 'GET /catalog.html 200', connection: 'motion-catalog-page' })]);
    expect(observationsOf(70)).toEqual([expect.objectContaining({ text: 'GET / 200', connection: 'socket-live-lifecycle' })]);
    expect(activitySummary(70, 'socket-live-lifecycle')).toBe('1 request (GET / 200)');
  });

  it('keeps a line another browser made, labelled with its connection', () => {
    observeEvent(event({ id: 'ev-1', method: 'POST', url: 'http://h/send', status: 200, commandIndex: 80 }), 'duo-member-one');
    observeEvent(event({ id: 'ev-1', method: 'GET', url: 'http://h/inbox', status: 200, commandIndex: 80 }), 'duo-member-two');

    expect(activityOf(80, 'duo-member-one').map(line => line.on)).toEqual([undefined, 'duo-member-two']);
    expect(activitySummary(80, 'duo-member-one')).toBe('1 request (POST /send 200), 1 request on duo-member-two (GET /inbox 200)');
    expect(countsLine(observationsOf(80), 'duo-member-one')).toBe('1 request, 1 request on duo-member-two');
    expect(activitySummary(80)).toBe('2 requests');

    const text = formatHistoryEntries([{ index: 80, timestamp: 0, tool: 'input', params: { action: 'click', selector: '#send', connection: 'duo-member-one' }, from: 'mcp' } as any]);
    expect(text).toMatch(/GET \/inbox 200 .* on duo-member-two$/m);
    expect(text).not.toMatch(/POST \/send 200 .*on /);
  });

  it('records the connection of a page write', () => {
    expect(observeWrite(write({ key: 'draft', cursor: { kind: 'command', index: 81 } }), 'socket-live-lifecycle').connection).toBe('socket-live-lifecycle');
  });
});
