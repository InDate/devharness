import { promises as fs } from 'fs';
import { appendEvent } from '../session-events.js';
import { getMessage } from '../messages.js';
import { parseExtendedSelector } from '../utils/selector-resolver.js';
import type { Annotation, AnnotationTarget } from '../annotation.js';
import { request, send, setInspectMode } from './cdp.js';
import { recordedSteps } from './recording.js';
import { type BenchSession, sessions } from './session.js';
import { ownScript } from '../utils/own-script.js';

/**
 * Confirm a reported source position against the file on disk, and correct it
 * where it is wrong.
 *
 * A dev transform reports where it thinks the JSX is, and it is not always
 * right: @vitejs/plugin-react prepends an HMR preamble before computing
 * positions, so its line is shifted by however many lines that preamble took
 * while its column stays correct. The column and the tag are enough to find the
 * real line, and reading the file is the only way to know which of the two the
 * framework gave us.
 */
export async function verifySourceLine(
  source: { fileName: string; lineNumber?: number; columnNumber?: number },
  tag: string,
  readOriginal?: (fileName: string) => Promise<string | null>
): Promise<{ fileName: string; lineNumber?: number; columnNumber?: number; corrected?: boolean }> {
  if (!source.lineNumber || !source.columnNumber) return source;

  // The source map is asked first: it carries sourcesContent, so it answers for
  // a bundled or remote app as well as a local one. Disk is the fallback for a
  // dev server that serves no map.
  let text: string | null = null;
  try {
    text = (await readOriginal?.(source.fileName)) ?? null;
  } catch {
    text = null;
  }
  if (text === null) {
    try {
      text = await fs.readFile(source.fileName, 'utf-8');
    } catch {
      return source;   // nothing can show us the original
    }
  }
  const lines = text.split('\n');

  const opening = `<${tag}`;
  const atColumn = (line: string | undefined) =>
    !!line && line.slice(Math.max(0, source.columnNumber! - 1)).startsWith(opening);

  if (atColumn(lines[source.lineNumber - 1])) return source;

  // Prefer the candidate nearest the reported line: a shifted report is still
  // a report about the same file, and files repeat tags.
  const candidates = lines
    .map((line, index) => (atColumn(line) ? index + 1 : 0))
    .filter(Boolean)
    .sort((a, b) => Math.abs(a - source.lineNumber!) - Math.abs(b - source.lineNumber!));

  if (!candidates.length) return source;
  return { ...source, lineNumber: candidates[0], corrected: true };
}

/**
 * Describe the picked element. A string: it runs in the page, not here.
 * Framework lookup is best-effort by design - every branch degrades to
 * omitting the field rather than failing the pick. Exported so it can be run
 * against a real DOM.
 */
export const DESCRIBE_ELEMENT = `function () {
  var el = this;

  // A selector good enough to point Chrome's overlay at, built mechanically.
  // It may name only where the element sat rather than the element; the
  // material below goes with it, so the selector can be judged against it.
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return '';
    var testId = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test-id'));
    if (testId) return '[data-testid="' + testId + '"]';
    if (node.id) return '#' + CSS.escape(node.id);
    var parts = [];
    var cur = node;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      var part = cur.localName;
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.localName === cur.localName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  var out = { tag: el.localName, selector: selectorFor(el) };

  try {
    var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) out.text = text.slice(0, 200);
  } catch (e) {}
  try {
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) out.testId = testId;
  } catch (e) {}
  try {
    var r = el.getBoundingClientRect();
    out.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  } catch (e) {}

  // React: the fiber is an own key on the DOM node. Walk up to the nearest
  // function component and take whichever dev-build source survives.
  try {
    var fiberKey = Object.keys(el).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
    });
    if (fiberKey) {
      var f = el[fiberKey];
      var hops = 0;
      while (f && hops < 30) {
        if (!out.source && f._debugSource && f._debugSource.fileName) out.source = f._debugSource;
        if (!out.source && f.pendingProps && f.pendingProps.__source) out.source = f.pendingProps.__source;
        if (typeof f.type === 'function') {
          out.component = f.type.displayName || f.type.name || undefined;
          if (out.component) break;
        }
        f = f.return;
        hops++;
      }
    }
  } catch (e) {}

  // Preact keeps no back-pointer on the DOM node - Object.keys(el) is empty -
  // but it does hang the whole vnode tree off the container it rendered into,
  // as an own __k. So find the container above this element and walk down to
  // the vnode whose element is this one, keeping the components passed through.
  try {
    if (!out.component) {
      var container = el;
      while (container && !Object.prototype.hasOwnProperty.call(container, '__k')) {
        container = container.parentElement;
      }
      if (container) {
        // A component vnode shares its element with the host it rendered, so
        // the first match on the way down is the component's *call site*. The
        // host vnode deeper in is the element itself, which is what was clicked.
        var hostSource = null;
        var nearestComponent = null;
        var walk = function (vnode, components, depth) {
          if (!vnode || depth > 60) return;
          var next = components;
          if (typeof vnode.type === 'function') {
            next = vnode.type.displayName || vnode.type.name || components;
          }
          if (vnode.__e === el) {
            if (!nearestComponent) nearestComponent = next;
            if (typeof vnode.type === 'string') {
              hostSource = vnode.__source || (vnode.props && vnode.props.__source) || null;
              nearestComponent = next;
              return;
            }
          }
          var kids = vnode.__k;
          if (Array.isArray(kids)) {
            for (var i = 0; i < kids.length; i++) walk(kids[i], next, depth + 1);
          }
        };
        walk(container.__k, null, 0);
        if (nearestComponent) out.component = nearestComponent;
        if (!out.source && hostSource && hostSource.fileName) out.source = hostSource;
      }
    }
  } catch (e) {}

  return out;
}`;


