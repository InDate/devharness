/**
 * Capability matrices: one JSON file per matrix under .devharness/matrix/,
 * cached in memory after the first read and kept fresh by an fs.watch on the
 * directory (debounced full rescan), as src/issue-tracker.ts keeps its issues.
 *
 * A matrix holds capabilities (columns) and scenarios (rows). A cell resolves
 * by layering, later layers over earlier ones: the capability's `default`,
 * then one table per entry of the file's `layers`, then the scenario's own
 * `cells[capability]`.
 */

import { createHash } from 'crypto';
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { getOutputPath, getProjectDir, registerRootBound } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';

// =============================================================================
// Types
// =============================================================================

export const CELL_STANDINGS = ['works', 'gap', 'unmeasured', 'n/a'] as const;
export type CellStanding = typeof CELL_STANDINGS[number];

export const CELL_FIELDS = ['expect', 'today', 'basis', 'note'] as const;
export type CellField = typeof CELL_FIELDS[number];

/**
 * One cell as a file writes it, at any layer. `basis` is `code` or
 * `sequence:<name>`. `needs` lists what the cell waits on: `#<issue>`, a matrix
 * ref, `/<capability>` (this row's cell in that column) or `<scenario>/` (that
 * row's cell in this column).
 */
export interface MatrixCell {
  expect?: string;
  today?: CellStanding;
  basis?: string;
  note?: string;
  needs?: string[];
}

export interface MatrixCapability {
  id: string;
  name?: string;
  question?: string;
  rule?: string;
  default?: MatrixCell;
  [extra: string]: unknown;
}

export interface MatrixScenario {
  id: string;
  name?: string;
  /** Needs every cell of this row holds, beside its own. */
  needs?: string[];
  cells?: Record<string, MatrixCell>;
  [extra: string]: unknown;
}

/**
 * One middle layer: a scenario's value of `field` keys into the top-level
 * object `table`, whose entry holds a cell per capability id.
 */
export interface MatrixLayer {
  field: string;
  table: string;
}

export interface MatrixFile {
  about?: string;
  layers?: MatrixLayer[];
  capabilities: MatrixCapability[];
  scenarios: MatrixScenario[];
  [table: string]: unknown;
}

/** The layer a resolved field took its value from: `capability`, `<table>.<key>` or `scenario`. */
export type CellLayerName = string;

/** One need of a resolved cell, as written, with the layer that holds it: a layer above, or `row` for the scenario's `needs`. */
export interface CellNeed {
  ref: string;
  from: CellLayerName;
}

export interface ResolvedCell extends Omit<MatrixCell, 'needs'> {
  scenario: string;
  capability: string;
  /** A cell with no `today` at any layer reads `unmeasured`. */
  today: CellStanding;
  /** For each field present, the layer its value came from. */
  from: Partial<Record<CellField, CellLayerName>>;
  /** The union of every layer's needs, first layer first; absent where no layer holds one. */
  needs?: CellNeed[];
}

export type StandingCounts = Record<CellStanding, number>;

export interface MatrixSummary {
  name: string;
  about?: string;
  scenarios: number;
  capabilities: number;
  cells: StandingCounts;
  /** Set on a file that failed to parse or holds the wrong shape; the counts are then zero. */
  problem?: string;
}

export type MatrixChangeCause = 'disk' | 'edit' | 'import' | 'removed';

export interface MatrixChange {
  name: string;
  cause: MatrixChangeCause;
  /** edit: the cell written. */
  cell?: { scenario: string; capability: string };
}

export type MatrixChangeListener = (change: MatrixChange) => void;

// =============================================================================
// References
// =============================================================================

export interface MatrixRef {
  matrix: string;
  scenario?: string;
  capability?: string;
}

const MATRIX_ID = '[A-Za-z0-9_.-]+';
const MATRIX_REF_RE = new RegExp(`^(${MATRIX_ID})#(?:(${MATRIX_ID})(?:/(${MATRIX_ID}))?|/(${MATRIX_ID}))$`);
/** A matrix name is also a file name, so a leading dot (`.`, `..`, hidden files) is refused. */
const MATRIX_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export function isMatrixName(name: string): boolean {
  return MATRIX_NAME_RE.test(name);
}

