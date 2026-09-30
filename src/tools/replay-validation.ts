/**
 * What a sequence or a call is refused for before anything runs: step tool names that
 * name no tool, a sequence that will not load, tags that cannot select, and
 * declared profiles that cannot mean what they say.
 */
import type { CommandSequence } from '../command-recorder.js';
import { createErrorResponse } from '../messages.js';
import { sanitizeReference } from '../reference-validator.js';
import { type LoadSequenceResult } from './replay-executor.js';

/**
 * Step "tools" that the replay executor handles itself instead of dispatching
 * through the MCP tool map (see replay-executor.ts). These are always valid
 * step names even though they are not registered tools.
 */
const VIRTUAL_STEP_TOOLS = new Set(['forEach']);

/** Levenshtein distance, used only to suggest a likely intended tool name. */
function editDistance(a: string, b: string): number {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

function suggestToolName(name: string, knownToolNames: string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const known of knownToolNames) {
    const distance = editDistance(lower, known.toLowerCase());
    if (distance <= 3 && (!best || distance < best.distance)) {
      best = { name: known, distance };
    }
  }
  return best?.name;
}

export interface UnknownStepTool {
  /** 1-based step number, matching the numbering used in run results */
  step: number;
  tool: string;
  suggestion?: string;
}

/**
 * Find sequence steps whose `tool` is not a registered tool name.
 *
 * Only NAMES are validated - step params are deliberately not checked against
 * the tools' zod schemas, because params legitimately contain interpolation
 * tokens ({{var:...}}, {{timestamp}}) that are only substituted at run time,
 * so a number-typed field can validly hold a string token at rest.
 */
export function findUnknownStepTools(
  commands: Array<{ tool?: unknown }>,
  knownToolNames: string[]
): UnknownStepTool[] {
  const known = new Set(knownToolNames);
  const unknown: UnknownStepTool[] = [];

  commands.forEach((cmd, i) => {
    const name = typeof cmd?.tool === 'string' ? cmd.tool : String(cmd?.tool);
    if (known.has(name) || VIRTUAL_STEP_TOOLS.has(name)) return;
    unknown.push({ step: i + 1, tool: name, suggestion: suggestToolName(name, knownToolNames) });
  });

  return unknown;
}

/**
 * Build the error response for a sequence containing unknown tool names. A
 * plain response: docs/messages.md holds no template for this case.
 */
function unknownStepToolsError(
  action: string,
  sequenceName: string,
  unknown: UnknownStepTool[],
  knownToolNames: string[]
) {
  const plural = unknown.length === 1 ? '' : 's';
  const lines: string[] = [
    `Error: Sequence "${sequenceName}" references ${unknown.length} unknown tool name${plural}`,
    `The "${action}" action was rejected before any step ran, so no browser state was changed.`,
    '',
  ];

  for (const u of unknown) {
    lines.push(
      `- Step ${u.step}: \`${u.tool}\` is not a known tool${u.suggestion ? ` - did you mean \`${u.suggestion}\`?` : ''}`
    );
  }

  lines.push('');
  lines.push('**Fix:** correct the `tool` field on the listed step(s).');
  lines.push(`**Known tools:** ${knownToolNames.slice().sort().join(', ')}`);

  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/**
 * Validate every step's tool name in a sequence. Returns an error response when
 * any name is unknown, or null when the sequence is fine (including when no
 * tool-name provider was supplied, which keeps validation opt-in).
 */
export function validateSequenceToolNames(
  sequence: CommandSequence,
  action: string,
  getKnownToolNames?: () => string[]
) {
  if (!getKnownToolNames) return null;

  const knownToolNames = getKnownToolNames();
  if (!knownToolNames || knownToolNames.length === 0) return null;

  const unknown = findUnknownStepTools(sequence.commands ?? [], knownToolNames);
  if (unknown.length === 0) return null;

  return unknownStepToolsError(action, sequence.name, unknown, knownToolNames);
}

/**
 * Handle loadSequence error result - creates proper error response with template variables
 */
export function handleLoadSequenceError(result: Extract<LoadSequenceResult, { success: false }>, action: string) {
  return createErrorResponse(result.errorCode, {
    action,
    message: result.error,
    ...result.templateVars
  });
}

/**
 * Tidy a tag list into the form selection can rely on: trimmed, lowercased,
 * de-duplicated, order preserved.
 *
 * Case and stray whitespace are normalised rather than rejected because a tag
 * is matched, not displayed - `runAll({ tags: ['UI'] })` skipping a sequence
 * tagged `ui` would be a silent miss, which for a suite means quietly running
 * less than you asked for.
 */
export function normalizeTags(tags: string[]): { tags: string[] } | { error: string } {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag) {
      return { error: 'An empty tag cannot select anything - drop it, or pass [] to clear the list.' };
    }
    if (/\s/.test(tag)) {
      return { error: `"${raw.trim()}" contains a space. Tags are single words so they stay unambiguous in a filter - use a hyphen ("${tag.replace(/\s+/g, '-')}").` };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return { tags: out };
}

/**
 * Reject a declaration set whose profiles cannot mean what it says, before
 * anything is launched.
 *
 * Two failures, both of which would otherwise surface later as something else:
 *
 * - **Two references on one profile.** Only one live Chrome may hold a profile,
 *   so the second launch fails - but the message would be about ports, not
 *   about a sequence asking two identities to be the same browser. Same shape
 *   as the `connections` rule that refuses collapsing two references into one.
 *
 * - **Rebinding a profile-bearing reference.** A rebind normally wins, because
 *   a declaration is only a default. A profile is not a default, it is an
 *   identity claim: pointing "device-a" at some other browser runs device-a's
 *   steps somewhere that is not device-a, and the run reports success. That is
 *   the class of lie the per-step connection rules exist to prevent.
 */
export function declaredProfileConflict(
  declared: NonNullable<CommandSequence['requiredConnections']>,
  connectionMap: Record<string, string> | undefined
): string | null {
  const byProfile = new Map<string, string[]>();
  for (const decl of declared) {
    if (!decl.profile) continue;
    const reference = sanitizeReference(decl.reference);
    if (!reference) continue;

    const rebound = connectionMap?.[reference];
    if (rebound) {
      return `"${reference}" is declared on the persistent profile "${decl.profile}", so it names a specific browser identity, ` +
        `not a default - rebinding it onto "${rebound}" would run its steps in a browser that is not "${decl.profile}" and pass. ` +
        `Drop it from \`connections\`, or drop the profile from the declaration.`;
    }

    byProfile.set(decl.profile, [...(byProfile.get(decl.profile) || []), reference]);
  }

  for (const [profile, references] of byProfile) {
    if (references.length > 1) {
      return `${references.length} declared connections (${references.join(', ')}) name the same persistent profile "${profile}". ` +
        `Only one live Chrome may hold a profile, so they would be one browser - give each identity its own profile.`;
    }
  }
  return null;
}