/** The pick waiting for a comment, if the person has made one. */
export function getPendingPick(connection: string): AnnotationTarget | null {
  return sessions.get(connection)?.pending ?? null;
}

/**
 * An in-page expression returning the element a selector names, or null.
 *
 * A note's selector may carry :has-text(), which DOM.querySelector refuses, so
 * the match is made in the page. One builder serves both the outline and the
 * screenshot clip - two matchers would let the picture and the outline land on
 * different elements.
 */
export function matchExpression(selector: string): string {
  const parsed = parseExtendedSelector(selector);
  if ('error' in parsed || !parsed.textMatch) {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }
  const descendant = parsed.descendantSelector ?? '';
  const wanted = JSON.stringify(parsed.textMatch.value);
  const scope = JSON.stringify(descendant ? (parsed.scopeSelector ?? parsed.baseSelector) : parsed.baseSelector);
  return `(() => {
    const exact = ${JSON.stringify(parsed.textMatch.type !== 'has-text')};
    const descendant = ${JSON.stringify(descendant)};
    for (const el of document.querySelectorAll(${scope})) {
      const text = (el.textContent || '').trim();
      const label = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const hit = exact
        ? (text === ${wanted} || label === ${wanted} || title === ${wanted})
        : [text, label, title].join(' ').toLowerCase().includes(${wanted}.toLowerCase());
      if (!hit) continue;
      const found = descendant ? el.querySelector(descendant) : el;
      if (found) return found;
    }
    return null;
  })()`;
}

/**
 * Outline an annotated element in the page while its row is hovered.
 *
 * Runtime.evaluate and Overlay both answer while V8 is stopped, so this works
 * on a held page, which is the state the pane is used in. An empty selector
 * clears the outline. A selector matching nothing clears it too:
 * the element has moved or gone, and a stale outline over the wrong element
 * reads as a match.
 */
