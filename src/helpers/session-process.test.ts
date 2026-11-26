import { describe, it, expect } from 'vitest';
import { sessionProcessOf, sessionProcesses } from './session-process.js';

const table = new Map([
  [40366, { ppid: 40162, command: 'claude --resume abcd' }],
  [40440, { ppid: 40366, command: 'node /Users/someone/devharness/build/mcp-supervisor.js' }],
  [40441, { ppid: 40366, command: 'npm exec devharness@0.20.0' }],
  [40669, { ppid: 40441, command: 'node /opt/homebrew/bin/devharness' }],
  [50000, { ppid: 40162, command: 'claude --resume abcd --fork-session' }],
]);

describe('sessionProcessOf', () => {
  it('walks a direct supervisor and an npx chain up to the one Claude process', () => {
    expect(sessionProcessOf(40440, table)).toBe(40366);
    expect(sessionProcessOf(40669, table)).toBe(40366);
  });

  it('keeps a pid that is no launcher, and one the table lacks', () => {
    expect(sessionProcessOf(50000, table)).toBe(50000);
    expect(sessionProcessOf(1234, table)).toBe(1234);
  });
});

describe('sessionProcesses', () => {
  it('collapses two servers of one session to one Claude process, and keeps two sessions apart', () => {
    expect(sessionProcesses([40440, 40669], () => table)).toEqual([40366]);
    expect(sessionProcesses([40440, 50000], () => table)).toEqual([40366, 50000]);
  });

  it('returns the pids as given when ps fails', () => {
    expect(sessionProcesses([1, 2], () => { throw new Error('no ps'); })).toEqual([1, 2]);
  });
});
