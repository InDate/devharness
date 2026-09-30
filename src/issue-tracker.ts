/**
 * Issue Tracker - persistent bug/feature tracking with one Markdown file
 * per issue (YAML-ish frontmatter + Markdown body + appended comments).
 *
 * Issues are cached in memory after first load and kept fresh via a native
 * fs.watch on the items directory (debounced full rescan) - see
 * ensureIndexLoaded()/startWatcher() below. This mirrors the dependency-free
 * watcher convention used by src/server-watcher.ts.
 */

import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import { join } from 'path';
import { getOutputPath, registerRootBound } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';

// =============================================================================
// Types
// =============================================================================

export type IssueType = 'bug' | 'feature';
export type IssueStatus = 'pending' | 'acknowledged' | 'in_progress' | 'fixed' | 'implemented';

/** GitHub's `stateReason` for a closed issue, copied verbatim (lowercased).
 *  Kept out of IssueStatus: the dashboard hub reads issue files written by
 *  other projects' devharness versions, and a status token an older reader
 *  doesn't know counts a closed issue as active. */
export type IssueClosedReason = 'completed' | 'not_planned' | 'duplicate';

const CLOSED_REASONS: ReadonlySet<string> = new Set(['completed', 'not_planned', 'duplicate']);
const COMPLETED_STATUSES: ReadonlySet<string> = new Set(['fixed', 'implemented']);

/** Whether a status means the issue is closed, whatever the reason. */
export function isCompletedStatus(status: unknown): boolean {
  return typeof status === 'string' && COMPLETED_STATUSES.has(status);
}

/** The closed status for a type - the one open/closed mapping devharness owns. */
export function completedStatusFor(type: IssueType): IssueStatus {
  return type === 'bug' ? 'fixed' : 'implemented';
}

export interface IssueComment {
  timestamp: Date;
  text: string;
}

export interface TrackedIssue {
  id: number;
  type: IssueType;
  status: IssueStatus;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
  sequenceFile: string;
  startUrl: string;
  reportedAt: Date;
  acknowledgedAt?: Date;
  startedAt?: Date;
  resolvedAt?: Date;
  recordingName: string;
  /** Upstream issue number. Its absence is what makes an issue unpublished. */
  github?: number;
  githubRepo?: string;
  closedReason?: IssueClosedReason;
  /** When both sides last agreed - compared against GitHub's updatedAt. */
  githubSyncedAt?: Date;
  /** sha256 of the body at that moment, to detect a local edit since. */
  githubBodyHash?: string;
  /**
   * true: marked for sync. false: left out on purpose, so the bench does not
   * offer it again. Absent: nobody has decided. `issues sync` reads and writes
   * only issues holding true.
   */
  githubSync?: boolean;
  /** Frontmatter keys this version doesn't know, re-emitted verbatim so a
   *  newer field (or a hand-edit) survives a rewrite by an older build. */
  extraFrontmatter?: Record<string, string>;
  /** Absolute path to the issue's .md file on disk. */
  filePath: string;
}

export interface IssueFilter {
  type?: IssueType;
  status?: IssueStatus;
  includeCompleted?: boolean;
  /** Match issues that have ANY of these labels. */
  labels?: string[];
}

// =============================================================================
// File Paths
// =============================================================================

function getIssuesDir(): string {
  return getOutputPath('issues');
}

function getSequencesDir(): string {
  return getOutputPath('issues', 'sequences');
}

function getItemsDir(): string {
  return getOutputPath('issues', 'items');
}

function getLegacyCsvPath(): string {
  return join(getIssuesDir(), 'issues.csv');
}

// =============================================================================
// Frontmatter (restricted YAML subset - bare token / JSON-quoted scalar /
// JSON-quoted array). Valid standard YAML, so the files open correctly in
// Obsidian/Jekyll/gray-matter/js-yaml too - we just never need a parser that
// handles more than what we ourselves write.
// =============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function yamlStringArray(values: string[]): string {
  return `[${values.map(v => JSON.stringify(v)).join(', ')}]`;
}

