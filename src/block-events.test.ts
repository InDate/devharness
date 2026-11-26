/**
 * The session event stream is what a Claude Code Monitor tails, so a
 * notification storm is the failure mode that matters: guards re-fire on every
 * subsequent tool call, and a naive append would emit one line per blocked call
 * instead of one per block. These cover the dedupe, the clear-on-unblocked
 * reset, and that each guard attaches the info the line is built from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths } from './helpers/paths.js';
import {
  recordBlockEvent,
  clearBlockEvents,
  type BlockEventInfo,
} from './block-events.js';
import { getEventStreamPath } from './session-events.js';
import { resolveSessionName } from './session-identity.js';
import {
  checkPortFailures,
  checkPendingStartups,
  checkDuplicateSession,
} from './tool-response.js';
import type { PortFailureInfo, PendingStartupFailureInfo } from './server-manager.js';

let workDir: string;
let originalCwd: string;
let originalGlobalDir: string | undefined;

const portBlock: BlockEventInfo = {
  guard: 'port',
  key: '3000',
  detail: 'Monitored port(s) down: 3000 (web)',
  resolve: `server({ action: 'acknowledgePort', port: 3000 })`,
};

function lines(): Record<string, string>[] {
  const path = getEventStreamPath(resolveSessionName());
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'cdp-block-events-test-'));
  process.chdir(workDir);
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(workDir, 'global');
  initializePaths();
  clearBlockEvents();
});

afterEach(() => {
  clearBlockEvents();
  process.chdir(originalCwd);
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(workDir, { recursive: true, force: true });
});

describe('block event stream', () => {
  it('writes one line per block, not per blocked call', async () => {
    await recordBlockEvent(portBlock, 'navigate');
    await recordBlockEvent(portBlock, 'screenshot');
    await recordBlockEvent(portBlock, 'content');

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      kind: 'block',
      guard: 'port',
      tool: 'navigate',
      detail: 'Monitored port(s) down: 3000 (web)',
    });
  });

  it('logs the same block again after a call clears every guard', async () => {
    await recordBlockEvent(portBlock, 'navigate');
    clearBlockEvents();
    await recordBlockEvent(portBlock, 'navigate');

    expect(lines()).toHaveLength(2);
  });

  it('treats a different block as a new event while the first is still active', async () => {
    await recordBlockEvent(portBlock, 'navigate');
    await recordBlockEvent(
      { ...portBlock, key: '3000,5173', detail: 'Monitored port(s) down: 3000, 5173' },
      'navigate'
    );

    expect(lines()).toHaveLength(2);
  });

  it('separates guards that happen to share a key', async () => {
    await recordBlockEvent({ ...portBlock, guard: 'port', key: 'web' }, 'navigate');
    await recordBlockEvent({ ...portBlock, guard: 'pendingStartup', key: 'web' }, 'navigate');

    expect(lines().map(l => l.guard)).toEqual(['port', 'pendingStartup']);
  });

  it('does nothing when a guard supplies no block info', async () => {
    await recordBlockEvent(undefined, 'navigate');
    expect(lines()).toHaveLength(0);
  });
});

describe('guards attach block info', () => {
  it('port failure', () => {
    const failed: PortFailureInfo[] = [
      { port: 3000, level: 'block', failedAt: new Date('2026-01-01T00:00:00Z'), description: 'web' } as PortFailureInfo,
    ];
    const result = checkPortFailures(failed, 'navigate');
    expect(result.blocked).toBe(true);
    if (!result.blocked) return;
    expect(result.block?.guard).toBe('port');
    expect(result.block?.key).toBe('3000');
    expect(result.block?.resolve).toContain('acknowledgePort');
  });

  it('pending startup failure', () => {
    const failures: PendingStartupFailureInfo[] = [
      { serverId: 'web', reason: 'died', startedAt: new Date('2026-01-01T00:00:00Z') } as PendingStartupFailureInfo,
    ];
    const result = checkPendingStartups(failures, 'navigate');
    expect(result.blocked).toBe(true);
    if (!result.blocked) return;
    expect(result.block?.guard).toBe('pendingStartup');
    expect(result.block?.detail).toContain('died before port detected');
    expect(result.block?.resolve).toContain('acknowledgeStartup');
  });

  it('duplicate session, from both sides', () => {
    const base = {
      sessionId: 'abc-123',
      shortId: 'abc',
      allPids: [10, 20],
      allPpids: [100, 200],
    };

    const original = checkDuplicateSession({ ...base, currentPid: 10, currentPpid: 100 }, 'navigate');
    expect(original.blocked).toBe(true);
    if (original.blocked) {
      expect(original.block?.key).toBe('original:abc-123');
      expect(original.block?.resolve).toBe('kill 200');
    }

    const duplicate = checkDuplicateSession({ ...base, currentPid: 20, currentPpid: 200 }, 'navigate');
    expect(duplicate.blocked).toBe(true);
    if (duplicate.blocked) {
      expect(duplicate.block?.key).toBe('duplicate:abc-123');
      expect(duplicate.block?.resolve).toContain('--fork-session');
    }
  });
});
