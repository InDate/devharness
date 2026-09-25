/**
 * Tests for the once-per-session part of a message template.
 *
 * A tool called repeatedly returns its template each time. Orientation is true
 * every time and new only the first, so repeating it spends context on text
 * already read - twenty starts of the bench cost ten thousand tokens of
 * the same three paragraphs.
 */

import { describe, it, expect } from 'vitest';
import { createSuccessResponse, getMessage } from './messages.js';

const textOf = (response: any): string => response.content[0].text;

describe('a template with a once-per-session part', () => {
  it('carries the orientation the first time and drops it after', () => {
    const first = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:1/t/', eventStreamPath: '/tmp/e.jsonl',
    }));
    const second = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:1/t/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(first).toContain('FREEZE in the bench');
    expect(second).not.toContain('FREEZE in the bench');
    expect(second.length).toBeLessThan(first.length / 2);
  });

  it('still says what changed on every call', () => {
    const later = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'second-app', benchUrl: 'http://127.0.0.1:2/u/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(later).toContain('second-app');
    expect(later).toContain('http://127.0.0.1:2/u/');
  });

  it('carries the Monitor call on every start that finds no watch, once part or not', () => {
    const call = 'Monitor({ command: "tail -f -n0 /tmp/e.jsonl" })';
    const unwatched = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:3/v/', eventStreamPath: '/tmp/e.jsonl', monitorCall: call,
    }));
    const watched = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:3/v/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(unwatched).toContain(call);
    expect(watched).not.toContain('No watch reads');
  });

  it('leaves a template without the marker exactly as it was', () => {
    const a = getMessage('ELEMENT_NOT_FOUND', { selector: '.a' });
    const b = getMessage('ELEMENT_NOT_FOUND', { selector: '.a' });

    expect(a).toBe(b);
    expect(a).toContain('.a');
  });
});
