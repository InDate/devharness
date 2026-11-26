/**
 * The Matrix tab's reads: the store's matrices, one matrix with every cell
 * resolved and the issues linked into it, and the places an issue's refs
 * point at.
 *
 * A resolved matrix is cached against the file object the store holds, which
 * the store replaces on every change, so a poll between changes costs no
 * re-resolution and a changed or relocated store is resolved afresh. The issue
 * links are read on every call: issue files change without any matrix change.
 */

import { CELL_STANDINGS, isMatrixName, listMatrices, parseMatrixRef, readMatrix, readMatrixActivity, resolveCell, setCell, type CellStanding, type MatrixFile } from '../matrix-store.js';
import { issuesLinkedTo, isCompletedStatus } from '../issue-tracker.js';
import { cellNeeds, chainEnds, loadWorld, type NeedState } from '../waits-on.js';
import { problemWords } from '../tools/needs-format.js';
import type { MatrixActivityRow, MatrixListRow, MatrixNeedView, MatrixPlace, MatrixRead, MatrixRefLink, MatrixScenarioView, MatrixView } from '../bench/wire.js';

const resolved = new WeakMap<MatrixFile, Omit<MatrixView, 'issues' | 'needs'>>();

const needView = ({ ref, target, met, problem, open, from }: NeedState): MatrixNeedView => ({
  ref, met,
  ...(target !== undefined && { target }),
  ...(problem !== undefined && { problem: problemWords(problem) }),
  ...(open !== undefined && { open }),
  ...(from !== undefined && { from }),
});

/** Every cell holding a need, with each need as it stands; read on every call, since another matrix or an issue meets it. */
async function needsView(name: string, matrix: MatrixFile): Promise<MatrixView['needs']> {
  const world = await loadWorld();
  const needs: MatrixView['needs'] = {};
  for (const scenario of matrix.scenarios) {
    for (const capability of matrix.capabilities) {
      const cell = resolveCell(matrix, scenario, capability)!;
      if (!cell.needs) continue;
      const states = cellNeeds(world, { matrix: name, scenario: scenario.id, capability: capability.id }, cell);
      const unmet = states.filter(state => !state.met);
      const open = cell.today === 'gap' || cell.today === 'unmeasured';
      (needs[scenario.id] ??= {})[capability.id] = {
        needs: states.map(needView),
        ...(open && unmet.length > 0 && {
          waits: chainEnds(world, unmet).map(({ ref, kind, problem }) => ({ ref, kind, ...(problem !== undefined && { problem: problemWords(problem) }) })),
        }),
      };
    }
  }
  return needs;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function scenarioView(scenario: MatrixFile['scenarios'][number]): MatrixScenarioView {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(scenario)) {
    if (key === 'id' || key === 'name' || key === 'cells' || key === 'needs') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[key] = String(value);
  }
  return { id: scenario.id, ...(typeof scenario.name === 'string' && { name: scenario.name }), fields };
}

function resolveView(name: string, matrix: MatrixFile): Omit<MatrixView, 'issues' | 'needs'> {
  const layers = (matrix.layers ?? []).map(layer => {
    const table = matrix[layer.table];
    const names: Record<string, string> = {};
    if (isRecord(table)) {
      for (const [key, entry] of Object.entries(table)) {
        if (isRecord(entry) && typeof entry.name === 'string') names[key] = entry.name;
      }
    }
    return { field: layer.field, table: layer.table, names };
  });
  const cells: MatrixView['cells'] = {};
  for (const scenario of matrix.scenarios) {
    const row: Record<string, MatrixView['cells'][string][string]> = {};
    for (const capability of matrix.capabilities) {
      const { scenario: _s, capability: _c, needs: _n, ...cell } = resolveCell(matrix, scenario, capability)!;
      row[capability.id] = cell;
    }
    cells[scenario.id] = row;
  }
  return {
    name,
    ...(matrix.about !== undefined && { about: matrix.about }),
    layers,
    capabilities: matrix.capabilities.map(capability => ({
      id: capability.id,
      ...(typeof capability.name === 'string' && { name: capability.name }),
      ...(typeof capability.question === 'string' && { question: capability.question }),
      ...(typeof capability.rule === 'string' && { rule: capability.rule }),
    })),
    scenarios: matrix.scenarios.map(scenarioView),
    cells,
  };
}

