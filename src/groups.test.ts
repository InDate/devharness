import { describe, it, expect } from 'vitest';
import { groupOf, joinGroup, joinRunGroup, membersOf, runGroupName } from './groups.js';

describe('the group a sequence names for its launches', () => {
  it('keeps a name of 20 characters or fewer', () => {
    expect(runGroupName('group-hold-controls')).toBe('group-hold-controls');
  });

  it('takes the initials of a longer name, split at separators and camel case', () => {
    expect(runGroupName('bench-connection-picker-widths')).toBe('bcpw');
    expect(runGroupName('checkoutFlowWithTwoBuyers')).toBe('cfwtb');
    expect(runGroupName('my sequence for two browsers')).toBe('msftb');
  });

  it('takes the first 20 characters of a long name with no letters to take initials from', () => {
    expect(runGroupName('_'.repeat(24))).toBe('_'.repeat(20));
  });
});

describe('a launched browser joining the run group', () => {
  it('joins the group of the run connection', () => {
    joinGroup('existing-run-group', 'run-browser-grouped');
    joinRunGroup('launched-into-existing', 'run-browser-grouped', 'unused-fallback');

    expect(groupOf('launched-into-existing')).toBe('existing-run-group');
  });

  it('forms the fallback group with an ungrouped run connection', () => {
    joinRunGroup('launched-into-fallback', 'run-browser-ungrouped', 'fallback-run-group');

    expect(membersOf('fallback-run-group').sort()).toEqual(['launched-into-fallback', 'run-browser-ungrouped']);
  });

  it('leaves a browser already in a group where it is', () => {
    joinGroup('group-held-elsewhere', 'browser-grouped-elsewhere');
    joinRunGroup('browser-grouped-elsewhere', 'run-browser-other', 'other-fallback-group');

    expect(groupOf('browser-grouped-elsewhere')).toBe('group-held-elsewhere');
  });
});
