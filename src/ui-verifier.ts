/**
 * UI Verifier - CDP-based deterministic UI verification
 *
 * Uses Chrome DevTools Protocol directly for accurate, deterministic checks:
 * - DOMDebugger.getEventListeners: Detect buttons/elements without click handlers
 * - DOM.getBoxModel: Get exact element positions and dimensions
 * - Page.getLayoutMetrics: Get viewport and content size
 * - CSS.getComputedStyleForNode: Get computed styles for overflow detection
 * - DOM.getNodeForLocation: Check what's actually clickable at a point
 */

import type { Page, CDPSession } from 'puppeteer-core';
import { ownScript } from './utils/own-script.js';

// Types for verification results
export interface UIIssue {
  type: UIIssueType;
  severity: 'error' | 'warning' | 'info';
  selector: string;
  text?: string;
  details: Record<string, any>;
  recommendation: string;
}

export type UIIssueType =
  | 'no-click-handler'
  | 'outside-viewport'
  | 'partially-outside-viewport'
  | 'small-touch-target'
  | 'overflow-clipping'
  | 'not-clickable'
  | 'dead-link'
  | 'horizontal-scroll';

export interface ViewportMetrics {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  contentWidth: number;
  contentHeight: number;
}

export interface VerifyOptions {
  checks?: UICheckType[];
  minTouchTargetSize?: number;
}

export type UICheckType =
  | 'handlers'     // Dead buttons (DOMDebugger.getEventListeners)
  | 'viewport'     // Elements outside viewport
  | 'touch'        // Touch target size
  | 'overflow'     // Overflow clipping
  | 'clickability' // Z-index blocking (expensive)
  | 'links'        // Dead links
  | 'scroll';      // Horizontal scroll

export interface VerifyResult {
  issues: UIIssue[];
  viewport: ViewportMetrics;
  scannedElements: number;
  timestamp: number;
  checksPerformed: UICheckType[];
}

// Default checks (clickability and touch are expensive/noisy, disabled by default)
const DEFAULT_CHECKS: UICheckType[] = ['handlers', 'viewport', 'overflow', 'links', 'scroll'];

// Click event types that indicate an element is interactive
const CLICK_EVENT_TYPES = ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup'];

// Minimum touch target size per WCAG 2.2
const DEFAULT_MIN_TOUCH_TARGET = 44;

export class UIVerifier {
  private page: Page;
  private cdpSession: CDPSession | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Run UI verification with specified checks
   */
  async verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    const checks = options.checks || DEFAULT_CHECKS;
    const minTouchTargetSize = options.minTouchTargetSize || DEFAULT_MIN_TOUCH_TARGET;

    // Create CDP session for direct protocol access
    this.cdpSession = await this.page.target().createCDPSession();

