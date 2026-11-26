/**
 * What matrix cells and issues wait on, and the order `next` hands them out in.
 *
 * A need names an issue (`#12`) or a matrix area (`m#s/c`, `m#s`, `m#/c`); a
 * cell's need may also name `/<capability>` (this row's cell in that column) or
 * `<scenario>/` (that row's cell in this column). An issue waits on its
 * blockers, its open pieces, its own needs, and the needs of every cell its
 * matrix refs cover, so `issues next` and `matrix next` follow one order.
 *
 * A need on an issue is met once the issue is completed. A need on an area is
 * met once every cell in it reads works; inside a row or a column an n/a cell
 * counts as met, and a need on one n/a cell is reported, since it never meets.
 */

import {
  allMatrices,
  formatMatrixRef,
  matrixLinkKind,
  parseMatrixRef,
  resolveCell,
  type CellStanding,
  type MatrixCapability,
  type MatrixFile,
  type MatrixRef,
  type MatrixScenario,
  type ResolvedCell,
} from './matrix-store.js';
import { childrenOf, getIssueMap, getReadyIssues, isCompletedStatus, type IssueFilter, type TrackedIssue } from './issue-tracker.js';

export type NeedProblem =
  | 'malformed'
  | 'relative'
  | 'issue-missing'
  | 'matrix-missing'
  | 'matrix-broken'
  | 'scenario-missing'
  | 'capability-missing'
  | 'na-target';

/**
 * Problems a write is refused for. A need on a matrix the store lacks or cannot
 * read is written and reported, so a need can name a matrix before it exists.
 */
export const REFUSED_NEED_PROBLEMS: ReadonlySet<NeedProblem> = new Set<NeedProblem>([
  'malformed', 'relative', 'issue-missing', 'scenario-missing', 'capability-missing',
]);

export interface NeedState {
  /** As written. */
  ref: string;
  /** The `#<issue>` or absolute matrix ref it resolves to; absent for a malformed or out-of-place need. */
  target?: string;
  met: boolean;
  problem?: NeedProblem;
  /** An unmet area's cells still short of works. */
  open?: string[];
  /** A cell's need: the layer holding it. */
  from?: string;
  /** An issue's need taken from a cell its matrix refs cover: that cell. */
  via?: string;
}

export interface CellPlace {
  matrix: string;
  scenario: string;
  capability: string;
}

export interface WaitWorld {
  matrices: Map<string, { matrix?: MatrixFile; problem?: string }>;
  issues: Map<number, TrackedIssue>;
}

/** The store and the issues as they stand, with an unwritten matrix or issue put in place of the stored one. */
export async function loadWorld(override: { matrix?: { name: string; matrix: MatrixFile }; issue?: TrackedIssue } = {}): Promise<WaitWorld> {
  const matrices: WaitWorld['matrices'] = new Map((await allMatrices()).map(({ name, matrix, problem }) => [name, { matrix, problem }]));
  if (override.matrix) matrices.set(override.matrix.name, { matrix: override.matrix.matrix });
  const issues = new Map(await getIssueMap());
  if (override.issue) issues.set(override.issue.id, override.issue);
  return { matrices, issues };
}

// =============================================================================
// Parsing and evaluation
// =============================================================================

const ID = '[A-Za-z0-9_.-]+';
const ISSUE_RE = /^#([1-9]\d*)$/;
const SAME_ROW_RE = new RegExp(`^/(${ID})$`);
const SAME_COLUMN_RE = new RegExp(`^(${ID})/$`);

type ParsedNeed = { kind: 'issue'; id: number } | { kind: 'area'; ref: MatrixRef } | { kind: 'bad'; problem: 'malformed' | 'relative' };

