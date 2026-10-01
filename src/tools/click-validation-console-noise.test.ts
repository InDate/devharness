/**
 * Click validation used to compare raw console error COUNTS before/after a
 * click, so an unrelated error landing in the post-click window (e.g. a
 * favicon 404) was indistinguishable from one the click actually caused.
 * capturePreClickState/validateClickAction now diff actual entry ids and
 * exclude known browser noise (favicon.ico) from what counts as "new".
 */
import { describe, it, expect } from 'vitest';
import { capturePreClickState, validateClickAction } from './replay-executor.js';
import type { ExecutionContext } from './replay-executor.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import type { ClickValidationConfig } from '../config.js';

const BASE_CONFIG: ClickValidationConfig = {
  enabled: true,
  validateNavigation: false,
  requireDomChanges: false,
  domChangesFailMode: 'warn',
  failOnConsoleErrors: true,
  consoleErrorsFailMode: 'error',
  validateNetworkPayload: false,
  networkFailMode: 'warn',
  postClickDelayMs: 0,
};

interface Entry { id: string; url?: string }

function consoleResponse(entries: Entry[]) {
  return {
    content: [{ type: 'text' as const, text: '' }],
    _meta: {
      console: {
        totalCount: entries.length,
        errorCount: entries.length,
        warnCount: 0,
        entries: entries.map(e => ({ id: e.id, type: 'error', ...(e.url && { url: e.url }) })),
      },
    },
  };
}

/** Fake ctx whose console responses switch from `before` to `after` the first
 *  time `console` is called a second time - mirrors pre-click vs post-click. */
function makeCtx(before: Entry[], after: Entry[]): ExecutionContext {
  let callCount = 0;
  const executeToolCall = productionShaped(async (tool: string, _params: Record<string, any>) => {
    if (tool === 'console') {
      callCount++;
      return consoleResponse(callCount === 1 ? before : after);
    }
    return { content: [{ type: 'text', text: '' }] };
  });
  return { executeToolCall, commandRecorder: {} as any, connection: 'test', logPrefix: 'test' };
}

describe('click validation - console error noise filtering', () => {
  it('suppresses a new error that is purely a favicon 404', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [{ id: 'c-1' }, { id: 'c-2', url: 'http://localhost:3000/favicon.ico' }]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.info.some(i => i.includes('unrelated browser noise'))).toBe(true);
  });

  it('still fails on a new error unrelated to any known noise pattern', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [{ id: 'c-1' }, { id: 'c-2', url: 'http://localhost:3000/api/broken' }]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('1 new console error');
  });

  it('still fails when a genuine error accompanies a noise one (mixed)', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [
        { id: 'c-1' },
        { id: 'c-2', url: 'http://localhost:3000/favicon.ico' },
        { id: 'c-3', url: 'http://localhost:3000/api/broken' },
      ]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('2 new console error');
  });

  it('respects consoleErrorsFailMode: warn for a genuine new error', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [{ id: 'c-1' }, { id: 'c-2', url: 'http://localhost:3000/api/broken' }]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, { ...BASE_CONFIG, consoleErrorsFailMode: 'warn' });

    expect(result.valid).toBe(true);
    expect(result.warnings[0]).toContain('1 new console error');
  });

  it('does not report anything when no new errors appear', async () => {
    const ctx = makeCtx([{ id: 'c-1' }], [{ id: 'c-1' }]);
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.info).toEqual([]);
  });

  it('a query string on the favicon URL is still recognized as noise', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [{ id: 'c-1' }, { id: 'c-2', url: 'http://localhost:3000/favicon.ico?v=2' }]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(true);
  });

  it('a similarly-named but different resource is NOT treated as noise', async () => {
    const ctx = makeCtx(
      [{ id: 'c-1' }],
      [{ id: 'c-1' }, { id: 'c-2', url: 'http://localhost:3000/api/favicon.ico/details' }]
    );
    const pre = await capturePreClickState(ctx);
    const result = await validateClickAction(ctx, pre, {}, BASE_CONFIG);

    expect(result.valid).toBe(false);
  });
});
