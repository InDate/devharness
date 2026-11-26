#!/usr/bin/env node

/**
 * postbuild hook: signals every running mcp-supervisor that serves THIS
 * checkout, so `npm run build` hot-reloads a live Claude Code connection
 * instead of requiring a manual /mcp reconnect. The project's pidfile names the
 * supervisors started from this directory; a process listing adds those
 * running this build from any other project directory, whose pidfiles sit
 * under their own `.devharness/`.
 *
 * A no-op if no such supervisor is running (e.g. CI, or a plain build with no
 * live session attached) - this must never fail the build. It does SAY so,
 * though: a silent no-op is indistinguishable from a successful reload, so a
 * build that never reached the running server looks exactly like one that did,
 * and you debug stale code believing it is current.
 *
 * A supervisor recorded against this project directory but running another
 * install - the npx-installed package is the usual one - is named and left
 * alone. Rebuilding this tree cannot change the code it runs, and signalling
 * it restarts a session this build has nothing to do with.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ownSupervisorScript = join(repoRoot, 'build', 'mcp-supervisor.js');

// Mirrors resolveStateDir in src/helpers/paths.ts: `.cdp-tools` is the pre-0.9.0
// name, kept as a fallback for a checkout the server has not migrated yet.
const candidatePidFiles = ['.devharness', '.cdp-tools'].map(
  (dir) => join(process.cwd(), dir, 'mcp-supervisor.pid')
);
const note = (message) => console.error(`[signal-supervisor] ${message}`);
const RECONNECT_HINT = 'run /mcp in Claude Code to pick up this build';

// Mirrors parseSupervisorRecords in src/supervisor/pidfile.ts. A bare integer
// is the pre-multi-record format and carries no script.
function parseRecords(contents) {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return [];
  if (/^\d+$/.test(trimmed)) {
    const pid = parseInt(trimmed, 10);
    return pid > 0 ? [{ pid, script: null }] : [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed?.supervisors) ? parsed.supervisors : [];
    return entries
      .map((entry) => ({ pid: parseInt(entry?.pid, 10), script: typeof entry?.script === 'string' ? entry.script : null }))
      .filter((record) => Number.isInteger(record.pid) && record.pid > 0);
  } catch {
    return [];
  }
}

let records = null;
let pidFilePath;
for (const candidate of candidatePidFiles) {
  try {
    records = parseRecords(readFileSync(candidate, 'utf-8'));
    pidFilePath = candidate;
    break;
  } catch {
    // Try the next location
  }
}

/** Supervisors whose command line runs this checkout's build, from any directory. */
function runningThisBuild() {
  try {
    const listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8', timeout: 2000 });
    return listing.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || !match[2].split(/\s+/).includes(ownSupervisorScript)) return [];
      const pid = parseInt(match[1], 10);
      return pid === process.pid ? [] : [{ pid, script: ownSupervisorScript }];
    });
  } catch {
    return [];
  }
}

if (pidFilePath === undefined) records = [];

// A record with no script comes from a supervisor that predates this format;
// it is the only one recorded, so it is the one this build reaches.
const recorded = records.filter((record) => record.script === ownSupervisorScript || record.script === null);
const foreign = records.filter((record) => !recorded.includes(record));
const mine = [...recorded, ...runningThisBuild().filter((found) => !recorded.some((record) => record.pid === found.pid))];

for (const record of mine) {
  try {
    process.kill(record.pid, 'SIGUSR2');
    note(`Sent SIGUSR2 to mcp-supervisor (PID ${record.pid})`);
  } catch (err) {
    note(
      err?.code === 'ESRCH'
        ? `Supervisor PID ${record.pid} is no longer running - nothing to reload (${RECONNECT_HINT}).`
        : `Could not signal supervisor PID ${record.pid}: ${err?.message ?? err} (${RECONNECT_HINT}).`
    );
  }
}

if (mine.length === 0) {
  note(`No supervisor running ${ownSupervisorScript}${pidFilePath === undefined ? `, and no pidfile at ${candidatePidFiles.join(' or ')}` : ''} - this build reaches nothing (${RECONNECT_HINT}).`);
}

for (const record of foreign) {
  note(`Left PID ${record.pid} alone: it runs ${record.script}, which this build does not change.`);
}
