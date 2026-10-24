/**
 * Whether the bench records the animations the page starts, kept in the
 * project's `.devharness` folder so a restart keeps it. A replay compared
 * against a recording made with it on reads every animation row as missing
 * while it is off, so it stays as the person left it.
 */

import { promises as fs } from 'fs';
import { atomicWriteFile } from '../atomic-write.js';
import { getOutputPath } from '../helpers/paths.js';
import { sessions } from './session.js';

function motionFile(): string {
  return getOutputPath('bench', 'motion.json');
}

/**
 * The setting this process holds, once read or set. A bench started while a
 * change is still being written would otherwise read the file's old value
 * and switch detection back.
 */
let current: boolean | undefined;

export async function readMotionDetect(): Promise<boolean> {
  if (current !== undefined) return current;
  try {
    current = JSON.parse(await fs.readFile(motionFile(), 'utf-8'))?.on === true;
  } catch {
    current = false;
  }
  return current;
}

export async function setMotionDetect(connection: string, on: boolean): Promise<void> {
  current = on;
  sessions.get(connection)?.writeWatch?.setAnimations(on);
  await fs.mkdir(getOutputPath('bench'), { recursive: true }).catch(() => {});
  await atomicWriteFile(motionFile(), JSON.stringify({ on }) + '\n').catch(() => {});
}

/** Whether animations are being recorded on `connection`: a run's animation rows are compared only then. */
export function watchingMotion(connection: string): boolean {
  return sessions.get(connection)?.writeWatch?.animations === true;
}
