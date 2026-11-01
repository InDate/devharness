import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerClaimsStore } from './server-claims.js';
import { initializePaths } from './helpers/paths.js';

/**
 * Claims are written next to servers.json, which getOutputPath() resolves from
 * the working directory - so these run in a scratch cwd.
 */
let workDir: string;
let originalCwd: string;
let originalGlobalDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'cdp-claims-test-'));
  process.chdir(workDir);
  // Point the global scope at the scratch dir too - without this the
  // global-scope cases write claims into the developer's real ~/.devharness.
  originalGlobalDir = process.env.CDP_TOOLS_DIR;
  process.env.CDP_TOOLS_DIR = join(workDir, 'global');
  initializePaths();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalGlobalDir === undefined) delete process.env.CDP_TOOLS_DIR;
  else process.env.CDP_TOOLS_DIR = originalGlobalDir;
  initializePaths();
  rmSync(workDir, { recursive: true, force: true });
});

/** A store whose liveness and start times are entirely under the test's control. */
function makeStore(supervisorPid: number, live: Map<number, string>) {
  return new ServerClaimsStore({
    supervisorPid,
    isAlive: (pid) => live.has(pid),
    startTimeReader: (pid) => live.get(pid) ?? '',
  });
}

describe('ServerClaimsStore', () => {
  it('claims a server and sees its own claim as live', async () => {
    const live = new Map([[100, 'Mon Jan 1 00:00:00 2026']]);
    const store = makeStore(100, live);

    await store.claim('web', '/proj', false);

    const claims = store.readAll(false);
    expect(claims).toHaveLength(1);
    expect(claims[0].claim).toMatchObject({ serverId: 'web', supervisorPid: 100 });
    expect(store.isClaimLive(claims[0].claim)).toBe(true);
  });

  it('does not report its own claim as foreign', async () => {
    const live = new Map([[100, 'start-100']]);
    const store = makeStore(100, live);
    await store.claim('web', '/proj', false);

    expect(store.hasForeignLiveClaim('web', false)).toBe(false);
  });

  it('sees another live session as a foreign claim', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).claim('web', '/proj', false);

    expect(makeStore(100, live).hasForeignLiveClaim('web', false)).toBe(true);
  });

  it('ignores a foreign claim whose session has died', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).claim('web', '/proj', false);

    live.delete(200); // that session's supervisor is gone
    expect(makeStore(100, live).hasForeignLiveClaim('web', false)).toBe(false);
  });

  it('ignores a claim whose pid was reused by a different process', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).claim('web', '/proj', false);

    // Same pid, different process: alive, but not the one that claimed.
    live.set(200, 'start-200-RECYCLED');
    expect(makeStore(100, live).hasForeignLiveClaim('web', false)).toBe(false);
  });

  it('keeps a claim when start times cannot be read at all', async () => {
    // No start time available (a platform without ps): a claim that cannot be
    // disproved must count as live, since the cost of being wrong is stopping
    // a running server.
    const live = new Map([[200, '']]);
    await makeStore(200, live).claim('web', '/proj', false);

    expect(makeStore(100, new Map([[100, ''], [200, '']])).hasForeignLiveClaim('web', false)).toBe(true);
  });

  it('releases only its own claim', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    const mine = makeStore(100, live);
    await mine.claim('web', '/proj', false);
    await makeStore(200, live).claim('web', '/proj', false);

    mine.release('web', false);

    const remaining = mine.readAll(false);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].claim.supervisorPid).toBe(200);
  });

  it('releases every claim it holds across both scopes', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    const mine = makeStore(100, live);
    await mine.claim('web', '/proj', false);
    await mine.claim('api', '/proj', true);
    await makeStore(200, live).claim('web', '/proj', false);

    mine.releaseAllOwn();

    expect(mine.readAll(false).map((entry) => entry.claim.supervisorPid)).toEqual([200]);
    expect(mine.readAll(true)).toEqual([]);
  });

  it('collects dead claims and reports servers nobody is coming back for', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200'], [300, 'start-300']]);
    await makeStore(200, live).claim('abandoned', '/proj', false);
    await makeStore(300, live).claim('shared', '/proj', false);
    await makeStore(100, live).claim('shared', '/proj', false);

    live.delete(200); // the only claimant of 'abandoned' is gone
    live.delete(300); // one of two claimants of 'shared' is gone

    const store = makeStore(100, live);
    const { removed, unclaimedServerIds } = store.collectDeadClaims(false);

    expect(removed).toBe(2);
    expect(unclaimedServerIds).toEqual(['abandoned']);
    // The dead claims are gone from disk; the live one survives.
    expect(store.readAll(false).map((entry) => entry.claim.supervisorPid)).toEqual([100]);
  });

  it('survives a corrupt claim file without throwing', async () => {
    const live = new Map([[100, 'start-100']]);
    const store = makeStore(100, live);
    await store.claim('web', '/proj', false);

    const dir = join(workDir, '.devharness', 'server-claims');
    writeFileSync(join(dir, 'garbage.json'), '{ not json');

    expect(() => store.readAll(false)).not.toThrow();
    expect(store.readAll(false)).toHaveLength(1);
    expect(store.hasForeignLiveClaim('web', false)).toBe(false);
  });

  it('reports no claims when the directory does not exist', () => {
    const store = makeStore(100, new Map([[100, 'start-100']]));
    expect(store.readAll(false)).toEqual([]);
    expect(store.hasForeignLiveClaim('web', false)).toBe(false);
  });

  it('keeps a claim for a server id containing path separators', async () => {
    const live = new Map([[100, 'start-100']]);
    const store = makeStore(100, live);

    await store.claim('team/web', '/proj', false);

    // The id must not escape the claims directory.
    const dir = join(workDir, '.devharness', 'server-claims');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(store.hasForeignLiveClaim('team/web', false)).toBe(false);
    expect(store.readAll(false)[0].claim.serverId).toBe('team/web');
  });

  it('protects a server while another live session works in its directory', async () => {
    // The ordering that claims alone cannot cover: the other window was open
    // first, so it never claimed the server, but it is plainly still using the
    // project.
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).registerSession('/proj');

    const store = makeStore(100, live);
    expect(store.hasOtherLiveSessionIn('/proj')).toBe(true);
    expect(store.mayStop('web', '/proj', false)).toBe(false);
    // A different project is unaffected.
    expect(store.mayStop('web', '/other', false)).toBe(true);
  });

  it('ignores presence of a session that has died', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).registerSession('/proj');

    live.delete(200);
    expect(makeStore(100, live).mayStop('web', '/proj', false)).toBe(true);
  });

  it('ignores presence of a session whose pid was recycled', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).registerSession('/proj');

    live.set(200, 'start-200-RECYCLED');
    expect(makeStore(100, live).mayStop('web', '/proj', false)).toBe(true);
  });

  it('does not count its own presence against itself', async () => {
    const live = new Map([[100, 'start-100']]);
    const store = makeStore(100, live);
    await store.registerSession('/proj');

    expect(store.hasOtherLiveSessionIn('/proj')).toBe(false);
    expect(store.mayStop('web', '/proj', false)).toBe(true);
  });

  it('collects presence records of dead sessions', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200'], [300, 'start-300']]);
    await makeStore(200, live).registerSession('/proj');
    await makeStore(300, live).registerSession('/proj');
    live.delete(300);

    const store = makeStore(100, live);
    expect(store.collectDeadSessions()).toBe(1);
    expect(store.readSessions().map((entry) => entry.presence.supervisorPid)).toEqual([200]);
  });

  it('withdraws its own presence on request', async () => {
    const live = new Map([[100, 'start-100']]);
    const store = makeStore(100, live);
    await store.registerSession('/proj');
    store.unregisterSession();

    expect(makeStore(200, new Map([[100, 'start-100'], [200, 'start-200']])).hasOtherLiveSessionIn('/proj')).toBe(false);
  });

  it('keeps local and global claims apart', async () => {
    const live = new Map([[100, 'start-100'], [200, 'start-200']]);
    await makeStore(200, live).claim('web', '/proj', true);

    const store = makeStore(100, live);
    expect(store.hasForeignLiveClaim('web', false)).toBe(false);
    expect(store.hasForeignLiveClaim('web', true)).toBe(true);
  });
});
