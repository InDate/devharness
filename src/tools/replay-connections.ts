/**
 * Which connection each step of a sequence runs on: which tools take one,
 * where a sequence creates its own, which references its steps name, and
 * which of them are live in this session.
 */

import type { RecordedCommand } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import type { ConnectionMeta } from '../tool-response.js';
import { sanitizeReference } from '../reference-validator.js';
import { addressesConnection, addressedConnection, createsConnection, createdName } from './connection-steps.js';
import type { ConnectionAnalysis } from './replay-types.js';

/**
 * Tools that can only run against a *browser*. Read to find whether a sequence
 * needs Chrome auto-launched (analyzeSequenceConnections / sequenceNeedsConnection
 * and the auto-launch paths in replay-tools).
 *
 * Deliberately excludes tools that are equally valid against a Node target
 * (`inspect`, `execution`, `breakpoint`, `source`, `request`) - listing
 * those here would make a Node-only sequence spuriously launch Chrome.
 */
export const TOOLS_NEEDING_CONNECTION = [
  'navigate', 'content', 'input', 'console', 'network', 'dom', 'screenshot', 'storage',
  // `bench` takes a required connection and launches Chrome when the
  // reference is unbound. Left out, a sequence holding a bench step has its
  // connection hoisted off and never given back, and the replay fails on a
  // missing parameter rather than on anything the sequence did.
  'bench',
];

/**
 * Tools whose params accept a `connection` and should therefore have the
 * run-level connection injected when the step doesn't name one itself. Superset of
 * TOOLS_NEEDING_CONNECTION: it adds the target-agnostic (Chrome *or* Node) debugging
 * tools, which need to be pinned to the run's target but must NOT drag a browser
 * launch in with them.
 *
 * `request` is handled separately - only `destination: 'browser'` takes a connection.
 */
export const TOOLS_ACCEPTING_CONNECTION = [
  ...TOOLS_NEEDING_CONNECTION,
  'inspect', 'execution', 'breakpoint', 'source', 'modal', 'assert',
  'wait', 'check', 'hold'
];

/**
 * Whether a single step requires a *browser* connection (drives Chrome
 * auto-launch). Param-aware variant of `TOOLS_NEEDING_CONNECTION.includes(tool)`:
 * `wait` is browser-bound only in its selector/selectorGone forms.
 * - `wait({ ms })` is a plain sleep and must not drag a Chrome launch in.
 * - `wait({ expression })` is target-agnostic (valid against Node too), so it
 *   behaves like `inspect`: the run connection is injected, but it never
 *   forces a browser launch on its own.
 */
export function commandNeedsBrowserConnection(cmd: { tool: string; params?: Record<string, any> }): boolean {
  // A check on time, a value or an expression reads no page of its own.
  if (cmd.tool === 'check') {
    const p = cmd.params || {};
    return ['selector', 'url', 'cookie', 'localStorage', 'indexedDB'].some(key => p[key] !== undefined);
  }
  if (cmd.tool === 'wait') {
    const p = cmd.params || {};
    return p.selector !== undefined || p.selectorGone !== undefined;
  }
  return TOOLS_NEEDING_CONNECTION.includes(cmd.tool);
}

/**
 * Actions of connection-taking tools that run without one: a bare `execution
 * acknowledge` acknowledges every paused connection, and `source loadMaps`
 * registers maps for the whole session. A connection stamped onto either
 * narrows the first to one connection and the second to nothing it uses.
 */
export function actsWithoutConnection(cmd: { tool: string; params?: Record<string, any> }): boolean {
  const action = cmd.params?.action;
  return (cmd.tool === 'execution' && action === 'acknowledge')
    || (cmd.tool === 'source' && action === 'loadMaps');
}

/**
 * Whether a bare step will have the run-level connection injected into it -
 * i.e. whether leaving it bare is AMBIGUOUS about which browser it belongs to.
 *
 * Deliberately wider than `commandNeedsBrowserConnection`, which answers a
 * different question (does this drag a Chrome launch in?). A step of
 * `inspect`, `execution`, `storage` and the other target-agnostic tools
 * recorded without a connection - which recordings made before every
 * call had to name one hold - captures nothing about which browser it ran
 * against, and on replay it lands wherever the run-level connection points.
 * Measuring ambiguity with the narrower predicate missed exactly those tools.
 */
