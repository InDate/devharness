/**
 * Matrix Tools
 * The capability matrices in .devharness/matrix/: list, read resolved cells, edit one cell, next cell, import.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, type MCPResponse } from '../messages.js';
import type { MatrixToolMeta } from '../tool-response.js';
import {
  CELL_FIELDS,
  CELL_STANDINGS,
  formatMatrixRef,
  importMatrix,
  matrixLinkKind,
  parseMatrixRef,
  refCoversCell,
  listMatrices,
  nextCell,
  readMatrix,
  readMatrixActivity,
  resolveCell,
  setCell,
  countStandings,
  type CellPatch,
  type CellStanding,
  type MatrixCapability,
  type MatrixFile,
  type MatrixIssueLink,
  type MatrixActivityEntry,
  type MatrixActivitySource,
  type MatrixRef,
  type MatrixScenario,
  type ResolvedCell,
  type StandingCounts,
} from '../matrix-store.js';
import { issuesLinkedTo, isCompletedStatus } from '../issue-tracker.js';
import { originChannel } from '../call-origin.js';

const nullableText = z.string().nullable().optional();

const matrixSchema = z.object({
  action: z.enum(['list', 'read', 'edit', 'next', 'import', 'activity']),
  matrix: z.string().optional()
    .describe('Matrix name; may be left out while the store holds one matrix'),
  scenario: z.string().optional()
    .describe('read: that row in full. edit: required'),
  capability: z.string().optional()
    .describe('read: that column in full. edit: required'),
  today: z.string().nullable().optional()
    .describe('works | gap | unmeasured | n/a. read: cells at that standing. edit: the new standing'),
  expect: nullableText.describe('edit: what devharness is expected to do in this cell'),
  basis: nullableText.describe('edit: `code` or `sequence:<name>`'),
  note: nullableText.describe('edit: the note. On edit, null on any field takes it off the cell so the default shows'),
  path: z.string().optional()
    .describe('import: matrix JSON file, relative to the project directory'),
  name: z.string().optional()
    .describe('import: store name (default: the file name, or its folder for matrix.json)'),
  overwrite: z.boolean().optional()
    .describe('import: replace a store entry of the same name'),
  issues: z.boolean().optional()
    .describe('read: false leaves out the linked issues'),
  limit: z.number().int().positive().max(200).optional()
    .describe('activity: newest N changes (default 20)'),
}).strict();

type MatrixArgs = z.infer<typeof matrixSchema>;

function withMeta(response: MCPResponse, meta: MatrixToolMeta): MCPResponse {
  response._meta = { tool: 'matrix', action: meta.action, timestamp: Date.now(), matrix: meta };
  return response;
}

function countsLine(counts: StandingCounts): string {
  return CELL_STANDINGS.map(standing => `${counts[standing]} ${standing}`).join(' · ');
}

function isStanding(value: string): value is CellStanding {
  return (CELL_STANDINGS as readonly string[]).includes(value);
}

function unknownId(kind: string, value: string, valid: string[]): MCPResponse {
  return createErrorResponse('MATRIX_UNKNOWN_ID', { kind, value, valid: valid.join(', ') });
}

function missing(action: string, fields: string): MCPResponse {
  return createErrorResponse('MISSING_PARAMETER', { missing: fields, action });
}

/** The matrix a call names, or the error naming the matrices the store holds. */
async function chooseMatrix(name: string | undefined): Promise<{ name: string; matrix: MatrixFile } | MCPResponse> {
  const read = await readMatrix(name);
  if (read.ok) return { name: read.name, matrix: read.matrix };
  if (read.reason === 'broken') return createErrorResponse('MATRIX_BROKEN', { name: read.name, problem: read.problem });
  return createErrorResponse('MATRIX_NOT_FOUND', {
    name: name ?? '',
    valid: read.valid.join(', '),
    empty: read.valid.length === 0,
  });
}

