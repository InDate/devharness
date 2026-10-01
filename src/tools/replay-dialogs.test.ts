/**
 * A step that opens a browser dialog: answered by the step after it, waited
 * on for a person in a run the bench started, and failed otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeSteps } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { dialogResponse, type DialogAnswer, type OpenDialog } from '../dialog-monitor.js';
import { createSuccessResponse } from '../messages.js';
import { arriveOn } from '../call-origin.js';
import type { CommandSequence } from '../command-recorder.js';

const picker: OpenDialog = { kind: 'fileChooser', mode: 'selectSingle', backendNodeId: 7, intercepted: false, since: 0 };
const confirm: OpenDialog = { kind: 'javascript', type: 'confirm', message: 'Forget it?', url: 'http://app.test/', since: 0 };

const click = (selector: string, extra: Record<string, unknown> = {}) =>
  ({ tool: 'input', params: { action: 'click', selector }, ...extra });
const seq = (commands: any[]): CommandSequence => ({ id: 'seq', name: 'seq', commands, createdAt: 1 });

/** A page where clicking `opener` opens `dialog`, and a wait on it closes with `answer`. */
function page(opener: string, dialog: OpenDialog, answer?: DialogAnswer): ExecutionContext & { calls: any[] } {
  const calls: any[] = [];
  const executeToolCall = productionShaped(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    if (tool === 'input' && params.selector === opener) return dialogResponse('DIALOG_OPENED', 'shop-web-app', dialog, 'input');
    if (tool === 'modal' && params.action === 'wait') {
      return { ...createSuccessResponse('DIALOG_CLOSED', {}), _meta: { tool: 'modal', timestamp: 0, dialog, dialogAnswer: answer } };
    }
    return { content: [{ type: 'text', text: '' }] };
  });
  return {
    executeToolCall,
    commandRecorder: { recordCommand: vi.fn(), getCurrentHistoryIndex: () => 0 } as any,
    connection: 'shop-web-app', logPrefix: 'test', calls,
  };
}

const waits = (ctx: { calls: any[] }) => ctx.calls.filter(c => c.tool === 'modal' && c.params.action === 'wait').length;

describe('a dialog the next step answers', () => {
  it('passes the step that opened it, carrying the dialog, and runs the answer', async () => {
    const ctx = page('#forget', confirm);
    const result = await executeSteps({
      sequence: seq([click('#forget'), { tool: 'modal', params: { action: 'answer', accept: true } }]),
      startStep: 0, ctx,
    });

    expect(result.results.map(r => r.success)).toEqual([true, true]);
    expect(result.results[0].dialog).toEqual(confirm);
    expect(waits(ctx)).toBe(0);
  });
});

describe('a dialog nothing in the sequence answers', () => {
  it('fails the step in a run an agent started, without waiting', async () => {
    const ctx = page('#forget', confirm);
    const result = await executeSteps({ sequence: seq([click('#forget'), click('#next')]), startStep: 0, ctx });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('A browser dialog opened during the call');
    expect(waits(ctx)).toBe(0);
  });

  it('waits on the person in a run the bench started, and carries their answer', async () => {
    const ctx = page('#forget', confirm, { kind: 'javascript', accepted: false });
    const result = await arriveOn('bench', () =>
      executeSteps({ sequence: seq([click('#forget'), click('#next')]), startStep: 0, ctx }));

    expect(result.results.map(r => r.success)).toEqual([true, true]);
    expect(result.results[0].dialogAnswer).toEqual({ kind: 'javascript', accepted: false });
    expect(waits(ctx)).toBe(1);
  });
});

describe('a file picker the person answers', () => {
  const run = (answer: DialogAnswer, extra: Record<string, unknown> = {}) => {
    const ctx = page('#upload', picker, answer);
    return arriveOn('bench', () =>
      executeSteps({ sequence: seq([click('#upload', extra), click('#next')]), startStep: 0, ctx }));
  };

  it('passes a pick', async () => {
    const result = await run({ kind: 'fileChooser', picked: true });
    expect(result.results.map(r => r.success)).toEqual([true, true]);
  });

  it('fails a cancel at the step that opened it', async () => {
    const result = await run({ kind: 'fileChooser', picked: false });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ success: false, error: 'File picker cancelled' });
  });

  it('passes a cancel on a step that carries onCancel: continue', async () => {
    const result = await run({ kind: 'fileChooser', picked: false }, { onCancel: 'continue' });
    expect(result.results.map(r => r.success)).toEqual([true, true]);
  });
});