export function commandTakesInjectedConnection(cmd: { tool: string; params?: Record<string, any> }): boolean {
  if (actsWithoutConnection(cmd)) return false;
  // wait({ ms }) is a plain sleep - no connection is injected, nothing ambiguous.
  if (cmd.tool === 'wait') return (cmd.params || {}).ms === undefined;
  if (cmd.tool === 'check') {
    const p = cmd.params || {};
    return ['selector', 'expression', 'url', 'cookie', 'localStorage', 'indexedDB'].some(key => p[key] !== undefined);
  }
  return TOOLS_ACCEPTING_CONNECTION.includes(cmd.tool) || addressesConnection(cmd);
}

// =============================================================================
// Connection Analysis
// =============================================================================

/**
 * Where a sequence creates its connection (its first launch or attach) and
 * where it first needs a browser. A sequence that creates its connection first
 * is given none by the run: auto-launching one under the same name would make
 * its own launch reuse it or its own attach fail on a name already in use.
 */
export function analyzeSequenceConnections(commands: RecordedCommand[]): ConnectionAnalysis {
  const createIndex = commands.findIndex(createsConnection);
  const firstConnectionToolIndex = commands.findIndex(commandNeedsBrowserConnection);
  const createsBeforeUse = createIndex !== -1 &&
    (firstConnectionToolIndex === -1 || createIndex < firstConnectionToolIndex);

  return { createIndex, firstConnectionToolIndex, createsBeforeUse };
}

/** The name the sequence's first launch or attach creates, when it creates it before any step needs a browser. */
export function extractConnectionFromSequence(
  commands: RecordedCommand[],
  analysis: ConnectionAnalysis
): string | undefined {
  if (!analysis.createsBeforeUse) return undefined;
  const name = createdName(commands[analysis.createIndex]);
  return name ? sanitizeReference(name) : undefined;
}

export interface RecordedConnectionAnalysis {
  /** Distinct per-step connection references, in first-seen order. */
  references: string[];
  /** The one reference every connection-bearing step shares, if there is one. */
  uniform?: string;
  /**
   * True when some steps name a connection and other steps that take one
   * don't - the bare steps were recorded without one, so nothing records
   * which browser they belonged to. Such a sequence is not hoisted
   * (that could pin every step to the one named reference) and `create` says so.
   */
  mixed: boolean;
  /** More than one distinct per-step reference: a genuinely multi-connection sequence. */
  multiConnection: boolean;
}

/**
 * What connections a recorded/stored sequence's steps name.
 */
export function analyzeRecordedStepConnections(commands: RecordedCommand[]): RecordedConnectionAnalysis {
  const references: string[] = [];
  let bareSteps = 0;

  for (const cmd of commands) {
    const raw = addressedConnection(cmd);
    if (raw) {
      const ref = sanitizeReference(raw);
      if (!references.includes(ref)) references.push(ref);
    } else if (commandTakesInjectedConnection(cmd)) {
      bareSteps++;
    }
  }

  return {
    references,
    ...(references.length === 1 ? { uniform: references[0] } : {}),
    mixed: references.length > 0 && bareSteps > 0,
    multiConnection: references.length > 1,
  };
}

/**
 * Hoist a uniform per-step connection back off the steps so the sequence stays
 * portable: `replay({ action: 'run', connection: 'other' })` can then
 * retarget the whole thing. Steps keep their own connection only where the
 * sequence genuinely spans connections (or where it is ambiguous - see
 * `mixed`), which is the case a run-level connection cannot express.
 *
 * Returns a new command array; the input is never mutated.
 */
export function normalizeStepConnections(commands: RecordedCommand[]): {
  commands: RecordedCommand[];
  /** The reference that was hoisted off every step, if any. */
  hoisted?: string;
  analysis: RecordedConnectionAnalysis;
} {
  const analysis = analyzeRecordedStepConnections(commands);

  if (analysis.uniform === undefined || analysis.mixed) {
    return { commands, analysis };
  }

  const hoisted = analysis.uniform;
  const stripped = commands.map(cmd => {
    if (addressedConnection(cmd) === undefined) return cmd;
    const { connection, ...rest } = cmd.params;
    return { ...cmd, params: rest };
  });

  return { commands: stripped, hoisted, analysis };
}

