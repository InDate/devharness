import { promises as fs } from 'fs';
import { basename, join, resolve } from 'path';
import { getOutputPath } from '../helpers/paths.js';
import { readRecord, forget } from '../capture-file.js';
import { capturesInFlight } from './captures.js';
import type { Annotation } from '../annotation.js';

export interface CaptureSweep {
  root: string;
  orphans: Array<{ path: string; bytes: number }>;
  bytes: number;
  removed: number;
  sequencesRead: number;
  referenced: number;
  inFlight: number;
}

/** The series a capture belongs to: its record's, or its file name where it carries none. */
async function seriesOf(path: string): Promise<string> {
  const record = await readRecord(path).catch(() => undefined);
  return record?.series ?? basename(path, '.png');
}

/**
 * The note captures no sequence refers to any more.
 *
 * A note is erased by removing it from the sequence, which leaves the picture
 * it cited on disk with nothing pointing at it. Every sequence store is read,
 * not only the open one: a capture cited by another sequence is in use, and
 * deleting it would empty a note somewhere else.
 *
 * With `only`, the sweep is narrowed to the series of those captures.
 *
 * Only the bench's own note captures are considered. The `screenshot` tool
 * writes to the same directories and no annotation ever cites those, so a rule
 * of "unreferenced" alone would take every one of them.
 */
export async function sweepCaptures(remove: boolean, only?: string[]): Promise<CaptureSweep> {
  const cited = new Set<string>();
  let sequencesRead = 0;
  for (const store of [getOutputPath('sequences'), getOutputPath('sequences', { global: true })]) {
    const files = await fs.readdir(store).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await fs.readFile(join(store, file), 'utf8').catch(() => null);
      if (raw === null) continue;
      sequencesRead += 1;
      let parsed: { commands?: Array<{ annotations?: Annotation[] }> };
      try { parsed = JSON.parse(raw) as typeof parsed; } catch { continue; }
      for (const command of parsed.commands ?? []) {
        for (const note of command.annotations ?? []) {
          for (const shot of note.screenshots ?? []) cited.add(resolve(shot));
        }
      }
    }
  }
  // A capture taken and not yet saved is cited by nothing on disk.
  const inFlight = capturesInFlight();
  for (const shot of inFlight) cited.add(resolve(shot));
  // A note cites version 1, whose file name is the series; every later version
  // of that series is in use with it.
  const citedSeries = new Set([...cited].map(path => basename(path, '.png')));

  // Narrowed to the series of the captures named, as a note's removal takes
  // its own pictures and leaves other orphans to a sweep someone asks for.
  const onlySeries = only ? new Set(await Promise.all(only.map(seriesOf))) : undefined;

  const root = getOutputPath('screenshots');
  const orphans: Array<{ path: string; bytes: number }> = [];
  const days = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dir = join(root, day.name);
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      // Written by the screenshot tool, which no note ever cites.
      if (name.startsWith('screenshot-')) continue;
      const full = join(dir, name);
      if (cited.has(resolve(full))) continue;
      if (name.endsWith('.png')) {
        const record = await readRecord(full).catch(() => undefined);
        if (record && citedSeries.has(record.series)) continue;
      }
      if (onlySeries && !onlySeries.has(await seriesOf(full))) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      orphans.push({ path: full, bytes: stat.size });
    }
  }

  let removed = 0;
  if (remove) {
    const deleted: string[] = [];
    for (const orphan of orphans) {
      const gone = await fs.unlink(orphan.path).then(() => true).catch(() => false);
      if (gone) { removed += 1; deleted.push(orphan.path); }
    }
    forget(deleted);
  }
  return {
    root,
    orphans,
    bytes: orphans.reduce((sum, one) => sum + one.bytes, 0),
    removed,
    sequencesRead,
    referenced: cited.size,
    inFlight: inFlight.length,
  };
}
