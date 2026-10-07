/**
 * The browser-owned dialogs open over one connection's page: a JavaScript
 * dialog (alert, confirm, prompt, beforeunload) and a file picker.
 *
 * A JavaScript dialog stops the renderer's main thread, so every CDP call that
 * needs it - input, evaluation, DOM reads - stays pending until the dialog
 * closes. A native file picker leaves the renderer running but takes the
 * window's input, and while it is up Chrome answers any JavaScript dialog
 * with "cancel" without showing it. Either way a call driving the page reads
 * a page no human can act on, so the record here is what the call path
 * refuses on and races against.
 *
 * Opening is read from CDP: Page.javascriptDialogOpening, and
 * Page.fileChooserOpened, which `enableFileChooserOpenedEvent` emits for a
 * picker Chrome still shows. A picker's closing has no CDP event: the page
 * script below reports the input's `cancel` and `change`, and the settling of
 * the File System Access pickers, through a binding.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { CDPSession, Page } from 'puppeteer-core';
import { debugLog } from './debug-logger.js';
import { createErrorResponse, createSuccessResponse } from './messages.js';
import type { ToolResponseMeta } from './tool-response.js';
import { ownScript } from './utils/own-script.js';

export type JavaScriptDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export type OpenDialog =
  | {
      kind: 'javascript';
      type: JavaScriptDialogType;
      message: string;
      defaultPrompt?: string;
      url: string;
      since: number;
    }
  | {
      kind: 'fileChooser';
      mode: 'selectSingle' | 'selectMultiple';
      /** The `<input type="file">` behind the picker; absent for showOpenFilePicker and its siblings. */
      backendNodeId?: number;
      /** No native picker is on screen: a devharness call opened it and holds it for `modal answer`. */
      intercepted: boolean;
      since: number;
    };

/** How a dialog closed: OK or Cancel and the prompt's text, or whether the picker returned files. */
export type DialogAnswer =
  | { kind: 'javascript'; accepted: boolean; promptText?: string }
  | { kind: 'fileChooser'; picked: boolean };

export interface ClosedDialog {
  dialog: OpenDialog;
  answer: DialogAnswer;
  at: number;
}

/**
 * Chrome cancels a picker within a millisecond of opening it when the tab
 * asking is not the focused one - the bench's tab beside the app in split view
 * included - so a cancel this soon after opening was never on screen.
 */
const UNSEEN_MS = 50;

/** Whether `closed` is a picker Chrome cancelled before anyone could see it. */
export function closedUnseen(closed: ClosedDialog): boolean {
  return closed.dialog.kind === 'fileChooser' && !closed.dialog.intercepted
    && closed.answer.kind === 'fileChooser' && !closed.answer.picked
    && closed.at - closed.dialog.since < UNSEEN_MS;
}

const BINDING = '__devharnessChooserClosed';

/**
 * Reports a file picker's close to the binding: the input's `cancel` or
 * `change`, and the settling of a File System Access picker's promise, which
 * fires neither event.
 */
const CHOOSER_CLOSE_SCRIPT = `(() => {
  if (globalThis.__devharnessChooserWatch) return;
  globalThis.__devharnessChooserWatch = true;
  const closed = (picked) => { try { globalThis.${BINDING}(picked ? 'picked' : 'cancelled'); } catch {} };
  const fromFileInput = (picked) => (event) => event.target instanceof HTMLInputElement && event.target.type === 'file' && closed(picked);
  addEventListener('cancel', fromFileInput(false), true);
  addEventListener('change', fromFileInput(true), true);
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    const original = globalThis[name];
    if (typeof original !== 'function') continue;
    globalThis[name] = function (...args) {
      const picked = original.apply(this, args);
      picked.then(() => closed(true), () => closed(false));
      return picked;
    };
  }
})();`;

/** Each attached monitor by its page's target id: the bench holds its own Page object for the same tab. */
const byTarget = new Map<string, DialogMonitor>();

function targetIdOf(page: Page): string | undefined {
  const target = (page as any).target?.();
  return target?._targetId ?? target?._targetInfo?.targetId;
}

/**
 * Calls run under `showingPickers` leave a picker they open on screen, for a
 * person to answer, where every other call holds it with no window.
 */