function parseFrontmatterBlock(block: string): Record<string, any> {
  const result: Record<string, any> = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!rawValue) continue;

    if (rawValue.startsWith('"') || rawValue.startsWith('[')) {
      try {
        result[key] = JSON.parse(rawValue);
      } catch {
        result[key] = rawValue;
      }
    } else if (/^-?\d+$/.test(rawValue)) {
      result[key] = parseInt(rawValue, 10);
    } else {
      result[key] = rawValue; // bare token: enum or ISO date
    }
  }
  return result;
}

/**
 * Pure, I/O-free frontmatter parse - exported for reuse by callers (e.g. the
 * dashboard) that need to read issue metadata from an arbitrary project's
 * directory without going through this module's own path config.
 */
export function parseIssueFrontmatter(raw: string): Record<string, any> | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;
  return parseFrontmatterBlock(match[1]);
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
}

const COMMENT_MARKER_RE = /^<!-- comment: (.+?) -->\r?$/gm;

function parseBodyAndComments(rest: string): { body: string; comments: IssueComment[] } {
  const text = rest.replace(/^\r?\n+/, '');

  const markers: { index: number; timestamp: string }[] = [];
  const re = new RegExp(COMMENT_MARKER_RE.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    markers.push({ index: match.index, timestamp: match[1] });
  }

  if (markers.length === 0) {
    return { body: text.trimEnd(), comments: [] };
  }

  const body = text.slice(0, markers[0].index).trimEnd();
  const comments: IssueComment[] = [];
  for (let i = 0; i < markers.length; i++) {
    const lineEnd = text.indexOf('\n', markers[i].index);
    const start = lineEnd === -1 ? text.length : lineEnd + 1;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    comments.push({
      timestamp: parseDate(markers[i].timestamp) || new Date(),
      text: text.slice(start, end).trim(),
    });
  }

  return { body, comments };
}

/** Keys this version owns. Anything else is preserved verbatim rather than
 *  dropped - the files are hand-editable and may be written by a newer build. */
const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'github', 'id', 'type', 'status', 'title', 'labels', 'sequenceFile', 'startUrl',
  'recordingName', 'githubRepo', 'closedReason', 'reportedAt', 'acknowledgedAt',
  'startedAt', 'resolvedAt', 'githubSyncedAt', 'githubBodyHash', 'githubSync',
]);

/** Raw (unparsed) values for keys we don't know, so re-emission is lossless. */
function collectExtraFrontmatter(block: string): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!rawValue || KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    extra[key] = rawValue;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function parseIssueFile(raw: string, filePath: string): TrackedIssue | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const fm = parseFrontmatterBlock(match[1]);
  const id = typeof fm.id === 'number' ? fm.id : parseInt(String(fm.id), 10);
  if (!Number.isFinite(id)) return null;

  const { body, comments } = parseBodyAndComments(match[2] ?? '');

  return {
    id,
    github: typeof fm.github === 'number' ? fm.github : undefined,
    githubRepo: typeof fm.githubRepo === 'string' ? fm.githubRepo : undefined,
    // Stricter than status, which is cast straight through below: this field
    // gates network writes, so an unrecognised token must not survive.
    closedReason: CLOSED_REASONS.has(fm.closedReason) ? fm.closedReason as IssueClosedReason : undefined,
    githubSyncedAt: parseDate(fm.githubSyncedAt),
    githubBodyHash: typeof fm.githubBodyHash === 'string' ? fm.githubBodyHash : undefined,
    githubSync: fm.githubSync === true || fm.githubSync === 'true' ? true
      : fm.githubSync === false || fm.githubSync === 'false' ? false
      : undefined,
    extraFrontmatter: collectExtraFrontmatter(match[1]),
    type: fm.type as IssueType,
    status: fm.status as IssueStatus,
    title: typeof fm.title === 'string' ? fm.title : '',
    body,
    labels: Array.isArray(fm.labels) ? fm.labels : [],
    comments,
    sequenceFile: typeof fm.sequenceFile === 'string' ? fm.sequenceFile : '',
    startUrl: typeof fm.startUrl === 'string' ? fm.startUrl : '',
    recordingName: typeof fm.recordingName === 'string' ? fm.recordingName : '',
    reportedAt: parseDate(fm.reportedAt) || new Date(),
    acknowledgedAt: parseDate(fm.acknowledgedAt),
    startedAt: parseDate(fm.startedAt),
    resolvedAt: parseDate(fm.resolvedAt),
    filePath,
  };
}

