/**
 * What a recorded step does to connections.
 *
 * A `connection` step's `connection` either names the connection it creates
 * (launch, attach) or addresses one that exists (switch, rename, close,
 * status), as every other tool's does. Replay treats the two differently: a
 * created name has no connection yet when the step runs, and an addressed one must.
 */

import { UNNAMED_CONNECTION } from '../reference-validator.js';

interface Step {
  tool: string;
  params?: Record<string, any>;
}

/** Actions of `connection` that act on an existing connection named by `connection`. */
export const ADDRESSING_ACTIONS: ReadonlySet<string> = new Set(['switch', 'rename', 'close', 'status']);

export function isLaunchStep(step: Step): boolean {
  return step.tool === 'connection' && step.params?.action === 'launch';
}

export function isAttachStep(step: Step): boolean {
  return step.tool === 'connection' && step.params?.action === 'attach';
}

/** A launch or attach: the step brings a connection into being under `params.connection`. */
export function createsConnection(step: Step): boolean {
  return isLaunchStep(step) || isAttachStep(step);
}

/**
 * The name a launch or attach step creates. A launch that gives none creates
 * the default connection, so it answers that name; an attach requires one.
 */
export function createdName(step: Step): string | undefined {
  if (!createsConnection(step)) return undefined;
  if (typeof step.params?.connection === 'string') return step.params.connection;
  return isLaunchStep(step) ? UNNAMED_CONNECTION : undefined;
}

/**
 * The existing connection a step acts on, or undefined for a step naming none
 * and for a launch or attach, whose `connection` is the one it creates.
 */
export function addressedConnection(step: Step): string | undefined {
  if (createsConnection(step)) return undefined;
  const named = step.params?.connection;
  return typeof named === 'string' && named.trim() ? named : undefined;
}

/** A `connection` action that addresses an existing connection, and so takes the run's connection when it names none. */
export function addressesConnection(step: Step): boolean {
  return step.tool === 'connection' && ADDRESSING_ACTIONS.has(String(step.params?.action));
}
