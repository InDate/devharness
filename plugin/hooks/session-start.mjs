#!/usr/bin/env node
/**
 * SessionStart hook: name this session's event stream, and report whether the
 * `devharness` CLI on PATH matches the version this plugin pins.
 *
 * Runs before any devharness server exists, so it imports nothing from the
 * package and resolves the stream path by the same rule
 * `src/session-events.ts` uses: `<DEVHARNESS_DIR or ~/.devharness>/events/<first
 * 8 of the session id>.jsonl`. Changing that rule means changing it here too.
 *
 * The output is `additionalContext`, which the agent reads before its first
 * turn. Nothing here installs or verifies anything: a session that ignores the
 * watch receives no events, and a missing CLI is reported for the agent to
 * offer, never installed behind the user. Every failure path exits 0 in
 * silence - a hook that reports its own problems on every session start costs
 * more than the nudge is worth.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, basename } from 'path';

/** Ids become filenames; anything else is left alone rather than sanitised. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // No input at all (a hook run by hand) resolves empty rather than hanging.
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

/** The global state root, matching getGlobalBase() in src/helpers/paths.ts. */
function globalBase() {
  if (process.env.DEVHARNESS_DIR) return process.env.DEVHARNESS_DIR;
  if (process.env.CDP_TOOLS_DIR) return process.env.CDP_TOOLS_DIR;
  const current = join(homedir(), '.devharness');
  const legacy = join(homedir(), '.cdp-tools');
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

/**
 * The Claude process this hook was spawned by, from the messaging socket's
 * filename. The server derives the same pid the same way, which is what lets
 * the two agree on a name.
 */
function clientPid() {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!socket) return null;
  const pid = Number(basename(socket).replace(/\.sock$/, ''));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Record the conversation this client is on now.
 *
 * The server reads `CLAUDE_CODE_SESSION_ID` once, when it is spawned, and
 * `/clear` gives the conversation a new id without restarting it. This hook
 * runs on every start reason including `clear`, so this file is what carries
 * the change across to a process whose environment cannot.
 */
function recordCurrentSession(sessionId) {
  const pid = clientPid();
  if (pid === null) return;
  const dir = join(globalBase(), 'clients');
  const path = join(dir, `${pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ sessionId, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // The nudge below is still worth printing without it.
  }
}

/** The version this plugin's server runs, read from the pin in its .mcp.json. */
function pinnedVersion() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  try {
    const raw = readFileSync(join(root, '.mcp.json'), 'utf-8');
    return raw.match(/devharness@([0-9][^"'\s]*)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The version of any `devharness` on PATH.
 *
 * `null` means no command; `'unreported'` means one exists but printed no
 * version, which is every build older than the flag - stdin is closed and the
 * call is bounded so such a build starts a server, finds no client and exits
 * instead of holding up the session.
 */
function installedVersion() {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v devharness'], { stdio: 'ignore', timeout: 2000 });
  } catch {
    return null;
  }
  try {
    const out = execFileSync('devharness', ['--version'], {
      input: '',
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.match(/^\s*(\d+\.\d+\.\d+[^\s]*)\s*$/m)?.[1] ?? 'unreported';
  } catch {
    return 'unreported';
  }
}

/** One line about the CLI, or nothing when it is present and matches. */
function cliLine() {
  const pinned = pinnedVersion();
  const installed = installedVersion();

  if (installed === null) {
    const install = pinned ? `npm i -g devharness@${pinned}` : 'npm i -g devharness';
    const run = pinned ? `npx -y devharness@${pinned} <command>` : 'npx -y devharness <command>';
    return `The devharness CLI is not on PATH, so \`devharness <command>\` will not resolve. ${run} works without installing anything; \`${install}\` adds the short form. Offer the install, do not run it unasked.`;
  }
  if (installed === 'unreported') {
    return `A devharness on PATH reports no version, so it predates${pinned ? ` the ${pinned} this plugin pins` : ' this plugin'}. Its CLI commands may not exist.`;
  }
  if (pinned && installed !== pinned) {
    return `The devharness on PATH is ${installed}; this plugin pins ${pinned}. \`npm i -g devharness@${pinned}\` lines them up. Offer it, do not run it unasked.`;
  }
  return null;
}

const raw = await readStdin();
if (!raw.trim()) process.exit(0);

let sessionId;
try {
  sessionId = JSON.parse(raw).session_id;
} catch {
  process.exit(0);
}
if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) process.exit(0);

recordCurrentSession(sessionId);

const eventsDir = join(globalBase(), 'events');
const streamPath = join(eventsDir, `${sessionId.slice(0, 8)}.jsonl`);

// Created now so the watch has a file to tail before the server writes to it.
try {
  mkdirSync(eventsDir, { recursive: true });
  appendFileSync(streamPath, '');
} catch {
  process.exit(0);
}

const lines = [
  `devharness event stream for this session: ${streamPath}`,
  `Guard blocks - a dev server that died, a paused breakpoint, a pending bug - messages from other devharness sessions, and the notes, screenshots and sequence writes a person makes in the bench are appended there as they happen. With no watch each one reaches you only on your next devharness call, after the moment it was about. Arm this watch as your first tool call of the session, before answering, and re-arm it on its expiry notice:`,
  `Monitor({ command: "mkdir -p ${eventsDir} && touch ${streamPath} && tail -f -n0 ${streamPath}", description: "devharness events", persistent: true, timeout_ms: 3600000 })`,
];

const cli = cliLine();
if (cli) lines.push(cli);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: lines.join('\n\n'),
  },
}) + '\n');
