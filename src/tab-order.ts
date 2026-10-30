/**
 * The Tab stops either side of the focused element, in the order the browser
 * visits them.
 *
 * A control the browser skips and this list keeps reads as a Tab stop the page
 * does not have, so the list drops every control the browser removes from
 * sequential focus: one under an `inert` ancestor, one outside the top modal
 * dialog (inert with no attribute set), one with a negative tabindex, one
 * matching `:disabled` (which covers a disabled fieldset's controls), and one
 * not rendered. Positive tabindex values come first in ascending order, then
 * tabindex 0 in document order. Shadow roots are not walked.
 */
function tabStopsInPage(span: number): { prev: string[]; next: string[] } {
  const doc = (globalThis as any).document;
  const focused = doc.activeElement;
  if (!focused || focused === doc.body) return { prev: [], next: [] };

  const modal = Array.from(doc.querySelectorAll(':modal')).pop() as any;
  const candidates = Array.from(doc.querySelectorAll(
    'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]'
  )) as any[];
  const stops = candidates.filter(el =>
    el.tabIndex >= 0
    && !(el.tagName === 'INPUT' && el.type === 'hidden')
    && !el.matches(':disabled')
    && !el.closest('[inert]')
    && !(modal && !modal.contains(el))
    && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }));
  const ordered = [
    ...stops.filter(el => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex),
    ...stops.filter(el => el.tabIndex === 0),
  ];

  const formatEl = (el: any) => {
    const tag = el.tagName.toLowerCase();
    const text = el.textContent?.trim().substring(0, 20) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (tag === 'input') return `${tag}[${el.getAttribute('type') || 'text'}]${text ? ` "${text}"` : ''}`;
    return `${tag}${text ? ` "${text}"` : ''}`;
  };
  const at = ordered.indexOf(focused);
  if (at === -1) return { prev: [], next: [] };
  return {
    prev: ordered.slice(Math.max(0, at - span), at).map(formatEl),
    next: ordered.slice(at + 1, at + 1 + span).map(formatEl),
  };
}

export const TAB_STOP_SPAN = 3;

export async function readTabStops(page: any, span = TAB_STOP_SPAN): Promise<{ prev: string[]; next: string[] }> {
  return page.evaluate(`(${tabStopsInPage.toString()})(${span})`);
}
