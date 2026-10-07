/**
 * `.devharness/sequences.env` supplies {{env:NAME}} to a run that names no
 * envFile, which is every bench play.
 */
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
    getProjectDir: () => project.dir,
  };
});

import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { historyPlace } from '../call-origin.js';

describe('the project envFile', () => {
  let recorder: CommandRecorder;
  let replay: any;
  let typed: string[];
  let dropsTyping = false;
  const original = { ...process.env };

  beforeEach(async () => {
    project.dir = await fs.mkdtemp(join(tmpdir(), 'cdp-envdefault-'));
    await fs.mkdir(join(project.dir, '.devharness'));
    recorder = new CommandRecorder();
    typed = [];
    vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(project.dir);
    const fieldValues = new Map<string, string>();
    ({ replay } = createReplayTools(
      recorder,
      vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
        const place = historyPlace();
        if (place) await recorder.recordCommand(tool, params, { ...place, result: { content: [] } });
        if (tool === 'input' && params.action === 'type') {
          typed.push(String(params.text));
          if (!dropsTyping) fieldValues.set(String(params.selector), String(params.text));
        }
        if (tool === 'inspect' && params.action === 'evaluateExpression') {
          const selector = String(params.expression).match(/querySelector\((['"])(.*?)\1\)/)?.[2] ?? '';
          const value = fieldValues.get(selector) ?? '';
          return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(value) + '\n```' }], _meta: { inspect: { value } } };
        }
        return { content: [{ type: 'text', text: '' }] };
      })) as any,
      async () => null,
      async () => 9222,
      undefined
    ));
    await fs.writeFile(join(project.dir, 'login.json'), JSON.stringify({
      id: 'seq-login', name: 'login', createdAt: 1,
      commands: [
        { tool: 'input', params: { action: 'click', selector: '#password', connection: 'app' } },
        { tool: 'input', params: { action: 'type', selector: '#password', text: '{{env:APP_PASSWORD}}', connection: 'app' } },
      ],
    }));
    await recorder.loadSequenceFromDisk(join(project.dir, 'login.json'));
    delete process.env.APP_PASSWORD;
    dropsTyping = false;
  });

  afterEach(async () => {
    process.env = { ...original };
    recorder.stopSequenceWatch();
    await fs.rm(project.dir, { recursive: true, force: true });
  });

  const text = (res: any) => res.content.map((c: any) => c.text).join('\n');

  it('supplies a run that names no envFile, and the reply names the file and the name, never the value', async () => {
    await fs.writeFile(join(project.dir, '.devharness', 'sequences.env'), 'APP_PASSWORD=from-default\n');

    const res = await replay.handler({ action: 'run', wait: true, name: 'login', connection: 'app' });

    expect(typed).toEqual(['from-default']);
    expect(text(res)).toContain('{{env:}} from .devharness/sequences.env: APP_PASSWORD');
    expect(text(res)).not.toContain('from-default');
  });

  it('carries its values through a pause, so finish resolves the step after it', async () => {
    await fs.writeFile(join(project.dir, '.devharness', 'sequences.env'), 'APP_PASSWORD=from-default\n');

    await replay.handler({ action: 'run', wait: true, name: 'login', connection: 'app', stepTo: 1 });
    const res = await replay.handler({ action: 'finish' });

    expect(res.isError).toBeUndefined();
    expect(typed).toEqual(['from-default']);
  });

  it('names the file to add a missing name to, where no envFile was read', async () => {
    const res = await replay.handler({ action: 'run', wait: true, name: 'login', connection: 'app' });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('failed at step 2 of 2');
    expect(text(res)).toContain('add APP_PASSWORD=<value> to .devharness/sequences.env');
  });

  it('keeps the value out of the reply when the field does not take it', async () => {
    await fs.writeFile(join(project.dir, '.devharness', 'sequences.env'), 'APP_PASSWORD=from-default\n');
    dropsTyping = true;

    const res = await replay.handler({ action: 'run', wait: true, name: 'login', connection: 'app' });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Text validation failed for #password: expected 12 characters, not shown');
    expect(text(res)).not.toContain('from-default');
  });
});
