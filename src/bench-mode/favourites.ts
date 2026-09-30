import { promises as fs } from 'fs';
import { atomicWriteFile } from '../atomic-write.js';
import { getOutputPath } from '../helpers/paths.js';
import type { ToolFavourite } from '../bench/wire.js';

/**
 * Tool calls a person starred in the bench, kept in the project's
 * `.devharness` folder. On disk rather than in the browser: the bench is
 * served on a fresh port each start, and a browser keeps storage per origin,
 * so browser storage would empty on every start.
 */
function favouritesFile(): string {
  return getOutputPath('bench', 'favourites.json');
}

export async function readFavourites(): Promise<ToolFavourite[]> {
  try {
    const read = JSON.parse(await fs.readFile(favouritesFile(), 'utf-8'));
    return Array.isArray(read) ? read : [];
  } catch {
    return [];
  }
}

/** Star a call. The same tool with the same arguments is starred once. */
export async function addFavourite(call: { tool: string; label: string; args: Record<string, unknown> }): Promise<ToolFavourite[]> {
  const favourites = await readFavourites();
  const same = JSON.stringify(call.args);
  if (favourites.some(favourite => favourite.tool === call.tool && JSON.stringify(favourite.args) === same)) return favourites;
  const next = [...favourites, {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tool: call.tool,
    label: call.label,
    args: call.args,
    at: Date.now(),
  }];
  await atomicWriteFile(favouritesFile(), JSON.stringify(next, null, 2));
  return next;
}

export async function removeFavourite(id: string): Promise<ToolFavourite[]> {
  const next = (await readFavourites()).filter(favourite => favourite.id !== id);
  await atomicWriteFile(favouritesFile(), JSON.stringify(next, null, 2));
  return next;
}
