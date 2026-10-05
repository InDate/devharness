/**
 * `replay search`: the saved steps that touch a string or an element.
 *
 * A string matches literally in a step's params, its comment and its notes,
 * which finds what a selector or URL names. An element is what a selector
 * resolves to on the live page, compared with the fingerprint each click step
 * stored, which also finds the steps that reached the same element by
 * position, by text or by a point. A step that addresses an element and
 * carries no fingerprint cannot be compared either way, and is reported as
 * unknown rather than as touching nothing.
 */
import { promises as fs } from 'fs';
import type { CommandRecorder, CommandSequence, RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createErrorResponse } from '../messages.js';
import { compareFingerprints, describeFingerprint, readFingerprintVia } from '../element-fingerprint.js';
import { unlisted } from '../call-origin.js';
import type { ReplayArgs } from './replay-schema.js';

/** The most matching steps a reply lists; `_meta` carries every one. */
const LISTED = 40;

interface StepMatch {
  sequence: string;
  step: number;
  teardown?: true;
  label: string;
  field?: string;
  value?: string;
}

/** Every saved sequence on disk, issue sequences included, read fresh from its file. */
async function savedSequences(recorder: CommandRecorder): Promise<CommandSequence[]> {
  const files = [
    ...await recorder.listSavedSequencesOnDisk(),
    ...await recorder.listIssueSequencesOnDisk().catch(() => []),
  ];
  const read = await Promise.all(files.map(async file => {
    try { return JSON.parse(await fs.readFile(file.fullPath, 'utf-8')) as CommandSequence; } catch { return undefined; }
  }));
  return read.filter((s): s is CommandSequence => Boolean(s?.commands));
}

/** Each step of a sequence with its 1-based number, teardown steps after the main ones. */
function stepsOf(sequence: CommandSequence): Array<{ step: RecordedCommand; number: number; teardown?: true }> {
  return [
    ...sequence.commands.map((step, i) => ({ step, number: i + 1 })),
    ...(sequence.teardown ?? []).map((step, i) => ({ step, number: i + 1, teardown: true as const })),
  ];
}

function labelOf(step: RecordedCommand): string {
  return `${step.tool}${step.params?.action ? `.${step.params.action}` : ''}`;
}

/** The first field of a step holding `query`, as a dotted path and its value. */
function fieldHolding(step: RecordedCommand, query: string): { field: string; value: string } | undefined {
  const walk = (value: unknown, path: string): { field: string; value: string } | undefined => {
    if (typeof value === 'string') return value.includes(query) ? { field: path, value } : undefined;
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        const found = walk(inner, path ? `${path}.${key}` : key);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(step.params ?? {}, '')
    ?? (step.comment?.includes(query) ? { field: 'comment', value: step.comment } : undefined)
    ?? walk((step as any).annotations ?? [], 'annotations');
}

/** Whether a step acts on or reads one element, which a fingerprint could identify. */
function addressesElement(step: RecordedCommand): boolean {
  const params = step.params ?? {};
  if (step.tool === 'input') return typeof params.selector === 'string' || typeof params.x === 'number';
  return (step.tool === 'check' || step.tool === 'wait' || step.tool === 'assert') && typeof params.selector === 'string';
}

function line(match: StepMatch): string {
  const where = `${match.sequence} step ${match.teardown ? `teardown ${match.step}` : match.step}`;
  const what = match.field ? ` ${match.field}: ${(match.value ?? '').slice(0, 80)}` : '';
  return `- ${where} \`${match.label}\`${what}`;
}

export async function handleSearch(args: ReplayArgs, recorder: CommandRecorder, executeToolCall: ExecuteToolCall) {
  if (!args.query && !args.element) {
    return createErrorResponse('MISSING_PARAMETER', {
      action: 'search', missing: 'query or element',
      message: 'The "search" action takes "query", a string matched literally in every saved step, or "element", a selector resolved on the live page and compared with the element each step reached (with "connection").',
    });
  }
  const sequences = await savedSequences(recorder);

  if (args.query) {
    const query = args.query;
    const matches: StepMatch[] = [];
    for (const sequence of sequences) {
      for (const { step, number, teardown } of stepsOf(sequence)) {
        const held = fieldHolding(step, query);
        if (held) matches.push({ sequence: sequence.name, step: number, ...(teardown ? { teardown } : {}), label: labelOf(step), ...held });
      }
    }
    const touched = new Set(matches.map(m => m.sequence)).size;
    const text = matches.length === 0
      ? `No saved step holds \`${query}\` (${sequences.length} sequences read). A step that reached the same element by position, text or a point holds no such string: search by \`element\` finds those.`
      : `**${matches.length} step(s) in ${touched} sequence(s) hold \`${query}\`**\n${matches.slice(0, LISTED).map(line).join('\n')}`
        + (matches.length > LISTED ? `\n- … ${matches.length - LISTED} more, in _meta.search.matches` : '');
    return {
      content: [{ type: 'text', text }],
      _meta: { tool: 'replay', action: 'search', timestamp: Date.now(), search: { query, read: sequences.length, matches } },
    };
  }

  if (!args.connection) {
    return createErrorResponse('MISSING_PARAMETER', { action: 'search', missing: 'connection', message: 'Searching by "element" resolves it on a live page: pass the "connection" whose page shows it.' });
  }
  const target = await unlisted(() => readFingerprintVia(executeToolCall, args.connection!, { selector: args.element! }));
  if (!target) {
    return createErrorResponse('ELEMENT_NOT_FOUND', { selector: args.element! });
  }

  const matches: StepMatch[] = [];
  const unknown = new Map<string, number[]>();
  let compared = 0;
  for (const sequence of sequences) {
    for (const { step, number, teardown } of stepsOf(sequence)) {
      if (!addressesElement(step)) continue;
      if (!step.fingerprint) {
        if (!teardown) unknown.set(sequence.name, [...(unknown.get(sequence.name) ?? []), number]);
        continue;
      }
      compared++;
      if (compareFingerprints(target, step.fingerprint).same) {
        matches.push({
          sequence: sequence.name, step: number, ...(teardown ? { teardown } : {}), label: labelOf(step),
          field: step.params?.selector ? 'selector' : 'point',
          value: step.params?.selector ?? `${step.params?.x}, ${step.params?.y}`,
        });
      }
    }
  }
  const unknownSteps = [...unknown.values()].reduce((n, steps) => n + steps.length, 0);
  const text = [
    `**${describeFingerprint(target)}**: ${matches.length} step(s) reached it, of ${compared} compared across ${sequences.length} sequences`,
    ...matches.slice(0, LISTED).map(line),
    ...(matches.length > LISTED ? [`- … ${matches.length - LISTED} more, in _meta.search.matches`] : []),
    ...(unknownSteps ? [`\n**Unknown:** ${unknownSteps} step(s) in ${unknown.size} sequence(s) address an element and carry no fingerprint, so whether they reach this one cannot be read. Recording them again stores one. The sequences are in _meta.search.unknown.`] : []),
  ].join('\n');
  return {
    content: [{ type: 'text', text }],
    _meta: {
      tool: 'replay', action: 'search', timestamp: Date.now(),
      search: {
        element: args.element, fingerprint: target, read: sequences.length, compared, matches,
        unknown: [...unknown.entries()].map(([sequence, steps]) => ({ sequence, steps })),
      },
    },
  };
}
