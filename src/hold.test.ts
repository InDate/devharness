import { afterEach, describe, it, expect } from 'vitest';
import { attachLayer, forgetConnection, forRunStep, hold, holdReading, recordHeld, release, type HoldLayer } from './hold.js';

const CONNECTION = 'hold-owners';

/** A ui mechanism covering the code, and a code mechanism, each logging what it engages and disengages. */
function attachLogged(): string[] {
  const log: string[] = [];
  const mechanism = (layer: HoldLayer, covers?: HoldLayer[]) => ({
    ...(covers ? { covers } : {}),
    engage: async () => { log.push(`engage ${layer}`); },
    disengage: async () => { log.push(`disengage ${layer}`); },
  });
  attachLayer(CONNECTION, 'ui', mechanism('ui', ['code']));
  attachLayer(CONNECTION, 'code', mechanism('code'));
  return log;
}

const heldLayers = () => holdReading(CONNECTION).held.map(held => held.layer);

afterEach(() => forgetConnection(CONNECTION));

describe('hold owners - a layer runs again when its last owner releases it', () => {
  it('engages once for two owners, and disengages only when the second is released', async () => {
    const log = attachLogged();
    await hold(CONNECTION, { owner: { kind: 'person' }, layers: ['ui'] });
    await hold(CONNECTION, { owner: { kind: 'run-step', run: 'run-a', step: 1 }, layers: ['ui'] });

    await release(CONNECTION, { by: { kind: 'run', run: 'run-a' } });
    expect(heldLayers()).toEqual(['ui', 'code']);

    await release(CONNECTION, { by: { kind: 'person' } });
    expect(heldLayers()).toEqual([]);
    expect(log).toEqual(['engage ui', 'disengage ui']);
  });

  it('leaves a person\'s hand hold standing through an agent\'s release', async () => {
    attachLogged();
    await hold(CONNECTION, { owner: { kind: 'person' }, layers: ['ui'] });
    await hold(CONNECTION, { owner: { kind: 'agent' }, layers: ['ui'] });

    await release(CONNECTION, { by: { kind: 'agent' } });

    const ui = holdReading(CONNECTION).held.find(held => held.layer === 'ui');
    expect(ui?.owners).toEqual([{ kind: 'person' }]);
  });

  it('ends every hold an agent may end, a run\'s and a breakpoint\'s included', async () => {
    attachLogged();
    await hold(CONNECTION, { owner: { kind: 'run-step', run: 'run-a' }, layers: ['ui'] });
    recordHeld(CONNECTION, 'network', { kind: 'outside' });

    await release(CONNECTION, { by: { kind: 'agent' }, layers: ['ui'] });

    expect(heldLayers()).toEqual(['network']);
  });

  it('ends a run\'s pause alone when the run carries on, leaving the hold its step took', async () => {
    attachLogged();
    await hold(CONNECTION, { owner: { kind: 'run-step', run: 'run-a', step: 1 }, layers: ['ui'] });
    await hold(CONNECTION, { owner: { kind: 'run-pause', run: 'run-a' }, layers: ['ui'] });

    await release(CONNECTION, { by: { kind: 'run', run: 'run-a', pauseOnly: true } });

    const ui = holdReading(CONNECTION).held.find(held => held.layer === 'ui');
    expect(ui?.owners).toEqual([{ kind: 'run-step', run: 'run-a', step: 1 }]);
  });

  it('ends one run\'s holds as it finishes, and leaves another run\'s', async () => {
    attachLogged();
    await hold(CONNECTION, { owner: { kind: 'run-step', run: 'run-a' }, layers: ['ui'] });
    await hold(CONNECTION, { owner: { kind: 'run-pause', run: 'run-b' }, layers: ['ui'] });

    await release(CONNECTION, { by: { kind: 'run', run: 'run-a' } });

    const ui = holdReading(CONNECTION).held.find(held => held.layer === 'ui');
    expect(ui?.owners).toEqual([{ kind: 'run-pause', run: 'run-b' }]);
  });

  it('resumes a breakpoint\'s stop for the debugger, and leaves devharness\'s own hold', async () => {
    attachLogged();
    recordHeld(CONNECTION, 'code', { kind: 'outside' });
    await release(CONNECTION, { by: { kind: 'debugger' } });
    expect(heldLayers()).toEqual([]);

    await hold(CONNECTION, { owner: { kind: 'agent' }, layers: ['code'] });
    await release(CONNECTION, { by: { kind: 'debugger' } });
    expect(heldLayers()).toEqual(['code']);
  });

  it('blocks a run\'s driving step on a hand hold or a step\'s hold, and releases an agent\'s or a rule\'s for it', () => {
    expect(forRunStep({ kind: 'person' }, 'run-a')).toBe('blocks');
    expect(forRunStep({ kind: 'run-step', run: 'run-a' }, 'run-a')).toBe('blocks');
    expect(forRunStep({ kind: 'run-pause', run: 'run-b' }, 'run-a')).toBe('blocks');
    expect(forRunStep({ kind: 'agent' }, 'run-a')).toBe('released');
    expect(forRunStep({ kind: 'rule' }, 'run-a')).toBe('released');
    expect(forRunStep({ kind: 'run-pause', run: 'run-a' }, 'run-a')).toBe('released');
    expect(forRunStep({ kind: 'outside' }, 'run-a')).toBe('outside');
  });

  it('keeps the covered code stopped under the owner the cover took', async () => {
    attachLogged();
    await hold(CONNECTION, { owner: { kind: 'person' }, layers: ['ui'] });
    await hold(CONNECTION, { owner: { kind: 'agent' }, layers: ['code'] });

    const code = holdReading(CONNECTION).held.find(held => held.layer === 'code');
    expect(code?.via).toBe('ui');
    expect(code?.owners).toEqual([{ kind: 'person' }, { kind: 'agent' }]);
  });
});
