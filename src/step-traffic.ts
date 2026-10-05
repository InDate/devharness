/**
 * What one step's window held at the app's boundary, counted from the network
 * log, the transports opened and the page's storage writes.
 *
 * One count for every side that stores or compares it: a recording made with
 * `create`, a baseline play in the bench, and a replay compared against
 * either. Two sides counted by different code report drift where the app did
 * nothing different.
 */
import type { StepTraffic } from './annotation.js';
import type { ExecuteToolCall } from './types.js';
import { unlisted } from './call-origin.js';

/**
 * The step's counts over `from` to `to`, or undefined where the network log
 * could not be read. Undefined rather than zeros: a stored zero reads as
 * "nothing crossed" against every later replay.
 */
export function countStepTraffic(
  executeToolCall: ExecuteToolCall,
  connection: string,
  from: number,
  to: number
): Promise<StepTraffic | undefined> {
  return unlisted(async () => {
    const http = await executeToolCall('network', {
      action: 'list', connection, since: from, until: to, limit: 100000,
    }).catch(() => null);
    if (!http) return undefined;
    const rows = http._meta?.network?.requests ?? [];
    // A transport counts against the action that OPENED it, by its open
    // clock. What it later carries does not: a socket opened by one action
    // can be sent on by another, and what comes back belongs where it
    // arrived, not to whoever opened the pipe.
    const inWindow = (t: any) => t.openedAt >= from && t.openedAt < to;
    const sockets = await executeToolCall('network', {
      action: 'sockets', connection,
    }).catch(() => null);
    const streams = await executeToolCall('network', {
      action: 'streams', connection,
    }).catch(() => null);
    const transports = [
      ...(sockets?._meta?.socketList ?? []).filter(inWindow),
      ...(streams?._meta?.streamList ?? []).filter(inWindow),
    ];
    const stored = await executeToolCall('storage', {
      action: 'writes', connection, since: from, until: to,
    }).catch(() => null);
    const written = (stored?._meta?.storage?.writes ?? []) as any[];
    return {
      requests: rows.length,
      failed: rows.filter((r: any) => r.failed || (r.status ?? 0) >= 400).length,
      opened: transports.length,
      writes: written.length,
      lines: [
        ...rows.slice(0, 8).map((r: any) => {
          const path = (() => { try { return new URL(r.url).pathname; } catch { return r.url; } })();
          return `${r.method} ${path} ${r.failed ? 'failed' : (r.status ?? 'pending')}`;
        }),
        ...transports.slice(0, 4).map((t: any) => `opened ${t.url}`),
        ...written.slice(0, 4).map((w: any) => `${w.area}Storage ${w.operation} ${w.key ?? ''}`.trim()),
      ],
    };
  });
}