export async function matrixList(): Promise<MatrixListRow[]> {
  return listMatrices();
}

/** The matrix `name`, or the only one in the store when `name` is absent. */
export async function matrixRead(name?: string): Promise<MatrixRead> {
  const read = await readMatrix(name);
  if (!read.ok) {
    return read.reason === 'missing'
      ? { missing: read.name, valid: read.valid }
      : { broken: read.name, problem: read.problem };
  }
  let view = resolved.get(read.matrix);
  if (!view) {
    view = resolveView(read.name, read.matrix);
    resolved.set(read.matrix, view);
  }
  const issues = (await issuesLinkedTo(read.name)).map(({ issue, refs }) => ({
    id: issue.id,
    type: issue.type,
    title: issue.title,
    closed: isCompletedStatus(issue.status),
    refs: refs.map(ref => {
      const parsed = parseMatrixRef(ref);
      return {
        ref,
        ...(parsed?.scenario !== undefined && { scenario: parsed.scenario }),
        ...(parsed?.capability !== undefined && { capability: parsed.capability }),
      };
    }),
  }));
  return { view: { ...view, issues, needs: await needsView(read.name, read.matrix) } };
}

/**
 * Each ref placed in the store: `at` holds where it points, and is left off a
 * ref that fails to parse or names a matrix, scenario or capability the store
 * lacks. The store is read only for refs that parse, so a project with no
 * matrix refs never creates the matrix folder.
 */
export async function placeMatrixRefs(refs: string[]): Promise<MatrixRefLink[]> {
  const parsed = refs.map(ref => ({ ref, at: parseMatrixRef(ref) }));
  const names = new Set(parsed.flatMap(({ at }) => (at ? [at.matrix] : [])));
  const held = new Map<string, MatrixFile>();
  for (const name of names) {
    const read = await readMatrix(name);
    if (read.ok) held.set(name, read.matrix);
  }
  return parsed.map(({ ref, at }) => {
    const matrix = at && held.get(at.matrix);
    const found = matrix
      && (at.scenario === undefined || matrix.scenarios.some(scenario => scenario.id === at.scenario))
      && (at.capability === undefined || matrix.capabilities.some(capability => capability.id === at.capability));
    if (!found) return { ref };
    const place: MatrixPlace = { matrix: at.matrix };
    if (at.scenario !== undefined) place.scenario = at.scenario;
    if (at.capability !== undefined) place.capability = at.capability;
    return { ref, at: place };
  });
}

/** Writes one cell's standing through the store, which lands it on the scenario's own cell. */
export async function matrixSetStanding(name: string, scenario: string, capability: string, today: string): Promise<{ failure?: string; previous?: string }> {
  if (!(CELL_STANDINGS as readonly string[]).includes(today)) {
    return { failure: `${today || 'An empty value'} is no standing. Standings: ${CELL_STANDINGS.join(', ')}.` };
  }
  const written = await setCell(name, scenario, capability, { today: today as CellStanding }, 'bench');
  if (written.ok) return { previous: written.previous.today };
  if (written.reason === 'broken') return { failure: written.problem };
  return { failure: `The store holds no ${written.reason} of that name, so nothing was written.` };
}

/** The changes logged for one matrix, newest first, without the hashes the log pairs entries by. */
export async function matrixActivity(name: string): Promise<MatrixActivityRow[]> {
  if (!isMatrixName(name)) return [];
  return (await readMatrixActivity(name)).map(({ at, by, cause, changes, notes }) => ({ at, by, cause, changes, ...(notes && { notes }) }));
}
