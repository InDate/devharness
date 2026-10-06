/**
 * What was done to a page while a run stood paused on it: a person's input,
 * and each hold, release and step through the hold controls - a statement, a
 * callback, a message let through. Listed in that pause beside the traffic,
 * in the order it happened, so the pause reads as what was done and what the
 * app did back.
 */
import { currentCursor } from './proxy/registry.js';
import { holdReading, watchHolds, type HoldChange } from './hold.js';

export interface PauseAction {
  runId: string;
  step: number;
  at: number;
  kind: 'input' | 'hold' | 'callback';
  line: string;
  /** The History entry an input was recorded as. */
  index?: number;
}

const KEPT = 200;
const actions = new Map<string, PauseAction[]>();

/** Record `line` against the pause standing now, where a run stands paused; nothing otherwise. */
export function recordPauseAction(connection: string, action: Omit<PauseAction, 'runId' | 'step'>): void {
  const standing = currentCursor();
  if (standing?.kind !== 'replay' || !standing.paused) return;
  const held = [...(actions.get(connection) ?? []), { ...action, runId: standing.runId, step: standing.step }];
  actions.set(connection, held.slice(-KEPT));
}

/** Everything recorded in pauses on `connection`, oldest first. */
export function pauseActionsFor(connection: string): PauseAction[] {
  return actions.get(connection) ?? [];
}

const STEPS: Record<string, string> = {
  code: 'stepped the code one statement',
  ui: 'stepped the screen one callback',
  network: 'let one message through',
};

function lineOf(change: HoldChange): string {
  if (change.change === 'stepped') {
    const at = holdReading(change.connection).held.find(held => held.layer === change.layers[0])?.standing?.at;
    return `${STEPS[change.layers[0]] ?? `stepped the ${change.layers[0]}`}${typeof at === 'string' ? `, now at ${at}` : ''}`;
  }
  return `${change.change === 'held' ? 'held' : 'released'} the ${change.layers.join(' and ')}${change.source ? ` (${change.source})` : ''}`;
}

// The pause's own hold is the pause itself, and the debugger reports that same
// stop again as a breakpoint's, so neither is listed: what is, is each step
// taken and each hold or release someone placed while the run stood.
watchHolds(change => {
  if (change.change !== 'stepped' && (change.source === 'sequence' || change.source === 'breakpoint' || change.source === undefined)) return;
  recordPauseAction(change.connection, { at: Date.now(), kind: 'hold', line: lineOf(change) });
});
