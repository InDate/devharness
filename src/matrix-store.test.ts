import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from './helpers/paths.js';
import {
  __resetForTests,
  countStandings,
  formatMatrixRef,
  getMatrixDir,
  importMatrix,
  listMatrices,
  matrixLinkKind,
  matrixShapeProblem,
  parseMatrixRef,
  readMatrix,
  readMatrixActivity,
  refCoversCell,
  resolveCell,
  setCell,
  type MatrixFile,
} from './matrix-store.js';

const SAMPLE: MatrixFile = {
  about: 'two rows against three columns',
  layers: [{ field: 'trigger', table: 'triggers' }, { field: 'mechanism', table: 'mechanisms' }],
  capabilities: [
    { id: 'seen', name: 'Seen', default: { expect: 'default seen' } },
    { id: 'credit', name: 'Credit', default: { today: 'gap', basis: 'code' } },
    { id: 'slow', name: 'Slow' },
  ],
  triggers: { action: { credit: { expect: 'the step of the action' } } },
  mechanisms: { css: { seen: { expect: 'through the record', today: 'works' }, credit: { expect: 'the mechanism over the trigger' } } },
  scenarios: [
    { id: 'badge', name: 'Badge', trigger: 'action', mechanism: 'css', cells: { credit: { today: 'unmeasured' } } },
    { id: 'toast', name: 'Toast', trigger: 'action', mechanism: 'timer' },
  ],
};

let tempDir: string;

async function store(name: string, matrix: unknown = SAMPLE): Promise<string> {
  await fsp.mkdir(getMatrixDir(), { recursive: true });
  const file = join(getMatrixDir(), `${name}.json`);
  await fsp.writeFile(file, JSON.stringify(matrix, null, 2) + '\n');
  return file;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-matrix-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
});