/** Cell `m#s/c`, row `m#s`, column `m#/c`; undefined for any other string. */
export function parseMatrixRef(ref: string): MatrixRef | undefined {
  const m = MATRIX_REF_RE.exec(ref);
  if (!m) return undefined;
  const parsed: MatrixRef = { matrix: m[1] };
  if (m[2] !== undefined) parsed.scenario = m[2];
  const capability = m[3] ?? m[4];
  if (capability !== undefined) parsed.capability = capability;
  return parsed;
}

/** The inverse of parseMatrixRef; a ref with neither scenario nor capability returns the bare matrix name. */
export function formatMatrixRef(ref: MatrixRef): string {
  if (ref.scenario !== undefined && ref.capability !== undefined) return `${ref.matrix}#${ref.scenario}/${ref.capability}`;
  if (ref.scenario !== undefined) return `${ref.matrix}#${ref.scenario}`;
  if (ref.capability !== undefined) return `${ref.matrix}#/${ref.capability}`;
  return ref.matrix;
}

/** The area a ref spans: one cell, a whole row (scenario) or a whole column (capability). */
export type MatrixLinkKind = 'cell' | 'row' | 'column';

export function matrixLinkKind(ref: MatrixRef): MatrixLinkKind {
  if (ref.scenario !== undefined && ref.capability !== undefined) return 'cell';
  return ref.scenario !== undefined ? 'row' : 'column';
}

/** One issue's link onto a matrix area, as the matrix tool reports it. */
export interface MatrixIssueLink {
  id: number;
  type: string;
  status: string;
  title: string;
  completed: boolean;
  link: MatrixLinkKind;
  ref: string;
}

/** true when the ref's area holds the cell: the cell itself, its row or its column. */
export function refCoversCell(ref: string | MatrixRef, scenarioId: string, capabilityId: string, matrixName?: string): boolean {
  const parsed = typeof ref === 'string' ? parseMatrixRef(ref) : ref;
  if (!parsed) return false;
  if (matrixName !== undefined && parsed.matrix !== matrixName) return false;
  return (parsed.scenario === undefined || parsed.scenario === scenarioId)
    && (parsed.capability === undefined || parsed.capability === capabilityId);
}

// =============================================================================
// Shape and resolution
// =============================================================================

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNeedList = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every(each => typeof each === 'string'));

/** The first shape fault in a parsed matrix file, or undefined for a well-formed one. */
export function matrixShapeProblem(data: unknown): string | undefined {
  if (!isRecord(data)) return 'the file holds no JSON object';
  if (!Array.isArray(data.capabilities)) return '`capabilities` is not an array';
  if (!Array.isArray(data.scenarios)) return '`scenarios` is not an array';
  const capabilityIds = new Set<string>();
  for (const capability of data.capabilities) {
    if (!isRecord(capability) || typeof capability.id !== 'string') return 'a capability has no string `id`';
    if (capabilityIds.has(capability.id)) return `capability id \`${capability.id}\` appears twice`;
    capabilityIds.add(capability.id);
  }
  const scenarioIds = new Set<string>();
  for (const scenario of data.scenarios) {
    if (!isRecord(scenario) || typeof scenario.id !== 'string') return 'a scenario has no string `id`';
    if (scenarioIds.has(scenario.id)) return `scenario id \`${scenario.id}\` appears twice`;
    scenarioIds.add(scenario.id);
    if (!isNeedList(scenario.needs)) return `scenario \`${scenario.id}\` holds \`needs\` that is not a list of strings`;
    if (isRecord(scenario.cells)) {
      for (const [capabilityId, cell] of Object.entries(scenario.cells)) {
        if (isRecord(cell) && !isNeedList(cell.needs)) return `cell \`${scenario.id}/${capabilityId}\` holds \`needs\` that is not a list of strings`;
      }
    }
  }
  for (const capability of data.capabilities as Array<Record<string, unknown>>) {
    if (isRecord(capability.default) && !isNeedList(capability.default.needs)) {
      return `capability \`${capability.id}\` default holds \`needs\` that is not a list of strings`;
    }
  }
  if (data.layers !== undefined) {
    if (!Array.isArray(data.layers)) return '`layers` is not an array';
    for (const layer of data.layers) {
      if (!isRecord(layer) || typeof layer.field !== 'string' || typeof layer.table !== 'string') {
        return 'a `layers` entry is not `{ "field": "<scenario field>", "table": "<top-level key>" }`';
      }
      const table = data[layer.table];
      if (!isRecord(table)) return `layer table \`${layer.table}\` is not a top-level object`;
      for (const [key, entry] of Object.entries(table)) {
        if (!isRecord(entry)) continue;
        for (const [capabilityId, cell] of Object.entries(entry)) {
          if (isRecord(cell) && !isNeedList(cell.needs)) return `layer \`${layer.table}.${key}.${capabilityId}\` holds \`needs\` that is not a list of strings`;
        }
      }
    }
  }
  return undefined;
}

