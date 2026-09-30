/**
 * feature-029: `create`/`insert` must rewrite a step's literal value back to
 * `{{var:name.path}}` when it matches an earlier included step's `saveAs`
 * capture, so a sequence built from a live/hands-on session is portable
 * (see references/sequences.md) instead of pinned to that session's data.
 */
import { describe, it, expect, vi } from 'vitest';
import { CommandRecorder } from '../command-recorder.js';
import { createReplayTools } from './replay-tools.js';

const KNOWN_TOOLS = ['navigate', 'inspect', 'input', 'request', 'connection'];

const text = (res: any) => res.content[0].text as string;

const requestResult = (body: any) => ({
  content: [{ type: 'text', text: 'ok' }],
  _meta: { request: { ok: true, status: 200, body } },
});

const evalResult = (value: unknown) => ({
  content: [{ type: 'text', text: 'evaluated' }],
  _meta: { tool: 'inspect', action: 'evaluateExpression', timestamp: 1, inspect: { expression: 'x', value, valueType: typeof value } },
});

async function makeRecorderWithReplay() {
  const recorder = new CommandRecorder();
  const { replay } = createReplayTools(recorder, vi.fn(), undefined, undefined, () => KNOWN_TOOLS);
  return { recorder, replay };
}

describe('replay create - templatizes literals against earlier saveAs captures', () => {
  it('rewrites a whole-value literal (a minted URL) to {{var:name.path}}', async () => {
    const { recorder, replay } = await makeRecorderWithReplay();

    await recorder.recordCommand(
      'request',
      { url: 'https://app.test/api/links', method: 'POST', saveAs: 'mint' },
      { result: requestResult({ url: 'https://app.test/l/abc123def' }) }
    );
    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/l/abc123def' });

    const res = await replay.handler({ action: 'create', name: 'mint-and-visit', indices: [0, 1] } as any);
    expect(res.isError).toBeUndefined();

    const created = recorder.listSequences()[0];
    expect(created.commands[1].params.url).toBe('{{var:mint.body.url}}');
    // the capturing step itself is untouched
    expect(created.commands[0].params.saveAs).toBe('mint');
  });

  it('rewrites a literal embedded inside a larger string (a CSS selector)', async () => {
    const { recorder, replay } = await makeRecorderWithReplay();

    await recorder.recordCommand(
      'inspect',
      { action: 'evaluateExpression', expression: 'rows[0].id', saveAs: 'personId' },
      { result: evalResult(48213) }
    );
    await recorder.recordCommand('input', { action: 'click', selector: '[data-row-key="48213"]' });

    const res = await replay.handler({ action: 'create', name: 'click-row', indices: [0, 1] } as any);
    expect(res.isError).toBeUndefined();

    const created = recorder.listSequences()[0];
    expect(created.commands[1].params.selector).toBe('[data-row-key="{{var:personId}}"]');
  });

  it('does not rewrite a literal that only happens to match a common/short number', async () => {
    const { recorder, replay } = await makeRecorderWithReplay();

    await recorder.recordCommand(
      'request',
      { url: 'https://app.test/api/status', saveAs: 'check' },
      { result: requestResult({ code: 200 }) }
    );
    await recorder.recordCommand('request', { url: 'https://app.test/api/other', expectedStatus: 200 });

    const res = await replay.handler({ action: 'create', name: 'status-check', indices: [0, 1] } as any);
    expect(res.isError).toBeUndefined();

    const created = recorder.listSequences()[0];
    expect(created.commands[1].params.expectedStatus).toBe(200);
  });

  it('does not templatize against a saveAs that has no recorded result', async () => {
    const { recorder, replay } = await makeRecorderWithReplay();

    // saveAs present, but no result was ever attached (e.g. handler never ran)
    await recorder.recordCommand('request', { url: 'https://app.test/api/links', saveAs: 'mint' });
    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/l/abc123def' });

    const res = await replay.handler({ action: 'create', name: 'mint-and-visit', indices: [0, 1] } as any);
    expect(res.isError).toBeUndefined();

    const created = recorder.listSequences()[0];
    expect(created.commands[1].params.url).toBe('https://app.test/l/abc123def');
  });

  it('only substitutes against captures from included, earlier steps (not later or excluded ones)', async () => {
    const { recorder, replay } = await makeRecorderWithReplay();

    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/l/abc123def' });
    await recorder.recordCommand(
      'request',
      { url: 'https://app.test/api/links', saveAs: 'mint' },
      { result: requestResult({ url: 'https://app.test/l/abc123def' }) }
    );

    // step 0 (the literal) comes before step 1 (the capture) - nothing to substitute against yet
    const res = await replay.handler({ action: 'create', name: 'visit-then-mint', indices: [0, 1] } as any);
    expect(res.isError).toBeUndefined();

    const created = recorder.listSequences()[0];
    expect(created.commands[0].params.url).toBe('https://app.test/l/abc123def');
  });
});

describe('replay insert - shares create\'s templatization (buildCommandsFromHistory)', () => {
  // handleInsert builds its inserted steps via recorder.buildCommandsFromHistory
  // (replay-edit.ts), the exact method createSequence uses above - exercised
  // directly here since driving a real pause/insert cycle needs a live
  // background run. Wiring is a 3-line delegation, verified by inspection.
  it('rewrites a literal against an earlier saveAs capture within the given indices', async () => {
    const recorder = new CommandRecorder();

    await recorder.recordCommand(
      'request',
      { url: 'https://app.test/api/links', saveAs: 'mint' },
      { result: requestResult({ url: 'https://app.test/l/abc123def' }) }
    );
    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/l/abc123def' });

    const commands = recorder.buildCommandsFromHistory([0, 1]);
    expect(commands).not.toBeNull();
    expect(commands![1].params.url).toBe('{{var:mint.body.url}}');
    // delay/comment are preserved too (insert's old inline map dropped them)
  });

  it('preserves delay and comment, which the old inline map in handleInsert dropped', async () => {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/' }, { delay: 500, comment: 'wait for load' });

    const commands = recorder.buildCommandsFromHistory([0]);
    expect(commands![0].delay).toBe(500);
    expect(commands![0].comment).toBe('wait for load');
  });

  it('returns null for a nonexistent index', async () => {
    const recorder = new CommandRecorder();
    await recorder.recordCommand('navigate', { action: 'goto', url: 'https://app.test/' });

    expect(recorder.buildCommandsFromHistory([0, 99])).toBeNull();
  });
});
