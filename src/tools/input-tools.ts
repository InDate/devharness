/**
 * Input Automation Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import type { ConnectionManager } from '../connection-manager.js';
import { executeWithPauseDetection, formatActionResult, actionFailureResponse } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { configManager } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { isElementBlocked, detectModals } from '../utils/modal-detector.js';
import { dismissModalByStrategy, selectDismissalStrategy } from '../utils/modal-dismissal.js';
import { resolveSelector, isExtendedSelector, cleanupResolvedSelector } from '../utils/selector-resolver.js';
import { domChangeMonitor, formatDOMChanges, DOMChanges } from '../dom-change-monitor.js';
import type { ToolResponseMeta, ClickActionMeta } from '../tool-response.js';
import { abortErrorFor, abortableSleep, isAbortError, throwIfAborted } from '../utils/abort.js';

// Coordinate schema for mouse actions
const coordinateSchema = z.object({
  x: z.number(),
  y: z.number(),
});

// Consolidated input tool schema
const inputToolSchema = z.object({
  action: z.enum(['click', 'type', 'press', 'hover', 'focus', 'focusNext', 'focusPrevious', 'drag', 'scroll', 'mousemove', 'pinch', 'tap', 'swipe']),
  connectionReason: z.string(),

  // Selector-based actions
  selector: z.string().optional().describe('CSS selector. Supports :has-text("x"), :text("x")'),
  handleModals: z.boolean().optional(),
  dismissStrategy: z.enum(['accept', 'reject', 'close', 'remove', 'auto']).optional(),

  // click
  clickCount: z.number().optional(),

  // type
  text: z.string().optional(),
  delay: z.number().optional().describe('Keystroke delay ms'),
  append: z.boolean().optional().describe('Append text instead of replacing (default: false)'),

  // press
  key: z.string().optional(),

  // focusNext/focusPrevious
  count: z.number().optional().describe('Tab count'),

  // drag
  from: coordinateSchema.optional(),
  to: coordinateSchema.optional(),
  steps: z.number().optional().describe('Drag smoothness'),

  // swipe: gesture on an element, instead of from/to pixels
  direction: z.enum(['left', 'right', 'up', 'down']).optional()
    .describe("swipe: gesture direction across `selector`'s box, resolved at run time. Use this rather than from/to for anything in a list - a row's coordinates move with the rows above it"),
  distance: z.number().optional()
    .describe('swipe: travel in px. Default is a short, reveal-sized nudge (60% of the element, capped at 96px) because a long fast swipe commits the destructive action on rows that have ranges - pass a larger distance deliberately to over-drag'),
  durationMs: z.number().optional()
    .describe('swipe: how long the gesture takes, spread across `steps` (default 300 - a deliberate drag). Velocity is a real input to gesture handling: unpaced moves go out as fast as the transport allows, which reads as a flick, and a flick is a DIFFERENT gesture - on a swipe-action row it commits the destructive action instead of revealing it. Pass a small value deliberately to test the flick'),

  // scroll
  deltaX: z.number().optional().describe('Horizontal scroll px'),
  deltaY: z.number().optional().describe('Vertical scroll px'),
  x: z.number().optional(),
  y: z.number().optional(),

  // pinch
  scaleFactor: z.number().optional().describe('>1 zoom in, <1 zoom out'),

  // Change detection
  detectChanges: z.boolean().optional(),
  settleTimeout: z.number().optional().describe('DOM settle timeout ms'),
}).strict();

/**
 * Wrapper to execute input actions while bypassing the replay blocker overlay.
 * Sets __cdpReplayClickInProgress flag before the action and clears it after.
 * This allows CDP-dispatched events to pass through the overlay's event listeners.
 */
/**
 * Click a selector without waiting on the document's rendering lifecycle.
 *
 * puppeteer's `page.click` begins with `scrollIntoViewIfNeeded`, which asks an
 * IntersectionObserver whether the element is in view. Observer entries are
 * delivered from the rendering lifecycle, and a tab that is not the selected
 * one in its window gets no rendering opportunities - so on a hidden tab that
 * promise never settles, the CDP call never returns, and the click never
 * reaches the wire. Measured: with the bench tab selected, the app tab
 * reports `document.hidden === true` and a selector click runs past 120s while
 * a coordinate click at the same point returns at once.
 *
 * `scrollIntoView` scrolls over CDP and `clickablePoint` reads getClientRects
 * synchronously; neither needs a frame to be produced.
 */
