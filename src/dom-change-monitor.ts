/**
 * DOM Change Monitor
 * Uses MutationObserver to track DOM changes during browser actions
 * Replaces snapshot-based diffing with real-time observation
 */

import { debugLog } from './debug-logger.js';

/**
 * Information about a changed element
 */
export interface ElementChange {
  tag: string;
  selector: string;
  text?: string;
  context?: string;  // nav, main, footer, form, alert
}

/**
 * Text content change
 */
export interface TextChange {
  selector: string;
  before: string;
  after: string;
}

/**
 * Result of DOM change observation
 */
export interface DOMChanges {
  added: ElementChange[];      // Elements added to DOM
  removed: ElementChange[];    // Elements removed from DOM
  shown: ElementChange[];      // Elements that became visible
  hidden: ElementChange[];     // Elements that became hidden
  textChanged: TextChange[];   // Text content changes
  settled: boolean;            // True if mutations stopped naturally
  duration: number;            // Time until settled or timeout
  mutationCount: number;       // Total mutations observed
}

/**
 * Configuration for change detection
 */
export interface ChangeDetectionConfig {
  enabled: boolean;           // Master switch
  settleTimeout: number;      // Max wait for mutations (default: 2000ms)
  quietPeriod: number;        // No-mutation period to consider settled (default: 300ms)
  navigationTimeout: number;  // Longer timeout for page loads (default: 3000ms)
}

export const DEFAULT_CHANGE_DETECTION_CONFIG: ChangeDetectionConfig = {
  enabled: true,
  settleTimeout: 2000,
  quietPeriod: 300,
  navigationTimeout: 3000,
};

/**
 * Session tracking for active observers
 */
interface ObserverSession {
  startTime: number;
  page: any;
}

/**
 * DOM Change Monitor
 * Manages MutationObserver injection and result collection
 */
export class DOMChangeMonitor {
  private sessions = new Map<string, ObserverSession>();

