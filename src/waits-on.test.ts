import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import { __resetForTests as resetMatrices, getMatrixDir, setCell, type MatrixFile } from './matrix-store.js';
import { __resetForTests as resetIssues, addIssue, updateIssueFields, updateIssueStatus } from './issue-tracker.js';
import {
  checkIssueNeeds,
  checkMatrixNeeds,
  evaluateNeed,
  loadWorld,
  nextReadyCell,
  parseNeed,
  readyIssues,
} from './waits-on.js';

const APP: MatrixFile = {
  capabilities: [
    { id: 'login', default: { today: 'gap' } },
    { id: 'profile', default: { today: 'gap', needs: ['/login'] } },
  ],
  scenarios: [
    { id: 'web' },
    { id: 'mobile', needs: ['api#/auth'] },
  ],
};

const API: MatrixFile = {
  capabilities: [{ id: 'auth', default: { today: 'gap' } }, { id: 'billing', default: { today: 'n/a' } }],
  scenarios: [{ id: 'prod' }],
};

let tempDir: string;

async function store(name: string, matrix: MatrixFile): Promise<void> {
  await fsp.mkdir(getMatrixDir(), { recursive: true });
  await fsp.writeFile(join(getMatrixDir(), `${name}.json`), JSON.stringify(matrix, null, 2) + '\n');
}

const feature = (title: string, fields: { matrix?: string[]; needs?: string[] } = {}) =>
  addIssue({ type: 'feature', title, initialStatus: 'acknowledged', ...fields });

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-waits-on-test-'));
  setWorkingDirOverride(tempDir);
  resetMatrices();
  resetIssues();
});