async function clickSelector(
  page: any,
  selector: string,
  options: { clickCount?: number } = {}
): Promise<void> {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`Element not found: ${selector}`);
  try {
    await handle.scrollIntoView();
    const { x, y } = await handle.clickablePoint();
    await page.mouse.click(x, y, options);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** Hover without the lifecycle wait - see clickSelector. */
async function hoverSelector(page: any, selector: string): Promise<void> {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`Element not found: ${selector}`);
  try {
    await handle.scrollIntoView();
    const { x, y } = await handle.clickablePoint();
    await page.mouse.move(x, y);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function withReplayBypass<T>(page: any, action: () => Promise<T>): Promise<T> {
  await page.evaluate(() => { (globalThis as any).__cdpReplayClickInProgress = true; });
  try {
    return await action();
  } finally {
    // Best-effort: never let a failure clearing the flag mask the action's
    // own outcome (in particular an AbortError thrown mid-action).
    try {
      await page.evaluate(() => { (globalThis as any).__cdpReplayClickInProgress = false; });
    } catch { /* page may have navigated/closed */ }
  }
}

/**
 * Warning text when a selector matches more than one element.
 *
 * The action takes the first match. On a list UI that silently drifts onto the
 * wrong row as the list grows, and the step still reports success - so the
 * count has to be said out loud even though the action succeeded.
 *
 * Advisory only: a selector the browser rejects is the action's error to
 * report, not this helper's.
 */
export async function ambiguousSelectorWarning(page: any, selector: string, raw: string): Promise<string | undefined> {
  try {
    const count: number = await page.evaluate(
      (sel: string) => (globalThis as any).document.querySelectorAll(sel).length,
      selector
    );
    if (count > 1) {
      return `\`${raw}\` matched ${count} elements - acted on the first. Narrow it if you meant a specific one.`;
    }
  } catch {
    // Counting is best-effort.
  }
  return undefined;
}

export function createInputTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  connectionManager: ConnectionManager,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    input: createTool(
      'Perform browser input actions. Actions: click (click element), type (type text into element), press (press keyboard key), hover (hover over element), focus (focus element by selector), focusNext (Tab to next focusable element), focusPrevious (Shift+Tab to previous focusable element), drag (drag from one point to another), scroll (scroll wheel at position), mousemove (move mouse to position), pinch (pinch zoom gesture), tap (real touch tap - selector or x/y), swipe (real touch drag - selector + direction, or raw from/to - for touch-only gestures the mouse cannot drive)',
      inputToolSchema,
      // abortSignal (#110): input events cannot be recalled once dispatched -
      // Input.dispatchMouseEvent on the wire WILL be processed by Chrome. What
      // cancellation buys here is *not dispatching* events that have not gone
      // out yet: checkpoints sit after connection/selector resolution and
      // immediately before every dispatch, and multi-dispatch paths (Tab
      // loops, drag stepping, clear-and-retype) abort between events. On
      // abort the handler THROWS an abort-shaped error; already-issued
      // dispatches are NOT undone.
      async (args, abortSignal?: AbortSignal) => {
        const { action, connectionReason } = args;

        throwIfAborted(abortSignal);

        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, action, resolved.connection.port);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();

        // Determine if change detection is enabled
        const changeConfig = configManager.getChangeDetectionConfig();
        const shouldDetectChanges = args.detectChanges ?? changeConfig.enabled;
        const settleTimeout = args.settleTimeout ?? changeConfig.settleTimeout;

        // Start observing DOM changes before interaction
        if (shouldDetectChanges && ['click', 'type', 'hover'].includes(action)) {
          await domChangeMonitor.startObserving(connectionReason, page);
        }

        // Abort checkpoint used at every point where nothing (further) has
        // been dispatched yet: tears down the DOM-change observer
        // (best-effort, no settle wait) so a cancelled action does not leave
        // a MutationObserver running in the page, then throws abort-shaped.
        const checkAborted = async (): Promise<void> => {
          if (!abortSignal?.aborted) return;
          if (shouldDetectChanges && domChangeMonitor.isObserving(connectionReason)) {
            try {
              await domChangeMonitor.stopObserving(connectionReason, { settleTimeout: 0 });
            } catch { /* cleanup is best-effort */ }
          }
          throw abortErrorFor(abortSignal);
        };

        await checkAborted();

        switch (action) {
          case 'click': {
            const { selector: rawSelector, clickCount = 1, handleModals = false, dismissStrategy = 'auto', x, y } = args;

            // Coordinate-based click (for canvas/3D apps)
            if (typeof x === 'number' && typeof y === 'number') {
              await checkAborted(); // last exit before the click goes on the wire
              await withReplayBypass(page, () => page.mouse.click(x, y, { clickCount }));
              return {
                content: [{
                  type: 'text',
                  text: `Clicked at coordinates (${x}, ${y})`
                }]
              };
            }

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\` or coordinates (\`x\`, \`y\`)\n\n**Action:** click\n\n**Suggestion:** Provide a CSS selector for the element to click, or x/y coordinates for coordinate-based clicking.`,
                  },
                ],
                isError: true,
              };
            }

            // Capture pre-click URL for validation metadata
            const preClickUrl = page.url();

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }
            {
              const ambiguous = await ambiguousSelectorWarning(page, selector, rawSelector);
              if (ambiguous) selectorWarning = selectorWarning ? `${selectorWarning} ${ambiguous}` : ambiguous;
            }
            await checkAborted(); // after selector resolution, before any dispatch

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Check if element exists and is clickable
                const element = await page.$(selector);
                if (!element) {
                  return {
                    error: `Element not found: ${selector}`,
                  };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal. Dismissal DISPATCHES too (an Escape
                    // key or a click on the dismiss control), so it needs its
                    // own pre-dispatch checkpoint - not just the one before the
                    // real action below.
                    await checkAborted();
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
                    if (recheckBlocking.blocked) {
                      return {
                        error: `Element still blocked after dismissing modal`,
                        blockingModal: recheckBlocking.blockingModal,
                      };
                    }
                  } else {
                    // Return error with modal information
                    return {
                      error: `Element is blocked by modal`,
                      blockingModal: blockingCheck.blockingModal,
                      suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                    };
                  }
                }

                // Check if element has click handlers
                const hasClickHandler = await page.evaluate((sel: string) => {
                  const el = (globalThis as any).document.querySelector(sel);
                  if (!el) return false;

                  // Check for onclick attribute
                  if (el.onclick) return true;

                  // Check for addEventListener listeners (limited - can't detect all)
                  // Check if element or ancestors have event listeners by testing common patterns
                  let current = el;
                  while (current) {
                    // Check for common click-related attributes
                    if (current.hasAttribute('onclick')) return true;
                    if (current.hasAttribute('data-action')) return true;

                    // Check for interactive elements that typically have handlers
                    const tag = current.tagName.toLowerCase();
                    if (tag === 'button' || tag === 'a' || tag === 'input') return true;

                    // Check for cursor pointer (often indicates clickable)
                    const style = (globalThis as any).window.getComputedStyle(current);
                    if (style.cursor === 'pointer') return true;

                    current = current.parentElement;
                  }

                  return false;
                }, selector);

                // Perform the click - use wrapper to bypass replay blocker overlay
                await checkAborted(); // last exit before the click goes on the wire
                await withReplayBypass(page, () => clickSelector(page, selector, { clickCount }));

                // Check if breakpoint was hit during click - if so, skip post-click evaluation
                // which would hang because page JS is paused
                if (targetCdpManager.isPaused()) {
                  return {
                    selector,
                    clickCount,
                    hasClickHandler,
                    postClickState: null,
                    pausedDuringClick: true,
                  };
                }

                // Get post-click state
                const postClickState = await page.evaluate((clickedSelector: string) => {
                  const focused = (globalThis as any).document.activeElement;
                  let focusInfo = null;
                  if (focused && focused !== (globalThis as any).document.body) {
                    const tag = focused.tagName.toLowerCase();
                    const text = focused.textContent?.trim().substring(0, 30) || '';
                    const ariaLabel = focused.getAttribute('aria-label') || '';
                    const placeholder = focused.getAttribute('placeholder') || '';
                    const type = focused.getAttribute('type') || '';
                    focusInfo = {
                      tag,
                      type: type || undefined,
                      text: text || ariaLabel || placeholder || undefined,
                      isInput: ['input', 'textarea', 'select'].includes(tag),
                    };
                  }

                  // Get tabbable elements
                  const tabbable = Array.from((globalThis as any).document.querySelectorAll(
                    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
                  )).filter((el: any) => {
                    const style = (globalThis as any).window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
                  });

                  // Helper to format element for display
                  const formatEl = (el: any) => {
                    const tag = el.tagName.toLowerCase();
                    const text = el.textContent?.trim().substring(0, 20) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
                    const type = el.getAttribute('type');
                    if (tag === 'input') {
                      return `${tag}[${type || 'text'}]${text ? ` "${text}"` : ''}`;
                    }
                    return `${tag}${text ? ` "${text}"` : ''}`;
                  };

                  let prevTabbable: string[] = [];
                  let nextTabbable: string[] = [];
                  if (focused) {
                    const currentIndex = tabbable.indexOf(focused);
                    if (currentIndex !== -1) {
                      // Previous 5 tabbable elements
                      prevTabbable = tabbable.slice(Math.max(0, currentIndex - 5), currentIndex).map(formatEl);
                      // Next 5 tabbable elements
                      nextTabbable = tabbable.slice(currentIndex + 1, currentIndex + 6).map(formatEl);
                    }
                  }

                  // Get child interactive elements of clicked element
                  let childInteractive: string[] = [];
                  try {
                    const clickedEl = (globalThis as any).document.querySelector(clickedSelector);
                    if (clickedEl) {
                      const children = clickedEl.querySelectorAll('a[href], button, input, select, textarea');
                      childInteractive = Array.from(children).slice(0, 10).map((el: any) => formatEl(el));
                    }
                  } catch (e) {
                    // Selector may have been cleaned up, ignore
                  }

                  return {
                    focusInfo,
                    prevTabbable,
                    nextTabbable,
                    childInteractive,
                    url: (globalThis as any).window.location.href,
                  };
                }, selector);

                return {
                  selector,
                  clickCount,
                  hasClickHandler,
                  postClickState,
                  warning: !hasClickHandler ? 'Element may not have a click handler attached. Click was performed but may not trigger any action.' : undefined,
                };
              },
              'click'
            );

            // If paused at breakpoint, return immediately - don't try any more page interactions
            if (result.pausedAtBreakpoint || result.result?.pausedDuringClick) {
              // Stop observing without waiting
              if (shouldDetectChanges) {
                await domChangeMonitor.stopObserving(connectionReason, { settleTimeout: 0 });
              }

              // Get pause info if we detected pause inside the action
              const pauseInfo = result.pauseInfo || (result.result?.pausedDuringClick ? (() => {
                const info = targetCdpManager.getPausedInfo();
                return info.location ? {
                  url: info.location.url,
                  lineNumber: info.location.lineNumber,
                } : undefined;
              })() : undefined);

              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'click',
                selector: rawSelector,
                ...pauseInfo,
              });
            }

            // Collect DOM changes
            let changesText = '';
            let changes: DOMChanges | null = null;
            if (shouldDetectChanges) {
              changes = await domChangeMonitor.stopObserving(connectionReason, { settleTimeout, signal: abortSignal });
              changesText = formatDOMChanges(changes);
            }

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (!result.result || result.result.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              const failed = actionFailureResponse(result, 'click', rawSelector);
              if (failed) return failed;
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Build post-click info string
            const postClick = result.result.postClickState;
            let postClickInfo = '';
            if (postClick?.focusInfo) {
              const f = postClick.focusInfo;
              if (f.isInput) {
                postClickInfo = `\n**Focus:** ${f.tag}${f.type ? `[type="${f.type}"]` : ''} ${f.text ? `"${f.text}"` : ''}`;
              } else if (f.tag !== 'body') {
                postClickInfo = `\n**Focus:** ${f.tag}${f.text ? ` "${f.text}"` : ''}`;
              }
            }
            if (postClick?.prevTabbable?.length > 0) {
              postClickInfo += `\n**Prev tab:** ${postClick.prevTabbable.join(' ← ')}`;
            }
            if (postClick?.nextTabbable?.length > 0) {
              postClickInfo += `\n**Next tab:** ${postClick.nextTabbable.join(' → ')}`;
            }
            if (postClick?.childInteractive?.length > 0) {
              postClickInfo += `\n**Contains:** ${postClick.childInteractive.join(', ')}`;
            }

            // Build _meta for click validation
            const postClickUrl = postClick?.url || page.url();
            const clickMeta: ToolResponseMeta = {
              tool: 'input',
              action: 'click',
              timestamp: Date.now(),
              click: {
                selector: rawSelector,
                preClickUrl,
                postClickUrl,
                navigationOccurred: preClickUrl !== postClickUrl,
                hasClickHandler: result.result.hasClickHandler ?? false,
                domChanges: changes ? {
                  mutationCount: changes.mutationCount,
                  added: changes.added?.length || 0,
                  removed: changes.removed?.length || 0,
                  shown: changes.shown?.length || 0,
                  hidden: changes.hidden?.length || 0,
                } : null,
              },
            };

            // Return success with warning if no click handler detected
            if (result.result.warning) {
              const response = createSuccessResponse('ELEMENT_CLICK_WARNING', { selector: rawSelector, warning: selectorWarning });
              response._meta = clickMeta;
              return response;
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Clicked element \`${rawSelector}\`${changesText}${postClickInfo}\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
                _meta: clickMeta,
              };
            }

            // Default success response with post-click info and changes
            return {
              content: [
                {
                  type: 'text',
                  text: `Clicked element: \`${rawSelector}\`${changesText}${postClickInfo}`,
                },
              ],
              _meta: clickMeta,
            };
          }

          case 'type': {
            const { selector: rawSelector, text, delay = 0, handleModals = false, dismissStrategy = 'auto', append = false } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** type\n\n**Suggestion:** Provide a CSS selector for the input element.`,
                  },
                ],
                isError: true,
              };
            }

            if (!text) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`text\`\n\n**Action:** type\n\n**Suggestion:** Provide text to type into the element.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }
            {
              const ambiguous = await ambiguousSelectorWarning(page, selector, rawSelector);
              if (ambiguous) selectorWarning = selectorWarning ? `${selectorWarning} ${ambiguous}` : ambiguous;
            }
            await checkAborted(); // after selector resolution, before any dispatch

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Check if element exists first
                const element = await page.$(selector);
                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal. Dismissal DISPATCHES too (an Escape
                    // key or a click on the dismiss control), so it needs its
                    // own pre-dispatch checkpoint - not just the one before the
                    // real action below.
                    await checkAborted();
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
                    if (recheckBlocking.blocked) {
                      return {
                        error: `Element still blocked after dismissing modal`,
                        blockingModal: recheckBlocking.blockingModal,
                      };
                    }
                  } else {
                    // Return error with modal information
                    return {
                      error: `Element is blocked by modal`,
                      blockingModal: blockingCheck.blockingModal,
                      suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                    };
                  }
                }

                // Clear existing text first (unless append mode)
                await checkAborted(); // last exit before keystrokes go on the wire
                if (!append) {
                  await withReplayBypass(page, async () => {
                    await clickSelector(page, selector, { clickCount: 3 });
                    await page.keyboard.press('Backspace');
                  });
                  // Abortable between clear and retype: the clear that went
                  // out stays out, but the new text is not dispatched.
                  await checkAborted();
                }
                // Type new text - use wrapper to bypass replay blocker overlay
                await withReplayBypass(page, () => page.type(selector, text, { delay }));

                // Get the actual value after typing
                const currentValue = await page.$eval(selector, (el: unknown) => {
                  const element = el as { value?: string; textContent?: string | null };
                  if ('value' in element && element.value !== undefined) {
                    return element.value;
                  }
                  return element.textContent || '';
                });

                return { selector, text, currentValue };
              },
              'typeText'
            );

            // If paused at breakpoint, return immediately - don't try any more page interactions
            if (result.pausedAtBreakpoint) {
              if (shouldDetectChanges) {
                await domChangeMonitor.stopObserving(connectionReason, { settleTimeout: 0 });
              }
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'type',
                selector: rawSelector,
                ...result.pauseInfo,
              });
            }

            // Collect DOM changes
            let changesText = '';
            if (shouldDetectChanges) {
              const changes = await domChangeMonitor.stopObserving(connectionReason, { settleTimeout, signal: abortSignal });
              changesText = formatDOMChanges(changes);
            }

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (result.result?.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              const failed = actionFailureResponse(result, 'type', rawSelector);
              if (failed) return failed;
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Typed into element \`${rawSelector}\`${changesText}\n\nCurrent value: ${result.result?.currentValue}\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            // Default success response with changes
            return {
              content: [
                {
                  type: 'text',
                  text: `Text typed into \`${rawSelector}\`: "${text}"${changesText}`,
                },
              ],
            };
          }

          case 'press': {
            const { key } = args;

            if (!key) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`key\`\n\n**Action:** press\n\n**Suggestion:** Provide a key name to press (e.g., "Enter", "Tab", "Escape").`,
                  },
                ],
                isError: true,
              };
            }

            // Use wrapper to bypass replay blocker overlay for key press
            await checkAborted(); // last exit before the key press goes on the wire
            await withReplayBypass(page, () =>
              executeWithPauseDetection(
                targetCdpManager,
                () => page.keyboard.press(key as any),
                'pressKey'
              )
            );

            return createSuccessResponse('KEY_PRESS_SUCCESS', {
              key
            });
          }

          case 'hover': {
            const { selector: rawSelector, handleModals = false, dismissStrategy = 'auto' } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** hover\n\n**Suggestion:** Provide a CSS selector for the element to hover over.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }
            {
              const ambiguous = await ambiguousSelectorWarning(page, selector, rawSelector);
              if (ambiguous) selectorWarning = selectorWarning ? `${selectorWarning} ${ambiguous}` : ambiguous;
            }
            await checkAborted(); // after selector resolution, before any dispatch

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Check if element exists first
                const element = await page.$(selector);
                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Check if element is blocked by modal
                const blockingCheck = await isElementBlocked(page, selector);

                if (blockingCheck.blocked && blockingCheck.blockingModal) {
                  if (handleModals) {
                    // Auto-dismiss modal. Dismissal DISPATCHES too (an Escape
                    // key or a click on the dismiss control), so it needs its
                    // own pre-dispatch checkpoint - not just the one before the
                    // real action below.
                    await checkAborted();
                    const dismissResult = await dismissModalHelper(
                      page,
                      blockingCheck.blockingModal.selector,
                      dismissStrategy
                    );

                    // Check if dismissal was successful
                    if (!dismissResult.success) {
                      return {
                        error: `Failed to dismiss blocking modal: ${dismissResult.error || 'Unknown error'}`,
                        blockingModal: blockingCheck.blockingModal,
                      };
                    }

                    // Re-check if element is still blocked
                    const recheckBlocking = await isElementBlocked(page, selector);
                    if (recheckBlocking.blocked) {
                      return {
                        error: `Element still blocked after dismissing modal`,
                        blockingModal: recheckBlocking.blockingModal,
                      };
                    }
                  } else {
                    // Return error with modal information
                    return {
                      error: `Element is blocked by modal`,
                      blockingModal: blockingCheck.blockingModal,
                      suggestion: `Enable handleModals parameter or call dismissModal tool first`,
                    };
                  }
                }

                await checkAborted(); // last exit before the hover goes on the wire
                await withReplayBypass(page, () => hoverSelector(page, selector));
                return { selector };
              },
              'hoverElement'
            );

            // If paused at breakpoint, return immediately - don't try any more page interactions
            if (result.pausedAtBreakpoint) {
              if (shouldDetectChanges) {
                await domChangeMonitor.stopObserving(connectionReason, { settleTimeout: 0 });
              }
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'hover',
                selector: rawSelector,
                ...result.pauseInfo,
              });
            }

            // Collect DOM changes
            let changesText = '';
            if (shouldDetectChanges) {
              const changes = await domChangeMonitor.stopObserving(connectionReason, { settleTimeout, signal: abortSignal });
              changesText = formatDOMChanges(changes);
            }

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            // Check if element was not found
            if (result.result?.error) {
              // Check if error is due to blocking modal
              if (result.result?.blockingModal) {
                return createErrorResponse('ELEMENT_BLOCKED_BY_MODAL', {
                  selector: rawSelector,
                  modalType: result.result.blockingModal.type,
                  modalDescription: result.result.blockingModal.description,
                  modalSelector: result.result.blockingModal.selector,
                  suggestion: result.result.suggestion,
                  availableStrategies: result.result.blockingModal.dismissStrategies,
                });
              }
              const failed = actionFailureResponse(result, 'hover', rawSelector);
              if (failed) return failed;
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Include warning about multiple matches if applicable
            if (selectorWarning) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Hovered over element \`${rawSelector}\`${changesText}\n\n**Warning:** ${selectorWarning}`,
                  },
                ],
              };
            }

            // Default success response with changes
            return {
              content: [
                {
                  type: 'text',
                  text: `Hovered over element: \`${rawSelector}\`${changesText}`,
                },
              ],
            };
          }

          case 'focus': {
            const { selector: rawSelector } = args;

            if (!rawSelector) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`selector\`\n\n**Action:** focus\n\n**Suggestion:** Provide a CSS selector for the element to focus.`,
                  },
                ],
                isError: true,
              };
            }

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(rawSelector)) {
              const resolved = await resolveSelector(page, rawSelector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }
            {
              const ambiguous = await ambiguousSelectorWarning(page, selector, rawSelector);
              if (ambiguous) selectorWarning = selectorWarning ? `${selectorWarning} ${ambiguous}` : ambiguous;
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Check if element exists first
                const element = await page.$(selector);
                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Focus the element
                await checkAborted(); // last exit before the focus is dispatched
                await withReplayBypass(page, () => page.focus(selector));

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);

                return { selector, focusInfo };
              },
              'focus'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            {
              const failed = actionFailureResponse(result, 'focus', rawSelector);
              if (failed) return failed;
            }
            if (result.result?.error) {
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            const focusInfo = result.result?.focusInfo;

            return createSuccessResponse('ELEMENT_FOCUS_SUCCESS', {
              description: focusInfo?.description || 'Unknown element',
              selector: focusInfo?.selector || rawSelector,
              nextTabbable: focusInfo?.nextTabbable?.length ? focusInfo.nextTabbable.join(' → ') : undefined,
              warning: selectorWarning || undefined
            });
          }

          case 'focusNext': {
            const { count = 1 } = args;

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Press Tab count times - use wrapper to bypass replay blocker overlay
                await withReplayBypass(page, async () => {
                  for (let i = 0; i < count; i++) {
                    // Abortable between Tabs: dispatched presses stay
                    // dispatched, but no further ones go out.
                    throwIfAborted(abortSignal);
                    await page.keyboard.press('Tab');
                    // Small delay between tabs for stability
                    if (i < count - 1) {
                      await abortableSleep(50, abortSignal);
                    }
                  }
                });

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);
                return { focusInfo, tabCount: count };
              },
              'focusNext'
            );

            const focusInfo = result.result?.focusInfo;

            return createSuccessResponse('FOCUS_NEXT_SUCCESS', {
              count: count > 1 ? count : undefined,
              description: focusInfo?.description || 'No element focused (may have reached end of page)',
              selector: focusInfo?.selector || 'none',
              nextTabbable: focusInfo?.nextTabbable?.length ? focusInfo.nextTabbable.join(' → ') : undefined
            });
          }

          case 'focusPrevious': {
            const { count = 1 } = args;

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Press Shift+Tab count times - use wrapper to bypass replay blocker overlay
                await withReplayBypass(page, async () => {
                  for (let i = 0; i < count; i++) {
                    // Abortable between Tabs (not mid-chord: Shift down/Tab/
                    // Shift up always complete together so no modifier is
                    // left held down).
                    throwIfAborted(abortSignal);
                    await page.keyboard.down('Shift');
                    await page.keyboard.press('Tab');
                    await page.keyboard.up('Shift');
                    // Small delay between tabs for stability
                    if (i < count - 1) {
                      await abortableSleep(50, abortSignal);
                    }
                  }
                });

                // Get focused element info
                const focusInfo = await getFocusedElementInfo(page);
                return { focusInfo, tabCount: count };
              },
              'focusPrevious'
            );

            const focusInfo = result.result?.focusInfo;

            return createSuccessResponse('FOCUS_PREVIOUS_SUCCESS', {
              count: count > 1 ? count : undefined,
              description: focusInfo?.description || 'No element focused (may have reached start of page)',
              selector: focusInfo?.selector || 'none',
              nextTabbable: focusInfo?.nextTabbable?.length ? focusInfo.nextTabbable.join(' → ') : undefined
            });
          }

          case 'drag': {
            const { from, to, steps = 10 } = args;

            if (!from || !to) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameters: \`from\` and \`to\`\n\n**Action:** drag\n\n**Suggestion:** Provide starting and ending coordinates. Example: from: {x: 100, y: 100}, to: {x: 200, y: 200}`,
                  },
                ],
                isError: true,
              };
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Use wrapper to bypass replay blocker overlay for entire drag operation
                return await withReplayBypass(page, async () => {
                  const mouse = page.mouse;

                  // Abortable before anything is dispatched.
                  throwIfAborted(abortSignal);

                  // Move to start position
                  await mouse.move(from.x, from.y);

                  // Press mouse button
                  await mouse.down();

                  // Calculate intermediate steps for smooth drag
                  const deltaX = (to.x - from.x) / steps;
                  const deltaY = (to.y - from.y) / steps;

                  try {
                    for (let i = 1; i <= steps; i++) {
                      // Abortable between steps: movement already dispatched
                      // stays dispatched, the rest of the drag does not go out.
                      throwIfAborted(abortSignal);
                      const currentX = from.x + deltaX * i;
                      const currentY = from.y + deltaY * i;
                      await mouse.move(currentX, currentY);
                      // Small delay for smoother drag
                      await abortableSleep(10, abortSignal);
                    }
                  } catch (err) {
                    // A cancel mid-drag must not leave the button held down.
                    if (isAbortError(err)) {
                      try { await mouse.up(); } catch { /* best-effort */ }
                    }
                    throw err;
                  }

                  // Release mouse button
                  await mouse.up();

                  return {
                    from,
                    to,
                    steps,
                    distance: Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2)),
                  };
                });
              },
              'drag'
            );

            if (result.pausedAtBreakpoint) {
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'drag',
                ...result.pauseInfo,
              });
            }

            const dragResult = result.result;
            return {
              content: [
                {
                  type: 'text',
                  text: `Dragged from (${dragResult?.from.x}, ${dragResult?.from.y}) to (${dragResult?.to.x}, ${dragResult?.to.y})\n**Distance:** ${dragResult?.distance.toFixed(1)}px over ${dragResult?.steps} steps`,
                },
              ],
            };
          }

          case 'scroll': {
            const { deltaX = 0, deltaY = 0, x, y } = args;

            if (deltaX === 0 && deltaY === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nAt least one of \`deltaX\` or \`deltaY\` must be non-zero\n\n**Action:** scroll\n\n**Suggestion:** Provide scroll amounts. Example: deltaY: 300 (scroll down), deltaY: -300 (scroll up)`,
                  },
                ],
                isError: true,
              };
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Use wrapper to bypass replay blocker overlay for scroll operation
                return await withReplayBypass(page, async () => {
                  const mouse = page.mouse;

                  // Abortable before anything is dispatched.
                  throwIfAborted(abortSignal);

                  // If coordinates provided, move to that position first
                  if (x !== undefined && y !== undefined) {
                    await mouse.move(x, y);
                  }

                  // Perform scroll
                  await mouse.wheel({ deltaX, deltaY });

                  // Get current scroll position
                  const scrollPosition = await page.evaluate(() => ({
                    scrollX: (globalThis as any).window.scrollX,
                    scrollY: (globalThis as any).window.scrollY,
                    maxScrollX: (globalThis as any).document.documentElement.scrollWidth - (globalThis as any).window.innerWidth,
                    maxScrollY: (globalThis as any).document.documentElement.scrollHeight - (globalThis as any).window.innerHeight,
                  }));

                  return {
                    deltaX,
                    deltaY,
                    position: x !== undefined && y !== undefined ? { x, y } : undefined,
                    scrollPosition,
                  };
                });
              },
              'scroll'
            );

            if (result.pausedAtBreakpoint) {
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'scroll',
                ...result.pauseInfo,
              });
            }

            const scrollResult = result.result;
            const directionParts: string[] = [];
            if (deltaY > 0) directionParts.push(`down ${deltaY}px`);
            if (deltaY < 0) directionParts.push(`up ${Math.abs(deltaY)}px`);
            if (deltaX > 0) directionParts.push(`right ${deltaX}px`);
            if (deltaX < 0) directionParts.push(`left ${Math.abs(deltaX)}px`);

            const positionInfo = scrollResult?.position
              ? ` at (${scrollResult.position.x}, ${scrollResult.position.y})`
              : '';

            return {
              content: [
                {
                  type: 'text',
                  text: `Scrolled ${directionParts.join(' and ')}${positionInfo}\n**Page position:** (${scrollResult?.scrollPosition.scrollX}, ${scrollResult?.scrollPosition.scrollY}) of (${scrollResult?.scrollPosition.maxScrollX}, ${scrollResult?.scrollPosition.maxScrollY})`,
                },
              ],
            };
          }

          case 'mousemove': {
            const { x, y } = args;

            if (x === undefined || y === undefined) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameters: \`x\` and \`y\`\n\n**Action:** mousemove\n\n**Suggestion:** Provide coordinates. Example: x: 100, y: 200`,
                  },
                ],
                isError: true,
              };
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Use wrapper to bypass replay blocker overlay for mousemove
                throwIfAborted(abortSignal); // last exit before dispatch
                await withReplayBypass(page, () => page.mouse.move(x, y));

                // Get element at the mouse position
                const elementInfo = await page.evaluate((mouseX: number, mouseY: number) => {
                  const el = (globalThis as any).document.elementFromPoint(mouseX, mouseY);
                  if (!el) return null;

                  const tag = el.tagName.toLowerCase();
                  const text = el.textContent?.trim().substring(0, 30) || '';
                  const id = el.id ? `#${el.id}` : '';
                  const className = el.className && typeof el.className === 'string'
                    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                    : '';

                  return {
                    tag,
                    text: text || undefined,
                    selector: id || className || tag,
                  };
                }, x, y);

                return { x, y, elementInfo };
              },
              'mousemove'
            );

            if (result.pausedAtBreakpoint) {
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'mousemove',
                ...result.pauseInfo,
              });
            }

            const moveResult = result.result;
            const elementDesc = moveResult?.elementInfo
              ? `\n**Element at position:** \`${moveResult.elementInfo.selector}\`${moveResult.elementInfo.text ? ` "${moveResult.elementInfo.text}"` : ''}`
              : '';

            return {
              content: [
                {
                  type: 'text',
                  text: `Mouse moved to (${moveResult?.x}, ${moveResult?.y})${elementDesc}`,
                },
              ],
            };
          }

          case 'tap':
          case 'swipe': {
            // Real touch events. Mouse actions do not produce touchstart/
            // touchmove, so a component that listens only for touch cannot be
            // driven by click or drag at all.
            const isSwipe = args.action === 'swipe';

            let start = isSwipe ? args.from : (typeof args.x === 'number' && typeof args.y === 'number' ? { x: args.x, y: args.y } : undefined);
            // A gesture across an element: its geometry is read now, because a
            // row's coordinates move with whatever is above it and a sequence
            // cannot know them in advance. Without this, gesture-revealed
            // actions get faked with a programmatic click in page JS, which
            // proves nothing about the gesture.
            let selectorEnd: { x: number; y: number } | undefined;
            if ((!isSwipe || args.direction) && !start && args.selector) {
              const rawSelector = args.selector;
              let selector = rawSelector;
              if (isExtendedSelector(selector)) {
                const resolved = await resolveSelector(page, selector);
                if ('error' in resolved) {
                  return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector, suggestion: resolved.suggestion });
                }
                selector = resolved.selector;
              }
              const box = await page.evaluate((sel: string) => {
                const el = (globalThis as any).document.querySelector(sel);
                if (!el) return null;
                el.scrollIntoView({ block: 'center', inline: 'center' });
                const r = el.getBoundingClientRect();
                const doc = (globalThis as any).document.documentElement;
                return {
                  x: r.x + r.width / 2, y: r.y + r.height / 2,
                  width: r.width, height: r.height,
                  viewW: doc.clientWidth, viewH: doc.clientHeight,
                };
              }, selector);
              await cleanupResolvedSelector(page, selector);
              if (!box) return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
              start = { x: box.x, y: box.y };
              if (args.direction) {
                const along = (args.direction === 'left' || args.direction === 'right') ? box.width : box.height;
                // Deliberately short. A swipe-action row has ranges - a nudge
                // peeks, further opens, further still commits the destructive
                // action - and 60% of a wide row lands in the last one. Travel
                // far enough to reveal, and let a caller that WANTS the
                // over-drag ask for it.
                const travel = args.distance ?? Math.min(Math.round(along * 0.6), 96);
                const dx = args.direction === 'left' ? -travel : args.direction === 'right' ? travel : 0;
                const dy = args.direction === 'up' ? -travel : args.direction === 'down' ? travel : 0;
                // Stay on-screen: a gesture ending outside the viewport lands
                // nowhere and reads as an unresponsive component.
                selectorEnd = {
                  x: Math.max(1, Math.min(box.viewW - 1, box.x + dx)),
                  y: Math.max(1, Math.min(box.viewH - 1, box.y + dy)),
                };
              }
            }

            if (!start) {
              return createErrorResponse('INVALID_PARAMETER', {
                parameter: isSwipe ? 'from' : 'selector/x,y',
                value: 'missing',
                message: isSwipe
                  ? 'swipe needs from:{x,y} and to:{x,y}, or selector + direction.'
                  : 'tap needs either a selector or x and y.'
              });
            }
            if (isSwipe && !args.to && !selectorEnd) {
              return createErrorResponse('INVALID_PARAMETER', {
                parameter: 'to',
                value: 'missing',
                message: 'swipe needs to:{x,y}, or direction alongside selector.'
              });
            }

            const end = isSwipe ? (args.to ?? selectorEnd!) : start;
            const steps = Math.max(1, args.steps ?? 10);

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const client = await page.createCDPSession();
                const point = (x: number, y: number) => ({ x: Math.round(x), y: Math.round(y) });
                try {
                  return await withReplayBypass(page, async () => {
                    throwIfAborted(abortSignal);
                    await client.send('Input.dispatchTouchEvent', {
                      type: 'touchStart',
                      touchPoints: [point(start!.x, start!.y)],
                    });
                    if (isSwipe) {
                      // Paced by default. Unpaced, the moves arrive within a few
                      // ms of each other - velocity of several px/ms, which
                      // gesture handlers read as a flick. On a row whose flick
                      // means "commit the destructive action", the safe-looking
                      // call (no timing given, short travel) would fire it.
                      // Distance does not protect against this; only pacing
                      // does.
                      const perStep = (args.durationMs ?? 300) / steps;
                      for (let i = 1; i <= steps; i++) {
                        throwIfAborted(abortSignal);
                        await client.send('Input.dispatchTouchEvent', {
                          type: 'touchMove',
                          touchPoints: [point(
                            start!.x + ((end.x - start!.x) * i) / steps,
                            start!.y + ((end.y - start!.y) * i) / steps
                          )],
                        });
                        if (perStep > 0 && i < steps) await abortableSleep(perStep, abortSignal);
                      }
                    }
                    // touchEnd carries no points: the contact has lifted.
                    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    return { from: point(start!.x, start!.y), to: point(end.x, end.y), steps: isSwipe ? steps : 0 };
                  });
                } finally {
                  await client.detach();
                }
              },
              args.action
            );

            const r = result.result;
            if (!r) {
              return createErrorResponse('INVALID_PARAMETER', {
                parameter: args.action,
                value: 'no result',
                message: `${args.action} dispatched but returned no result — the page may have navigated mid-gesture.`
              });
            }
            return {
              content: [{
                type: 'text',
                text: isSwipe
                  ? `Swiped (touch) from (${r.from.x},${r.from.y}) to (${r.to.x},${r.to.y}) in ${r.steps} steps`
                  : `Tapped (touch) at (${r.from.x},${r.from.y})`,
              }],
            };
          }

          case 'pinch': {
            const { x, y, scaleFactor } = args;

            if (scaleFactor === undefined) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `## Error\n\nMissing required parameter: \`scaleFactor\`\n\n**Action:** pinch\n\n**Suggestion:** Provide a scale factor. Example: scaleFactor: 2.0 (zoom in 2x), scaleFactor: 0.5 (zoom out 50%)`,
                  },
                ],
                isError: true,
              };
            }

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Get viewport center if coordinates not provided
                const viewport = page.viewport();
                const centerX = x ?? (viewport?.width ?? 800) / 2;
                const centerY = y ?? (viewport?.height ?? 600) / 2;

                // Create CDP session for synthesizePinchGesture
                const client = await page.createCDPSession();

                try {
                  // Use wrapper to bypass replay blocker overlay for pinch gesture
                  return await withReplayBypass(page, async () => {
                    // Last exit before the gesture goes on the wire (once
                    // dispatched, the whole synthesized pinch runs in Chrome).
                    throwIfAborted(abortSignal);
                    await client.send('Input.synthesizePinchGesture', {
                      x: centerX,
                      y: centerY,
                      scaleFactor,
                      relativeSpeed: 300, // pixels per second
                      gestureSourceType: 'touch',
                    });

                    return {
                      x: centerX,
                      y: centerY,
                      scaleFactor,
                      action: scaleFactor > 1 ? 'zoom in' : 'zoom out',
                    };
                  });
                } finally {
                  await client.detach();
                }
              },
              'pinch'
            );

            if (result.pausedAtBreakpoint) {
              return createSuccessResponse('ACTION_PAUSED_AT_BREAKPOINT', {
                action: 'pinch',
                ...result.pauseInfo,
              });
            }

            const pinchResult = result.result;
            return {
              content: [
                {
                  type: 'text',
                  text: `Pinch ${pinchResult?.action} at (${pinchResult?.x}, ${pinchResult?.y}) with scale factor ${pinchResult?.scaleFactor}`,
                },
              ],
            };
          }

          default:
            return createErrorResponse('INVALID_ACTION', {
              action,
              validActions: 'click, type, press, hover, focus, focusNext, focusPrevious, drag, scroll, mousemove, pinch'
            });
        }
      }
    ),
  };
}

