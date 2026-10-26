/**
 * A run's reply: its steps from the run's first step, a resume included, and
 * each pause listed where it stood between them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { formatRunReply } from './run-table.js';
import { CommandRecorder } from '../command-recorder.js';
import { executeSteps } from './replay-executor.js';
import { historyPlace } from '../call-origin.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import type { Crossing } from '../bench/step-compare.js';
import type { RunRules } from './run-rules.js';
import { forgetObservations, observeWrite } from '../observation-log.js';
import { animationValue, motionOf, type PageWrite } from '../write-watch.js';
import type { PageAnimation } from '../page-animations.js';

/** History as the reply reads it, newest first: the run's four steps at entries 3, 4, 7 and 8. */
function recorder(): CommandRecorder {
  const steps = [
    { index: 3, run: 'sse', runStep: 0 },
    { index: 4, run: 'sse', runStep: 1 },
    { index: 7, run: 'sse', runStep: 2 },
    { index: 8, run: 'sse', runStep: 3 },
  ].map(step => ({ ...step, tool: 'input', params: {}, timestamp: step.index, result: { content: [] } }));
  return { getHistory: () => [...steps].reverse() } as unknown as CommandRecorder;
}

const answer = { key: '/sse', verb: 'answer' as const, label: '/sse price', from: 'this sequence', pin: 'pin-1' };
const rules: RunRules = { rules: [answer], ignores: [] };

function answered(id: string): Crossing {
  return { id, at: 1, kind: 'frame', url: 'http://app.test/sse', direction: 'in', runId: 'run-a', step: 2, paused: true,
    answeredBy: 'pin-1' } as Crossing;
}

describe('the reply after a resume', () => {
  it('counts every step of the run from its first step, not from the resume', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2 });
    expect(reply.split('\n')[0]).toBe('sse completed 4 of 4 · 4 passed');
  });

  it('counts only the steps after `since` where the reply starts at the resume', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 5 });
    expect(reply.split('\n')[0]).toBe('sse completed 4 of 4 · 2 passed');
  });
});

describe('a pause in the reply', () => {
  it('is listed between the step before it and the step it resumed at', () => {
    const pauses = new Map([[2, [answered('ev-1'), answered('ev-2')]]]);
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, steps: 'all', rules, pauses });
    const rows = reply.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| step') && !line.startsWith('| rule'));
    expect(rows.map(row => row.split('|')[1].trim())).toEqual(['1 input', '2 input', 'paused before 3', '3 input', '4 input', '/sse price']);
    expect(rows[2]).toContain('2 frames: 2 answered');
  });

  it('is counted in the rules block where a rule acted in it', () => {
    const pauses = new Map([[2, [answered('ev-1')]]]);
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, rules, pauses });
    expect(reply).toContain('| /sse price | answer | this sequence | paused before 3: 1 |');
  });

  it('lists no row after the last step', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2, steps: 'all', rules });
    expect(reply).not.toMatch(/\| after \|/);
    expect(reply).toContain('| /sse price | answer | this sequence | never fired |');
  });
});

describe('a step that fails before its call is recorded', () => {
  it('is the failed step, with its reason, and the step before it, of the same tool, passes', async () => {
    const history = new CommandRecorder();
    const executeToolCall = productionShaped(async (tool: string, params: Record<string, any>) => {
      const result = { content: [{ type: 'text', text: tool === 'input' ? `Clicked element \`${params.selector}\`` : '' }] };
      const place = historyPlace();
      if (place) await history.recordCommand(tool, params, { ...place, result });
      return result;
    });
    const sequence = { id: 'seq-env', name: 'env-token-search', createdAt: 1, commands: [
      { tool: 'input', params: { action: 'click', selector: 'search-shell' } },
      { tool: 'input', params: { action: 'type', text: '{{env:SOCKET_APP_TOKEN_UNSET}}' } },
    ] };

    const execution = await executeSteps({
      sequence, startStep: 0,
      ctx: { executeToolCall, commandRecorder: history, connection: 'app', variableStore: {}, runEnv: {} } as any,
    });
    const reply = formatRunReply(history, {
      name: 'env-token-search', total: 2, since: -1,
      failures: new Map(execution.results.filter(r => !r.success).map(r => [r.step, r.error!])),
    });

    expect(reply.split('\n')[0]).toBe('env-token-search failed at step 2 of 2 · 1 passed');
    expect(reply).toContain('Step 2: Could not resolve template token {{env:SOCKET_APP_TOKEN_UNSET}}');
    expect(reply).not.toContain('Clicked element');
  });
});

describe('the steps a reply leaves out', () => {
  it('names each step it does not list, so the table never reads as fewer steps than the run took', () => {
    const reply = formatRunReply(recorder(), { name: 'sse', total: 4, since: 2 });

    expect(reply).toContain('not listed (nothing caused): 1, 2, 3, 4 · input');
  });
});

/** A run of `motion` whose steps start at the given times, one history entry per step from entry 1, on `connection`. */
function timed(starts: number[], connection?: string, tools: string[] = []): CommandRecorder {
  const steps = starts.map((timestamp, i) => ({ index: i + 1, run: 'motion', runStep: i, tool: tools[i] ?? 'input', params: connection ? { connection } : {}, timestamp, result: { content: [] } }));
  return { getHistory: () => [...steps].reverse() } as unknown as CommandRecorder;
}

