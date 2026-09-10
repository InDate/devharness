/**
 * Unit tests for bug-003's fix: issues({action:'resolve'}) waits on an
 * interactive overlay that only a human click can settle, so the wait must be
 * bounded - otherwise an agent calling it (or a person walking away) hangs
 * until Puppeteer's raw protocol timeout leaks through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setWorkingDirOverride } from '../helpers/paths.js';
import { __resetForTests, addIssue, getIssue } from '../issue-tracker.js';
import { createIssuesTools, DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS } from './issues-tools.js';
import { ToolError } from '../tool-error.js';
import { createErrorResponse } from '../messages.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

// showTestReadyOverlay/showVerificationOverlay both drive page.evaluate() and
// resolve only when a human clicks a button in the browser - mock them so
// tests control exactly when (or whether) that "click" happens.
const showTestReadyOverlay = vi.fn();
const showVerificationOverlay = vi.fn();
vi.mock('../interaction-recorder.js', () => ({
  showTestReadyOverlay: (...args: any[]) => showTestReadyOverlay(...args),
  showVerificationOverlay: (...args: any[]) => showVerificationOverlay(...args),
}));

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(join(tmpdir(), 'devharness-issues-tools-test-'));
  setWorkingDirOverride(tempDir);
  __resetForTests();
  showTestReadyOverlay.mockReset();
  showVerificationOverlay.mockReset();
});

afterEach(async () => {
  __resetForTests();
  vi.useRealTimers();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function buildTools(opts: {
  executeToolCall?: (toolName: string, params: Record<string, any>) => Promise<any>;
} = {}) {
  const executeToolCall = opts.executeToolCall ?? vi.fn(productionShaped(async (..._args: any[]) => ({ content: [{ type: 'text', text: '' }] })));
  const getPageForConnection = vi.fn().mockResolvedValue({ evaluate: vi.fn() });
  const tools = createIssuesTools(executeToolCall, undefined, getPageForConnection);
  return { tools, executeToolCall, getPageForConnection };
}

describe('issues resolve - human gate (bug-003)', () => {
  // There is no caller-identity check: resolve is human-gated purely by the
  // overlay, whose promise only settles on a real click in the browser. What
  // an agent gets is therefore not a refusal but a bounded wait (below).
  it('always routes through the overlay, and cannot reach a resolution without one settling', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('cancel');
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(showTestReadyOverlay).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('cancelled');

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.status).toBe(issue.status); // unchanged
    expect(reloaded!.resolvedAt).toBeUndefined();
  });
});

describe('issues resolve - bounded human-verification timeout (bug-003 follow-on)', () => {
  it('returns a typed ISSUES_RESOLVE_TIMEOUT error, and closes the tab, if nobody ever answers the "ready to begin?" overlay', async () => {
    vi.useFakeTimers();
    const issue = await addIssue({ type: 'bug', title: 'Something broke', sequenceFile: 'x.json' });

    // Simulates a human who never clicks anything - the overlay's promise never settles.
    showTestReadyOverlay.mockReturnValue(new Promise(() => {}));

    const executeToolCall = vi.fn(productionShaped(async (..._args: any[]) => ({ content: [{ type: 'text', text: '' }] })));
    const { tools } = buildTools({ executeToolCall });

    const resultPromise = tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);
    await vi.advanceTimersByTimeAsync(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS + 1000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timed out after');
    expect(result.content[0].text).toContain('waiting for a human to respond');
    expect(executeToolCall).toHaveBeenCalledWith('tab', expect.objectContaining({ action: 'close' }));

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.resolvedAt).toBeUndefined(); // no-op on issue state
  });

  it('never lets the overall wait exceed the bound even though Puppeteer\'s own protocolTimeout (180s) is longer', () => {
    // This is the crux of the bug-003 "bound the interactive path" requirement:
    // our own timeout (150s) must fire strictly before Puppeteer's default
    // protocolTimeout (180s) would, so callers get our typed error instead of
    // a raw "Runtime.callFunctionOn timed out".
    const PUPPETEER_DEFAULT_PROTOCOL_TIMEOUT_MS = 180_000;
    expect(DEFAULT_RESOLVE_VERIFICATION_TIMEOUT_MS).toBeLessThan(PUPPETEER_DEFAULT_PROTOCOL_TIMEOUT_MS);
  });
});

/**
 * Verification runs the issue's sequence in a browser this handler opened. Both
 * ways that can go wrong have to close that browser: a run that FAILS returns
 * normally and is read from its text, while a run that cannot START (missing
 * file, Chrome refused to launch) throws - and the throw used to escape the
 * handler, leaving the tab open on the path where nobody is watching it.
 */
