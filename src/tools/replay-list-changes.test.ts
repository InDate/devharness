/**
 * A session's first listing of the saved sequences draws every one; the full
 * list then stands in the agent's context, so each later listing draws only
 * what changed since the last, with a note pointing back at it. `full: true`
 * draws the whole list again, and a listing bound for the bench draws in full
 * without moving the session's record.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleList, handleListSaved, resetDiskListings } from './replay-library.js';
import { arriveOn } from '../call-origin.js';
import { setSessionInfo } from './dashboard-tools.js';

function recorder(saved: Array<{ name: string; commandCount: number }>) {
  return {
    listSavedSequencesOnDisk: async () => saved.map((one, i) => ({ ...one, id: `seq-${i + 1}`, filename: `${one.name}.json`, fullPath: `/seq/${one.name}.json` })),
    listIssueSequencesOnDisk: async () => [],
    listSequences: () => [],
  } as any;
}

const text = (result: any): string => result.content[0].text;

describe('listing the saved sequences in a session', () => {
  beforeEach(() => resetDiskListings());

  it('names how to view, run and drop a sequence on the first listing of the session only', async () => {
    const disk = recorder([{ name: 'a', commandCount: 2 }]);
    resetDiskListings();
    const first = text(await handleListSaved({ action: 'listSaved', full: true } as any, disk));
    const second = text(await handleListSaved({ action: 'listSaved', full: true } as any, disk));

    expect(first).toContain("run({ action: 'sequence', name })");
    expect(second).not.toContain("run({ action: 'sequence', name })");
    expect(second).toContain('1. a (2)');
  });

  it('draws every sequence on the first listing', async () => {
    const out = text(await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 2 }, { name: 'b', commandCount: 3 }])));
    expect(out).toContain('**Saved** (2)');
    expect(out).toContain('1. a (2)');
    expect(out).toContain('2. b (3)');
  });

  it('draws a one-line note on a later listing with nothing changed', async () => {
    const disk = recorder([{ name: 'a', commandCount: 2 }]);
    await handleListSaved({ action: 'listSaved' } as any, disk);
    const out = text(await handleListSaved({ action: 'listSaved' } as any, disk));
    expect(out).toContain('1 saved, unchanged since the full list earlier in this session');
    expect(out).not.toContain('1. a (2)');
  });

  it('draws the sequences added, gone and changed since the last listing', async () => {
    await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 2 }, { name: 'b', commandCount: 3 }]));
    const out = text(await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 4 }, { name: 'c', commandCount: 1 }])));
    expect(out).toContain('3 change(s) since the last listing');
    expect(out).toContain('~ a (2) → a (4)');
    expect(out).toContain('+ c (1)');
    expect(out).toContain('− b (3)');
  });

  it('compares each listing with the one before it, not with the first', async () => {
    await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 2 }]));
    await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 2 }, { name: 'c', commandCount: 1 }]));
    const out = text(await handleListSaved({ action: 'listSaved' } as any, recorder([{ name: 'a', commandCount: 2 }, { name: 'c', commandCount: 1 }])));
    expect(out).toContain('2 saved, unchanged');
  });

  it('draws every sequence again with full', async () => {
    const disk = recorder([{ name: 'a', commandCount: 2 }]);
    await handleListSaved({ action: 'listSaved' } as any, disk);
    const out = text(await handleListSaved({ action: 'listSaved', full: true } as any, disk));
    expect(out).toContain('1. a (2)');
  });

  it('shares one record between list and listSaved', async () => {
    const disk = recorder([{ name: 'a', commandCount: 2 }]);
    await handleListSaved({ action: 'listSaved' } as any, disk);
    const out = text(await handleList({ action: 'list' } as any, disk));
    expect(out).toContain('1 saved, unchanged');
    expect(out).not.toContain('1. a (2)');
  });

  it('draws in full for the bench and leaves the session record for the next agent listing', async () => {
    const disk = recorder([{ name: 'a', commandCount: 2 }]);
    const bench = text(await arriveOn('bench', () => handleListSaved({ action: 'listSaved' } as any, disk)));
    expect(bench).toContain('1. a (2)');
    const agent = text(await handleListSaved({ action: 'listSaved' } as any, disk));
    expect(agent).toContain('1. a (2)');
  });

  it('keeps the record when the detector names the session between two listings', async () => {
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'aaaa1111-2222-3333-4444-555566667777';
    try {
      const disk = recorder([{ name: 'a', commandCount: 2 }]);
      setSessionInfo(null);
      await handleListSaved({ action: 'listSaved' } as any, disk);
      setSessionInfo({ sessionId: 'aaaa1111-2222-3333-4444-555566667777', shortId: 'aaaa1111' } as any);
      const out = text(await handleList({ action: 'list' } as any, disk));
      expect(out).toContain('1 saved, unchanged');
    } finally {
      setSessionInfo(null);
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
  });
});