    try {
      const issues: UIIssue[] = [];

      // Get viewport metrics first
      const viewport = await this.getViewportMetrics();

      // Check for horizontal scroll (page-level)
      if (checks.includes('scroll')) {
        if (viewport.contentWidth > viewport.width) {
          issues.push({
            type: 'horizontal-scroll',
            severity: 'info',
            selector: 'document',
            details: {
              contentWidth: viewport.contentWidth,
              viewportWidth: viewport.width,
              overflow: viewport.contentWidth - viewport.width,
            },
            recommendation: 'Page has horizontal scroll - may indicate layout issue or intentional design',
          });
        }
      }

      // Get all interactive elements
      const interactives = await this.findInteractiveElements();

      // Run checks on each element
      for (const element of interactives) {
        // Check 1: Event listeners (dead buttons)
        if (checks.includes('handlers')) {
          const hasHandler = await this.checkEventListeners(element.objectId, element.tagName);
          if (!hasHandler && this.shouldHaveHandler(element)) {
            issues.push({
              type: 'no-click-handler',
              severity: 'error',
              selector: element.selector,
              text: element.text,
              details: {
                tagName: element.tagName,
                eventListeners: [],
              },
              recommendation: 'This element looks interactive but has no click/touch event handlers attached',
            });
          }
        }

        // Check 2: Viewport position
        if (checks.includes('viewport') && element.box) {
          const position = this.checkViewportPosition(element.box, viewport);
          if (position === 'outside') {
            issues.push({
              type: 'outside-viewport',
              severity: 'info',
              selector: element.selector,
              text: element.text,
              details: {
                x: element.box.x,
                y: element.box.y,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
              },
              recommendation: 'Element is outside visible area - user must scroll to interact',
            });
          } else if (position === 'partial') {
            issues.push({
              type: 'partially-outside-viewport',
              severity: 'warning',
              selector: element.selector,
              text: element.text,
              details: {
                x: element.box.x,
                y: element.box.y,
                width: element.box.width,
                height: element.box.height,
              },
              recommendation: 'Element is partially clipped by viewport edge',
            });
          }
        }

        // Check 3: Touch target size
        if (checks.includes('touch') && element.box) {
          if (element.box.width < minTouchTargetSize || element.box.height < minTouchTargetSize) {
            issues.push({
              type: 'small-touch-target',
              severity: 'warning',
              selector: element.selector,
              text: element.text,
              details: {
                width: Math.round(element.box.width),
                height: Math.round(element.box.height),
                minimum: minTouchTargetSize,
              },
              recommendation: `Touch target should be at least ${minTouchTargetSize}x${minTouchTargetSize}px (WCAG 2.2)`,
            });
          }
        }

        // Check 4: Dead links
        if (checks.includes('links') && element.tagName === 'A') {
          const href = element.attributes?.href;
          if (this.isDeadLink(href)) {
            issues.push({
              type: 'dead-link',
              severity: 'warning',
              selector: element.selector,
              text: element.text,
              details: {
                href: href || '(empty)',
              },
              recommendation: 'Link has no valid destination',
            });
          }
        }

        // Check 5: Clickability (z-index blocking) - expensive
        if (checks.includes('clickability') && element.box && element.nodeId) {
          const isClickable = await this.checkClickability(element.nodeId, element.box);
          if (!isClickable) {
            issues.push({
              type: 'not-clickable',
              severity: 'error',
              selector: element.selector,
              text: element.text,
              details: {
                reason: 'Another element is blocking this element',
              },
              recommendation: 'Element is covered by another element - check z-index and positioning',
            });
          }
        }
      }

      // Check 6: Overflow clipping (on all elements, not just interactive)
      if (checks.includes('overflow')) {
        const overflowIssues = await this.checkOverflowClipping();
        issues.push(...overflowIssues);
      }

      return {
        issues,
        viewport,
        scannedElements: interactives.length,
        timestamp: Date.now(),
        checksPerformed: checks,
      };
    } finally {
      // Clean up CDP session
      if (this.cdpSession) {
        await this.cdpSession.detach().catch(() => {});
        this.cdpSession = null;
      }
    }
  }

  /**
   * Get viewport and content metrics using Page.getLayoutMetrics
   */
  private async getViewportMetrics(): Promise<ViewportMetrics> {
    const metrics = await this.cdpSession!.send('Page.getLayoutMetrics');

    return {
      width: metrics.layoutViewport.clientWidth,
      height: metrics.layoutViewport.clientHeight,
      scrollX: metrics.layoutViewport.pageX,
      scrollY: metrics.layoutViewport.pageY,
      contentWidth: metrics.contentSize.width,
      contentHeight: metrics.contentSize.height,
    };
  }

  /**
   * Find all interactive elements and get their properties
   */
  private async findInteractiveElements(): Promise<InteractiveElement[]> {
    // Get all interactive elements with their properties in one evaluate
    // @ts-ignore - This code runs in browser context
    const elements = await this.page.evaluate(() => {
      const interactiveSelectors = [
        'button',
        'a',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
        '[onclick]',
        '[data-click]',
      ];

      const elements: any[] = [];
      // @ts-ignore
      const seen = new Set();

      for (const selectorStr of interactiveSelectors) {
        // @ts-ignore
        document.querySelectorAll(selectorStr).forEach((el: any) => {
          if (seen.has(el)) return;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;

          // Skip invisible elements
          if (!isVisible) return;

          // Get attributes
          const attributes: Record<string, string> = {};
          for (const attr of Array.from(el.attributes) as any[]) {
            attributes[attr.name] = attr.value;
          }

          // Generate a unique selector
          let uniqueSelector = '';
          if (el.id) {
            uniqueSelector = `#${el.id}`;
          } else if (attributes['data-testid']) {
            uniqueSelector = `[data-testid="${attributes['data-testid']}"]`;
          } else if (attributes['aria-label']) {
            uniqueSelector = `[aria-label="${attributes['aria-label']}"]`;
          } else {
            const tag = el.tagName.toLowerCase();
            const text = (el.textContent || '').trim().substring(0, 30);
            if (text) {
              uniqueSelector = `${tag}:has-text("${text}")`;
            } else {
              uniqueSelector = tag;
            }
          }

          elements.push({
            tagName: el.tagName,
            text: (el.textContent || '').trim().substring(0, 100),
            selector: uniqueSelector,
            attributes,
            box: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          });
        });
      }

      return elements;
    });

    // Now get objectId for each element for CDP calls
    const results: InteractiveElement[] = [];

    for (const el of elements) {
      try {
        // Get element handle and objectId via Runtime.evaluate
        const result = await this.cdpSession!.send('Runtime.evaluate', {
          expression: ownScript('ui-verify', `document.querySelector('${el.selector.replace(/'/g, "\\'")}')`),
          objectGroup: 'ui-verify',
        });

        if (result.result.objectId) {
          // Also get nodeId for clickability check
          const { node } = await this.cdpSession!.send('DOM.describeNode', {
            objectId: result.result.objectId,
          });

          results.push({
            ...el,
            objectId: result.result.objectId,
            nodeId: node.nodeId,
          });
        } else {
          results.push(el);
        }
      } catch {
        // Element might not be found, skip
        results.push(el);
      }
    }

    // Clean up object group
    await this.cdpSession!.send('Runtime.releaseObjectGroup', { objectGroup: 'ui-verify' }).catch(() => {});

    return results;
  }

  /**
   * Check if an element has click/touch event handlers using DOMDebugger.getEventListeners
   */
  private async checkEventListeners(objectId: string | undefined, tagName: string): Promise<boolean> {
    if (!objectId) return true; // Can't check, assume it has handlers

    try {
      const result = await this.cdpSession!.send('DOMDebugger.getEventListeners', {
        objectId,
        depth: 1,
        pierce: true, // Include shadow DOM
      });

      const listeners = result.listeners || [];

      // Check if any listener is a click-type event
      return listeners.some((l: any) => CLICK_EVENT_TYPES.includes(l.type));
    } catch {
      // If we can't get listeners, assume it has them (fail safe)
      return true;
    }
  }

  /**
   * Determine if an element should have a click handler based on its type
   */
  private shouldHaveHandler(element: InteractiveElement): boolean {
    const { tagName, attributes } = element;

    // Buttons should always have handlers unless they're submit buttons in a form
    if (tagName === 'BUTTON') {
      const type = attributes?.type?.toLowerCase();
      // Submit and reset buttons work without JS handlers
      if (type === 'submit' || type === 'reset') return false;
      return true;
    }

    // Links with valid href don't need handlers
    if (tagName === 'A') {
      const href = attributes?.href;
      if (href && !this.isDeadLink(href)) return false;
      return true;
    }

    // Elements with role="button" should have handlers
    if (attributes?.role === 'button') return true;

    // Elements with onclick attribute already have handlers (checked via attribute)
    if (attributes?.onclick) return false;

    // Input types that need handlers
    if (tagName === 'INPUT') {
      const type = attributes?.type?.toLowerCase() || 'text';
      // These work without JS handlers
      if (['submit', 'reset', 'text', 'password', 'email', 'number', 'tel', 'url', 'search', 'checkbox', 'radio'].includes(type)) {
        return false;
      }
      return true;
    }

    // Select, textarea work without handlers
    if (tagName === 'SELECT' || tagName === 'TEXTAREA') return false;

    return false;
  }

  /**
   * Check if a link href is "dead" (empty, #, javascript:void)
   */
  private isDeadLink(href: string | undefined): boolean {
    if (!href) return true;
    const trimmed = href.trim();
    if (trimmed === '') return true;
    if (trimmed === '#') return true;
    if (trimmed.startsWith('javascript:void')) return true;
    if (trimmed === 'javascript:;') return true;
    if (trimmed === 'javascript:') return true;
    return false;
  }

  /**
   * Check element position relative to viewport
   */
  private checkViewportPosition(
    box: { x: number; y: number; width: number; height: number },
    viewport: ViewportMetrics
  ): 'visible' | 'partial' | 'outside' {
    const right = box.x + box.width;
    const bottom = box.y + box.height;

    // Fully outside viewport
    if (right < 0 || box.x > viewport.width || bottom < 0 || box.y > viewport.height) {
      return 'outside';
    }

    // Partially outside
    if (box.x < 0 || box.y < 0 || right > viewport.width || bottom > viewport.height) {
      return 'partial';
    }

    return 'visible';
  }

  /**
   * Check if an element is actually clickable at its center point
   * Uses DOM.getNodeForLocation to see what's at that position
   */
  private async checkClickability(
    nodeId: number,
    box: { x: number; y: number; width: number; height: number }
  ): Promise<boolean> {
    try {
      const centerX = Math.round(box.x + box.width / 2);
      const centerY = Math.round(box.y + box.height / 2);

      const result = await this.cdpSession!.send('DOM.getNodeForLocation', {
        x: centerX,
        y: centerY,
        includeUserAgentShadowDOM: false,
      });

      // Check if the node at this location is the same as our element
      // or if our element is an ancestor of the node at this location
      if (!result.nodeId) return true; // Can't determine, assume clickable
      if (result.nodeId === nodeId) return true;

      // Check if our node is an ancestor
      return await this.isAncestor(nodeId, result.nodeId);
    } catch {
      // If we can't check, assume it's clickable
      return true;
    }
  }

  /**
   * Check if nodeId is an ancestor of childNodeId
   */
  private async isAncestor(ancestorNodeId: number, childNodeId: number): Promise<boolean> {
    try {
      let currentId = childNodeId;
      const maxDepth = 20; // Prevent infinite loops

      for (let i = 0; i < maxDepth; i++) {
        const { node } = await this.cdpSession!.send('DOM.describeNode', {
          nodeId: currentId,
        });

        if (!node.parentId) return false;
        if (node.parentId === ancestorNodeId) return true;
        currentId = node.parentId;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check for overflow on all elements
   * Reports ALL overflow with context about how it's handled
   */
  private async checkOverflowClipping(): Promise<UIIssue[]> {
    const issues: UIIssue[] = [];

    const overflowElements = await this.page.evaluate(() => {
      const results: any[] = [];
      const TOLERANCE = 5; // Rounding tolerance

      // Check all elements - the check is fast (just property reads)
      // @ts-ignore - browser context
      document.querySelectorAll('*').forEach((el: any) => {
        // Skip elements with no dimensions
        if (!el.clientWidth && !el.clientHeight) return;

        const scrollW = el.scrollWidth;
        const clientW = el.clientWidth;
        const scrollH = el.scrollHeight;
        const clientH = el.clientHeight;

        // Check if content exceeds container
        const overflowsX = scrollW > clientW + TOLERANCE;
        const overflowsY = scrollH > clientH + TOLERANCE;

        if (!overflowsX && !overflowsY) return;

        // Get computed overflow style
        // @ts-ignore - browser context
        const style = window.getComputedStyle(el);

        // Generate selector - prefer stable attributes
        let selector = '';
        const testId = el.getAttribute('data-testid');
        const id = el.id;

        if (testId) {
          selector = `[data-testid="${testId}"]`;
        } else if (id && !id.includes(':') && !id.includes('__')) {
          selector = `#${id}`;
        } else {
          const tag = el.tagName.toLowerCase();
          const cls = Array.from(el.classList as any[])
            .find((c: any) => !c.includes('__') && !c.includes(':') && c.length > 2);
          selector = cls ? `${tag}.${cls}` : tag;
        }

        results.push({
          selector,
          overflowX: overflowsX ? scrollW - clientW : 0,
          overflowY: overflowsY ? scrollH - clientH : 0,
          styleX: style.overflowX,
          styleY: style.overflowY,
        });
      });

      return results;
    });

    for (const el of overflowElements) {
      const direction = el.overflowX && el.overflowY ? 'both' :
                        el.overflowX ? 'horizontal' : 'vertical';
      const pixels = direction === 'horizontal' ? el.overflowX : el.overflowY;
      const style = direction === 'horizontal' ? el.styleX : el.styleY;

      // Determine severity based on whether content is reachable
      const isClipped = style === 'hidden' || style === 'clip';
      const isScrollable = style === 'auto' || style === 'scroll';

      let message: string;
      let severity: 'error' | 'warning' | 'info';

      if (isClipped) {
        severity = 'warning';
        message = `${pixels}px clipped and unreachable (overflow:${style}) - intentional?`;
      } else if (isScrollable) {
        severity = 'info';
        message = `${pixels}px scrollable content (overflow:${style})`;
      } else {
        // visible or other
        severity = 'info';
        message = `${pixels}px overflows container bounds (overflow:${style}) - intentional?`;
      }

      issues.push({
        type: 'overflow-clipping',
        severity,
        selector: el.selector,
        details: {
          direction,
          overflowPixelsX: el.overflowX,
          overflowPixelsY: el.overflowY,
          overflowStyleX: el.styleX,
          overflowStyleY: el.styleY,
        },
        recommendation: message,
      });
    }

    return issues;
  }
}

// Internal type for element tracking
interface InteractiveElement {
  tagName: string;
  text: string;
  selector: string;
  attributes?: Record<string, string>;
  box?: { x: number; y: number; width: number; height: number };
  objectId?: string;
  nodeId?: number;
}
