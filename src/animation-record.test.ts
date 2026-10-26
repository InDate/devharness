import { describe, it, expect } from 'vitest';
import { AnimationRecord } from './animation-record.js';
import type { PageAnimation } from './page-animations.js';
import type { ProxyCursor } from './proxy/intercept-proxy.js';

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

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', '#toast')], gone: [] }, step(3));

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

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', '#toast')], gone: [] }, step(3));
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
    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity'), read(2, 'width')], gone: [] }, step(1));
    record.chromeCreated('c2', step(1));
    record.chromeStarted('c2', read(2, 'width'));

    record.takeSweep({ doc: 'd1', created: [], gone: [{ id: 1, how: 'finished' }] }, step(2));
    record.chromeCanceled('c2');

    expect(record.list().map(entry => entry.gone)).toEqual(['finished', 'canceled']);
  });

  it('keeps two documents\' animations apart, though their page ids repeat', () => {
    const record = new AnimationRecord('page');

    record.takeSweep({ doc: 'd1', created: [read(1, 'opacity', undefined, 'd1')], gone: [] }, step(1));
    record.takeSweep({ doc: 'd2', created: [read(1, 'opacity', undefined, 'd2')], gone: [] }, step(2));

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

  it('settles a step by sweeping the page, crediting what it lists to the step running', async () => {
    const record = new AnimationRecord('page');
    const client = {
      send: async () => ({ result: { value: { doc: 'd1', created: [read(7, 'opacity', '#panel')], gone: [] } } }),
    } as any;

    await record.settle(client);

    expect(record.list()).toEqual([expect.objectContaining({ key: 'd1:7', kind: 'opacity #panel', via: 'sweep' })]);
  });
});
