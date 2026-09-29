/**
 * The check tool called directly, and the check step in a run.
 *
 * Called directly a check answers held or failed without erroring, so an
 * agent reads the answer; only a check that cannot be read errors. As a step
 * each answer sets what the run does next - continue, stop, or run another
 * sequence and resume - and a check that cannot be read stops the run
 * whatever its fail action says.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCheckTools } from './check-tools.js';
import { executeSteps, type ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { FAILED, HELD } from '../test-support/check-steps.js';
import { currentCursor } from '../proxy/registry.js';

function tool(pageAnswers: unknown[] = [true]) {
  let at = 0;
  const cdpManager = {
    isPaused: () => false,
    isConnected: () => true,
    getRuntimeType: () => 'browser',
    evaluateExpressionDetailed: vi.fn(async () => {
      const answer = pageAnswers[Math.min(at++, pageAnswers.length - 1)];
      return { rawCaptured: true, rawValue: answer, formatted: String(answer) };
    }),
  };
  const { check } = createCheckTools(vi.fn(async () => ({ cdpManager })) as any, vi.fn() as any);
  return (args: Record<string, unknown>) => check.handler(args as any) as Promise<any>;
}

describe('check called directly', () => {
  it('answers a failed check without erroring', async () => {
    const res = await tool([false])({ selector: '#a', condition: 'present', connectionReason: 'tab', message: 'the banner never showed' });
    expect(res.isError).toBeFalsy();
    expect(res._meta.check).toMatchObject({ outcome: 'failed', subject: '#a present' });
    expect(res.content[0].text).toContain('the banner never showed');
  });

  it('answers a held check with what it found', async () => {
    const res = await tool([true])({ selector: '#a', condition: 'present', connectionReason: 'tab' });
    expect(res.isError).toBeFalsy();
    expect(res._meta.check).toMatchObject({ outcome: 'held', found: 'present' });
  });

  it('errors on a check that cannot be read', async () => {
    const res = await tool()({ selector: '#a', condition: 'text', connectionReason: 'tab' });
    expect(res.isError).toBe(true);
    expect(res._meta.check.outcome).toBe('error');
  });

  it('refuses a check that names two things to read', async () => {
    const res = await tool()({ selector: '#a', url: '/app', connectionReason: 'tab' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('one thing');
  });
});

const seq = (name: string, commands: RecordedCommand[]): CommandSequence => ({ id: `seq-${name}`, name, commands, createdAt: 1 });
const click = (id: string): RecordedCommand => ({ tool: 'input', params: { action: 'click', selector: `#${id}` } });
const checkStep = (params: Record<string, unknown>): RecordedCommand => ({ tool: 'check', params: { afterMs: 0, ...params } });

/** A run whose check steps answer `answer`, and which records every click it makes and the step marked while each check read. */
function run(answer: unknown, nested: CommandSequence[] = []) {
  const clicks: string[] = [];
  const markedDuringCheck: Array<number | undefined> = [];
  const executeToolCall = vi.fn(productionShaped(async (name: string, params: Record<string, any>) => {
    if (name === 'check') {
      const cursor = currentCursor();
      markedDuringCheck.push(cursor?.kind === 'replay' ? cursor.step : undefined);
      return answer;
    }
    if (name === 'input') clicks.push(params.selector);
    return { content: [{ type: 'text', text: '' }] };
  }));
  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    getSequence: (id: string) => nested.find(one => one.id === id),
    getFreshSequence: async (id: string) => nested.find(one => one.id === id),
    listSequences: () => nested,
  } as any;
  const ctx: ExecutionContext = { executeToolCall, commandRecorder, connectionReason: 'tab', logPrefix: 'test' };
  return {
    clicks,
    markedDuringCheck,
    execute: (commands: RecordedCommand[]) => executeSteps({ sequence: seq('outer', commands), ctx, startStep: 0 }),
  };
}

const ERROR = { content: [{ type: 'text', text: '## Error\n\nunreadable' }], isError: true, _meta: { check: { outcome: 'error' } } };

