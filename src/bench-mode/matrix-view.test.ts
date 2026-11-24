import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { __resetForTests as resetIssues, addIssue, updateIssueFields } from '../issue-tracker.js';
import { __resetForTests as resetMatrices, getMatrixDir, setCell, type MatrixFile } from '../matrix-store.js';
import { matrixActivity, matrixList, matrixRead, matrixSetStanding, placeMatrixRefs } from './matrix-view.js';

const SAMPLE: MatrixFile = {
  about: 'the bench reads this',
  layers: [{ field: 'mechanism', table: 'mechanisms' }],
  capabilities: [
    { id: 'seen', name: 'Seen', question: 'Is the motion registered?', default: { today: 'works' } },
    { id: 'credit', name: 'Credit', default: { today: 'gap' } },
  ],
  mechanisms: { css: { name: 'CSS keyframes', credit: { expect: 'the press step' } } },
  scenarios: [
    { id: 'badge', name: 'Badge', mechanism: 'css', fault: 'dips for one frame' },
    { id: 'toast', name: 'Toast', mechanism: 'css' },
  ],
};

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-matrix-view-test-'));
  setWorkingDirOverride(tempDir);
  resetIssues();
  resetMatrices();
  await fsp.mkdir(getMatrixDir(), { recursive: true });
  await fsp.writeFile(join(getMatrixDir(), 'sample.json'), JSON.stringify(SAMPLE, null, 2) + '\n');
});

afterEach(async () => {
  resetIssues();
  resetMatrices();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

const viewOf = async (name?: string) => {
  const read = await matrixRead(name);
  if (!('view' in read)) throw new Error(`no view: ${JSON.stringify(read)}`);
  return read.view;
};

describe('the Matrix tab reads', () => {
  it('lists each matrix with its counts per standing', async () => {
    expect(await matrixList()).toMatchObject([{ name: 'sample', about: 'the bench reads this', scenarios: 2, capabilities: 2, cells: { works: 2, gap: 2, unmeasured: 0, 'n/a': 0 } }]);
  });

  it('resolves every cell with the layer each value came from, and names each layer key', async () => {
    const view = await viewOf('sample');
    expect(view.layers).toEqual([{ field: 'mechanism', table: 'mechanisms', names: { css: 'CSS keyframes' } }]);
    expect(view.cells.badge.credit).toMatchObject({ today: 'gap', expect: 'the press step', from: { today: 'capability', expect: 'mechanisms.css' } });
    expect(view.scenarios[0].fields).toMatchObject({ mechanism: 'css', fault: 'dips for one frame' });
    expect(view.capabilities[0]).toMatchObject({ id: 'seen', name: 'Seen', question: 'Is the motion registered?' });
  });

  it('answers a missing name with the names the store holds', async () => {
    expect(await matrixRead('nope')).toEqual({ missing: 'nope', valid: ['sample'] });
  });

  it('answers a file that does not parse with its problem', async () => {
    await fsp.writeFile(join(getMatrixDir(), 'broken.json'), '{ not json');
    resetMatrices();
    expect(await matrixRead('broken')).toMatchObject({ broken: 'broken' });
  });

  it('shows a cell written through the store on the next read', async () => {
    expect((await viewOf('sample')).cells.toast.credit.today).toBe('gap');
    await setCell('sample', 'toast', 'credit', { today: 'works' });
    expect((await viewOf('sample')).cells.toast.credit.today).toBe('works');
  });

  it('carries the issues linked into the matrix with the area each ref names, completed ones marked closed', async () => {
    const open = await addIssue({ type: 'bug', title: 'on a cell and a row', matrix: ['sample#badge/credit', 'sample#toast'] });
    const done = await addIssue({ type: 'feature', title: 'on a column', matrix: ['sample#/seen'] });
    await updateIssueFields(done.id, { status: 'implemented' });

    const { issues } = await viewOf('sample');
    expect(issues.find(each => each.id === open.id)).toMatchObject({
      type: 'bug', closed: false,
      refs: [{ scenario: 'badge', capability: 'credit' }, { scenario: 'toast' }],
    });
    expect(issues.find(each => each.id === done.id)).toMatchObject({ type: 'feature', closed: true, refs: [{ capability: 'seen' }] });
  });
});

describe('placeMatrixRefs', () => {
  it('places a ref the store holds and leaves a dead or malformed one with no place', async () => {
    expect(await placeMatrixRefs(['sample#badge/seen', 'sample#toast', 'sample#/credit', 'sample#nope', 'gone#badge', 'not a ref'])).toEqual([
      { ref: 'sample#badge/seen', at: { matrix: 'sample', scenario: 'badge', capability: 'seen' } },
      { ref: 'sample#toast', at: { matrix: 'sample', scenario: 'toast' } },
      { ref: 'sample#/credit', at: { matrix: 'sample', capability: 'credit' } },
      { ref: 'sample#nope' },
      { ref: 'gone#badge' },
      { ref: 'not a ref' },
    ]);
  });
});

describe('a standing pressed in the bench', () => {
  it('writes the cell, returns the standing it replaced, and logs the change as the bench\'s', async () => {
    expect(await matrixSetStanding('sample', 'badge', 'credit', 'n/a')).toEqual({ previous: 'gap' });
    expect((await viewOf('sample')).cells.badge.credit.today).toBe('n/a');
    expect(await matrixActivity('sample')).toMatchObject([
      { by: 'bench', cause: 'edit', changes: [{ scenario: 'badge', capability: 'credit', field: 'today', from: 'gap', to: 'n/a' }] },
    ]);
  });

  it('refuses a value that is no standing and an id the matrix lacks, writing nothing', async () => {
    expect((await matrixSetStanding('sample', 'badge', 'credit', 'broken')).failure).toBeTypeOf('string');
    expect((await matrixSetStanding('sample', 'nope', 'credit', 'works')).failure).toBeTypeOf('string');
    expect((await matrixSetStanding('gone', 'badge', 'credit', 'works')).failure).toBeTypeOf('string');
    expect(await matrixActivity('sample')).toEqual([]);
  });

  it('returns no activity for a name that is no matrix name', async () => {
    expect(await matrixActivity('../outside')).toEqual([]);
  });
});