function layerFields(matrix: MatrixFile, scenario: MatrixScenario): string {
  return (matrix.layers ?? []).map(layer => `${layer.field}: ${String(scenario[layer.field] ?? '-')}`).join(' · ');
}

/** One resolved cell as Markdown lines; fields from a layer other than the scenario's own cell name that layer. */
function renderCell(cell: ResolvedCell, heading: string, omitFrom?: string): string {
  const lines = [`**${heading}**: ${cell.today}${cell.from.today && cell.from.today !== 'scenario' ? ` _(${cell.from.today})_` : ''}`];
  for (const field of CELL_FIELDS) {
    if (field === 'today' || cell[field] === undefined) continue;
    const layer = cell.from[field];
    if (omitFrom !== undefined && layer === omitFrom) continue;
    lines.push(`- ${field}: ${cell[field]}${layer && layer !== 'scenario' ? ` _(${layer})_` : ''}`);
  }
  return lines.join('\n');
}

type LinkedIssues = Awaited<ReturnType<typeof issuesLinkedTo>>;

/** One entry per ref of these issues that the test holds for. */
function linksWhere(linked: LinkedIssues, test: (ref: MatrixRef) => boolean): MatrixIssueLink[] {
  const links: MatrixIssueLink[] = [];
  for (const { issue, refs } of linked) {
    for (const ref of refs) {
      const parsed = parseMatrixRef(ref);
      if (!parsed || !test(parsed)) continue;
      links.push({
        id: issue.id,
        type: issue.type,
        status: issue.status,
        title: issue.title,
        completed: isCompletedStatus(issue.status),
        link: matrixLinkKind(parsed),
        ref,
      });
    }
  }
  return links;
}

/** The links whose area holds the cell: the cell itself, its row or its column. */
function linksForCell(linked: LinkedIssues, scenarioId: string, capabilityId: string): MatrixIssueLink[] {
  return linksWhere(linked, ref => refCoversCell(ref, scenarioId, capabilityId));
}

function issueLine(link: MatrixIssueLink): string {
  return `- #${link.id} ${link.type} ${link.status}${link.completed ? ' (completed)' : ''}, ${link.link} link: ${link.title}`;
}

function issueBlock(links: MatrixIssueLink[], heading: string): string {
  return links.length > 0 ? `\n${heading}:\n${links.map(issueLine).join('\n')}` : '';
}

function scenarioTitle(scenario: MatrixScenario): string {
  return scenario.name ? `${scenario.id} (${scenario.name})` : scenario.id;
}

function capabilityHeader(capability: MatrixCapability): string {
  const lines = [`**${capability.name ?? capability.id}** (\`${capability.id}\`)`];
  if (capability.question) lines.push(`Question: ${capability.question}`);
  if (capability.rule) lines.push(`Rule: ${capability.rule}`);
  if (capability.default) {
    for (const field of CELL_FIELDS) {
      if (capability.default[field] !== undefined) lines.push(`Default ${field}: ${capability.default[field]}`);
    }
  }
  return lines.join('\n');
}

