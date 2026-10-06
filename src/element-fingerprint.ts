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

export type FingerprintTarget = { selector: string } | { x: number; y: number } | { handle: unknown };

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
 * The page-side search for a fingerprint: every element, in the document and
 * in every open shadow root, whose own fingerprint carries the same strict
 * fields, and a selector that resolves to it where exactly one does. A selector
 * into a shadow root is a chain of `host >>> inner` steps, one per root, each
 * step unique in its scope; the chain is kept only when it resolves back to
 * the element. `fingerprintOf` is `fingerprintInPage`, passed in because both
 * are serialised into the page.
 */
function locateInPage(fp: ElementFingerprint, fingerprintOf: (t: any, given?: any) => any): { count: number; selector?: string } {
  const doc = (globalThis as any).document;
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  const STRICT = ['tag', 'testid', 'id', 'name', 'role', 'label'];
  const esc = (v: string) => (globalThis as any).CSS.escape(v);

  const all: any[] = [];
  const walk = (root: any) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(doc);
  const candidates = all.filter(el => {
    if (el.tagName.toLowerCase() !== fp.tag) return false;
    const seen = fingerprintOf({}, el);
    return STRICT.every(field => (fp as any)[field] === undefined || (fp as any)[field] === seen?.[field]);
  });
  if (candidates.length !== 1) return { count: candidates.length };
  const target = candidates[0];

  // One simple selector for an element, unique in the scope it sits in.
  const stepFor = (el: any, scope: any): string | undefined => {
    const tag = el.tagName.toLowerCase();
    const attr = TEST_ATTRS.find(a => el.getAttribute(a));
    const options = [
      attr ? `[${attr}="${esc(el.getAttribute(attr))}"]` : undefined,
      el.id ? `#${esc(el.id)}` : undefined,
      el.getAttribute('name') ? `${tag}[name="${esc(el.getAttribute('name'))}"]` : undefined,
      tag,
    ].filter(Boolean) as string[];
    return options.find(option => scope.querySelectorAll(option).length === 1 && scope.querySelector(option) === el);
  };

  const chain: any[] = [target];
  let root = target.getRootNode();
  while (root && root !== doc && root.host) {
    chain.unshift(root.host);
    root = root.host.getRootNode();
  }
  const steps: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const scope = i === 0 ? doc : chain[i - 1].shadowRoot;
    const step = stepFor(chain[i], scope);
    if (!step) {
      // A light-DOM element with nothing unique on it is named by its words,
      // which devharness resolves; inside a shadow root nothing resolves those.
      const words = fp.label ?? fp.text;
      return chain.length === 1 && words !== undefined
        ? { count: 1, selector: `${fp.tag}:has-text(${JSON.stringify(words)})` }
        : { count: 1 };
    }
    steps.push(step);
  }
  let resolved: any = doc.querySelector(steps[0]);
  for (let i = 1; i < steps.length; i++) resolved = resolved?.shadowRoot?.querySelector(steps[i]) ?? null;
  return resolved === target ? { count: 1, selector: steps.join(' >>> ') } : { count: 1 };
}

/** The expression that runs `locateInPage` for `fingerprint`. */
function locateExpression(fingerprint: ElementFingerprint): string {
  return `(${locateInPage.toString()})(${JSON.stringify(fingerprint)}, ${fingerprintInPage.toString()})`;
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
  const result = await executeToolCall('inspect', { action: 'evaluateExpression', connection, expression: locateExpression(fingerprint) }).catch(() => null);
  const value = result?._meta?.inspect?.value;
  return value && typeof value.count === 'number' ? value : undefined;
}

/** `locateFingerprint` on a page held directly, as the input tool holds it. */
export async function locateFingerprintOnPage(page: any, fingerprint: ElementFingerprint): Promise<{ count: number; selector?: string } | undefined> {
  return page.evaluate(locateExpression(fingerprint)).catch(() => undefined);
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
  if ('handle' in target) return page.evaluate(fingerprintInPage, { handle: true }, target.handle).catch(() => undefined);
  return page.evaluate(fingerprintInPage, target).catch(() => undefined);
}

/** `readFingerprint` through a tool call, for code that holds no page. */
export async function readFingerprintVia(
  executeToolCall: (tool: string, params: Record<string, any>) => Promise<any>,
  connection: string,
  target: FingerprintTarget
): Promise<ElementFingerprint | undefined> {
  const expression = `(${fingerprintInPage.toString()})(${JSON.stringify(target)})`;
  const result = await executeToolCall('inspect', { action: 'evaluateExpression', connection, expression }).catch(() => null);
  const value = result?._meta?.inspect?.value;
  return value && typeof value.tag === 'string' ? value : undefined;
}

