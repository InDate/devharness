/**
 * `runAll` fans `run` out over a folder, so a per-run option either carries or
 * is deliberately withheld. Two carry that a suite needs:
 *
 *  - `baseUrl` retargets every sequence at the same deployment. A suite that
 *    could only run against the recorded origin is a suite that can only test
 *    the machine it was recorded on.
 *  - `killChromeOnFinish` means the SUITE's finish, so only the last sequence
 *    carries it: passing it to each one tears down the browser between
 *    sequences and destroys the state a _helpers preamble established.
 *
 * The rest (startFrom/stepTo/stepCount/startUrl) address one specific
 * sequence and are cleared.
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
let gotoUrls: string[];
let killCalls: number;

const writeSequence = async (name: string, url: string) => {
  await fs.writeFile(join(dir, `${name}.json`), JSON.stringify({
    id: `seq-${name}`, name, createdAt: 1,
    commands: [{ tool: 'navigate', params: { action: 'goto', url, connectionReason: 'suite' } }],
  }));
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-runall-parity-'));
  recorder = new CommandRecorder();
  gotoUrls = [];
  killCalls = 0;
  vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(dir);

  ({ replay } = createReplayTools(
    recorder,
    vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
      if (tool === 'navigate' && params.action === 'goto') gotoUrls.push(String(params.url));
      if (tool === 'killChrome') killCalls++;
      return { content: [{ type: 'text', text: '' }] };
    })) as any,
    async () => null,          // no page -> no cursor/overlay injection
    async () => 9222,
    undefined
  ));
});

afterEach(async () => {
  recorder.stopSequenceWatch();
  await fs.rm(dir, { recursive: true, force: true });
});

const runAll = (params: Record<string, any> = {}) =>
  replay.handler({ action: 'runAll', ...params } as any);

describe('runAll carries baseUrl', () => {
  it('retargets every sequence in the suite', async () => {
    await writeSequence('a-first', 'https://staging.example.com/one');
    await writeSequence('b-second', 'https://staging.example.com/two?q=1');

    await runAll({ baseUrl: 'https://cue-test.pages.dev', connectionReason: 'suite' });

    expect(gotoUrls).toEqual([
      'https://cue-test.pages.dev/one',
      'https://cue-test.pages.dev/two?q=1',
    ]);
  });

  it('leaves the recorded origin in place when no baseUrl is given', async () => {
    await writeSequence('a-first', 'https://staging.example.com/one');

    await runAll({ connectionReason: 'suite' });

    expect(gotoUrls).toEqual(['https://staging.example.com/one']);
  });

  it('does not write the retarget back to the sequence file', async () => {
    await writeSequence('a-first', 'https://staging.example.com/one');

    await runAll({ baseUrl: 'https://cue-test.pages.dev', connectionReason: 'suite' });

    const onDisk = JSON.parse(await fs.readFile(join(dir, 'a-first.json'), 'utf-8'));
    expect(onDisk.commands[0].params.url).toBe('https://staging.example.com/one');
  });
});

describe('runAll carries killChromeOnFinish once', () => {
  it('kills after the last sequence, not between them', async () => {
    await writeSequence('a-first', 'https://staging.example.com/one');
    await writeSequence('b-second', 'https://staging.example.com/two');

    await runAll({ killChromeOnFinish: true, connectionReason: 'suite' });

    expect(gotoUrls.length).toBe(2);
    expect(killCalls).toBe(1);
  });

  it('kills nothing when it is not asked for', async () => {
    await writeSequence('a-first', 'https://staging.example.com/one');
    await writeSequence('b-second', 'https://staging.example.com/two');

    await runAll({ connectionReason: 'suite' });

    expect(killCalls).toBe(0);
  });
});