async function handleRead(args: MatrixArgs): Promise<MCPResponse> {
  const chosen = await chooseMatrix(args.matrix);
  if ('content' in chosen) return chosen;
  const { name, matrix } = chosen;

  const scenario = args.scenario === undefined ? undefined : matrix.scenarios.find(s => s.id === args.scenario);
  if (args.scenario !== undefined && !scenario) return unknownId('scenario', args.scenario, matrix.scenarios.map(s => s.id));
  const capability = args.capability === undefined ? undefined : matrix.capabilities.find(c => c.id === args.capability);
  if (args.capability !== undefined && !capability) return unknownId('capability', args.capability, matrix.capabilities.map(c => c.id));
  if (args.today !== undefined && args.today !== null && !isStanding(args.today)) {
    return unknownId('`today` value', args.today, [...CELL_STANDINGS]);
  }
  const today = args.today ?? undefined;
  const kept = (cell: ResolvedCell) => today === undefined || cell.today === today;

  const rows = scenario ? [scenario] : matrix.scenarios;
  const columns = capability ? [capability] : matrix.capabilities;
  const cells = rows.flatMap(row => columns.map(column => resolveCell(matrix, row, column)!)).filter(kept);
  const ref = formatMatrixRef({ matrix: name, scenario: scenario?.id, capability: capability?.id });
  const linked = args.issues === false ? undefined : await issuesLinkedTo(name);

  if (!scenario && !capability) {
    const openOnRow = (rowId: string) => linked === undefined ? undefined : linked
      .filter(({ issue, refs }) => !isCompletedStatus(issue.status) && refs.some(r => parseMatrixRef(r)?.scenario === rowId))
      .length;
    const summary = matrix.scenarios.map(row => {
      const standings: Partial<Record<CellStanding, string[]>> = {};
      for (const column of matrix.capabilities) {
        const cell = resolveCell(matrix, row, column)!;
        if (kept(cell)) (standings[cell.today] ??= []).push(column.id);
      }
      return { scenario: row.id, title: scenarioTitle(row), standings, openIssues: openOnRow(row.id) };
    }).filter(row => Object.keys(row.standings).length > 0);
    const lines = summary.map(row => `- ${row.title}: ${CELL_STANDINGS
      .filter(standing => row.standings[standing])
      .map(standing => `${standing} ${row.standings[standing]!.join(', ')}`)
      .join(' · ')}${row.openIssues ? ` · ${row.openIssues} open issue${row.openIssues === 1 ? '' : 's'}` : ''}`);
    const columnIssues = linked && linksWhere(linked, ref => matrixLinkKind(ref) === 'column');
    const columnLine = columnIssues && columnIssues.length > 0
      ? `\nIssues on whole columns: ${columnIssues.map(link => `#${link.id} on ${parseMatrixRef(link.ref)!.capability}${link.completed ? ' (completed)' : ''}`).join(', ')}`
      : '';
    return withMeta(createSuccessResponse('MATRIX_READ', {
      ref,
      about: matrix.about,
      header: `${matrix.scenarios.length} scenarios × ${matrix.capabilities.length} capabilities: ${countsLine(countStandings(matrix))}`,
      body: (lines.length > 0 ? lines.join('\n') : `No cell reads ${today}.`) + columnLine,
      whole: true,
    }), {
      action: 'read',
      name,
      counts: countStandings(matrix),
      rows: summary.map(({ scenario: id, standings, openIssues }) => ({ scenario: id, standings, ...(openIssues !== undefined && { openIssues }) })),
      ...(columnIssues && { columnIssues }),
    });
  }

  const cellIssues = linked && cells.map(cell => ({
    scenario: cell.scenario,
    capability: cell.capability,
    issues: linksForCell(linked, cell.scenario, cell.capability),
  }));
  const shownFor = (cell: ResolvedCell, except?: 'row' | 'column') => issueBlock(
    (cellIssues?.find(c => c.scenario === cell.scenario && c.capability === cell.capability)?.issues ?? [])
      .filter(link => link.link !== except),
    'Issues',
  );

  let header: string;
  let body: string;
  if (scenario && capability) {
    header = `${scenarioTitle(scenario)} · ${capability.name ?? capability.id}${layerFields(matrix, scenario) ? `\n${layerFields(matrix, scenario)}` : ''}`;
    body = cells.length > 0 ? renderCell(cells[0], capability.id) + shownFor(cells[0]) : `The cell reads ${resolveCell(matrix, scenario, capability)!.today}, not ${today}.`;
  } else if (scenario) {
    const rowLinks = linked ? linksWhere(linked, ref => matrixLinkKind(ref) === 'row' && ref.scenario === scenario.id) : [];
    header = [scenarioTitle(scenario), layerFields(matrix, scenario)].filter(Boolean).join('\n') + issueBlock(rowLinks, 'Issues on this row');
    body = cells.length > 0 ? cells.map(cell => renderCell(cell, cell.capability) + shownFor(cell, 'row')).join('\n') : `No cell of this scenario reads ${today}.`;
  } else {
    const columnLinks = linked ? linksWhere(linked, ref => matrixLinkKind(ref) === 'column' && ref.capability === capability!.id) : [];
    header = capabilityHeader(capability!) + issueBlock(columnLinks, 'Issues on this column');
    body = cells.length > 0
      ? cells.map(cell => renderCell(cell, cell.scenario, 'capability') + shownFor(cell, 'column')).join('\n')
      : `No cell of this capability reads ${today}.`;
  }
  return withMeta(createSuccessResponse('MATRIX_READ', { ref, header, body, whole: false }), {
    action: 'read',
    name,
    cells,
    ...(cellIssues && { cellIssues }),
  });
}

