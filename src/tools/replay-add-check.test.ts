/**
 * `addCheck` writes a check step from its parameters. A check that runs
 * another sequence has no other authoring route: a recorded assert or wait
 * becomes a check that only continues or stops.
 */
import { describe, it, expect, vi } from 'vitest';
import { createReplayTools } from './replay-tools.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';

const seq = (name: string, commands: RecordedCommand[] = []): CommandSequence => ({
  id: `id-${name}`,
  name,
  commands,
  createdAt: 1,
});

function makeReplay(options?: {
  sequences?: CommandSequence[];
  onDisk?: Array<{ name: string; location: string }>;
  saveResult?: any;
}) {
  const sequences = options?.sequences ?? [seq('main', [{ tool: 'navigate', params: {} }])];
  const recorder = {
    listSequences: vi.fn(() => sequences),
    getSequence: vi.fn((id: string) => sequences.find(s => s.id === id)),
    getFreshSequence: vi.fn(async (id: string) => sequences.find(s => s.id === id)),
    loadSequenceFromDisk: vi.fn(async () => null),
    listSavedSequencesOnDisk: vi.fn(async () => options?.onDisk ?? []),
    saveSequenceToDisk: vi.fn(async () => options?.saveResult ?? null),
    recordCommand: vi.fn(),
  } as any;
  const { replay } = createReplayTools(recorder, vi.fn());
  return { recorder, replay, sequences };
}

const call = (replay: any, args: any) => replay.handler(args);
const text = (res: any) => res.content[0].text as string;
const guard = (run: string) => ({ selector: '.cookie-banner', condition: 'present', holds: { run }, fails: 'continue' });

describe('replay addCheck', () => {
  it('appends a check step with the parameters given', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }]), seq('dismiss-banner')],
    });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('dismiss-banner') });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands).toEqual([
      { tool: 'navigate', params: {} },
      { tool: 'check', params: guard('dismiss-banner') },
    ]);
    expect(text(res)).toContain('**Step 2** of 2');
    expect(text(res)).toContain('run `dismiss-banner`');
  });

  it('inserts at insertAfterStep rather than appending', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }, { tool: 'input', params: {} }]), seq('setup')],
    });

    await call(replay, { action: 'addCheck', name: 'main', check: guard('setup'), insertAfterStep: 0 });

    expect(sequences[0].commands.map(c => c.tool)).toEqual(['check', 'navigate', 'input']);
  });

  it('writes a check that only reads, with no sequence to run', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, {
      action: 'addCheck', name: 'main', check: { selector: '#done', condition: 'visible', withinMs: 5000 },
    });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands).toEqual([
      { tool: 'check', params: { selector: '#done', condition: 'visible', withinMs: 5000 } },
    ]);
    expect(text(res)).toContain('**On pass:** continue');
    expect(text(res)).toContain('**On fail:** stop');
  });

  it('rejects insertAfterStep past the end of the sequence', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main', [{ tool: 'navigate', params: {} }]), seq('setup')] });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('setup'), insertAfterStep: 5 });

    expect(res.isError).toBe(true);
    expect(sequences[0].commands).toHaveLength(1);
  });

  it('rejects parameters the check tool would refuse, before mutating the sequence', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main'), seq('setup')] });

    const res = await call(replay, {
      action: 'addCheck', name: 'main', check: { selector: '.x', condition: 'shiny' },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('condition');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('rejects a sequence to run that does not exist', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('typo-sequence') });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('typo-sequence');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('checks the sequence run on a fail as well as on a pass', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, {
      action: 'addCheck', name: 'main', check: { selector: '.x', condition: 'present', fails: { run: 'recover' } },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('recover');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('accepts a sequence to run that only exists on disk', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main')],
      onDisk: [{ name: 'dismiss-banner', location: 'working-dir' }],
    });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('dismiss-banner') });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands).toHaveLength(1);
  });

  it('rejects a check running its own sequence', async () => {
    const { replay, sequences } = makeReplay({ sequences: [seq('main')] });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('main') });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('maxConditionalDepth');
    expect(sequences[0].commands).toHaveLength(0);
  });

  it('shifts resumeAt into the list the check goes into', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [
        seq('main', [{ tool: 'navigate', params: {} }, { tool: 'input', params: {} }, { tool: 'input', params: {} }]),
        seq('setup'),
      ],
    });

    // Resuming at the old step 3 (index 2); the check goes in after step 1,
    // so that step is index 3 once it is in.
    await call(replay, {
      action: 'addCheck', name: 'main', insertAfterStep: 1,
      check: { selector: '.x', condition: 'present', holds: { run: 'setup', resumeAt: 2 } },
    });

    expect(sequences[0].commands[1]).toEqual({
      tool: 'check', params: { selector: '.x', condition: 'present', holds: { run: 'setup', resumeAt: 3 } },
    });
  });

  it('rejects a resumeAt at or before the check itself', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }, { tool: 'input', params: {} }]), seq('setup')],
    });

    const res = await call(replay, {
      action: 'addCheck', name: 'main', insertAfterStep: 1,
      check: { selector: '.x', condition: 'present', holds: { run: 'setup', resumeAt: 0 } },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('resume');
    expect(sequences[0].commands).toHaveLength(2);
  });

  it('accepts a resumeAt at the end of the list, which ends the run', async () => {
    const { replay, sequences } = makeReplay({
      sequences: [seq('main', [{ tool: 'navigate', params: {} }, { tool: 'input', params: {} }]), seq('setup')],
    });

    const res = await call(replay, {
      action: 'addCheck', name: 'main', insertAfterStep: 1,
      check: { selector: '.x', condition: 'present', holds: { run: 'setup', resumeAt: 2 } },
    });

    expect(res.isError).toBeFalsy();
    expect(sequences[0].commands[1].params.holds).toEqual({ run: 'setup', resumeAt: 3 });
  });

  it('reports a file that did not take the check as an error', async () => {
    const { replay } = makeReplay({
      sequences: [seq('main'), seq('setup')],
      onDisk: [{ name: 'main', location: 'working-dir' }],
      saveResult: { success: false, error: 'EACCES' },
    });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('setup') });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('EACCES');
  });

  it('re-persists a sequence that already exists on disk', async () => {
    const { replay, recorder } = makeReplay({
      sequences: [seq('main'), seq('setup')],
      onDisk: [{ name: 'main', location: 'global' }],
      saveResult: { success: true, filepath: '/home/u/.devharness/sequences/main.json' },
    });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('setup') });

    // global: true, overwrite: true - the file it came from.
    expect(recorder.saveSequenceToDisk).toHaveBeenCalledWith('id-main', true, true);
    expect(text(res)).toContain('/home/u/.devharness/sequences/main.json');
  });

  it('tells the caller to export when the sequence is memory-only', async () => {
    const { replay, recorder } = makeReplay({ sequences: [seq('main'), seq('setup')] });

    const res = await call(replay, { action: 'addCheck', name: 'main', check: guard('setup') });

    expect(recorder.saveSequenceToDisk).not.toHaveBeenCalled();
    expect(text(res)).toContain("action: 'export'");
  });

  it('requires check', async () => {
    const { replay } = makeReplay();
    const res = await call(replay, { action: 'addCheck', name: 'main' });
    expect(res.isError).toBe(true);
  });
});