function serializeIssueFile(issue: TrackedIssue): string {
  const fm: string[] = ['---'];
  // First, matching the stamps already on disk, so stamped files round-trip
  // byte-identically.
  if (issue.github !== undefined) fm.push(`github: ${issue.github}`);
  fm.push(`id: ${issue.id}`);
  fm.push(`type: ${issue.type}`);
  fm.push(`status: ${issue.status}`);
  fm.push(`title: ${yamlQuote(issue.title)}`);
  if (issue.labels.length > 0) fm.push(`labels: ${yamlStringArray(issue.labels)}`);
  if (issue.sequenceFile) fm.push(`sequenceFile: ${yamlQuote(issue.sequenceFile)}`);
  if (issue.startUrl) fm.push(`startUrl: ${yamlQuote(issue.startUrl)}`);
  if (issue.recordingName) fm.push(`recordingName: ${yamlQuote(issue.recordingName)}`);
  if (issue.githubRepo) fm.push(`githubRepo: ${yamlQuote(issue.githubRepo)}`);
  if (issue.closedReason) fm.push(`closedReason: ${issue.closedReason}`);
  fm.push(`reportedAt: ${issue.reportedAt.toISOString()}`);
  if (issue.acknowledgedAt) fm.push(`acknowledgedAt: ${issue.acknowledgedAt.toISOString()}`);
  if (issue.startedAt) fm.push(`startedAt: ${issue.startedAt.toISOString()}`);
  if (issue.resolvedAt) fm.push(`resolvedAt: ${issue.resolvedAt.toISOString()}`);
  if (issue.githubSyncedAt) fm.push(`githubSyncedAt: ${issue.githubSyncedAt.toISOString()}`);
  if (issue.githubBodyHash) fm.push(`githubBodyHash: ${yamlQuote(issue.githubBodyHash)}`);
  if (issue.githubSync !== undefined) fm.push(`githubSync: ${issue.githubSync}`);
  for (const [key, rawValue] of Object.entries(issue.extraFrontmatter ?? {})) {
    fm.push(`${key}: ${rawValue}`);
  }
  fm.push('---');

  const bodySections = [issue.body.trim()];
  for (const c of issue.comments) {
    bodySections.push(`<!-- comment: ${c.timestamp.toISOString()} -->\n${c.text.trim()}`);
  }

  return fm.join('\n') + '\n\n' + bodySections.join('\n\n') + '\n';
}

function slugifyTitle(title: string): string {
  const sanitized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30);
  return sanitized || 'untitled';
}

/** Filename for an issue's repro sequence JSON (lives in issues/sequences/). */
export function generateSequenceFilename(type: IssueType, id: number, title: string): string {
  return `${type}-${String(id).padStart(3, '0')}-${slugifyTitle(title)}.json`;
}

/** Filename for an issue's own Markdown file (lives in issues/items/). */
export function generateIssueFilename(type: IssueType, id: number, title: string): string {
  return `${type}-${String(id).padStart(3, '0')}-${slugifyTitle(title)}.md`;
}

// =============================================================================
// Legacy CSV migration (one-time, runs while issues.csv still exists)
// =============================================================================

function legacyParseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

interface LegacyCsvRow {
  id: number;
  type: IssueType;
  status: IssueStatus;
  description: string;
  sequenceFile: string;
  startUrl: string;
  reportedAt?: Date;
  acknowledgedAt?: Date;
  startedAt?: Date;
  resolvedAt?: Date;
  recordingName: string;
}

function legacyCsvRowToFields(row: string): LegacyCsvRow | null {
  const values = legacyParseCSVLine(row);
  if (values.length < 11) return null;

  const id = parseInt(values[0], 10);
  if (isNaN(id)) return null;

  return {
    id,
    type: values[1] as IssueType,
    status: values[2] as IssueStatus,
    description: values[3],
    sequenceFile: values[4],
    startUrl: values[5],
    reportedAt: parseDate(values[6]),
    acknowledgedAt: parseDate(values[7]),
    startedAt: parseDate(values[8]),
    resolvedAt: parseDate(values[9]),
    recordingName: values[10],
  };
}

