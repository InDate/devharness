import { z } from 'zod';
import type { Page } from 'puppeteer-core';
import {
  detectModals as detectModalsUtil,
  DetectedModal,
  DismissStrategy,
  ModalDetectionOptions,
} from '../utils/modal-detector.js';
import {
  dismissModalByStrategy,
  selectDismissalStrategy,
} from '../utils/modal-dismissal.js';
import { executeWithPauseDetection } from '../debugger-aware-wrapper.js';
import { formatToolError, formatToolSuccess, createErrorResponse, createSuccessResponse } from '../messages.js';
import { createTool } from '../validation-helpers.js';
import { closedUnseen, dialogResponse, describeAnswer, describeDialog, type DialogMonitor, type OpenDialog } from '../dialog-monitor.js';
import { throwIfAborted } from '../utils/abort.js';
import { sanitizeReference } from '../reference-validator.js';
import type { ToolResponseMeta } from '../tool-response.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

const modalSchema = z.object({
  action: z.enum(['detect', 'dismiss', 'answer', 'wait']),
  connection: z.string().describe('The connection, by the name connection launch or attach gave it'),
  minZIndex: z.number().optional().describe('detect/dismiss: min z-index to consider'),
  minViewportCoverage: z.number().optional().describe('detect/dismiss: min viewport coverage (0-1, default: 0.25)'),
  includeBackdrops: z.boolean().optional().describe('detect/dismiss: include backdrop/overlay elements; the same options keep detect\'s index valid for dismiss'),
  selector: z.string().optional().describe('dismiss: CSS selector of the modal to dismiss'),
  index: z.number().optional().describe('dismiss: modal index (1-based)'),
  strategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).optional().describe('dismiss: accept, reject, close (click that button), remove (from the DOM), auto (by modal type; default)'),
  retryAttempts: z.number().optional().describe('dismiss: click retries (default 3)'),
  accept: z.boolean().optional().describe('answer: OK (true, default) or Cancel (false); false closes a file picker unfilled'),
  promptText: z.string().optional().describe('answer: the text a prompt is accepted with'),
  files: z.array(z.string()).optional().describe('answer: files for the file picker, absolute or relative to the project'),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional().describe('wait: most ms to wait for the dialog to close (default 600000)'),
}).strict();

/**
 * Create modal handling tools
 */
export function createModalTools(resolveConnectionByName: (connection: string) => Promise<any>) {
  return {
    modal: createTool(
      'Blocking modals and overlays, and browser dialogs. Actions: detect (an open alert/confirm/prompt/file picker, else page overlays with the strategies each can be dismissed by), dismiss (dismiss a page overlay, the topmost by default), answer (close an open alert/confirm/prompt or fill a file picker), wait (until the open dialog closes, however it is answered)',
      modalSchema,
      async ({ action, ...args }, signal) => {
        const resolved = await resolveConnectionByName(args.connection);
        const dialog = resolved?.connection?.dialogMonitor?.current() as OpenDialog | null | undefined;
        if (action === 'answer') return answerDialogImpl(args, resolved);
        if (action === 'wait') return waitDialogImpl(args, resolved, signal);
        if (dialog) {
          return dialogResponse(action === 'detect' ? 'DIALOG_DETECTED' : 'DIALOG_OPEN', sanitizeReference(args.connection), dialog, `modal ${action}`);
        }
        return action === 'detect'
          ? await detectModalsImpl(args, resolveConnectionByName)
          : await dismissModalImpl(args, resolveConnectionByName);
      }
    ),
  };
}

/**
 * Close the browser dialog open on the connection: a JavaScript dialog by
 * Page.handleJavaScriptDialog, which returns while the page's scripts are
 * stopped, and a picker a call holds by filling its input or cancelling it.
 */
