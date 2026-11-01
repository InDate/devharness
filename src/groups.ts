/**
 * Named sets of connections: the browsers one sequence or one person treats
 * as a unit, each still its own Chrome with its own profile and proxy.
 *
 * Membership is by connection name, and a member outlives its browser: a
 * closed member reads as closed, and a launch under the same name rejoins.
 * That keeps a group stable across a sequence's reruns, which relaunch the
 * same names. A group exists from `create` or its first member's launch
 * until `end`, with or without members.
 */

const groups = new Map<string, Set<string>>();
/** When each group was created, epoch ms: where a full read of it starts. */
const createdAt = new Map<string, number>();

function ensure(name: string): Set<string> {
  if (!groups.has(name)) {
    groups.set(name, new Set());
    createdAt.set(name, Date.now());
  }
  return groups.get(name)!;
}

/** Adds an empty group; false when one by that name exists. */
export function createGroup(name: string): boolean {
  if (groups.has(name)) return false;
  ensure(name);
  return true;
}

export function groupCreatedAt(name: string): number | undefined {
  return createdAt.get(name);
}

/** Puts `connection` in `group`, creating the group, and takes it out of any other. */
export function joinGroup(group: string, connection: string): void {
  leaveGroup(connection);
  ensure(group).add(connection);
}

/**
 * The group a sequence's launches join when its run connection has none: the
 * sequence name up to 20 characters, its initials past that, so the name fits
 * the bench's group column.
 */
export function runGroupName(sequence: string): string {
  if (sequence.length <= 20) return sequence;
  const words = sequence.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  return words.map(word => word[0]!.toLowerCase()).join('') || sequence.slice(0, 20);
}

/**
 * Puts a browser a sequence launched in the group of the run's own connection,
 * so a pause holding that group reaches it. With the run's connection in no
 * group, both join a group named `fallback`. A launched browser already in a
 * group stays there: it came from a launch that named one, or a reused browser.
 */
export function joinRunGroup(launched: string, runConnection: string | undefined, fallback: string): void {
  if (groupOf(launched) !== undefined) return;
  const target = (runConnection && groupOf(runConnection)) || fallback;
  if (runConnection && groupOf(runConnection) === undefined) ensure(target).add(runConnection);
  ensure(target).add(launched);
}

export function leaveGroup(connection: string): void {
  for (const members of groups.values()) members.delete(connection);
}

export function groupOf(connection: string): string | undefined {
  for (const [name, members] of groups) if (members.has(connection)) return name;
  return undefined;
}

export function hasGroup(name: string): boolean {
  return groups.has(name);
}

export function membersOf(name: string): string[] {
  return [...(groups.get(name) ?? [])];
}

export function listGroups(): Array<{ name: string; members: string[] }> {
  return [...groups].map(([name, members]) => ({ name, members: [...members] }));
}

/** Follows a connection's rename, so its group holds the new name. */
export function renameMember(from: string, to: string): void {
  for (const members of groups.values()) {
    if (members.delete(from)) members.add(to);
  }
}

/** Removes the group; returns the members it held. */
export function endGroup(name: string): string[] {
  const members = membersOf(name);
  groups.delete(name);
  createdAt.delete(name);
  return members;
}
