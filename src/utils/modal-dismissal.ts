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

      // Define button search patterns based on strategy
      // TODO: These button text patterns are English-only. Non-English sites will fail button detection.
      // Workaround: Use strategy: 'remove' for non-English sites.
      // See KNOWN_LIMITATIONS.md "Language Limitations" section for details.
      let textPatterns: RegExp;
      let classPatterns: string[];

      switch (strat) {
        case 'accept':
          textPatterns = /accept|agree|allow|enable|ok|got it|i accept|continue|yes/i;
          classPatterns = ['accept', 'agree', 'allow', 'enable', 'ok', 'continue', 'yes'];
          break;
        case 'reject':
          textPatterns = /reject|decline|deny|disable|no thanks|refuse|dismiss/i;
          classPatterns = ['reject', 'decline', 'deny', 'refuse', 'no'];
          break;
        case 'close':
          textPatterns = /close|dismiss|×|✕|✖|skip|no thanks/i;
          classPatterns = ['close', 'dismiss', 'skip'];
          break;
        default:
          return [];
      }

      // Find buttons within modal
      const buttons = modal.querySelectorAll(
        'button, [role="button"], a[href="#"], .button, .btn, [class*="button" i], [class*="btn" i]'
      );

      buttons.forEach((btn: any, idx: number) => {
        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const className = btn.className.toLowerCase();
        const id = btn.id.toLowerCase();
        const combined = `${text} ${ariaLabel} ${className} ${id}`;

        // Check text pattern
        if (textPatterns.test(combined)) {
          // Try to create a unique selector
          if (btn.id) {
            selectors.push(`#${btn.id}`);
          } else if (btn.className) {
            const classes = btn.className.split(/\s+/).filter(Boolean);
            if (classes.length > 0) {
              selectors.push(`${sel} .${classes.join('.')}`);
            }
          } else {
            // Fallback to nth-of-type
            selectors.push(`${sel} button:nth-of-type(${idx + 1})`);
          }
        }

        // Check class patterns
        classPatterns.forEach(pattern => {
          if (className.includes(pattern.toLowerCase())) {
            if (btn.id) {
              selectors.push(`#${btn.id}`);
            } else if (btn.className) {
              const classes = btn.className.split(/\s+/).filter(Boolean);
              selectors.push(`${sel} .${classes.join('.')}`);
            }
          }
        });
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
