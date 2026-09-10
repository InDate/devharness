/**
 * The `variables` key is BUILT from the selector, not quoted from it:
 * `var_<0-based step index>_<selector, non-alphanumerics replaced by _>`. A
 * step 2 typing into `#email` is `var_2__email` - two underscores, one from
 * the separator and one from the `#`.
 *
 * A key that matches nothing is dropped in silence and the step runs on its
 * recorded text, so a wrong key reads as an override while the recorded value
 * reaches the live app. `docs/replay.md` and the skill's sequences reference
 * both carried `var_2_#email` in their examples with nothing to catch it -
 * these pin the two producers against each other so a doc example can be
 * copied from a passing test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { extractTextVariables } from './replay-formatters.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const commands: RecordedCommand[] = [
  { tool: 'navigate', params: { action: 'goto', url: 'https://app.example.com/login' } },
  { tool: 'input', params: { action: 'click', selector: '#open' } },
  { tool: 'input', params: { action: 'type', selector: '#email', text: 'original@example.com' } },
  { tool: 'input', params: { action: 'type', selector: '#password', text: 'recorded-secret' } },
  { tool: 'input', params: { action: 'type', text: 'no selector here' } },
];

const seq = (): CommandSequence => ({ id: 'seq-login', name: 'login', commands, createdAt: 1 });

function makeHarness() {
  const typed: Array<{ selector?: string; text: string }> = [];
  // After a `type` step the executor reads the field back through
  // inspect.evaluateExpression and fails the step when it does not match, so
  // the stub has to hold the value the field would now carry.
  const fieldValues = new Map<string, string>();
  const executeToolCall = vi.fn(productionShaped(async (tool: string, params: Record<string, any>) => {
    if (tool === 'input' && params.action === 'type') {
      typed.push({ selector: params.selector, text: String(params.text) });
      if (params.selector) fieldValues.set(String(params.selector), String(params.text));
    }
    if (tool === 'inspect' && params.action === 'evaluateExpression') {
      const selector = String(params.expression).match(/querySelector\('([^']*)'\)/)?.[1] ?? '';
      const value = fieldValues.get(selector) ?? '';
      return { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }] };
    }
    return { content: [{ type: 'text', text: '' }] };
  }));

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder: { recordCommand: vi.fn(), getCurrentHistoryIndex: () => 0, listSequences: () => [] } as any,
    connectionReason: 'device-a',
    logPrefix: 'test',
    variableStore: {},
  };

  return { typed, ctx };
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

describe('typed-text variable keys', () => {
  it('replaces every non-alphanumeric in the selector, giving two underscores after the index', () => {
    expect(Object.keys(extractTextVariables(commands))).toEqual([
      'var_2__email',
      'var_3__password',
      'var_4_text',
    ]);
  });

  it('carries the recorded value alongside each key, so `get` shows what a run would type', () => {
    expect(extractTextVariables(commands)['var_3__password'].value).toBe('recorded-secret');
  });

  it('substitutes on the key the extractor displays', async () => {
    const { typed, ctx } = makeHarness();

    await executeSteps({
      sequence: seq(),
      ctx,
      startStep: 0,
      variables: { var_2__email: 'fresh@example.com', var_3__password: 'supplied-secret' },
    });

    expect(typed).toEqual([
      { selector: '#email', text: 'fresh@example.com' },
      { selector: '#password', text: 'supplied-secret' },
      { selector: undefined, text: 'no selector here' },
    ]);
  });

  // The failure the doc examples produced: no error, no warning, and the
  // recorded credential reaches the app.
  it('drops a key that matches nothing and types the recorded text', async () => {
    const { typed, ctx } = makeHarness();

    const result = await executeSteps({
      sequence: seq(),
      ctx,
      startStep: 0,
      variables: { 'var_3_#password': 'supplied-secret' },
    });

    expect(result.results.every(r => r.success)).toBe(true);
    expect(typed[1]).toEqual({ selector: '#password', text: 'recorded-secret' });
  });

  it('keys off the absolute command index, so startFrom does not shift them', async () => {
    const { typed, ctx } = makeHarness();

    await executeSteps({
      sequence: seq(),
      ctx,
      startStep: 3,
      variables: { var_3__password: 'supplied-secret' },
    });

    expect(typed).toEqual([
      { selector: '#password', text: 'supplied-secret' },
      { selector: undefined, text: 'no selector here' },
    ]);
  });
});
