/**
 * A `variables` key that names no typed-text step is a typo the caller has to
 * hear about before anything runs.
 *
 * The executor matches keys exactly and nothing else looks at them, so an
 * unmatched key was dropped in silence and the step ran on its RECORDED text
 * while the call read as an override - a recorded credential reaching the live
 * app with the run reporting success. The `connections` rebinding already
 * rejects a reference that names no recorded step for the same reason.
 *
 * Two scopes, because the map means different things:
 *  - `run` checks against the sequence plus everything it nests into;
 *  - `runAll` holds ONE map for the whole suite, so a key is a typo only when
 *    it matches no member. A per-sequence check there would reject a key meant
 *    for a different one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

let dir: string;
let recorder: CommandRecorder;
let replay: any;
let typed: Array<{ selector?: string; text: string }>;

const write = async (name: string, commands: any[]) => {
  await fs.writeFile(join(dir, `${name}.json`), JSON.stringify({
    id: `seq-${name}`, name, createdAt: 1, commands,
  }));
};

const typeStep = (selector: string, text: string) =>
  ({ tool: 'input', params: { action: 'type', selector, text, connectionReason: 'suite' } });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-varkeys-'));
  recorder = new CommandRecorder();
  typed = [];
  vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(dir);

  const fieldValues = new Map<string, string>();
  ({ replay } = createReplayTools(
    recorder,
    vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
      if (tool === 'input' && params.action === 'type') {
        typed.push({ selector: params.selector, text: String(params.text) });
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
});

afterEach(async () => {
  recorder.stopSequenceWatch();
  await fs.rm(dir, { recursive: true, force: true });
});

const text = (res: any) => res.content.map((c: any) => c.text).join('\n');

describe('run rejects a key that names no step', () => {
  beforeEach(async () => {
    await write('login', [typeStep('#password', 'recorded-secret')]);
    await recorder.loadSequenceFromDisk(join(dir, 'login.json'));
  });

  it('names the key, states the transform, and lists what is substitutable', async () => {
    const res = await replay.handler({
      action: 'run', wait: true, name: 'login', connectionReason: 'suite',
      variables: { 'var_0_#password': 'supplied' },
    } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('var_0_#password');
    expect(text(res)).toContain('var_0__password');
    expect(typed).toEqual([]);
  });

  it('accepts the key the executor actually builds', async () => {
    const res = await replay.handler({
      action: 'run', wait: true, name: 'login', connectionReason: 'suite',
      variables: { var_0__password: 'supplied' },
    } as any);

    expect(res.isError).toBeUndefined();
    expect(typed).toEqual([{ selector: '#password', text: 'supplied' }]);
  });

  it('accepts a key that names a step in a sequence it nests into', async () => {
    await write('outer', [{ tool: 'conditional', params: { if: '{{localStorage:x}}', then: 'login' } }]);
    await recorder.loadSequenceFromDisk(join(dir, 'outer.json'));

    const res = await replay.handler({
      action: 'run', wait: true, name: 'outer', connectionReason: 'suite',
      variables: { var_0__password: 'supplied' },
    } as any);

    expect(res.isError).toBeUndefined();
  });

  it('accepts an empty map, which is how a caller keeps the recorded values', async () => {
    const res = await replay.handler({
      action: 'run', wait: true, name: 'login', connectionReason: 'suite', variables: {},
    } as any);

    expect(res.isError).toBeUndefined();
    expect(typed).toEqual([{ selector: '#password', text: 'recorded-secret' }]);
  });
});

describe('runAll checks the map against the whole suite', () => {
  beforeEach(async () => {
    await write('a-first', [typeStep('#email', 'recorded@example.com')]);
    await write('b-second', [typeStep('#password', 'recorded-secret')]);
  });

  it('accepts a key that matches only one member, and leaves the other on its recorded text', async () => {
    const res = await replay.handler({
      action: 'runAll', connectionReason: 'suite',
      variables: { var_0__password: 'supplied' },
    } as any);

    expect(res.isError).toBeUndefined();
    expect(typed).toEqual([
      { selector: '#email', text: 'recorded@example.com' },
      { selector: '#password', text: 'supplied' },
    ]);
  });

  it('rejects a key that matches no member, before anything runs', async () => {
    const res = await replay.handler({
      action: 'runAll', connectionReason: 'suite',
      variables: { var_0__nosuchfield: 'supplied' },
    } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('var_0__nosuchfield');
    expect(typed).toEqual([]);
  });
});
