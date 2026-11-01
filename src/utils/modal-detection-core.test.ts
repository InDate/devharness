// @vitest-environment happy-dom
/**
 * Unit tests for core modal detection logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isBasicVisible,
  isBlockingPosition,
  hasMinimumZIndex,
  coversMinimumViewport,
  isVisibleOnTop,
  isElementBlockingViewport,
  classifyModal,
  getDismissStrategies,
  getUniqueSelector,
  MODAL_PATTERNS,
} from './modal-detection-core.js';

// setupMockGlobals() below replaces globalThis.document with a stub, so the
// real happy-dom document is taken at module scope, before any test runs.
const domDocument = (globalThis as any).document;

// Mock DOM environment
class MockElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: MockElement[];
  parentElement: MockElement | null;
  _boundingRect: any;

  constructor(tag: string, attrs: Record<string, any> = {}) {
    this.tagName = tag.toUpperCase();
    this.id = attrs.id || '';
    this.className = attrs.className || '';
    this.textContent = attrs.textContent || '';
    this.style = attrs.style || {};
    this.children = [];
    this.parentElement = null;
    this._boundingRect = attrs.boundingRect || { left: 0, top: 0, width: 100, height: 100 };
  }

  getAttribute(name: string) {
    return (this as any)[name] || null;
  }

  matches(selector: string) {
    // Simple selector matching for testing
    if (selector.startsWith('#')) {
      return this.id === selector.slice(1);
    }
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.className.split(/\s+/).includes(className);
    }
    if (selector.startsWith('[')) {
      // Basic attribute selector support
      // Handle [class*="newsletter" i] patterns
      if (selector.includes('class*=')) {
        const match = selector.match(/class\*="([^"]+)"/i);
        if (match) {
          const pattern = match[1].toLowerCase();
          return this.className.toLowerCase().includes(pattern);
        }
      }
      if (selector.includes('id*=')) {
        const match = selector.match(/id\*="([^"]+)"/i);
        if (match) {
          const pattern = match[1].toLowerCase();
          return this.id.toLowerCase().includes(pattern);
        }
      }
      // Handle [role="button"] patterns
      if (selector.includes('role=')) {
        const match = selector.match(/role="([^"]+)"/);
        if (match) {
          return this.getAttribute('role') === match[1];
        }
      }
    }
    // Handle tag name matching (e.g., "button", "a")
    const lowerSelector = selector.toLowerCase();
    const lowerTag = this.tagName.toLowerCase();
    if (lowerSelector === lowerTag) {
      return true;
    }
    return false;
  }

  getBoundingClientRect() {
    return this._boundingRect;
  }

  querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector: string): any {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) results.push(child);
      const childResults = child.querySelectorAll(selector);
      // Handle both array and object-like returns
      if (Array.isArray(childResults)) {
        results.push(...childResults);
      } else if (childResults && typeof childResults === 'object') {
        // Extract array elements from object-like structure
        for (let i = 0; i < childResults.length; i++) {
          if (childResults[i]) results.push(childResults[i]);
        }
      }
    }
    // Return object that acts like NodeList
    const nodeList: any = {
      length: results.length,
      forEach: (callback: any) => results.forEach(callback),
      [Symbol.iterator]: function* () {
        for (const item of results) {
          yield item;
        }
      },
    };
    // Add indexed access
    results.forEach((item, i) => {
      nodeList[i] = item;
    });
    return nodeList;
  }

  contains(other: MockElement) {
    if (other === this) return true;
    for (const child of this.children) {
      if (child.contains(other)) return true;
    }
    return false;
  }
}

// Setup mock globals
function setupMockGlobals() {
  (globalThis as any).window = {
    innerWidth: 1920,
    innerHeight: 1080,
    getComputedStyle: (el: MockElement) => ({
      display: el.style.display || 'block',
      visibility: el.style.visibility || 'visible',
      opacity: el.style.opacity || '1',
      position: el.style.position || 'static',
      zIndex: el.style.zIndex || 'auto',
    }),
  };

  (globalThis as any).document = {
    body: new MockElement('body'),
    querySelector: (selector: string) => null,
    querySelectorAll: (selector: string) => [],
    elementFromPoint: (x: number, y: number) => null,
  };
}

describe('Modal Detection Core - Visibility Checks', () => {
  beforeEach(() => {
    setupMockGlobals();
  });

  describe('isBasicVisible', () => {
    it('should return true for visible elements', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '1' },
      });
      expect(isBasicVisible(el)).toBe(true);
    });

    it('should return false for display:none elements', () => {
      const el = new MockElement('div', {
        style: { display: 'none', visibility: 'visible', opacity: '1' },
      });
      expect(isBasicVisible(el)).toBe(false);
    });

    it('should return false for visibility:hidden elements', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'hidden', opacity: '1' },
      });
      expect(isBasicVisible(el)).toBe(false);
    });

    it('should return false for near-transparent elements', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '0.05' },
      });
      expect(isBasicVisible(el)).toBe(false);
    });

    it('should return true for semi-transparent elements (opacity >= 0.1)', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '0.1' },
      });
      expect(isBasicVisible(el)).toBe(true);
    });
  });

  describe('isBlockingPosition', () => {
    it('should return true for fixed position', () => {
      const el = new MockElement('div', { style: { position: 'fixed' } });
      expect(isBlockingPosition(el)).toBe(true);
    });

    it('should return true for absolute position', () => {
      const el = new MockElement('div', { style: { position: 'absolute' } });
      expect(isBlockingPosition(el)).toBe(true);
    });

    it('should return false for static position', () => {
      const el = new MockElement('div', { style: { position: 'static' } });
      expect(isBlockingPosition(el)).toBe(false);
    });

    it('should return false for relative position', () => {
      const el = new MockElement('div', { style: { position: 'relative' } });
      expect(isBlockingPosition(el)).toBe(false);
    });
  });

  describe('hasMinimumZIndex', () => {
    it('should return true for z-index above minimum', () => {
      const el = new MockElement('div', { style: { zIndex: '1000' } });
      expect(hasMinimumZIndex(el, 100)).toBe(true);
    });

    it('should return true for z-index equal to minimum', () => {
      const el = new MockElement('div', { style: { zIndex: '100' } });
      expect(hasMinimumZIndex(el, 100)).toBe(true);
    });

    it('should return false for z-index below minimum', () => {
      const el = new MockElement('div', { style: { zIndex: '50' } });
      expect(hasMinimumZIndex(el, 100)).toBe(false);
    });

    it('should return true for auto z-index (might still be on top)', () => {
      const el = new MockElement('div', { style: { zIndex: 'auto' } });
      expect(hasMinimumZIndex(el, 100)).toBe(true);
    });
  });

  describe('coversMinimumViewport', () => {
    beforeEach(() => {
      (globalThis as any).window.innerWidth = 1920;
      (globalThis as any).window.innerHeight = 1080;
    });

    it('should return true for full-screen element (100% coverage)', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 0, top: 0, width: 1920, height: 1080 },
      });
      expect(coversMinimumViewport(el, 0.25)).toBe(true);
    });

    it('should return true for element covering 50% of viewport', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 0, top: 0, width: 1920, height: 540 },
      });
      expect(coversMinimumViewport(el, 0.25)).toBe(true);
    });

    it('should return true for element exactly at minimum threshold (25%)', () => {
      // 25% of 1920x1080 = 518400 pixels
      // 960x540 = 518400 pixels
      const el = new MockElement('div', {
        boundingRect: { left: 0, top: 0, width: 960, height: 540 },
      });
      expect(coversMinimumViewport(el, 0.25)).toBe(true);
    });

    it('should return false for small element below threshold', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 0, top: 0, width: 200, height: 100 },
      });
      expect(coversMinimumViewport(el, 0.25)).toBe(false);
    });
  });

  describe('isVisibleOnTop', () => {
    it('should return true when element is at center point', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 100, top: 100, width: 200, height: 200 },
      });

      (globalThis as any).document.elementFromPoint = (x: number, y: number) => {
        // Center is at 200, 200
        if (x === 200 && y === 200) return el;
        return null;
      };

      expect(isVisibleOnTop(el)).toBe(true);
    });

    it('should return true when element contains child at center point', () => {
      const parent = new MockElement('div', {
        boundingRect: { left: 100, top: 100, width: 200, height: 200 },
      });
      const child = new MockElement('span');
      parent.children.push(child);

      (globalThis as any).document.elementFromPoint = () => child;

      expect(isVisibleOnTop(parent)).toBe(true);
    });

    it('should return false when different element is at center point', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 100, top: 100, width: 200, height: 200 },
      });
      const other = new MockElement('div');

      (globalThis as any).document.elementFromPoint = () => other;

      expect(isVisibleOnTop(el)).toBe(false);
    });

    it('should return false when element center is outside viewport', () => {
      const el = new MockElement('div', {
        boundingRect: { left: 2000, top: 100, width: 200, height: 200 },
      });

      expect(isVisibleOnTop(el)).toBe(false);
    });
  });

  describe('isElementBlockingViewport', () => {
    it('should return true for fully blocking modal', () => {
      const el = new MockElement('div', {
        style: {
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          position: 'fixed',
          zIndex: '9999',
        },
        boundingRect: { left: 0, top: 0, width: 1920, height: 1080 },
      });

      (globalThis as any).document.elementFromPoint = () => el;

      expect(isElementBlockingViewport(el, 100, 0.25)).toBe(true);
    });

    it('should return false for invisible element', () => {
      const el = new MockElement('div', {
        style: { display: 'none', position: 'fixed', zIndex: '9999' },
        boundingRect: { left: 0, top: 0, width: 1920, height: 1080 },
      });

      expect(isElementBlockingViewport(el, 100, 0.25)).toBe(false);
    });

    it('should return false for non-positioned element', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: '9999' },
        boundingRect: { left: 0, top: 0, width: 1920, height: 1080 },
      });

      expect(isElementBlockingViewport(el, 100, 0.25)).toBe(false);
    });

    it('should return false for low z-index element', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', zIndex: '10' },
        boundingRect: { left: 0, top: 0, width: 1920, height: 1080 },
      });

      (globalThis as any).document.elementFromPoint = () => el;

      expect(isElementBlockingViewport(el, 100, 0.25)).toBe(false);
    });

    it('should return false for small element', () => {
      const el = new MockElement('div', {
        style: { display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', zIndex: '9999' },
        boundingRect: { left: 0, top: 0, width: 100, height: 100 },
      });

      (globalThis as any).document.elementFromPoint = () => el;

      expect(isElementBlockingViewport(el, 100, 0.25)).toBe(false);
    });
  });
});

/** A detached element built in the happy-dom document, so `matches` and `querySelectorAll` are the browser's own. */
function domElementFrom(html: string): any {
  const host = domDocument.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild;
}

