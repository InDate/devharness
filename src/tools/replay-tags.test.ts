/**
 * Tags say what KIND of sequence this is, and `runAll` selects on them.
 *
 * Without them a suite reporting "36 passed" reads as interface coverage
 * whether or not any of it drove the interface: in one 43-sequence suite, 14
 * sequences never issued an `input` step - navigate, request, assert, with the
 * browser present only to hold the auth cookie. Good contract tests, but no UI
 * regression could fail one of them, and nothing said so (issue #133).
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
let run: any;

const writeSequence = async (name: string, tags?: string[]) => {
  await fs.writeFile(join(dir, `${name}.json`), JSON.stringify({
    id: `seq-${name}`, name, createdAt: 1, ...(tags ? { tags } : {}),
    commands: [{ tool: 'wait', params: { ms: 1 } }],
  }));
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'cdp-tags-'));
  recorder = new CommandRecorder();
  vi.spyOn(recorder, 'getSequencesDir').mockReturnValue(dir);

  ({ replay, run } = createReplayTools(
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

const text = (res: any) => res.content[0].text as string;
const runAll = (params: Record<string, any> = {}) => run.handler({ action: 'all', ...params } as any);

describe('declaring tags', () => {
  it('stores them on the sequence and writes them back to its file', async () => {
    await writeSequence('spine-09');
    await recorder.loadSequenceFromDisk(join(dir, 'spine-09.json'));

    const res = await replay.handler({ action: 'declare', name: 'spine-09', tags: ['ui'] } as any);

    expect(text(res)).toContain('ui');
    expect(JSON.parse(await fs.readFile(join(dir, 'spine-09.json'), 'utf-8')).tags).toEqual(['ui']);
  });

  it('normalises case, whitespace and duplicates, because a tag is matched not displayed', async () => {
    await writeSequence('spine-09');
    await recorder.loadSequenceFromDisk(join(dir, 'spine-09.json'));

    await replay.handler({ action: 'declare', name: 'spine-09', tags: ['UI', ' ui ', 'Contract'] } as any);

    expect(JSON.parse(await fs.readFile(join(dir, 'spine-09.json'), 'utf-8')).tags).toEqual(['ui', 'contract']);
  });

  it('refuses a tag with a space, which would be ambiguous in a filter', async () => {
    await writeSequence('spine-09');
    await recorder.loadSequenceFromDisk(join(dir, 'spine-09.json'));

    const res = await replay.handler({ action: 'declare', name: 'spine-09', tags: ['slow ui'] } as any);

    expect(text(res)).toContain('single words');
    expect(text(res)).toContain('slow-ui');
  });
});

describe('runAll with tags', () => {
  beforeEach(async () => {
    await writeSequence('a-ui-one', ['ui']);
    await writeSequence('b-contract-one', ['contract']);
    await writeSequence('c-contract-two', ['contract']);
    await writeSequence('d-plain', undefined);
  });

  it('runs only the sequences carrying the tag', async () => {
    const res = await runAll({ tags: ['ui'] });

    expect(text(res)).toContain('a-ui-one');
    expect(text(res)).not.toContain('b-contract-one');
    expect(text(res)).toContain('tagged ui');
  });

  it('treats several tags as "any of"', async () => {
    const res = await runAll({ tags: ['ui', 'contract'] });

    expect(text(res)).toContain('a-ui-one');
    expect(text(res)).toContain('b-contract-one');
    expect(text(res)).not.toContain('d-plain');
  });

  it('reports the split on an unfiltered run, so the balance is visible every time', async () => {
    const res = await runAll();

    expect(text(res)).toMatch(/2 contract/);
    expect(text(res)).toMatch(/1 ui/);
    expect(text(res)).toMatch(/1 untagged/);
  });

  it('says which tags exist when the filter matches nothing', async () => {
    const res = await runAll({ tags: ['smoke'] });

    expect(text(res)).toContain('smoke');
    expect(text(res)).toContain('contract');
    expect(text(res)).toContain('ui');
  });

  it('points at declare when nothing is tagged at all', async () => {
    await fs.rm(join(dir, 'a-ui-one.json'));
    await fs.rm(join(dir, 'b-contract-one.json'));
    await fs.rm(join(dir, 'c-contract-two.json'));

    const res = await runAll({ tags: ['ui'] });

    expect(text(res)).toContain("action: 'declare'");
  });
});