  /**
   * Start observing DOM changes before an action
   */
  async startObserving(connectionRef: string, page: any): Promise<void> {
    // Stop any existing session for this connection
    if (this.sessions.has(connectionRef)) {
      await this.cleanup(connectionRef);
    }

    try {
      // Inject MutationObserver into page. One left by a session that was
      // dropped while the page was paused is still attached, so it is
      // disconnected first rather than left recording beside the new one.
      await page.evaluate(() => {
        // @ts-ignore - runs in browser context
        window.__cdpChangeObserver?.observer?.disconnect();
        // @ts-ignore - runs in browser context
        window.__cdpChangeObserver = {
          startTime: Date.now(),
          mutations: [],
          addedNodes: [],
          removedNodes: [],
          visibilityChanges: [],
          textChanges: [],
          lastMutationTime: Date.now(),

          // Helper to get selector for element
          // @ts-ignore - runs in browser context
          getSelector(el: any): string {
            if (el.id) return `#${el.id}`;
            if (el.getAttribute?.('name')) return `[name="${el.getAttribute('name')}"]`;

            const tag = el.tagName?.toLowerCase() || 'unknown';
            const text = el.textContent?.trim()?.substring(0, 30);
            if (text && text.length > 0) {
              return `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
            }

            const className = el.className;
            if (className && typeof className === 'string') {
              const classes = className.split(' ').filter((c: string) => c.length > 0 && c.length <= 20);
              if (classes.length > 0) {
                return `${tag}.${classes.slice(0, 2).join('.')}`;
              }
            }

            return tag;
          },

          // Helper to get semantic context
          // @ts-ignore - runs in browser context
          getContext(el: any): string {
            let parent = el.parentElement;
            while (parent) {
              const tag = parent.tagName?.toLowerCase();
              if (tag === 'nav') return 'nav';
              if (tag === 'main') return 'main';
              if (tag === 'footer') return 'footer';
              if (tag === 'header') return 'header';
              if (tag === 'form') return 'form';
              if (parent.getAttribute?.('role') === 'alert') return 'alert';
              if (parent.className?.includes?.('alert')) return 'alert';
              parent = parent.parentElement;
            }
            return 'main';
          },

          // Helper to check if element is interactive
          // @ts-ignore - runs in browser context
          isInteractive(el: any): boolean {
            const tag = el.tagName?.toLowerCase();
            if (!tag) return false;
            if (['button', 'a', 'input', 'select', 'textarea'].includes(tag)) return true;
            if (el.getAttribute?.('role') === 'button') return true;
            if (el.getAttribute?.('onclick')) return true;
            return false;
          },

          // Helper to serialize element info
          // @ts-ignore - runs in browser context
          serializeElement(el: any): { tag: string; selector: string; text?: string; context?: string } | null {
            if (!el || !el.tagName) return null;
            const tag = el.tagName.toLowerCase();
            // Skip script, style, meta elements
            if (['script', 'style', 'meta', 'link', 'noscript'].includes(tag)) return null;

            return {
              tag,
              selector: this.getSelector(el),
              text: el.textContent?.trim()?.substring(0, 50) || undefined,
              context: this.getContext(el),
            };
          },

          // Check if element was hidden and is now visible (or vice versa)
          // @ts-ignore - runs in browser context
          checkVisibilityChange(el: any, oldValue: string | null, attrName: string): 'shown' | 'hidden' | null {
            // @ts-ignore
            const style = window.getComputedStyle(el);
            const isVisible = style.display !== 'none' &&
                              style.visibility !== 'hidden' &&
                              parseFloat(style.opacity) > 0;

            // Check if this was a visibility-related change
            if (attrName === 'style' || attrName === 'class' || attrName === 'hidden') {
              // Rough check: if old value suggested hidden and now visible
              if (oldValue?.includes('display: none') || oldValue?.includes('visibility: hidden') || oldValue?.includes('opacity: 0')) {
                if (isVisible) return 'shown';
              }
              // If hidden attribute was removed
              if (attrName === 'hidden' && oldValue !== null && !el.hasAttribute('hidden')) {
                return 'shown';
              }
              if (attrName === 'hidden' && oldValue === null && el.hasAttribute('hidden')) {
                return 'hidden';
              }
            }
            return null;
          },

          start() {
            // @ts-ignore
            this.observer = new MutationObserver((mutations) => {
              this.lastMutationTime = Date.now();

              for (const mutation of mutations) {
                this.mutations.push({
                  type: mutation.type,
                  time: Date.now() - this.startTime,
                });

                // Helper to recursively find interactive elements in a node tree
                const findInteractiveInTree = (node: any, results: any[]) => {
                  if (!node || node.nodeType !== 1) return;
                  // Check this node
                  if (this.isInteractive(node)) {
                    const info = this.serializeElement(node);
                    if (info) results.push(info);
                  }
                  // Recursively check children
                  if (node.children) {
                    for (const child of node.children) {
                      findInteractiveInTree(child, results);
                    }
                  }
                };

                // Track added nodes (including interactive children)
                if (mutation.addedNodes.length > 0) {
                  mutation.addedNodes.forEach((node: any) => {
                    findInteractiveInTree(node, this.addedNodes);
                  });
                }

                // Track removed nodes (including interactive children)
                if (mutation.removedNodes.length > 0) {
                  mutation.removedNodes.forEach((node: any) => {
                    findInteractiveInTree(node, this.removedNodes);
                  });
                }

                // Track attribute changes (visibility)
                if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
                  const el = mutation.target as any;
                  const attrName = mutation.attributeName || '';
                  if (['style', 'class', 'hidden', 'aria-hidden'].includes(attrName)) {
                    const change = this.checkVisibilityChange(el, mutation.oldValue, attrName);
                    if (change && this.isInteractive(el)) {
                      const info = this.serializeElement(el);
                      if (info) {
                        this.visibilityChanges.push({ ...info, change });
                      }
                    }
                  }
                }

                // Track text changes
                if (mutation.type === 'characterData' && mutation.target.parentElement) {
                  const parent = mutation.target.parentElement;
                  if (this.isInteractive(parent)) {
                    this.textChanges.push({
                      selector: this.getSelector(parent),
                      before: (mutation.oldValue || '').substring(0, 50),
                      after: (mutation.target.textContent || '').substring(0, 50),
                    });
                  }
                }
              }
            });

            // @ts-ignore
            this.observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeOldValue: true,
              attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'disabled'],
              characterData: true,
              characterDataOldValue: true,
            });
          },

          stop() {
            // @ts-ignore
            if (this.observer) {
              // @ts-ignore
              this.observer.disconnect();
            }
            return {
              mutationCount: this.mutations.length,
              added: this.addedNodes,
              removed: this.removedNodes,
              visibilityChanges: this.visibilityChanges,
              textChanges: this.textChanges,
              lastMutationTime: this.lastMutationTime,
            };
          },
        };

        // @ts-ignore
        window.__cdpChangeObserver.start();
      });

      this.sessions.set(connectionRef, {
        startTime: Date.now(),
        page,
      });

      await debugLog('DOMChangeMonitor', `Started observing for ${connectionRef}`);
    } catch (err) {
      await debugLog('DOMChangeMonitor', `Failed to start observer: ${err}`);
      // Don't throw - we want actions to succeed even if observation fails
    }
  }

  /**
   * Stop observing and collect results
   * Waits for mutations to settle before collecting
   */
  async stopObserving(
    connectionRef: string,
    options: {
      settleTimeout?: number;
      quietPeriod?: number;
      /** Optional cancellation (#110): aborting ends the settle WAIT early
       *  (reported as settled: false) - results observed so far are still
       *  collected and the observer is still cleaned up. It never throws:
       *  the action's dispatches already happened, so callers report what
       *  was seen and stop promptly. */
      signal?: AbortSignal;
    } = {}
  ): Promise<DOMChanges | null> {
    const session = this.sessions.get(connectionRef);
    if (!session) {
      return null;
    }

    const settleTimeout = options.settleTimeout ?? DEFAULT_CHANGE_DETECTION_CONFIG.settleTimeout;
    const quietPeriod = options.quietPeriod ?? DEFAULT_CHANGE_DETECTION_CONFIG.quietPeriod;
    const { page, startTime } = session;

    try {
      // Wait for mutations to settle
      const settleResult = await this.waitForSettle(page, settleTimeout, quietPeriod, options.signal);

      // Collect results
      const rawResults = await page.evaluate(() => {
        // @ts-ignore
        if (window.__cdpChangeObserver) {
          // @ts-ignore
          return window.__cdpChangeObserver.stop();
        }
        return null;
      });

      if (!rawResults) {
        return null;
      }

      // Process visibility changes into shown/hidden
      const shown: ElementChange[] = [];
      const hidden: ElementChange[] = [];
      for (const change of rawResults.visibilityChanges) {
        const info: ElementChange = {
          tag: change.tag,
          selector: change.selector,
          text: change.text,
          context: change.context,
        };
        if (change.change === 'shown') {
          shown.push(info);
        } else if (change.change === 'hidden') {
          hidden.push(info);
        }
      }

      const result: DOMChanges = {
        added: rawResults.added,
        removed: rawResults.removed,
        shown,
        hidden,
        textChanged: rawResults.textChanges,
        settled: settleResult.settled,
        duration: Date.now() - startTime,
        mutationCount: rawResults.mutationCount,
      };

      await debugLog('DOMChangeMonitor',
        `Stopped observing for ${connectionRef}: ${result.mutationCount} mutations, ` +
        `${result.added.length} added, ${result.removed.length} removed, ` +
        `${result.shown.length} shown, ${result.hidden.length} hidden`
      );

      return result;
    } catch (err) {
      await debugLog('DOMChangeMonitor', `Failed to stop observer: ${err}`);
      return null;
    } finally {
      this.sessions.delete(connectionRef);
      // Cleanup browser-side observer
      await this.cleanup(connectionRef).catch(() => {});
    }
  }

  /**
   * Wait for mutations to settle (no new mutations for quietPeriod)
   */
  private async waitForSettle(
    page: any,
    timeout: number,
    quietPeriod: number,
    signal?: AbortSignal
  ): Promise<{ settled: boolean; waitTime: number }> {
    const startTime = Date.now();
    const checkInterval = 50; // Check every 50ms

    while (Date.now() - startTime < timeout) {
      // Cancelled: stop waiting for quiet - report unsettled with whatever
      // was observed so far.
      if (signal?.aborted) {
        return { settled: false, waitTime: Date.now() - startTime };
      }
      const timeSinceLastMutation = await page.evaluate(() => {
        // @ts-ignore
        if (window.__cdpChangeObserver) {
          // @ts-ignore
          return Date.now() - window.__cdpChangeObserver.lastMutationTime;
        }
        return Infinity;
      });

      if (timeSinceLastMutation >= quietPeriod) {
        return { settled: true, waitTime: Date.now() - startTime };
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    return { settled: false, waitTime: timeout };
  }

  /**
   * Cleanup browser-side observer
   */
  private async cleanup(connectionRef: string): Promise<void> {
    const session = this.sessions.get(connectionRef);
    if (!session) return;

    try {
      await session.page.evaluate(() => {
        // @ts-ignore
        if (window.__cdpChangeObserver?.observer) {
          // @ts-ignore
          window.__cdpChangeObserver.observer.disconnect();
        }
        // @ts-ignore
        delete window.__cdpChangeObserver;
      });
    } catch {
      // Ignore cleanup errors (page may have navigated)
    }
    this.sessions.delete(connectionRef);
  }

  /**
   * Forget a connection's session without touching the page.
   *
   * Collecting or removing the observer runs page JS, and a page held at a
   * breakpoint never answers it, so an action that paused would wait there
   * until something resumed the page. The observer stays in the page until
   * the next startObserving disconnects it.
   */
  drop(connectionRef: string): void {
    this.sessions.delete(connectionRef);
  }

  /**
   * Check if currently observing for a connection
   */
  isObserving(connectionRef: string): boolean {
    return this.sessions.has(connectionRef);
  }

  /**
   * Clear all sessions (for shutdown)
   */
  async clearAll(): Promise<void> {
    for (const connectionRef of this.sessions.keys()) {
      await this.cleanup(connectionRef);
    }
  }
}

// Singleton instance
export const domChangeMonitor = new DOMChangeMonitor();

/**
 * Format DOM changes for display in action response
 */
export function formatDOMChanges(changes: DOMChanges | null): string {
  if (!changes) return '';

  const hasChanges = changes.added.length > 0 ||
                     changes.removed.length > 0 ||
                     changes.shown.length > 0 ||
                     changes.hidden.length > 0 ||
                     changes.textChanged.length > 0;

  if (!hasChanges) return '';

  const lines: string[] = [];
  const settleStatus = changes.settled ? `${changes.duration}ms` : `timeout ${changes.duration}ms`;

  // Summary line
  const parts: string[] = [];
  if (changes.added.length > 0) parts.push(`+${changes.added.length}`);
  if (changes.removed.length > 0) parts.push(`-${changes.removed.length}`);
  if (changes.shown.length > 0) parts.push(`${changes.shown.length} shown`);
  if (changes.hidden.length > 0) parts.push(`${changes.hidden.length} hidden`);
  if (changes.textChanged.length > 0) parts.push(`${changes.textChanged.length} text`);

  lines.push(`**Changes (${settleStatus}):** ${parts.join(', ')}`);

  // Group by context for details
  const byContext = new Map<string, string[]>();

  const addToContext = (items: ElementChange[], prefix: string) => {
    for (const item of items.slice(0, 3)) { // Limit to 3 per category
      const ctx = item.context || 'main';
      if (!byContext.has(ctx)) byContext.set(ctx, []);
      const text = item.text ? `: ${item.text.substring(0, 30)}` : '';
      byContext.get(ctx)!.push(`${prefix}${item.tag}${text}`);
    }
  };

  addToContext(changes.added, '+');
  addToContext(changes.shown, '→');
  addToContext(changes.removed, '-');
  addToContext(changes.hidden, '←');

  // Format context groups
  for (const [ctx, items] of byContext) {
    if (items.length > 0) {
      lines.push(`  ${ctx}: ${items.join(', ')}`);
    }
  }

  // Text changes
  if (changes.textChanged.length > 0) {
    const tc = changes.textChanged[0];
    lines.push(`  text: "${tc.before}" → "${tc.after}"`);
  }

  return '\n\n' + lines.join('\n');
}
