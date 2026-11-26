/**
 * The matrix tool and the issue links onto it: what each action carries in
 * `_meta`, the refusals by `_errorId`, and the links an issue holds onto
 * cells, rows and columns, read from both tools.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { __resetForTests as resetIssues, getIssue, getIssues, issuesLinkedTo, updateIssueFields } from '../issue-tracker.js';
import { __resetForTests as resetMatrices, getMatrixDir, type MatrixFile } from '../matrix-store.js';
import { createIssuesTools } from './issues-tools.js';
import { createMatrixTools } from './matrix-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

vi.mock('../interaction-recorder.js', () => ({
  showTestReadyOverlay: vi.fn(),
  showVerificationOverlay: vi.fn(),
}));

const SAMPLE: MatrixFile = {
  layers: [{ field: 'mechanism', table: 'mechanisms' }],
  capabilities: [
    { id: 'seen', name: 'Seen', question: 'Is the motion registered?', default: { today: 'works' } },
    { id: 'credit', name: 'Credit', default: { today: 'gap', basis: 'code' } },
  ],
  mechanisms: { css: { name: 'CSS', credit: { expect: 'the press step' } } },
  scenarios: [
    { id: 'badge', name: 'Badge', mechanism: 'css' },
    { id: 'toast', name: 'Toast', mechanism: 'css', cells: { credit: { today: 'unmeasured' } } },
  ],
};

let tempDir: string;
const { matrix } = createMatrixTools();
const { issues } = createIssuesTools(vi.fn(productionShaped(async () => ({ content: [{ type: 'text', text: '' }] }))));

const call = async (args: Record<string, unknown>) => (await matrix.handler(args as never)) as any;
const issue = async (args: Record<string, unknown>) => (await issues.handler(args as never)) as any;
const newIssue = async (type: 'bug' | 'feature', title: string, refs?: string[]) => {
  const made = await issue({ action: 'create', type, title, includeSequence: false, ...(refs && { matrix: refs }) });
  expect(made.isError, made.content?.[0]?.text).toBeUndefined();
  return Math.max(...(await getIssues({ includeCompleted: true })).map(each => each.id));
};

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-matrix-tools-test-'));
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

describe('matrix tool', () => {
  it('lists the store with each matrix and its counts', async () => {
    const listed = await call({ action: 'list' });
    expect(listed._meta.matrix.matrices).toMatchObject([{ name: 'sample', scenarios: 2, capabilities: 2, cells: { works: 2, gap: 1, unmeasured: 1, 'n/a': 0 } }]);
  });

  it('reads a whole matrix as capability ids by standing per scenario', async () => {
    const read = await call({ action: 'read' });
    expect(read._meta.matrix.name).toBe('sample');
    expect(read._meta.matrix.rows.map((row: any) => [row.scenario, row.standings])).toEqual([
      ['badge', { works: ['seen'], gap: ['credit'] }],
      ['toast', { works: ['seen'], unmeasured: ['credit'] }],
    ]);
  });

  it('reads one scenario and one capability as resolved cells, and filters on today', async () => {
    const row = await call({ action: 'read', scenario: 'toast' });
    expect(row._meta.matrix.cells.map((cell: any) => [cell.capability, cell.today, cell.expect])).toEqual([
      ['seen', 'works', undefined],
      ['credit', 'unmeasured', 'the press step'],
    ]);
    const gaps = await call({ action: 'read', capability: 'credit', today: 'gap' });
    expect(gaps._meta.matrix.cells.map((cell: any) => cell.scenario)).toEqual(['badge']);
  });

  it('edits one cell and returns it before and after', async () => {
    const edited = await call({ action: 'edit', scenario: 'badge', capability: 'credit', today: 'works', basis: 'sequence:credit-check' });
    expect(edited._meta.matrix.previous).toMatchObject({ today: 'gap', basis: 'code' });
    expect(edited._meta.matrix.cell).toMatchObject({ today: 'works', basis: 'sequence:credit-check' });
  });

  it('refuses an edit naming an unknown id or standing, or changing nothing', async () => {
    expect((await call({ action: 'edit', scenario: 'nope', capability: 'credit', today: 'works' }))._errorId).toBe('MATRIX_UNKNOWN_ID');
    expect((await call({ action: 'edit', scenario: 'badge', capability: 'credit', today: 'broken' }))._errorId).toBe('MATRIX_UNKNOWN_ID');
    expect((await call({ action: 'edit', scenario: 'badge', capability: 'credit' }))._errorId).toBe('MATRIX_EDIT_EMPTY');
    expect((await call({ action: 'read', matrix: 'nope' }))._errorId).toBe('MATRIX_NOT_FOUND');
  });

  it('hands over the first gap, then reports none once every cell is measured', async () => {
    expect((await call({ action: 'next' }))._meta.matrix.next).toMatchObject({ ref: 'sample#badge/credit', remaining: { gap: 1, unmeasured: 1 } });
    await call({ action: 'edit', scenario: 'badge', capability: 'credit', today: 'works' });
    await call({ action: 'edit', scenario: 'toast', capability: 'credit', today: 'n/a' });
    expect((await call({ action: 'next' }))._meta.matrix.next).toBeNull();
  });

  it('lists the changes to a matrix newest first, as session edits', async () => {
    await call({ action: 'edit', scenario: 'badge', capability: 'credit', today: 'works' });
    await call({ action: 'edit', scenario: 'toast', capability: 'credit', note: 'waits on a recording' });
    const activity = (await call({ action: 'activity' }))._meta.matrix.activity;
    expect(activity.map((entry: any) => [entry.by, entry.changes[0].field, entry.changes[0].to])).toEqual([
      ['session', 'note', 'waits on a recording'],
      ['session', 'today', 'works'],
    ]);
    expect((await call({ action: 'activity', limit: 1 }))._meta.matrix.activity).toHaveLength(1);
  });
});

describe('issue links onto a matrix', () => {
  it('keeps a cell, a row and a column ref on the issue file across a reload', async () => {
    const id = await newIssue('bug', 'credit lands on the wrong step', ['sample#badge/credit', 'sample#toast', 'sample#/seen']);
    resetIssues();
    expect((await getIssue(id))!.matrix).toEqual(['sample#badge/credit', 'sample#toast', 'sample#/seen']);
    const file = (await fsp.readdir(join(tempDir, '.devharness', 'issues', 'items'))).find(name => name.endsWith('.md'))!;
    expect(await fsp.readFile(join(tempDir, '.devharness', 'issues', 'items', file), 'utf-8')).toContain('matrix: ["sample#badge/credit", "sample#toast", "sample#/seen"]');
  });

  it('writes no matrix key for an issue with no link', async () => {
    await newIssue('bug', 'unlinked');
    const dir = join(tempDir, '.devharness', 'issues', 'items');
    const file = (await fsp.readdir(dir)).find(name => name.endsWith('.md'))!;
    expect(await fsp.readFile(join(dir, file), 'utf-8')).not.toMatch(/^matrix:/m);
  });

  it('adds and removes single links, and replaces the list on matrix', async () => {
    const id = await newIssue('feature', 'slow every mechanism', ['sample#badge']);
    await issue({ action: 'edit', id, matrixAdd: ['sample#/credit'] });
    expect((await getIssue(id))!.matrix).toEqual(['sample#badge', 'sample#/credit']);
    await issue({ action: 'edit', id, matrixRemove: ['sample#badge'] });
    expect((await getIssue(id))!.matrix).toEqual(['sample#/credit']);
    await issue({ action: 'edit', id, matrix: ['sample#toast/seen'] });
    expect((await getIssue(id))!.matrix).toEqual(['sample#toast/seen']);
  });

  it('refuses a malformed ref and a ref naming a matrix, scenario or capability the store lacks', async () => {
    const id = await newIssue('bug', 'target');
    expect((await issue({ action: 'edit', id, matrixAdd: ['sample'] }))._errorId).toBe('ISSUES_MATRIX_REF_INVALID');
    for (const ref of ['nope#badge', 'sample#nope', 'sample#badge/nope']) {
      expect((await issue({ action: 'edit', id, matrixAdd: [ref] }))._errorId, ref).toBe('ISSUES_MATRIX_REF_MISSING');
    }
    expect((await getIssue(id))!.matrix).toEqual([]);
  });

  it('lists and removes a link left dangling by a later matrix change', async () => {
    const id = await newIssue('bug', 'outlives its row', ['sample#toast']);
    const without = structuredClone(SAMPLE);
    without.scenarios = without.scenarios.filter(scenario => scenario.id !== 'toast');
    await fsp.writeFile(join(getMatrixDir(), 'sample.json'), JSON.stringify(without));
    resetMatrices();

    expect((await issuesLinkedTo('sample')).map(link => [link.issue.id, link.refs])).toEqual([[id, ['sample#toast']]]);
    const removed = await issue({ action: 'edit', id, matrixRemove: ['sample#toast'] });
    expect(removed.isError).toBeUndefined();
    expect((await getIssue(id))!.matrix).toEqual([]);
  });

  it('filters the issue list on a matrix name and on a cell, which its row and column links also reach', async () => {
    const onCell = await newIssue('bug', 'on the cell', ['sample#badge/credit']);
    const onRow = await newIssue('bug', 'on the row', ['sample#badge']);
    const onColumn = await newIssue('feature', 'on the column', ['sample#/credit']);
    const elsewhere = await newIssue('bug', 'on another cell', ['sample#toast/seen']);
    await newIssue('bug', 'unlinked');

    const ids = async (filter: string) => (await getIssues({ matrix: filter })).map(each => each.id).sort();
    expect(await ids('sample')).toEqual([onCell, onRow, onColumn, elsewhere].sort());
    expect(await ids('sample#badge/credit')).toEqual([onCell, onRow, onColumn].sort());
    expect(await ids('sample#badge')).toEqual([onCell, onRow].sort());
    expect((await issue({ action: 'list', matrix: 'not a ref' }))._errorId).toBe('ISSUES_MATRIX_FILTER_INVALID');
  });

  it('carries each cell\'s issues on a matrix read, by cell, row and column link, completed ones marked', async () => {
    const onCell = await newIssue('bug', 'on the cell', ['sample#badge/credit']);
    const onRow = await newIssue('feature', 'on the row', ['sample#badge']);
    const onColumn = await newIssue('bug', 'on the column', ['sample#/credit']);
    await updateIssueFields(onColumn, { status: 'fixed' });

    const read = await call({ action: 'read', scenario: 'badge', capability: 'credit' });
    const links = read._meta.matrix.cellIssues[0].issues.map((link: any) => [link.id, link.link, link.completed]);
    expect(links.sort()).toEqual([[onCell, 'cell', false], [onRow, 'row', false], [onColumn, 'column', true]].sort());

    const whole = await call({ action: 'read' });
    expect(whole._meta.matrix.rows.find((row: any) => row.scenario === 'badge').openIssues).toBe(2);
    expect(whole._meta.matrix.columnIssues.map((link: any) => link.id)).toEqual([onColumn]);

    const bare = await call({ action: 'read', scenario: 'badge', issues: false });
    expect(bare._meta.matrix.cellIssues).toBeUndefined();

    expect((await call({ action: 'next' }))._meta.matrix.next.issues.map((link: any) => link.id).sort()).toEqual([onCell, onRow, onColumn].sort());
  });

  it('writes a cell\'s needs, refusing a need naming no capability and a loop, and keeping one on a matrix not in the store', async () => {
    expect((await call({ action: 'edit', scenario: 'toast', capability: 'credit', needs: ['/nope'] }))._errorId).toBe('NEEDS_REFUSED');
    expect((await call({ action: 'edit', scenario: 'toast', capability: 'credit', needs: ['/credit'] }))._errorId).toBe('NEEDS_CYCLE');
    const written = await call({ action: 'edit', scenario: 'toast', capability: 'credit', needs: ['tools#/probe'] });
    expect(written.isError).toBeUndefined();
    const read = await call({ action: 'read', scenario: 'toast', capability: 'credit' });
    expect(read._meta.matrix.cellNeeds).toMatchObject([{ needs: [{ ref: 'tools#/probe', met: false, problem: 'matrix-missing' }] }]);
    expect((await call({ action: 'read' }))._meta.matrix.needProblems.needs).toMatchObject([{ cell: 'sample#toast/credit', problem: 'matrix-missing' }]);
  });

  it('hands out the cell a need waits on before the cell holding it, and names the skipped one', async () => {
    await call({ action: 'edit', scenario: 'badge', capability: 'credit', needs: ['toast/'] });
    const next = (await call({ action: 'next' }))._meta.matrix;
    expect(next.next.ref).toBe('sample#toast/credit');
    expect(next.remaining).toEqual({ gap: 1, unmeasured: 1, blocked: 1 });
    expect(next.waiting).toMatchObject({ ref: 'sample#badge/credit', ends: [{ ref: 'sample#toast/credit', kind: 'cell' }] });
  });

  it('holds an issue on a need until the cell works, and refuses a short form on an issue', async () => {
    expect((await issue({ action: 'create', type: 'feature', title: 'short', includeSequence: false, needs: ['/credit'] }))._errorId).toBe('NEEDS_REFUSED');
    const made = await issue({ action: 'create', type: 'feature', title: 'after credit', includeSequence: false, needs: ['sample#badge/credit'] });
    expect(made.isError).toBeUndefined();
    const waiting = Math.max(...(await getIssues()).map(each => each.id));
    expect((await getIssue(waiting))!.needs).toEqual(['sample#badge/credit']);
    const before = await issue({ action: 'next' });
    expect(before.content[0].text).not.toContain(`#${waiting}`);
    await call({ action: 'edit', scenario: 'badge', capability: 'credit', today: 'works' });
    expect((await issue({ action: 'next' })).content[0].text).toContain(`#${waiting}`);
  });
});
