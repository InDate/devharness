import { describe, it, expect } from 'vitest';
import { logpointLine, WriteWatch } from './write-watch.js';
import { animationRecordOf } from './animation-record.js';
import type { PageAnimation } from './page-animations.js';

describe('a console call read as a logpoint row', () => {
  it('drops the query a dev server adds on rebuild from the key', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:5173/src/NoteText.tsx?t=1791166684888:89:auto:' }, { value: 'press' }, { value: '{"path":null}' }]))
      .toEqual({ key: '/src/NoteText.tsx:89', value: '{"path":null}' });
  });

  it('takes the message as the value where the line carries no values', () => {
    expect(logpointLine([{ value: '[Logpoint] http://localhost:3101/client.js:180:auto:' }, { value: 'calc pressed' }]))
      .toEqual({ key: '/client.js:180', value: 'calc pressed' });
  });

  it('reads any other console call as no row', () => {
    expect(logpointLine([{ value: 'Fetching pricing configuration from server...' }])).toBeUndefined();
    expect(logpointLine([{ value: { type: 'object' } }])).toBeUndefined();
  });
});

describe('a motion row once its property comes to rest', () => {
  it('takes the value the settle read, on the row its start wrote', async () => {
    const client: any = { on: () => undefined, send: async () => ({}) };
    const page: any = { on: () => undefined, off: () => undefined, url: () => 'about:blank', browser: () => ({ on: () => undefined, off: () => undefined }) };
    const watch = new WriteWatch(client, page, 'settled-row-browser');
    await watch.start();
    watch.setAnimations(true);
    const record = animationRecordOf('settled-row-browser');
    const dim: PageAnimation = {
      id: 7, doc: 'd1', name: 'opacity', type: 'CSSTransition', element: '#refreshed', from: '1', to: '0.5',
      duration: 200, delay: 0, easing: 'ease', looping: false, playState: 'running', currentTime: 0,
    };

    record.takeSweep({ doc: 'd1', created: [dim], gone: [], settled: [] }, { kind: 'command', index: 3 });
    record.takeSweep({ doc: 'd1', created: [], gone: [{ id: 7, how: 'finished' }], settled: [{ id: 7, value: '0.5' }] }, { kind: 'command', index: 3 });
    watch.stop();

    const rows = watch.between(0, Number.MAX_SAFE_INTEGER).filter(write => write.store === 'animation');
    expect(rows).toHaveLength(1);
    expect(rows[0].motion).toMatchObject({ to: '0.5', settled: '0.5' });
  });
});