/** A need's target; the short forms resolve against `at` and read as `relative` without one. */
export function parseNeed(ref: string, at?: CellPlace): ParsedNeed {
  const issue = ISSUE_RE.exec(ref);
  if (issue) return { kind: 'issue', id: Number(issue[1]) };
  const area = parseMatrixRef(ref);
  if (area) return { kind: 'area', ref: area };
  const sameRow = SAME_ROW_RE.exec(ref);
  const sameColumn = SAME_COLUMN_RE.exec(ref);
  if (!sameRow && !sameColumn) return { kind: 'bad', problem: 'malformed' };
  if (!at) return { kind: 'bad', problem: 'relative' };
  return sameRow
    ? { kind: 'area', ref: { matrix: at.matrix, scenario: at.scenario, capability: sameRow[1] } }
    : { kind: 'area', ref: { matrix: at.matrix, scenario: sameColumn![1], capability: at.capability } };
}

export const cellRef = (place: CellPlace): string => formatMatrixRef(place);

function areaCells(matrix: MatrixFile, ref: MatrixRef): Array<[MatrixScenario, MatrixCapability]> {
  const rows = matrix.scenarios.filter(s => ref.scenario === undefined || s.id === ref.scenario);
  const columns = matrix.capabilities.filter(c => ref.capability === undefined || c.id === ref.capability);
  return rows.flatMap(row => columns.map(column => [row, column] as [MatrixScenario, MatrixCapability]));
}

type AreaLookup =
  | { ok: true; matrix: MatrixFile; cells: Array<[MatrixScenario, MatrixCapability]> }
  | { ok: false; problem: NeedProblem; valid?: string[] };

function lookUpArea(world: WaitWorld, ref: MatrixRef): AreaLookup {
  const entry = world.matrices.get(ref.matrix);
  if (!entry) return { ok: false, problem: 'matrix-missing', valid: [...world.matrices.keys()] };
  if (!entry.matrix) return { ok: false, problem: 'matrix-broken' };
  const matrix = entry.matrix;
  if (ref.scenario !== undefined && !matrix.scenarios.some(s => s.id === ref.scenario)) {
    return { ok: false, problem: 'scenario-missing', valid: matrix.scenarios.map(s => s.id) };
  }
  if (ref.capability !== undefined && !matrix.capabilities.some(c => c.id === ref.capability)) {
    return { ok: false, problem: 'capability-missing', valid: matrix.capabilities.map(c => c.id) };
  }
  return { ok: true, matrix, cells: areaCells(matrix, ref) };
}

/** One need as it stands in `world`. */
export function evaluateNeed(world: WaitWorld, ref: string, at?: CellPlace): NeedState {
  const parsed = parseNeed(ref, at);
  if (parsed.kind === 'bad') return { ref, met: false, problem: parsed.problem };
  if (parsed.kind === 'issue') {
    const target = `#${parsed.id}`;
    const issue = world.issues.get(parsed.id);
    if (!issue) return { ref, target, met: false, problem: 'issue-missing' };
    return { ref, target, met: isCompletedStatus(issue.status) };
  }
  const target = formatMatrixRef(parsed.ref);
  const area = lookUpArea(world, parsed.ref);
  if (!area.ok) return { ref, target, met: false, problem: area.problem };
  if (matrixLinkKind(parsed.ref) === 'cell') {
    const today = resolveCell(area.matrix, parsed.ref.scenario!, parsed.ref.capability!)!.today;
    if (today === 'works') return { ref, target, met: true };
    return { ref, target, met: false, open: [target], ...(today === 'n/a' && { problem: 'na-target' as const }) };
  }
  const open = area.cells
    .filter(([row, column]) => !['works', 'n/a'].includes(resolveCell(area.matrix, row, column)!.today))
    .map(([row, column]) => cellRef({ matrix: parsed.ref.matrix, scenario: row.id, capability: column.id }));
  return open.length === 0 ? { ref, target, met: true } : { ref, target, met: false, open };
}

/** The valid ids for a refused need naming a scenario, capability or matrix that is not there. */
export function needValidIds(world: WaitWorld, ref: string, at?: CellPlace): string[] {
  const parsed = parseNeed(ref, at);
  if (parsed.kind !== 'area') return [];
  const area = lookUpArea(world, parsed.ref);
  return area.ok ? [] : area.valid ?? [];
}

/** Every need the cell holds across its layers, each as it stands. */
export function cellNeeds(world: WaitWorld, place: CellPlace, resolved?: ResolvedCell): NeedState[] {
  const cell = resolved ?? cellAt(world, place);
  return (cell?.needs ?? []).map(need => ({ ...evaluateNeed(world, need.ref, place), from: need.from }));
}

