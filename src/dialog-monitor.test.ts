/**
 * What the monitor holds as open over a page, read off the CDP events Chrome
 * sends and the binding the page script calls on a picker's close.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  DialogMonitor, answerCalls, closedUnseen, dialogMonitorOf, showingPickers,
  type ClosedDialog, type OpenDialog,
} from './dialog-monitor.js';

function fakeSession() {
  const session = new EventEmitter() as EventEmitter & { send: ReturnType<typeof vi.fn>; detach: () => Promise<void> };
  session.send = vi.fn(async (method: string) => (method === 'DOM.resolveNode' ? { object: { objectId: 'node-1' } } : {}));
  session.detach = async () => {};
  return session;
}

async function attached(targetId = 'target-1') {
  const session = fakeSession();
  const page = { createCDPSession: async () => session, target: () => ({ _targetId: targetId }) } as any;
  const monitor = await DialogMonitor.attach(page);
  return { session, page, monitor };
}

const BINDING = '__devharnessChooserClosed';
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('a JavaScript dialog', () => {
  it('is open from javascriptDialogOpening until javascriptDialogClosed, with the answer given', async () => {
    const { session, monitor } = await attached();
    const closes: ClosedDialog[] = [];
    session.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'draft', url: 'http://app.test/' });
    expect(monitor.current()).toMatchObject({ kind: 'javascript', type: 'prompt', message: 'Name?', defaultPrompt: 'draft' });

    const waited = monitor.waitForClose(1000).then(closed => closed && closes.push(closed));
    session.emit('Page.javascriptDialogClosed', { result: true, userInput: 'final' });
    await waited;

    expect(monitor.current()).toBeNull();
    expect(closes[0].answer).toEqual({ kind: 'javascript', accepted: true, promptText: 'final' });
  });

  it('is answered by a browser-side command and closed with that answer', async () => {
    const { session, monitor } = await attached();
    session.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Forget it?', url: 'http://app.test/' });

    await monitor.answerDialog(false);

    expect(session.send).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false });
    expect(monitor.current()).toBeNull();
    expect(monitor.closedWithin(1000)?.answer).toEqual({ kind: 'javascript', accepted: false });
  });

  it('tells each listener it opened', async () => {
    const { session, monitor } = await attached();
    const opened: OpenDialog[] = [];
    const stop = monitor.onOpen(dialog => opened.push(dialog));
    session.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved', url: 'http://app.test/' });
    stop();
    session.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Again', url: 'http://app.test/' });

    expect(opened.map(dialog => dialog.kind === 'javascript' && dialog.message)).toEqual(['Saved']);
  });
});

describe('a file picker', () => {
  it('is open from fileChooserOpened until the page reports its close, picked or cancelled', async () => {
    const { session, monitor } = await attached();
    session.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 7, frameId: 'f' });
    expect(monitor.current()).toMatchObject({ kind: 'fileChooser', backendNodeId: 7, intercepted: false });

    session.emit('Runtime.bindingCalled', { name: BINDING, payload: 'picked' });

    expect(monitor.current()).toBeNull();
    expect(monitor.closedWithin(1000)?.answer).toEqual({ kind: 'fileChooser', picked: true });
  });

  it('is closed by a new document, which fires no cancel', async () => {
    const { session, monitor } = await attached();
    session.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 7 });
    session.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } });
    expect(monitor.current()).not.toBeNull();

    session.emit('Page.frameNavigated', { frame: { id: 'main' } });

    expect(monitor.current()).toBeNull();
    expect(monitor.closedWithin(1000)?.answer).toEqual({ kind: 'fileChooser', picked: false });
  });

  it('is filled through its input when a call holds it', async () => {
    const { session, monitor } = await attached();
    session.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 7 });

    await monitor.answerFiles(7, ['/tmp/upload.txt']);

    expect(session.send).toHaveBeenCalledWith('DOM.setFileInputFiles', { files: ['/tmp/upload.txt'], backendNodeId: 7 });
    expect(monitor.closedWithin(1000)?.answer).toEqual({ kind: 'fileChooser', picked: true });
  });
});

describe('interception', () => {
  const interceptions = (session: ReturnType<typeof fakeSession>) => session.send.mock.calls
    .filter(([method]) => method === 'Page.setInterceptFileChooserDialog')
    .map(([, params]) => params.enabled);

  it('is on for the span of the calls that ask for it, and off once the last ends', async () => {
    const { session, monitor } = await attached();
    let release!: () => void;
    const first = monitor.intercepting(() => new Promise<void>(resolve => { release = resolve; }));
    await settle();
    await monitor.intercepting(async () => {});
    release();
    await first;
    await settle();

    expect(interceptions(session)).toEqual([true, false]);
  });

  it('stays off for a call run showing pickers, so the picker reaches a person', async () => {
    const { session, monitor } = await attached();
    await showingPickers(() => monitor.intercepting(async () => {}));
    await settle();

    expect(interceptions(session)).toEqual([]);
  });

  it('records a picker opened under it as held, and counts a File System Access picker Chrome refused', async () => {
    const { session, monitor } = await attached();
    await monitor.intercepting(async () => {
      session.emit('Page.fileChooserOpened', { mode: 'selectSingle' });
      expect(monitor.current()).toBeNull();
      session.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 9 });
    });

    expect(monitor.current()).toMatchObject({ kind: 'fileChooser', intercepted: true, backendNodeId: 9 });
    expect(monitor.takeRefusedPickers()).toBe(1);
    expect(monitor.takeRefusedPickers()).toBe(0);
  });
});

describe('a picker Chrome cancels unseen', () => {
  const closed = (afterMs: number, picked = false): ClosedDialog => ({
    dialog: { kind: 'fileChooser', mode: 'selectSingle', backendNodeId: 7, intercepted: false, since: 1000 },
    answer: { kind: 'fileChooser', picked },
    at: 1000 + afterMs,
  });

  it('is a cancel within 50ms of opening', () => {
    expect(closedUnseen(closed(2))).toBe(true);
    expect(closedUnseen(closed(2639))).toBe(false);
    expect(closedUnseen(closed(2, true))).toBe(false);
  });

  it('leaves the wait standing on the next picker a person opens, and resolves on its close', async () => {
    const { session, monitor } = await attached();
    const waited = monitor.waitForPersonToOpen(1000);
    expect(monitor.awaitingGesture()).toBe(true);

    session.emit('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 7 });
    await settle();
    expect(monitor.awaitingGesture()).toBe(false);
    session.emit('Runtime.bindingCalled', { name: BINDING, payload: 'picked' });

    expect((await waited)?.answer).toEqual({ kind: 'fileChooser', picked: true });
  });

  it('gives up the wait at its timeout', async () => {
    const { monitor } = await attached();
    expect(await monitor.waitForPersonToOpen(5)).toBeNull();
    expect(monitor.awaitingGesture()).toBe(false);
  });
});

describe('the monitor of a page', () => {
  it('is found from any Page object for the same tab, until it is disposed', async () => {
    const { monitor } = await attached('target-shared');
    const benchsCopy = { target: () => ({ _targetId: 'target-shared' }) } as any;
    expect(dialogMonitorOf(benchsCopy)).toBe(monitor);

    await monitor.dispose();

    expect(dialogMonitorOf(benchsCopy)).toBeUndefined();
  });
});

describe('the answers offered', () => {
  const picker = (intercepted: boolean): OpenDialog =>
    ({ kind: 'fileChooser', mode: 'selectSingle', backendNodeId: 7, intercepted, since: 0 });

  it('offers files or a cancel for a held picker, and nothing for one on screen', () => {
    expect(answerCalls('shop', picker(true))).toHaveLength(2);
    expect(answerCalls('shop', picker(false))).toEqual([]);
  });

  it('offers OK alone for an alert', () => {
    expect(answerCalls('shop', { kind: 'javascript', type: 'alert', message: 'Saved', url: '', since: 0 }))
      .toEqual([`modal({ action: 'answer', connection: 'shop', accept: true })`]);
  });
});