export async function highlightAnnotation(connection: string, selector: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const { client } = session;

  if (!selector) {
    await send(client, 'Overlay.hideHighlight').catch(() => {});
    return;
  }

  // A note's selector may carry :has-text(), which anchors on what an element
  // says rather than where it sits. DOM.querySelector refuses it, so the match
  // is made in the page and the element handed back by object id, which
  // Overlay.highlightNode takes in place of a node id.
  try {
    const expression = matchExpression(selector);
    const { result } = await request(client, 'Runtime.evaluate', { expression: ownScript('annotation', expression), returnByValue: false });
    if (!result?.objectId) {
      await send(client, 'Overlay.hideHighlight').catch(() => {});
      return;
    }
    await send(client, 'Overlay.highlightNode', {
      objectId: result.objectId,
      highlightConfig: {
        contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
        borderColor: { r: 42, g: 112, b: 180, a: 0.9 },
        showInfo: true,
      },
    });
    await send(client, 'Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  } catch {
    // An outline is a convenience: a selector the page will not parse, or a
    // node that went away mid-lookup, leaves the pane working without it.
    await send(client, 'Overlay.hideHighlight').catch(() => {});
  }
}

/**
 * Commit the pending pick with the comment typed in the bench.
 *
 * The note is stored in the open sequence, against the step on screen. During a
 * recording it is held against the recorded step until the recording lands.
 * With neither there is nowhere for it to go: the pick is held rather than
 * discarded, so the same pick saves once a sequence is selected, and the pane
 * states why on its failure line.
 */
export async function saveAnnotation(connection: string, comment: string): Promise<Annotation | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  // A note with no element is a note about the step, which is a thing people
  // write: "this one is flaky", "this is the wrong order". Refusing it unless
  // something was picked lost the note without saying so.
  if (!session.pending && !comment.trim()) return undefined;

  const target = session.pending ?? undefined;
  const annotation: Annotation = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    url: session.page.url(),
    tick: session.tickMs,
    comment,
    ...(target ? { target } : {}),
    ...(session.pickShots?.length ? { screenshots: [...session.pickShots] } : {}),
  };

  const place = session.recordingSequence && session.sequences
    ? await holdRecordingAnnotation(session, annotation)
    : await attachToOpenSequence(session, annotation);
  if ('failure' in place) {
    session.sequenceFailure = place.failure;
    return undefined;
  }

  session.pending = null;
  session.pickShots = [];
  session.noteStep = undefined;
  session.sequenceFailure = undefined;
  const firstOfSession = session.annotations === 0;
  session.annotations++;
  await appendEvent(session.session, 'annotation', {
    annotationId: annotation.id,
    connection,
    url: annotation.url,
    tick: annotation.tick,
    comment: annotation.comment,
    ...(target
      ? {
        selector: target.selector,
        // Once per session: on every note it buries the notes.
        ...(firstOfSession ? { review: getMessage('BENCH_SELECTOR_REVIEW') } : {}),
        component: target.component,
        source: target.source?.fileName,
      }
      : {}),
    sequence: `${place.name} step ${place.step + 1}/${place.total}`,
    detail: target
      ? `${target.component ? target.component + ' ' : ''}${target.selector}${comment ? ` - "${comment}"` : ''}`
      : `about the step${comment ? ` - "${comment}"` : ''}`,
  });

  // The note is written, so the pick that began it is over: left armed, the
  // next click in the app becomes a pick and never reaches the page.
  await setInspectMode(session, false).catch(() => {});
  return annotation;
}

type NotePlace = { name: string; step: number; total: number } | { failure: string };

async function attachToOpenSequence(session: BenchSession, annotation: Annotation): Promise<NotePlace> {
  const active = session.sequences?.active();
  // Nothing to attach to yet. The pick and its captures are held rather than
  // dropped, so selecting a sequence and saving again keeps them.
  if (!active) return { failure: 'no sequence open - a note is stored in the step it belongs to' };
  const step = noteTargetStep(session, active.currentStep, active.total);
  const failure = await session.sequences!.attachAnnotation(step, annotation);
  return failure ? { failure } : { name: active.name, step, total: active.total };
}

/**
 * Keep a finding against the recorded step it was written at until the
 * recording lands, when flushRecordingNotes writes it onto the file.
 */
async function holdRecordingAnnotation(session: BenchSession, annotation: Annotation): Promise<NotePlace> {
  const total = (await recordedSteps(session)).length;
  if (total === 0) return { failure: 'nothing recorded yet - a note is stored in the step it belongs to' };
  const step = noteTargetStep(session, total, total);
  const held = session.recordingAnnotations ?? new Map<number, Annotation[]>();
  session.recordingAnnotations = held;
  held.set(step, [...(held.get(step) ?? []), annotation]);
  return { name: session.recordingName ?? 'the recording', step, total };
}

