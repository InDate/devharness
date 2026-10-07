import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const project = vi.hoisted(() => ({ dir: '' }));
vi.mock('../helpers/paths.js', async (original) => {
  const actual = await original<typeof import('../helpers/paths.js')>();
  return {
    ...actual,
    getOutputPath: (...args: any[]) => args[0] === 'sequences.env' && args.length === 1
      ? join(project.dir, '.devharness', 'sequences.env')
      : (actual.getOutputPath as any)(...args),
  };
});

import { secretsFor, writeSecret } from './secrets.js';

describe('the secrets a bench lists', () => {
  beforeEach(async () => { project.dir = await fs.mkdtemp(join(tmpdir(), 'bench-secrets-')); });
  afterEach(async () => { await fs.rm(project.dir, { recursive: true, force: true }); });

  const steps = [
    { index: 0, label: 'click', done: false, current: false, params: { action: 'click' } },
    { index: 1, label: 'type', done: false, current: false, params: { action: 'type', text: '{{env:APP_PASSWORD}}' } },
  ];

  it('lists a name the steps read and the file holds, with its origins and readers, never its value', async () => {
    await writeSecret('APP_PASSWORD', { value: 'hunter2', byOrigin: { 'https://staging.example.com': 'staging-pass' } });

    const secrets = await secretsFor(steps);

    expect(secrets).toEqual([{ name: 'APP_PASSWORD', plain: true, origins: ['https://staging.example.com'], usedBy: [1] }]);
    expect(JSON.stringify(secrets)).not.toMatch(/hunter2|staging-pass/);
  });

  it('lists a name the steps read and the file lacks as holding no value', async () => {
    expect(await secretsFor(steps)).toEqual([{ name: 'APP_PASSWORD', plain: false, origins: [], usedBy: [1] }]);
  });

  it('leaves the file readable by its owner alone, one already there included', async () => {
    const file = join(project.dir, '.devharness', 'sequences.env');
    await fs.mkdir(join(project.dir, '.devharness'), { recursive: true });
    await fs.writeFile(file, 'OTHER=1\n', { mode: 0o644 });

    await writeSecret('APP_PASSWORD', { value: 'hunter2' });

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps the values an edit leaves out', async () => {
    await writeSecret('APP_PASSWORD', { value: 'plain', byOrigin: { 'https://a.example': 'a', 'https://b.example': 'b' } });

    await writeSecret('APP_PASSWORD', { byOrigin: { 'https://b.example': 'b2' } }, true);

    expect(await fs.readFile(join(project.dir, '.devharness', 'sequences.env'), 'utf-8'))
      .toBe('APP_PASSWORD=plain\nAPP_PASSWORD@https://a.example=a\nAPP_PASSWORD@https://b.example=b2\n');
  });

  it('removes every value for the name', async () => {
    await writeSecret('APP_PASSWORD', { value: 'hunter2' });
    await writeSecret('APP_PASSWORD', null);

    expect(await fs.readFile(join(project.dir, '.devharness', 'sequences.env'), 'utf-8')).not.toContain('APP_PASSWORD');
  });
});
