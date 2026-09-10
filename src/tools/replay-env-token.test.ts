/**
 * `{{env:NAME}}` keeps a credential OUT of the sequence file: the file holds
 * the token, the value lives in the environment, and neither the file nor the
 * tool call carries the secret.
 *
 * Two behaviours the alternative gets wrong. An unset or empty variable FAILS
 * the step - resolving to '' would submit a blank password and surface as a
 * confusing downstream failure instead of the missing configuration that
 * caused it. And a token-bearing step does not hold `run` open for a
 * `variables` answer: its value arrives at run time by definition.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { interpolateParams, hasTemplateToken, InterpolationError } from './interpolation.js';
import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

describe('{{env:NAME}} resolution', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('resolves from the process environment', () => {
    process.env.APP_PASSWORD = 'from-env';
    expect(interpolateParams({ text: '{{env:APP_PASSWORD}}' }, {}, 0)).toEqual({ text: 'from-env' });
  });

  it('substitutes inside a larger string', () => {
    process.env.APP_TOKEN = 'abc';
    expect(interpolateParams({ h: 'Bearer {{env:APP_TOKEN}}' }, {}, 0)).toEqual({ h: 'Bearer abc' });
  });

  it('fails the step when the variable is unset, naming the variable and not a value', () => {
    delete process.env.APP_PASSWORD;
    expect(() => interpolateParams({ text: '{{env:APP_PASSWORD}}' }, {}, 0))
      .toThrow(InterpolationError);
    expect(() => interpolateParams({ text: '{{env:APP_PASSWORD}}' }, {}, 0))
      .toThrow(/APP_PASSWORD is not set/);
  });

  it('fails on an empty variable rather than typing an empty value', () => {
    process.env.APP_PASSWORD = '';
    expect(() => interpolateParams({ text: '{{env:APP_PASSWORD}}' }, {}, 0))
      .toThrow(/APP_PASSWORD is set but empty/);
  });

  it('yields a string for a whole-string token, since environment values are strings', () => {
    process.env.APP_PORT = '3000';
    expect(interpolateParams({ port: '{{env:APP_PORT}}' }, {}, 0)).toEqual({ port: '3000' });
  });

  it('leaves the other token kinds working alongside it', () => {
    process.env.APP_USER = 'alice';
    const out = interpolateParams(
      { a: '{{env:APP_USER}}', b: '{{var:r.id}}', c: '{{timestamp}}' },
      { r: { id: 7 } },
      1234,
    );
    expect(out).toEqual({ a: 'alice', b: 7, c: 1234 });
  });

  it('does not treat a lowercase or hyphenated name as a token', () => {
    expect(hasTemplateToken('{{env:app-password}}')).toBe(false);
    expect(interpolateParams({ t: '{{env:app-password}}' }, {}, 0)).toEqual({ t: '{{env:app-password}}' });
  });
});

describe('a token-bearing step does not prompt for variables', () => {
  let dir: string;
  let recorder: CommandRecorder;
  let replay: any;
  let typed: string[];
  const original = { ...process.env };

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'cdp-env-token-'));
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
      commands: [{ tool: 'input', params: { action: 'type', selector: '#password', text: '{{env:APP_PASSWORD}}', connectionReason: 'suite' } }],
    }));
    await recorder.loadSequenceFromDisk(join(dir, 'login.json'));
  });

  afterEach(async () => {
    process.env = { ...original };
    recorder.stopSequenceWatch();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs without variables and types the environment value', async () => {
    process.env.APP_PASSWORD = 'from-env';

    const res = await replay.handler({ action: 'run', wait: true, name: 'login', connectionReason: 'suite' } as any);

    expect(res._meta?.replay?.prompted).toBeUndefined();
    expect(typed).toEqual(['from-env']);
  });

  it('lets an explicitly supplied value win over the environment', async () => {
    process.env.APP_PASSWORD = 'from-env';

    await replay.handler({
      action: 'run', wait: true, name: 'login', connectionReason: 'suite',
      variables: { var_0__password: 'from-caller' },
    } as any);

    expect(typed).toEqual(['from-caller']);
  });

  it('fails the run when the variable is unset', async () => {
    delete process.env.APP_PASSWORD;

    const res = await replay.handler({ action: 'run', wait: true, name: 'login', connectionReason: 'suite' } as any);

    expect(res._meta?.replay?.success).toBe(false);
    expect(typed).toEqual([]);
  });
});
