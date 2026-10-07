/**
 * Secrets the bench adds and lists. A secret's value lives in
 * `.devharness/sequences.env` - git ignores `.devharness/`, and every run that
 * names no envFile reads it - and a step reads it as {{env:NAME}}. It never
 * passes through the app's page, the sequence file or the bench's state: the
 * bench writes the file and reads back names and origins alone.
 */
import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { SecretVariable, SequenceStep } from '../bench/wire.js';
import { envNames, parseEnvFile, withEnvEntries, type EnvEntries } from '../helpers/env-file.js';
import { getOutputPath } from '../helpers/paths.js';

const projectEnvFile = () => getOutputPath('sequences.env');

async function readEnvText(): Promise<string> {
  try {
    return await fs.readFile(projectEnvFile(), 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Store `name`'s values in the project env file, replacing any it held; null
 * removes them. With `keep`, a value left out - the plain one or an origin's -
 * keeps the one the file holds, so an edit that changes one value leaves the
 * others where they were.
 */
export async function writeSecret(name: string, entries: EnvEntries | null, keep = false): Promise<void> {
  const text = await readEnvText();
  let stored = entries;
  if (keep && entries) {
    const held = parseEnvFile(text).values;
    const heldOrigins = Object.fromEntries(Object.entries(held)
      .filter(([key]) => key.startsWith(`${name}@`)).map(([key, value]) => [key.slice(name.length + 1), value]));
    const value = entries.value ?? held[name];
    const byOrigin = { ...heldOrigins, ...entries.byOrigin };
    stored = { ...(value !== undefined ? { value } : {}), ...(Object.keys(byOrigin).length ? { byOrigin } : {}) };
  }
  const next = withEnvEntries(text, name, stored);
  await fs.mkdir(dirname(projectEnvFile()), { recursive: true });
  await fs.writeFile(projectEnvFile(), next, { mode: 0o600 });
  // writeFile's mode applies only to a file it creates; one already there keeps its own.
  await fs.chmod(projectEnvFile(), 0o600);
}

/**
 * The secrets to list beside a sequence: each name its steps read as
 * {{env:NAME}}, and each name the project env file holds, with the origins it
 * holds a value for and the steps that read it. A name the steps read and the
 * file lacks is listed with neither, which is the run's failure before it runs.
 */
export async function secretsFor(steps: SequenceStep[]): Promise<SecretVariable[]> {
  const held = envNames(parseEnvFile(await readEnvText().catch(() => '')).values);
  const readers = new Map<string, number[]>();
  for (const step of steps) {
    for (const [, name] of JSON.stringify(step.params ?? {}).matchAll(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      const at = readers.get(name) ?? [];
      if (!at.includes(step.index)) at.push(step.index);
      readers.set(name, at);
    }
  }
  const names = [...new Set([...readers.keys(), ...held.keys()])].sort();
  return names.map(name => ({
    name,
    plain: held.get(name)?.plain ?? false,
    origins: held.get(name)?.origins ?? [],
    usedBy: readers.get(name) ?? [],
  }));
}
