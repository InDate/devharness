/**
 * Extended Selector Resolver
 *
 * Supports Playwright-style extended selectors that aren't native CSS:
 * - :has-text("text") - matches elements containing text (case-insensitive partial match)
 * - :text("text") - matches elements with exact text content
 * - :text-is("text") - alias for :text()
 *
 * Text matching includes: textContent, aria-label, and title attributes.
 *
 * Examples:
 *   button:has-text("Submit")      -> finds <button>Submit Form</button>
 *   a:has-text("Login")            -> finds <a href="/login">Login</a>
 *   a:has-text("Homepage")         -> finds <a aria-label="Homepage">...</a>
 *   div:text("Exact Match")        -> finds <div>Exact Match</div> (exact only)
 *   :has-text("Search")            -> finds any element containing "Search"
 */

export interface ResolvedSelector {
  /** The resolved CSS selector that can be used with querySelector */
  selector: string;
  /** Number of elements that matched */
  matchCount: number;
  /** Warning message if multiple matches found */
  warning?: string;
}

export interface SelectorError {
  error: string;
  originalSelector: string;
  suggestion?: string;
}

/**
 * Parse extended selector syntax and extract components
 * (exported for the wait tool, which needs the raw base-selector + text-match
 * pieces to build a self-contained polling predicate instead of marking
 * elements with data attributes that would not survive a navigation)
 */
