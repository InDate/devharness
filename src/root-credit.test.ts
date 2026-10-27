import { describe, it, expect, vi, afterEach } from 'vitest';
import { entrySettled, nameRoot, noteRoot, onEntrySettled, setSettleGate, stepToken, whenSettled } from './root-credit.js';

const driven = (entry: number) => stepToken({ kind: 'replay', runId: 'run-a', step: entry, entry });

afterEach(() => { vi.useRealTimers(); });

describe('a step read once its roots settle', () => {
  it('stands open while a root credited to it has work outstanding, and settles when the last one does', async () => {
    const settled: number[] = [];
    const stop = onEntrySettled(entry => settled.push(entry));
    noteRoot('page', { id: 'p:1', step: driven(41) }, true);
    noteRoot('page', { id: 'p:2', step: driven(41) }, true);

    noteRoot('page', { id: 'p:1', step: driven(41) }, false);
    await Promise.resolve();
    expect(entrySettled(41)).toBe(false);
    expect(settled).toEqual([]);

    noteRoot('page', { id: 'p:2', step: driven(41) }, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(entrySettled(41)).toBe(true);
    expect(settled).toEqual([41]);
    stop();
  });

  it('is not held open by another step\'s root', () => {
    noteRoot('page', { id: 'p:3', step: driven(51) }, true);
    expect(entrySettled(52)).toBe(true);
    noteRoot('page', { id: 'p:3', step: driven(51) }, false);
  });

  it('holds a person\'s input open under the History entry its root is named as', () => {
    noteRoot('page', { id: 'p:4' }, true);
    nameRoot('p:4', { kind: 'command', index: 61 });
    expect(entrySettled(61)).toBe(false);
    noteRoot('page', { id: 'p:4' }, false);
    expect(entrySettled(61)).toBe(true);
  });

  it('announces a settle only after the browser\'s reports already received are drained', async () => {
    const order: string[] = [];
    let drain!: () => void;
    const ungate = setSettleGate('gated', () => new Promise<void>(resolve => { drain = () => { order.push('drained'); resolve(); }; }));
    const stop = onEntrySettled(entry => { if (entry === 71) order.push('settled'); });
    noteRoot('gated', { id: 'p:5', step: driven(71) }, true);
    noteRoot('gated', { id: 'p:5', step: driven(71) }, false);
    await Promise.resolve();
    expect(order).toEqual([]);

    drain();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['drained', 'settled']);
    stop();
    ungate();
  });

  it('answers a wait true when the step settles, and false at the bound where a root runs on', async () => {
    noteRoot('page', { id: 'p:6', step: driven(81) }, true);
    const waited = whenSettled(81, 1000);
    noteRoot('page', { id: 'p:6', step: driven(81) }, false);
    await expect(waited).resolves.toBe(true);

    vi.useFakeTimers();
    noteRoot('page', { id: 'p:7', step: driven(82) }, true);
    const bounded = whenSettled(82, 1000);
    vi.advanceTimersByTime(1000);
    await expect(bounded).resolves.toBe(false);
  });
});
