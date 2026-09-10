/**
 * `envFile` names a KEY=value file for one run, so a credential lives neither
 * in the sequence file nor in the tool call, and changing it needs no MCP
 * client restart - the environment of a running server is fixed when it starts.
 *
 * Two rules the alternatives get wrong. The file WINS over the server's own
 * environment: the caller named this file for this run, and a stale ambient
 * variable shadowing it would substitute a different credential with nothing
 * in the output to say so. And process.env is never written: concurrent
 * background runs may name different files, so a global write would let one
 * run's credentials resolve inside the other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnvFile } from '../helpers/env-file.js';
import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';
import { getProjectDir } from '../helpers/paths.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

describe('parseEnvFile', () => {
  it('reads KEY=value, skipping blanks and # comments', () => {
    const { values, problems } = parseEnvFile('# a comment\n\nAPP_PASSWORD=hunter2\nAPP_USER=alice\n');
    expect(values).toEqual({ APP_PASSWORD: 'hunter2', APP_USER: 'alice' });
    expect(problems).toEqual([]);
  });

  it('accepts an export prefix and strips surrounding quotes', () => {
    const { values } = parseEnvFile('export A="one two"\nB=\'three\'\n');
    expect(values).toEqual({ A: 'one two', B: 'three' });
  });

  it('keeps a value containing = and $ verbatim, with no expansion', () => {
    const { values } = parseEnvFile('TOKEN=ab=cd$HOME$\n');
    expect(values).toEqual({ TOKEN: 'ab=cd$HOME$' });
  });

  it('reports a line that is not NAME=value rather than skipping it', () => {
    const { values, problems } = parseEnvFile('GOOD=1\njust some words\n2BAD=x\n');
    expect(values).toEqual({ GOOD: '1' });
    expect(problems.map(p => p.line)).toEqual([2, 3]);
  });

  it('keeps an empty value, which is a set-but-empty variable', () => {
    expect(parseEnvFile('EMPTY=\n').values).toEqual({ EMPTY: '' });
  });
});

describe('envFile through a run', () => {
  let dir: string;
  let recorder: CommandRecorder;
  let replay: any;
  let typed: string[];
  const original = { ...process.env };

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'cdp-envfile-'));
    recorder = new CommandRecorder();
    typed = [];
    vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(dir);

    const fieldValues = new Map<string, string>();
    ({ replay } = createReplayTools(
      recorder,
      vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
        if (tool === 'input' && params.action === 'type') {
          typed.push(String(params.text));
          if (params.selector) fieldValues.set(String(params.selector), String(params.text));
        }
        if (tool === 'inspect' && params.action === 'evaluateExpression') {
          const selector = String(params.expression).match(/querySelector\('([^']*)'\)/)?.[1] ?? '';
          return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(fieldValues.get(selector) ?? '') + '\n```' }] };
        }
        return { content: [{ type: 'text', text: '' }] };
      })) as any,
      async () => null,
      async () => 9222,
      undefined
    ));

    await fs.writeFile(join(dir, 'login.json'), JSON.stringify({
      id: 'seq-login', name: 'login', createdAt: 1,
      commands: [{ tool: 'input', params: { action: 'type', selector: '#password', text: '{{env:APP_PASSWORD}}', connectionReason: 'app' } }],
    }));
    await recorder.loadSequenceFromDisk(join(dir, 'login.json'));
  });

  afterEach(async () => {
    process.env = { ...original };
    recorder.stopSequenceWatch();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = (extra: Record<string, any>) =>
    replay.handler({ action: 'run', wait: true, name: 'login', connectionReason: 'app', ...extra } as any);

  const text = (res: any) => res.content.map((c: any) => c.text).join('\n');

  it('resolves a token from the file at an absolute path', async () => {
    const envPath = join(dir, 'sequences.env');
    await fs.writeFile(envPath, 'APP_PASSWORD=from-file\n');

    const res = await run({ envFile: envPath });

    expect(res.isError).toBeUndefined();
    expect(typed).toEqual(['from-file']);
  });

  it('resolves a relative path against the project directory', async () => {
    const rel = 'test-sequences.env';
    const abs = join(getProjectDir(), rel);
    await fs.writeFile(abs, 'APP_PASSWORD=from-relative\n');
    try {
      await run({ envFile: rel });
      expect(typed).toEqual(['from-relative']);
    } finally {
      await fs.rm(abs, { force: true });
    }
  });

  it('wins over a value already in the process environment', async () => {
    process.env.APP_PASSWORD = 'from-ambient';
    const envPath = join(dir, 'sequences.env');
    await fs.writeFile(envPath, 'APP_PASSWORD=from-file\n');

    await run({ envFile: envPath });

    expect(typed).toEqual(['from-file']);
  });

  it('falls through to the process environment for a name the file omits', async () => {
    process.env.APP_PASSWORD = 'from-ambient';
    const envPath = join(dir, 'sequences.env');
    await fs.writeFile(envPath, 'SOMETHING_ELSE=x\n');

    await run({ envFile: envPath });

    expect(typed).toEqual(['from-ambient']);
  });

  it('does not write the file values into process.env', async () => {
    delete process.env.APP_PASSWORD;
    const envPath = join(dir, 'sequences.env');
    await fs.writeFile(envPath, 'APP_PASSWORD=from-file\n');

    await run({ envFile: envPath });

    expect(process.env.APP_PASSWORD).toBeUndefined();
  });

  it('fails as a parameter error before any step runs when the file is missing', async () => {
    const res = await run({ envFile: join(dir, 'nope.env') });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('no such file');
    expect(typed).toEqual([]);
  });

  it('fails before any step runs on a malformed line, naming the line number', async () => {
    const envPath = join(dir, 'bad.env');
    await fs.writeFile(envPath, 'APP_PASSWORD=ok\njust some words\n');

    const res = await run({ envFile: envPath });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('line 2');
    expect(typed).toEqual([]);
  });
});