async function handleEdit(args: MatrixArgs): Promise<MCPResponse> {
  const absent = [args.scenario === undefined && 'scenario', args.capability === undefined && 'capability'].filter(Boolean);
  if (absent.length > 0) return missing('edit', absent.join(', '));
  const patch: CellPatch = {};
  if (args.today !== undefined) {
    if (args.today !== null && !isStanding(args.today)) return unknownId('`today` value', args.today, [...CELL_STANDINGS]);
    patch.today = args.today;
  }
  if (args.expect !== undefined) patch.expect = args.expect;
  if (args.basis !== undefined) patch.basis = args.basis;
  if (args.note !== undefined) patch.note = args.note;
  if (Object.keys(patch).length === 0) return createErrorResponse('MATRIX_EDIT_EMPTY', {});

  const chosen = await chooseMatrix(args.matrix);
  if ('content' in chosen) return chosen;
  const result = await setCell(chosen.name, args.scenario!, args.capability!, patch, sourceOfCall());
  if (!result.ok) {
    if (result.reason === 'broken') return createErrorResponse('MATRIX_BROKEN', { name: chosen.name, problem: result.problem });
    const value = result.reason === 'matrix' ? chosen.name
      : result.reason === 'scenario' ? args.scenario!
      : result.reason === 'capability' ? args.capability!
      : String(args.today);
    return unknownId(result.reason, value, result.valid);
  }
  const ref = formatMatrixRef({ matrix: chosen.name, scenario: args.scenario, capability: args.capability });
  return withMeta(createSuccessResponse('MATRIX_EDIT', {
    ref,
    before: renderCell(result.previous, 'Before'),
    after: renderCell(result.cell, 'After'),
  }), { action: 'edit', name: chosen.name, cell: result.cell, previous: result.previous });
}

/** The channel this call arrived on, as the activity log names it. */
function sourceOfCall(): MatrixActivitySource {
  const channel = originChannel();
  return channel === 'bench' ? 'bench' : channel === 'cli' ? 'cli' : 'session';
}

const shown = (value: string | undefined): string => (value === undefined ? 'nothing' : `"${value.length > 80 ? `${value.slice(0, 80)}…` : value}"`);

function activityLines(entry: MatrixActivityEntry): string {
  const lines = [
    ...(entry.notes ?? []),
    ...entry.changes.slice(0, 12).map(change => `${change.scenario}/${change.capability} ${change.field}: ${shown(change.from)} → ${shown(change.to)}`),
    ...(entry.changes.length > 12 ? [`and ${entry.changes.length - 12} more cell values`] : []),
  ];
  return `- ${entry.at} · ${entry.by}${entry.cause === 'edit' ? '' : ` · ${entry.cause}`}\n${lines.map(line => `  - ${line}`).join('\n')}`;
}

