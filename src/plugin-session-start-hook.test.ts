/**
 * Tests for the plugin's SessionStart hook.
 *
 * The script cannot import from this package - it runs before any devharness
 * server exists - so it re-derives the event stream path from the same rule.
 * The case that matters most is the one asserting the two agree: nothing else
 * would catch the convention changing on one side only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { initializePaths } from './helpers/paths.js';
import { getEventStreamPath } from './session-events.js';

const HOOK = join(process.cwd(), 'plugin', 'hooks', 'session-start.mjs');
const SESSION_ID = '2e9119bf-672e-4ad8-89c1-f44fcd1060d8';

let dir: string;
let previousDir: string | undefined;

/**
 * Run the hook the way Claude Code does: event JSON on stdin, and read back
 * the additionalContext it emits. Empty output means the hook declined to say
 * anything, which is its response to every input it must not act on.
 */
function runHook(input: string, env: Record<string, string> = {}): string {
  const raw = execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, DEVHARNESS_DIR: dir, ...env },
  });
  if (!raw.trim()) return '';
  return JSON.parse(raw).hookSpecificOutput.additionalContext;
}

/** A `devharness` on PATH that reports `version`, or one that reports nothing. */
function fakeCliOnPath(version: string | null): Record<string, string> {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = version === null ? 'echo not-a-version' : `echo ${version}`;
  writeFileSync(join(binDir, 'devharness'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(binDir, 'devharness'), 0o755);
  return { PATH: `${binDir}:${process.env.PATH}` };
}

/**
 * A PATH with node on it and nothing else, so the hook can run while finding
 * no `devharness`. Emptying PATH entirely would take node with it.
 */
const NO_CLI_PATH = { PATH: dirname(process.execPath) };

/** A plugin root whose .mcp.json pins `version`. */
function pluginRootPinning(version: string): Record<string, string> {
  const root = join(dir, 'plugin');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { devharness: { command: 'npx', args: ['-y', `devharness@${version}`] } },
  }));
  return { CLAUDE_PLUGIN_ROOT: root };
}

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-hook-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

describe('session-start hook', () => {
  it('names the same stream path the server writes to', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'SessionStart' }));
    expect(output).toContain(getEventStreamPath('2e9119bf'));
  });

  it('emits additionalContext, not bare stdout', () => {
    const raw = execFileSync('node', [HOOK], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      encoding: 'utf-8',
      env: { ...process.env, DEVHARNESS_DIR: dir },
    });
    expect(JSON.parse(raw).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  it('creates the file, so a watch has something to tail before the server starts', () => {
    runHook(JSON.stringify({ session_id: SESSION_ID }));
    expect(existsSync(getEventStreamPath('2e9119bf'))).toBe(true);
  });

  it('prints a background Bash call running devharness watch', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }));
    // A background task holds no deadline, so the call must carry
    // run_in_background; without it the watch blocks the turn.
    expect(output).toMatch(/Bash\(\{ command: "[^"]*devharness[^"]* watch --session=/);
    expect(output).toContain('run_in_background: true');
    expect(output).toContain('description: "devharness events"');
  });

  it('names the session on the watch, so it reads this stream with no session in its environment', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }));
    expect(output).toContain('watch --session=2e9119bf"');
  });

  it('prints the Monitor to a pin older than devharness watch, whose CLI would start a server instead', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }), pluginRootPinning('0.10.1'));
    expect(output).toContain('Monitor({ command: "tail -f -n0');
    expect(output).not.toContain('devharness watch');
  });

  it('runs the pinned version through npx when PATH holds another', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }), { ...pluginRootPinning('0.11.0'), ...fakeCliOnPath('0.10.1') });
    expect(output).toContain('npx -y devharness@0.11.0 watch --session=2e9119bf');
  });

  it('starts the cursor at the stream\'s end, so the first watch reads what lands after the session starts', () => {
    const stream = getEventStreamPath('2e9119bf');
    mkdirSync(dirname(stream), { recursive: true });
    writeFileSync(stream, '{"old":1}\n');
    runHook(JSON.stringify({ session_id: SESSION_ID }));
    expect(readFileSync(join(dirname(stream), '2e9119bf.cursor'), 'utf-8')).toBe(String('{"old":1}\n'.length));
  });

  it('honours DEVHARNESS_DIR, so a relocated state root is still found', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }));
    expect(output).toContain(join(dir, 'events', '2e9119bf.jsonl'));
  });
});

