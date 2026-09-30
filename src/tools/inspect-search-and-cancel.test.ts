import { describe, it, expect, vi } from 'vitest';
import { createInspectionTools } from './inspection-tools.js';
import { isAbortError } from '../utils/abort.js';

/** A connection with one script, whose search answers `lineContent` and whose full line is `fullLine`. */
function inspectOver(lineContent: string, fullLine?: string) {
  const cdpManager = {
    isConnected: () => true,
    getAllScripts: () => [{ scriptId: '1', url: 'http://app/bundle.js' }],
    searchInScript: vi.fn(async () => [{ lineNumber: 0, lineContent }]),
    getScriptLine: vi.fn(async () => fullLine ?? lineContent),
    getEndpoint: () => ({ host: 'localhost', port: 9222 }),
  } as any;
  return createInspectionTools({} as any, async () => ({ cdpManager }) as any).inspect;
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');

describe('searching a webpack eval bundle', () => {
  it('reads an escaped backslash before n as a backslash and an n, not a line break', async () => {
    const fullLine = String.raw`eval(__webpack_require__.ts("const a = 1;\nconst sep = '\\n'; // marker\n"))`;
    const inspect = inspectOver('eval(__webpack_require__.ts("const a = 1;', fullLine);

    const result = await inspect.handler({ action: 'searchCode', connectionReason: 'shop-web-app', pattern: 'marker' });

    expect(text(result)).toContain(String.raw`const sep = '\n'; // marker`);
  });
});

describe('search results', () => {
  it('are shown without their indentation, by searchCode as by searchFunctions', async () => {
    const code = await inspectOver('        const marker = 1;').handler({
      action: 'searchCode', connectionReason: 'shop-web-app', pattern: 'marker',
    });
    const fns = await inspectOver('        function marker() {').handler({
      action: 'searchFunctions', connectionReason: 'shop-web-app', functionName: 'marker',
    });

    expect(text(code)).toContain('\n  const marker = 1;');
    expect(text(fns)).toContain('\n  function marker() {');
  });
});

describe('evaluating inside a worker', () => {
  it('stops waiting when the call is cancelled', async () => {
    const cdpManager = { getEndpoint: () => ({ host: 'localhost', port: 9222 }) } as any;
    const registry = { evaluate: vi.fn(() => new Promise(() => {})) };
    const { inspect } = createInspectionTools({} as any, async () => ({ cdpManager }) as any, () => registry as any);
    const controller = new AbortController();

    const settled = inspect.handler(
      { action: 'evaluateExpression', connectionReason: 'shop-web-app', target: 'sw.js', expression: 'self.registration' },
      controller.signal,
    ).then(value => ({ value }), error => ({ error }));
    controller.abort();

    const outcome: any = await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('still waiting'), 200))]);
    expect(outcome).not.toBe('still waiting');
    expect(isAbortError(outcome.error)).toBe(true);
  });
});