async function handleActivity(args: MatrixArgs): Promise<MCPResponse> {
  const chosen = await chooseMatrix(args.matrix);
  if ('content' in chosen) return chosen;
  const entries = await readMatrixActivity(chosen.name, args.limit ?? 20);
  return withMeta(createSuccessResponse('MATRIX_ACTIVITY', {
    name: chosen.name,
    empty: entries.length === 0,
    count: entries.length,
    list: entries.map(activityLines).join('\n'),
  }), { action: 'activity', name: chosen.name, activity: entries });
}

async function handleNext(args: MatrixArgs): Promise<MCPResponse> {
  if (args.matrix !== undefined) {
    const chosen = await chooseMatrix(args.matrix);
    if ('content' in chosen) return chosen;
  }
  const next = await nextCell(args.matrix);
  if (!next) {
    return withMeta(createSuccessResponse('MATRIX_NEXT_NONE', { scope: args.matrix ?? 'any matrix' }), {
      action: 'next',
      name: args.matrix,
      next: null,
    });
  }
  const nextIssues = linksForCell(await issuesLinkedTo(next.matrix), next.scenario.id, next.capability.id);
  return withMeta(createSuccessResponse('MATRIX_NEXT', {
    ref: next.ref,
    matrix: next.matrix,
    scenarioId: next.scenario.id,
    capabilityId: next.capability.id,
    scenario: scenarioTitle(next.scenario),
    capability: next.capability.name ?? next.capability.id,
    question: next.capability.question,
    rule: next.capability.rule,
    cell: renderCell(next.cell, 'Cell') + issueBlock(nextIssues, 'Issues'),
    gap: next.remaining.gap,
    unmeasured: next.remaining.unmeasured,
  }), {
    action: 'next',
    name: next.matrix,
    next: {
      ref: next.ref,
      scenario: next.scenario.id,
      capability: next.capability.id,
      cell: next.cell,
      remaining: next.remaining,
      issues: nextIssues,
    },
  });
}

async function handleImport(args: MatrixArgs): Promise<MCPResponse> {
  if (!args.path) return missing('import', 'path');
  const result = await importMatrix(args.path, { name: args.name, overwrite: args.overwrite, by: sourceOfCall() });
  if (!result.ok) {
    return createErrorResponse('MATRIX_IMPORT_REFUSED', {
      source: result.source,
      problem: result.problem,
      exists: result.reason === 'exists',
      path: args.path,
      name: result.name ?? '',
    });
  }
  return withMeta(createSuccessResponse('MATRIX_IMPORT', {
    name: result.name,
    source: result.source,
    filePath: result.filePath,
    replaced: result.replaced,
    scenarios: result.summary.scenarios,
    capabilities: result.summary.capabilities,
    counts: countsLine(result.summary.cells),
  }), {
    action: 'import',
    name: result.name,
    imported: { filePath: result.filePath, source: result.source, replaced: result.replaced },
    matrices: [result.summary],
  });
}

export function createMatrixTools() {
  return {
    matrix: createTool(
      'Capability matrices: scenarios against capabilities, each cell expected behaviour and how it stands today.',
      matrixSchema,
      async (args) => {
        switch (args.action) {
          case 'list': {
            const matrices = await listMatrices();
            const lines = matrices.map(m => m.problem
              ? `- **${m.name}**: unreadable, ${m.problem}`
              : `- **${m.name}**: ${m.scenarios} scenarios × ${m.capabilities} capabilities, ${countsLine(m.cells)}`);
            return withMeta(createSuccessResponse('MATRIX_LIST', {
              count: matrices.length,
              list: lines.join('\n'),
              empty: matrices.length === 0,
            }), { action: 'list', matrices });
          }
          case 'read':
            return handleRead(args);
          case 'edit':
            return handleEdit(args);
          case 'next':
            return handleNext(args);
          case 'import':
            return handleImport(args);
          case 'activity':
            return handleActivity(args);
        }
      }
    ),
  };
}