/** A finding held by the recording in progress, and the step it is held at. */
export function heldAnnotation(session: BenchSession, id: string): { annotation: Annotation; step: number } | undefined {
  for (const [step, notes] of session.recordingAnnotations ?? []) {
    const annotation = notes.find(note => note.id === id);
    if (annotation) return { annotation, step };
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * Decisions about traffic.
 *
 * A rule outlives the event that prompted it and the run that carried it: the
 * events are a reading of one pass, and the rule is what every later pass
 * should do. Held on the session until someone writes it onto the sequence.
 * ------------------------------------------------------------------------- */

/** The step a pick would land on, so the bench opens its composer there. */
export async function noteTargetFor(connection: string): Promise<number | undefined> {
  const session = sessions.get(connection);
  if (session?.recordingSequence && session.sequences) {
    const total = (await recordedSteps(session)).length;
    return total > 0 ? noteTargetStep(session, total, total) : undefined;
  }
  const active = session?.sequences?.active();
  if (!session || !active) return undefined;
  return noteTargetStep(session, active.currentStep, active.total);
}

/**
 * The pen names a step; without one the run's own step is used, clamped - a
 * completed run sits one past its last command. The pane reads this too, or it
 * would state one step and save to another.
 */
function noteTargetStep(session: BenchSession, currentStep: number, total: number): number {
  const wanted = session.noteStep ?? currentStep;
  return Math.min(Math.max(wanted, 0), Math.max(0, total - 1));
}

/** Aim the next note at a step and arm the picker. */
export async function noteAtStep(connection: string, step: number): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  session.noteStep = Math.max(0, step);
  session.sequenceFailure = undefined;
  await setInspectMode(session, true).catch(() => {});
}

/** Put one note on the session event stream, on demand. */
export async function notifyAnnotation(connection: string, id: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;

  const held = heldAnnotation(session, id);
  const found = held
    ? { ...held, sequence: session.recordingName ?? 'the recording' }
    : session.sequences.findAnnotation(id);
  if (!found) {
    session.sequenceFailure = 'that note is not in the open sequence';
    return;
  }

  const { annotation, step, sequence } = found;
  session.sequenceFailure = undefined;
  await appendEvent(session.session, 'annotation', {
    annotationId: annotation.id,
    connection,
    notify: true,
    url: annotation.url,
    tick: annotation.tick,
    comment: annotation.comment,
    ...(annotation.target
      ? {
        selector: annotation.target.selector,
        component: annotation.target.component,
        source: annotation.target.source?.fileName,
      }
      : {}),
    sequence: `${sequence} step ${step + 1}`,
    review: getMessage('BENCH_NOTIFY_REVIEW'),
    detail: `look at this: ${annotation.comment || '(no comment)'}`
      + (annotation.target ? ` - ${annotation.target.selector}` : ' - about the step itself'),
  });
}

/** Carry one note to another step, and write the sequence back. */
export async function moveAnnotation(connection: string, id: string, step: number, after?: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const held = heldAnnotation(session, id);
  if (held) {
    dropHeldAnnotation(session, id);
    if (after === undefined) delete held.annotation.after;
    else held.annotation.after = after;
    const notes = session.recordingAnnotations!;
    notes.set(step, [...(notes.get(step) ?? []), held.annotation]);
    session.sequenceFailure = undefined;
    return;
  }
  const failure = await session.sequences.moveAnnotation(id, step, after).catch(error => String(error));
  session.sequenceFailure = failure;
}

/** Replace one note's words: in memory while a recording holds it, in the file once it is saved. */
export async function rewordAnnotation(connection: string, id: string, words: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const held = heldAnnotation(session, id);
  if (held) {
    held.annotation.comment = words;
    return;
  }
  session.sequenceFailure = await session.sequences.rewordAnnotation(id, words).catch(error => String(error));
}

/** Returns no failure: a held finding is removed from memory, with no write to refuse it. */
function dropHeldAnnotation(session: BenchSession, id: string): undefined {
  for (const [step, notes] of session.recordingAnnotations ?? []) {
    const kept = notes.filter(note => note.id !== id);
    if (kept.length) session.recordingAnnotations!.set(step, kept);
    else session.recordingAnnotations!.delete(step);
  }
  return undefined;
}

/** Erase one note: from memory while a recording holds it, from the file once it is saved. */
export async function removeAnnotation(connection: string, id: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  const failure = heldAnnotation(session, id)
    ? dropHeldAnnotation(session, id)
    : await session.sequences.detachAnnotation(id).catch(error => String(error));
  session.sequenceFailure = failure;
  if (!failure && session.annotations > 0) session.annotations--;
}

export async function discardPick(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  session.pending = null;
  session.noteStep = undefined;
  session.pickShots = [];
  await setInspectMode(session, true).catch(() => {});
}
