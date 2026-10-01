/**
 * What a browser dialog does to a tool call on its way to the page: a dialog
 * already open refuses it, one opening during it ends it, and the calls that
 * read only devharness's own state pass either way.
 */
import { describe, it, expect, vi } from 'vitest';
import { underDialogs, type DialogTarget } from './dialog-gate.js';
import type { OpenDialog } from './dialog-monitor.js';

const confirm: OpenDialog = { kind: 'javascript', type: 'confirm', message: 'Forget it?', url: 'http://app.test/', since: 0 };

function target(open: OpenDialog | null = null) {
  const listeners = new Set<(dialog: OpenDialog) => void>();
  const intercepted: string[] = [];
  const monitor: DialogTarget['monitor'] = {
    current: () => open,
    onOpen: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    intercepting: async work => { intercepted.push('on'); try { return await work(); } finally { intercepted.push('off'); } },
    takeRefusedPickers: () => 0,
  };
  const opens = (dialog: OpenDialog) => { open = dialog; for (const listener of listeners) listener(dialog); };
  return { target: { reference: 'shop-web-app', monitor }, opens, intercepted };
}

const ok = { content: [{ type: 'text', text: 'Clicked' }] };

describe('a dialog already open', () => {
  it('refuses a call that reads or drives the page, with the dialog in _meta', async () => {
    const run = vi.fn(async () => ok);
    const result = await underDialogs(target(confirm).target, 'content', { action: 'extractText' }, undefined, run);

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, _errorId: 'DIALOG_OPEN', _meta: { dialog: confirm } });
  });

  it('lets through modal, replay and the bench reading its own state', async () => {
    for (const [tool, args] of [['modal', { action: 'answer' }], ['replay', { action: 'step' }], ['bench', { action: 'status' }]] as const) {
      const run = vi.fn(async () => ok);
      expect(await underDialogs(target(confirm).target, tool, args, undefined, run)).toBe(ok);
    }
  });

  it('refuses the bench driving the page', async () => {
    const result = await underDialogs(target(confirm).target, 'bench', { action: 'hold' }, undefined, async () => ok);
    expect(result).toMatchObject({ _errorId: 'DIALOG_OPEN' });
  });
});

describe('a dialog opening during the call', () => {
  it('ends the call with DIALOG_OPENED and aborts the handler, whose command is still pending', async () => {
    const page = target();
    let handlerSignal: AbortSignal | undefined;
    const run = vi.fn((signal?: AbortSignal) => {
      handlerSignal = signal;
      queueMicrotask(() => page.opens(confirm));
      return new Promise<any>(() => {});
    });

    const result = await underDialogs(page.target, 'input', { action: 'click' }, undefined, run);

    expect(result).toMatchObject({ isError: true, _errorId: 'DIALOG_OPENED', _meta: { dialog: confirm } });
    expect(handlerSignal?.aborted).toBe(true);
  });

  it('returns the handler result when nothing opens', async () => {
    expect(await underDialogs(target().target, 'input', { action: 'click' }, undefined, async () => ok)).toBe(ok);
  });
});

describe('interception', () => {
  it('is on for an input call, the only kind that opens a picker', async () => {
    const input = target();
    await underDialogs(input.target, 'input', { action: 'click' }, undefined, async () => ok);
    const read = target();
    await underDialogs(read.target, 'storage', { action: 'getLocalStorage' }, undefined, async () => ok);

    expect(input.intercepted).toEqual(['on', 'off']);
    expect(read.intercepted).toEqual([]);
  });
});

it('runs a call that names no page as it is', async () => {
  const run = vi.fn(async () => ok);
  expect(await underDialogs(undefined, 'server', { action: 'list' }, undefined, run)).toBe(ok);
  expect(run).toHaveBeenCalledOnce();
});
