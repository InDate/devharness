/**
 * A recorded press replays held for its recorded length once it reaches the
 * sequence's threshold, and quick below it, so the few ms a quick click rests
 * do not turn every click into a hold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_HOLD_THRESHOLD_MS, resolvePressHold } from './press-hold.js';
import { executeSteps, type ExecutionContext } from './tools/replay-executor.js';
import type { CommandSequence, RecordedCommand } from './command-recorder.js';
import { productionShaped } from './test-support/fake-execute-tool-call.js';
import { configManager } from './config.js';

describe('the hold a recorded press replays with', () => {
  it('holds a press at or past the threshold for its recorded length', () => {
    expect(resolvePressHold({ action: 'click', pressMs: DEFAULT_HOLD_THRESHOLD_MS })).toEqual({ action: 'click', holdMs: DEFAULT_HOLD_THRESHOLD_MS });
  });

  it('sends a press below the threshold quick, with no pressMs left on it', () => {
    expect(resolvePressHold({ action: 'tap', pressMs: DEFAULT_HOLD_THRESHOLD_MS - 1 })).toEqual({ action: 'tap' });
  });

  it('keeps a holdMs written on the step over the recorded length', () => {
    expect(resolvePressHold({ action: 'click', pressMs: 2000, holdMs: 300 }, 100)).toEqual({ action: 'click', holdMs: 300 });
  });
});

describe('a run of recorded presses', () => {
  beforeEach(() => {
    vi.spyOn(configManager, 'getClickValidationConfig').mockReturnValue({
      enabled: false, validateNavigation: false, requireDomChanges: false,
      domChangesFailMode: 'warn', failOnConsoleErrors: false,
      consoleErrorsFailMode: 'error', validateNetworkPayload: false,
      networkFailMode: 'warn', postClickDelayMs: 0,
    } as any);
  });

  async function sentParams(sequence: Partial<CommandSequence>, commands: RecordedCommand[]) {
    const sent: Record<string, any>[] = [];
    const executeToolCall = vi.fn(productionShaped(async (name: string, params: Record<string, any>) => {
      if (name === 'input') sent.push(params);
      return { content: [{ type: 'text', text: '' }] };
    }));
    const ctx: ExecutionContext = {
      executeToolCall,
      commandRecorder: { recordCommand: vi.fn(), getCurrentHistoryIndex: () => 0 } as any,
      connection: 'tab',
      logPrefix: 'test',
    };
    await executeSteps({ sequence: { id: 'seq-press', name: 'press', createdAt: 1, ...sequence, commands }, ctx, startStep: 0 });
    return sent;
  }

  const pressed = (pressMs: number): RecordedCommand => ({ tool: 'input', params: { action: 'click', selector: '#hold', pressMs } });

  it('sends input holdMs for a press past the default threshold, and nothing for one below it', async () => {
    const sent = await sentParams({}, [pressed(800), pressed(90)]);

    expect(sent.map(params => params.holdMs)).toEqual([800, undefined]);
    expect(sent.every(params => !('pressMs' in params))).toBe(true);
  });

  it("measures the press against the sequence's own holdThresholdMs", async () => {
    const sent = await sentParams({ holdThresholdMs: 1000 }, [pressed(800), pressed(1200)]);

    expect(sent.map(params => params.holdMs)).toEqual([undefined, 1200]);
  });
});
