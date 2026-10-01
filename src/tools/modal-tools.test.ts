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

describe('a browser dialog', () => {
  const confirm = { kind: 'javascript', type: 'confirm', message: 'Forget it?', url: 'http://app.test/', since: 0 } as const;
  const picker = (intercepted: boolean) => ({ kind: 'fileChooser', mode: 'selectSingle', backendNodeId: 7, intercepted, since: 0 }) as const;

  function withDialog(open: any, extra: Record<string, any> = {}) {
    const monitor = {
      current: () => open,
      answerDialog: vi.fn(async () => {}),
      answerFiles: vi.fn(async () => {}),
      cancelChooser: vi.fn(async () => {}),
      waitForClose: vi.fn(async () => null),
      closedWithin: vi.fn(() => null),
      waitForPersonToOpen: vi.fn(async () => null),
      ...extra,
    };
    const resolved = { connection: { dialogMonitor: monitor }, cdpManager: { isPaused: () => false }, puppeteerManager: { getPage: () => ({}) } };
    return { modal: createModalTools(async () => resolved).modal, monitor };
  }

  it('detect reports it, and leaves the page unread while its scripts are stopped', async () => {
    const { modal } = withDialog(confirm);
    const result: any = await modal.handler({ action: 'detect', connection: 'shop-web-app' });

    expect(result._meta.dialog).toEqual(confirm);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it('answer closes a confirm with the answer given', async () => {
    const { modal, monitor } = withDialog(confirm);
    await modal.handler({ action: 'answer', connection: 'shop-web-app', accept: false });
    expect(monitor.answerDialog).toHaveBeenCalledWith(false, undefined);
  });

  it('answer fills a held picker, resolving a path against the project', async () => {
    const { modal, monitor } = withDialog(picker(true));
    await modal.handler({ action: 'answer', connection: 'shop-web-app', files: ['package.json'] });
    expect(monitor.answerFiles).toHaveBeenCalledWith(7, [`${process.cwd()}/package.json`]);
  });

  it('answer refuses a file that is not there, and a picker on screen', async () => {
    const missing: any = await withDialog(picker(true)).modal.handler({ action: 'answer', connection: 'shop-web-app', files: ['nope.txt'] });
    const onScreen: any = await withDialog(picker(false)).modal.handler({ action: 'answer', connection: 'shop-web-app', files: ['package.json'] });

    expect(missing._errorId).toBe('DIALOG_ANSWER_REFUSED');
    expect(onScreen._errorId).toBe('DIALOG_ANSWER_REFUSED');
  });

  it('answer with nothing open says so', async () => {
    const result: any = await withDialog(null).modal.handler({ action: 'answer', connection: 'shop-web-app' });
    expect(result._errorId).toBe('DIALOG_NONE_OPEN');
  });

  it('wait returns the answer the dialog closed with', async () => {
    const answer = { kind: 'javascript', accepted: true };
    const { modal } = withDialog(confirm, { waitForClose: vi.fn(async () => ({ dialog: confirm, answer, at: 5 })) });
    const result: any = await modal.handler({ action: 'wait', connection: 'shop-web-app' });
    expect(result._meta.dialogAnswer).toEqual(answer);
  });

  it('wait stands on the person opening a picker Chrome cancelled unseen', async () => {
    const unseen = { dialog: picker(false), answer: { kind: 'fileChooser', picked: false }, at: 2 };
    const picked = { dialog: picker(false), answer: { kind: 'fileChooser', picked: true }, at: 3000 };
    const { modal, monitor } = withDialog(null, {
      closedWithin: vi.fn(() => unseen),
      waitForPersonToOpen: vi.fn(async () => picked),
    });

    const result: any = await modal.handler({ action: 'wait', connection: 'shop-web-app' });

    expect(monitor.waitForPersonToOpen).toHaveBeenCalled();
    expect(result._meta.dialogAnswer).toEqual({ kind: 'fileChooser', picked: true });
  });
});