describe('issues resolve - verification replay failures close the browser', () => {
  const tabClosed = (executeToolCall: any) =>
    executeToolCall.mock.calls.some(([tool, params]: any[]) => tool === 'tab' && params.action === 'close');

  it('reports and cleans up when the replay runs but steps fail', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Broken', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('begin');

    const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') {
        return {
          content: [{ type: 'text', text: 'Error: Failed at step 2\n\n**Failed:** 1\n' }],
          _meta: { tool: 'replay', action: 'run', timestamp: 0, replay: { success: false, totalSteps: 2, failedSteps: 1 } },
        };
      }
      return { content: [{ type: 'text', text: '' }] };
    });
    const { tools } = buildTools({ executeToolCall });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('replay failed');
    expect(tabClosed(executeToolCall)).toBe(true);
  });

  it('reports and cleans up when the replay itself throws', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Broken', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('begin');

    const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') {
        throw new ToolError(createErrorResponse('SEQUENCE_NOT_FOUND', { message: 'Chrome refused to launch' }));
      }
      return { content: [{ type: 'text', text: '' }] };
    });
    const { tools } = buildTools({ executeToolCall });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Chrome refused to launch');
    expect(tabClosed(executeToolCall)).toBe(true);
  });

  it('leaves the browser open when the caller asked it to', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Broken', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('begin');

    const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') throw new ToolError(createErrorResponse('SEQUENCE_NOT_FOUND', { message: 'Chrome refused to launch' }));
      return { content: [{ type: 'text', text: '' }] };
    });
    const { tools } = buildTools({ executeToolCall });

    await tools.issues.handler({ action: 'resolve', id: issue.id, keepBrowserOpen: true } as any, undefined);

    expect(tabClosed(executeToolCall)).toBe(false);
  });
});

/**
 * Verification outcomes come from the run's own `_meta`, not its rendered
 * summary. The text forms coupled this handler to exact wording in
 * replay-formatters - a reformat there would have turned every failed
 * verification into a pass, silently.
 */
describe('issues resolve - verification outcome comes from _meta', () => {
  const runResponse = (text: string, meta?: Record<string, any>) => ({
    content: [{ type: 'text', text }],
    ...(meta && { _meta: { tool: 'replay', action: 'run', timestamp: 0, replay: meta } }),
  });

  it('fails on _meta even when the summary text says nothing about failures', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Broken', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('begin');

    const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') {
        return runResponse('reformatted summary, no Failed line', { success: false, totalSteps: 3, failedSteps: 1 });
      }
      return { content: [{ type: 'text', text: '' }] };
    });
    const { tools } = buildTools({ executeToolCall });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('replay failed');
  });

  it('passes on _meta even when the summary text happens to contain the failure wording', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Broken', sequenceFile: 'x.json' });
    showTestReadyOverlay.mockResolvedValue('begin');
    showVerificationOverlay.mockResolvedValue('fixed');

    const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
      if (tool === 'replay' && params.action === 'run') {
        // A step whose own recorded text mentions "**Failed:** 2".
        return runResponse('Completed 3/3\n\nassert: expected "**Failed:** 2"', { success: true, totalSteps: 3, failedSteps: 0 });
      }
      return { content: [{ type: 'text', text: '' }] };
    });
    const { tools } = buildTools({ executeToolCall });

    const result = await tools.issues.handler({ action: 'resolve', id: issue.id } as any, undefined);
    expect(result.isError).toBeUndefined();
  });

});

/**
 * A body used to be reachable only through workOn, which writes in_progress and
 * opens a browser - so reading what an issue says cost a state change and a
 * Chrome launch that the read itself does not need.
 */
