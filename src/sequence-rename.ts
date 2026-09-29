/**
 * Rename a saved sequence where every name for it is kept.
 *
 * A sequence is found by its name in three places besides its own file: the
 * activity file beside it, which holds its baseline and responses by the same
 * path; and every sequence that runs it, through a check's `holds` or `fails`
 * `{ run }`, a forEach's `do`, or a `replay run` step's `name`. A rename that
 * left any of those on the old name would break the guard or lose the
 * baseline, so all of them move together.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { walkSequenceFiles } from './helpers/sequence-tree.js';
import { activityPathFor } from './sequence-activity.js';

/** A name a file can take and a reference can hold: letters, digits, `-` and `_`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface Loaded { path: string; sequence: any }

/** Point every step that runs `from` at `to`; the count of steps changed. */
function repoint(commands: any[] | undefined, from: string, to: string): number {
  let changed = 0;
  for (const command of commands ?? []) {
    const params = command?.params;
    if (!params) continue;
    for (const branch of ['holds', 'fails']) {
      if (params[branch]?.run === from) { params[branch].run = to; changed += 1; }
    }
    if (params.do === from) { params.do = to; changed += 1; }
    if (command.tool === 'replay' && params.name === from) { params.name = to; changed += 1; }
  }
  return changed;
}

export async function renameSequence(
  dirs: string[], from: string, to: string,
): Promise<{ failure?: string; references: number }> {
  if (!NAME.test(to)) return { failure: `"${to}" is not a name a sequence can take: letters, digits, - and _ only`, references: 0 };
  if (to === from) return { references: 0 };

  const loaded: Loaded[] = [];
  for (const dir of [...new Set(dirs)]) {
    const files = await walkSequenceFiles(dir).catch(() => [] as string[]);
    for (const file of files) {
      const path = join(dir, file);
      try {
        loaded.push({ path, sequence: JSON.parse(await fs.readFile(path, 'utf-8')) });
      } catch { /* a file that does not parse is not a sequence to rename or repoint */ }
    }
  }
  const target = loaded.find(one => one.sequence?.name === from);
  if (!target) return { failure: `no saved sequence named "${from}"`, references: 0 };
  const renamedPath = join(dirname(target.path), `${to}.json`);
  if (loaded.some(one => one.sequence?.name === to) || loaded.some(one => one.path === renamedPath)) {
    return { failure: `a sequence named "${to}" already exists`, references: 0 };
  }

  let references = 0;
  for (const one of loaded) {
    const changed = repoint(one.sequence.commands, from, to) + repoint(one.sequence.teardown, from, to);
    references += changed;
    if (changed && one !== target) await fs.writeFile(one.path, `${JSON.stringify(one.sequence, null, 2)}\n`);
  }

  target.sequence.name = to;
  await fs.writeFile(renamedPath, `${JSON.stringify(target.sequence, null, 2)}\n`);
  await fs.unlink(target.path);

  const activityFrom = activityPathFor(target.path);
  const activity = await fs.readFile(activityFrom, 'utf-8').then(text => JSON.parse(text)).catch(() => undefined);
  if (activity) {
    activity.name = to;
    const activityTo = activityPathFor(renamedPath);
    await fs.mkdir(dirname(activityTo), { recursive: true });
    await fs.writeFile(activityTo, `${JSON.stringify(activity, null, 2)}\n`);
    await fs.unlink(activityFrom);
  }
  return { references };
}
