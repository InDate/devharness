/**
 * Guarded stderr writer for the supervisor.
 *
 * The supervisor's stderr is a pipe held by the Claude Code host. The host
 * exits and closes its end; the supervisor's next write to fd 2 returns
 * errno 32, EPIPE. Node delivers that as an `error` event on the stream, and a
 * stream with no `error` listener raises it as an `uncaughtException`. The
 * supervisor's `uncaughtException` handler logs the exception, which writes to
 * the same closed pipe, which raises the same EPIPE: a write loop with no pause
 * that holds a core until the process is killed. Two such supervisors were
 * measured at about 89,000 write calls a second each, every call returning
 * errno 32, five days after their sessions ended.
 *
 * Two guards break that chain. An `error` listener on the stream takes the
 * EPIPE off the `uncaughtException` path, so a failed write raises nothing. A
 * `broken` latch turns every later write into a no-op, so the count of writes
 * to a closed pipe is bounded at one.
 *
 * `isBroken()` reports the latch. A closed host pipe means the host is gone,
 * which is the supervisor's signal to shut down rather than run on unattached.
 */

export interface StderrLog {
  /** Writes one prefixed line. A latched-broken stream consumes nothing. */
  write(message: string): void;
  /** True once a write to the stream has failed. */
  isBroken(): boolean;
}

export function createStderrLog(
  prefix: string,
  stream: NodeJS.WriteStream | NodeJS.WritableStream = process.stderr,
  onBroken?: () => void,
): StderrLog {
  let broken = false;

  const latch = (): void => {
    if (broken) return;
    broken = true;
    if (onBroken) onBroken();
  };

  // Attached once, for the lifetime of the process: an EPIPE that arrives
  // asynchronously lands here instead of on the uncaughtException path.
  stream.on('error', latch);

  return {
    write(message: string): void {
      if (broken) return;
      try {
        stream.write(`${prefix} ${message}\n`);
      } catch {
        // A synchronous throw covers the case where the write fails inline
        // rather than through the stream's error event.
        latch();
      }
    },
    isBroken(): boolean {
      return broken;
    },
  };
}
