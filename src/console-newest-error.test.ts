/**
 * Tests for the error the status line names.
 *
 * "Console: 1 err" says an error happened and nothing about which one, so
 * acting on it costs a second tool call to fetch what the first already held.
 */

import { describe, it, expect } from 'vitest';
import { ConsoleMonitor } from './console-monitor.js';

/** Enough of a monitor to hold messages, without a CDP client behind it. */
function monitorWith(messages: Array<{ type: string; text: string; url?: string; line?: number }>): any {
  const monitor: any = new (ConsoleMonitor as any)();
  monitor.messages = messages.map((m, i) => ({
    id: String(i),
    type: m.type,
    text: m.text,
    args: [],
    ...(m.url ? { location: { url: m.url, lineNumber: m.line ?? 0, columnNumber: 0 } } : {}),
    timestamp: Date.now(),
  }));
  monitor.lastSeenCount = 0;
  return monitor;
}

describe('peekNewestError', () => {
  it('names the error and the file it came from', () => {
    const monitor = monitorWith([
      { type: 'log', text: 'ready' },
      { type: 'error', text: 'TypeError: x is not a function', url: 'http://localhost/static/bundle.js', line: 42 },
    ]);

    expect(monitor.peekNewestError()).toEqual({
      text: 'TypeError: x is not a function',
      where: 'bundle.js:42',
    });
  });

  it('takes the newest, which is the one just raised', () => {
    const monitor = monitorWith([
      { type: 'error', text: 'first' },
      { type: 'error', text: 'second' },
    ]);

    expect(monitor.peekNewestError().text).toBe('second');
  });

  it('leaves the cursor alone, so the count that follows is unchanged', () => {
    const monitor = monitorWith([{ type: 'error', text: 'boom' }]);

    monitor.peekNewestError();

    expect(monitor.getLogStats().newErrors).toBe(1);
  });

  it('reports nothing when the new messages hold no error', () => {
    const monitor = monitorWith([{ type: 'log', text: 'ready' }, { type: 'warn', text: 'slow' }]);

    expect(monitor.peekNewestError()).toBeUndefined();
  });

  it('ignores errors already reported', () => {
    const monitor = monitorWith([{ type: 'error', text: 'old' }]);
    monitor.getLogStats();

    expect(monitor.peekNewestError()).toBeUndefined();
  });
});