describe('session-start hook - inputs it must not act on', () => {
  it('says nothing for input that is not JSON', () => {
    expect(runHook('not json')).toBe('');
  });

  it('says nothing for empty input', () => {
    expect(runHook('')).toBe('');
  });

  it('says nothing when the event carries no session id', () => {
    expect(runHook(JSON.stringify({ hook_event_name: 'SessionStart' }))).toBe('');
  });

  it('writes nothing for an id that would escape the events directory', () => {
    expect(runHook(JSON.stringify({ session_id: '../../escape' }))).toBe('');
    expect(existsSync(join(dir, 'events'))).toBe(false);
  });

  it('writes nothing for an id that is not a string', () => {
    expect(runHook(JSON.stringify({ session_id: 42 }))).toBe('');
    expect(existsSync(join(dir, 'events'))).toBe(false);
  });
});

describe('session-start hook - what it leaves behind', () => {
  it('creates the stream and its cursor, both named for the session', () => {
    runHook(JSON.stringify({ session_id: SESSION_ID }));
    expect(readdirSync(join(dir, 'events')).sort()).toEqual(['2e9119bf.cursor', '2e9119bf.jsonl']);
  });
});

describe('session-start hook - recording the current conversation', () => {
  const SOCKET = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/61220.sock' };

  function recorded(): any {
    return JSON.parse(readFileSync(join(dir, 'clients', '61220.json'), 'utf-8'));
  }

  it('writes the conversation id where the server reads it', () => {
    runHook(JSON.stringify({ session_id: SESSION_ID }), SOCKET);
    expect(recorded().sessionId).toBe(SESSION_ID);
  });

  it('overwrites it when a clear brings a new conversation', () => {
    runHook(JSON.stringify({ session_id: SESSION_ID }), SOCKET);
    runHook(JSON.stringify({ session_id: 'bbbbbbbb-9999-0000-1111-222222222222' }), SOCKET);
    expect(recorded().sessionId).toBe('bbbbbbbb-9999-0000-1111-222222222222');
  });

  it('writes the record owner-only', () => {
    runHook(JSON.stringify({ session_id: SESSION_ID }), SOCKET);
    expect(statSync(join(dir, 'clients', '61220.json')).mode & 0o777).toBe(0o600);
  });

  it('still names the stream when no socket identifies the client', () => {
    const output = runHook(JSON.stringify({ session_id: SESSION_ID }), { CLAUDE_CODE_MESSAGING_SOCKET: '' });
    expect(output).toContain('2e9119bf.jsonl');
    expect(existsSync(join(dir, 'clients'))).toBe(false);
  });
});

describe('session-start hook - the CLI on PATH', () => {
  const payload = JSON.stringify({ session_id: SESSION_ID });

  it('says nothing about the CLI when the installed version matches the pin', () => {
    const output = runHook(payload, { ...pluginRootPinning('1.2.3'), ...fakeCliOnPath('1.2.3') });
    expect(output).not.toMatch(/npm i -g/);
    expect(output).not.toMatch(/not on PATH/);
  });

  it('reports a drift between the installed version and the pin', () => {
    const output = runHook(payload, { ...pluginRootPinning('1.2.3'), ...fakeCliOnPath('1.0.0') });
    expect(output).toContain('on PATH is 1.0.0');
    expect(output).toContain('pins 1.2.3');
    expect(output).toContain('npm i -g devharness@1.2.3');
  });

  it('reports a build too old to state its version', () => {
    const output = runHook(payload, { ...pluginRootPinning('1.2.3'), ...fakeCliOnPath(null) });
    expect(output).toContain('reports no version');
    expect(output).toContain('predates the 1.2.3');
  });

  it('offers both the npx form and the install when nothing is on PATH', () => {
    const output = runHook(payload, { ...pluginRootPinning('1.2.3'), ...NO_CLI_PATH });
    expect(output).toContain('not on PATH');
    expect(output).toContain('npx -y devharness@1.2.3');
    expect(output).toContain('npm i -g devharness@1.2.3');
  });

  it('leaves the version out of its advice when no plugin root names a pin', () => {
    const output = runHook(payload, { ...NO_CLI_PATH });
    expect(output).toContain('npm i -g devharness');
    expect(output).not.toMatch(/devharness@\d/);
  });

  it('never installs anything itself', () => {
    const output = runHook(payload, { ...pluginRootPinning('1.2.3'), ...NO_CLI_PATH });
    expect(output).toContain('do not run it unasked');
  });
});
