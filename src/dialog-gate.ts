/**
 * The gate every tool call passes on its way to a page: what a browser dialog
 * open over that page, or opening during the call, does to the call.
 */

import { dialogResponse, type DialogMonitor, type OpenDialog } from './dialog-monitor.js';
import { appendToResponse } from './tool-response.js';
import { AbortError, linkSignals } from './utils/abort.js';

/**
 * Tools that run with a browser dialog open: `modal` answers it, and the rest
 * read what devharness holds rather than the page, so none waits on a page
 * whose scripts the dialog stopped. `replay` passes because each step of a
 * run comes through the gate as a call of its own: gated as a whole, a
 * step-through could never reach the step that answers the dialog the step
 * before it opened, and raced as a whole, one step's dialog aborts the run.
 */
const DIALOG_PASSING_TOOLS = new Set([
  'modal', 'connection', 'browser', 'console', 'network', 'proxy', 'server', 'config', 'dashboard', 'issues', 'message',
  'replay',
]);
/** Actions that read the bench's own state, not the page, and so run with a dialog open. */
const DIALOG_PASSING_ACTIONS: Record<string, ReadonlySet<string>> = {
  bench: new Set(['status', 'list']),
};

/** The page a call names: its connection's name, and the monitor on its dialogs. */
export interface DialogTarget {
  reference: string;
  monitor: Pick<DialogMonitor, 'current' | 'onOpen' | 'intercepting' | 'takeRefusedPickers'>;
}

/**
 * Run a tool call against the browser dialogs of the page it names.
 *
 * A dialog already open refuses the call with DIALOG_OPEN: a JavaScript dialog
 * stops the page's scripts, so the call would wait until a human answered, and
 * a native picker takes the window's input while Chrome cancels every dialog
 * behind it. A dialog opening mid-call settles the call with DIALOG_OPENED and
 * aborts the handler, whose CDP command stays pending until the dialog closes.
 * File-chooser interception is on for an `input` call's span, so a picker it
 * opens raises no OS window and waits for `modal answer`.
 */
export async function underDialogs(
  target: DialogTarget | undefined,
  toolName: string,
  args: Record<string, any>,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<any>,
): Promise<any> {
  const passes = DIALOG_PASSING_TOOLS.has(toolName)
    || (DIALOG_PASSING_ACTIONS[toolName]?.has(String(args.action)) ?? false);
  if (passes || !target) return run(signal);
  const { reference, monitor } = target;

  const standing = monitor.current();
  if (standing) return dialogResponse('DIALOG_OPEN', reference, standing, toolName);

  const stopped = new AbortController();
  const linked = linkSignals(signal, stopped.signal);
  let stopWatching = () => {};
  const opened = new Promise<OpenDialog>(resolve => { stopWatching = monitor.onOpen(resolve); });
  // Chrome opens a picker only on a user gesture, which only `input` makes.
  // Interception is one setting for the whole page, so a reading call holding
  // it on would hold a picker a step means to show on screen.
  const within = toolName === 'input'
    ? <T>(work: () => Promise<T>) => monitor.intercepting(work)
    : <T>(work: () => Promise<T>) => work();
  try {
    return await within(async () => {
      const work = run(linked.signal);
      // Rejected after the dialog settled the call, by the abort or the dialog's close.
      work.catch(() => {});
      const settled = await Promise.race([
        work.then(result => ({ result })),
        opened.then(dialog => ({ dialog })),
      ]);
      if ('dialog' in settled) {
        stopped.abort(new AbortError('A browser dialog opened during the call'));
        return dialogResponse('DIALOG_OPENED', reference, settled.dialog, toolName);
      }
      const refused = monitor.takeRefusedPickers();
      if (refused > 0 && settled.result && !settled.result.isError) {
        appendToResponse(settled.result, `\n\n**File System Access picker refused:** Chrome returned AbortError to the page${refused > 1 ? ` ${refused} times` : ''}.`);
      }
      return settled.result;
    });
  } finally {
    stopWatching();
    linked.dispose();
  }
}