function standingOf(value: unknown): CellStanding {
  return (CELL_STANDINGS as readonly unknown[]).includes(value) ? value as CellStanding : 'unmeasured';
}

/** The cell layered as the file defines it: capability default, each layer table in order, the scenario's own cell. */
export function resolveCell(matrix: MatrixFile, scenario: MatrixScenario | string, capability: MatrixCapability | string): ResolvedCell | undefined {
  const row = typeof scenario === 'string' ? matrix.scenarios.find(s => s.id === scenario) : scenario;
  const column = typeof capability === 'string' ? matrix.capabilities.find(c => c.id === capability) : capability;
  if (!row || !column) return undefined;

  const stack: Array<[CellLayerName, unknown]> = [['capability', column.default]];
  for (const layer of matrix.layers ?? []) {
    const key = row[layer.field];
    const table = matrix[layer.table];
    if (typeof key !== 'string' || !isRecord(table)) continue;
    const entry = table[key];
    if (isRecord(entry)) stack.push([`${layer.table}.${key}`, entry[column.id]]);
  }
  stack.push(['row', { needs: row.needs }]);
  stack.push(['scenario', row.cells?.[column.id]]);

  const cell: Omit<MatrixCell, 'needs'> = {};
  const from: ResolvedCell['from'] = {};
  const needs: CellNeed[] = [];
  for (const [layerName, values] of stack) {
    if (!isRecord(values)) continue;
    for (const field of CELL_FIELDS) {
      if (values[field] === undefined) continue;
      (cell as Record<string, unknown>)[field] = values[field];
      from[field] = layerName;
    }
    if (!Array.isArray(values.needs)) continue;
    for (const ref of values.needs) {
      if (typeof ref === 'string' && !needs.some(need => need.ref === ref)) needs.push({ ref, from: layerName });
    }
  }
  return { ...cell, scenario: row.id, capability: column.id, today: standingOf(cell.today), from, ...(needs.length > 0 && { needs }) };
}

function emptyCounts(): StandingCounts {
  return { works: 0, gap: 0, unmeasured: 0, 'n/a': 0 };
}

export function countStandings(matrix: MatrixFile): StandingCounts {
  const counts = emptyCounts();
  for (const scenario of matrix.scenarios) {
    for (const capability of matrix.capabilities) counts[resolveCell(matrix, scenario, capability)!.today]++;
  }
  return counts;
}

// =============================================================================
// In-memory index + watcher
// =============================================================================

interface MatrixEntry {
  name: string;
  filePath: string;
  raw: string;
  matrix?: MatrixFile;
  problem?: string;
}

let index: Map<string, MatrixEntry> | null = null;
let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const RELOAD_DEBOUNCE_MS = 250;
const listeners = new Set<MatrixChangeListener>();
let writing: Promise<unknown> = Promise.resolve();

export function getMatrixDir(): string {
  return getOutputPath('matrix');
}

function fileFor(name: string): string {
  return join(getMatrixDir(), `${name}.json`);
}

/** One field of one cell, as it resolved before a change and after it; an absent side held no value. */
export interface MatrixCellChange {
  scenario: string;
  capability: string;
  /** `needs` changes log the list joined with `, `. */
  field: CellField | 'needs';
  from?: string;
  to?: string;
}

/** The channel a change came in on: the bench, a session's tool call, the CLI, or a write to the file from outside devharness. */
export type MatrixActivitySource = 'bench' | 'session' | 'cli' | 'file';

/** One change to a matrix, as its activity log holds it. */
export interface MatrixActivityEntry {
  at: string;
  by: MatrixActivitySource;
  cause: 'edit' | 'import' | 'file' | 'removed';
  changes: MatrixCellChange[];
  /** What changed beside cell values: rows and columns that came or went, an import's source, a file that stopped parsing. */
  notes?: string[];
  /** Hash of the file's text after the change; two entries with one hash record one change. */
  after?: string;
}

