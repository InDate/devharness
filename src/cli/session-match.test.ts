/**
 * Tests for identifying the session a CLI command was typed in.
 *
 * The tree below is the shape this has to get right: one editor, two Claude
 * sessions under it, each with a supervisor and an MCP child, and a shell
 * under one of them. Every session shares the editor, so a rule that stops at
 * "shares an ancestor" picks both.
 *
 *   900 editor
 *   +-- 800 claude A          +-- 700 claude B
 *       +-- 810 supervisor A      +-- 710 supervisor B
 *       |   +-- 811 mcp A         |   +-- 711 mcp B
 *       +-- 820 shell A           +-- 720 shell B
 *           +-- 821 devharness        +-- 721 devharness
 */

import { describe, it, expect } from 'vitest';
import { collectAncestors, collectChain } from './process-tree.js';
import { matchByAncestry, findSessionByName, filterToListedProcesses, filterToProjectRoot, isWithinRoot, shareOneRoot } from './session-match.js';
import type { SessionRecord } from '../session-endpoint.js';

const PARENTS = new Map<number, number>([
  [900, 1],
  [800, 900], [810, 800], [811, 810], [820, 800], [821, 820],
  [700, 900], [710, 700], [711, 710], [720, 700], [721, 720],
]);

function record(pid: number, shortId: string): SessionRecord {
  return {
    pid,
    ppid: PARENTS.get(pid) ?? 1,
    cwd: `/repo/${shortId}`,
    shortId,
    sessionId: `${shortId}-0000-0000`,
    address: `/tmp/${pid}.sock`,
    startedAt: 1000 + pid,
  };
}

const SESSION_A = record(811, 'aaaaaaaa');
const SESSION_B = record(711, 'bbbbbbbb');

describe('collectAncestors', () => {
  it('walks to the top, nearest first, excluding the process itself and init', () => {
    expect(collectAncestors(821, PARENTS)).toEqual([820, 800, 900]);
  });

  it('returns nothing for a pid with no recorded parent', () => {
    expect(collectAncestors(4242, PARENTS)).toEqual([]);
  });

  it('stops on a cycle instead of spinning', () => {
    const cyclic = new Map<number, number>([[10, 20], [20, 10]]);
    expect(collectAncestors(10, cyclic)).toEqual([20]);
  });

  it('includes the process itself in a chain', () => {
    expect(collectChain(811, PARENTS)).toEqual(new Set([811, 810, 800, 900]));
  });
});

describe('matchByAncestry', () => {
  it('picks the session whose shared ancestor is nearest the caller', () => {
    const result = matchByAncestry([SESSION_A, SESSION_B], 821, PARENTS);
    expect(result.matched?.shortId).toBe('aaaaaaaa');
    expect(result.ambiguous).toEqual([]);
  });

  it('picks the other session from the other shell', () => {
    const result = matchByAncestry([SESSION_A, SESSION_B], 721, PARENTS);
    expect(result.matched?.shortId).toBe('bbbbbbbb');
  });

  it('still lists the far session as a candidate, just further away', () => {
    const result = matchByAncestry([SESSION_A, SESSION_B], 821, PARENTS);
    expect(result.candidates.map(c => [c.record.shortId, c.distance])).toEqual([
      ['aaaaaaaa', 1],  // claude A, one hop up from the shell
      ['bbbbbbbb', 2],  // the editor, two hops up
    ]);
  });

  it('reports ambiguity rather than guessing when two are equally near', () => {
    const twin = { ...record(812, 'cccccccc'), ppid: 810 };
    const parents = new Map(PARENTS).set(812, 810);
    const result = matchByAncestry([SESSION_A, twin], 821, parents);
    expect(result.matched).toBeNull();
    expect(result.ambiguous.map(m => m.record.shortId).sort()).toEqual(['aaaaaaaa', 'cccccccc']);
  });

  it('matches nothing for a caller outside every session tree', () => {
    const parents = new Map(PARENTS).set(50, 1);
    const result = matchByAncestry([SESSION_A, SESSION_B], 50, parents);
    expect(result.matched).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('matches nothing when the process listing is empty', () => {
    const result = matchByAncestry([SESSION_A, SESSION_B], 821, new Map());
    expect(result.matched).toBeNull();
  });
});

describe('filterToListedProcesses', () => {
  it('drops a record whose process is no longer in the listing', () => {
    const gone = record(811, 'aaaaaaaa');
    const parents = new Map(PARENTS);
    parents.delete(811);
    expect(filterToListedProcesses([gone, SESSION_B], parents)).toEqual([SESSION_B]);
  });

  it('keeps every record when the process listing failed', () => {
    expect(filterToListedProcesses([SESSION_A, SESSION_B], new Map())).toEqual([SESSION_A, SESSION_B]);
  });
});

describe('findSessionByName', () => {
  const records = [SESSION_A, SESSION_B];

  it('finds by short id', () => {
    expect(findSessionByName(records, 'bbbbbbbb')?.pid).toBe(711);
  });

  it('finds by full session id and by prefix', () => {
    expect(findSessionByName(records, 'aaaaaaaa-0000-0000')?.pid).toBe(811);
    expect(findSessionByName(records, 'aaaaaaaa-0000')?.pid).toBe(811);
  });

  it('finds by pid', () => {
    expect(findSessionByName(records, '711')?.shortId).toBe('bbbbbbbb');
  });

  it('returns null for a name that matches nothing', () => {
    expect(findSessionByName(records, 'zzzz')).toBeNull();
  });
});

describe('filtering to the project the caller stands in', () => {
  const rooted = (pid: number, cwd: string): SessionRecord =>
    ({ ...record(pid, `id-${pid}`), cwd });

  const records = [
    rooted(811, '/Code/devharness'),
    rooted(711, '/Code/devharness-old'),
    rooted(611, '/Code/speak'),
  ];

  it('keeps the session rooted at the caller\'s own directory', () => {
    expect(filterToProjectRoot(records, '/Code/devharness').map(r => r.pid)).toEqual([811]);
  });

  it('keeps a session rooted above the caller', () => {
    expect(filterToProjectRoot(records, '/Code/devharness/src/cli').map(r => r.pid)).toEqual([811]);
  });

  it('does not treat a sibling sharing a name prefix as a parent', () => {
    expect(isWithinRoot('/Code/devharness-old', '/Code/devharness')).toBe(false);
    expect(filterToProjectRoot(records, '/Code/devharness-old').map(r => r.pid)).toEqual([711]);
  });

  it('keeps nothing when no session holds the caller', () => {
    expect(filterToProjectRoot(records, '/Code/reader')).toEqual([]);
  });
});

describe('two servers tied on one session', () => {
  const rooted = (pid: number, cwd: string): SessionRecord =>
    ({ ...record(pid, `id-${pid}`), cwd });

  it('share one root when both hold the same project', () => {
    expect(shareOneRoot([rooted(811, '/Code/devharness'), rooted(711, '/Code/devharness/')])).toBe(true);
  });

  it('do not share one root when they hold different projects', () => {
    expect(shareOneRoot([rooted(811, '/Code/devharness'), rooted(711, '/Code')])).toBe(false);
  });
});
