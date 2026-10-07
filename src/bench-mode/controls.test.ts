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
  await release(CONNECTION).catch(() => {});
  detach?.(); detach = undefined;
  sessions.delete(CONNECTION);
});

describe('benchHold on a page a paused run holds', () => {
  it('passes over the run\'s own hold for a call that resumes the run', async () => {
    openBench();
    await hold(CONNECTION, { source: 'sequence', layers: ['code'] });

    expect(benchHold(CONNECTION, true)).toBeUndefined();
  });

  it('refuses any other driving call, naming finish and step as the way on', async () => {
    openBench();
    await hold(CONNECTION, { source: 'sequence', layers: ['code'] });

    const refusal = benchHold(CONNECTION);

    expect(refusal?.why).toContain('held by the sequence');
    expect(refusal?.release).toContain("replay({ action: 'finish' })");
  });

  it('refuses a resuming call while the bench holds the page itself', async () => {
    openBench();
    await hold(CONNECTION, { source: 'bench', layers: ['code'] });

    const refusal = benchHold(CONNECTION, true);

    expect(refusal?.why).toContain('held by the bench');
    expect(refusal?.release).toContain("bench({ action: 'release'");
  });
});