/**
 * Migrate any remaining rows from the legacy issues.csv into issues/items/.
 * Idempotent and resumable: each row is skipped if its target file already
 * exists, and issues.csv is only renamed to .bak once every row in it has a
 * corresponding file on disk (so a partial failure just retries on the next
 * process start instead of losing rows).
 */
async function migrateCsvIfNeeded(): Promise<void> {
  const csvPath = getLegacyCsvPath();
  let csvContent: string;
  try {
    csvContent = await fs.readFile(csvPath, 'utf-8');
  } catch {
    return; // no legacy CSV - nothing to migrate
  }

  const itemsDir = getItemsDir();
  const lines = csvContent.split('\n').filter(l => l.trim());
  if (lines.length && lines[0].startsWith('id,')) lines.shift();

  let attempted = 0;
  let failed = 0;

  for (const line of lines) {
    const row = legacyCsvRowToFields(line);
    if (!row) continue;
    attempted++;

    const filePath = join(itemsDir, generateIssueFilename(row.type, row.id, row.description));

    try {
      await fs.access(filePath);
      continue; // already migrated
    } catch {
      // doesn't exist yet - proceed to write
    }

    const issue: TrackedIssue = {
      id: row.id,
      type: row.type,
      status: row.status,
      title: row.description,
      body: '',
      labels: [],
      comments: [],
      sequenceFile: row.sequenceFile,
      startUrl: row.startUrl,
      recordingName: row.recordingName,
      reportedAt: row.reportedAt ?? new Date(),
      acknowledgedAt: row.acknowledgedAt,
      startedAt: row.startedAt,
      resolvedAt: row.resolvedAt,
      filePath,
    };

    try {
      await atomicWriteFile(filePath, serializeIssueFile(issue));
    } catch (err) {
      failed++;
      console.error(`[devharness] Failed to migrate issue #${row.id} from legacy CSV:`, err);
    }
  }

  if (attempted > 0 && failed === 0) {
    try {
      await fs.rename(csvPath, `${csvPath}.bak`);
    } catch (err) {
      console.error('[devharness] Migrated issues but failed to rename legacy issues.csv to .bak:', err);
    }
  }
}

// =============================================================================
// In-memory index + watcher
// =============================================================================

let index: Map<number, TrackedIssue> | null = null;
let nextIssueId = 1;
let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const RELOAD_DEBOUNCE_MS = 250;

/**
 * Close the watcher, drop the pending debounced reload, and clear the index
 * so the next read misses the one-shot `if (index) return` gate in
 * ensureIndexLoaded() and rescans from disk instead of continuing to serve
 * whatever directory was current when the index was first primed.
 */
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
  nextIssueId = 1;
}

/**
 * Test-only: resets in-memory state (closing any active watcher) so the next
 * ensureIndexLoaded() re-scans from disk. Not part of the tool-facing API.
 */
export function __resetForTests(): void {
  resetIndexState();
}

// A root relocation moves getItemsDir()'s target directory (it derives from
// getOutputPath()); without this, the index and watcher opened against the
// old root would keep serving it, silently, for the rest of the process.
registerRootBound({
  name: 'issue-tracker',
  rebind: () => resetIndexState(),
});

async function scanIssuesDir(): Promise<Map<number, TrackedIssue>> {
  const dir = getItemsDir();
  const map = new Map<number, TrackedIssue>();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const issue = parseIssueFile(raw, filePath);
      if (issue) map.set(issue.id, issue);
    } catch (err) {
      console.error(`[devharness] Failed to parse issue file ${entry}:`, err);
    }
  }

  return map;
}

function recomputeNextIssueId(map: Map<number, TrackedIssue>): void {
  let maxId = 0;
  for (const id of map.keys()) {
    if (id > maxId) maxId = id;
  }
  nextIssueId = maxId + 1;
}

async function reloadIndex(): Promise<void> {
  try {
    const fresh = await scanIssuesDir();
    index = fresh;
    recomputeNextIssueId(fresh);
  } catch (err) {
    console.error('[devharness] Issue index reload failed, keeping previous state:', err);
  }
}

