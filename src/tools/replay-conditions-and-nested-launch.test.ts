/**
 * Two gaps that made guarded setup sequences unusable for identity healing:
 *
 * 1. Conditions could only see selector/url/cookie/localStorage, so a device
 *    identity kept in IndexedDB (the usual home for a non-extractable CryptoKey)
 *    could only be probed by proxy through some UI marker.
 * 2. Nested sequences dropped every launch step, so a setup sequence spanning
 *    two browsers could only run when both browsers happened to exist already.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeSteps, evaluateCondition } from './replay-executor.js';
import { formatExecutionResults } from './replay-formatters.js';
import type { ExecutionContext } from './replay-executor.js';
import type { CommandSequence, RecordedCommand } from '../command-recorder.js';
import { configManager } from '../config.js';
import { createErrorResponse, getErrorMessage, formatCodeBlock } from '../messages.js';
import { webStorageMeta } from './storage-tools.js';
import { ToolError } from '../tool-error.js';
import { HELD, runsOnPass } from '../test-support/check-steps.js';

function makeHarness(responses: Record<string, any> = {}, nested?: CommandSequence) {
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
    if (tool === 'check') return HELD;
    calls.push({ tool, params });
    const key = `${tool}.${params.action}`;
    const r = key in responses ? responses[key] : responses[tool];
    const response = r !== undefined
      ? (typeof r === 'function' ? r(params) : r)
      : { content: [{ type: 'text', text: '' }] };
    if (response?.isError) throw new ToolError(response);
    return response;
  });

  const commandRecorder = {
    recordCommand: vi.fn(),
    getCurrentHistoryIndex: () => 0,
    getSequence: (id: string) => (nested?.id === id ? nested : undefined),
    getFreshSequence: async (id: string) => (nested?.id === id ? nested : undefined),
    listSequences: () => (nested ? [nested] : []),
  } as any;

  const ctx: ExecutionContext = {
    executeToolCall,
    commandRecorder,
    connectionReason: 'device-a',
    logPrefix: 'test',
  };

  return { calls, ctx, executeToolCall };
}

const seq = (name: string, commands: RecordedCommand[]): CommandSequence => ({
  id: `seq-${name}`,
  name,
  commands,
  createdAt: 1,
});

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
/** The shapes the storage tool really returns: presence lives in `_meta`. */
const idbRecord = (t: string, found: boolean) => ({
  content: [{ type: 'text', text: t }],
  _meta: { tool: 'storage', action: 'idbGet', timestamp: 0, storage: { database: 'identity', store: 'keys', found } },
});
const idbRecords = (t: string, count: number) => ({
  content: [{ type: 'text', text: t }],
  _meta: { tool: 'storage', action: 'idbGetAll', timestamp: 0, storage: { database: 'identity', store: 'keys', count } },
});
/** connection list as the real tool answers it: the connections in `_meta`. */
const connectionsList = (connections: Array<{ reference: string; connected?: boolean }>) => ({
  ...text('Active debugger connections'),
  _meta: {
    tool: 'connection', action: 'list', timestamp: 0,
    connections: connections.map((c, i) => ({
      type: 'chrome', host: 'localhost', port: 9222 + i, active: i === 0, connected: true, paused: false, ...c,
    })),
  },
});
const errorText = (t: string) => ({ isError: true, content: [{ type: 'text', text: t }] });

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

