import { describe, it, expect, afterEach } from 'vitest';
import { benchHold } from './controls.js';
import { sessions } from './session.js';
import { attachLayer, hold, release } from '../hold.js';

const CONNECTION = 'bench-held-page';

let detach: (() => void) | undefined;

function openBench() {
  sessions.set(CONNECTION, { recordingSequence: false, sequenceBusy: false } as any);
  detach = attachLayer(CONNECTION, 'code', { engage: async () => {}, disengage: async () => {} });
}

afterEach(async () => {
  await release(CONNECTION, { by: { kind: 'resume' } }).catch(() => {});
  detach?.(); detach = undefined;
  sessions.delete(CONNECTION);
});

describe('benchHold on a page a paused run holds', () => {
  it('passes over the run\'s own hold for a call that resumes the run', async () => {
    openBench();
    await hold(CONNECTION, { owner: { kind: 'run-pause' }, layers: ['code'] });

    expect(benchHold(CONNECTION, true)).toBeUndefined();
  });

  it('refuses any other driving call, naming finish and step as the way on', async () => {
    openBench();
    await hold(CONNECTION, { owner: { kind: 'run-pause' }, layers: ['code'] });

    const refusal = benchHold(CONNECTION);

    expect(refusal?.why).toContain('held by a paused run');
    expect(refusal?.release).toContain("run({ action: 'finish' })");
  });

  it('refuses a resuming call while the bench holds the page itself', async () => {
    openBench();
    await hold(CONNECTION, { owner: { kind: 'person' }, layers: ['code'] });

    const refusal = benchHold(CONNECTION, true);

    expect(refusal?.why).toContain('held by a person, by hand in the bench');
    expect(refusal?.release).toBe('it runs again when they release it in the bench');
  });
});
