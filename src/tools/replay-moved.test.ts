/**
 * `replay` records and keeps sequences; the actions that run calls moved to
 * `run`. A call written for a moved action - from a session working from older
 * text - is refused with the `run` call that does the same, its fields carried
 * over, so it recovers in one step rather than on a bare enum error.
 */
import { describe, it, expect } from 'vitest';
import { replaySchema, runSchema, movedReplayRefusal } from './replay-schema.js';

const text = (res: any): string => res.content[0].text;

describe('the actions that moved from replay to run', () => {
  it('leaves replay without them and without the fields only they take', () => {
    for (const action of ['run', 'runAll', 'repeat', 'runFromLog', 'step', 'finish', 'status', 'cancel']) {
      expect(replaySchema.safeParse({ action }).success).toBe(false);
    }
    expect(replaySchema.safeParse({ action: 'create', name: 'n', indices: [1], wait: true }).success).toBe(false);
    expect(replaySchema.safeParse({ action: 'pause', sequenceId: 's', step: 1, hold: ['network'] }).success).toBe(true);
  });

  it('gives each moved action a run action that takes its fields', () => {
    expect(runSchema.safeParse({ action: 'sequence', name: 'login', wait: true, connection: 'shop-web-app' }).success).toBe(true);
    expect(runSchema.safeParse({ action: 'repeat', indices: [3], params: { url: 'x' } }).success).toBe(true);
  });

  it('refuses a moved call with the run call that does the same', () => {
    const refused = movedReplayRefusal({ action: 'run', name: 'login', wait: true });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('run({"action":"sequence","name":"login","wait":true})');
  });

  it('names runAll and runFromLog by their run actions', () => {
    expect(text(movedReplayRefusal({ action: 'runAll', folder: 'spine' }))).toContain('"action":"all"');
    expect(text(movedReplayRefusal({ action: 'runFromLog', lines: [1] }))).toContain('"action":"fromLog"');
  });

  it('leaves a recording or keeping call alone', () => {
    expect(movedReplayRefusal({ action: 'create', name: 'n', indices: [1] })).toBeUndefined();
    expect(movedReplayRefusal(undefined)).toBeUndefined();
  });
});
