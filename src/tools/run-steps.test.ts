/**
 * `run steps`: tool calls written into one `run` call, run in order through the
 * sequence executor in that one request, each step answered on a line of its
 * own. A synthetic event inside one evaluation is the one-request alternative,
 * and it reaches states real input never does; these steps are real input at
 * the same request count.
 *
 * The fake records each step the way the server's dispatch does - under the
 * run's name and step, with its reply attached - since the reply is read back
 * off those history rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';
import { productionShaped } from '../test-support/fake-execute-tool-call.js';
import { historyPlace } from '../call-origin.js';

const text = (res: any): string => res.content[0].text;
/** The calls the steps made, apart from the connection setup the executor does before them. */
const stepCalls = (calls: Array<{ tool: string; params: Record<string, any> }>) =>
  calls.filter(c => ['input', 'wait', 'inspect'].includes(c.tool));

function harness(answer: (tool: string, params: Record<string, any>) => any = () => ({ content: [{ type: 'text', text: 'done' }] })) {
  const recorder = new CommandRecorder();
  const calls: Array<{ tool: string; params: Record<string, any> }> = [];
  const executeToolCall = vi.fn(async (tool: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    const place = historyPlace();
    if (place) await recorder.recordCommand(tool, params, place);
    const index = recorder.getCurrentHistoryIndex();
    try {
      const response = await productionShaped(async () => answer(tool, params))();
      if (place) recorder.attachResult(index, response);
      return response;
    } catch (error: any) {
      if (place) recorder.attachResult(index, error.response ?? { content: [{ type: 'text', text: String(error) }], isError: true });
      throw error;
    }
  });
  const tools = createReplayTools(recorder, executeToolCall as any, async () => null, async () => 9222, undefined);
  return { recorder, calls, run: tools.run, replay: tools.replay };
}

const clickWaitRead = [
  { tool: 'input', params: { action: 'click', selector: '#save' } },
  { tool: 'wait', params: { ms: 1 } },
  { tool: 'inspect', params: { action: 'evaluateExpression', expression: "document.querySelector('#toast').textContent" } },
];

describe('run steps', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness((tool) => tool === 'inspect'
      ? { content: [{ type: 'text', text: "Expression evaluated successfully\nExpression: document.querySelector('#toast').textContent, Context: Global context\n\nResult:\n\"Saved\"" }] }
      : { content: [{ type: 'text', text: `${tool} done` }] });
  });

  it('names how to keep the steps on the first run of the session only', async () => {
    const first = text(await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any));
    const second = text(await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any));

    expect(first).toContain("replay({ action: 'create'");
    expect(second).not.toContain("replay({ action: 'create'");
  });

  it('runs the steps in order in the one call and answers each on a line of its own', async () => {
    const res = await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any);

    expect(res.isError).not.toBe(true);
    expect(stepCalls(h.calls).map(c => c.tool)).toEqual(['input', 'wait', 'inspect']);
    const out = text(res);
    expect(out).toMatch(/^Ran 3 of 3 steps/);
    expect(out).toMatch(/1 #\d+ input\.click ✓ - input done/);
    expect(out).toMatch(/2 #\d+ wait ✓/);
    expect(out).toContain('"Saved"');
    expect(out).not.toContain('Expression evaluated successfully');
    expect(out).not.toContain('runId');
  });

  it('runs a step naming no connection on the call\'s connection', async () => {
    await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any);

    expect(stepCalls(h.calls).every(c => c.params.connection === 'shop-web-app')).toBe(true);
  });

  it('stops at the first failing step and names it with its reason', async () => {
    const failing = harness((tool) => tool === 'wait'
      ? { content: [{ type: 'text', text: 'Error: Timed out after 15000ms waiting for #toast' }], isError: true }
      : { content: [{ type: 'text', text: `${tool} done` }] });

    const res = await failing.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any);

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Failed at step 2 of 3/);
    expect(text(res)).toMatch(/2 #\d+ wait ✗ - .*Timed out/);
    expect(stepCalls(failing.calls).map(c => c.tool)).toEqual(['input', 'wait']);
  });

  it('leaves out an input\'s settle wait where the next step waits on the page', async () => {
    await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: [
      ...clickWaitRead,
      { tool: 'input', params: { action: 'click', selector: '#close' } },
      { tool: 'input', params: { action: 'click', selector: '#again', detectChanges: true } },
      { tool: 'wait', params: { ms: 1 } },
    ] } as any);

    const clicks = stepCalls(h.calls).filter(c => c.tool === 'input');
    expect(clicks[0].params.detectChanges).toBe(false);
    expect(clicks[1].params.detectChanges).toBeUndefined();
    expect(clicks[2].params.detectChanges).toBe(true);
  });

  it('types text as written, with no variable prompt', async () => {
    const res = await h.run.handler({
      action: 'steps', connection: 'shop-web-app',
      commands: [{ tool: 'input', params: { action: 'type', selector: '#q', text: 'north ridge' } }],
    } as any);

    expect(res._meta?.replay?.prompted).toBeUndefined();
    expect(stepCalls(h.calls)[0].params.text).toBe('north ridge');
  });

  it('leaves no sequence behind once the run ends', async () => {
    await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any);

    expect(h.recorder.listSequences()).toEqual([]);
  });

  it('holds the steps while a paused run can resume them, and drops them when it ends', async () => {
    await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead, stepTo: 1, hold: [] } as any);
    expect(h.recorder.listSequences()).toHaveLength(1);

    await h.run.handler({ action: 'finish' } as any);

    expect(h.recorder.listSequences()).toEqual([]);
    expect(stepCalls(h.calls).map(c => c.tool)).toEqual(['input', 'wait', 'inspect']);
  });

  it('keeps the steps as a sequence through create with their history indices', async () => {
    const res = await h.run.handler({ action: 'steps', connection: 'shop-web-app', commands: clickWaitRead } as any);
    const indices = [...text(res).matchAll(/#(\d+)/g)].map(m => Number(m[1]));

    await h.replay.handler({ action: 'create', name: 'save-toast', indices } as any);

    const kept = h.recorder.listSequences().find(s => s.name === 'save-toast');
    // A wait is stored as the check it is a face of.
    expect(kept?.commands.map(c => c.tool)).toEqual(['input', 'check', 'inspect']);
  });
});

describe('run steps refused before anything runs', () => {
  const cases: Array<[string, Record<string, any>, RegExp]> = [
    ['steps without commands', { action: 'steps', connection: 'shop-web-app' }, /requires "commands"/],
    ['commands on another action', { action: 'sequence', name: 'login', commands: clickWaitRead }, /belongs to the "steps" action/],
    ['commands with a saved name', { action: 'steps', name: 'login', commands: clickWaitRead }, /not both/],
    ['commands played in the bench', { action: 'steps', bench: true, connection: 'shop-web-app', commands: clickWaitRead }, /bench plays a saved sequence/],
    ['a step that starts a run', { action: 'steps', connection: 'shop-web-app', commands: [{ tool: 'run', params: { action: 'sequence', name: 'login' } }] }, /never `replay` or `run`/],
    ['a step that calls replay', { action: 'steps', connection: 'shop-web-app', commands: [{ tool: 'replay', params: { action: 'history' } }] }, /never `replay` or `run`/],
  ];

  for (const [label, args, reason] of cases) {
    it(label, async () => {
      const h = harness();
      const res = await h.run.handler(args as any);

      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(reason);
      expect(h.calls).toEqual([]);
    });
  }
});
