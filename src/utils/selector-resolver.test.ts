/**
 * Tests for extended selector resolution.
 *
 * The property worth pinning is that a resolved selector still finds its
 * element after the page re-renders. Resolution works by stamping the match
 * with a data attribute and handing back a selector for that attribute, and a
 * UI that repaints on a timer - a dashboard polling for state, a list re-keying
 * - replaces the node and takes the stamp with it. The element is then reported
 * as missing while it is plainly on screen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSelector, cleanupResolvedSelector, parseExtendedSelector } from './selector-resolver.js';

/**
 * happy-dom supplies the document; the compiler's lib is ES2022 with no DOM, so
 * the binding is declared here rather than pulling the DOM lib into the build.
 */
declare const document: any;

/** page.evaluate, against the test environment's own document. */
const page = {
  evaluate: async (fn: (...args: any[]) => any, ...args: any[]) => fn(...args),
};

/** MutationObserver callbacks land on a microtask. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function render(rows: string[]): void {
  document.body.innerHTML = `<table><tbody>${rows
    .map(text => `<tr class="session-row"><td>${text}</td></tr>`)
    .join('')}</tbody></table>`;
}

beforeEach(() => {
  render(['389d0e79 annotate active']);
});

afterEach(() => {
  // Each resolution leaves a live observer until it is cleaned up or its
  // backstop fires; without this, one test's mark keeps re-applying itself
  // through the next one's renders.
  const marks = (globalThis as any).__cdpSelectorMarks ?? {};
  for (const key of Object.keys(marks)) {
    marks[key].observer?.disconnect?.();
    clearTimeout(marks[key].timer);
    delete marks[key];
  }
  document.body.innerHTML = '';
});

describe('parseExtendedSelector', () => {
  it('splits the base selector from the text match', () => {
    expect(parseExtendedSelector('.session-row:has-text("389d0e79")')).toEqual({
      baseSelector: '.session-row',
      textMatch: { type: 'has-text', value: '389d0e79' },
      scopeSelector: '.session-row',
      descendantSelector: '',
    });
  });

  it('keeps the text on the compound it was written on', () => {
    // `.row:has-text("x") .cell` reads as "the row saying x, then its cell".
    // Concatenated into `.row .cell` the text is tested against the cell,
    // whose own text is something else, and nothing ever matches.
    expect(parseExtendedSelector('.session-row:has-text("8d76da6e") .entry-count')).toEqual({
      baseSelector: '.session-row .entry-count',
      textMatch: { type: 'has-text', value: '8d76da6e' },
      scopeSelector: '.session-row',
      descendantSelector: '.entry-count',
    });
  });

  it('finds a descendant of the element the text names', async () => {
    document.body.innerHTML = `<table><tbody>
      <tr class="session-row"><td>91e8406d idle</td><td class="entry-count">+0</td></tr>
      <tr class="session-row"><td>8d76da6e active</td><td class="entry-count">+45</td></tr>
    </tbody></table>`;

    const resolved = await resolveSelector(page, '.session-row:has-text("8d76da6e") .entry-count');

    expect('error' in resolved).toBe(false);
    const marked = document.querySelector((resolved as any).selector);
    expect(marked).not.toBeNull();
    expect(marked.textContent).toBe('+45');
    expect(marked.className).toBe('entry-count');
  });

  it('leaves a plain selector alone', () => {
    expect(parseExtendedSelector('.session-row')).toEqual({
      baseSelector: '.session-row',
      textMatch: null,
    });
  });
});

describe('resolveSelector', () => {
  it('resolves to a selector that finds the element', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');

    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(document.querySelector(resolved.selector)).not.toBeNull();
  });

  it('still finds the element after the page re-renders', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    // What a dashboard does once a second: same content, new nodes.
    render(['389d0e79 annotate active']);
    await settle();

    const found = document.querySelector(resolved.selector);
    expect(found).not.toBeNull();
    expect(found?.textContent).toContain('389d0e79');
  });

  it('follows the text when the row it belongs to moves', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    render(['45027e10 other session', '389d0e79 annotate active']);
    await settle();

    expect(document.querySelector(resolved.selector)?.textContent).toContain('389d0e79');
  });

  it('marks exactly one element, not every re-rendered copy', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    render(['389d0e79 annotate active']);
    await settle();
    render(['389d0e79 annotate paused']);
    await settle();

    expect(document.querySelectorAll('[data-cdp-selector-match]')).toHaveLength(1);
  });

  it('reports no match without leaving anything behind', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("nothing here")');

    expect('error' in resolved).toBe(true);
    expect(document.querySelectorAll('[data-cdp-selector-match]')).toHaveLength(0);
  });

  it('warns when more than one element matches', async () => {
    render(['389d0e79 first', '389d0e79 second']);

    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    expect(resolved.matchCount).toBe(2);
    expect(resolved.warning).toContain('2 matches');
  });
});

describe('cleanupResolvedSelector', () => {
  it('removes the mark', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    await cleanupResolvedSelector(page, resolved.selector);

    expect(document.querySelector(resolved.selector)).toBeNull();
  });

  it('stops the mark re-applying itself, or removal would not stick', async () => {
    const resolved = await resolveSelector(page, '.session-row:has-text("389d0e79")');
    if ('error' in resolved) throw new Error(resolved.error);

    await cleanupResolvedSelector(page, resolved.selector);
    render(['389d0e79 annotate active']);
    await settle();

    expect(document.querySelectorAll('[data-cdp-selector-match]')).toHaveLength(0);
  });

  it('ignores a selector it did not produce', async () => {
    await expect(cleanupResolvedSelector(page, '.session-row')).resolves.toBeUndefined();
  });
});