describe('Modal Detection Core - Classification', () => {
  describe('classifyModal', () => {
    it('should classify cookie consent banner by class name', () => {
      const result = classifyModal(domElementFrom('<div class="cookie-banner">We use cookies</div>'), MODAL_PATTERNS);

      expect(result.type).toBe('cookie-consent');
      expect(result.confidence).toBe(90);
      expect(result.description).toBe('Cookie consent banner');
    });

    it('should classify cookie consent banner by text content', () => {
      const result = classifyModal(domElementFrom('<div>This website uses cookies to improve your experience</div>'), MODAL_PATTERNS);

      expect(result.type).toBe('cookie-consent');
      expect(result.confidence).toBe(90);
    });

    it('should classify newsletter popup', () => {
      const result = classifyModal(domElementFrom('<div class="newsletter-popup">Subscribe to our newsletter</div>'), MODAL_PATTERNS);

      expect(result.type).toBe('newsletter-popup');
      expect(result.confidence).toBe(85);
    });

    it('should classify age verification', () => {
      const result = classifyModal(domElementFrom('<div>Are you over 18 years old?</div>'), MODAL_PATTERNS);

      expect(result.type).toBe('age-verification');
      expect(result.confidence).toBe(95);
    });

    it('should classify generic dialog by ARIA attributes', () => {
      const result = classifyModal(domElementFrom('<div class="some-panel" role="dialog"></div>'), MODAL_PATTERNS);

      expect(result.type).toBe('generic-dialog');
      expect(result.confidence).toBe(75);
    });

    it('should classify blocking overlay', () => {
      const result = classifyModal(domElementFrom('<div class="modal-backdrop"></div>'), MODAL_PATTERNS);

      expect(result.type).toBe('blocking-overlay');
      expect(result.confidence).toBe(70);
    });

    it('should return unknown for unrecognized elements', () => {
      const result = classifyModal(domElementFrom('<div class="random-element">Some random content</div>'), MODAL_PATTERNS);

      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(50);
    });
  });

  describe('getDismissStrategies', () => {
    it('should detect accept button', () => {
      const strategies = getDismissStrategies(domElementFrom('<div><button class="btn">Accept All Cookies</button></div>'), 'unknown');

      expect(strategies).toContain('accept');
    });

    it('should detect reject button', () => {
      const strategies = getDismissStrategies(domElementFrom('<div><button class="btn">Decline All Cookies</button></div>'), 'cookie-consent');

      expect(strategies).toContain('reject');
    });

    it('should detect reject from an id no text or class repeats', () => {
      const strategies = getDismissStrategies(domElementFrom('<div><button id="btn-Reject">continue</button></div>'), 'cookie-consent');

      expect(strategies).toContain('reject');
    });

    it('should detect close button', () => {
      const strategies = getDismissStrategies(domElementFrom('<div><button class="btn">×</button></div>'), 'newsletter-popup');

      expect(strategies).toContain('close');
    });

    it('should add accept as default for cookie consent without explicit button', () => {
      const strategies = getDismissStrategies(domElementFrom('<div></div>'), 'cookie-consent');

      expect(strategies).toContain('accept');
      expect(strategies).toContain('remove');
    });
  });

  describe('getUniqueSelector', () => {
    beforeEach(() => {
      (globalThis as any).document = domDocument;
    });

    afterEach(() => {
      domDocument.body.innerHTML = '';
    });

    it('should use ID selector when available', () => {
      domDocument.body.innerHTML = '<div id="cookieBanner"></div>';

      expect(getUniqueSelector(domDocument.getElementById('cookieBanner'))).toBe('#cookieBanner');
    });

    it('should use class selector when unique', () => {
      domDocument.body.innerHTML = '<div class="cookie-banner modal-dialog"></div><div class="cookie-banner"></div>';

      expect(getUniqueSelector(domDocument.querySelector('.modal-dialog'))).toBe('.cookie-banner.modal-dialog');
    });

    it('should build path-based selector when class is not unique', () => {
      domDocument.body.innerHTML = '<div id="modal-container"><div class="content"></div></div><div class="content"></div>';

      const selector = getUniqueSelector(domDocument.querySelector('#modal-container .content'));

      expect(selector).toBe('div#modal-container > div.content');
    });

    it('should handle elements without ID or class', () => {
      domDocument.body.innerHTML = '<span></span>';

      expect(getUniqueSelector(domDocument.querySelector('span'))).toBe('span');
    });
  });
});