function cellAt(world: WaitWorld, place: CellPlace): ResolvedCell | undefined {
  const matrix = world.matrices.get(place.matrix)?.matrix;
  return matrix ? resolveCell(matrix, place.scenario, place.capability) : undefined;
}

/** The cells each of the issue's matrix refs covers, in the store as it stands. */
function cellsCoveredBy(world: WaitWorld, issue: TrackedIssue): CellPlace[] {
  const places: CellPlace[] = [];
  for (const ref of issue.matrix) {
    const parsed = parseMatrixRef(ref);
    if (!parsed) continue;
    const area = lookUpArea(world, parsed);
    if (!area.ok) continue;
    for (const [row, column] of area.cells) places.push({ matrix: parsed.matrix, scenario: row.id, capability: column.id });
  }
  return places;
}

/**
 * The issue's own needs, then the needs of each cell its matrix refs cover,
 * one entry per target. A cell's need naming this issue is left out: the
 * issue is the work that cell waits on.
 */
export function issueNeeds(world: WaitWorld, issue: TrackedIssue): NeedState[] {
  const states = (issue.needs ?? []).map(ref => evaluateNeed(world, ref));
  const self = `#${issue.id}`;
  const held = new Set(states.map(state => state.target ?? state.ref));
  for (const place of cellsCoveredBy(world, issue)) {
    for (const state of cellNeeds(world, place)) {
      const key = state.target ?? state.ref;
      if (key === self || held.has(key)) continue;
      held.add(key);
      const { from: _from, ...rest } = state;
      states.push({ ...rest, via: cellRef(place) });
    }
  }
  return states;
}

// =============================================================================
// The wait graph: cycles
// =============================================================================

/** The nodes a node waits on: cells as `m#s/c`, issues as `#n`. Areas expand to their cells. */
function waitsOnNodes(world: WaitWorld, node: string): string[] {
  const targets = (states: NeedState[]): string[] => states.flatMap(state => {
    if (!state.target) return [];
    if (state.target.startsWith('#')) return world.issues.has(Number(state.target.slice(1))) ? [state.target] : [];
    const parsed = parseMatrixRef(state.target)!;
    const area = lookUpArea(world, parsed);
    return area.ok ? area.cells.map(([row, column]) => cellRef({ matrix: parsed.matrix, scenario: row.id, capability: column.id })) : [];
  });
  if (node.startsWith('#')) {
    const issue = world.issues.get(Number(node.slice(1)));
    if (!issue) return [];
    return [
      ...issue.blockedBy.map(id => `#${id}`),
      ...childrenOf(issue.id, world.issues).map(child => `#${child.id}`),
      ...targets(issueNeeds(world, issue)),
    ];
  }
  const parsed = parseMatrixRef(node);
  if (!parsed || parsed.scenario === undefined || parsed.capability === undefined) return [];
  return targets(cellNeeds(world, { matrix: parsed.matrix, scenario: parsed.scenario, capability: parsed.capability }));
}

