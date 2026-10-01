/**
 * Coverage for two dead-parameter bugs in the `replay` tool (issue #97):
 *
 * A) recordInteraction accepted simplifyEvents/includeHovers/preferCoordinates/
 *    preferSelectors but hardcoded them when calling eventsToCommands.
 * B) outputFormat advertised six values but only playwright/puppeteer did
 *    anything; the rest silently fell through to the default detail view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandSequence } from '../command-recorder.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';

const startRecordingMock = vi.fn();
const eventsToCommandsSpy = vi.fn();

vi.mock('../interaction-recorder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-recorder.js')>();
  return {
    ...actual,
    startRecording: (...args: any[]) => startRecordingMock(...args),
    eventsToCommands: (...args: any[]) => {
      eventsToCommandsSpy(...args);
      return (actual.eventsToCommands as any)(...args);
    },
  };
});

// Keep the issue tracker off the filesystem.
vi.mock('../issue-tracker.js', () => ({
  addIssue: vi.fn(),
  initializeTracker: vi.fn(async () => undefined),
  saveIssueSequence: vi.fn(async () => undefined),
  getIssue: vi.fn(async () => null),
  updateIssue: vi.fn(async () => undefined),
  getIssues: vi.fn(async () => []),
}));

const { createReplayTools } = await import('./replay-tools.js');
const { CommandRecorder } = await import('../command-recorder.js');

function makeTool(recorder: InstanceType<typeof CommandRecorder>) {
  // A real tool always returns at least one content item; `{ content: [] }`
  // made every `content[0].text` read undefined.
  const executeToolCall = vi.fn(productionShaped(async (..._args: any[]) => ({ content: [{ type: 'text', text: '' }] })));
  const getPageForConnection = vi.fn(async () => ({ /* fake CDP page */ }));
  return createReplayTools(recorder, executeToolCall as any, getPageForConnection as any).replay;
}

const recordingEvents = [
  { type: 'click', timestamp: 1000, x: 10, y: 20, elementInfo: { selector: '#go' } },
  { type: 'mousemove', timestamp: 1100, x: 30, y: 40 },
  { type: 'mousemove', timestamp: 1200, x: 50, y: 60 },
  { type: 'click', timestamp: 1300, x: 70, y: 80, elementInfo: { selector: '#done' } },
] as any[];

beforeEach(() => {
  startRecordingMock.mockReset();
  eventsToCommandsSpy.mockReset();
  startRecordingMock.mockResolvedValue({
    success: true,
    recording: {
      events: recordingEvents,
      startUrl: 'http://localhost:3000/',
      duration: 2000,
      summary: { clicks: 2, drags: 0, scrolls: 0, keyPresses: 0, navigations: 0, comments: 0 },
    },
  });
});

async function record(extraArgs: Record<string, any> = {}) {
  const recorder = new CommandRecorder();
  const tool = makeTool(recorder);
  const result = await tool.handler({
    action: 'recordInteraction',
    connection: `rec-${Math.random().toString(36).slice(2)}`,
    ...extraArgs,
  } as any);
  return { result, recorder, options: eventsToCommandsSpy.mock.calls[0]?.[1] };
}

describe('recordInteraction threads recording options into eventsToCommands (bug A)', () => {
  it('keeps the previous hardcoded values as defaults', async () => {
    const { options } = await record();
    expect(options).toMatchObject({
      simplify: true,
      includeDelays: true,
      includeHovers: false,
      preferCoordinates: false,
      preferSelectors: false,
    });
  });

  it('passes simplifyEvents through as `simplify`', async () => {
    const { options } = await record({ simplifyEvents: false });
    expect(options.simplify).toBe(false);
  });

  it('passes includeHovers through, and hover commands actually appear', async () => {
    const { options, recorder } = await record({ includeHovers: true });
    expect(options.includeHovers).toBe(true);
    const seq = recorder.listSequences()[0];
    expect(seq.commands.some(c => c.params.action === 'mousemove')).toBe(true);
  });

  it('passes preferCoordinates through, producing x/y clicks instead of selectors', async () => {
    const { options, recorder } = await record({ preferCoordinates: true });
    expect(options.preferCoordinates).toBe(true);
    const clicks = recorder.listSequences()[0].commands.filter(c => c.params.action === 'click');
    expect(clicks.length).toBeGreaterThan(0);
    expect(clicks.every(c => typeof c.params.x === 'number' && c.params.selector === undefined)).toBe(true);
  });

  it('preferSelectors wins when both preference flags are set', async () => {
    const { options, recorder } = await record({ preferCoordinates: true, preferSelectors: true });
    expect(options).toMatchObject({ preferCoordinates: true, preferSelectors: true });
    const clicks = recorder.listSequences()[0].commands.filter(c => c.params.action === 'click');
    expect(clicks.every(c => c.params.selector !== undefined)).toBe(true);
  });
});

