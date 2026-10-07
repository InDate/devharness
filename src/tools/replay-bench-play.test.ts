/**
 * `replay run` with `bench: true` replies with the play's run table. A step
 * that failed before its call was recorded has no History row, so its reason
 * comes from the bench's state.
 */
import { describe, it, expect, vi } from 'vitest';

const play = vi.hoisted(() => ({ failed: true, recorder: undefined as any, envFiles: [] as string[], plays: 0 }));
const reason = 'Could not resolve template token {{env:SOCKET_APP_TOKEN}}: SOCKET_APP_TOKEN is not set: no envFile was read and the server\'s environment lacks it - add SOCKET_APP_TOKEN=<value> to .devharness/sequences.env, which every run reads when it names no envFile (the sequence file deliberately holds no value for it)';

vi.mock('../bench-mode.js', () => ({
  isBenchOpen: () => true,
  selectSequence: async () => undefined,
  gotoSequenceStep: async () => undefined,
  playSequence: async () => play.failed
    ? { total: 5, currentStep: 1, failure: reason,
        steps: [0, 1, 2, 3, 4].map(index => ({ index, ...(index === 1 ? { failed: true } : {}) })) }
    : (await play.recorder.recordCommand('input', { action: 'type', text: '{{env:SOCKET_APP_TOKEN}}' }, {
        run: 'env-token-search', runStep: 0, result: { content: [] },
        env: { file: '.devharness/sequences.env', names: ['SOCKET_APP_TOKEN'] },
      }), { total: 1, currentStep: 1, steps: [{ index: 0 }] }),
  getBenchSession: () => ({ benchUrl: 'http://127.0.0.1:1/bench/' }),
  setSequenceEnvFile: (_connection: string, envFile: string) => { play.envFiles.push(envFile); return true; },
}));

import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';

describe('a bench play whose step failed before it was recorded', () => {
  it('names that step and its whole reason', async () => {
    const recorder = new CommandRecorder();
    const { replay } = createReplayTools(recorder, vi.fn() as any, async () => null, async () => 9222, undefined);

    const res: any = await replay.handler({ action: 'run', name: 'env-token-search', connection: 'app', bench: true, wait: true } as any);
    const text = res.content.map((c: any) => c.text).join('\n');

    expect(text).toContain('env-token-search failed at step 2 of 5');
    expect(text).toContain(`Step 2: ${reason}`);
    recorder.stopSequenceWatch();
  });

  it('names the file a step took a value from, and the name', async () => {
    play.failed = false;
    const recorder = play.recorder = new CommandRecorder();
    const { replay } = createReplayTools(recorder, vi.fn() as any, async () => null, async () => 9222, undefined);

    const res: any = await replay.handler({ action: 'run', name: 'env-token-search', connection: 'app', bench: true, wait: true } as any);
    const text = res.content.map((c: any) => c.text).join('\n');

    expect(text).toContain('env-token-search completed 1 of 1');
    expect(text).toContain('{{env:}} from .devharness/sequences.env: SOCKET_APP_TOKEN');
    recorder.stopSequenceWatch();
  });
});

describe('a bench play given an env file', () => {
  it('reads the file and sets it on the bench before the play', async () => {
    const { promises: fs } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await fs.mkdtemp(join(tmpdir(), 'cdp-bench-env-'));
    const file = join(dir, 'local.env');
    await fs.writeFile(file, 'KEEL_PASSWORD=secret\n');
    play.failed = false;
    play.envFiles = [];
    const recorder = play.recorder = new CommandRecorder();
    const { replay } = createReplayTools(recorder, vi.fn() as any, async () => null, async () => 9222, undefined);

    const res: any = await replay.handler({ action: 'run', name: 'env-token-search', connection: 'app', bench: true, wait: true, envFile: file } as any);

    expect(res.isError).toBeFalsy();
    expect(play.envFiles).toEqual([file]);
    recorder.stopSequenceWatch();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a file that does not exist, and sets nothing', async () => {
    play.envFiles = [];
    const recorder = new CommandRecorder();
    const { replay } = createReplayTools(recorder, vi.fn() as any, async () => null, async () => 9222, undefined);

    const res: any = await replay.handler({ action: 'run', name: 'env-token-search', connection: 'app', bench: true, wait: true, envFile: '/nonexistent/local.env' } as any);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('envFile');
    expect(play.envFiles).toEqual([]);
    recorder.stopSequenceWatch();
  });

  it('still refuses a baseUrl, which a bench play does not carry', async () => {
    const recorder = new CommandRecorder();
    const { replay } = createReplayTools(recorder, vi.fn() as any, async () => null, async () => 9222, undefined);

    const res: any = await replay.handler({ action: 'run', name: 'env-token-search', connection: 'app', bench: true, wait: true, baseUrl: 'http://localhost:9000' } as any);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Not carried into a bench play: baseUrl');
    recorder.stopSequenceWatch();
  });
});
