/**
 * An evaluation that dispatches input drives the page with events the page
 * made itself. The first such evaluation of a session names `run steps`,
 * which drives real input and reads the page back in the same one request;
 * an evaluation that only reads is answered as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInspectionTools } from './inspection-tools.js';

const text = (res: any): string => res.content.map((part: any) => part.text ?? '').join('\n');

function inspectTool() {
  const cdpManager = {
    evaluateExpressionDetailed: vi.fn(async () => ({ formatted: '"Saved"', rawCaptured: false })),
  } as any;
  return createInspectionTools({} as any, async () => ({ cdpManager }) as any).inspect;
}

describe('an evaluation that dispatches input', () => {
  it('names the real-input path on the first such evaluation of the session, and not again', async () => {
    const inspect = inspectTool();
    const read = await inspect.handler({ action: 'evaluateExpression', connection: 'shop-web-app', expression: "document.title" } as any);
    const first = await inspect.handler({ action: 'evaluateExpression', connection: 'shop-web-app', expression: "document.querySelector('#save').click()" } as any);
    const second = await inspect.handler({ action: 'evaluateExpression', connection: 'shop-web-app', expression: "el.dispatchEvent(new MouseEvent('click'))" } as any);

    expect(text(read)).not.toContain("run({ action: 'steps'");
    expect(text(first)).toContain("run({ action: 'steps'");
    expect(text(second)).not.toContain("run({ action: 'steps'");
    expect(text(second)).toContain('"Saved"');
  });
});
