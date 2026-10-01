import { describe, it, expect, vi, beforeEach } from 'vitest';

const detectMock = vi.fn();
vi.mock('../utils/modal-detector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/modal-detector.js')>()),
  detectModals: (...args: any[]) => detectMock(...args),
}));

const { createModalTools } = await import('./modal-tools.js');

function makeModal(opts: { paused: boolean }) {
  const page = { viewport: () => ({ width: 800, height: 600 }) };
  const cdpManager = {
    isPaused: () => opts.paused,
    getPausedInfo: () => ({ paused: true, location: { url: 'app.js', lineNumber: 4 } }),
  };
  const resolved = { cdpManager, puppeteerManager: { getPage: () => page } };
  return createModalTools(async () => resolved).modal;
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');

beforeEach(() => {
  detectMock.mockReset();
  detectMock.mockResolvedValue([]);
});

describe('modal on a page paused at a breakpoint', () => {
  it('detect reports the pause, not an empty page', async () => {
    const result: any = await makeModal({ paused: true }).handler({ action: 'detect', connection: 'shop-web-app' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('paused at a breakpoint');
    expect(text(result)).not.toContain('No blocking modals');
  });

  it('dismiss reports the pause, not that there is nothing to dismiss', async () => {
    const result: any = await makeModal({ paused: true }).handler({ action: 'dismiss', connection: 'shop-web-app' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('paused at a breakpoint');
  });
});

describe('modal dismiss', () => {
  it('detects with the options detect was given, so an index means the same modal', async () => {
    await makeModal({ paused: false }).handler({
      action: 'dismiss', connection: 'shop-web-app', index: 1, minZIndex: 10, minViewportCoverage: 0.1, includeBackdrops: false,
    });

    expect(detectMock).toHaveBeenCalledWith(expect.anything(), { minZIndex: 10, minViewportCoverage: 0.1, includeBackdrops: false });
  });
});
