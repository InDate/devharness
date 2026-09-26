/**
 * Payloads typed once and kept by name, for a replacement to serve.
 *
 * Only the content: what a replacement serves in place of a crossing. Where
 * it applies - the step, the socket, the status - stays on the replacement.
 * One file a payload under `payloads/`, named for it, `.json` where it parses
 * and `.txt` where it does not, so one can be read and changed by hand. The
 * project's, not a sequence's, so every sequence can serve the same one.
 */

import { existsSync, promises as fs, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';

/** A name a file can carry: letters and digits, with `-`, `_` and `.` between. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const dir = () => getOutputPath('payloads');

const fileOf = (name: string, json: boolean) => join(dir(), `${name}.${json ? 'json' : 'txt'}`);

export function payloadNameIsValid(name: string): boolean {
  return NAME.test(name);
}

export async function listPayloads(): Promise<Array<{ name: string; bytes: number }>> {
  const entries = await fs.readdir(dir()).catch(() => [] as string[]);
  const out: Array<{ name: string; bytes: number }> = [];
  for (const file of entries) {
    const found = /^(.+)\.(json|txt)$/.exec(file);
    if (!found) continue;
    const stat = await fs.stat(join(dir(), file)).catch(() => undefined);
    if (stat) out.push({ name: found[1], bytes: stat.size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The payload's content, read now, so a replacement serving it serves the file as it stands. */
export function readPayload(name: string): string | undefined {
  if (!payloadNameIsValid(name)) return undefined;
  for (const json of [true, false]) {
    const file = fileOf(name, json);
    if (existsSync(file)) return readFileSync(file, 'utf-8');
  }
  return undefined;
}

/** Write a payload, replacing one of the same name under either extension. */
export async function savePayload(name: string, content: string): Promise<string | undefined> {
  if (!payloadNameIsValid(name)) return `"${name}" is not a payload name: letters, digits, - _ and . only`;
  let json = false;
  try { JSON.parse(content); json = true; } catch { /* kept as text */ }
  await fs.mkdir(dir(), { recursive: true });
  await atomicWriteFile(fileOf(name, json), content);
  const other = fileOf(name, !json);
  if (existsSync(other)) unlinkSync(other);
  return undefined;
}

/** Remove a payload. A replacement serving it keeps serving what it last read. */
export function deletePayload(name: string): boolean {
  if (!payloadNameIsValid(name)) return false;
  let found = false;
  for (const json of [true, false]) {
    const file = fileOf(name, json);
    if (existsSync(file)) { unlinkSync(file); found = true; }
  }
  return found;
}
