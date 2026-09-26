/**
 * What an element is, beyond how it looks: the handlers that reach it, the
 * rules that style it, its markup and what assistive technology reads from it.
 *
 * Read through DOM, CSS, DOMDebugger and Accessibility, which the browser
 * answers while the page's JS is held, so the facts belong to the same frozen
 * moment as the picture.
 *
 * Each reading is bounded: a failed or unanswered call leaves that fact out and
 * notes it under `unread`, rather than failing the capture it goes with.
 */

import type { CDPSession } from 'puppeteer-core';
import type { FactKind } from './bench/wire.js';

export interface ListenerFact {
  /** `self`, an ancestor as `tag#id.class (n up)`, `document` or `window`. */
  on: string;
  type: string;
  capture?: boolean;
  passive?: boolean;
  once?: boolean;
  fn?: string;
  url?: string;
  line?: number;
  /** Set on a line standing for many listeners on one node, which a framework root carries. */
  count?: number;
}

export interface RuleFact {
  selector: string;
  source?: string;
  origin: string;
  properties: Array<{ name: string; value: string; applied: boolean }>;
}

export interface CssFact {
  rules: RuleFact[];
  inline?: Array<{ name: string; value: string }>;
  /** Computed values for every property a rule sets, plus the layout ones. */
  computed: Record<string, string>;
  box?: { content: Rect; padding: Rect; border: Rect; margin: Rect };
  /** What the browser hits at the element's centre, when that is not the element or inside it. */
  coveredBy?: string;
  fonts?: string[];
}

export interface A11yFact {
  role?: string;
  name?: string;
  ignored?: boolean;
  states: Record<string, string>;
}

export interface ElementFacts {
  events?: ListenerFact[];
  css?: CssFact;
  html?: string;
  a11y?: A11yFact;
  /** Facts asked for and not read, with the reason. */
  unread?: Record<string, string>;
}

interface Rect { x: number; y: number; w: number; h: number; }

/** Always carried in `computed`: what places and sizes the element, which a rule may leave to default. */
const LAYOUT = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border-width',
  'overflow', 'z-index', 'transform', 'opacity', 'visibility', 'top', 'left', 'right', 'bottom',
];

/** More listeners than this on one ancestor is a framework's delegation root. */
const DELEGATION_ROOT = 6;

const HTML_LIMIT = 20_000;