function startWatcher(): void {
  if (watcher) return;
  try {
    watcher = fsWatch(getItemsDir(), () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reloadIndex();
      }, RELOAD_DEBOUNCE_MS);
    });
  } catch {
    // Not watchable on this platform/filesystem - external edits just won't auto-reload.
  }
}

async function ensureIndexLoaded(): Promise<void> {
  if (index) return;

  await fs.mkdir(getItemsDir(), { recursive: true });
  await fs.mkdir(getSequencesDir(), { recursive: true });
  await migrateCsvIfNeeded();

  index = await scanIssuesDir();
  recomputeNextIssueId(index);
  startWatcher();
}

// =============================================================================
// Public API
// =============================================================================

/** Initialize the issue tracker - ensures the index is loaded (migrating legacy CSV data if present). */
export async function initializeTracker(): Promise<void> {
  await ensureIndexLoaded();
}

export async function addIssue(params: {
  type: IssueType;
  title: string;
  sequenceFile?: string;
  recordingName?: string;
  initialStatus?: IssueStatus;
  startUrl?: string;
  body?: string;
  labels?: string[];
}): Promise<TrackedIssue> {
  await ensureIndexLoaded();

  const status = params.initialStatus ?? 'pending';
  const now = new Date();
  const id = nextIssueId++;

  const issue: TrackedIssue = {
    id,
    type: params.type,
    status,
    title: params.title,
    body: params.body ?? '',
    labels: params.labels ?? [],
    comments: [],
    sequenceFile: params.sequenceFile ?? '',
    startUrl: params.startUrl ?? '',
    recordingName: params.recordingName ?? '',
    reportedAt: now,
    acknowledgedAt: status === 'acknowledged' ? now : undefined,
    filePath: join(getItemsDir(), generateIssueFilename(params.type, id, params.title)),
  };

  await atomicWriteFile(issue.filePath, serializeIssueFile(issue));
  index!.set(issue.id, issue);

  return issue;
}

export async function getIssue(id: number): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  return index!.get(id);
}

export async function getIssues(filter?: IssueFilter): Promise<TrackedIssue[]> {
  await ensureIndexLoaded();

  let result = Array.from(index!.values());

  if (!filter?.includeCompleted) {
    result = result.filter(i => !isCompletedStatus(i.status));
  }
  if (filter?.type) {
    result = result.filter(i => i.type === filter.type);
  }
  if (filter?.status) {
    result = result.filter(i => i.status === filter.status);
  }
  if (filter?.labels && filter.labels.length > 0) {
    const wanted = new Set(filter.labels);
    result = result.filter(i => i.labels.some(l => wanted.has(l)));
  }

  result.sort((a, b) => a.id - b.id);
  return result;
}

async function writeAndCacheIssue(issue: TrackedIssue): Promise<TrackedIssue> {
  await atomicWriteFile(issue.filePath, serializeIssueFile(issue));
  index!.set(issue.id, issue);
  return issue;
}

export async function updateIssueStatus(id: number, status: IssueStatus): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  const issue = index!.get(id);
  if (!issue) return undefined;

  issue.status = status;
  const now = new Date();
  switch (status) {
    case 'acknowledged':
      issue.acknowledgedAt = now;
      break;
    case 'in_progress':
      issue.startedAt = now;
      break;
    case 'fixed':
    case 'implemented':
      issue.resolvedAt = now;
      break;
  }

  return writeAndCacheIssue(issue);
}

/** Fields sync may write. Kept separate from updateIssueStatus because sync
 *  has to set a status AND clear resolvedAt on reopen, which that function's
 *  timestamp switch cannot express. */
export type IssueFieldPatch = Partial<Pick<TrackedIssue,
  'status' | 'title' | 'body' | 'labels' | 'closedReason' | 'resolvedAt' |
  'github' | 'githubRepo' | 'githubSyncedAt' | 'githubBodyHash' | 'githubSync'>>;

export async function updateIssueFields(id: number, patch: IssueFieldPatch): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  const issue = index!.get(id);
  if (!issue) return undefined;

  Object.assign(issue, patch);
  return writeAndCacheIssue(issue);
}

