/**
 * What identifies the element an input action acted on, read in the page at
 * the moment of the action.
 *
 * A selector names where to look, not what is there: `li:nth-child(3)` hits
 * whatever third row a release puts there, and an `x,y` click hits whatever
 * sits under the point at the window size it runs at. The fingerprint is what
 * the step found, so a later run can compare what it found against it.
 */

export interface ElementFingerprint {
  tag: string;
  id?: string;
  /** data-testid, data-test-id, data-test, data-cy or data-qa, whichever the element carries. */
  testid?: string;
  name?: string;
  /** The explicit role, or the one the tag implies. */
  role?: string;
  /** aria-label, aria-labelledby, a label for it, alt, title or placeholder, in that order. */
  label?: string;
  /** Whitespace collapsed, at most 80 characters. */
  text?: string;
  /** Up to four ancestors, nearest first, each `tag#id`, `tag[testid]` or `tag`; a shadow host is marked `tag>>`. */
  path: string[];
}

export type FingerprintTarget = { selector: string } | { x: number; y: number };

/**
 * What a step that hit another element can be repaired to. `selector` is
 * where the recorded element is now, present only when exactly one element
 * carries its strict fields; `matches` is how many do. `hit` is the element
 * the step reached, which becomes the step's fingerprint when the change was
 * intended.
 */
export interface ElementRepair {
  matches: number;
  selector?: string;
  hit: ElementFingerprint;
}

/** The fields that identify an element; any one the stored fingerprint carries must match. */
const STRICT_FIELDS = ['tag', 'testid', 'id', 'name', 'role', 'label'] as const;

/**
 * Whether `hit` is the element `expected` describes, and which fields part
 * them. Text and path are advisory: a toggle's text carries its state, and a
 * wrapper added above the element moves its path while it stays the same
 * element.
 */
export function compareFingerprints(
  expected: ElementFingerprint,
  hit: ElementFingerprint
): { same: boolean; differ: string[]; advisory: string[] } {
  const differ = STRICT_FIELDS.filter(field => expected[field] !== undefined && expected[field] !== hit[field]);
  const advisory: string[] = [];
  if (expected.text !== hit.text) advisory.push('text');
  if (expected.path.join(' ') !== hit.path.join(' ')) advisory.push('path');
  return { same: differ.length === 0, differ: [...differ], advisory };
}

/**
 * The page-side search for a fingerprint: every element carrying its strict
 * fields, and a selector built from the strongest of them where exactly one
 * does. Serialised into an expression, so it reads nothing outside itself.
 * Light DOM only: a selector into a shadow root needs a piercing step this
 * search does not build.
 */
function locateInPage(fp: ElementFingerprint): { count: number; selector?: string } {
  const doc = (globalThis as any).document;
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  const esc = (v: string) => (globalThis as any).CSS.escape(v);
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  let candidates: any[];
  let selector: string | undefined;
  if (fp.testid) {
    const attr = TEST_ATTRS.find(a => doc.querySelector(`[${a}="${esc(fp.testid!)}"]`));
    selector = attr ? `[${attr}="${fp.testid}"]` : undefined;
    candidates = attr ? [...doc.querySelectorAll(`[${attr}="${esc(fp.testid)}"]`)] : [];
  } else if (fp.id) {
    selector = `#${esc(fp.id)}`;
    candidates = [...doc.querySelectorAll(selector)];
  } else if (fp.name) {
    selector = `${fp.tag}[name="${fp.name}"]`;
    candidates = [...doc.querySelectorAll(`${fp.tag}[name="${esc(fp.name)}"]`)];
  } else {
    const words = fp.label ?? fp.text;
    candidates = [...doc.querySelectorAll(fp.tag)].filter((el: any) =>
      words !== undefined && (squash(el.getAttribute('aria-label')) === words || squash(el.textContent).slice(0, 80) === words));
    selector = words !== undefined ? `${fp.tag}:has-text(${JSON.stringify(words)})` : undefined;
  }
  candidates = candidates.filter((el: any) => el.tagName.toLowerCase() === fp.tag
    && (fp.name === undefined || el.getAttribute('name') === fp.name));
  return candidates.length === 1 && selector ? { count: 1, selector } : { count: candidates.length };
}

/**
 * Where the recorded element is on the page now, as a selector, when exactly
 * one element carries its strict fields. `count` is how many do: zero is an
 * element the page no longer has, more than one is a match no repair can pick.
 */
export async function locateFingerprint(
  executeToolCall: (tool: string, params: Record<string, any>) => Promise<any>,
  connection: string,
  fingerprint: ElementFingerprint
): Promise<{ count: number; selector?: string } | undefined> {
  const expression = `(${locateInPage.toString()})(${JSON.stringify(fingerprint)})`;
  const result = await executeToolCall('inspect', { action: 'evaluateExpression', connection, expression }).catch(() => null);
  const value = result?._meta?.inspect?.value;
  return value && typeof value.count === 'number' ? value : undefined;
}

