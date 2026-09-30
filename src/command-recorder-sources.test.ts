// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CommandRecorder } from './command-recorder.js';
import { activityPathFor } from './sequence-activity.js';
import { setWorkingDirOverride } from './helpers/paths.js';

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'recorder-sources-'));
  setWorkingDirOverride(dir);
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

const sequenceFile = (name: string) => JSON.stringify({ id: `id-${name}`, name, createdAt: 1, commands: [{ tool: 'navigate', params: { action: 'reload' } }] });

async function touchLater(file: string) {
  const later = new Date(Date.now() + 5000);
  await fsp.utimes(file, later, later);
}

describe('a sequence removed from memory', () => {
  it('is not brought back when its file changes afterwards', async () => {
    const recorder = new CommandRecorder();
    const file = join(dir, 'removed-one.json');
    await fsp.writeFile(file, sequenceFile('removed-one'));
    const loaded = await recorder.loadSequenceFromDisk(file);

    recorder.deleteSequence(loaded!.id);
    await touchLater(file);
    const reloaded = await recorder.reloadChangedSequences();

    expect(reloaded).toEqual([]);
    expect(recorder.listSequences().map(s => s.name)).not.toContain('removed-one');
    recorder.stopSequenceWatch();
  });

  it('replaced by a same-named load is not reloaded over the one that replaced it', async () => {
    const recorder = new CommandRecorder();
    const first = join(dir, 'first-copy.json');
    const second = join(dir, 'second-copy.json');
    await fsp.writeFile(first, JSON.stringify({ ...JSON.parse(sequenceFile('shared-name')), id: 'id-first' }));
    await fsp.writeFile(second, JSON.stringify({ ...JSON.parse(sequenceFile('shared-name')), id: 'id-second' }));
    await recorder.loadSequenceFromDisk(first);
    await recorder.loadSequenceFromDisk(second);

    await touchLater(first);
    await recorder.reloadChangedSequences();

    expect(recorder.listSequences().filter(s => s.name === 'shared-name').map(s => s.id)).toEqual(['id-second']);
    recorder.stopSequenceWatch();
  });
});

describe('a sequence deleted from disk', () => {
  it('takes its activity file with it', async () => {
    const recorder = new CommandRecorder();
    const file = join(dir, 'with-activity.json');
    await fsp.writeFile(file, sequenceFile('with-activity'));
    const activity = activityPathFor(file);
    await fsp.mkdir(join(activity, '..'), { recursive: true });
    await fsp.writeFile(activity, '{}');

    expect(await recorder.deleteSequenceFromDisk(file)).toBe(true);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(activity)).toBe(false);
  });
});
