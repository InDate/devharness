import { describe, it, expect } from 'vitest';
import { duplicateSessionInfo } from './dashboard-tools.js';
import { RUNNING_BUILD } from '../dashboard/running-build.js';
import { checkDuplicateSession } from '../tool-response.js';

const me = process.pid;
const other = 1;

describe('duplicateSessionInfo', () => {
  it('leaves out a server of the session running another build', () => {
    const info = duplicateSessionInfo('abc-123', 'abc', [me, other], [process.ppid, 2], {
      [me]: { ppid: process.ppid, build: RUNNING_BUILD },
      [other]: { ppid: 2, build: '/elsewhere/devharness/build/index.js' },
    });
    expect(info.allPids).toEqual([me]);
    expect(checkDuplicateSession(info, 'connection').blocked).toBe(false);
  });

  it('counts a server running this build, so a resumed copy is still blocked', () => {
    const info = duplicateSessionInfo('abc-123', 'abc', [me, other], [process.ppid, 2], {
      [me]: { ppid: process.ppid, build: RUNNING_BUILD },
      [other]: { ppid: 2, build: RUNNING_BUILD },
    });
    expect(info).toMatchObject({ allPids: [me, other], allPpids: [process.ppid, 2] });
    expect(checkDuplicateSession(info, 'connection').blocked).toBe(true);
  });

  it('leaves out a server reporting no build, which runs an older version', () => {
    const info = duplicateSessionInfo('abc-123', 'abc', [me, other], [process.ppid, 2], {
      [me]: { ppid: process.ppid, build: RUNNING_BUILD },
      [other]: { ppid: 2 },
    });
    expect(info.allPids).toEqual([me]);
  });

  it('counts every pid where the hub keeps no server records', () => {
    const info = duplicateSessionInfo('abc-123', 'abc', [me, other], [process.ppid, 2], {});
    expect(info.allPids).toEqual([me, other]);
  });
});