/** The page-side read behind `readFingerprint`. Serialised into the page, so it reads nothing outside itself. */
function fingerprintInPage(t: any, given?: any): ElementFingerprint | undefined {
  {
    const doc = (globalThis as any).document;
    const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]';
    const IMPLIED: Record<string, string> = {
      button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'img',
    };
    const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const parentOf = (el: any) => el.parentElement ?? (el.parentNode?.host ?? null);

    let el: any = null;
    if (given) {
      el = given;
    } else if ('selector' in t) {
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
    return fingerprint as unknown as ElementFingerprint;
  }
}

/**
 * A selector that resolves to `el` alone, built from what identifies it - a
 * test id, an id, a name, else its tag where that is unique in its scope - as
 * a `host >>> inner` chain through open shadow roots; undefined where some
 * step of the chain has nothing unique. Serialised into the page.
 */
function selectorInPage(el: any): string | undefined {
  const doc = (globalThis as any).document;
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  const esc = (v: string) => (globalThis as any).CSS.escape(v);
  const stepFor = (node: any, scope: any): string | undefined => {
    const tag = node.tagName.toLowerCase();
    const attr = TEST_ATTRS.find(a => node.getAttribute(a));
    const options = [
      attr ? `[${attr}="${esc(node.getAttribute(attr))}"]` : undefined,
      node.id ? `#${esc(node.id)}` : undefined,
      node.getAttribute('name') ? `${tag}[name="${esc(node.getAttribute('name'))}"]` : undefined,
      tag,
    ].filter(Boolean) as string[];
    return options.find(option => scope.querySelectorAll(option).length === 1 && scope.querySelector(option) === node);
  };
  const chain: any[] = [el];
  let root = el.getRootNode();
  while (root && root !== doc && root.host) {
    chain.unshift(root.host);
    root = root.host.getRootNode();
  }
  const steps: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const step = stepFor(chain[i], i === 0 ? doc : chain[i - 1].shadowRoot);
    if (!step) return undefined;
    steps.push(step);
  }
  return steps.join(' >>> ');
}

/**
 * The listener the bench installs while it records a person's input. Each
 * click, each field left after typing into it, and each Enter, Escape or Tab is
 * reported the moment it happens through the `__devharnessInput` binding, with
 * the element's fingerprint and a selector built from it - a point only where
 * nothing identifies the element. A click reads as its nearest interactive
 * ancestor, through shadow roots. devharness's own input runs with
 * `__cdpReplayClickInProgress` set and is not reported.
 */
export function personInputScript(): string {
  return `(() => {
  if (globalThis.__devharnessPersonInput) return;
  globalThis.__devharnessPersonInput = true;
  const fingerprintOf = ${fingerprintInPage.toString()};
  const selectorOf = ${selectorInPage.toString()};
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]';
  const ours = () => globalThis.__cdpReplayClickInProgress === true;
  const send = (input) => { try { globalThis.__devharnessInput(JSON.stringify({ ...input, at: Date.now() })); } catch {} };
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const where = (el, point) => {
    const selector = selectorOf(el);
    return selector ? { selector } : point ? { x: Math.round(point.clientX), y: Math.round(point.clientY) } : {};
  };
  addEventListener('click', (e) => {
    if (ours() || !e.isTrusted) return;
    let el = e.composedPath()[0];
    while (el && el.nodeType === 1 && !el.matches(INTERACTIVE)) el = parentOf(el);
    if (!el || el.nodeType !== 1 || el === document.body) el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    send({ action: 'click', ...where(el, e), fingerprint: fingerprintOf({}, el) });
  }, true);
  const typedInto = new Set();
  // A field that keeps focus never reports on leaving it, so typing that
  // pauses is reported then too.
  const idle = new Map();
  addEventListener('input', (e) => {
    if (ours()) return;
    let el = e.composedPath()[0];
    if (!el || !el.matches) return;
    if (!el.matches('input,textarea,[contenteditable],[contenteditable=true],[contenteditable=""]')) el = el.closest && el.closest('[contenteditable]');
    if (!el) return;
    typedInto.add(el);
    clearTimeout(idle.get(el));
    idle.set(el, setTimeout(() => flush(el), 1000));
  }, true);
  const flush = (el) => {
    if (!typedInto.has(el)) return;
    typedInto.delete(el);
    clearTimeout(idle.get(el));
    idle.delete(el);
    const text = 'value' in el ? el.value : el.textContent;
    send({ action: 'type', ...where(el), text, fingerprint: fingerprintOf({}, el) });
  };
  addEventListener('focusout', (e) => flush(e.composedPath()[0]), true);
  addEventListener('keydown', (e) => {
    if (ours() || !e.isTrusted) return;
    if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') return;
    flush(e.composedPath()[0]);
    send({ action: 'press', key: e.key });
  }, true);
})();`;
}