/**
 * Normalize a recorded-reference -> session-reference map (both sides sanitized,
 * so `{ 'Duo Member Two': 'My Second Browser' }` works the same as the
 * hyphenated form). Returns undefined for an empty/absent map.
 */
export function sanitizeConnectionMap(
  map?: Record<string, string>
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string' || !to.trim()) continue;
    out[sanitizeReference(from)] = sanitizeReference(to);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether a run of `sequence` crosses the proxy: declared with `proxy`, or
 * holding a traffic or socket check or a boundary rule, each of which reads
 * what crossed the proxy and answers an error on a browser outside it.
 */
export function sequenceNeedsProxy(sequence: {
  proxy?: boolean;
  commands: RecordedCommand[];
  teardown?: RecordedCommand[];
  boundaryRules?: unknown[];
}): boolean {
  if (sequence.proxy === true) return true;
  if ((sequence.boundaryRules?.length ?? 0) > 0) return true;
  return [...sequence.commands, ...(sequence.teardown ?? [])].some(step =>
    step.tool === 'check' && (step.params?.traffic !== undefined || step.params?.socket !== undefined));
}

/**
 * Check if sequence needs a connection
 */
export function sequenceNeedsConnection(commands: RecordedCommand[]): boolean {
  return commands.some(cmd =>
    commandNeedsBrowserConnection(cmd) && !cmd.params.connection
  );
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * The connection references live in this session, as `connection list` reports
 * them: an empty set when the list was read and nothing in it is live, and
 * null when the list could not be read (the call failed, or its reply carried
 * no `_meta.connections`). Callers treat null as unknown, so an unreadable list
 * neither rejects a step's own connection nor relaunches a live browser.
 */
export async function probeLiveConnectionReferences(
  executeToolCall: ExecuteToolCall
): Promise<Set<string> | null> {
  try {
    const parsed = connectionsOf(await executeToolCall('connection', { action: 'list' }));
    if (!parsed) return null;
    // A connection whose socket has already dropped is not somewhere a step can
    // run, so it must not count as live - otherwise a healing sequence skips the
    // launch that would have replaced it.
    const refs = new Set<string>();
    for (const c of parsed) {
      if (c.connected !== false) refs.add(sanitizeReference(c.reference));
    }
    return refs;
  } catch {
    return null;
  }
}

/**
 * The connections a `connection list` response carries in `_meta`, or null when
 * it carries none (a stub) - null means "unknown", never "empty".
 */
export function connectionsOf(response: any): ConnectionMeta[] | null {
  const list = response?._meta?.connections;
  if (!Array.isArray(list)) return null;
  return list.filter((c: any) => typeof c?.reference === 'string');
}

/**
 * Resolve a step's RECORDED connection onto this session, and refuse to
 * proceed if it doesn't exist here (bug-018).
 *
 * Falling back to the run-level connection with a warning is exactly the failure
 * this exists to prevent: a sequence whose purpose is proving something crosses
 * a browser boundary would run entirely in one browser and still pass.
 */
export function formatMissingStepConnection(opts: {
  step: number;
  tool: string;
  recorded: string;
  resolved: string;
  mapped: boolean;
  runConnection?: string;
  live: string[];
}): string {
  const { step, tool, recorded, resolved, mapped, runConnection, live } = opts;
  const via = mapped ? ` (mapped from recorded "${recorded}")` : '';
  return [
    `Step ${step} (${tool}) needs connection "${resolved}"${via}, which does not exist in this session.`,
    `Connections in this session: ${live.length ? live.join(', ') : 'none'}.`,
    `The step names its own connection, so it is NOT run against` +
      ` the run-level connection${runConnection ? ` "${runConnection}"` : ''} - that would replay a` +
      ` multi-browser sequence in a single browser and report success.`,
    `Either create it (connection({ action: 'launch', connection: "${resolved}" })) or rebind it:` +
      ` replay({ action: 'run', ..., connections: { "${recorded}": "<a reference from this session>" } }).`,
  ].join(' ');
}
