/**
 * bug-010: sequence steps naming a nonexistent tool must be rejected at
 * create/load time, before any step has mutated browser state.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createReplayTools, findUnknownStepTools } from './replay-tools.js';
import { CommandRecorder } from '../command-recorder.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';

const KNOWN_TOOLS = ['navigate', 'inspect', 'input', 'screenshot', 'launchChrome'];

const seq = (commands: RecordedCommand[], name = 'hand-authored'): CommandSequence => ({
  id: 'seq-1',
  name,
  commands,
  createdAt: 1,
});

function makeRecorder(sequence: CommandSequence | null) {
  return {
    // Mirrors the real recorder: the parsed candidate is validated BEFORE it
    // replaces any same-named sequence, and a rejected candidate is never stored.
    loadSequenceFromDisk: vi.fn(async (_filename: string, options?: any) => {
      if (sequence && options?.validate && !options.validate(sequence)) return null;
      return sequence;
    }),
    // Mirrors the real recorder: the candidate is validated BEFORE it is stored,
    // and a rejected candidate is never stored at all (nothing to delete after).
    createSequence: vi.fn(async (_name: string, _indices: number[], options?: any) => {
      if (sequence && options?.validate && !options.validate(sequence)) return null;
      return sequence;
    }),
    deleteSequence: vi.fn(() => true),
    recordCommand: vi.fn(),
  } as any;
}

function makeReplay(sequence: CommandSequence | null, getKnownToolNames?: () => string[]) {
  const recorder = makeRecorder(sequence);
  const tools = createReplayTools(
    recorder,
    vi.fn(),
    undefined,
    undefined,
    getKnownToolNames
  );
  return { recorder, replay: tools.replay };
}

const text = (res: any) => res.content[0].text as string;

// ---------------------------------------------------------------------------
// findUnknownStepTools
// ---------------------------------------------------------------------------

describe('findUnknownStepTools', () => {
  it('returns nothing when every step names a known tool', () => {
    const commands = [{ tool: 'navigate' }, { tool: 'inspect' }];
    expect(findUnknownStepTools(commands, KNOWN_TOOLS)).toEqual([]);
  });

  it('reports 1-based step number and offending name', () => {
    const commands = [{ tool: 'navigate' }, { tool: 'inpsect' }, { tool: 'nope' }];
    const unknown = findUnknownStepTools(commands, KNOWN_TOOLS);
    expect(unknown.map(u => ({ step: u.step, tool: u.tool }))).toEqual([
      { step: 2, tool: 'inpsect' },
      { step: 3, tool: 'nope' },
    ]);
  });

  it('suggests a near-miss tool name for a typo', () => {
    const [unknown] = findUnknownStepTools([{ tool: 'inpsect' }], KNOWN_TOOLS);
    expect(unknown.suggestion).toBe('inspect');
  });

  it('accepts the "forEach" virtual step, which is not a registered tool', () => {
    expect(findUnknownStepTools([{ tool: 'forEach' }], KNOWN_TOOLS)).toEqual([]);
  });

  it('flags "conditional", which a check that runs a sequence replaced', () => {
    expect(findUnknownStepTools([{ tool: 'conditional' }], KNOWN_TOOLS)).toHaveLength(1);
  });

  it('flags a non-string tool field instead of throwing', () => {
    const unknown = findUnknownStepTools([{ tool: undefined }, {}], KNOWN_TOOLS);
    expect(unknown).toHaveLength(2);
  });

  it('does not inspect params (interpolation tokens must stay valid)', () => {
    const commands = [
      { tool: 'input', params: { action: 'click', x: '{{var:pos.x}}' } },
      { tool: 'navigate', params: { url: '{{var:base}}/page?t={{timestamp}}' } },
    ];
    expect(findUnknownStepTools(commands as any, KNOWN_TOOLS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe('replay load - tool name validation', () => {
  it('rejects a sequence with an unknown tool name when the provider is supplied', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }, { tool: 'inpsect', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Step 2');
    expect(text(res)).toContain('inpsect');
    expect(text(res)).toContain('inspect');
    // rejected before storage, so there is nothing to clean up afterwards
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
    // and nothing was pushed into history
    expect(recorder.recordCommand).not.toHaveBeenCalled();
  });

  it('rejects before loading into history when intoHistory is set', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'bogus', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json', intoHistory: true } as any);

    expect(res.isError).toBe(true);
    expect(recorder.recordCommand).not.toHaveBeenCalled();
  });

  it('loads a valid sequence normally', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }, { tool: 'forEach', params: {} }]),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when no tool-name provider is supplied (previous behaviour)', async () => {
    const { replay, recorder } = makeReplay(seq([{ tool: 'inpsect', params: {} }]));

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when the provider returns an empty list', async () => {
    const { replay } = makeReplay(seq([{ tool: 'inpsect', params: {} }]), () => []);

    const res = await replay.handler({ action: 'load', filename: 'x.json' } as any);

    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('replay create - tool name validation', () => {
  it('rejects a created sequence containing an unknown tool name', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'ntavigate', params: {} }], 'from-history'),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Step 1');
    expect(text(res)).toContain('ntavigate');
    // Rejected before storage, so there is nothing to clean up afterwards
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('creates a valid sequence normally', async () => {
    const { replay, recorder } = makeReplay(
      seq([{ tool: 'navigate', params: {} }], 'from-history'),
      () => KNOWN_TOOLS
    );

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBeUndefined();
    expect(recorder.deleteSequence).not.toHaveBeenCalled();
  });

  it('does not validate when no tool-name provider is supplied', async () => {
    const { replay } = makeReplay(seq([{ tool: 'ntavigate', params: {} }], 'from-history'));

    const res = await replay.handler({ action: 'create', name: 'from-history', indices: [0] } as any);

    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create ordering: validation must run before the same-name replace
// ---------------------------------------------------------------------------

describe('replay create - a rejected create must not destroy the existing sequence', () => {
  async function realRecorderReplay() {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('navigate', { action: 'goto', url: 'http://example.test/' });
    await recorder.recordCommand('ntavigate', { action: 'goto', url: 'http://example.test/bad' });
    const { replay } = createReplayTools(recorder, vi.fn(), undefined, undefined, () => KNOWN_TOOLS);
    return { recorder, replay };
  }

  it('keeps the good in-memory sequence when a same-named create is rejected', async () => {
    const { recorder, replay } = await realRecorderReplay();

    const good = await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    expect(good.isError).toBeUndefined();
    const goodId = recorder.listSequences()[0].id;

    const bad = await replay.handler({ action: 'create', name: 'login', indices: [1] } as any);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('ntavigate');

    // the original survives, unchanged, under the same id - and nothing else was stored
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(goodId);
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate']);
  });

  it('still resolves the pre-existing sequence by name after a rejected create', async () => {
    const { replay } = await realRecorderReplay();

    await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    await replay.handler({ action: 'create', name: 'login', indices: [1] } as any);

    const got = await replay.handler({ action: 'get', name: 'login' } as any);
    expect(got.isError).toBeUndefined();
    expect(text(got)).toContain('navigate');
    expect(text(got)).not.toContain('ntavigate');
  });

  it('replaces the existing sequence when the new one is valid (dedupe still works, #75)', async () => {
    const { recorder, replay } = await realRecorderReplay();
    await recorder.recordCommand('inspect', { action: 'evaluateExpression', expression: '1+1' });

    await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    const res = await replay.handler({ action: 'create', name: 'login', indices: [0, 2] } as any);

    expect(res.isError).toBeUndefined();
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate', 'inspect']);
  });
});

// ---------------------------------------------------------------------------
// load ordering: validation must run before the same-name replace
// (same defect class as the create path above, on the disk-load path)
// ---------------------------------------------------------------------------

describe('replay load - a rejected load must not destroy the existing sequence', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'replay-load-order-'));
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Write a sequence file and return its absolute path (load takes absolute paths as-is). */
  async function writeSequenceFile(file: string, sequence: CommandSequence): Promise<string> {
    const filepath = join(dir, file);
    await fsp.writeFile(filepath, JSON.stringify(sequence), 'utf-8');
    return filepath;
  }

  /** Real recorder holding one good in-memory sequence named "login". */
  async function withGoodSequence() {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('navigate', { action: 'goto', url: 'http://example.test/' });
    const { replay } = createReplayTools(recorder, vi.fn(), undefined, undefined, () => KNOWN_TOOLS);

    const created = await replay.handler({ action: 'create', name: 'login', indices: [0] } as any);
    expect(created.isError).toBeUndefined();
    const goodId = recorder.listSequences()[0].id;
    return { recorder, replay, goodId };
  }

  it('keeps the good in-memory sequence when a same-named load is rejected', async () => {
    const { recorder, replay, goodId } = await withGoodSequence();
    const filepath = await writeSequenceFile('bad.json', {
      id: 'seq-from-disk-bad',
      name: 'login',
      commands: [{ tool: 'ntavigate', params: {} }],
      createdAt: 2,
    });

    const res = await replay.handler({ action: 'load', filename: filepath } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('ntavigate');

    // the original survives, unchanged, under the same id - and nothing else was stored
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(goodId);
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate']);
    expect(recorder.getSequence('seq-from-disk-bad')).toBeUndefined();
  });

  it('still resolves the pre-existing sequence by name after a rejected load', async () => {
    const { replay } = await withGoodSequence();
    const filepath = await writeSequenceFile('bad-get.json', {
      id: 'seq-from-disk-bad-2',
      name: 'login',
      commands: [{ tool: 'ntavigate', params: {} }],
      createdAt: 2,
    });

    await replay.handler({ action: 'load', filename: filepath } as any);

    const got = await replay.handler({ action: 'get', name: 'login' } as any);
    expect(got.isError).toBeUndefined();
    expect(text(got)).toContain('navigate');
    expect(text(got)).not.toContain('ntavigate');
  });

  it('records nothing into history when a load with intoHistory is rejected', async () => {
    const { recorder, replay, goodId } = await withGoodSequence();
    const before = recorder.getStats().historyCount;
    const filepath = await writeSequenceFile('bad-history.json', {
      id: 'seq-from-disk-bad-3',
      name: 'login',
      commands: [{ tool: 'ntavigate', params: {} }],
      createdAt: 2,
    });

    const res = await replay.handler({ action: 'load', filename: filepath, intoHistory: true } as any);

    expect(res.isError).toBe(true);
    expect(recorder.getStats().historyCount).toBe(before);
    expect(recorder.listSequences()).toHaveLength(1);
    expect(recorder.listSequences()[0].id).toBe(goodId);
  });

  it('replaces the existing same-named sequence when the loaded one is valid', async () => {
    const { recorder, replay } = await withGoodSequence();
    const filepath = await writeSequenceFile('good.json', {
      id: 'seq-from-disk-good',
      name: 'login',
      commands: [{ tool: 'navigate', params: {} }, { tool: 'inspect', params: {} }],
      createdAt: 2,
    });

    const res = await replay.handler({ action: 'load', filename: filepath } as any);

    expect(res.isError).toBeUndefined();
    const remaining = recorder.listSequences();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('seq-from-disk-good');
    expect(remaining[0].commands.map(c => c.tool)).toEqual(['navigate', 'inspect']);
  });
});