/** A loop of waits reachable from `starts`, as the nodes along it with the first repeated at the end; null for none. */
export function findWaitCycle(world: WaitWorld, starts: string[]): string[] | null {
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const memo = new Map<string, string[]>();
  const edges = (node: string) => {
    let found = memo.get(node);
    if (!found) memo.set(node, found = waitsOnNodes(world, node));
    return found;
  };
  const walk = (node: string): string[] | null => {
    if (onStack.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (done.has(node)) return null;
    stack.push(node);
    onStack.add(node);
    for (const next of edges(node)) {
      const loop = walk(next);
      if (loop) return loop;
    }
    stack.pop();
    onStack.delete(node);
    done.add(node);
    return null;
  };
  for (const start of starts) {
    const loop = walk(start);
    if (loop) return loop;
  }
  return null;
}

// =============================================================================
// Write checks
// =============================================================================

export type NeedRefusal =
  | { kind: 'need'; at: string; ref: string; problem: NeedProblem; valid: string[] }
  | { kind: 'cycle'; path: string[] };

function firstRefusedNeed(world: WaitWorld, at: string, states: NeedState[], place?: CellPlace): NeedRefusal | undefined {
  const bad = states.find(state => state.problem !== undefined && REFUSED_NEED_PROBLEMS.has(state.problem));
  return bad && { kind: 'need', at, ref: bad.ref, problem: bad.problem!, valid: needValidIds(world, bad.ref, place) };
}

/**
 * The refusal for a matrix about to be written: the first need naming a form,
 * issue, scenario or capability that is not there, then a loop of waits. With
 * `only`, the cells checked are those alone; otherwise every cell.
 */
export async function checkMatrixNeeds(name: string, matrix: MatrixFile, only?: Array<{ scenario: string; capability: string }>): Promise<NeedRefusal | undefined> {
  const world = await loadWorld({ matrix: { name, matrix } });
  const places: CellPlace[] = only
    ? only.map(cell => ({ matrix: name, ...cell }))
    : matrix.scenarios.flatMap(row => matrix.capabilities.map(column => ({ matrix: name, scenario: row.id, capability: column.id })));
  for (const place of places) {
    const refusal = firstRefusedNeed(world, cellRef(place), cellNeeds(world, place), place);
    if (refusal) return refusal;
  }
  const loop = findWaitCycle(world, places.map(cellRef));
  return loop ? { kind: 'cycle', path: loop } : undefined;
}

/**
 * The same check for an issue about to be written: `needs` for a new issue,
 * which nothing waits on yet, or the stored issue as the edit leaves it.
 */
export async function checkIssueNeeds(proposed: { needs: string[] } | TrackedIssue): Promise<NeedRefusal | undefined> {
  const issue = 'id' in proposed ? proposed : undefined;
  const world = await loadWorld(issue ? { issue } : {});
  const own = proposed.needs.map(ref => evaluateNeed(world, ref));
  const refusal = firstRefusedNeed(world, issue ? `#${issue.id}` : 'the new issue', own);
  if (refusal || !issue) return refusal;
  const loop = findWaitCycle(world, [`#${issue.id}`]);
  return loop ? { kind: 'cycle', path: loop } : undefined;
}

/** Every need in a matrix carrying a problem, refused or reported, then a loop of waits through its cells. */
export function matrixNeedProblems(world: WaitWorld, name: string): { needs: Array<NeedState & { cell: string }>; cycle: string[] | null } {
  const matrix = world.matrices.get(name)?.matrix;
  if (!matrix) return { needs: [], cycle: null };
  const places = matrix.scenarios.flatMap(row => matrix.capabilities.map(column => ({ matrix: name, scenario: row.id, capability: column.id })));
  const needs = places.flatMap(place => cellNeeds(world, place)
    .filter(state => state.problem !== undefined)
    .map(state => ({ ...state, cell: cellRef(place) })));
  return { needs, cycle: findWaitCycle(world, places.map(cellRef)) };
}

// =============================================================================
// Readiness and next
// =============================================================================

/** Where a chain of unmet needs ends: a cell or issue ready to work, or a need that cannot resolve. */
export interface ChainEnd {
  ref: string;
  kind: 'cell' | 'issue' | 'problem';
  problem?: NeedProblem;
  today?: CellStanding;
  status?: string;
}

const CHAIN_ENDS_SHOWN = 8;

/** The ready cells and issues, and the unresolvable needs, at the bottom of these unmet needs. */
export function chainEnds(world: WaitWorld, unmet: NeedState[]): ChainEnd[] {
  const ends: ChainEnd[] = [];
  const seen = new Set<string>();
  const add = (end: ChainEnd) => {
    if (ends.length < CHAIN_ENDS_SHOWN && !ends.some(each => each.ref === end.ref)) ends.push(end);
  };
  const follow = (states: NeedState[]) => {
    for (const state of states) {
      if (state.met || ends.length >= CHAIN_ENDS_SHOWN) continue;
      if (state.problem !== undefined) {
        add({ ref: state.target ?? state.ref, kind: 'problem', problem: state.problem });
        continue;
      }
      const nodes = state.target!.startsWith('#') ? [state.target!] : state.open ?? [];
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (node.startsWith('#')) {
          const issue = world.issues.get(Number(node.slice(1)))!;
          const waits = issueWaits(world, issue).filter(each => !each.met);
          if (waits.length === 0) add({ ref: node, kind: 'issue', status: issue.status });
          else follow(waits);
          continue;
        }
        const parsed = parseMatrixRef(node)!;
        const place = { matrix: parsed.matrix, scenario: parsed.scenario!, capability: parsed.capability! };
        const waits = cellNeeds(world, place).filter(each => !each.met);
        if (waits.length === 0) add({ ref: node, kind: 'cell', today: cellAt(world, place)?.today });
        else follow(waits);
      }
    }
  };
  follow(unmet);
  return ends;
}

