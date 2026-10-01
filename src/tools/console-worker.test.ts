import { describe, it, expect, vi } from 'vitest';

const messages = Array.from({ length: 5 }, (_, i) => ({ type: 'log', text: `worker line ${i + 1}` }));

vi.mock('../worker-targets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker-targets.js')>()),
  getWorkerTargetRegistry: () => ({ messages: async () => messages }),
}));

const { createConsoleTools } = await import('./console-tools.js');

const tools = createConsoleTools(async () => ({
  connection: { host: 'localhost', port: 9222 },
  consoleMonitor: {},
  puppeteerManager: null,
}));

describe('console recent on a worker target', () => {
  it('returns the last `count` messages, as recent on the page does', async () => {
    const result: any = await tools.console.handler({
      action: 'recent', connection: 'shop-web-app', target: 'sw.js', count: 2,
    });

    const text = result.content[0].text as string;
    expect(text).toContain('worker line 4');
    expect(text).toContain('worker line 5');
    expect(text).not.toContain('worker line 3');
  });
});
