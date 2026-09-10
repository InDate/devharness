/**
 * Observed for real: two supervisors from sessions that had ended days earlier
 * were each issuing about 89,000 write calls a second to fd 2, every call
 * returning errno 32 (EPIPE), together accounting for 96.8% of the machine's
 * filesystem syscalls. The loop is the supervisor's uncaughtException handler
 * logging to the closed host pipe, which raises the next uncaughtException.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createStderrLog } from './stderr-log.js';

/** A stream whose write throws inline, the synchronous EPIPE shape. */
function throwingStream(): NodeJS.WritableStream {
  const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
  stream.write = (() => {
    const err = new Error('write EPIPE') as NodeJS.ErrnoException;
    err.code = 'EPIPE';
    throw err;
  }) as NodeJS.WritableStream['write'];
  return stream;
}

/** A stream that accepts writes and emits errors on demand, the async shape. */
function emittingStream(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
  stream.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as NodeJS.WritableStream['write'];
  return { stream, lines };
}

describe('createStderrLog', () => {
  it('writes prefixed lines while the stream accepts them', () => {
    const { stream, lines } = emittingStream();
    const log = createStderrLog('[mcp-supervisor]', stream);

    log.write('Starting (PID: 1)');
    log.write('Shutting down (host stdin closed)');

    expect(lines).toEqual([
      '[mcp-supervisor] Starting (PID: 1)\n',
      '[mcp-supervisor] Shutting down (host stdin closed)\n',
    ]);
    expect(log.isBroken()).toBe(false);
  });

  it('writes to a synchronously failing stream exactly once', () => {
    const stream = throwingStream();
    const write = vi.spyOn(stream, 'write');
    const log = createStderrLog('[mcp-supervisor]', stream);

    for (let i = 0; i < 1000; i++) log.write('Uncaught exception: write EPIPE');

    expect(write).toHaveBeenCalledTimes(1);
    expect(log.isBroken()).toBe(true);
  });

  it('stops writing after the stream emits an error', () => {
    const { stream, lines } = emittingStream();
    const log = createStderrLog('[mcp-supervisor]', stream);

    log.write('before');
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    for (let i = 0; i < 1000; i++) log.write('after');

    expect(lines).toEqual(['[mcp-supervisor] before\n']);
    expect(log.isBroken()).toBe(true);
  });

  it('keeps an emitted error off the uncaughtException path', () => {
    const { stream } = emittingStream();
    createStderrLog('[mcp-supervisor]', stream);

    // An EventEmitter with no 'error' listener throws on emit; the listener the
    // log attaches is what makes this emit return instead of throwing.
    expect(() => stream.emit('error', new Error('write EPIPE'))).not.toThrow();
  });

  it('calls onBroken once, on the first failure', () => {
    const stream = throwingStream();
    const onBroken = vi.fn();
    const log = createStderrLog('[mcp-supervisor]', stream, onBroken);

    log.write('one');
    log.write('two');
    log.write('three');

    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(log.isBroken()).toBe(true);
  });
});