async function answerDialogImpl(
  args: { connection: string; accept?: boolean; promptText?: string; files?: string[] },
  resolved: any,
) {
  const connection = sanitizeReference(args.connection);
  if (!resolved) return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connection });
  const monitor: DialogMonitor | undefined = resolved.connection?.dialogMonitor;
  const dialog = monitor?.current();
  if (!monitor || !dialog) return createErrorResponse('DIALOG_NONE_OPEN', { connection });

  const refused = (reason: string) => {
    const response: any = createErrorResponse('DIALOG_ANSWER_REFUSED', { connection, dialog: describeDialog(dialog), reason });
    response._meta = { tool: 'modal', action: 'answer', timestamp: Date.now(), dialog } satisfies ToolResponseMeta;
    return response;
  };
  const answered = (answer: string) => {
    const response: any = createSuccessResponse('DIALOG_ANSWERED', { connection, dialog: describeDialog(dialog), answer });
    response._meta = { tool: 'modal', action: 'answer', timestamp: Date.now(), dialog } satisfies ToolResponseMeta;
    return response;
  };

  if (dialog.kind === 'javascript') {
    if (args.files) return refused('it takes accept and promptText, not files.');
    const accept = args.accept ?? true;
    await monitor.answerDialog(accept, args.promptText);
    return answered(accept
      ? `accepted${args.promptText !== undefined ? ` with "${args.promptText}"` : ''}`
      : 'cancelled');
  }

  if (!dialog.intercepted || dialog.backendNodeId === undefined) {
    return refused('the picker is on screen, and filling its input would leave the OS window up. A person answers it there.');
  }
  if (args.files) {
    // Relative to the project, so a sequence carrying a fixture path runs on any machine.
    const files = args.files.map(file => resolve(file));
    const missing = files.filter(file => !existsSync(file));
    if (missing.length > 0) return refused(`no file at ${missing.map(file => `\`${file}\``).join(', ')}.`);
    if (dialog.mode === 'selectSingle' && files.length > 1) return refused(`its input takes one file, and ${files.length} were given.`);
    await monitor.answerFiles(dialog.backendNodeId, files);
    return answered(`filled with ${files.map(file => `\`${file}\``).join(', ')}`);
  }
  if (args.accept === false) {
    await monitor.cancelChooser(dialog.backendNodeId);
    return answered('cancelled');
  }
  return refused("it takes files to fill it, or accept: false to cancel it.");
}

/**
 * Wait for the dialog open on the connection to close, from the app's window,
 * the bench or `modal answer`, and report how it was answered.
 */
async function waitDialogImpl(
  args: { connection: string; timeoutMs?: number },
  resolved: any,
  signal?: AbortSignal,
) {
  const connection = sanitizeReference(args.connection);
  if (!resolved) return createErrorResponse('CONNECTION_NOT_FOUND', { reference: args.connection });
  const monitor: DialogMonitor | undefined = resolved.connection?.dialogMonitor;
  if (!monitor) return createSuccessResponse('DIALOG_WAIT_NONE_OPEN', { connection });
  const timeoutMs = args.timeoutMs ?? 600_000;
  const began = Date.now();
  const left = () => Math.max(1, timeoutMs - (Date.now() - began));
  const open = monitor.current();
  // A picker the step opened in a tab without focus, which Chrome cancelled
  // before it showed, was answered by nobody: the wait stands on the person
  // opening it with their own click in the app, which focuses that tab.
  const just = open ? null : monitor.closedWithin(2000);
  let closed = open ? await monitor.waitForClose(timeoutMs, signal) : null;
  const unseen = closed && closedUnseen(closed) ? closed : just && closedUnseen(just) ? just : null;
  if (!open && !unseen) return createSuccessResponse('DIALOG_WAIT_NONE_OPEN', { connection });
  if (unseen) closed = await monitor.waitForPersonToOpen(left(), signal);
  throwIfAborted(signal);
  const dialog = open ?? unseen!.dialog;
  if (!closed) {
    const response: any = createErrorResponse('DIALOG_WAIT_TIMEOUT', { connection, dialog: describeDialog(dialog), timeoutMs });
    response._meta = { tool: 'modal', action: 'wait', timestamp: Date.now(), dialog } satisfies ToolResponseMeta;
    return response;
  }
  const response: any = createSuccessResponse('DIALOG_CLOSED', {
    connection, dialog: describeDialog(closed.dialog), answer: describeAnswer(closed.answer),
    waitedMs: Date.now() - began,
  });
  response._meta = {
    tool: 'modal', action: 'wait', timestamp: Date.now(), dialog: closed.dialog, dialogAnswer: closed.answer,
  } satisfies ToolResponseMeta;
  return response;
}

/**
 * Detects modals and blocking overlays on the current page
 */
async function detectModalsImpl(
  args: {
    connection: string;
    minZIndex?: number;
    minViewportCoverage?: number;
    includeBackdrops?: boolean;
    selector?: string;
    index?: number;
  },
  resolveConnectionByName: (connection: string) => Promise<any>
) {
  const { connection, minZIndex, minViewportCoverage, includeBackdrops } = args;
  const detectionOptions = { minZIndex, minViewportCoverage, includeBackdrops };

  try {
    const resolved = await resolveConnectionByName(connection);
    if (!resolved || !resolved.puppeteerManager) {
      return formatToolError('connection_not_found', 'No Chrome browser available. Start one with `connection` action `launch`.');
    }
    const page = resolved.puppeteerManager.getPage();
    const cdpManager = resolved.cdpManager;

    const result = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page, detectionOptions as ModalDetectionOptions),
      'modal detect'
    );
    // A page paused at a breakpoint, or a detection that failed or timed out,
    // returns no list at all - which is not a page with no modals.
    if (!result.success) {
      return formatToolError('modal_detection_failed', result.error || 'Modal detection did not complete');
    }

    const modals = result.result || [];

    if (modals.length === 0) {
      return formatToolSuccess(
        'No blocking modals detected on the page',
        { count: 0 }
      );
    }

    // Get viewport dimensions
    const viewport = page.viewport();
    const viewportWidth = viewport?.width || 1920;
    const viewportHeight = viewport?.height || 1080;

    // Format modals for display
    const formattedModals = modals.map((modal: any, index: number) => ({
      index: index + 1,
      type: modal.type,
      description: modal.description,
      confidence: `${modal.confidence}%`,
      selector: modal.selector,
      zIndex: modal.zIndex,
      position: {
        x: Math.round(modal.boundingBox.x),
        y: Math.round(modal.boundingBox.y),
        width: Math.round(modal.boundingBox.width),
        height: Math.round(modal.boundingBox.height),
      },
      viewportCoverage: `${Math.round(
        (modal.boundingBox.width * modal.boundingBox.height) /
          viewportWidth /
          viewportHeight *
          100
      )}%`,
      availableStrategies: modal.dismissStrategies,
    }));

    return formatToolSuccess(
      `Detected ${modals.length} blocking modal${modals.length > 1 ? 's' : ''}`,
      {
        count: modals.length,
        modals: formattedModals,
        recommendation:
          modals.length > 0
            ? `Use modal({ action: 'dismiss', connection: "${connection}", index: ${formattedModals[0].index} }) or selector "${formattedModals[0].selector}"`
            : undefined,
      }
    );
  } catch (error: any) {
    return formatToolError(
      'modal_detection_failed',
      `Failed to detect modals: ${error.message}`
    );
  }
}

/**
 * Dismisses a modal using various strategies
 */
async function dismissModalImpl(
  args: {
    connection: string;
    selector?: string;
    index?: number;
    strategy?: 'accept' | 'reject' | 'close' | 'remove' | 'auto';
    retryAttempts?: number;
    minZIndex?: number;
    minViewportCoverage?: number;
    includeBackdrops?: boolean;
  },
  resolveConnectionByName: (connection: string) => Promise<any>
) {
  const {
    connection,
    selector,
    index,
    strategy = 'auto',
    retryAttempts = 3,
    minZIndex,
    minViewportCoverage,
    includeBackdrops,
  } = args;

  try {
    // resolveConnectionByName yields { connection, cdpManager,
    // puppeteerManager, ... } - there is no `page` on it, so the page has to
    // come from the puppeteerManager (same as detect does).
    const resolved = await resolveConnectionByName(connection);
    if (!resolved || !resolved.puppeteerManager) {
      return formatToolError('connection_not_found', 'No Chrome browser available. Start one with `connection` action `launch`.');
    }
    const page = resolved.puppeteerManager.getPage();
    const cdpManager = resolved.cdpManager;

    // First, detect modals to find the target
    const detectResult = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page, { minZIndex, minViewportCoverage, includeBackdrops } as ModalDetectionOptions),
      'modal detect'
    );
    if (!detectResult.success) {
      return formatToolError('modal_detection_failed', detectResult.error || 'Modal detection did not complete');
    }

    const modals = detectResult.result || [];

    if (modals.length === 0) {
      return formatToolError(
        'no_modals_found',
        'No modals detected on the page. Nothing to dismiss.'
      );
    }

    // Determine which modal to dismiss
    let targetModal: DetectedModal | undefined;

    if (selector) {
      // Try to find modal by selector
      targetModal = modals.find((m: any) => m.selector === selector);
      if (!targetModal) {
        // Selector might be more specific, try to match partial
        targetModal = modals.find((m: any) => m.selector.includes(selector) || selector.includes(m.selector));
      }
    } else if (index !== undefined) {
      // Use index (1-based)
      if (index < 1 || index > modals.length) {
        return formatToolError(
          'invalid_modal_index',
          `Invalid modal index ${index}. Detected ${modals.length} modal${modals.length > 1 ? 's' : ''} (indices 1-${modals.length})`
        );
      }
      targetModal = modals[index - 1];
    } else {
      // Default to first/topmost modal
      targetModal = modals[0];
    }

    if (!targetModal) {
      return formatToolError(
        'modal_not_found',
        selector
          ? `Could not find modal matching selector "${selector}". Available modals:\n${modals.map((m: any, i: any) => `${i + 1}. ${m.selector} (${m.description})`).join('\n')}`
          : 'Could not determine which modal to dismiss'
      );
    }

    // Determine dismissal strategy using shared logic
    const effectiveStrategy = selectDismissalStrategy(targetModal, strategy);

    // Verify strategy is available
    if (strategy !== 'auto' && !targetModal.dismissStrategies.includes(strategy)) {
      return formatToolError(
        'strategy_not_available',
        `Strategy "${strategy}" not available for this modal. Available strategies: ${targetModal.dismissStrategies.join(', ')}`
      );
    }

    // Execute dismissal
    const dismissResult = await executeWithPauseDetection(cdpManager, async () => {
      return await dismissModalByStrategy(
        page,
        targetModal!,
        effectiveStrategy,
        retryAttempts
      );
    }, 'modal dismiss');

    const result = dismissResult.result;

    if (result && result.success) {
      return formatToolSuccess(
        `Successfully dismissed ${targetModal.description} using "${effectiveStrategy}" strategy`,
        {
          modalType: targetModal.type,
          strategy: effectiveStrategy,
          selector: targetModal.selector,
          method: result.method,
        }
      );
    } else {
      return formatToolError(
        'dismissal_failed',
        `Failed to dismiss modal: ${result?.error || dismissResult.error || 'Unknown error'}`,
        {
          modalType: targetModal.type,
          attemptedStrategy: effectiveStrategy,
          selector: targetModal.selector,
        }
      );
    }
  } catch (error: any) {
    return formatToolError(
      'modal_dismissal_failed',
      `Failed to dismiss modal: ${error.message}`
    );
  }
}