async function call(client: CDPSession, method: string, params: any, timeoutMs = 3000): Promise<any> {
  return Promise.race([
    client.send(method as any, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}

/** `div#root.app` - a node named the way a selector would. */
function nodeName(node: { localName?: string; nodeName?: string; attributes?: string[] }): string {
  const attrs = new Map<string, string>();
  for (let i = 0; i + 1 < (node.attributes ?? []).length; i += 2) attrs.set(node.attributes![i], node.attributes![i + 1]);
  const id = attrs.get('id');
  const cls = attrs.get('class')?.trim().split(/\s+/)[0];
  return `${node.localName || node.nodeName?.toLowerCase() || 'node'}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}`;
}

async function readEvents(
  client: CDPSession, objectId: string, scripts: Map<string, string>,
): Promise<ListenerFact[]> {
  const found: ListenerFact[] = [];
  let current: string | undefined = objectId;
  let up = 0;
  while (current) {
    const { listeners = [] } = await call(client, 'DOMDebugger.getEventListeners', { objectId: current, depth: 0 });
    const described = await call(client, 'DOM.describeNode', { objectId: current }).catch(() => undefined);
    const node = described?.node;
    const on = up === 0 ? 'self'
      : node?.nodeName === '#document' ? 'document'
      : `${nodeName(node ?? {})} (${up} up)`;
    if (up > 0 && listeners.length > DELEGATION_ROOT) {
      const types = [...new Set(listeners.map((l: any) => l.type))].sort();
      found.push({ on, type: types.slice(0, 8).join(' ') + (types.length > 8 ? ' …' : ''), count: listeners.length });
    } else {
      for (const l of listeners) {
        const url = l.scriptId ? scripts.get(l.scriptId) : undefined;
        const fn = typeof l.handler?.description === 'string'
          ? l.handler.description.split('\n')[0].slice(0, 80) : undefined;
        found.push({
          on, type: l.type,
          ...(l.useCapture ? { capture: true } : {}),
          ...(l.passive ? { passive: true } : {}),
          ...(l.once ? { once: true } : {}),
          ...(fn ? { fn } : {}),
          ...(url ? { url } : {}),
          ...(typeof l.lineNumber === 'number' ? { line: l.lineNumber + 1 } : {}),
        });
      }
    }
    const parent: any = await call(client, 'Runtime.callFunctionOn', {
      objectId: current,
      functionDeclaration: 'function () { return this.parentNode; }',
    });
    if (up > 0 && current !== objectId) await call(client, 'Runtime.releaseObject', { objectId: current }).catch(() => {});
    current = parent?.result?.objectId;
    up++;
  }
  const win: any = await call(client, 'Runtime.evaluate', { expression: 'window' });
  if (win?.result?.objectId) {
    const { listeners = [] } = await call(client, 'DOMDebugger.getEventListeners', { objectId: win.result.objectId, depth: 0 });
    if (listeners.length > DELEGATION_ROOT) {
      const types = [...new Set(listeners.map((l: any) => l.type))].sort();
      found.push({ on: 'window', type: types.slice(0, 8).join(' ') + (types.length > 8 ? ' …' : ''), count: listeners.length });
    } else {
      for (const l of listeners) found.push({ on: 'window', type: l.type, ...(typeof l.lineNumber === 'number' ? { line: l.lineNumber + 1 } : {}) });
    }
    await call(client, 'Runtime.releaseObject', { objectId: win.result.objectId }).catch(() => {});
  }
  return found;
}

/**
 * Stylesheet URLs by id, filled from CSS.styleSheetAdded.
 *
 * CSS.enable goes unanswered while the page's JS is held, and the rules are
 * read on a held page. So the CSS domain is enabled while the page runs - when
 * the bench opens - and this map is kept from then on.
 */
export type StyleSheets = Map<string, string>;

export async function trackStyleSheets(client: CDPSession, sheets: StyleSheets): Promise<void> {
  client.on('CSS.styleSheetAdded' as any, (event: any) => {
    const header = event?.header;
    if (header?.styleSheetId) sheets.set(header.styleSheetId, header.sourceURL || header.origin);
  });
  await call(client, 'CSS.enable', {});
}

async function readCss(client: CDPSession, objectId: string, sheets: StyleSheets): Promise<CssFact> {
  await call(client, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await call(client, 'DOM.requestNode', { objectId });

  const matched: any = await call(client, 'CSS.getMatchedStylesForNode', { nodeId });
  const written = (style: any) => (style?.cssProperties ?? [])
    .filter((p: any) => p.text && !p.disabled)
    .map((p: any) => ({ name: p.name, value: p.value }));

  // Later rules in the list win, and inline beats every rule; an !important
  // declaration beats a later one without it. Walked from the back, the first
  // declaration of a name to be seen is the one applied.
  const inline = written(matched.inlineStyle);
  const taken = new Set<string>(inline.map((p: any) => p.name));
  const importantTaken = new Set<string>();
  const rules: RuleFact[] = [];
  for (const entry of [...(matched.matchedCSSRules ?? [])].reverse()) {
    const rule = entry.rule;
    if (rule.origin === 'user-agent') continue;
    const sheet = rule.styleSheetId ? sheets.get(rule.styleSheetId) : undefined;
    const line = rule.style?.range ? rule.style.range.startLine + 1 : undefined;
    const properties = (rule.style?.cssProperties ?? [])
      .filter((p: any) => p.text && !p.disabled)
      .map((p: any) => {
        const important = !!p.important;
        const applied = important ? !importantTaken.has(p.name) : !taken.has(p.name) && !importantTaken.has(p.name);
        taken.add(p.name);
        if (important) importantTaken.add(p.name);
        return { name: p.name, value: p.value + (important ? ' !important' : ''), applied };
      });
    rules.unshift({
      selector: rule.selectorList?.text ?? '',
      ...(sheet ? { source: `${sheet}${line !== undefined ? `:${line}` : ''}` } : {}),
      origin: rule.origin,
      properties,
    });
  }

  const wanted = new Set([...LAYOUT, ...taken]);
  const { computedStyle = [] } = await call(client, 'CSS.getComputedStyleForNode', { nodeId });
  const computed: Record<string, string> = {};
  for (const { name, value } of computedStyle) if (wanted.has(name)) computed[name] = value;

  const css: CssFact = { rules, ...(inline.length ? { inline } : {}), computed };

  const model: any = await call(client, 'DOM.getBoxModel', { nodeId }).catch(() => undefined);
  if (model?.model) {
    const rect = (quad: number[]): Rect => ({ x: quad[0], y: quad[1], w: quad[2] - quad[0], h: quad[5] - quad[1] });
    css.box = {
      content: rect(model.model.content), padding: rect(model.model.padding),
      border: rect(model.model.border), margin: rect(model.model.margin),
    };
    const border = css.box.border;
    const hit: any = await call(client, 'DOM.getNodeForLocation', {
      x: Math.round(border.x + border.w / 2), y: Math.round(border.y + border.h / 2),
      includeUserAgentShadowDOM: false, ignorePointerEventsNone: false,
    }).catch(() => undefined);
    if (hit?.backendNodeId) {
      const resolved: any = await call(client, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId }).catch(() => undefined);
      const other = resolved?.object?.objectId;
      if (other) {
        const inside: any = await call(client, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function (other) { return this === other || this.contains(other); }',
          arguments: [{ objectId: other }],
          returnByValue: true,
        }).catch(() => undefined);
        if (inside?.result?.value === false) {
          const described: any = await call(client, 'DOM.describeNode', { objectId: other }).catch(() => undefined);
          css.coveredBy = nodeName(described?.node ?? {});
        }
        await call(client, 'Runtime.releaseObject', { objectId: other }).catch(() => {});
      }
    }
  }

  const fonts: any = await call(client, 'CSS.getPlatformFontsForNode', { nodeId }).catch(() => undefined);
  if (fonts?.fonts?.length) css.fonts = fonts.fonts.map((f: any) => f.familyName);
  return css;
}

/**
 * The element's markup, whole when it is short. Past the limit the subtree is
 * cut below three levels, each cut replaced by a count of what it held, so a
 * table of thousands of rows still shows its structure.
 */
async function readHtml(client: CDPSession, objectId: string): Promise<string> {
  const { outerHTML } = await call(client, 'DOM.getOuterHTML', { objectId });
  if (outerHTML.length <= HTML_LIMIT) return outerHTML;
  const cut: any = await call(client, 'Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      var copy = this.cloneNode(true);
      (function trim(node, depth) {
        for (var i = 0; i < node.children.length; i++) {
          var child = node.children[i];
          if (depth >= 3 && child.children.length) {
            var n = child.querySelectorAll('*').length;
            child.innerHTML = '';
            child.appendChild(document.createComment(' ' + n + ' elements '));
          } else {
            trim(child, depth + 1);
          }
        }
      })(copy, 1);
      return copy.outerHTML;
    }`,
  });
  const html = String(cut?.result?.value ?? outerHTML);
  return html.length <= HTML_LIMIT ? html : `${html.slice(0, HTML_LIMIT)}<!-- ${html.length - HTML_LIMIT} more characters -->`;
}

async function readA11y(client: CDPSession, objectId: string): Promise<A11yFact> {
  const { nodes = [] } = await call(client, 'Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  const node = nodes[0] ?? {};
  const states: Record<string, string> = {};
  for (const p of node.properties ?? []) states[p.name] = String(p.value?.value);
  return {
    ...(node.role?.value ? { role: String(node.role.value) } : {}),
    ...(node.name?.value ? { name: String(node.name.value) } : {}),
    ...(node.ignored ? { ignored: true } : {}),
    states,
  };
}

/**
 * Read the facts asked for about the element `objectId` names. `scripts` maps
 * a script id to its URL, which a listener names its handler's script by;
 * `sheets` does the same for a rule's stylesheet.
 */
export async function readFacts(
  client: CDPSession, objectId: string, kinds: FactKind[],
  known: { scripts: Map<string, string>; sheets: StyleSheets },
): Promise<ElementFacts> {
  const facts: ElementFacts = {};
  const unread: Record<string, string> = {};
  const readers: Record<FactKind, () => Promise<void>> = {
    events: async () => { facts.events = await readEvents(client, objectId, known.scripts); },
    css: async () => { facts.css = await readCss(client, objectId, known.sheets); },
    html: async () => { facts.html = await readHtml(client, objectId); },
    a11y: async () => { facts.a11y = await readA11y(client, objectId); },
  };
  for (const kind of kinds) {
    await readers[kind]().catch((error) => { unread[kind] = error instanceof Error ? error.message : String(error); });
  }
  if (Object.keys(unread).length) facts.unread = unread;
  return facts;
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

const listenerKey = (l: ListenerFact) => `${l.type} on ${l.on}${l.count ? ` ×${l.count}` : ''}${l.fn ? ` ${l.fn}` : ''}`;

/** The source of the rule that sets `name` in `css`, for a change line to cite. */
function sourceOf(css: CssFact, name: string): string | undefined {
  for (const rule of css.rules) {
    if (rule.properties.some(p => p.name === name && p.applied)) return rule.source;
  }
  return undefined;
}

function rectText(r: Rect): string {
  return `${Math.round(r.w)}×${Math.round(r.h)} at ${Math.round(r.x)},${Math.round(r.y)}`;
}

/** One line per fact that changed between two readings, empty when none did. */
export function diffFacts(before: ElementFacts, after: ElementFacts): string[] {
  const lines: string[] = [];

  if (before.events && after.events) {
    const a = new Set(before.events.map(listenerKey));
    const b = new Set(after.events.map(listenerKey));
    for (const key of b) if (!a.has(key)) lines.push(`events: +${key}`);
    for (const key of a) if (!b.has(key)) lines.push(`events: -${key}`);
  }

  if (before.css && after.css) {
    const names = new Set([...Object.keys(before.css.computed), ...Object.keys(after.css.computed)]);
    for (const name of names) {
      const was = before.css.computed[name];
      const now = after.css.computed[name];
      if (was === now) continue;
      const source = sourceOf(after.css, name) ?? sourceOf(before.css, name);
      lines.push(`css: ${name} ${was ?? '(unset)'} → ${now ?? '(unset)'}${source ? ` (${source})` : ''}`);
    }
    const boxA = before.css.box?.border;
    const boxB = after.css.box?.border;
    if (boxA && boxB && rectText(boxA) !== rectText(boxB)) lines.push(`css: border box ${rectText(boxA)} → ${rectText(boxB)}`);
    if (before.css.coveredBy !== after.css.coveredBy) {
      lines.push(`css: covered by ${before.css.coveredBy ?? 'nothing'} → ${after.css.coveredBy ?? 'nothing'}`);
    }
    const fontsA = (before.css.fonts ?? []).join(', ');
    const fontsB = (after.css.fonts ?? []).join(', ');
    if (fontsA !== fontsB) lines.push(`css: rendered font ${fontsA || 'none'} → ${fontsB || 'none'}`);
  }

  if (before.html !== undefined && after.html !== undefined && before.html !== after.html) {
    let start = 0;
    while (start < before.html.length && before.html[start] === after.html[start]) start++;
    let endA = before.html.length;
    let endB = after.html.length;
    while (endA > start && endB > start && before.html[endA - 1] === after.html[endB - 1]) { endA--; endB--; }
    const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s) || '(nothing)';
    lines.push(`html: "${clip(before.html.slice(start, endA))}" → "${clip(after.html.slice(start, endB))}" at character ${start}`);
  }

  if (before.a11y && after.a11y) {
    if (before.a11y.role !== after.a11y.role) lines.push(`a11y: role ${before.a11y.role ?? 'none'} → ${after.a11y.role ?? 'none'}`);
    if (before.a11y.name !== after.a11y.name) lines.push(`a11y: name "${before.a11y.name ?? ''}" → "${after.a11y.name ?? ''}"`);
    if (!!before.a11y.ignored !== !!after.a11y.ignored) lines.push(`a11y: ${after.a11y.ignored ? 'now hidden from' : 'now exposed to'} assistive technology`);
    const states = new Set([...Object.keys(before.a11y.states), ...Object.keys(after.a11y.states)]);
    for (const s of states) {
      if (before.a11y.states[s] !== after.a11y.states[s]) {
        lines.push(`a11y: ${s} ${before.a11y.states[s] ?? '(unset)'} → ${after.a11y.states[s] ?? '(unset)'}`);
      }
    }
  }

  return lines;
}