let writes = 0;
type Read = Pick<PageAnimation, 'type' | 'duration'> & Partial<Pick<PageAnimation, 'frames' | 'from' | 'to'>>;
/** A motion the write watch took, stamped to `entry`, with its value and motion built as the write watch builds them. */
function motionWrite(entry: number, key: string, at: number, read: Read): PageWrite {
  const animation: PageAnimation = { id: ++writes, doc: 'd1', name: key, delay: 0, easing: 'linear', looping: false, playState: 'running', currentTime: 0, ...read };
  return { id: `w${writes}`, at, store: 'animation', operation: 'started', key, value: animationValue(animation), motion: motionOf(animation), cursor: { kind: 'command', index: entry } };
}

const caused = (reply: string, step: string) => reply.split('\n').find(line => line.startsWith(`| ${step} `))?.split(' | ')[4]?.replace(/ \|$/, '');

describe('the caused column of a motion', () => {
  beforeEach(() => forgetObservations());

  it('counts one-frame sets in one tag after the motion, so the tweens lead', () => {
    const set = (key: string, at: number) => observeWrite(motionWrite(1, key, at, { type: 'StyleWrites', duration: 0, frames: 1, to: 'none' }));
    set('translate div.plan', 10); set('rotate div.plan', 11); set('scale div.plan', 12); set('left #plan-pick', 13);
    observeWrite(motionWrite(1, 'opacity div.plan', 20, { type: 'StyleWrites', duration: 400, frames: 24, from: '0', to: '1' }));
    observeWrite(motionWrite(1, 'transform div.plan', 21, { type: 'StyleWrites', duration: 400, frames: 24, to: 'none' }));

    const reply = formatRunReply(timed([0]), { name: 'motion', total: 1, since: 0 });

    expect(caused(reply, '1')).toBe('opacity div.plan  js style 0 → 1 over 400ms, 24 frames; transform div.plan  js style → none over 400ms, 24 frames · 4 set');
  });

  it('keeps a transform matrix motion\'s duration and frames and leaves its values out', () => {
    observeWrite(motionWrite(1, 'transform g', 10, { type: 'AttributeWrites', duration: 1967, frames: 119, from: 'matrix(1,0,0,1,30,40)', to: 'matrix(0.9999971985816956,0,0,1,30,40)' }));

    const reply = formatRunReply(timed([0]), { name: 'motion', total: 1, since: 0 });

    expect(caused(reply, '1')).toBe('transform g  js attribute over 1967ms, 119 frames');
  });

  it('keeps a line from another browser, labelled with its connection', () => {
    observeWrite(motionWrite(1, 'height #acc-body', 10, { type: 'StyleWrites', duration: 300, frames: 19, to: '58px' }), 'member-two');

    const reply = formatRunReply(timed([0], 'member-one'), { name: 'motion', total: 1, since: 0 });

    expect(caused(reply, '1')).toBe('height #acc-body  js style → 58px over 300ms, 19 frames on member-two');
  });
});

describe('a frame loop that stopped before a step', () => {
  beforeEach(() => forgetObservations());
  const loop = { type: 'Canvas' as const, duration: 580, frames: 36 };

  it('lists the step with the gap from the last frame, crediting no step', () => {
    observeWrite(motionWrite(1, 'pixels #gl', 100, loop));

    const reply = formatRunReply(timed([0, 500, 700]), { name: 'motion', total: 3, since: 0 });

    expect(caused(reply, '3')).toBe('pixels #gl  last frame 20ms before this step, not tied to it by time (m1)');
  });

  it('lists no stop where a motion of the same key started between the last frame and the step', () => {
    observeWrite(motionWrite(1, 'pixels #gl', 100, loop));
    observeWrite(motionWrite(2, 'pixels #gl', 690, { ...loop, duration: 300, frames: 18 }));

    const reply = formatRunReply(timed([0, 500, 700]), { name: 'motion', total: 3, since: 0 });

    expect(caused(reply, '3')).toBeUndefined();
    expect(reply).toContain('not listed (nothing caused): 3 · input');
  });

  it('lists no stop on a step that only reads the page', () => {
    observeWrite(motionWrite(1, 'pixels #gl', 100, loop));

    const reply = formatRunReply(timed([0, 500, 700], undefined, ['input', 'input', 'check']), { name: 'motion', total: 3, since: 0 });

    expect(caused(reply, '3')).toBeUndefined();
    expect(reply).toContain('not listed (nothing caused): 2, 3 · input, check');
  });

  it('lists no stop for a set whose time falls before the step', () => {
    observeWrite(motionWrite(1, 'left #plan-pick', 600, { type: 'StyleWrites', duration: 0, frames: 1, to: '-4px' }));

    const reply = formatRunReply(timed([0, 500, 700]), { name: 'motion', total: 3, since: 0 });

    expect(caused(reply, '3')).toBeUndefined();
    expect(reply).toContain('not listed (nothing caused): 2, 3 · input');
  });
});
