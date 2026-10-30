/**
 * The build of devharness running now, as stamped onto what it records.
 *
 * Capture changes between builds: a field a recording lacks is either one the
 * app never produced or one the build that recorded it did not yet capture.
 * The stamp separates the two.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface CapturedBy {
  /** The package version. */
  version: string;
  /** The commit the build was compiled from; absent on a build made outside the repository. */
  commit?: string;
  /** The build held uncommitted changes under `src/`, so `commit` names the code it started from. */
  dirty?: true;
}

const here = dirname(fileURLToPath(import.meta.url));

const read = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
};

let stamp: CapturedBy | undefined;

/** Read once per process: a rebuild restarts the process, and the stamp with it. */
export function capturedBy(): CapturedBy {
  if (stamp) return stamp;
  const info = read(join(here, 'build-info.json'));
  stamp = {
    version: read(join(here, '..', 'package.json'))?.version ?? 'unknown',
    ...(typeof info?.commit === 'string' ? { commit: info.commit } : {}),
    ...(info?.dirty === true ? { dirty: true as const } : {}),
  };
  return stamp;
}
