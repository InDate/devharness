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