/** The local issue linked to an upstream number, if any. */
export async function findIssueByGithub(github: number, repo?: string): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  for (const issue of index!.values()) {
    if (issue.github !== github) continue;
    if (repo && issue.githubRepo && issue.githubRepo !== repo) continue;
    return issue;
  }
  return undefined;
}

export async function updateIssueSequenceFile(id: number, sequenceFile: string): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  const issue = index!.get(id);
  if (!issue) return undefined;

  issue.sequenceFile = sequenceFile;
  return writeAndCacheIssue(issue);
}

/** Append a comment to an issue's Markdown timeline. */
export async function addIssueComment(id: number, text: string): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  const issue = index!.get(id);
  if (!issue) return undefined;

  const trimmed = text.trim();
  if (!trimmed) return issue;

  issue.comments.push({ timestamp: new Date(), text: trimmed });
  return writeAndCacheIssue(issue);
}

/** Rewrite one comment's text in place, found by its timestamp (e.g. to stamp
 *  the GitHub id a push just created for it). */
export async function updateIssueCommentText(
  id: number, timestamp: Date, text: string
): Promise<TrackedIssue | undefined> {
  await ensureIndexLoaded();
  const issue = index!.get(id);
  if (!issue) return undefined;

  const comment = issue.comments.find(c => c.timestamp.getTime() === timestamp.getTime());
  if (!comment) return issue;

  comment.text = text;
  return writeAndCacheIssue(issue);
}

/**
 * Save a sequence file to the issues folder and link it to an issue
 */
export async function saveIssueSequence(
  issueId: number,
  issueType: IssueType,
  issueTitle: string,
  sequenceData: Record<string, any>,
  comment?: string
): Promise<{ success: boolean; filename?: string; error?: string }> {
  const sequencesDir = getIssueSequencesDir();
  const filename = generateSequenceFilename(issueType, issueId, issueTitle);
  const sequenceNameForFile = filename.replace(/\.json$/, '');

  try {
    const dataToSave = {
      ...sequenceData,
      name: sequenceNameForFile,
      _comment: comment || `CDP Tools sequence for ${issueType} #${issueId}: ${issueTitle}`,
    };
    await atomicWriteFile(join(sequencesDir, filename), JSON.stringify(dataToSave, null, 2));
    await updateIssueSequenceFile(issueId, filename);
    return { success: true, filename };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Acknowledge all pending bugs (sets status to 'acknowledged')
 */
export async function acknowledgeAllBugs(): Promise<TrackedIssue[]> {
  await ensureIndexLoaded();

  const pendingBugs = Array.from(index!.values()).filter(i => i.type === 'bug' && i.status === 'pending');

  const acknowledged: TrackedIssue[] = [];
  for (const bug of pendingBugs) {
    const updated = await updateIssueStatus(bug.id, 'acknowledged');
    if (updated) acknowledged.push(updated);
  }

  return acknowledged;
}

/**
 * Check if there are pending bugs that should block tools
 */
export async function hasPendingBugs(): Promise<boolean> {
  await ensureIndexLoaded();
  return Array.from(index!.values()).some(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get pending bugs for blocking message
 */
export async function getPendingBugs(): Promise<TrackedIssue[]> {
  await ensureIndexLoaded();
  return Array.from(index!.values()).filter(i => i.type === 'bug' && i.status === 'pending');
}

/**
 * Get the sequences directory path for issues
 */
export function getIssueSequencesDir(): string {
  return getSequencesDir();
}

/**
 * Get the items directory path for issues (one .md file per issue)
 */
export function getIssueItemsDir(): string {
  return getItemsDir();
}

// Alias for backwards compatibility
export const getInteractionSequencesDir = getIssueSequencesDir;

/**
 * Get issues indexed by their sequence filename
 */
export async function getIssuesBySequenceFile(): Promise<Map<string, TrackedIssue>> {
  const issues = await getIssues({ includeCompleted: true });
  const map = new Map<string, TrackedIssue>();
  for (const issue of issues) {
    if (issue.sequenceFile) {
      map.set(issue.sequenceFile, issue);
    }
  }
  return map;
}