const pickersOnScreen = new AsyncLocalStorage<true>();

export function showingPickers<T>(work: () => Promise<T>): Promise<T> {
  return pickersOnScreen.run(true, work);
}

/** The monitor attached to the tab `page` drives, from any Page object for that tab. */
export function dialogMonitorOf(page: Page): DialogMonitor | undefined {
  const id = targetIdOf(page);
  return id ? byTarget.get(id) : undefined;
}

export class DialogMonitor {
  private targetId?: string;
  private open: OpenDialog | null = null;
  private openListeners = new Set<(dialog: OpenDialog) => void>();
  private closeListeners = new Set<(closed: ClosedDialog) => void>();
  private lastClosed: ClosedDialog | null = null;
  /** Waits on a person opening a picker themselves, after Chrome cancelled one a step opened unseen. */
  private gestureWaits = 0;
  /** Calls running with interception on; interception is on while this is above zero. */
  private interceptingCalls = 0;
  /** The interception change last sent, so on and off reach Chrome in the order the calls made them. */
  private interceptionQueue: Promise<unknown> = Promise.resolve();
  /** File System Access pickers Chrome refused while intercepting, waiting to be reported by the call that opened them. */
  private refusedPickers = 0;

  private constructor(private readonly session: CDPSession) {}

  static async attach(page: Page): Promise<DialogMonitor> {
    const session = await page.createCDPSession();
    const monitor = new DialogMonitor(session);
    monitor.listen();
    monitor.targetId = targetIdOf(page);
    if (monitor.targetId) byTarget.set(monitor.targetId, monitor);
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: BINDING });
    await session.send('Page.enable', { enableFileChooserOpenedEvent: true } as any);
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: ownScript('chooser-close', CHOOSER_CLOSE_SCRIPT) });
    await session.send('Runtime.evaluate', { expression: ownScript('chooser-close', CHOOSER_CLOSE_SCRIPT) }).catch(() => {});
    return monitor;
  }

  private listen(): void {
    this.session.on('Page.javascriptDialogOpening', (event: any) => {
      this.markOpen({
        kind: 'javascript',
        type: event.type,
        message: event.message,
        ...(event.type === 'prompt' ? { defaultPrompt: event.defaultPrompt ?? '' } : {}),
        url: event.url,
        since: Date.now(),
      });
    });
    this.session.on('Page.javascriptDialogClosed', (event: any) => {
      if (this.open?.kind !== 'javascript') return;
      this.markClosed({
        kind: 'javascript',
        accepted: !!event.result,
        ...(this.open.type === 'prompt' && event.result ? { promptText: event.userInput ?? '' } : {}),
      });
    });
    this.session.on('Page.fileChooserOpened', (event: any) => {
      const intercepted = this.interceptingCalls > 0;
      // Chrome rejects an intercepted File System Access picker with AbortError
      // at once: nothing stays open, and no input exists to fill.
      if (intercepted && event.backendNodeId === undefined) {
        this.refusedPickers += 1;
        return;
      }
      this.markOpen({
        kind: 'fileChooser',
        mode: event.mode,
        ...(event.backendNodeId !== undefined ? { backendNodeId: event.backendNodeId } : {}),
        intercepted,
        since: Date.now(),
      });
    });
    this.session.on('Runtime.bindingCalled', (event: any) => {
      if (event.name === BINDING && this.open?.kind === 'fileChooser') {
        this.markClosed({ kind: 'fileChooser', picked: event.payload === 'picked' });
      }
    });
    // A new document closes any picker the old one opened, and fires no cancel.
    this.session.on('Page.frameNavigated', (event: any) => {
      if (!event.frame?.parentId && this.open?.kind === 'fileChooser') {
        this.markClosed({ kind: 'fileChooser', picked: false });
      }
    });
  }

  private markClosed(answer: DialogAnswer): void {
    const dialog = this.open;
    if (!dialog) return;
    this.open = null;
    const closed = { dialog, answer, at: Date.now() };
    this.lastClosed = closed;
    void debugLog('DialogMonitor', `closed after ${closed.at - dialog.since}ms: ${describeAnswer(answer)}${closedUnseen(closed) ? ' (unseen)' : ''}`);
    for (const listener of [...this.closeListeners]) {
      try { listener(closed); } catch { /* one listener's failure leaves the others fed */ }
    }
  }

  /**
   * The open dialog's close, however it comes: a person in the app's window,
   * the bench, or `modal answer`. Null when none is open, when `timeoutMs`
   * passes first, or when `signal` aborts.
   */
  waitForClose(timeoutMs: number, signal?: AbortSignal): Promise<ClosedDialog | null> {
    if (!this.open || signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const done = (closed: ClosedDialog | null) => {
        clearTimeout(timer);
        this.closeListeners.delete(onClose);
        signal?.removeEventListener('abort', onAbort);
        resolve(closed);
      };
      const onClose = (closed: ClosedDialog) => done(closed);
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      this.closeListeners.add(onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private markOpen(dialog: OpenDialog): void {
    this.open = dialog;
    void debugLog('DialogMonitor', `opened ${dialog.kind === 'javascript' ? dialog.type : `file chooser (${dialog.intercepted ? 'intercepted' : 'native'})`}`);
    for (const listener of [...this.openListeners]) {
      try { listener(dialog); } catch { /* one listener's failure leaves the others fed */ }
    }
  }

  current(): OpenDialog | null {
    return this.open;
  }

  /** The last dialog to close, when it closed no more than `withinMs` ago. */
  closedWithin(withinMs: number): ClosedDialog | null {
    return this.lastClosed && Date.now() - this.lastClosed.at <= withinMs ? this.lastClosed : null;
  }

  /** Whether a wait stands on a person opening a picker in the app themselves. */
  awaitingGesture(): boolean {
    return this.gestureWaits > 0;
  }

  /**
   * The close of the next dialog to open, opened by a person's own click in
   * the app: their click focuses the app's tab, where Chrome shows a picker it
   * cancelled unseen for a step. Null on timeout or abort.
   */
  async waitForPersonToOpen(timeoutMs: number, signal?: AbortSignal): Promise<ClosedDialog | null> {
    const began = Date.now();
    this.gestureWaits += 1;
    try {
      const opened = this.open ?? await new Promise<OpenDialog | null>(resolve => {
        const done = (dialog: OpenDialog | null) => {
          clearTimeout(timer);
          stop();
          signal?.removeEventListener('abort', onAbort);
          resolve(dialog);
        };
        const stop = this.onOpen(dialog => done(dialog));
        const onAbort = () => done(null);
        const timer = setTimeout(() => done(null), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (!opened) return null;
    } finally {
      this.gestureWaits -= 1;
    }
    return this.waitForClose(Math.max(1, timeoutMs - (Date.now() - began)), signal);
  }

  /** Receive each dialog that opens, until the returned stop is called. */
  onOpen(listener: (dialog: OpenDialog) => void): () => void {
    this.openListeners.add(listener);
    return () => { this.openListeners.delete(listener); };
  }

  /** File System Access pickers refused since the last read, cleared by reading. */
  takeRefusedPickers(): number {
    const count = this.refusedPickers;
    this.refusedPickers = 0;
    return count;
  }

  /**
   * Run `work` with file-chooser interception on, so a picker it opens raises
   * no OS window and waits for `modal answer`. Interception is off outside
   * calls, so a picker a human opens shows as usual.
   */
  async intercepting<T>(work: () => Promise<T>): Promise<T> {
    if (pickersOnScreen.getStore()) return work();
    this.interceptingCalls += 1;
    if (this.interceptingCalls === 1) await this.setInterception(true);
    try {
      return await work();
    } finally {
      this.interceptingCalls -= 1;
      if (this.interceptingCalls === 0) void this.setInterception(false);
    }
  }

  private setInterception(enabled: boolean): Promise<unknown> {
    void debugLog('DialogMonitor', `interception ${enabled ? 'on' : 'off'}`);
    const send = () => this.session.send('Page.setInterceptFileChooserDialog', { enabled })
      .catch(error => debugLog('DialogMonitor', `interception ${enabled ? 'on' : 'off'} failed: ${error}`));
    this.interceptionQueue = this.interceptionQueue.then(send, send);
    return this.interceptionQueue;
  }

  /** Close the open JavaScript dialog. A browser-side command, so it returns while the renderer is stopped. */
  async answerDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.session.send('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    if (this.open?.kind === 'javascript') {
      this.markClosed({
        kind: 'javascript',
        accepted: accept,
        ...(this.open.type === 'prompt' && accept ? { promptText: promptText ?? this.open.defaultPrompt ?? '' } : {}),
      });
    }
  }

  /** Fill the open picker's input with `files`; the page receives `change` as from a human's pick. */
  async answerFiles(backendNodeId: number, files: string[]): Promise<void> {
    await this.session.send('DOM.setFileInputFiles', { files, backendNodeId });
    this.markClosed({ kind: 'fileChooser', picked: true });
  }

  /** Close the open picker unfilled; the page receives `cancel`. */
  async cancelChooser(backendNodeId: number): Promise<void> {
    const { object } = await this.session.send('DOM.resolveNode', { backendNodeId });
    await this.session.send('Runtime.callFunctionOn', {
      objectId: object.objectId!,
      functionDeclaration: "function () { this.dispatchEvent(new Event('cancel', { bubbles: true })); }",
    });
    this.markClosed({ kind: 'fileChooser', picked: false });
  }

  async dispose(): Promise<void> {
    if (this.targetId && byTarget.get(this.targetId) === this) byTarget.delete(this.targetId);
    this.openListeners.clear();
    await this.session.detach().catch(() => {});
  }
}

/**
 * A response naming `dialog` on `connection`: DIALOG_OPEN for a call refused
 * on a dialog already open, DIALOG_OPENED for one a dialog stopped, and the
 * answered and detected readings. `_meta.dialog` carries the dialog itself.
 */
export function dialogResponse(
  messageId: 'DIALOG_OPEN' | 'DIALOG_OPENED' | 'DIALOG_DETECTED',
  connection: string,
  dialog: OpenDialog,
  toolName: string,
): any {
  const answers = answerCalls(connection, dialog);
  const variables = {
    connection,
    dialog: describeDialog(dialog),
    toolName,
    javascript: dialog.kind === 'javascript',
    onScreen: dialog.kind === 'fileChooser' && !dialog.intercepted,
    held: dialog.kind === 'fileChooser' && dialog.intercepted,
    answers,
    hasAnswers: answers.length > 0,
  };
  const response: any = messageId === 'DIALOG_DETECTED'
    ? createSuccessResponse(messageId, variables)
    : createErrorResponse(messageId, variables);
  response._meta = { tool: toolName, timestamp: Date.now(), dialog } satisfies ToolResponseMeta;
  return response;
}

/** How a dialog was answered, in a few words. */
export function describeAnswer(answer: DialogAnswer): string {
  if (answer.kind === 'fileChooser') return answer.picked ? 'files picked' : 'cancelled';
  if (!answer.accepted) return 'cancelled';
  return answer.promptText !== undefined ? `OK, with "${answer.promptText}"` : 'OK';
}

/** One line naming an open dialog, for responses and refusals. */
export function describeDialog(dialog: OpenDialog): string {
  if (dialog.kind === 'javascript') {
    return dialog.type === 'beforeunload'
      ? 'a "leave this page?" dialog'
      : `${dialog.type === 'alert' ? 'an' : 'a'} ${dialog.type}: "${dialog.message}"`;
  }
  const source = dialog.backendNodeId === undefined ? 'a File System Access picker' : 'a file picker';
  return dialog.intercepted ? `${source} (held for files, no window on screen)` : `${source} (on screen)`;
}

/**
 * The modal calls that answer `dialog`. A picker on screen has none: filling
 * its input leaves the OS window up, so the human answers it there.
 */
export function answerCalls(connection: string, dialog: OpenDialog): string[] {
  const call = (fields: string) => `modal({ action: 'answer', connection: '${connection}', ${fields} })`;
  if (dialog.kind === 'javascript') {
    if (dialog.type === 'alert') return [call('accept: true')];
    if (dialog.type === 'prompt') return [call("accept: true, promptText: '...'"), call('accept: false')];
    return [call('accept: true'), call('accept: false')];
  }
  if (!dialog.intercepted || dialog.backendNodeId === undefined) return [];
  return [call("files: ['path/to/file']"), call('accept: false')];
}