const hashOf = (raw: string): string => createHash('sha1').update(raw).digest('hex').slice(0, 12);

function activityFile(name: string): string {
  return join(getMatrixDir(), 'activity', `${name}.jsonl`);
}

async function loggedActivity(name: string): Promise<MatrixActivityEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(activityFile(name), 'utf-8');
  } catch {
    return [];
  }
  const entries: MatrixActivityEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as MatrixActivityEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

async function appendActivity(name: string, entry: MatrixActivityEntry): Promise<void> {
  try {
    await fs.mkdir(dirname(activityFile(name)), { recursive: true });
    await fs.appendFile(activityFile(name), JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[devharness] Failed to append matrix activity for ${name}:`, err);
  }
}

/**
 * The changes to one matrix, newest first. Every devharness process watching
 * the store logs a file change it did not make itself, so entries sharing an
 * `after` hash collapse to one, the entry of the process that made the write
 * kept over a `file` entry.
 */
export async function readMatrixActivity(name: string, limit = 200): Promise<MatrixActivityEntry[]> {
  const kept: MatrixActivityEntry[] = [];
  const byHash = new Map<string, number>();
  for (const entry of await loggedActivity(name)) {
    const at = entry.after === undefined ? undefined : byHash.get(entry.after);
    if (at === undefined) {
      if (entry.after !== undefined) byHash.set(entry.after, kept.length);
      kept.push(entry);
    } else if (kept[at].by === 'file' && entry.by !== 'file') {
      kept[at] = entry;
    }
  }
  return kept.reverse().slice(0, limit);
}

/** The joined list of a cell's needs, or undefined for a cell holding none. */
function needsText(cell: ResolvedCell): string | undefined {
  return cell.needs?.map(need => need.ref).join(', ');
}

/** Each field, and the needs list, that resolves differently in `now`. */
function cellChanges(was: ResolvedCell, now: ResolvedCell): MatrixCellChange[] {
  const at = { scenario: now.scenario, capability: now.capability };
  const changes: MatrixCellChange[] = CELL_FIELDS
    .filter(field => was[field] !== now[field])
    .map(field => ({ ...at, field, from: was[field], to: now[field] }));
  if (needsText(was) !== needsText(now)) changes.push({ ...at, field: 'needs', from: needsText(was), to: needsText(now) });
  return changes;
}

/** The cell fields that resolve differently in `after`, and the rows and columns that came or went. */
function matrixDifference(before: MatrixFile, after: MatrixFile): { changes: MatrixCellChange[]; notes: string[] } {
  const changes: MatrixCellChange[] = [];
  const notes: string[] = [];
  const ids = (list: Array<{ id: string }>) => new Set(list.map(each => each.id));
  const [rowsBefore, rowsAfter] = [ids(before.scenarios), ids(after.scenarios)];
  const [columnsBefore, columnsAfter] = [ids(before.capabilities), ids(after.capabilities)];
  for (const id of rowsAfter) if (!rowsBefore.has(id)) notes.push(`scenario ${id} added`);
  for (const id of rowsBefore) if (!rowsAfter.has(id)) notes.push(`scenario ${id} removed`);
  for (const id of columnsAfter) if (!columnsBefore.has(id)) notes.push(`capability ${id} added`);
  for (const id of columnsBefore) if (!columnsAfter.has(id)) notes.push(`capability ${id} removed`);
  for (const scenario of after.scenarios) {
    if (!rowsBefore.has(scenario.id)) continue;
    for (const capability of after.capabilities) {
      if (!columnsBefore.has(capability.id)) continue;
      const was = resolveCell(before, scenario.id, capability.id);
      const now = resolveCell(after, scenario, capability);
      if (!was || !now) continue;
      changes.push(...cellChanges(was, now));
    }
  }
  return { changes, notes };
}

/**
 * Logs a file change the watcher found. A change already logged under the
 * same `after` hash, by the process that wrote it, is left as it stands.
 */
async function logFileChange(name: string, before: MatrixEntry | undefined, after: MatrixEntry): Promise<void> {
  const hash = hashOf(after.raw);
  if ((await loggedActivity(name)).some(entry => entry.after === hash)) return;
  const at = new Date().toISOString();
  if (!after.matrix) {
    await appendActivity(name, { at, by: 'file', cause: 'file', changes: [], notes: [`the file stopped reading: ${after.problem ?? 'unreadable'}`], after: hash });
    return;
  }
  if (!before?.matrix) {
    await appendActivity(name, { at, by: 'file', cause: 'file', changes: [], notes: [before ? 'the file reads again' : 'the file appeared in the store'], after: hash });
    return;
  }
  const { changes, notes } = matrixDifference(before.matrix, after.matrix);
  if (changes.length === 0 && notes.length === 0) notes.push('the file changed with no cell, row or column differing');
  await appendActivity(name, { at, by: 'file', cause: 'file', changes, ...(notes.length > 0 && { notes }), after: hash });
}

/** Subscribes to every matrix change, on disk or through setCell/importMatrix; returns the unsubscribe. */
export function onMatrixChange(listener: MatrixChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(change: MatrixChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      console.error('[devharness] Matrix change listener failed:', err);
    }
  }
}

function resetIndexState(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  index = null;
}

/** Test-only: drops the cache and closes the watcher, so the next read rescans from disk. */
export function __resetForTests(): void {
  resetIndexState();
  listeners.clear();
}

// A root relocation moves getMatrixDir(); a cache and watcher bound to the
// old root would otherwise keep serving it.
registerRootBound({
  name: 'matrix-store',
  rebind: () => resetIndexState(),
});

function entryFromRaw(name: string, filePath: string, raw: string): MatrixEntry {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { name, filePath, raw, problem: `invalid JSON: ${(err as Error).message}` };
  }
  const problem = matrixShapeProblem(data);
  return problem ? { name, filePath, raw, problem } : { name, filePath, raw, matrix: data as MatrixFile };
}

async function scanMatrixDir(): Promise<Map<string, MatrixEntry>> {
  const dir = getMatrixDir();
  const map = new Map<string, MatrixEntry>();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return map;
  }
  for (const entry of entries.sort()) {
    if (extname(entry) !== '.json') continue;
    const name = basename(entry, '.json');
    if (!isMatrixName(name)) continue;
    const filePath = join(dir, entry);
    try {
      map.set(name, entryFromRaw(name, filePath, await fs.readFile(filePath, 'utf-8')));
    } catch (err) {
      console.error(`[devharness] Failed to read matrix file ${entry}:`, err);
    }
  }
  return map;
}

async function reloadIndex(): Promise<void> {
  let fresh: Map<string, MatrixEntry>;
  try {
    fresh = await scanMatrixDir();
  } catch (err) {
    console.error('[devharness] Matrix reload failed, keeping previous state:', err);
    return;
  }
  // The first scan of a process has nothing to compare against, so it logs nothing.
  const first = index === null;
  const previous = index ?? new Map<string, MatrixEntry>();
  index = fresh;
  for (const [name, entry] of fresh) {
    if (previous.get(name)?.raw === entry.raw) continue;
    if (!first) await logFileChange(name, previous.get(name), entry);
    emit({ name, cause: 'disk' });
  }
  for (const name of previous.keys()) {
    if (fresh.has(name)) continue;
    await appendActivity(name, { at: new Date().toISOString(), by: 'file', cause: 'removed', changes: [], notes: ['the file left the store'] });
    emit({ name, cause: 'removed' });
  }
}

function startWatcher(): void {
  if (watcher) return;
  try {
    watcher = fsWatch(getMatrixDir(), () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reloadIndex();
      }, RELOAD_DEBOUNCE_MS);
    });
  } catch {
    // Not watchable on this filesystem: edits made outside devharness reach the cache on the next rebind only.
  }
}

async function ensureIndexLoaded(): Promise<Map<string, MatrixEntry>> {
  if (index) return index;
  await fs.mkdir(getMatrixDir(), { recursive: true });
  index = await scanMatrixDir();
  startWatcher();
  return index;
}

/** Runs writes one after another, so two edits never read the same file before either writes. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work, work);
  writing = next.catch(() => {});
  return next;
}

// =============================================================================
// Public API
// =============================================================================

export async function listMatrices(): Promise<MatrixSummary[]> {
  const entries = await ensureIndexLoaded();
  return [...entries.values()].map(entry => entry.matrix
    ? {
        name: entry.name,
        about: entry.matrix.about,
        scenarios: entry.matrix.scenarios.length,
        capabilities: entry.matrix.capabilities.length,
        cells: countStandings(entry.matrix),
      }
    : { name: entry.name, scenarios: 0, capabilities: 0, cells: emptyCounts(), problem: entry.problem });
}

export type MatrixReadResult =
  | { ok: true; name: string; matrix: MatrixFile }
  | { ok: false; reason: 'missing'; name: string; valid: string[] }
  | { ok: false; reason: 'broken'; name: string; problem: string };

/** The matrix `name`, or the only matrix in the store when `name` is absent. */
export async function readMatrix(name?: string): Promise<MatrixReadResult> {
  const entries = await ensureIndexLoaded();
  const valid = [...entries.keys()];
  const chosen = name ?? (valid.length === 1 ? valid[0] : undefined);
  const entry = chosen === undefined ? undefined : entries.get(chosen);
  if (!entry) return { ok: false, reason: 'missing', name: name ?? '', valid };
  if (!entry.matrix) return { ok: false, reason: 'broken', name: entry.name, problem: entry.problem ?? 'unreadable' };
  return { ok: true, name: entry.name, matrix: entry.matrix };
}

/** A field set to null is taken off the scenario's own cell, so the layer beneath shows through. `needs` replaces the cell's own list. */
export type CellPatch = { [F in CellField]?: (F extends 'today' ? CellStanding : string) | null } & { needs?: string[] | null };

/**
 * Runs on the matrix as a write would leave it, before anything reaches the
 * disk; a returned refusal stops the write and comes back in the result.
 */
export type MatrixWriteCheck<R> = (name: string, matrix: MatrixFile) => Promise<R | undefined>;

export type SetCellResult<R = never> =
  | { ok: true; cell: ResolvedCell; previous: ResolvedCell }
  | { ok: false; reason: 'matrix' | 'scenario' | 'capability' | 'today'; valid: string[] }
  | { ok: false; reason: 'broken'; problem: string }
  | { ok: false; reason: 'refused'; refusal: R };

/**
 * Writes the patch onto `scenario.cells[capability]` and saves the file
 * atomically. Default tables stay as they are: a value set here overrides them
 * for this one cell. The file is read from disk at write time, so an edit made
 * outside devharness inside the watcher's debounce window is kept.
 */
export function setCell<R = never>(
  name: string, scenarioId: string, capabilityId: string, patch: CellPatch,
  by: MatrixActivitySource = 'session', check?: MatrixWriteCheck<R>,
): Promise<SetCellResult<R>> {
  return serialized(async () => {
    const entries = await ensureIndexLoaded();
    if (!entries.has(name)) return { ok: false, reason: 'matrix', valid: [...entries.keys()] };
    if (patch.today !== undefined && patch.today !== null && !CELL_STANDINGS.includes(patch.today)) {
      return { ok: false, reason: 'today', valid: [...CELL_STANDINGS] };
    }

    const filePath = fileFor(name);
    const entry = entryFromRaw(name, filePath, await fs.readFile(filePath, 'utf-8'));
    if (!entry.matrix) return { ok: false, reason: 'broken', problem: entry.problem ?? 'unreadable' };
    const matrix = entry.matrix;
    const scenario = matrix.scenarios.find(s => s.id === scenarioId);
    if (!scenario) return { ok: false, reason: 'scenario', valid: matrix.scenarios.map(s => s.id) };
    const capability = matrix.capabilities.find(c => c.id === capabilityId);
    if (!capability) return { ok: false, reason: 'capability', valid: matrix.capabilities.map(c => c.id) };

    const previous = resolveCell(matrix, scenario, capability)!;
    const own: Record<string, unknown> = { ...(scenario.cells?.[capabilityId] ?? {}) };
    for (const field of CELL_FIELDS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) delete own[field];
      else own[field] = value;
    }
    if (patch.needs === null || (patch.needs !== undefined && patch.needs.length === 0)) delete own.needs;
    else if (patch.needs !== undefined) own.needs = [...new Set(patch.needs)];
    const cells = { ...(scenario.cells ?? {}) };
    if (Object.keys(own).length > 0) cells[capabilityId] = own as MatrixCell;
    else delete cells[capabilityId];
    if (Object.keys(cells).length > 0) scenario.cells = cells;
    else delete scenario.cells;

    const refusal = check ? await check(name, matrix) : undefined;
    if (refusal !== undefined) return { ok: false, reason: 'refused', refusal };

    const raw = JSON.stringify(matrix, null, 2) + '\n';
    await atomicWriteFile(filePath, raw);
    entries.set(name, { name, filePath, raw, matrix });
    const cell = resolveCell(matrix, scenario, capability)!;
    const changes = cellChanges(previous, cell);
    if (changes.length > 0) await appendActivity(name, { at: new Date().toISOString(), by, cause: 'edit', changes, after: hashOf(raw) });
    emit({ name, cause: 'edit', cell: { scenario: scenarioId, capability: capabilityId } });
    return { ok: true, cell, previous };
  });
}

/** Every matrix in the store, in name order, each with its file or the reason it does not read. */
export async function allMatrices(): Promise<Array<{ name: string; matrix?: MatrixFile; problem?: string }>> {
  const entries = await ensureIndexLoaded();
  return [...entries.values()]
    .map(entry => ({ name: entry.name, ...(entry.matrix ? { matrix: entry.matrix } : { problem: entry.problem ?? 'unreadable' }) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ImportResult<R = never> =
  | { ok: true; name: string; filePath: string; source: string; replaced: boolean; summary: MatrixSummary }
  | { ok: false; reason: 'unreadable' | 'shape' | 'name' | 'exists'; name?: string; source: string; problem: string }
  | { ok: false; reason: 'refused'; name: string; source: string; refusal: R };

/**
 * The store name a source file takes when no name is given: its file name
 * without `.json`, or its folder's name for a file named `matrix.json`.
 */
export function defaultImportName(sourcePath: string): string {
  const stem = basename(sourcePath, extname(sourcePath));
  return stem === 'matrix' ? basename(dirname(resolve(sourcePath))) : stem;
}

/** Copies a matrix file into the store. A relative path resolves against the project directory. */
export function importMatrix<R = never>(
  sourcePath: string,
  options: { name?: string; overwrite?: boolean; by?: MatrixActivitySource; check?: MatrixWriteCheck<R> } = {},
): Promise<ImportResult<R>> {
  return serialized(async () => {
    const source = resolve(getProjectDir(), sourcePath);
    let raw: string;
    try {
      raw = await fs.readFile(source, 'utf-8');
    } catch (err) {
      return { ok: false, reason: 'unreadable', source, problem: (err as Error).message };
    }
    const name = options.name ?? defaultImportName(source);
    if (!isMatrixName(name)) {
      return { ok: false, reason: 'name', name, source, problem: 'a name holds letters, digits, `_`, `-` and `.`, and opens with no `.`' };
    }
    const parsed = entryFromRaw(name, fileFor(name), raw);
    if (!parsed.matrix) return { ok: false, reason: 'shape', name, source, problem: parsed.problem ?? 'unreadable' };

    const entries = await ensureIndexLoaded();
    const replaced = entries.has(name);
    if (replaced && !options.overwrite) {
      return { ok: false, reason: 'exists', name, source, problem: `\`${name}\` is already in the store` };
    }
    const refusal = options.check ? await options.check(name, parsed.matrix) : undefined;
    if (refusal !== undefined) return { ok: false, reason: 'refused', name, source, refusal };
    const replacedMatrix = entries.get(name)?.matrix;
    await atomicWriteFile(parsed.filePath, raw);
    entries.set(name, parsed);
    const difference = replacedMatrix ? matrixDifference(replacedMatrix, parsed.matrix) : { changes: [], notes: [] };
    await appendActivity(name, {
      at: new Date().toISOString(), by: options.by ?? 'session', cause: 'import', changes: difference.changes,
      notes: [`imported from ${sourcePath}${replaced ? ', replacing the store entry' : ''}`, ...difference.notes], after: hashOf(raw),
    });
    emit({ name, cause: 'import' });
    return {
      ok: true,
      name,
      filePath: parsed.filePath,
      source,
      replaced,
      summary: {
        name,
        about: parsed.matrix.about,
        scenarios: parsed.matrix.scenarios.length,
        capabilities: parsed.matrix.capabilities.length,
        cells: countStandings(parsed.matrix),
      },
    };
  });
}
