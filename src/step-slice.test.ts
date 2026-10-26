import { describe, it, expect, beforeEach } from 'vitest';
import { forgetObservations, observeEvent, observeWrite } from './observation-log.js';
import { crossingsIn, crossingsOf, kindsOf, sliceIn, sliceOf, writeCrossing } from './step-slice.js';
import { recordKinds } from './bench/step-compare.js';
import { markedNow } from './proxy/cause-timeline.js';
import type { ProxyEvent } from './proxy/intercept-proxy.js';
import type { PageWrite } from './write-watch.js';

const event = (fields: Partial<ProxyEvent>): ProxyEvent => ({ id: `ev-${Math.random()}`, at: 1000, kind: 'request', direction: 'out', url: 'http://localhost:7788/x', size: 0, ...fields } as ProxyEvent);
const write = (fields: Partial<PageWrite>): PageWrite => ({ id: `write-${Math.random()}`, at: 1000, store: 'localStorage', operation: 'set', ...fields } as PageWrite);

beforeEach(() => forgetObservations());

describe('a step read from the observation log', () => {
  it('counts the stamped request and write as recordKinds counts the same records', () => {
    const request = event({ method: 'POST', url: 'http://localhost:7788/draft', status: 200, commandIndex: 5, at: 1010 });
    const stored = write({ key: 'socket-app:draft', value: '{"body":"sent"}', cursor: { kind: 'command', index: 5 }, at: 1020 });
    observeEvent(request, 'socket-app-page');
    observeWrite(stored, 'socket-app-page');

    expect(kindsOf(5, 'socket-app-page', 1000)).toEqual(recordKinds([request, writeCrossing(stored)],
      crossing => (crossing.kind === 'write' ? stored.value : undefined), 1000));
    expect(Object.keys(kindsOf(5, 'socket-app-page', 1000))).toEqual(['POST /draft', 'localStorage socket-app:draft']);
  });

  it('leaves out what was placed under the step by time and what another browser made', () => {
    markedNow({ kind: 'command', index: 9 }, 2000);
    markedNow(undefined, 2010);
    observeEvent(event({ kind: 'frame', direction: 'in', url: 'ws://localhost:7788/small', size: 34, at: 2050 }), 'socket-app-page');
    observeEvent(event({ method: 'GET', url: 'http://localhost:7788/inbox', status: 200, commandIndex: 9 }), 'other-browser-page');

    expect(crossingsOf(9, 'socket-app-page').crossings).toEqual([]);
    expect(crossingsOf(9).crossings.map(crossing => crossing.url)).toEqual(['http://localhost:7788/inbox']);
  });

  it('keeps a motion\'s fields and the value written, timed from the step', () => {
    observeWrite(write({
      store: 'animation', operation: 'started', key: 'height #acc-body', value: 'js style → 58px over 300ms, 19 frames',
      motion: { type: 'StyleWrites', durationMs: 300, frames: 19, to: '58px', set: false },
      cursor: { kind: 'command', index: 12 }, at: 3040,
    }), 'motion-catalog-page');

    expect(sliceOf(12, 'motion-catalog-page', 3000, 1000)).toEqual([{
      kind: 'motion', text: 'height #acc-body  js style → 58px over 300ms, 19 frames', key: 'height #acc-body', atMs: 40,
      connection: 'motion-catalog-page',
      motion: { type: 'StyleWrites', durationMs: 300, frames: 19, to: '58px', set: false },
      body: 'js style → 58px over 300ms, 19 frames',
    }]);
  });

  it('reads a recording\'s window by arrival, stamped or not, on its own browser alone', () => {
    markedNow(undefined, 4000);
    observeEvent(event({ method: 'GET', url: 'http://localhost:7788/before', status: 200, at: 3990 }), 'socket-app-page');
    observeEvent(event({ method: 'POST', url: 'http://localhost:7788/draft', status: 200, at: 4010 }), 'socket-app-page');
    observeWrite(write({ key: 'socket-app:draft', value: 'sent', at: 4020 }), 'socket-app-page');
    observeEvent(event({ method: 'GET', url: 'http://localhost:7788/inbox', status: 200, at: 4030 }), 'other-browser-page');
    observeEvent(event({ method: 'GET', url: 'http://localhost:7788/after', status: 200, at: 4100 }), 'socket-app-page');

    expect(crossingsIn(4000, 4100, 'socket-app-page').crossings.map(crossing => crossing.url)).toEqual(['http://localhost:7788/draft', 'localStorage:socket-app:draft']);
    expect(sliceIn(4000, 4100, 'socket-app-page', 1000).map(one => [one.text, one.atMs])).toEqual([['POST /draft 200', 10], ['localStorage socket-app:draft set', 20]]);
  });
});