describe('issues list - reading a body', () => {
  it('returns the named issue in full, changing no state and opening no browser', async () => {
    const issue = await addIssue({
      type: 'bug',
      title: 'ServerFileWatcher can silently miss a change',
      body: 'fs.watch delivery is not guaranteed.',
      initialStatus: 'acknowledged',
    });
    const { tools, executeToolCall, getPageForConnection } = buildTools();

    const result = await tools.issues.handler({ action: 'list', id: issue.id } as any, undefined);

    expect(result.content[0].text).toContain('fs.watch delivery is not guaranteed.');
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(getPageForConnection).not.toHaveBeenCalled();

    const reloaded = await getIssue(issue.id);
    expect(reloaded!.status).toBe('acknowledged');
    expect(reloaded!.startedAt).toBeUndefined();
  });

  it('reaches an issue the default filter drops, so an id needs no includeCompleted', async () => {
    const issue = await addIssue({
      type: 'feature',
      title: 'GitHub issue sync via the gh CLI',
      body: 'Body of an issue already implemented.',
      initialStatus: 'implemented',
    });
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', id: issue.id } as any, undefined);

    expect(result.content[0].text).toContain('Body of an issue already implemented.');
  });

  it('returns ISSUES_NOT_FOUND for an id no issue carries', async () => {
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', id: 4242 } as any, undefined);

    expect(result.isError).toBe(true);
    expect((result as any)._errorId).toBe('ISSUES_NOT_FOUND');
    expect(result.content[0].text).toContain('4242');
  });

  it('renders the body when a search narrows the listing to one issue', async () => {
    await addIssue({ type: 'bug', title: 'relocateRoot has no reentrancy guard', body: 'A rebind that throws leaves no rollback.' });
    await addIssue({ type: 'bug', title: 'Unrelated watcher bug', body: 'Nothing to do with rebinding.' });
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', search: 'reentrancy' } as any, undefined);

    expect(result.content[0].text).toContain('A rebind that throws leaves no rollback.');
  });

  it('omits bodies above the cap and names the call that reads one', async () => {
    await addIssue({ type: 'bug', title: 'First routing bug', body: 'BODY MARKER ONE' });
    await addIssue({ type: 'bug', title: 'Second routing bug', body: 'BODY MARKER TWO' });
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', search: 'routing' } as any, undefined);

    const text = result.content[0].text;
    expect(text).not.toContain('BODY MARKER ONE');
    expect(text).not.toContain('BODY MARKER TWO');
    expect(text).toContain("action: 'list', id:");
  });
});

/**
 * A body is arbitrary Markdown written by users and agents, and it now reaches
 * the response through a template variable. Variable values enter in one final
 * replace pass and are never rescanned, so template syntax inside a body is
 * inert - these pin that, because a rewrite of the substitution loop would
 * otherwise silently mangle or hide what a body says.
 */
describe('issues list - a body is data, not template', () => {
  it('renders template syntax inside a body verbatim', async () => {
    const hostile = 'Counts {{count}} and {{^details}}HIDDEN{{/details}} and {{#each x}}L{{/each}} and a bare {{ brace.';
    const issue = await addIssue({ type: 'bug', title: 'Body carries braces', body: hostile });
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', id: issue.id } as any, undefined);

    expect(result.content[0].text).toContain(hostile);
  });

  it('omits the read-one pointer when nothing matched', async () => {
    await addIssue({ type: 'bug', title: 'Present but unmatched', body: 'x' });
    const { tools } = buildTools();

    const result = await tools.issues.handler({ action: 'list', search: 'nothing-matches-this' } as any, undefined);

    expect(result.content[0].text).not.toContain("action: 'list', id:");
  });

  it('returns the named issue when the other filters contradict it', async () => {
    const issue = await addIssue({ type: 'bug', title: 'Contradicted', body: 'BODY OF THE NAMED ISSUE', initialStatus: 'acknowledged' });
    const { tools } = buildTools();

    const result = await tools.issues.handler(
      { action: 'list', id: issue.id, type: 'feature', status: 'pending', search: 'no-such-text', labels: ['absent'] } as any,
      undefined
    );

    expect(result.content[0].text).toContain('BODY OF THE NAMED ISSUE');
  });
});