beforeEach(() => {
  vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
    enabled: false, validateNavigation: false, requireDomChanges: false,
    domChangesFailMode: 'warn', failOnConsoleErrors: false,
    consoleErrorsFailMode: 'error', validateNetworkPayload: false,
    networkFailMode: 'warn', postClickDelayMs: 0,
  } as any);
  vi.spyOn(configManager, 'getReplayConfig').mockReturnValue({
    maxConditionalDepth: 10, maxRegexLength: 500, showCursor: false,
    playwrightExportPath: './x', puppeteerExportPath: './y', maxDelayMs: 0,
  } as any);
});

describe('check as a step', () => {
  it('continues on a pass and stops on a fail, by default', async () => {
    const passing = run(HELD);
    expect((await passing.execute([checkStep({}), click('next')])).results.map(r => r.success)).toEqual([true, true]);
    expect(passing.clicks).toEqual(['#next']);

    const failing = run(FAILED);
    const result = await failing.execute([checkStep({}), click('next')]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ success: false, check: { outcome: 'failed', action: 'stop' } });
    expect(failing.clicks).toEqual([]);
  });

  it('carries on past a fail set to continue', async () => {
    const { execute, clicks } = run(FAILED);
    const result = await execute([checkStep({ fails: 'continue' }), click('next')]);
    expect(result.results[0]).toMatchObject({ success: true, check: { outcome: 'failed', action: 'continue' } });
    expect(clicks).toEqual(['#next']);
  });

  it('stops on a pass set to stop', async () => {
    const { execute, clicks } = run(HELD);
    const result = await execute([checkStep({ holds: 'stop' }), click('next')]);
    expect(result.results[0]).toMatchObject({ success: false, check: { outcome: 'held', action: 'stop' } });
    expect(clicks).toEqual([]);
  });

  it('runs a sequence on a pass, then carries on at the next step', async () => {
    const { execute, clicks } = run(HELD, [seq('dismiss', [click('dismiss')])]);
    const result = await execute([checkStep({ holds: { run: 'dismiss' } }), click('next')]);
    expect(result.results[0]).toMatchObject({ success: true, sequenceName: 'dismiss', check: { action: 'run' } });
    expect(clicks).toEqual(['#dismiss', '#next']);
  });

  it('runs a sequence on a fail when the fail says so', async () => {
    const { execute, clicks } = run(FAILED, [seq('recover', [click('recover')])]);
    await execute([checkStep({ fails: { run: 'recover' } }), click('next')]);
    expect(clicks).toEqual(['#recover', '#next']);
  });

  it('resumes at resumeAt once the sequence has run, skipping the steps between', async () => {
    const { execute, clicks } = run(HELD, [seq('login', [click('login')])]);
    await execute([checkStep({ holds: { run: 'login', resumeAt: 3 } }), click('skipped-1'), click('skipped-2'), click('resumed')]);
    expect(clicks).toEqual(['#login', '#resumed']);
  });

  it('stops on a check that cannot be read, whatever its fail says', async () => {
    const { execute, clicks } = run(ERROR);
    const result = await execute([checkStep({ fails: 'continue' }), click('next')]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('refuses a resumeAt at or before the check', async () => {
    const { execute, clicks } = run(HELD, [seq('login', [click('login')])]);
    const result = await execute([click('first'), checkStep({ holds: { run: 'login', resumeAt: 0 } }), click('next')]);
    expect(result.results.at(-1)).toMatchObject({ success: false });
    expect(result.results.at(-1)!.error).toContain('resume');
    expect(clicks).toEqual(['#first', '#login']);
  });

  it('keeps the step before a traffic check marked while it reads, and marks a plain check itself', async () => {
    const traffic = run(HELD);
    await traffic.execute([click('first'), checkStep({ traffic: { urlIncludes: '/api' } }), click('next')]);
    expect(traffic.markedDuringCheck).toEqual([0]);

    const plain = run(HELD);
    await plain.execute([click('first'), checkStep({}), click('next')]);
    expect(plain.markedDuringCheck).toEqual([1]);
  });
});