/**
 * Helper function to get information about the currently focused element
 */
async function getFocusedElementInfo(page: any): Promise<{
  description: string;
  tag: string;
  type?: string;
  text?: string;
  selector?: string;
  prevTabbable: string[];
  nextTabbable: string[];
} | null> {
  return await page.evaluate(() => {
    const focused = (globalThis as any).document.activeElement;
    if (!focused || focused === (globalThis as any).document.body) {
      return null;
    }

    const tag = focused.tagName.toLowerCase();
    const type = focused.getAttribute('type') || undefined;
    const text = focused.textContent?.trim().substring(0, 50) ||
      focused.getAttribute('aria-label') ||
      focused.getAttribute('placeholder') ||
      focused.getAttribute('name') ||
      focused.getAttribute('id') ||
      '';

    // Build a description
    let description = tag;
    if (type) description += `[type="${type}"]`;
    if (text) description += ` "${text}"`;

    // Try to build a useful selector
    let selector: string | undefined;
    if (focused.id) {
      selector = `#${focused.id}`;
    } else if (focused.name) {
      selector = `${tag}[name="${focused.name}"]`;
    } else if (focused.className && typeof focused.className === 'string') {
      const classes = focused.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (classes) selector = `${tag}.${classes}`;
    }

    // Helper to format element for display
    const formatEl = (el: any) => {
      const elTag = el.tagName.toLowerCase();
      const elText = el.textContent?.trim().substring(0, 20) ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        '';
      const elType = el.getAttribute('type');
      if (elTag === 'input') {
        return `${elTag}[${elType || 'text'}]${elText ? ` "${elText}"` : ''}`;
      }
      return `${elTag}${elText ? ` "${elText}"` : ''}`;
    };

    // Get tabbable elements
    const tabbable = Array.from((globalThis as any).document.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el: any) => {
      const style = (globalThis as any).window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const currentIndex = tabbable.indexOf(focused);
    let prevTabbable: string[] = [];
    let nextTabbable: string[] = [];

    if (currentIndex !== -1) {
      // Previous 3 tabbable elements
      prevTabbable = tabbable.slice(Math.max(0, currentIndex - 3), currentIndex).map(formatEl);
      // Next 3 tabbable elements
      nextTabbable = tabbable.slice(currentIndex + 1, currentIndex + 4).map(formatEl);
    }

    return {
      description,
      tag,
      type,
      text: text || undefined,
      selector,
      prevTabbable,
      nextTabbable,
    };
  });
}

/**
 * Helper function to dismiss a modal
 *
 * This is a thin wrapper around the shared dismissal logic from modal-dismissal.ts
 */
async function dismissModalHelper(
  page: any,
  modalSelector: string,
  strategy: 'accept' | 'reject' | 'close' | 'remove' | 'auto'
): Promise<{ success: boolean; error?: string }> {
  // Get modal info to determine strategy
  const modals = await detectModals(page);
  const modal = modals.find(m => m.selector === modalSelector);

  if (!modal) {
    return { success: false, error: 'Modal not found' };
  }

  // Use shared dismissal logic
  const effectiveStrategy = selectDismissalStrategy(modal, strategy);
  const result = await dismissModalByStrategy(page, modal, effectiveStrategy, 3);

  return {
    success: result.success,
    error: result.error,
  };
}
