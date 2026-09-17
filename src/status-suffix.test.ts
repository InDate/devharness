/**
 * Tests for the status lines appended to every tool response.
 *
 * They ride on every call, so what repeats is what they cost. Counts that do
 * not change between calls, a heading, a rule and a spelled-out call are all
 * paid for on every response and read once.
 */

import { describe, it, expect } from 'vitest';
import { buildStatusSuffix } from './tool-response.js';

describe('buildStatusSuffix', () => {
  it('says nothing when nothing changed', () => {
    expect(buildStatusSuffix([])).toBe('');
  });

  it('is one short line per item', () => {
    const suffix = buildStatusSuffix([
      { label: 'Logs', value: 'test-app (1 err/3 out)' },
      { label: 'Replay', value: '7' },
    ]);

    expect(suffix).toBe('\n\ntest-app (1 err/3 out)'.replace('test-app', 'Logs: test-app') + '\nReplay: 7');
    expect(suffix).not.toContain('---');
    expect(suffix).not.toContain('**');
  });

  it('explains the lines when asked, and that is the longer form', () => {
    const items = [{ label: 'Replay', value: '7' }];

    const plain = buildStatusSuffix(items);
    const explained = buildStatusSuffix(items, true);

    expect(plain).not.toContain('session history');
    expect(explained).toContain('session history');
    expect(explained).toContain('this note only once');
    expect(explained.length).toBeGreaterThan(plain.length * 5);
  });
});
