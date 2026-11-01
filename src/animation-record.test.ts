import { describe, it, expect } from 'vitest';
import { AnimationRecord } from './animation-record.js';
import type { PageAnimation } from './page-animations.js';
import type { ProxyCursor } from './proxy/intercept-proxy.js';
import { markedNow } from './proxy/cause-timeline.js';
import { motionOf } from './write-watch.js';

const step = (n: number): ProxyCursor => ({ kind: 'replay', runId: 'run-a', step: n });

function read(id: number, name: string, element?: string, doc = 'd1'): PageAnimation {
  return {
    id, doc, name, type: 'CSSTransition', ...(element ? { element } : {}),
    duration: 300, delay: 0, easing: 'ease', looping: false, playState: 'running', currentTime: 0,
  };
}

describe('the animation record', () => {
  it('credits a held step\'s sweep to that step', () => {
    const record = new AnimationRecord('page');

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', '#toast')], gone: [], settled: [] }, step(3));

    expect(record.list()).toEqual([expect.objectContaining({ key: 'd1:1', kind: 'opacity #toast', createdIn: step(3), via: 'sweep' })]);
  });

  it('credits an animation Chrome reports to the step it was created in, not the one it started in', () => {
    const record = new AnimationRecord('page');

    record.chromeCreated('c32', step(2));
    record.chromeStarted('c32', read(5, 'transform', 'div.item'));

    expect(record.list()).toEqual([expect.objectContaining({ key: 'd1:5', createdIn: step(2), chromeId: 'c32', via: 'chrome' })]);
  });

  it('names an animation once when a sweep and Chrome both reach it', () => {
    const record = new AnimationRecord('page');
    const added: string[] = [];
    record.watch((entry, change) => added.push(`${change} ${entry.key}`));

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', '#toast')], gone: [], settled: [] }, step(3));
    record.chromeCreated('c1', step(4));
    record.chromeStarted('c1', read(1, 'opacity', '#toast'));

    expect(added).toEqual(['added d1:1']);
    expect(record.list()[0]).toEqual(expect.objectContaining({ createdIn: step(3), chromeId: 'c1' }));
  });

  it('keeps one Chrome reported created and cancelled before it could be read, with no name', () => {
    const record = new AnimationRecord('page');

    record.chromeCreated('c9', step(5));
    record.chromeCanceled('c9');

    expect(record.list()).toEqual([expect.objectContaining({ key: 'chrome:c9', kind: 'animation (unread)', createdIn: step(5), gone: 'canceled' })]);
  });

  it('marks an animation gone, finished from a sweep or cancelled from Chrome', () => {
    const record = new AnimationRecord('page');
    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity'), read(2, 'width')], gone: [], settled: [] }, step(1));
    record.chromeCreated('c2', step(1));
    record.chromeStarted('c2', read(2, 'width'));

    record.takeSweep({ doc: 'd1', created: [], gone: [{ id: 1, how: 'finished' }], settled: [] }, step(2));
    record.chromeCanceled('c2');

    expect(record.list().map(entry => entry.gone)).toEqual(['finished', 'canceled']);
  });

  it('puts the value a sweep read at rest on its animation, and tells the listeners', () => {
    const record = new AnimationRecord('page');
    const heard: string[] = [];
    record.takeSweep({ doc: 'd1', created: [read(4, 'opacity', '#refreshed')], gone: [], settled: [] }, step(1));
    record.watch((entry, change) => heard.push(`${change} ${entry.key}`));

    record.takeSweep({ doc: 'd1', created: [], gone: [], settled: [{ id: 4, value: '1' }] }, step(1));

    expect(heard).toEqual(['settled d1:4']);
    expect(record.get('d1:4')?.settled).toBe('1');
  });

  it('keeps two documents\' animations apart, though their page ids repeat', () => {
    const record = new AnimationRecord('page');

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', undefined, 'd1')], gone: [], settled: [] }, step(1));
    record.takeSweep({ doc: 'd2', created: [read(1, 'opacity', undefined, 'd2')], gone: [], settled: [] }, step(2));

    expect(record.list().map(entry => entry.key)).toEqual(['d1:1', 'd2:1']);
  });

  it('runs each read after the one before it, so no resolve lands between another\'s resolve and read', async () => {
    const record = new AnimationRecord('page');
    const order: string[] = [];
    const read = (name: string, ms: number) => record.queueRead(async () => {
      order.push(`resolve ${name}`);
      await new Promise(resolve => setTimeout(resolve, ms));
      order.push(`read ${name}`);
    });

    await Promise.all([read('a', 10), read('b', 0), read('c', 0)]);

    expect(order).toEqual(['resolve a', 'read a', 'resolve b', 'read b', 'resolve c', 'read c']);
  });

  it('settles a step by sweeping the page, crediting what it lists to the step it settles', async () => {
    const record = new AnimationRecord('page');
    const client = {
      send: async () => ({ result: { value: { doc: 'd1', created: [read(7, 'opacity', '#panel')], gone: [] } } }),
    } as any;

    await record.settle(client, 1000, step(4));

    expect(record.list()).toEqual([expect.objectContaining({ key: 'd1:7', kind: 'opacity #panel', via: 'sweep', createdIn: step(4) })]);
  });
});

