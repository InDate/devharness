/**
 * The issue body as a transport for sequences.
 *
 * A sequence rides inside the body as a fenced block tagged
 * ```json devharness-sequence. GitHub highlights on the first word of the
 * info string, so it renders as JSON and the second word is ours to find.
 *
 * Everything here treats the markdown as untrusted: issue bodies already
 * contain code fences of their own, and a sequence pulled from a public issue
 * is a script, not a macro.
 */

import { z } from 'zod';
import { translateSequence } from '../tools/legacy-steps.js';

export const SEQUENCE_FENCE_INFO = 'json devharness-sequence';
const SEQUENCE_TAG = 'devharness-sequence';
const MAX_SEQUENCE_BYTES = 256 * 1024;
const MAX_STEPS = 500;

/** Tools that do more than drive a page, so a remote sequence using one is
 *  refused unless the caller explicitly opts in. */
export const PRIVILEGED_TOOLS: ReadonlySet<string> = new Set([
  'execution', 'server', 'request', 'download', 'browser',
]);

export interface FencedBlock {
  /** The info string, e.g. `json devharness-sequence`. */
  info: string;
  content: string;
  /** 0-based line of the opening fence. */
  startLine: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every fenced block, in document order.
 *
 * Tracks the opening fence's character and length so a longer fence can
 * legally contain shorter ones - the reason this is a scanner and not a
 * regex. Ten issue files on disk already carry code fences of their own.
 */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: FencedBlock[] = [];

  let open: { char: string; length: number; info: string; startLine: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FENCE_RE);

    if (!open) {
      if (!match) continue;
      // A backtick info string may not contain backticks (CommonMark), which
      // is what stops ```` ```a```b ```` opening a block.
      const info = match[2];
      if (match[1][0] === '`' && info.includes('`')) continue;
      open = { char: match[1][0], length: match[1].length, info: info.trim(), startLine: i, body: [] };
      continue;
    }

    const closes = match
      && match[1][0] === open.char
      && match[1].length >= open.length
      && match[2].trim() === '';

    if (closes) {
      blocks.push({ info: open.info, content: open.body.join('\n'), startLine: open.startLine });
      open = null;
    } else {
      open.body.push(lines[i]);
    }
  }

  // An unterminated fence still holds a block - GitHub renders it that way.
  if (open) blocks.push({ info: open.info, content: open.body.join('\n'), startLine: open.startLine });

  return blocks;
}

function isSequenceBlock(block: FencedBlock): boolean {
  const words = block.info.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words[0] === 'json' && words[1] === SEQUENCE_TAG;
}

export function findSequenceBlocks(markdown: string): FencedBlock[] {
  return extractFencedBlocks(markdown).filter(isSequenceBlock);
}

/** The first sequence block. First, not newest - order in the body is the rule. */
export function findSequenceBlock(markdown: string): FencedBlock | null {
  return findSequenceBlocks(markdown)[0] ?? null;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === '`') { current++; if (current > longest) longest = current; }
    else current = 0;
  }
  return longest;
}

/**
 * Emit a sequence as a fence wide enough to contain it. A step can be an
 * `execution` call carrying a JS template literal, so three backticks is not
 * always enough; GitHub renders a wider fence identically.
 */
export function emitSequenceBlock(sequence: unknown): string {
  const json = JSON.stringify(sequence, null, 2);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(json) + 1));
  return `${fence}${SEQUENCE_FENCE_INFO}\n${json}\n${fence}`;
}

/**
 * Remove sequence blocks and collapse the gap they leave.
 *
 * Used before hashing and before writing a pulled body: the block is a
 * projection of the sequence file, not body content, so leaving it in would
 * make every publish look like a local edit.
 */
export function stripSequenceBlocks(markdown: string): string {
  const blocks = findSequenceBlocks(markdown);
  if (blocks.length === 0) return markdown;

  const lines = markdown.split(/\r?\n/);
  const drop = new Set<number>();
  for (const block of blocks) {
    const bodyLines = block.content === '' ? 0 : block.content.split('\n').length;
    // opening fence + body + closing fence
    for (let i = block.startLine; i <= block.startLine + bodyLines + 1; i++) drop.add(i);
  }

  return lines
    .filter((_, i) => !drop.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// =============================================================================
// Remote sequences
// =============================================================================

const stepSchema = z.object({
  tool: z.string().min(1),
  params: z.record(z.any()).optional(),
  delay: z.number().optional(),
  comment: z.string().optional(),
}).strip();

/** Deliberately a whitelist with .strip(): unknown keys from a public issue
 *  are dropped rather than carried onto disk. `id` is regenerated locally. */
const remoteSequenceSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  expectedOutcome: z.string().optional(),
  startUrl: z.string().optional(),
  commands: z.array(stepSchema).min(1).max(MAX_STEPS),
  teardown: z.array(stepSchema).max(MAX_STEPS).optional(),
  tags: z.array(z.string()).optional(),
  requiredSockets: z.array(z.string()).optional(),
  requiredConnections: z.array(z.object({
    reference: z.string(),
    url: z.string().optional(),
    profile: z.string().optional(),
    forceNewInstance: z.boolean().optional(),
    role: z.string().optional(),
  }).strip()).optional(),
}).strip();

export type RemoteSequence = z.infer<typeof remoteSequenceSchema>;

export type ParseRemoteSequenceResult =
  | { ok: true; sequence: RemoteSequence }
  | { ok: false; reason: string };

export function parseRemoteSequence(json: string): ParseRemoteSequenceResult {
  if (json.length > MAX_SEQUENCE_BYTES) {
    return { ok: false, reason: `Sequence is ${Math.round(json.length / 1024)}KB, over the 256KB limit` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, reason: `Not valid JSON: ${(err as Error).message}` };
  }

  const parsed = remoteSequenceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return { ok: false, reason: `${path}: ${issue.message}` };
  }

  // Before the audit and the known-tools check read it, so an old tool name
  // reads as the tool that replaced it.
  return { ok: true, sequence: translateSequence(parsed.data) };
}

export interface SequenceAudit {
  steps: number;
  tools: string[];
  privileged: string[];
}

/** What this sequence would do, in the terms a reader needs before running it. */
export function auditSequence(sequence: RemoteSequence): SequenceAudit {
  const all = [...sequence.commands, ...(sequence.teardown ?? [])];
  const tools = [...new Set(all.map(step => step.tool))].sort();
  return {
    steps: all.length,
    tools,
    privileged: tools.filter(tool => PRIVILEGED_TOOLS.has(tool)),
  };
}
