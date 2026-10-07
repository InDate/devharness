/**
 * What a run is given and checks before it starts: the envFile it reads, the
 * `variables` keys it substitutes on, and the references `connections` can
 * rebind, across every sequence the run reaches by name.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CommandRecorder, RecordedCommand } from '../command-recorder.js';
import { sanitizeReference } from '../reference-validator.js';
import { analyzeRecordedStepConnections } from './replay-executor.js';
import { createdName } from './connection-steps.js';
import { extractTextVariables } from './replay-formatters.js';
import { configManager } from '../config.js';
import { parseEnvFile } from '../helpers/env-file.js';
import { getOutputPath, getProjectDir } from '../helpers/paths.js';
import { isAbsolute, relative } from 'path';

/** The sequences a run reaches by name: a check's `{ run }` on either answer, and a `forEach`'s `do`. */
function reachedByName(commands: RecordedCommand[]): string[] {
  const names: string[] = [];
  for (const cmd of commands) {
    if (cmd.tool === 'check') {
      for (const answer of [cmd.params?.holds, cmd.params?.fails]) {
        if (typeof answer?.run === 'string') names.push(answer.run);
      }
    }
    if (cmd.tool === 'forEach' && typeof cmd.params?.do === 'string') names.push(cmd.params.do);
  }
  return names;
}

/**
 * References that sequences reached by name (a check's `{ run }`, a
 * `forEach`'s `do`) name, for validating `connections`. Resolution is memory-only and best-effort: a
 * sequence that lives on disk isn't loaded here (that would register it as a
 * side effect of validation), so `complete: false` says "this list may be
 * short" and the caller must not treat a missing key as a typo.
 */
export function collectNestedRebindableReferences(
  commands: RecordedCommand[],
  recorder: CommandRecorder,
  depth = 0,
  seen = new Set<string>()
): { references: string[]; complete: boolean } {
  // Must track the executor's own cap, not a hardcoded copy: with a raised
  // maxConditionalDepth, references at runtime-reachable depths would be
  // omitted while `complete` still claimed the list was exhaustive, and a valid
  // rebinding key would be rejected as a typo.
  if (depth >= configManager.getReplayConfig().maxConditionalDepth) {
    return { references: [], complete: false };
  }

  const references: string[] = [];
  let complete = true;

  for (const then of reachedByName(commands)) {
    if (seen.has(then)) continue;
    seen.add(then);

    const nested = recorder.listSequences().find(s => s.name === then);
    if (!nested) { complete = false; continue; }

    references.push(...analyzeRecordedStepConnections(nested.commands).references);
    for (const c of nested.commands) {
      const created = createdName(c);
      if (created) {
        references.push(sanitizeReference(created));
      }
    }

    const deeper = collectNestedRebindableReferences(nested.commands, recorder, depth + 1, seen);
    references.push(...deeper.references);
    complete = complete && deeper.complete;
  }

  return { references, complete };
}

/**
 * Read the run's `envFile` into the values {{env:NAME}} resolves against.
 *
 * Loaded here, before any side effects, so a missing file or a malformed line
 * fails the run as a parameter error rather than as a step failure halfway
 * through a flow that has already logged in. The values stay on the run's
 * context: writing them into process.env would leak one run's credentials into
 * every concurrent background run, which name their own files.
 */
export async function loadRunEnv(
  envFile: string
): Promise<{ values: Record<string, string> } | { error: string }> {
  const path = isAbsolute(envFile) ? envFile : join(getProjectDir(), envFile);
  let text: string;
  try {
    text = await fs.readFile(path, 'utf-8');
  } catch (err: any) {
    return { error: `Could not read envFile "${envFile}" (resolved to ${path}): ${err?.code === 'ENOENT' ? 'no such file' : err?.message || String(err)}` };
  }

  const { values, problems } = parseEnvFile(text);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map(p => `line ${p.line}: ${p.text}`).join('; ');
    return { error: `envFile "${envFile}" (resolved to ${path}) has ${problems.length} line(s) that are neither blank, a # comment, nor NAME=value with a name matching [A-Za-z_][A-Za-z0-9_]* - ${shown}${problems.length > 3 ? ', ...' : ''}. A skipped line reads as a set variable, so the run stops here.` };
  }

  return { values };
}

/**
 * The file a run reads its {{env:NAME}} values from when it names no envFile:
 * `.devharness/sequences.env`. A bench play passes no envFile, so without it a
 * credential reaches a played sequence only through the server's own
 * environment, which is fixed when the server starts. Absent, the run reads
 * the environment alone; malformed, the run fails before its first step, as a
 * named envFile does.
 */
export async function loadDefaultRunEnv(): Promise<{ values: Record<string, string>; file: string } | { error: string } | undefined> {
  const path = getOutputPath('sequences.env');
  try {
    await fs.access(path);
  } catch {
    return undefined;
  }
  const loaded = await loadRunEnv(path);
  return 'error' in loaded ? loaded : { values: loaded.values, file: relative(getProjectDir(), path) };
}

/**
 * Every `variables` key a run could substitute on: this sequence's typed-text
 * steps plus those of every sequence it reaches through a check's `{ run }`
 * or a `forEach`'s `do`.
 *
 * Resolution is memory-only and best-effort, the same rule
 * collectNestedRebindableReferences follows: a helper that lives on disk and
 * has not been loaded is not loaded here (that would register it as a side
 * effect of validation), so `complete: false` says "this list may be short"
 * and the caller must not call a missing key a typo. `runAll` loads the whole
 * tree before it runs anything, so a suite run always gets a complete list.
 */
export function collectVariableKeys(
  commands: RecordedCommand[],
  recorder: CommandRecorder,
  depth = 0,
  seen = new Set<string>()
): { keys: Set<string>; complete: boolean } {
  const keys = new Set(Object.keys(extractTextVariables(commands)));
  // Must track the executor's own cap: with a raised maxConditionalDepth, keys
  // at runtime-reachable depths would be omitted while `complete` still claimed
  // the list was exhaustive, and a valid key would be rejected as a typo.
  if (depth >= configManager.getReplayConfig().maxConditionalDepth) {
    return { keys, complete: false };
  }

  let complete = true;
  for (const name of reachedByName(commands)) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const nested = recorder.listSequences().find(sq => sq.name === name);
    if (!nested) { complete = false; continue; }

    const deeper = collectVariableKeys(nested.commands, recorder, depth + 1, seen);
    for (const key of deeper.keys) keys.add(key);
    complete = complete && deeper.complete;
  }

  return { keys, complete };
}

/**
 * Keys the caller supplied that name no typed-text step anywhere the run can
 * reach. Empty when the key list could not be resolved in full, because a key
 * valid for an unloaded helper is not a typo.
 *
 * A `variables` key is matched exactly and nothing else reads it, so an
 * unmatched key would be dropped in silence: the step would run on its
 * RECORDED text while the call read as an override. For a recorded credential that
 * means the old password reaching the live app with the run reporting success.
 * Same rule the `connections` rebinding already applies to a reference that
 * names no recorded step.
 */
export function unmatchedVariableKeys(
  supplied: Record<string, string>,
  commands: RecordedCommand[],
  recorder: CommandRecorder
): { unmatched: string[]; known: string[] } {
  const { keys, complete } = collectVariableKeys(commands, recorder);
  if (!complete) return { unmatched: [], known: [...keys].sort() };
  return {
    unmatched: Object.keys(supplied).filter(k => !keys.has(k)),
    known: [...keys].sort(),
  };
}
