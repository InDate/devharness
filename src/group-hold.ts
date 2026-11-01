import { groupOf, membersOf } from './groups.js';
import { hold, holdableLayers, release, type HoldCaller, type HoldLayer, type HoldOwner, type HoldReading } from './hold.js';

/**
 * The other members of `connection`'s group a hold reaches: those with a layer
 * to hold. A closed member has none, and a hold on it would engage nothing.
 */
export function groupPeers(connection: string): string[] {
  const group = groupOf(connection);
  if (!group) return [];
  return membersOf(group).filter(member => member !== connection && holdableLayers(member).length > 0);
}

/**
 * Holds `connection` and every peer in its group under one owner, so a paused
 * run stops the browsers its steps drive together: a peer left running sends
 * frames and requests into a browser that cannot answer them. Returns the
 * reading of `connection`; a peer whose hold fails stays running.
 */
export async function holdWithGroup(
  connection: string,
  options: { owner: HoldOwner; layers?: readonly HoldLayer[] },
): Promise<HoldReading> {
  const [reading] = await Promise.all([
    hold(connection, options),
    ...groupPeers(connection).map(peer => hold(peer, options).catch(() => undefined)),
  ]);
  return reading;
}

/** Releases what `by` may end on `connection` and every peer in its group. */
export async function releaseWithGroup(
  connection: string,
  options: { by: HoldCaller; layers?: readonly HoldLayer[] },
): Promise<HoldReading> {
  const [reading] = await Promise.all([
    release(connection, options),
    ...groupPeers(connection).map(peer => release(peer, options).catch(() => undefined)),
  ]);
  return reading;
}
