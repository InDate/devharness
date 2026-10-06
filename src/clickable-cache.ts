/**
 * Cache for clickable elements by URL
 * Stores clickable elements discovered during navigation for quick filtering/searching
 */

export interface ClickableElement {
  type: 'link' | 'button' | 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'date' | 'other';
  text: string;
  href: string;
  selector: string;
  // Viewport position information
  inViewport?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // Semantic context (nav, main, footer, header, aside, form)
  context?: string;
  // Input-specific fields
  label?: string;
  required?: boolean;
  // Whether element is visually visible (not hidden by CSS, clipping, etc.)
  visible?: boolean;
}

interface CacheEntry {
  url: string;
  elements: ClickableElement[];
  timestamp: number;
  viewportHeight: number;
  viewportWidth: number;
}

/**
 * Simple in-memory cache for clickable elements
 * Keys are normalized URL stubs (pathname + search, no protocol/host/hash)
 */
const pageIds = new WeakMap<object, number>();
let nextPageId = 0;

/**
 * The key a page's elements are cached under: the page itself, then its URL.
 * Keyed by URL alone, two connections on one URL - a bench opened twice -
 * shared an entry, and one was handed the other's selectors.
 */
export function pageKey(page: object, url: string): string {
  let id = pageIds.get(page);
  if (id === undefined) {
    id = ++nextPageId;
    pageIds.set(page, id);
  }
  return `${id}|${url}`;
}

export class ClickableCache {
  private cache = new Map<string, CacheEntry>();
  private maxAge = 5 * 60 * 1000; // 5 minutes default TTL

  /**
   * Normalize URL to cache key (host + pathname + search)
   * Includes host to prevent conflicts between different sites
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.host + parsed.pathname + parsed.search;
    } catch {
      // If URL parsing fails, use as-is
      return url;
    }
  }

  /**
   * Store clickable elements for a URL
   */
  set(url: string, elements: ClickableElement[], viewportHeight: number, viewportWidth: number): void {
    const key = this.normalizeUrl(url);
    this.cache.set(key, {
      url,
      elements,
      timestamp: Date.now(),
      viewportHeight,
      viewportWidth,
    });
  }

  /**
   * Get cached clickable elements for a URL
   * Returns null if not cached or expired
   */
  get(url: string): CacheEntry | null {
    const key = this.normalizeUrl(url);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Check if URL is cached and fresh
   */
  has(url: string): boolean {
    return this.get(url) !== null;
  }

  /**
   * Clear cache for a specific URL
   */
  delete(url: string): void {
    const key = this.normalizeUrl(url);
    this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  stats(): { size: number; entries: Array<{ url: string; count: number; age: number }> } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      url: entry.url,
      count: entry.elements.length,
      age: Math.floor((Date.now() - entry.timestamp) / 1000), // seconds
    }));

    return {
      size: this.cache.size,
      entries,
    };
  }
}