describe('indexedDB conditions', () => {
  it('is met when the record exists and not met when it does not', async () => {
    const found = makeHarness({
      'storage.idbGet': idbRecord('## IndexedDB Record\n\n**Key:** "device"\n\n{"__type":"CryptoKey"}', true),
    });
    expect(await evaluateCondition('{{indexedDB:identity/keys/device}}', found.ctx))
      .toEqual({ met: true });
    expect(found.calls[0]).toMatchObject({
      tool: 'storage',
      params: { action: 'idbGet', db: 'identity', store: 'keys', key: 'device', connectionReason: 'device-a' },
    });

    const missing = makeHarness({
      'storage.idbGet': idbRecord('## IndexedDB Record\n\nNo record found for this key.', false),
    });
    expect((await evaluateCondition('{{indexedDB:identity/keys/device}}', missing.ctx)).met).toBe(false);
    expect(await evaluateCondition('{{!indexedDB:identity/keys/device}}', missing.ctx))
      .toEqual({ met: true });
  });

  // The whole point of a healing guard: on a wiped profile the database
  // isn't there yet. That has to read as "absent", not as a broken condition,
  // or the setup sequence fails exactly when it's needed.
  it('treats a missing database or store as absent rather than an error', async () => {
    for (const message of ['Database "identity" does not exist', 'Store "keys" not found in database "identity"']) {
      const { ctx } = makeHarness({ 'storage.idbGet': errorText(message) });
      const result = await evaluateCondition('{{indexedDB:identity/keys/device}}', ctx);
      expect(result).toEqual({ met: false });
      expect(await evaluateCondition('{{!indexedDB:identity/keys/device}}', ctx)).toEqual({ met: true });
    }
  });

  // The live executor's executeToolCall THROWS on a failed tool call rather
  // than returning isError, which is how the missing-database case escaped as a
  // raw exception the first time this was driven for real.
  it('treats a missing database as absent when the tool call throws', async () => {
    const { ctx } = makeHarness({
      'storage.idbGet': () => { throw new Error('IndexedDB operation failed (idbGet): Database "identity" does not exist'); },
    });
    expect(await evaluateCondition('{{indexedDB:identity/keys/device}}', ctx)).toEqual({ met: false });
    expect(await evaluateCondition('{{!indexedDB:identity/keys/device}}', ctx)).toEqual({ met: true });
  });

  it('still fails the run when a thrown IndexedDB error is not an absence', async () => {
    const { ctx } = makeHarness({
      'storage.idbGet': () => { throw new Error('Target closed'); },
    });
    const result = await evaluateCondition('{{indexedDB:identity/keys/device}}', ctx) as any;
    expect(result.isError).toBe(true);
    expect(result.reason).toContain('Target closed');
  });

  it('still fails the run when IndexedDB itself cannot be read', async () => {
    const { ctx } = makeHarness({ 'storage.idbGet': errorText('indexedDB.databases() is not supported') });
    const result = await evaluateCondition('{{indexedDB:identity/keys/device}}', ctx) as any;
    expect(result.met).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('asks whether a store holds anything when no key is given', async () => {
    const { ctx, calls } = makeHarness({
      'storage.idbGetAll': idbRecords('## IndexedDB Records\n\n**Count:** 0\n\n[]', 0),
    });
    expect((await evaluateCondition('{{indexedDB:identity/keys}}', ctx)).met).toBe(false);
    expect(calls[0].params).toMatchObject({ action: 'idbGetAll', db: 'identity', store: 'keys', limit: 1 });

    const populated = makeHarness({
      'storage.idbGetAll': idbRecords('## IndexedDB Records\n\n**Count:** 1\n\n[{}]', 1),
    });
    expect(await evaluateCondition('{{indexedDB:identity/keys}}', populated.ctx)).toEqual({ met: true });
  });

  // Driven live, these three were all false negatives: presence was decided by
  // grepping the tool's rendered markdown, so a record whose VALUE contained
  // the tool's own absence text read as missing.
  it('reads presence from _meta, not from a value that mimics the absence text', async () => {
    const trap = {
      content: [{ type: 'text', text: '## IndexedDB Record\n\n**Key:** "trap"\n\n"No record found for this key."' }],
      _meta: { tool: 'storage', action: 'idbGet', storage: { database: 'traps', store: 'kv', found: true } },
    };
    const { ctx } = makeHarness({ 'storage.idbGet': trap });
    expect(await evaluateCondition('{{indexedDB:traps/kv/trap}}', ctx)).toEqual({ met: true });
  });

  it('reads the store form from _meta, not from a record that mimics the count line', async () => {
    const trap = {
      content: [{ type: 'text', text: '## IndexedDB Records\n\n**Count:** 2\n\n["**Count:** 0"]' }],
      _meta: { tool: 'storage', action: 'idbGetAll', storage: { database: 'traps', store: 'kv', count: 2 } },
    };
    const { ctx } = makeHarness({ 'storage.idbGetAll': trap });
    expect(await evaluateCondition('{{indexedDB:traps/kv}}', ctx)).toEqual({ met: true });

    const empty = {
      content: [{ type: 'text', text: '## IndexedDB Records\n\n**Count:** 0\n\n[]' }],
      _meta: { tool: 'storage', action: 'idbGetAll', storage: { database: 'traps', store: 'kv', count: 0 } },
    };
    const { ctx: emptyCtx } = makeHarness({ 'storage.idbGetAll': empty });
    expect((await evaluateCondition('{{indexedDB:traps/kv}}', emptyCtx)).met).toBe(false);
  });

  it('retries a numeric key as a number, since IndexedDB keys 42 and "42" differ', async () => {
    const { ctx, calls } = makeHarness({
      'storage.idbGet': (params: Record<string, any>) => ({
        content: [{ type: 'text', text: '## IndexedDB Record' }],
        _meta: { tool: 'storage', action: 'idbGet', storage: { database: 'traps', store: 'nums', found: params.key === 42 } },
      }),
    });

    expect(await evaluateCondition('{{indexedDB:traps/nums/42}}', ctx)).toEqual({ met: true });
    expect(calls.map(c => c.params.key)).toEqual(['42', 42]);
  });

  it('does not retry a non-numeric key', async () => {
    const { ctx, calls } = makeHarness({
      'storage.idbGet': {
        content: [{ type: 'text', text: '## IndexedDB Record' }],
        _meta: { tool: 'storage', action: 'idbGet', storage: { database: 'traps', store: 'kv', found: false } },
      },
    });
    expect((await evaluateCondition('{{indexedDB:traps/kv/device}}', ctx)).met).toBe(false);
    expect(calls).toHaveLength(1);
  });

  // An interpolated key that resolves to nothing would otherwise silently ask
  // "does this store hold anything", which is a different question.
  it('rejects an empty key rather than degrading to the store form', async () => {
    const { ctx, calls } = makeHarness();
    const result = await evaluateCondition('{{indexedDB:identity/keys/}}', ctx) as any;

    expect(result.isError).toBe(true);
    expect(result.reason).toContain('the key is empty');
    expect(calls).toEqual([]);
  });

  it('rejects a value that names no store', async () => {
    const { ctx } = makeHarness();
    const result = await evaluateCondition('{{indexedDB:identity}}', ctx) as any;
    expect(result.isError).toBe(true);
    expect(result.reason).toContain('DB/STORE');
  });
});

// Same absence bug one tool over: a missing element reached the outer catch and
// failed the step, so `{{!selector:...}}` could never take its skip path. The
// fixtures come from createErrorResponse, not hand-written text - the first
// version of this test asserted a string production never emits (the real one
// carries an "Error: " summary line).
describe('selector conditions', () => {
  const elementNotFound = (selector: string) => createErrorResponse('ELEMENT_NOT_FOUND', { selector });
  // Mirrors index.ts's executeToolCall, which rethrows any isError response.
  const rethrown = (response: any) => () => { throw new ToolError(response); };

  it('treats a missing element as not met', async () => {
    const { ctx } = makeHarness({ 'dom.querySelector': elementNotFound('#enrol-marker') });
    expect(await evaluateCondition('{{selector:#enrol-marker}}', ctx)).toEqual({ met: false });
    expect(await evaluateCondition('{{!selector:#enrol-marker}}', ctx)).toEqual({ met: true });
  });

  // The id is the seam; the message is the fallback for anything throwing
  // without a captured response.
  it('falls back to the message when no error id survives the throw', async () => {
    const { ctx } = makeHarness({
      'dom.querySelector': () => { throw new Error(getErrorMessage('ELEMENT_NOT_FOUND', { selector: '#enrol-marker' })); },
    });
    expect(await evaluateCondition('{{selector:#enrol-marker}}', ctx)).toEqual({ met: false });
    expect(await evaluateCondition('{{!selector:#enrol-marker}}', ctx)).toEqual({ met: true });
  });

  it('keeps both seams pinned to the real ELEMENT_NOT_FOUND response', () => {
    expect((elementNotFound('#x') as any)._errorId).toBe('ELEMENT_NOT_FOUND');
    expect(/Element not found:/.test(getErrorMessage('ELEMENT_NOT_FOUND', { selector: '#x' }))).toBe(true);
  });

  it('is met when the element is present', async () => {
    const { ctx, calls } = makeHarness({ 'dom.querySelector': text('Element found: `#enrol-marker`\n\n{}') });
    expect(await evaluateCondition('{{selector:#enrol-marker}}', ctx)).toEqual({ met: true });
    expect(await evaluateCondition('{{!selector:#enrol-marker}}', ctx)).toEqual({ met: false });
    expect(calls[0]).toMatchObject({
      tool: 'dom',
      params: { action: 'querySelector', selector: '#enrol-marker', connectionReason: 'device-a' },
    });
  });

  // Negation must not flip a broken condition into a met one, in any shape.
  it('still fails the run when the failure is not a missing element', async () => {
    for (const { ctx } of [
      makeHarness({ 'dom.querySelector': errorText('Not connected to debugger') }),
      makeHarness({ 'dom.querySelector': () => { throw new Error('Not connected to debugger'); } }),
    ]) {
      for (const condition of ['{{selector:#enrol-marker}}', '{{!selector:#enrol-marker}}']) {
        const result = await evaluateCondition(condition, ctx) as any;
        expect(result.isError).toBe(true);
        expect(result.reason).toContain('Not connected to debugger');
      }
    }
  });
});

// The selector fix exposed the same shape in three more conditions: each read a
// rendered response, so page-controlled DATA could answer a question about
// STRUCTURE. All three now read `_meta`, as indexedDB already did.
describe('conditions read structure, not rendered text', () => {
  const cookies = (list: Array<{ name: string; value: string }>) => ({
    content: [{ type: 'text', text: `## Browser Cookies\n\n**Count:** ${list.length}\n\n${formatCodeBlock(list)}` }],
    _meta: { tool: 'storage', action: 'getCookies', timestamp: 0, storage: { cookieNames: list.map(c => c.name), count: list.length } },
  });
  // `_meta` from the storage tool's own helper, so a change to what it reports
  // fails here rather than leaving the fixture describing a shape production
  // stopped emitting.
  const localStorageResponse = (items: Record<string, string | null>, key: string) => ({
    content: [{ type: 'text', text: `## localStorage\n\n${formatCodeBlock(items)}` }],
    _meta: { tool: 'storage', action: 'getLocalStorage', timestamp: 0, storage: webStorageMeta(items, key) },
  });
  const pageInfo = (url: string) => ({
    content: [{ type: 'text', text: `Page info\nURL: ${url}\nTitle: t` }],
    _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url, title: 't', action: 'info' } },
  });

  it('does not let one cookie\'s value forge another cookie\'s presence', async () => {
    const { ctx } = makeHarness({
      'storage.getCookies': cookies([{ name: 'decoy', value: '{"name": "session"}' }]),
    });
    expect((await evaluateCondition('{{cookie:session}}', ctx)).met).toBe(false);
    expect(await evaluateCondition('{{!cookie:session}}', ctx)).toEqual({ met: true });
  });

  it('matches a cookie name exactly, not as a suffix', async () => {
    const { ctx } = makeHarness({ 'storage.getCookies': cookies([{ name: 'app_session', value: 'x' }]) });
    expect((await evaluateCondition('{{cookie:session}}', ctx)).met).toBe(false);
    expect(await evaluateCondition('{{cookie:app_session}}', ctx)).toEqual({ met: true });
  });

  it('reads a localStorage value of "null" as present, not missing', async () => {
    const stored = makeHarness({ 'storage.getLocalStorage': localStorageResponse({ token: 'null' }, 'token') });
    expect(await evaluateCondition('{{localStorage:token}}', stored.ctx)).toEqual({ met: true });

    const absent = makeHarness({ 'storage.getLocalStorage': localStorageResponse({ token: null }, 'token') });
    expect((await evaluateCondition('{{localStorage:token}}', absent.ctx)).met).toBe(false);
    expect(await evaluateCondition('{{!localStorage:token}}', absent.ctx)).toEqual({ met: true });
  });

  it('counts a stored empty string as present', async () => {
    const { ctx } = makeHarness({ 'storage.getLocalStorage': localStorageResponse({ flag: '' }, 'flag') });
    expect(await evaluateCondition('{{localStorage:flag}}', ctx)).toEqual({ met: true });
  });

  it('does not let a value containing "not found" hide the key', async () => {
    const { ctx } = makeHarness({
      'storage.getLocalStorage': localStorageResponse({ lastError: 'record not found' }, 'lastError'),
    });
    expect(await evaluateCondition('{{localStorage:lastError}}', ctx)).toEqual({ met: true });
  });

  it('compares a URL containing a comma in full', async () => {
    const url = 'https://example.com/report?ids=1,2,3';
    const { ctx } = makeHarness({ 'navigate.info': pageInfo(url) });
    expect(await evaluateCondition(`{{url:${url}}}`, ctx)).toEqual({ met: true });
    // The text fallback stopped at the comma, so the truncated prefix "matched".
    expect((await evaluateCondition('{{url:https://example.com/report?ids=1}}', ctx)).met).toBe(false);
  });
});