afterEach(async () => {
  resetMatrices();
  resetIssues();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('parseNeed', () => {
  const at = { matrix: 'app', scenario: 'mobile', capability: 'profile' };

  it('reads an issue, a matrix area, and the two short forms against the cell', () => {
    expect(parseNeed('#12')).toEqual({ kind: 'issue', id: 12 });
    expect(parseNeed('api#/auth')).toEqual({ kind: 'area', ref: { matrix: 'api', capability: 'auth' } });
    expect(parseNeed('/login', at)).toEqual({ kind: 'area', ref: { matrix: 'app', scenario: 'mobile', capability: 'login' } });
    expect(parseNeed('web/', at)).toEqual({ kind: 'area', ref: { matrix: 'app', scenario: 'web', capability: 'profile' } });
  });

  it('reads a short form with no cell to resolve against as relative, and anything else as malformed', () => {
    expect(parseNeed('/login')).toEqual({ kind: 'bad', problem: 'relative' });
    expect(parseNeed('#0')).toEqual({ kind: 'bad', problem: 'malformed' });
    expect(parseNeed('login')).toEqual({ kind: 'bad', problem: 'malformed' });
  });
});

describe('evaluateNeed', () => {
  it('meets a column once every cell works or reads n/a, and reports a need on one n/a cell', async () => {
    await store('api', { ...API, scenarios: [{ id: 'prod' }, { id: 'staging', cells: { billing: { today: 'works' } } }] });
    const world = await loadWorld();
    expect(evaluateNeed(world, 'api#/billing')).toMatchObject({ met: true });
    expect(evaluateNeed(world, 'api#prod/billing')).toMatchObject({ met: false, problem: 'na-target' });
    expect(evaluateNeed(world, 'api#prod')).toMatchObject({ met: false, open: ['api#prod/auth'] });
  });

  it('leaves a need on a matrix the store lacks unmet, with its problem', async () => {
    await store('app', APP);
    expect(evaluateNeed(await loadWorld(), 'design#tokens')).toMatchObject({ target: 'design#tokens', met: false, problem: 'matrix-missing' });
  });

  it('meets an issue need once the issue is completed', async () => {
    const issue = await feature('api auth');
    expect(evaluateNeed(await loadWorld(), `#${issue.id}`)).toMatchObject({ met: false });
    await updateIssueStatus(issue.id, 'implemented');
    expect(evaluateNeed(await loadWorld(), `#${issue.id}`)).toMatchObject({ met: true });
    expect(evaluateNeed(await loadWorld(), '#99')).toMatchObject({ met: false, problem: 'issue-missing' });
  });
});

describe('nextReadyCell', () => {
  it('skips a cell whose needs are unmet and names where its chain ends', async () => {
    await store('app', APP);
    await store('api', API);
    const first = await nextReadyCell('app');
    expect(first.next?.ref).toBe('app#web/login');
    expect(first.remaining).toEqual({ gap: 4, unmeasured: 0, blocked: 3 });
    expect(first.waiting).toMatchObject({
      ref: 'app#web/profile',
      unmet: [{ ref: '/login', target: 'app#web/login', met: false }],
      ends: [{ ref: 'app#web/login', kind: 'cell', today: 'gap' }],
    });

    await setCell('app', 'web', 'login', { today: 'works' });
    expect((await nextReadyCell('app')).next?.ref).toBe('app#web/profile');
  });

  it('follows a chain into another matrix, so the whole store hands out the other matrix first', async () => {
    await store('app', { ...APP, scenarios: [{ id: 'mobile', needs: ['api#/auth'] }] });
    await store('api', API);
    const named = await nextReadyCell('app');
    expect(named.next).toBeUndefined();
    expect(named.waiting?.ends).toEqual([{ ref: 'api#prod/auth', kind: 'cell', today: 'gap' }]);
    expect((await nextReadyCell()).next?.ref).toBe('api#prod/auth');
  });

  it('holds a cell waiting on a matrix not in the store yet, and names that matrix as the end', async () => {
    await store('app', { capabilities: [{ id: 'sync', default: { today: 'gap', needs: ['design#/tokens'] } }], scenarios: [{ id: 'mobile' }] });
    const result = await nextReadyCell();
    expect(result.next).toBeUndefined();
    expect(result.waiting?.ends).toEqual([{ ref: 'design#/tokens', kind: 'problem', problem: 'matrix-missing' }]);
  });
});

describe('checkMatrixNeeds', () => {
  it('refuses a need naming a capability the matrix lacks, with the valid ids', async () => {
    await store('api', API);
    const refusal = await checkMatrixNeeds('app', { ...APP, scenarios: [{ id: 'mobile', needs: ['api#/search'] }] });
    expect(refusal).toEqual({ kind: 'need', at: 'app#mobile/login', ref: 'api#/search', problem: 'capability-missing', valid: ['auth', 'billing'] });
  });

  it('writes a need on a matrix the store lacks', async () => {
    expect(await checkMatrixNeeds('app', APP)).toBeUndefined();
  });

  it('refuses a loop of waits, naming each cell along it', async () => {
    const looped: MatrixFile = { capabilities: [{ id: 'a', default: { needs: ['/b'] } }, { id: 'b', default: { needs: ['/a'] } }], scenarios: [{ id: 'r' }] };
    expect(await checkMatrixNeeds('m', looped)).toEqual({ kind: 'cycle', path: ['m#r/a', 'm#r/b', 'm#r/a'] });
  });
});

describe('issues and cells together', () => {
  it('holds an issue linked to a cell until that cell\'s needs are met', async () => {
    await store('app', APP);
    const profile = await feature('profile on web', { matrix: ['app#web/profile'] });
    expect((await readyIssues()).map(issue => issue.id)).not.toContain(profile.id);
    await setCell('app', 'web', 'login', { today: 'works' });
    expect((await readyIssues()).map(issue => issue.id)).toContain(profile.id);
  });

  it('holds an issue on its own matrix need, and a cell on an issue', async () => {
    const waiting = await feature('api docs', { needs: ['api#prod/auth'] });
    const fix = await feature('auth crash');
    await store('api', API);
    await store('app', { capabilities: [{ id: 'sync', default: { today: 'gap', needs: [`#${fix.id}`] } }], scenarios: [{ id: 'mobile' }] });
    expect((await readyIssues()).map(issue => issue.id)).not.toContain(waiting.id);
    expect((await nextReadyCell('app')).waiting?.ends).toEqual([{ ref: `#${fix.id}`, kind: 'issue', status: 'acknowledged' }]);
  });

  it('refuses an issue edit that closes a loop through a cell', async () => {
    const issue = await feature('sync on mobile');
    await store('app', {
      capabilities: [{ id: 'sync', default: { today: 'gap' } }, { id: 'history', default: { today: 'gap', needs: [`#${issue.id}`] } }],
      scenarios: [{ id: 'mobile' }],
    });
    expect(await checkIssueNeeds({ ...issue, needs: ['app#mobile/history'] })).toEqual({
      kind: 'cycle', path: [`#${issue.id}`, 'app#mobile/history', `#${issue.id}`],
    });
    await updateIssueFields(issue.id, { matrix: ['app#mobile/history'] });
    expect(await checkIssueNeeds({ ...issue, matrix: ['app#mobile/history'] })).toBeUndefined();
  });

  it('refuses a short form on an issue, which has no cell to resolve it against', async () => {
    expect(await checkIssueNeeds({ needs: ['/login'] })).toMatchObject({ kind: 'need', problem: 'relative' });
  });
});