/** `locateFingerprint` on a page held directly, as the input tool holds it. */
export async function locateFingerprintOnPage(page: any, fingerprint: ElementFingerprint): Promise<{ count: number; selector?: string } | undefined> {
  return page.evaluate(locateInPage, fingerprint).catch(() => undefined);
}

/**
 * Whether a click goes ahead against the element it was meant for. Undefined
 * where it does: no expected element, nothing read, or the same element. A
 * refusal carries the line naming both elements and the repair found.
 */
export async function refuseOtherElement(
  page: any,
  expected: ElementFingerprint | undefined,
  hit: ElementFingerprint | undefined
): Promise<{ line: string; repair: ElementRepair } | undefined> {
  if (!expected || !hit) return undefined;
  const compared = compareFingerprints(expected, hit);
  if (compared.same) return undefined;
  const located = await locateFingerprintOnPage(page, expected);
  return {
    line: `recorded ${describeFingerprint(expected)}, found ${describeFingerprint(hit)} (${compared.differ.join(', ')} differ)`,
    repair: { matches: located?.count ?? 0, ...(located?.selector ? { selector: located.selector } : {}), hit },
  };
}

/** One element in a line: `button [dark-toggle] "Dark mode: off"`. */
export function describeFingerprint(fingerprint: ElementFingerprint): string {
  const marker = fingerprint.testid ? ` [${fingerprint.testid}]` : fingerprint.id ? ` #${fingerprint.id}` : '';
  const words = fingerprint.label ?? fingerprint.text;
  return `${fingerprint.tag}${marker}${words ? ` "${words}"` : ''}`;
}

/**
 * The fingerprint of the element a selector resolves to, or of the nearest
 * interactive element under a point; undefined where nothing is there.
 * A point is followed into open shadow roots, and climbs to an interactive
 * ancestor so a click on a button's inner span reads as the button.
 */
export async function readFingerprint(page: any, target: FingerprintTarget): Promise<ElementFingerprint | undefined> {
  return page.evaluate((t: any) => {
    const doc = (globalThis as any).document;
    const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]';
    const IMPLIED: Record<string, string> = {
      button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'img',
    };
    const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const parentOf = (el: any) => el.parentElement ?? (el.parentNode?.host ?? null);

    let el: any = null;
    if ('selector' in t) {
      el = doc.querySelector(t.selector);
    } else {
      el = doc.elementFromPoint(t.x, t.y);
      while (el?.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(t.x, t.y);
        if (!inner || inner === el) break;
        el = inner;
      }
      let climb = el;
      while (climb && !climb.matches?.(INTERACTIVE)) climb = parentOf(climb);
      if (climb && climb !== doc.body && climb !== doc.documentElement) el = climb;
    }
    if (!el) return undefined;

    const tag = el.tagName.toLowerCase();
    const testid = TEST_ATTRS.map(a => el.getAttribute(a)).find(Boolean) ?? undefined;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role')
      || (tag === 'input' ? (['checkbox', 'radio', 'button', 'submit', 'range'].includes(type) ? (type === 'submit' ? 'button' : type) : 'textbox') : IMPLIED[tag])
      || undefined;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id: string) => doc.getElementById(id)?.textContent).join(' ');
    const forLabel = el.id ? doc.querySelector(`label[for="${(globalThis as any).CSS.escape(el.id)}"]`)?.textContent : '';
    const label = squash(el.getAttribute('aria-label') || labelledBy || forLabel || el.getAttribute('alt')
      || el.getAttribute('title') || el.getAttribute('placeholder')) || undefined;
    const text = squash(el.textContent).slice(0, 80) || undefined;

    const path: string[] = [];
    let up = el.parentElement ?? null;
    let node: any = el;
    while (path.length < 4) {
      if (!up && node.parentNode?.host) {
        up = node.parentNode.host;
        const hostTag = up.tagName.toLowerCase();
        path.push(`${hostTag}>>`);
        node = up;
        up = up.parentElement ?? null;
        continue;
      }
      if (!up || up === doc.body || up === doc.documentElement) break;
      const upTestid = TEST_ATTRS.map(a => up.getAttribute(a)).find(Boolean);
      path.push(up.id ? `${up.tagName.toLowerCase()}#${up.id}` : upTestid ? `${up.tagName.toLowerCase()}[${upTestid}]` : up.tagName.toLowerCase());
      node = up;
      up = up.parentElement ?? null;
    }

    const fingerprint: Record<string, unknown> = { tag, path };
    if (el.id) fingerprint.id = el.id;
    if (testid) fingerprint.testid = testid;
    if (el.getAttribute('name')) fingerprint.name = el.getAttribute('name');
    if (role) fingerprint.role = role;
    if (label) fingerprint.label = label;
    if (text) fingerprint.text = text;
    return fingerprint;
  }, target).catch(() => undefined);
}
