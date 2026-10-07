/**
 * The page's standing as bench start, an already-open bench and bench status
 * name it. The bench's own hold flag reads a pause that a breakpoint, the hold
 * tool or a sequence's pause took as "running" (#109).
 */
import { describe, it, expect } from 'vitest';
import { pageStanding } from './bench-tools.js';
import { attachLayer, hold, release } from '../hold.js';

const running = { pausedAt: () => undefined };

describe('the page standing a bench reply names', () => {
  it('names the debugger pause and where it stands, whoever took it', () => {
    const paused = { pausedAt: () => ({ url: 'http://localhost:8801/join.html', line: 5 }) };

    expect(pageStanding('standing-paused', paused, false)).toBe('paused in the debugger at http://localhost:8801/join.html:5');
  });

  it('names a hold taken outside the bench, with its source', async () => {
    const detach = attachLayer('standing-held', 'code', { engage: async () => ({ armed: true }), disengage: async () => {} });
    await hold('standing-held', { source: 'tool', layers: ['code'] });

    expect(pageStanding('standing-held', running, false)).toBe('held (code by tool)');

    await release('standing-held');
    detach();
  });

  it('leaves a held network out, which stops nothing the page runs', async () => {
    const detach = attachLayer('standing-network', 'network', { engage: async () => undefined, disengage: async () => {} });
    await hold('standing-network', { source: 'bench', layers: ['network'] });

    expect(pageStanding('standing-network', running, false)).toBe('running');

    await release('standing-network');
    detach();
  });

  it('names the bench\'s own hold, and running where nothing holds', () => {
    expect(pageStanding('standing-bench', running, true)).toBe('held');
    expect(pageStanding('standing-free', running, false)).toBe('running');
  });
});