/** Everything an issue waits on: its blockers, its open pieces, and its needs. */
export function issueWaits(world: WaitWorld, issue: TrackedIssue): NeedState[] {
  return [
    ...issue.blockedBy.map(id => evaluateNeed(world, `#${id}`)),
    ...childrenOf(issue.id, world.issues)
      .filter(child => !isCompletedStatus(child.status))
      .map(child => evaluateNeed(world, `#${child.id}`)),
    ...issueNeeds(world, issue),
  ];
}

/** Open issues ready to work, in `getReadyIssues` order, less those with a need unmet. */
export async function readyIssues(filter?: Pick<IssueFilter, 'type' | 'labels'>): Promise<TrackedIssue[]> {
  const ready = await getReadyIssues(filter);
  const world = await loadWorld();
  return ready.filter(issue => issueNeeds(world, issue).every(state => state.met));
}

export interface WaitingCell {
  ref: string;
  unmet: NeedState[];
  ends: ChainEnd[];
}

export interface NextReadyCell {
  matrix: string;
  ref: string;
  scenario: MatrixScenario;
  capability: MatrixCapability;
  cell: ResolvedCell;
  needs: NeedState[];
}

export interface NextCellResult {
  next?: NextReadyCell;
  /** Open cells left in the matrices searched; `blocked` counts those of them with a need unmet. */
  remaining: { gap: number; unmeasured: number; blocked: number };
  /** The first open cell skipped for an unmet need, gaps before unmeasured, in file order. */
  waiting?: WaitingCell;
}

/**
 * The next cell to work on: the first gap whose needs are all met, then the
 * first such unmeasured cell, in file order (scenarios, then capabilities). With
 * no name, every matrix is searched in name order, all gaps before any
 * unmeasured cell.
 */
export async function nextReadyCell(name?: string): Promise<NextCellResult> {
  const world = await loadWorld();
  const remaining = { gap: 0, unmeasured: 0, blocked: 0 };
  const ready: Partial<Record<'gap' | 'unmeasured', NextReadyCell>> = {};
  const blocked: Partial<Record<'gap' | 'unmeasured', { ref: string; unmet: NeedState[] }>> = {};
  for (const [matrixName, { matrix }] of world.matrices) {
    if (!matrix || (name !== undefined && matrixName !== name)) continue;
    for (const scenario of matrix.scenarios) {
      for (const capability of matrix.capabilities) {
        const cell = resolveCell(matrix, scenario, capability)!;
        if (cell.today !== 'gap' && cell.today !== 'unmeasured') continue;
        remaining[cell.today]++;
        const place = { matrix: matrixName, scenario: scenario.id, capability: capability.id };
        const needs = cellNeeds(world, place, cell);
        const unmet = needs.filter(state => !state.met);
        if (unmet.length > 0) {
          remaining.blocked++;
          blocked[cell.today] ??= { ref: cellRef(place), unmet };
          continue;
        }
        ready[cell.today] ??= { matrix: matrixName, ref: cellRef(place), scenario, capability, cell, needs };
      }
    }
  }
  const skipped = blocked.gap ?? blocked.unmeasured;
  return {
    next: ready.gap ?? ready.unmeasured,
    remaining,
    ...(skipped && { waiting: { ...skipped, ends: chainEnds(world, skipped.unmet) } }),
  };
}
