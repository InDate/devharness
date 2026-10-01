/**
 * `declare` is the authoring route for what a sequence NEEDS, as opposed to
 * what it does: the browsers (`requiredConnections`) and the sockets its
 * assertions ride on (`requiredSockets`).
 *
 * Neither can be recorded - they are statements about a run, not steps in it -
 * so before this the only way to add them was to hand-edit the JSON, which the
 * rest of the guidance tells you not to do.
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

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-declare-'));
  recorder = new CommandRecorder();
  vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(dir);

  await fs.writeFile(join(dir, 'duo-flow.json'), JSON.stringify({
    id: 'seq-duo', name: 'duo-flow', createdAt: 1,
    commands: [{ tool: 'dom', params: { action: 'querySelector', selector: '#a' } }],
  }));
  await recorder.loadSequenceFromDisk(join(dir, 'duo-flow.json'));

  ({ replay } = createReplayTools(
    recorder,
    vi.fn(productionShaped(async () => ({ content: [{ type: 'text', text: '' }] }))) as any,
    async () => null,
    async () => 9222,
    undefined
  ));
});

afterEach(async () => {
  recorder.stopSequenceWatch();
  await fs.rm(dir, { recursive: true, force: true });
});

const declare = (params: Record<string, any>) =>
  replay.handler({ action: 'declare', name: 'duo-flow', ...params } as any);

const text = (res: any) => res.content[0].text as string;
const onDisk = async () => JSON.parse(await fs.readFile(join(dir, 'duo-flow.json'), 'utf-8'));

describe('declare', () => {
  it('records the browsers a sequence needs, and writes them back to its file', async () => {
    const res = await declare({
      requiredConnections: [
        { connection: 'duo-member-two', profile: 'device-a', role: 'the enrolled member' },
      ],
    });

    expect(text(res)).toContain('duo-member-two');
    expect(text(res)).toContain('device-a');
    expect((await onDisk()).requiredConnections).toEqual([
      { connection: 'duo-member-two', profile: 'device-a', role: 'the enrolled member' },
    ]);
  });

  it('records the sockets the assertions ride on', async () => {
    await declare({ requiredSockets: ['/api/sync/socket'] });

    expect((await onDisk()).requiredSockets).toEqual(['/api/sync/socket']);
  });

  it('replaces rather than merges, so a browser can be removed', async () => {
    await declare({ requiredConnections: [{ connection: 'device-one-phone' }, { connection: 'device-two-phone' }] });
    await declare({ requiredConnections: [{ connection: 'device-one-phone' }] });

    expect((await onDisk()).requiredConnections).toEqual([{ connection: 'device-one-phone' }]);
  });

  it('clears a declaration with an empty list', async () => {
    await declare({ requiredSockets: ['/api/sync/socket'] });
    await declare({ requiredSockets: [] });

    expect((await onDisk()).requiredSockets).toBeUndefined();
  });

  it('leaves the other declaration alone', async () => {
    await declare({ requiredSockets: ['/api/sync/socket'] });
    await declare({ requiredConnections: [{ connection: 'device-one-phone' }] });

    const saved = await onDisk();
    expect(saved.requiredSockets).toEqual(['/api/sync/socket']);
    expect(saved.requiredConnections).toEqual([{ connection: 'device-one-phone' }]);
  });
});

describe('declarations that cannot mean what they say are refused at authoring time', () => {
  it('refuses two references on one profile', async () => {
    const res = await declare({
      requiredConnections: [
        { connection: 'device-one-phone', profile: 'shared' },
        { connection: 'device-two-phone', profile: 'shared' },
      ],
    });

    expect(text(res)).toContain('same persistent profile "shared"');
    expect((await onDisk()).requiredConnections).toBeUndefined();
  });

  it('refuses a reference that a launch would refuse, before the run reaches it', async () => {
    const res = await declare({ requiredConnections: [{ connection: 'device-a' }] });

    expect(text(res)).toContain('exactly 3 words');
    expect((await onDisk()).requiredConnections).toBeUndefined();
  });

  it('refuses the same reference twice', async () => {
    const res = await declare({
      requiredConnections: [{ connection: 'device-one-phone' }, { connection: 'device-one-phone' }],
    });

    expect(text(res)).toContain('declared twice');
  });

  it('refuses a profile name that is not a safe directory segment', async () => {
    const res = await declare({
      requiredConnections: [{ connection: 'device-one-phone', profile: '../escape' }],
    });

    expect(text(res)).toContain('Invalid profile name');
  });

  it('refuses an empty socket pattern, which would match every socket', async () => {
    const res = await declare({ requiredSockets: ['  '] });

    expect(text(res)).toContain('matches every socket');
  });

  it('says what it needs when given neither list', async () => {
    const res = await declare({});

    expect(text(res)).toContain('requiredConnections');
    expect(text(res)).toContain('requiredSockets');
  });
});