describe('a motion report in the page\'s record', () => {
  it('keeps the page-time length for the row and the wall-time length for where it ended', () => {
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 4, doc: 'd', phase: 'close', source: 'scroll', element: 'html', property: 'scrollY', from: '3298', to: '0', startMs: 1000, endMs: 4584, pageStartMs: 1000, pageEndMs: 1896, frames: 203, sentMs: 4704 }, 60_000);

    const [entry] = record.list();
    expect(entry.read).toMatchObject({ duration: 896, wallDuration: 3584 });
    expect(motionOf(entry.read!)).toMatchObject({ durationMs: 896, wallMs: 3584 });
  });

  it('stands as an ended entry of its kind, with its change for the row', () => {
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 1, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '0px', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 50_000);

    const [entry] = record.list();
    expect(entry).toMatchObject({ kind: 'height #acc-body', via: 'motion', gone: 'finished', createdAt: 49_580 });
    expect(entry.read).toMatchObject({ type: 'StyleWrites', duration: 300, from: '0px', to: '58px', frames: 19 });
    expect(record.live()).toHaveLength(0);
  });

  it('stands from its open report, under the step it began in, and its close fills in the same entry', () => {
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 29 }, 300_000);
    const record = new AnimationRecord('conn');
    const changes: string[] = [];
    record.watch((_, change) => changes.push(change));
    record.takeMotion({ id: 7, doc: 'd', phase: 'open', source: 'style', element: '#acc-body', property: 'height', from: '', to: '4px', startMs: 1000, endMs: 1000, pageStartMs: 1000, pageEndMs: 1000, frames: 1, sentMs: 1000 }, 300_016);

    expect(record.live()).toHaveLength(1);
    expect(record.list()[0]).toMatchObject({ createdIn: { entry: 29 }, read: { playState: 'running' } });

    markedNow(undefined, 300_200);
    record.takeMotion({ id: 7, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 300_436);

    expect(record.list()).toHaveLength(1);
    expect(record.list()[0]).toMatchObject({ createdIn: { entry: 29 }, gone: 'finished', read: { duration: 300, to: '58px', frames: 19, playState: 'finished' } });
    expect(changes).toEqual(['added', 'updated']);
  });
});

describe('a motion a later step stopped', () => {
  it('carries the step it ended in beside the step it began in', () => {
    markedNow({ kind: 'command', index: 9 }, 100_000);
    markedNow({ kind: 'command', index: 11 }, 100_900);
    const record = new AnimationRecord('conn');
    // Played at page 1000 under #9, paused at page 1900 under #11, reported at 1910.
    record.takeMotion({ id: 2, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.900', startMs: 1000, endMs: 1900, pageStartMs: 1000, pageEndMs: 1900, frames: 0, sentMs: 1910 }, 100_910);

    const [entry] = record.list();
    expect(entry.createdIn).toMatchObject({ index: 9 });
    expect(entry.endedIn).toMatchObject({ index: 11 });
    expect(entry.endedAt).toBe(100_900);
  });
});

describe('a motion that ends under the step it began in', () => {
  it('carries no end of its own, however many cursors that step stood under', () => {
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 3 }, 200_000);
    markedNow({ kind: 'replay', runId: 'r', step: 1, entry: 3 }, 200_100);
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 3, doc: 'd', phase: 'close', source: 'style', element: '#acc-body', property: 'height', from: '', to: '58px', startMs: 1000, endMs: 1300, pageStartMs: 1000, pageEndMs: 1300, frames: 19, sentMs: 1420 }, 200_500);

    expect(record.list()[0].endedIn).toBeUndefined();
  });
});

describe('a stop placed by its cause, not by when its report arrived', () => {
  it('ends under the step whose call stopped it, though by time it falls in the step before', () => {
    markedNow({ kind: 'command', index: 9 }, 400_000);
    markedNow({ kind: 'command', index: 11 }, 400_900);
    const record = new AnimationRecord('conn');
    // Paused 2ms into #11 by the page's clock, which runs behind: by time the pause lands in #9.
    record.takeMotion({ id: 4, doc: 'd', phase: 'close', source: 'media', element: '#promo', property: 'currentTime', from: '0.015', to: '0.050', startMs: 1000, endMs: 1050, pageStartMs: 1000, pageEndMs: 1050, frames: 0, sentMs: 1051,
      root: { id: 'p:9', step: JSON.stringify({ kind: 'command', index: 9 }) },
      stoppedBy: { maker: 'MEDIA', trigger: 'key [ · pause()', root: { id: 'p:11', step: JSON.stringify({ kind: 'command', index: 11 }) } } }, 400_051);

    expect(record.list()[0].endedIn).toMatchObject({ index: 11 });
  });

  it('adds no end where the motion ended by itself under its own root, however late the step after began', () => {
    markedNow({ kind: 'command', index: 20 }, 500_000);
    markedNow({ kind: 'command', index: 21 }, 500_100);
    const record = new AnimationRecord('conn');
    record.takeMotion({ id: 5, doc: 'd', phase: 'close', source: 'text', element: '#counter', property: 'text', from: '0', to: '1248', startMs: 1000, endMs: 1624, pageStartMs: 1000, pageEndMs: 1624, frames: 39, sentMs: 1625,
      root: { id: 'p:20', step: JSON.stringify({ kind: 'command', index: 20 }) } }, 500_625);

    expect(record.list()[0].endedIn).toBeUndefined();
  });
});
