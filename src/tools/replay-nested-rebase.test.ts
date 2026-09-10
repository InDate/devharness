/**
 * `baseUrl` must reach a sequence's nested sequences, not just its own steps.
 *
 * handleRun rebases the sequence it loaded. A `conditional`'s `then` and a
 * `forEach`'s `do` are loaded later, from the recorder, in their recorded
 * form - so before this the parent ran against the target deployment while
 * the helper that logs in or navigates ran against the recorded one, and a
 * retargeted run drove two origins at once. runAll is where that bites: a
 * suite's shared setup lives in exactly those helper sequences.
 *
 * The origin travels on the ExecutionContext (`rebaseOrigin`) so every depth
 * inherits it, the same way connectionMap does.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const seq = (name: string, commands: RecordedCommand[]): CommandSequence => ({
  id: `seq-${name}`, name, commands, createdAt: 1,
});

/** The shape navigate.info really returns: the URL comes from `_meta`. */
const pageInfo = (url: string) => ({
  content: [{ type: 'text', text: `URL: ${url}` }],
  _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url, title: 't', action: 'info' } },
});

function makeHarness(nested: CommandSequence[], rebaseOrigin?: string) {
  const gotoUrls: string[] = [];
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'navigate' && params.action === 'goto') {
      gotoUrls.push(String(params.url));
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    if (tool === 'navigate' && params.action === 'info') return pageInfo('https://cue-test.pages.dev/');
    return { content: [{ type: 'text', text: '' }] };
  }));

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    getSequence: (id: string) => nested.find(s => s.id === id),
    getFreshSequence: async (id: string) => nested.find(s => s.id === id),
    listSequences: () => nested,
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connectionReason: 'device-a',
    logPrefix: 'test',
    variableStore: {},
    ...(rebaseOrigin ? { rebaseOrigin } : {}),
  };

  return { gotoUrls, ctx };
}

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

const recordedGoto = (url: string): RecordedCommand =>
  ({ tool: 'navigate', params: { action: 'goto', url } });

describe('rebaseOrigin reaches nested sequences', () => {
  it("retargets a conditional's then sequence", async () => {
    const inner = seq('login', [recordedGoto('http://localhost:5174/login?next=/home')]);
    const { gotoUrls, ctx } = makeHarness([inner], 'https://cue-test.pages.dev');

    const result = await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:cue-test}}', then: 'login' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(result.results[0].success).toBe(true);
    expect(gotoUrls).toEqual(['https://cue-test.pages.dev/login?next=/home']);
  });

  it("retargets a forEach's do sequence", async () => {
    const inner = seq('open-row', [recordedGoto('http://localhost:5174/row')]);
    const { gotoUrls, ctx } = makeHarness([inner], 'https://cue-test.pages.dev');

    const result = await executeSteps({
      sequence: seq('outer', [
        { tool: 'forEach', params: { in: ['a', 'b'], as: 'row', do: 'open-row' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(result.results[0].success).toBe(true);
    expect(gotoUrls).toEqual([
      'https://cue-test.pages.dev/row',
      'https://cue-test.pages.dev/row',
    ]);
  });

  it('reaches a sequence nested two deep', async () => {
    const deep = seq('deep', [recordedGoto('http://localhost:5174/deep')]);
    const mid = seq('mid', [{ tool: 'conditional', params: { if: '{{url:contains:cue-test}}', then: 'deep' } }]);
    const { gotoUrls, ctx } = makeHarness([mid, deep], 'https://cue-test.pages.dev');

    const result = await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:cue-test}}', then: 'mid' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(result.results[0].success).toBe(true);
    expect(gotoUrls).toEqual(['https://cue-test.pages.dev/deep']);
  });

  // A non-localhost recorded origin: checkPortBeforeNavigation refuses a
  // localhost goto whose port is closed, and the step would break before
  // navigate was ever called - which says nothing about rebasing.
  it('leaves nested URLs alone with no rebaseOrigin on the context', async () => {
    const inner = seq('login', [recordedGoto('https://staging.example.com/login')]);
    const { gotoUrls, ctx } = makeHarness([inner]);

    await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:cue-test}}', then: 'login' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(gotoUrls).toEqual(['https://staging.example.com/login']);
  });

  it('does not mutate the recorder-held nested sequence', async () => {
    const inner = seq('login', [recordedGoto('http://localhost:5174/login')]);
    const { ctx } = makeHarness([inner], 'https://cue-test.pages.dev');

    await executeSteps({
      sequence: seq('outer', [
        { tool: 'conditional', params: { if: '{{url:contains:cue-test}}', then: 'login' } },
      ]),
      ctx,
      startStep: 0,
    });

    expect(inner.commands[0].params.url).toBe('http://localhost:5174/login');
  });
});
