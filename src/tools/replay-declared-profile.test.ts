/**
 * A sequence can declare which persistent Chrome profile a browser comes up
 * on: `requiredConnections: [{ connection: 'device-a', profile: 'device-a' }]`.
 *
 * The profile is the durable half - cookies, localStorage and IndexedDB
 * survive between runs, so a device enrolled once stays enrolled - while the
 * reference is only a name for this session. Steps still address browsers by
 * reference; nothing about a step changes (issue #104).
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

type Declaration = NonNullable<CommandSequence['requiredConnections']>[number];

function makeReplay(declared: Declaration[], commands?: RecordedCommand[]) {
  const sequence = {
    id: 'seq-profile',
    name: 'profile-seq',
    createdAt: 1,
    startUrl: 'http://localhost:5173/',
    commands: (commands ?? [{ tool: 'dom', params: { action: 'querySelector', selector: '#a' } }]) as RecordedCommand[],
    requiredConnections: declared,
  } as CommandSequence;

  const recorder = {
    getSequence: vi.fn(() => sequence),
    getFreshSequence: vi.fn(async () => sequence),
    listSequences: vi.fn(() => [sequence]),
    loadSequenceFromDisk: vi.fn(async () => sequence),
    getHistory: vi.fn(() => []),
    getCurrentHistoryIndex: vi.fn(() => 0),
    recordCommand: vi.fn(),
    setActiveSequence: vi.fn(),
    getActiveSequence: vi.fn(() => null),
  } as any;

  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    return { content: [{ type: 'text', text: '' }] };
  }));

  const { replay } = createReplayTools(
    recorder,
    executeToolCall,
    async () => null,
    async () => 9222,
    undefined
  );
  return { replay, calls };
}

const run = (replay: any, extra: Record<string, any> = {}) =>
  replay.handler({
    action: 'run', wait: true, sequenceId: 'seq-profile',
    connection: 'run-device', ...extra,
  } as any);

const launches = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => c.tool === 'connection' && c.params.action === 'launch').map(c => c.params);

const text = (res: any) => res.content[0].text as string;

describe('a declared connection with a profile', () => {
  it('launches the reference on that profile', async () => {
    const { replay, calls } = makeReplay([
      { connection: 'device-a', profile: 'device-a', role: 'the enrolled member' },
    ]);

    await run(replay);

    expect(launches(calls)).toContainEqual(expect.objectContaining({
      connection: 'device-a',
      profile: 'device-a',
    }));
  });

  it('reuses the browser already on that profile rather than forcing a second', async () => {
    // Only one live Chrome may hold a profile, so the declaration default of
    // "a distinct process" would fail against the very browser it wants.
    const { replay, calls } = makeReplay([{ connection: 'device-a', profile: 'device-a' }]);

    await run(replay);

    expect(launches(calls)).toContainEqual(expect.objectContaining({
      connection: 'device-a',
      forceNewInstance: false,
    }));
  });

  it('still forces a new process when the declaration asks for one explicitly', async () => {
    const { replay, calls } = makeReplay([
      { connection: 'device-a', profile: 'device-a', forceNewInstance: true },
    ]);

    await run(replay);

    expect(launches(calls)).toContainEqual(expect.objectContaining({
      connection: 'device-a',
      forceNewInstance: true,
    }));
  });

  it('keeps the profile-less default of a distinct process', async () => {
    const { replay, calls } = makeReplay([{ connection: 'plain-b' }]);

    await run(replay);

    expect(launches(calls)).toContainEqual(expect.objectContaining({
      connection: 'plain-b',
      forceNewInstance: true,
    }));
    expect(launches(calls).every(p => p.profile === undefined)).toBe(true);
  });
});

describe('declarations that cannot mean what they say', () => {
  it('refuses two references on one profile, before launching anything', async () => {
    const { replay, calls } = makeReplay([
      { connection: 'device-a', profile: 'shared' },
      { connection: 'device-b', profile: 'shared' },
    ]);

    const res = await run(replay);

    expect(text(res)).toContain('same persistent profile "shared"');
    expect(text(res)).toContain('device-a, device-b');
    expect(launches(calls)).toEqual([]);
  });

  it('refuses a connections rebind of a profile-bearing reference', async () => {
    // A declaration is normally just a default that a rebind overrides. A
    // profile is an identity claim: pointing it elsewhere would run device-a's
    // steps in a browser that is not device-a, and pass.
    const { replay, calls } = makeReplay(
      [{ connection: 'device-a', profile: 'device-a' }],
      [{ tool: 'dom', params: { action: 'querySelector', selector: '#a', connection: 'device-a' } }],
    );

    const res = await run(replay, { connections: { 'device-a': 'some-other-browser' } });

    expect(text(res)).toContain('identity');
    expect(text(res)).toContain('device-a');
    expect(launches(calls)).toEqual([]);
  });

  it('still lets a profile-less declaration be rebound', async () => {
    const { replay, calls } = makeReplay(
      [{ connection: 'plain-b' }],
      [{ tool: 'dom', params: { action: 'querySelector', selector: '#a', connection: 'plain-b' } }],
    );

    await run(replay, { connections: { 'plain-b': 'my-second-browser' } });

    // Rebound onto a browser the caller supplied: nothing to launch for it.
    expect(launches(calls).some(p => p.name === 'plain-b')).toBe(false);
  });
});
