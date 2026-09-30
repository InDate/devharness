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
import { formatToolError, formatToolSuccess } from '../messages.js';
import { createTool } from '../validation-helpers.js';

// Zod schemas for input validation
const detectModalsSchema = z.object({
  connectionReason: z.string().describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
  minZIndex: z.number().optional().describe('Min z-index to consider'),
  minViewportCoverage: z.number().optional().describe('Min viewport coverage (0-1, default: 0.25)'),
  includeBackdrops: z.boolean().optional().describe('Include backdrop/overlay elements'),
}).strict();

const dismissModalSchema = z.object({
  connectionReason: z.string().describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
  selector: z.string().optional().describe('CSS selector of the modal to dismiss'),
  index: z.number().optional().describe('Modal index (1-based)'),
  strategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).default('auto').describe('Dismissal strategy: accept (click accept/agree), reject (click reject/decline), close (click close/X), remove (remove from DOM), auto (smart selection based on modal type)'),
  retryAttempts: z.number().default(3).describe('Number of retry attempts when clicking buttons'),
}).strict();

/**
 * Create modal handling tools
 */
export function createModalTools(resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  return {
    detectModals: createTool(
      'Detect modals',
      detectModalsSchema,
      async (args) => await detectModalsImpl(args, resolveConnectionFromReason)
    ),
    dismissModal: createTool(
      'Dismiss modal',
      dismissModalSchema,
      async (args) => await dismissModalImpl(args, resolveConnectionFromReason)
    ),
  };
}

/**
 * Detects modals and blocking overlays on the current page
 */
async function detectModalsImpl(
  args: {
    connectionReason: string;
    minZIndex?: number;
    minViewportCoverage?: number;
    includeBackdrops?: boolean;
  },
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  const { connectionReason, ...detectionOptions } = args;

  try {
    const resolved = await resolveConnectionFromReason(connectionReason);
    if (!resolved || !resolved.puppeteerManager) {
      return formatToolError('connection_not_found', 'No Chrome browser available. Start one with `connection` action `launch`.');
    }
    const page = resolved.puppeteerManager.getPage();
    const cdpManager = resolved.cdpManager;

    const result = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page, detectionOptions as ModalDetectionOptions),
      'detectModals'
    );

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
            ? `Use dismissModal with index ${formattedModals[0].index} or selector "${formattedModals[0].selector}"`
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
    connectionReason: string;
    selector?: string;
    index?: number;
    strategy?: 'accept' | 'reject' | 'close' | 'remove' | 'auto';
    retryAttempts?: number;
  },
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  const {
    connectionReason,
    selector,
    index,
    strategy = 'auto',
    retryAttempts = 3,
  } = args;

  try {
    // resolveConnectionFromReason yields { connection, cdpManager,
    // puppeteerManager, ... } - there is no `page` on it, so the page has to
    // come from the puppeteerManager (same as detectModals does).
    const resolved = await resolveConnectionFromReason(connectionReason);
    if (!resolved || !resolved.puppeteerManager) {
      return formatToolError('connection_not_found', 'No Chrome browser available. Start one with `connection` action `launch`.');
    }
    const page = resolved.puppeteerManager.getPage();
    const cdpManager = resolved.cdpManager;

    // First, detect modals to find the target
    const detectResult = await executeWithPauseDetection(
      cdpManager,
      async () => await detectModalsUtil(page),
      'detectModals'
    );

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
    }, 'dismissModal');

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
        `Failed to dismiss modal: ${result?.error || 'Unknown error'}`,
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