export function parseExtendedSelector(selector: string): {
  baseSelector: string;
  textMatch: { type: 'has-text' | 'text' | 'text-is'; value: string } | null;
  /**
   * The compound the pseudo-class is attached to - what the text is tested
   * against. `.session-row:has-text("x") .cell` tests `.session-row`.
   */
  scopeSelector?: string;
  /**
   * What follows that compound, empty when the pseudo-class sits on the last
   * one. Non-empty means the match descends from the scope, rather than the
   * text being tested against the descendant - whose own text differs.
   */
  descendantSelector?: string;
} | { error: string } {
  // Check if this looks like an extended selector
  const extendedMatch = selector.match(/:(?:has-text|text|text-is)\(/);
  if (!extendedMatch) {
    return { baseSelector: selector, textMatch: null };
  }

  // Find the pseudo-class start position
  const pseudoStart = extendedMatch.index!;
  const beforePart = selector.substring(0, pseudoStart);

  // Extract the type (has-text, text, or text-is)
  const typeMatch = selector.substring(pseudoStart).match(/^:(has-text|text|text-is)\(/);
  if (!typeMatch) {
    return { error: 'Invalid extended selector syntax' };
  }

  const matchType = typeMatch[1] as 'has-text' | 'text' | 'text-is';
  const afterTypeStart = pseudoStart + typeMatch[0].length;

  // Parse the quoted string - handle both single and double quotes
  const remaining = selector.substring(afterTypeStart);
  const quoteChar = remaining[0];

  if (quoteChar !== '"' && quoteChar !== "'") {
    return { error: `Expected quote after :${matchType}(, got: ${quoteChar || 'end of string'}` };
  }

  // Find the closing quote, handling escaped quotes
  let textValue = '';
  let i = 1;
  while (i < remaining.length) {
    const char = remaining[i];
    if (char === '\\' && i + 1 < remaining.length) {
      // Escaped character - include the next char literally
      textValue += remaining[i + 1];
      i += 2;
    } else if (char === quoteChar) {
      // Found closing quote
      break;
    } else {
      textValue += char;
      i++;
    }
  }

  if (i >= remaining.length || remaining[i] !== quoteChar) {
    return { error: `Unterminated string in :${matchType}() selector` };
  }

  // Check for closing paren
  if (remaining[i + 1] !== ')') {
    return { error: `Expected ) after closing quote in :${matchType}() selector` };
  }

  // Get any remaining selector after the extended part
  const afterPart = remaining.substring(i + 2);

  // Combine before and after parts
  let baseSelector = (beforePart + afterPart).trim();
  if (!baseSelector) {
    baseSelector = '*';
  }

  return {
    baseSelector,
    textMatch: { type: matchType, value: textValue },
    scopeSelector: beforePart.trim() || '*',
    descendantSelector: afterPart.trim(),
  };
}

/**
 * Check if a selector uses extended syntax
 */
export function isExtendedSelector(selector: string): boolean {
  return /:(?:has-text|text|text-is)\(/.test(selector);
}

/**
 * Resolve an extended selector to a standard CSS selector
 *
 * For extended selectors, this finds matching elements and returns a
 * data-attribute based selector that uniquely identifies the first match.
 *
 * @param page - Puppeteer page instance
 * @param selector - The selector (may include extended syntax like :has-text())
 * @returns Resolved selector info or error
 */
export async function resolveSelector(
  page: any,
  selector: string
): Promise<ResolvedSelector | SelectorError> {
  // Check if it's an extended selector
  if (!isExtendedSelector(selector)) {
    // Standard CSS selector - return as-is, let caller validate
    return {
      selector,
      matchCount: 1,
    };
  }

  const parsed = parseExtendedSelector(selector);

  if ('error' in parsed) {
    return {
      error: parsed.error,
      originalSelector: selector,
      suggestion: 'Check the selector syntax. Format: element:has-text("text") or element:text("exact text")',
    };
  }

  const { baseSelector, textMatch, scopeSelector, descendantSelector } = parsed;

  if (!textMatch) {
    // Shouldn't happen since we checked isExtendedSelector, but handle it
    return { selector, matchCount: 1 };
  }

  // Find matching elements and mark the first one with a unique attribute.
  //
  // The mark has to survive the page re-rendering. A live UI that repaints on a
  // timer - a dashboard polling for state, a list re-keying - replaces the
  // matched node and takes the attribute with it, so a caller querying a moment
  // later finds nothing and reports the element as missing while it is plainly
  // on screen. The mark re-applies itself on every mutation until it is cleaned
  // up, which is what makes an extended selector usable on a page that moves.
  const result = await page.evaluate(
    (base: string, matchType: string, matchText: string, scope: string, descendant: string) => {
      const root = (globalThis as any).document;

      const matchesText = (el: any): boolean => {
        const textContent = el.textContent?.trim() || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const allText = [textContent, ariaLabel, title].filter(Boolean).join(' ');
        if (matchType === 'has-text') {
          return allText.toLowerCase().includes(matchText.toLowerCase());
        }
        return textContent === matchText || ariaLabel === matchText || title === matchText;
      };

      const collect = () => {
        const found: any[] = [];
        root.querySelectorAll(descendant ? scope : base).forEach((el: any) => {
          if (!matchesText(el)) return;
          if (!descendant) { found.push(el); return; }
          el.querySelectorAll(descendant).forEach((inner: any) => found.push(inner));
        });
        return found;
      };

      const initial = collect();
      if (initial.length === 0) {
        return { error: 'no_match' };
      }

      const uniqueId = `cdp-ext-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const apply = () => {
        const current = collect();
        if (!current.length) return;
        if (current[0].getAttribute('data-cdp-selector-match') === uniqueId) return;
        // A re-render can leave the old mark on a detached node; only the live
        // first match should carry it.
        root.querySelectorAll(`[data-cdp-selector-match="${uniqueId}"]`)
          .forEach((el: any) => el.removeAttribute('data-cdp-selector-match'));
        current[0].setAttribute('data-cdp-selector-match', uniqueId);
      };
      apply();

      const w = globalThis as any;
      w.__cdpSelectorMarks = w.__cdpSelectorMarks || {};
      const observer = new (globalThis as any).MutationObserver(() => apply());
      observer.observe(root.documentElement, { childList: true, subtree: true });
      // A caller that never cleans up must not leave an observer running for
      // the life of the page.
      const timer = (globalThis as any).setTimeout(() => {
        observer.disconnect();
        delete w.__cdpSelectorMarks[uniqueId];
      }, 30000);
      w.__cdpSelectorMarks[uniqueId] = { observer, timer };

      const describe = (el: any) => {
        const text = (el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        return {
          text: text.substring(0, 60) + (text.length > 60 ? '...' : ''),
          tagName: el.tagName.toLowerCase(),
        };
      };

      return {
        uniqueId,
        matchCount: initial.length,
        matches: initial.slice(0, 5).map(describe),
        tagName: describe(initial[0]).tagName,
      };
    },
    baseSelector,
    textMatch.type,
    textMatch.value,
    scopeSelector ?? baseSelector,
    descendantSelector ?? ''
  );

  if ('error' in result && result.error === 'no_match') {
    return {
      error: `Element not found: \`${selector}\``,
      originalSelector: selector,
      suggestion: `No ${baseSelector === '*' ? 'element' : `\`${baseSelector}\``} contains text "${textMatch.value}". Use \`content({ action: 'findInteractive', search: '${textMatch.value}' })\` to see available elements.`,
    };
  }

  // Build response
  const resolvedSelector = `[data-cdp-selector-match="${result.uniqueId}"]`;

  let warning: string | undefined;
  if (result.matchCount > 1) {
    const othersText = result.matches.slice(1).map((m: any) => `"${m.text}"`).join(', ');
    warning = `Found ${result.matchCount} matches. Using first match. Other matches: ${othersText}${result.matchCount > 5 ? ` (and ${result.matchCount - 5} more)` : ''}`;
  }

  return {
    selector: resolvedSelector,
    matchCount: result.matchCount,
    warning,
  };
}

/**
 * Clean up the temporary data attribute after use
 * Should be called after the selector has been used
 */
export async function cleanupResolvedSelector(page: any, selector: string): Promise<void> {
  if (!selector.startsWith('[data-cdp-selector-match=')) {
    return;
  }

  await page.evaluate((sel: string) => {
    const w = globalThis as any;
    // Stop the mark re-applying itself before removing it, or the observer puts
    // it straight back.
    const uniqueId = sel.match(/\[data-cdp-selector-match="([^"]+)"\]/)?.[1];
    if (uniqueId && w.__cdpSelectorMarks?.[uniqueId]) {
      const { observer, timer } = w.__cdpSelectorMarks[uniqueId];
      observer?.disconnect?.();
      w.clearTimeout?.(timer);
      delete w.__cdpSelectorMarks[uniqueId];
    }
    w.document.querySelectorAll(sel).forEach((el: any) => el.removeAttribute('data-cdp-selector-match'));
  }, selector);
}
