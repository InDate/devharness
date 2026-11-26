/**
 * The Claude process an MCP server runs under.
 *
 * A server's parent is its launcher, not Claude: the supervisor
 * (`mcp-supervisor.js`, or the `devharness` bin that runs it), with `npm exec`
 * between the supervisor and Claude for a server installed through npx. Two
 * servers in one Claude session therefore carry different parents, and only
 * the process above the launcher chain is shared.
 */

import { execFileSync } from 'child_process';

const LAUNCHER = /mcp-supervisor|\/devharness(\s|$)|devharness\/build\/index\.js|\bnpm exec\b|\bnpx\b/;
const MOST_HOPS = 6;

type ProcessTable = Map<number, { ppid: number; command: string }>;

function readProcessTable(): ProcessTable {
  const table: ProcessTable = new Map();
  const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8', timeout: 2000 });
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] });
  }
  return table;
}

/** The first process at or above `pid` whose command is no launcher; `pid` itself where the table holds nothing above it. */
export function sessionProcessOf(pid: number, table: ProcessTable): number {
  let current = pid;
  for (let hop = 0; hop < MOST_HOPS; hop++) {
    const entry = table.get(current);
    if (!entry || !LAUNCHER.test(entry.command) || entry.ppid <= 1) return current;
    current = entry.ppid;
  }
  return current;
}

/**
 * Each parent pid mapped to the Claude process above it, duplicates dropped,
 * order kept. A failed `ps` returns the pids as given.
 */
export function sessionProcesses(parentPids: number[], read: () => ProcessTable = readProcessTable): number[] {
  let table: ProcessTable;
  try {
    table = read();
  } catch {
    return parentPids;
  }
  return [...new Set(parentPids.map(pid => sessionProcessOf(pid, table)))];
}