describe('replay schema no longer accepts dead parameters', () => {
  const parse = async (args: Record<string, any>) => {
    const recorder = new CommandRecorder();
    const tool = makeTool(recorder);
    return tool.zodSchema.safeParse({ action: 'get', name: 'x', ...args });
  };

  it('rejects recordingId (nothing ever read it)', async () => {
    expect((await parse({ recordingId: 3 })).success).toBe(false);
  });

  it('rejects outputFormat values with no implementation', async () => {
    expect((await parse({ outputFormat: 'csv' })).success).toBe(false);
  });

  it("accepts outputFormat 'review' now that recordInteraction implements it", async () => {
    expect((await parse({ outputFormat: 'review' })).success).toBe(true);
  });
});

describe('outputFormat produces distinguishable output for every surviving value (bug B)', () => {
  const sequence: CommandSequence = {
    id: 'seq-1',
    name: 'fmt-test',
    commands: [
      { tool: 'navigate', params: { action: 'goto', url: 'http://localhost:3000/' } },
      { tool: 'input', params: { action: 'click', selector: '#go' }, delay: 250 },
      { tool: 'input', params: { action: 'type', text: 'hello' } },
    ],
    createdAt: Date.now(),
    startUrl: 'http://localhost:3000/',
  };

  async function get(outputFormat?: string) {
    const recorder = new CommandRecorder();
    (recorder as any).sequences.set(sequence.id, sequence);
    const tool = makeTool(recorder);
    const res = await tool.handler({ action: 'get', name: sequence.name, outputFormat } as any);
    return res.content[0].text as string;
  }

  it('default returns the human detail view', async () => {
    const text = await get();
    expect(text).toContain('**Commands**');
  });

  it('commands returns machine-readable JSON of the command list', async () => {
    const text = await get('commands');
    const json = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    expect(json).toHaveLength(3);
    expect(json[1]).toMatchObject({ tool: 'input', params: { action: 'click', selector: '#go' }, delay: 250 });
    expect(text).not.toContain('await page');
  });

  it('events is rejected with an explicit error - a stored sequence has no raw events', async () => {
    const text = await get('events');
    expect(text).toContain('recordInteraction');
    expect(text).toContain('commands');
    expect(text).not.toContain('**Commands**');
  });

  it('playwright and puppeteer return distinct generated code', async () => {
    const pw = await get('playwright');
    const pp = await get('puppeteer');
    expect(pw).toContain('@playwright/test');
    expect(pp).toContain("require('puppeteer')");
    expect(pw).not.toBe(pp);
  });

  it('review is rejected with its own explicit error - it renders raw events too', async () => {
    const text = await get('review');
    expect(text).toContain('review');
    expect(text).toContain('recordInteraction');
    expect(text).not.toContain('**Commands**');
  });

  it('every surviving outputFormat value yields a unique response', async () => {
    const outputs = await Promise.all([undefined, 'events', 'commands', 'review', 'playwright', 'puppeteer'].map(f => get(f)));
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});

describe('recordInteraction honours outputFormat (bug B, raw-event side)', () => {
  it("outputFormat 'events' appends the raw recorded events as JSON", async () => {
    const { result } = await record({ outputFormat: 'events' });
    const text = result.content[0].text as string;
    expect(text).toContain('Raw recorded events');
    const json = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    expect(json).toHaveLength(recordingEvents.length);
    expect(json[0]).toMatchObject({ type: 'click', x: 10, y: 20 });
  });

  it("outputFormat 'commands' appends the converted commands as JSON", async () => {
    const { result } = await record({ outputFormat: 'commands' });
    const text = result.content[0].text as string;
    expect(text).toContain('Commands (JSON)');
    const json = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    expect(json[0]).toMatchObject({ tool: 'input', params: { action: 'click', selector: '#go' } });
  });

  it("outputFormat 'review' appends a human-readable walkthrough, not JSON", async () => {
    const { result } = await record({ outputFormat: 'review' });
    const text = result.content[0].text as string;
    expect(text).toContain('Event Review');
    // Markdown walkthrough, not a JSON dump of either events or commands.
    expect(text).toContain('### 1. CLICK at (10, 20)');
    expect(text).toContain('Selector: `#go`');
    expect(text).not.toContain('Raw recorded events');
    expect(text).not.toContain('Commands (JSON)');
    expect(text).not.toContain('"timestamp"');
    // mousemove noise is dropped from the review
    expect(text).not.toContain('MOUSEMOVE');
  });

  it("outputFormat 'review' renders the wider event variants instead of dropping them", async () => {
    startRecordingMock.mockResolvedValue({
      success: true,
      recording: {
        events: [
          { type: 'navigation', timestamp: 1000, url: 'http://localhost:3000/next', previousUrl: 'http://localhost:3000/' },
          { type: 'click', timestamp: 1100, x: 10, y: 20, elementInfo: { tag: 'button', selector: '#go', isInteractive: true } },
          { type: 'paste', timestamp: 1200, text: 'pasted-value', targetInfo: { tag: 'input', id: 'email', isInput: true } },
          { type: 'comment', timestamp: 1300, text: 'this is where it goes wrong', category: 'narrative' },
        ],
        startUrl: 'http://localhost:3000/',
        duration: 2000,
        summary: { clicks: 1, drags: 0, scrolls: 0, keyPresses: 0, navigations: 1, comments: 1 },
      },
    });

    const { result } = await record({ outputFormat: 'review' });
    const text = result.content[0].text as string;
    const review = text.slice(text.indexOf('**Event Review'));

    expect(review).toContain('NAVIGATION to http://localhost:3000/next');
    expect(review).toContain('From: http://localhost:3000/');
    expect(review).toContain('PASTE');
    expect(review).toContain('"pasted-value"');
    expect(review).toContain('Target: `input#email`');
    expect(review).toContain('COMMENT');
    expect(review).toContain('this is where it goes wrong');
    // All four events are numbered - nothing fell through silently.
    expect(review).toContain('### 4.');
  });

  it('appends nothing when outputFormat is omitted', async () => {
    const { result } = await record();
    const text = result.content[0].text as string;
    expect(text).not.toContain('Raw recorded events');
    expect(text).not.toContain('Commands (JSON)');
  });
});

describe('recordInteraction under a name already taken', () => {
  it('is refused before anything is recorded, so no recording is lost to it', async () => {
    const recorder = new CommandRecorder();
    await recorder.createSequenceFromCommands('checkout-flow-test', [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    ]);
    const tool = makeTool(recorder);

    const result: any = await tool.handler({
      action: 'recordInteraction', connection: 'checkout-page-tab', name: 'checkout-flow-test',
    } as any);

    expect(result.content[0].text).toContain('"checkout-flow-test" exists');
    expect(startRecordingMock).not.toHaveBeenCalled();
  });

  it('records over it with overwrite', async () => {
    const recorder = new CommandRecorder();
    await recorder.createSequenceFromCommands('checkout-flow-test', [
      { tool: 'dom', params: { action: 'querySelector', selector: '#a' } },
    ]);
    const tool = makeTool(recorder);

    await tool.handler({
      action: 'recordInteraction', connection: 'checkout-page-tab', name: 'checkout-flow-test', overwrite: true,
    } as any);

    expect(startRecordingMock).toHaveBeenCalled();
  });
});

describe('exported test code', () => {
  async function exported(format: 'playwright' | 'puppeteer') {
    const recorder = new CommandRecorder();
    await recorder.createSequenceFromCommands('quoted-flow-test', [
      { tool: 'navigate', params: { action: 'goto', url: "http://shop.test/?q=it's" } },
      { tool: 'input', params: { action: 'click', selector: "[data-test='buy']" }, comment: 'first line\nsecond line' } as any,
      { tool: 'input', params: { action: 'hover', selector: "a[title='Help']" } },
    ]);
    const result: any = await makeTool(recorder).handler({ action: 'get', name: 'quoted-flow-test', outputFormat: format } as any);
    return result.content[0].text.split('```')[1].replace(/^\w+\n/, '');
  }

  it('escapes quotes in selectors and URLs, so the Puppeteer file parses', async () => {
    const code = await exported('puppeteer');
    expect(() => new Function(code)).not.toThrow();
    expect(code).toContain("page.click('[data-test=\\'buy\\']')");
  });

  it('keeps a multi-line step comment inside the comment in the Playwright file', async () => {
    const code = await exported('playwright');
    expect(code).toContain('// first line second line');
    expect(code).toContain("page.hover('a[title=\\'Help\\']')");
    expect(code).toContain("page.goto('http://shop.test/?q=it\\'s')");
  });
});
