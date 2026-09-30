/**
 * Modal dismissal utilities
 *
 * This module handles the logic for dismissing modals using various strategies.
 * It was extracted from duplicate code in modal-tools.ts and input-tools.ts
 */

import type { Page } from 'puppeteer-core';
import type { DetectedModalInfo as DetectedModal, DismissStrategy } from './modal-detection-core.js';
import { clickElement } from './click-element.js';

export interface DismissalResult {
  success: boolean;
  method?: string;
  error?: string;
}

/**
 * Dismiss a modal using a specific strategy
 *
 * @param page - Puppeteer page instance
 * @param modal - The detected modal to dismiss
 * @param strategy - Dismissal strategy (accept, reject, close, remove)
 * @param retryAttempts - Number of retry attempts when clicking buttons
 * @returns Result indicating success or failure
 */
export async function dismissModalByStrategy(
  page: Page,
  modal: DetectedModal,
  strategy: DismissStrategy,
  retryAttempts: number = 3
): Promise<DismissalResult> {
  // Remove strategy - just remove from DOM
  if (strategy === 'remove') {
    try {
      await page.evaluate((sel: string) => {
        const element = (globalThis as any).document.querySelector(sel);
        if (element) {
          element.remove();
          return true;
        }
        return false;
      }, modal.selector);

      // Verify removal
      const stillExists = await page.$(modal.selector);
      if (stillExists) {
        return { success: false, error: 'Element still exists after removal attempt' };
      }

      return { success: true, method: 'DOM removal' };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Button click strategies - need to find appropriate button
  const buttonSelectors = await page.evaluate(
    (sel: string, strat: string) => {
      const modal = (globalThis as any).document.querySelector(sel);
      if (!modal) return [];

      const selectors: string[] = [];

      // The patterns are English: on a site in another language no button
      // matches, and strategy "remove" is the way to dismiss.
      let textPatterns: RegExp;
      let classPatterns: string[];

      // Whole words only: "ok" as a substring reads "Cookie settings" as an
      // accept button, and "no" reads "notification" as a reject one.
      switch (strat) {
        case 'accept':
          textPatterns = /\b(accept|agree|allow|enable|ok|got it|continue|yes)\b/i;
          classPatterns = ['accept', 'agree', 'allow', 'enable', 'ok', 'continue', 'yes'];
          break;
        case 'reject':
          textPatterns = /\b(reject|decline|deny|disable|no thanks|refuse|dismiss)\b/i;
          classPatterns = ['reject', 'decline', 'deny', 'refuse', 'no'];
          break;
        case 'close':
          textPatterns = /\b(close|dismiss|skip|no thanks)\b|[×✕✖]/i;
          classPatterns = ['close', 'dismiss', 'skip'];
          break;
        default:
          return [];
      }

      const escape = (value: string): string => {
        const css = (globalThis as any).CSS;
        return css?.escape ? css.escape(value) : value.replace(/[^\w-]/g, ch => `\\${ch}`);
      };
      // An element:nth-of-type path from the modal down to the button, which
      // names that button alone whatever its id and classes are.
      const pathFromModal = (el: any): string => {
        const steps: string[] = [];
        for (let node = el; node && node !== modal; node = node.parentElement) {
          let n = 1;
          for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
            if (sib.tagName === node.tagName) n++;
          }
          steps.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${n})`);
        }
        return `${sel} > ${steps.join(' > ')}`;
      };

      const buttons = modal.querySelectorAll(
        'button, [role="button"], a[href="#"], .button, .btn, [class*="button" i], [class*="btn" i]'
      );

      buttons.forEach((btn: any) => {
        const words = `${btn.textContent || ''} ${btn.getAttribute('aria-label') || ''} ${btn.id}`;
        const classTokens = String(btn.className || '').toLowerCase().split(/[\s_-]+/).filter(Boolean);
        if (textPatterns.test(words) || classPatterns.some(pattern => classTokens.includes(pattern))) {
          selectors.push(btn.id ? `#${escape(btn.id)}` : pathFromModal(btn));
        }
      });

      return [...new Set(selectors)]; // Remove duplicates
    },
    modal.selector,
    strategy
  );

  // Try each button selector
  for (const btnSelector of buttonSelectors) {
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try {
        const button = await page.$(btnSelector);
        if (!button) continue;

        await clickElement(page, button);

        // Wait for modal to disappear (with timeout)
        try {
          await page.waitForSelector(modal.selector, { hidden: true, timeout: 1000 });
          return { success: true, method: `Clicked button: ${btnSelector}` };
        } catch (e) {
          // Modal didn't disappear, try next button
          continue;
        }
      } catch (error) {
        // Try next button or retry
        continue;
      }
    }
  }

  // Removal is left to the caller, as strategy "remove", rather than done here.
  if (buttonSelectors.length === 0) {
    return {
      success: false,
      error: `No ${strategy} buttons found in modal. Use strategy "remove" to force removal.`,
    };
  }

  return {
    success: false,
    error: `Found ${buttonSelectors.length} potential ${strategy} button(s) but none successfully dismissed the modal`,
  };
}

/**
 * Select the best dismissal strategy based on modal type
 *
 * @param modal - The detected modal
 * @param requestedStrategy - User-requested strategy or 'auto'
 * @returns Effective strategy to use
 */
export function selectDismissalStrategy(
  modal: DetectedModal,
  requestedStrategy: DismissStrategy | 'auto'
): DismissStrategy {
  if (requestedStrategy === 'auto') {
    // Smart strategy selection based on modal type
    switch (modal.type) {
      case 'cookie-consent':
        // Prefer accept for cookie consents (least friction)
        return modal.dismissStrategies.includes('accept')
          ? 'accept'
          : modal.dismissStrategies.includes('close')
            ? 'close'
            : 'remove';
      case 'newsletter-popup':
        // Prefer close for newsletters (non-committal)
        return modal.dismissStrategies.includes('close')
          ? 'close'
          : modal.dismissStrategies.includes('reject')
            ? 'reject'
            : 'remove';
      case 'age-verification':
        // Prefer accept for age gates (necessary)
        return modal.dismissStrategies.includes('accept')
          ? 'accept'
          : 'remove';
      default:
        // For unknown modals, prefer close, then remove
        return modal.dismissStrategies.includes('close')
          ? 'close'
          : 'remove';
    }
  } else {
    // Use requested strategy if available
    if (!modal.dismissStrategies.includes(requestedStrategy)) {
      // Fall back to remove if requested strategy not available
      return 'remove';
    }
    return requestedStrategy;
  }
}