describe('a launch inside a nested sequence', () => {
  const nested = (ref: string) => seq('setup', [
    { tool: 'connection', params: { action: 'launch', name: ref } },
    { tool: 'navigate', params: { action: 'goto', url: 'https://example.com/', connectionReason: ref } },
  ]);

  const outer = seq('outer', [
    runsOnPass('setup'),
  ]);

  // connection list has to answer with the session as it IS at the moment of
  // the call - a launch mid-run adds a connection, and a static list would let
  // a step-connection check see a browser that was just created as missing.
  const baseResponses = (liveRefs: string[]) => {
    const live = new Set(liveRefs);
    return {
      'navigate.info': {
        content: [{ type: 'text', text: 'URL: https://example.com/' }],
        _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url: 'https://example.com/', title: 't', action: 'info' } },
      },
      'connection.launch': (params: Record<string, any>) => {
        live.add(params.name);
        return text('Chrome launched and connected');
      },
      'connection.list': () => connectionsList([...live].map(reference => ({ reference }))),
    };
  };

  it('launches a browser the session does not have', async () => {
    const { ctx, calls } = makeHarness(baseResponses(['device-a']), nested('member-two'));

    const result = await executeSteps({ sequence: outer, ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000 });

    expect(result.results[0].success).toBe(true);
    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toHaveLength(1);
    expect(calls.find(c => c.tool === 'connection' && c.params.action === 'launch')!.params.name).toBe('member-two');
  });

  it('does not relaunch a browser that is already connected', async () => {
    const { ctx, calls } = makeHarness(baseResponses(['device-a', 'member-two']), nested('member-two'));

    await executeSteps({ sequence: outer, ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000 });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toHaveLength(0);
  });

  // A setup sequence that is ONLY a launch empties out once the browser
  // exists. Reporting that as "condition not met" would state the opposite of
  // what happened - the condition held, there was simply nothing left to do.
  it('reports an emptied sub-sequence as held with nothing run, not as failed', async () => {
    const launchOnly = seq('launch-only', [
      { tool: 'connection', params: { action: 'launch', name: 'member-two' } },
    ]);
    const { ctx } = makeHarness(baseResponses(['device-a', 'member-two']), launchOnly);

    const result = await executeSteps({
      sequence: seq('outer', [runsOnPass('launch-only')]),
      ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000,
    });

    expect(result.results[0]).toMatchObject({ success: true, check: { outcome: 'held', action: 'run' } });
    expect(result.results[0].substeps).toEqual([]);
    expect(formatExecutionResults('outer', result.results, 1, 0)).toContain('ran launch-only (0 steps)');
  });

  // A registered-but-dropped connection is not somewhere a step can run, so it
  // must not suppress the launch that would replace it.
  it('does not treat a disconnected connection as live', async () => {
    const responses = {
      'navigate.info': {
        content: [{ type: 'text', text: 'URL: https://example.com/' }],
        _meta: { tool: 'navigate', action: 'info', timestamp: 0, navigate: { url: 'https://example.com/', title: 't', action: 'info' } },
      },
      'connection.launch': text('Chrome launched and connected'),
      'connection.list': connectionsList([
        { reference: 'device-a', connected: true },
        { reference: 'member-two', connected: false },
      ]),
    };
    const { ctx, calls } = makeHarness(responses, seq('setup', [
      { tool: 'connection', params: { action: 'launch', name: 'member-two' } },
    ]));

    await executeSteps({
      sequence: seq('outer', [runsOnPass('setup')]),
      ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000,
    });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toHaveLength(1);
  });

  // `create` hoists a uniform connection OFF the steps, so a real setup
  // sequence is a launch followed by BARE steps. Leaving those on the caller's
  // connection meant the run launched a browser, did all the work in the
  // CALLER's browser, and reported success - healing the wrong browser.
  it('runs a launched setup sequence in the browser it just launched', async () => {
    const hoisted = seq('setup', [
      { tool: 'connection', params: { action: 'launch', name: 'member-two' } },
      { tool: 'navigate', params: { action: 'goto', url: 'https://example.com/enrol' } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'mint()' } },
    ]);
    const { ctx, calls } = makeHarness(baseResponses(['device-a']), hoisted);

    await executeSteps({
      sequence: seq('outer', [runsOnPass('setup')]),
      ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000,
    });

    const enrolStep = calls.find(c => c.tool === 'navigate' && c.params.url === 'https://example.com/enrol');
    expect(enrolStep!.params.connectionReason).toBe('member-two');
    expect(calls.find(c => c.tool === 'inspect' && c.params.expression === 'mint()')!.params.connectionReason)
      .toBe('member-two');
  });

  // ...but only for a launch this run actually made. A nested login sequence
  // whose browser already exists must keep running in whatever browser called
  // it, the way it always has.
  it('leaves bare steps on the caller when the launch was dropped', async () => {
    const hoisted = seq('setup', [
      { tool: 'connection', params: { action: 'launch', name: 'member-two' } },
      { tool: 'inspect', params: { action: 'evaluateExpression', expression: 'login()' } },
    ]);
    const { ctx, calls } = makeHarness(baseResponses(['device-a', 'member-two']), hoisted);

    await executeSteps({
      sequence: seq('outer', [runsOnPass('setup')]),
      ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000,
    });

    expect(calls.filter(c => c.tool === 'connection' && c.params.action === 'launch')).toEqual([]);
    expect(calls.find(c => c.tool === 'inspect' && c.params.expression === 'login()')!.params.connectionReason)
      .toBe('device-a');
  });

  it('rebinds the launch through the run connection map', async () => {
    const { ctx, calls } = makeHarness(baseResponses(['device-a']), nested('member-two'));
    ctx.connectionMap = { 'member-two': 'my-second-browser' };

    await executeSteps({ sequence: outer, ctx, startStep: 0, stepTimeout: 2000, totalTimeout: 20_000 });

    expect(calls.find(c => c.tool === 'connection' && c.params.action === 'launch')!.params.name).toBe('my-second-browser');
  });
});