afterEach(async () => {
  __resetForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('resolveCell', () => {
  it('holds the union of every layer\'s needs and the row\'s, first layer first, each once', () => {
    const matrix: MatrixFile = {
      layers: [{ field: 'kind', table: 'kinds' }],
      capabilities: [{ id: 'profile', default: { needs: ['/login'] } }, { id: 'login' }],
      kinds: { native: { profile: { needs: ['api#/auth', '/login'] } } },
      scenarios: [{ id: 'mobile', kind: 'native', needs: ['api#/auth', '#4'], cells: { profile: { needs: ['design#tokens'] } } }],
    };
    expect(resolveCell(matrix, 'mobile', 'profile')!.needs).toEqual([
      { ref: '/login', from: 'capability' },
      { ref: 'api#/auth', from: 'kinds.native' },
      { ref: '#4', from: 'row' },
      { ref: 'design#tokens', from: 'scenario' },
    ]);
    expect(resolveCell(matrix, 'mobile', 'login')!.needs).toEqual([{ ref: 'api#/auth', from: 'row' }, { ref: '#4', from: 'row' }]);
  });

  it('layers the capability default, each layer table in order, then the scenario cell', () => {
    const cell = resolveCell(SAMPLE, 'badge', 'credit')!;
    expect(cell.expect).toBe('the mechanism over the trigger');
    expect(cell.basis).toBe('code');
    expect(cell.today).toBe('unmeasured');
    expect(cell.from).toEqual({ expect: 'mechanisms.css', basis: 'capability', today: 'scenario' });
  });

  it('reads a cell with no today as unmeasured', () => {
    expect(resolveCell(SAMPLE, 'toast', 'slow')!.today).toBe('unmeasured');
    expect(resolveCell(SAMPLE, 'toast', 'seen')!.expect).toBe('default seen');
  });

  it('returns nothing for an id the matrix lacks', () => {
    expect(resolveCell(SAMPLE, 'nope', 'seen')).toBeUndefined();
    expect(resolveCell(SAMPLE, 'badge', 'nope')).toBeUndefined();
  });

  it('counts every cell once per standing', () => {
    expect(countStandings(SAMPLE)).toEqual({ works: 1, gap: 1, unmeasured: 4, 'n/a': 0 });
  });
});

describe('matrix refs', () => {
  it('parses and formats a cell, a row and a column', () => {
    expect(parseMatrixRef('motion#badge/credit')).toEqual({ matrix: 'motion', scenario: 'badge', capability: 'credit' });
    expect(parseMatrixRef('motion#badge')).toEqual({ matrix: 'motion', scenario: 'badge' });
    expect(parseMatrixRef('motion#/credit')).toEqual({ matrix: 'motion', capability: 'credit' });
    for (const ref of ['motion#badge/credit', 'motion#badge', 'motion#/credit']) {
      expect(formatMatrixRef(parseMatrixRef(ref)!)).toBe(ref);
    }
  });

  it('rejects a malformed ref', () => {
    for (const ref of ['', 'motion', 'motion#', '#badge', 'motion#badge/', 'motion#a/b/c', 'mo tion#badge']) {
      expect(parseMatrixRef(ref), ref).toBeUndefined();
    }
  });

  it('names the kind of area a ref covers', () => {
    expect(matrixLinkKind(parseMatrixRef('m#s/c')!)).toBe('cell');
    expect(matrixLinkKind(parseMatrixRef('m#s')!)).toBe('row');
    expect(matrixLinkKind(parseMatrixRef('m#/c')!)).toBe('column');
  });

  it('covers a cell from its own ref, its row and its column, inside one matrix', () => {
    expect(refCoversCell('m#s/c', 's', 'c')).toBe(true);
    expect(refCoversCell('m#s', 's', 'c')).toBe(true);
    expect(refCoversCell('m#/c', 's', 'c')).toBe(true);
    expect(refCoversCell('m#s/other', 's', 'c')).toBe(false);
    expect(refCoversCell('m#other', 's', 'c')).toBe(false);
    expect(refCoversCell('m#s', 's', 'c', 'another')).toBe(false);
  });
});

describe('the store', () => {
  it('lists each matrix with its size and counts, and a broken file with its problem', async () => {
    await store('sample');
    await fsp.writeFile(join(getMatrixDir(), 'broken.json'), '{ not json');
    const listed = await listMatrices();
    expect(listed.map(m => m.name)).toEqual(['broken', 'sample']);
    expect(listed[0].problem).toMatch(/invalid JSON/);
    expect(listed[1]).toMatchObject({ scenarios: 2, capabilities: 3, cells: { works: 1, gap: 1, unmeasured: 4, 'n/a': 0 } });
  });

  it('reads the only matrix with no name given, and names the valid ones for a missing name', async () => {
    await store('sample');
    const only = await readMatrix();
    expect(only.ok && only.name).toBe('sample');
    const missing = await readMatrix('nope');
    expect(missing).toMatchObject({ ok: false, reason: 'missing', valid: ['sample'] });
  });

  it('reports needs that are not a list of strings', () => {
    expect(matrixShapeProblem({ capabilities: [{ id: 'a', default: { needs: 'b' } }], scenarios: [] })).toMatch(/capability `a` default/);
    expect(matrixShapeProblem({ capabilities: [], scenarios: [{ id: 'r', needs: [3] }] })).toMatch(/scenario `r`/);
    expect(matrixShapeProblem({ capabilities: [], scenarios: [{ id: 'r', cells: { a: { needs: {} } } }] })).toMatch(/cell `r\/a`/);
  });

  it('reports a file of the wrong shape', () => {
    expect(matrixShapeProblem({ capabilities: [], scenarios: [] })).toBeUndefined();
    expect(matrixShapeProblem({ scenarios: [] })).toBeTypeOf('string');
    expect(matrixShapeProblem([])).toBeTypeOf('string');
  });
});

describe('setCell', () => {
  it('writes onto the scenario cell alone and leaves every default table as it stood', async () => {
    const file = await store('sample');
    const result = await setCell('sample', 'toast', 'credit', { today: 'works', note: 'measured' });
    expect(result.ok && result.previous.today).toBe('gap');
    expect(result.ok && result.cell).toMatchObject({ today: 'works', note: 'measured', basis: 'code' });

    const written = JSON.parse(await fsp.readFile(file, 'utf-8')) as MatrixFile;
    expect(written.scenarios[1].cells).toEqual({ credit: { today: 'works', note: 'measured' } });
    expect(written.capabilities).toEqual(SAMPLE.capabilities);
    expect(written.triggers).toEqual(SAMPLE.triggers);
    expect(written.mechanisms).toEqual(SAMPLE.mechanisms);
  });

  it('replaces the cell\'s own needs, logs the change, and holds the write when the check refuses it', async () => {
    await store('sample');
    const written = await setCell('sample', 'toast', 'slow', { needs: ['/seen', '/seen', '#2'] });
    expect(written.ok && written.cell.needs).toEqual([{ ref: '/seen', from: 'scenario' }, { ref: '#2', from: 'scenario' }]);
    expect((await readMatrixActivity('sample'))[0].changes).toEqual([{ scenario: 'toast', capability: 'slow', field: 'needs', to: '/seen, #2' }]);
    const refused = await setCell('sample', 'toast', 'slow', { needs: null }, 'session', async () => 'no');
    expect(refused).toEqual({ ok: false, reason: 'refused', refusal: 'no' });
    const read = await readMatrix('sample');
    expect(read.ok && resolveCell(read.matrix, 'toast', 'slow')!.needs).toHaveLength(2);
  });

  it('takes a field off the cell on null, so the layer under it shows again', async () => {
    const file = await store('sample');
    const result = await setCell('sample', 'badge', 'credit', { today: null });
    expect(result.ok && result.cell.today).toBe('gap');
    const written = JSON.parse(await fsp.readFile(file, 'utf-8')) as MatrixFile;
    expect(written.scenarios[0].cells).toBeUndefined();
  });

  it('refuses an unknown matrix, scenario, capability and standing, naming the valid ones', async () => {
    await store('sample');
    expect(await setCell('nope', 'badge', 'credit', { today: 'works' })).toMatchObject({ ok: false, reason: 'matrix', valid: ['sample'] });
    expect(await setCell('sample', 'nope', 'credit', { today: 'works' })).toMatchObject({ ok: false, reason: 'scenario', valid: ['badge', 'toast'] });
    expect(await setCell('sample', 'badge', 'nope', { today: 'works' })).toMatchObject({ ok: false, reason: 'capability', valid: ['seen', 'credit', 'slow'] });
    expect(await setCell('sample', 'badge', 'credit', { today: 'broken' as never })).toMatchObject({ ok: false, reason: 'today' });
  });
});

describe('importMatrix', () => {
  it('copies a file in under its folder name for matrix.json, and refuses a second copy without overwrite', async () => {
    const source = join(tempDir, 'examples', 'motion', 'matrix.json');
    await fsp.mkdir(join(tempDir, 'examples', 'motion'), { recursive: true });
    await fsp.writeFile(source, JSON.stringify(SAMPLE));

    const first = await importMatrix('examples/motion/matrix.json');
    expect(first).toMatchObject({ ok: true, name: 'motion', replaced: false });
    expect(await importMatrix('examples/motion/matrix.json')).toMatchObject({ ok: false, reason: 'exists' });
    expect(await importMatrix('examples/motion/matrix.json', { overwrite: true })).toMatchObject({ ok: true, replaced: true });
  });

  it('refuses a file that is missing or holds the wrong shape', async () => {
    expect(await importMatrix('nowhere.json')).toMatchObject({ ok: false, reason: 'unreadable' });
    await fsp.writeFile(join(tempDir, 'wrong.json'), JSON.stringify({ rows: [] }));
    expect(await importMatrix('wrong.json')).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('the activity log', () => {
  it('logs each field an edit changed with its value before and after, newest first, under the channel given', async () => {
    await store('sample');
    await setCell('sample', 'toast', 'credit', { today: 'works' }, 'bench');
    await setCell('sample', 'toast', 'credit', { today: 'n/a', note: 'no such motion' });

    const activity = await readMatrixActivity('sample');
    expect(activity.map(entry => entry.by)).toEqual(['session', 'bench']);
    expect(activity[1].changes).toEqual([{ scenario: 'toast', capability: 'credit', field: 'today', from: 'gap', to: 'works' }]);
    expect(activity[0].changes).toEqual([
      { scenario: 'toast', capability: 'credit', field: 'today', from: 'works', to: 'n/a' },
      { scenario: 'toast', capability: 'credit', field: 'note', to: 'no such motion' },
    ]);
  });

  it('logs nothing for an edit that leaves every resolved value as it stood', async () => {
    await store('sample');
    await setCell('sample', 'toast', 'credit', { today: 'gap' });
    expect(await readMatrixActivity('sample')).toEqual([]);
  });

  it('logs an import with its source, and the cells an overwrite changed', async () => {
    await fsp.writeFile(join(tempDir, 'sample.json'), JSON.stringify(SAMPLE));
    await importMatrix('sample.json');
    const changed = structuredClone(SAMPLE);
    changed.scenarios[1].cells = { slow: { today: 'works' } };
    await fsp.writeFile(join(tempDir, 'sample.json'), JSON.stringify(changed));
    await importMatrix('sample.json', { overwrite: true, by: 'cli' });

    const [overwrite, first] = await readMatrixActivity('sample');
    expect(first).toMatchObject({ cause: 'import', by: 'session', changes: [] });
    expect(first.notes?.[0]).toContain('sample.json');
    expect(overwrite).toMatchObject({ cause: 'import', by: 'cli' });
    expect(overwrite.changes).toEqual([{ scenario: 'toast', capability: 'slow', field: 'today', from: 'unmeasured', to: 'works' }]);
  });

  it('collapses entries sharing one after-hash to the entry of the process that made the write', async () => {
    await store('sample');
    await setCell('sample', 'toast', 'credit', { today: 'works' }, 'bench');
    const file = join(getMatrixDir(), 'activity', 'sample.jsonl');
    const [line] = (await fsp.readFile(file, 'utf-8')).trim().split('\n');
    const own = JSON.parse(line);
    const seenByAnother = JSON.stringify({ ...own, by: 'file', cause: 'file' });
    await fsp.writeFile(file, `${seenByAnother}\n${line}\n`);

    const activity = await readMatrixActivity('sample');
    expect(activity).toHaveLength(1);
    expect(activity[0].by).toBe('bench');
  });

  it('keeps the newest entries under a limit', async () => {
    await store('sample');
    await setCell('sample', 'toast', 'credit', { today: 'works' });
    await setCell('sample', 'toast', 'credit', { today: 'gap' });
    await setCell('sample', 'toast', 'credit', { today: 'n/a' });
    const activity = await readMatrixActivity('sample', 2);
    expect(activity.map(entry => entry.changes[0].to)).toEqual(['n/a', 'gap']);
  });
});
