import { promises as fs } from 'fs';
import { basename, join } from 'path';
import type { CDPSession } from 'puppeteer-core';
import { getOutputPath } from '../helpers/paths.js';
import { appendEvent } from '../session-events.js';
import { debugLog } from '../debug-logger.js';
import type { CaptureComparison, CaptureKind, CapturePause, CaptureRecord, CaptureRect, CaptureVersion, FactKind, PendingShot, SequenceState } from '../bench/wire.js';
import { cropPixels, decodePng } from '../png.js';
import { diffPixels, sideBySide, strokeDashed } from '../pixel-diff.js';
import { indexCapture, readCapture, readRecord, seriesIndex, versionsOf, writeCapture } from '../capture-file.js';
import { diffFacts, readFacts, type ElementFacts } from '../element-facts.js';
import { DESCRIBE_ELEMENT, heldAnnotation, matchExpression } from './annotations.js';
import { request, send, setInspectMode } from './cdp.js';
import { describePause, holdUi, releaseUi } from './page-hold.js';
import { type BenchSession, type CaptureContext, sessions } from './session.js';

/**
 * Every capture a live session still holds, by path.
 *
 * A capture taken and not yet saved belongs to no annotation, so a sweep
 * reading the sequences alone would call it unreferenced and delete the
 * picture out from under the draft that is about to cite it.
 */
export function capturesInFlight(): string[] {
  const held: string[] = [];
  for (const session of sessions.values()) {
    for (const file of session.pickShots ?? []) held.push(file);
    for (const notes of session.recordingAnnotations?.values() ?? []) {
      for (const note of notes) held.push(...(note.screenshots ?? []));
    }
  }
  return held;
}

/** The window, where it is scrolled to, and the document's size, in CSS px. */
interface Layout {
  viewport: { width: number; height: number; dpr: number };
  scroll: { x: number; y: number };
  document: { width: number; height: number };
}

/**
 * Read from Page.getLayoutMetrics, which the browser answers on a held page.
 * The pixel ratio comes from the page: a capture's pixels are CSS px times it,
 * and every rectangle in a record is kept in CSS px so a retake on another
 * display still lands on the same region.
 */
async function layoutOf(session: BenchSession): Promise<Layout> {
  const metrics = await request(session.client, 'Page.getLayoutMetrics');
  const css = metrics.cssLayoutViewport;
  const ratio = await request(session.client, 'Runtime.evaluate', {
    expression: 'devicePixelRatio', returnByValue: true,
  }).catch(() => undefined);
  return {
    viewport: { width: css.clientWidth, height: css.clientHeight, dpr: Number(ratio?.result?.value) || 1 },
    scroll: { x: css.pageX, y: css.pageY },
    document: { width: Math.round(metrics.cssContentSize.width), height: Math.round(metrics.cssContentSize.height) },
  };
}

/** Where the page's JS stands, for a capture to carry. */
function pauseOf(session: BenchSession): CapturePause {
  const event = session.pausedEvent;
  if (!session.pauseTaken || !event) return { taken: false };
  const entry = describePause(session, event, 0);
  const by = event.hitBreakpoints?.length ? 'breakpoint'
    : session.pauseRequested && !session.heldByOther ? 'bench'
    : event.reason === 'other' ? 'debugger statement'
    : String(event.reason ?? 'other');
  return {
    taken: true,
    ...(entry.fn ? { fn: entry.fn } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.line !== undefined ? { line: entry.line } : {}),
    by,
  };
}

/**
 * Open the capture dialog: hold the page and arm the picker for a capture.
 *
 * A hold already on is recorded, so closing the dialog releases only the
 * hold the dialog made. Opened from a note, the capture taken joins that note.
 */
export async function beginCapture(connection: string, annotationId?: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const heldBefore = session.shotArmed?.heldBefore ?? session.frozen;
  session.pendingShot = null;
  session.pendingCapture = undefined;
  await holdUi(session);
  session.shotArmed = { heldBefore, ...(annotationId ? { annotationId } : {}) };
  await setInspectMode(session, true);
}

/** Close the dialog with nothing taken. */
export async function cancelCapture(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.shotArmed) return;
  const { heldBefore } = session.shotArmed;
  session.shotArmed = undefined;
  await setInspectMode(session, false).catch(() => {});
  if (!heldBefore) await releaseUi(session);
}

/** Release a hold the capture dialog made, once its capture is saved or dropped. */
async function endCaptureHold(session: BenchSession, heldBefore: boolean | undefined): Promise<void> {
  if (heldBefore === false) await releaseUi(session);
}

export function setFactChoice(connection: string, kinds: FactKind[]): void {
  const session = sessions.get(connection);
  if (session) session.factChoice = kinds;
}

/**
 * Read element facts the held capture was taken without, and keep them with it.
 *
 * The capture dialog's page hold lasts until the draft is saved, so facts read
 * now belong to the same moment as the picture. Also becomes the dialog's
 * choice, so the next element capture reads them from the start.
 */
export async function readMoreFacts(connection: string, kinds: FactKind[]): Promise<void> {
  const session = sessions.get(connection);
  const shot = session?.pendingShot;
  const context = session?.pendingCapture;
  if (!session || !shot || !context || shot.kind !== 'element' || !shot.selector) return;
  session.factChoice = [...new Set([...session.factChoice, ...kinds])];
  const missing = kinds.filter(kind => !shot.facts.includes(kind));
  if (!missing.length) return;
  const objectId = await elementObject(session, shot.selector, shot.widen);
  if (!objectId) {
    session.sequenceFailure = `\`${shot.selector}\` no longer matches an element, so its ${missing.join(', ')} could not be read`;
    return;
  }
  try {
    const read = await readFacts(session.client, objectId, missing, { scripts: session.scripts, sheets: session.sheets });
    const { unread, ...found } = read;
    context.facts = {
      ...context.facts, ...found,
      ...(unread || context.facts?.unread ? { unread: { ...context.facts?.unread, ...unread } } : {}),
    };
    shot.facts = [...shot.facts, ...missing.filter(kind => !unread?.[kind])];
  } finally {
    await send(session.client, 'Runtime.releaseObject', { objectId });
  }
}

/** The element a selector names, walked out by `widen`, as a remote object. */
async function elementObject(session: BenchSession, selector: string, widen: number): Promise<string | undefined> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression: `(() => {
      let el = ${matchExpression(selector)};
      if (!el) return null;
      for (let out = 0; out < ${Math.max(0, Math.trunc(widen))}; out++) {
        if (!el.parentElement || el.parentElement === document.body) break;
        el = el.parentElement;
      }
      return el;
    })()`,
    returnByValue: false,
  }).catch(() => ({ result: undefined }));
  return result?.objectId;
}

/**
 * The page's own CDP session, which Puppeteer sized the viewport through.
 *
 * Chrome keeps a size override per session and a clipped or beyond-viewport
 * capture applies the capturing session's own for its duration: sent from the
 * bench's session, it drops the size a headless launch set, and the element is
 * captured laid out at the bare window's width. Captures and the retake's
 * resize go through the session holding that size instead.
 */
function pageSession(session: BenchSession): CDPSession {
  const own = (session.page as unknown as { _client?: () => CDPSession })._client?.();
  return own ?? session.client;
}

/**
 * A clip's `scale` multiplies the device scale factor, so scale 1 returns the
 * element at the display's own resolution, as the window and page captures are.
 */
async function shoot(
  session: BenchSession,
  kind: CaptureKind,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<string | undefined> {
  const shot = await request(pageSession(session), 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: kind === 'page',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  }, 10_000);
  return shot?.data;
}

/**
 * Take a capture and hold it; saveBenchScreenshot writes it once accepted.
 *
 * `element` clips to the box a selector names, walked out `widen` parents;
 * `screen` is what the window shows; `page` is the whole document, with the
 * window's rectangle offered as a mark when `viewportMark` is set.
 */
export async function captureBenchScreenshot(
  connection: string,
  ask: {
    kind: CaptureKind;
    selector?: string;
    widen?: number;
    annotationId?: string;
    viewportMark?: boolean;
    /** From the dialog: whether the page was held before it opened. */
    heldBefore?: boolean;
  },
): Promise<{ shot: PendingShot } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session) return { failure: 'the bench is not open here' };
  const widen = ask.widen ?? 0;
  // A widen re-takes the capture already open, which keeps the dialog's hold.
  const heldBefore = ask.heldBefore ?? session.pendingCapture?.heldBefore;

  try {
    const layout = await layoutOf(session);
    let label = ask.kind === 'screen' ? 'the window as shown' : 'the whole page';
    let element: CaptureContext['element'];
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (ask.kind === 'element') {
      if (!ask.selector) return { failure: 'an element capture needs a selector' };
      const box = await elementBox(session, ask.selector, widen);
      if (!box) return { failure: `nothing on the page matches \`${ask.selector}\`` };
      clip = { x: box.x, y: box.y, width: box.width, height: box.height };
      label = widen > 0 ? `${box.tag} - ${widen} out from ${ask.selector}` : ask.selector;
      element = {
        selector: ask.selector, widen, tag: box.tag,
        box: { x: box.x, y: box.y, w: box.width, h: box.height },
      };
    }

    const data = await shoot(session, ask.kind, clip);
    if (!data) return { failure: 'the page returned no image' };

    let facts: ElementFacts | undefined;
    const kinds = ask.kind === 'element' ? session.factChoice : [];
    if (kinds.length && ask.selector) {
      const objectId = await elementObject(session, ask.selector, widen);
      if (objectId) {
        facts = await readFacts(session.client, objectId, kinds, { scripts: session.scripts, sheets: session.sheets });
        await send(session.client, 'Runtime.releaseObject', { objectId });
      }
    }

    // IHDR's width, read without decoding the image.
    const scale = imageScale({ width: Buffer.from(data, 'base64').readUInt32BE(16) }, ask.kind, layout, element?.box.w);
    const viewportMark = ask.kind === 'page' && ask.viewportMark
      ? {
        x: layout.scroll.x * scale, y: layout.scroll.y * scale,
        w: layout.viewport.width * scale, h: layout.viewport.height * scale,
      }
      : undefined;
    const pause = pauseOf(session);

    session.pendingShot = {
      data, widen, label, kind: ask.kind, pause,
      facts: facts ? kinds.filter(kind => !facts!.unread?.[kind]) : [],
      ...(ask.selector && ask.kind === 'element' ? { selector: ask.selector } : {}),
      ...(ask.annotationId ? { annotationId: ask.annotationId } : {}),
      ...(viewportMark ? { viewportMark } : {}),
    };
    session.pendingCapture = {
      layout,
      url: session.page.url(),
      frozen: session.frozen,
      ...(element ? { element } : {}),
      ...(facts ? { facts } : {}),
      ...(heldBefore !== undefined ? { heldBefore } : {}),
    };
    return { shot: session.pendingShot };
  } catch (error) {
    return { failure: String(error) };
  }
}

/**
 * The smallest element holding a region of the document, and the region's
 * offset from its corner.
 *
 * A screen or page crop stored only as coordinates lands on other content once
 * anything above it changes height. Stored against the element around it, the
 * crop moves with that element.
 */
async function anchorFor(
  session: BenchSession,
  region: { x: number; y: number; w: number; h: number },
): Promise<CaptureRecord['anchor'] | undefined> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression: `(() => {
      const r = ${JSON.stringify(region)};
      let best = null, area = Infinity;
      for (const el of document.body.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        const x = b.left + scrollX, y = b.top + scrollY;
        if (x > r.x || y > r.y || x + b.width < r.x + r.w || y + b.height < r.y + r.h) continue;
        if (b.width * b.height < area) { best = el; area = b.width * b.height; }
      }
      return best || document.body;
    })()`,
    returnByValue: false,
  }).catch(() => ({ result: undefined }));
  const objectId = result?.objectId;
  if (!objectId) return undefined;
  try {
    const described = await request(session.client, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: DESCRIBE_ELEMENT, returnByValue: true,
    });
    const selector = described?.result?.value?.selector;
    if (typeof selector !== 'string' || !selector) return undefined;
    const box = await elementBox(session, selector, 0);
    if (!box) return undefined;
    return { selector, offset: { x: region.x - box.x, y: region.y - box.y } };
  } finally {
    await send(session.client, 'Runtime.releaseObject', { objectId });
  }
}

/** Write a held capture, with its record, and announce it. */
export async function saveBenchScreenshot(
  connection: string,
  /**
   * The capture with marks drawn on it, as a base64 PNG.
   *
   * Written in place of the raw capture, so what reaches whoever reads the
   * file is the picture with the box around the thing being pointed at. Marks
   * kept beside the image would have to be composited by every reader, and a
   * reader that did not know about them would see an unmarked page.
   */
  marked?: string,
  /** The region kept, in the raw capture's pixels. */
  crop?: CaptureRect,
  /** The element facts to keep, of those read; all of them when absent. */
  keepFacts?: FactKind[],
): Promise<{ path: string } | { failure: string }> {
  const session = sessions.get(connection);
  const shot = session?.pendingShot;
  const context = session?.pendingCapture;
  if (!session || !shot || !context) return { failure: 'nothing is waiting to be saved' };

  try {
    const date = new Date().toISOString().split('T')[0];
    const dir = getOutputPath('screenshots', date);
    await fs.mkdir(dir, { recursive: true });
    const name = shotFilename(shot.kind, shot.selector, shot.widen);
    const file = join(dir, `${name}.png`);

    const raw = decodePng(Buffer.from(shot.data, 'base64'));
    const cut = crop && crop.w >= 1 && crop.h >= 1 ? crop : undefined;
    const clean = cut ? cropPixels(raw, cut) : raw;
    const { layout } = context;
    const scale = imageScale(raw, shot.kind, layout, context.element?.box.w);

    let cropRecord: CaptureRecord['crop'];
    let anchor: CaptureRecord['anchor'];
    if (cut) {
      const css = { x: cut.x / scale, y: cut.y / scale, w: cut.w / scale, h: cut.h / scale };
      const from = shot.kind === 'element' ? 'element' : shot.kind === 'screen' ? 'viewport' : 'document';
      cropRecord = { ...css, from };
      if (shot.kind !== 'element') {
        const origin = shot.kind === 'screen' ? layout.scroll : { x: 0, y: 0 };
        anchor = await anchorFor(session, { ...css, x: css.x + origin.x, y: css.y + origin.y });
      }
    }

    const factKinds = shot.facts.filter(kind => !keepFacts || keepFacts.includes(kind));
    const record: CaptureRecord = {
      series: name,
      version: 1,
      at: new Date().toISOString(),
      url: context.url,
      kind: shot.kind,
      viewport: layout.viewport,
      document: layout.document,
      scale,
      ...(shot.kind === 'screen' || shot.viewportMark ? { scroll: layout.scroll } : {}),
      ...(shot.viewportMark
        ? { viewportMark: { x: layout.scroll.x, y: layout.scroll.y, w: layout.viewport.width, h: layout.viewport.height } }
        : {}),
      ...(context.element ? { element: context.element } : {}),
      ...(anchor ? { anchor } : {}),
      ...(cropRecord ? { crop: cropRecord } : {}),
      frozen: context.frozen,
      pause: shot.pause,
      ...(factKinds.length ? { facts: factKinds } : {}),
    };
    const kept = context.facts && factKinds.length
      ? Object.fromEntries(Object.entries(context.facts).filter(([key]) => factKinds.includes(key as FactKind) || key === 'unread'))
      : undefined;
    await writeCapture(file, marked ? Buffer.from(marked, 'base64') : raw, record, clean, kept);
    session.pendingShot = null;
    session.pendingCapture = undefined;

    // Where the capture goes: taken from a note, it joins that note; taken
    // otherwise, it waits for the next note written. A capture is the evidence
    // for something someone is about to say, and one that stood alone left the
    // words and the picture in different places.
    const held = shot.annotationId ? heldAnnotation(session, shot.annotationId) : undefined;
    // An element picked for a note's capture goes to that note, as a pick
    // made from the toolbar goes to the note written with it, and is not left
    // pending for a new note.
    const picked = shot.annotationId && shot.kind === 'element' ? session.pending ?? undefined : undefined;
    if (shot.annotationId) session.pending = null;
    if (held) {
      held.annotation.screenshots = [...(held.annotation.screenshots ?? []), file];
      if (picked && !held.annotation.target) held.annotation.target = picked;
    } else if (shot.annotationId && session.sequences) {
      const failure = await session.sequences.attachScreenshot(shot.annotationId, file, picked);
      if (failure) session.sequenceFailure = failure;
    } else {
      session.pickShots = [...(session.pickShots ?? []), file];
    }

    await appendEvent(session.session, 'screenshot', {
      connection,
      path: file,
      url: context.url,
      shot: shot.kind,
      ...(shot.selector ? { selector: shot.selector } : {}),
      ...(marked ? { marked: true } : {}),
      ...(shot.pause.taken ? { pause: shot.pause } : {}),
      ...(factKinds.length ? { facts: factKinds } : {}),
      detail: `screenshot of ${shot.label}${marked ? ', marked up,' : ''} at ${file}`,
    });
    await endCaptureHold(session, context.heldBefore);
    return { path: file };
  } catch (error) {
    return { failure: String(error) };
  }
}

/**
 * Image pixels per CSS px in a capture.
 *
 * Measured from the image against the CSS width of what it covers, rather
 * than taken from the pixel ratio: a capture drops a size override another
 * CDP session holds, so under such emulation the image comes back at 1x
 * whatever the page reports.
 */
function imageScale(
  raw: { width: number },
  kind: CaptureKind,
  layout: Layout,
  elementWidth?: number,
): number {
  const css = kind === 'element' ? elementWidth : kind === 'screen' ? layout.viewport.width : layout.document.width;
  return css ? raw.width / css : layout.viewport.dpr;
}

/** Drop a held capture, releasing a hold the dialog made for it. */
export async function discardBenchScreenshot(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  const heldBefore = session.pendingCapture?.heldBefore;
  session.pendingShot = null;
  session.pendingCapture = undefined;
  await endCaptureHold(session, heldBefore);
}

/** Capped: a long selector path would exceed the name limit and fail the write. */
function shotFilename(kind: CaptureKind, selector: string | undefined, widen: number): string {
  const base = selector
    // A leading dot - which every class selector starts with - makes the file
    // hidden, so a capture would not appear in the directory it was saved to.
    ? selector.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 120)
    : kind;
  return `${base || 'element'}${widen > 0 ? `-out${widen}` : ''}-${Date.now()}`;
}

/**
 * Take a capture again the way its record says, and compare it with an
 * earlier version of the same series.
 *
 * The window is set to the recorded size and the page held as it was, so a
 * difference between the two is the page's and not the setup's. Both are put
 * back afterwards. The new version's picture is before, after and the
 * difference side by side; its clean copy is the new capture alone.
 */
export async function retakeCapture(
  connection: string,
  file: string,
  against = 1,
): Promise<{ path: string; record: CaptureRecord } | { failure: string }> {
  const session = sessions.get(connection);
  if (!session) return { failure: 'the bench is not open here' };
  const given = await readRecord(file).catch(() => undefined);
  if (!given) return { failure: `${file} carries no capture record, so there is nothing to take it again from` };
  await indexCapture(file, given);

  const versions = await versionsOf(given.series);
  const base = versions.find(v => v.version === against);
  if (!base) return { failure: `version ${against} of ${given.series} is not on disk` };
  const before = await readCapture(base.path);
  if (!before.record || !before.clean) return { failure: `${base.path} has no clean copy to compare against` };
  const recipe = before.record;
  if (recipe.url !== session.page.url()) {
    return { failure: `the capture was taken on ${recipe.url} and the page is on ${session.page.url()}` };
  }

  const heldBefore = session.frozen;
  const current = await layoutOf(session);
  // Puppeteer's record of a size it set - a headless or sized launch - or null
  // for a page that follows its window.
  const pinned = session.page.viewport?.() ?? null;
  const { width, height, dpr } = recipe.viewport;
  const resize = current.viewport.width !== width || current.viewport.height !== height || current.viewport.dpr !== dpr;
  let ranToResize = false;
  let laidOut = true;
  try {
    if (resize) {
      // A held page runs none of the resize handlers an app lays itself out
      // with, so the size changes while it runs and it is held again after.
      if (session.frozen) {
        ranToResize = true;
        await releaseUi(session);
      }
      await request(pageSession(session), 'Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: dpr, mobile: false,
      });
      laidOut = await settleLayout(session);
      const reached = (await layoutOf(session)).viewport;
      if (reached.width !== width || reached.height !== height || reached.dpr !== dpr) {
        return {
          failure: `the window was set to ${width}×${height} at ${dpr}x for the retake and reached `
            + `${reached.width}×${reached.height} at ${reached.dpr}x, so the capture would not match`,
        };
      }
    }
    if (recipe.frozen || heldBefore) await holdUi(session);
    if (recipe.kind === 'screen' && recipe.scroll) {
      await request(session.client, 'Runtime.evaluate', {
        expression: `scrollTo(${recipe.scroll.x}, ${recipe.scroll.y})`,
      });
    }
    const layout = await layoutOf(session);

    // Where the kept region's corner sits in the raw capture, in CSS px, and how that was found.
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    let origin = { x: 0, y: 0 };
    let placedBy: CaptureComparison['placedBy'] = 'rectangle';
    let element: CaptureRecord['element'];
    if (recipe.kind === 'element' && recipe.element) {
      const box = await elementBox(session, recipe.element.selector, recipe.element.widen);
      const found = box ?? {
        x: recipe.element.box.x, y: recipe.element.box.y,
        width: recipe.element.box.w, height: recipe.element.box.h, tag: recipe.element.tag,
      };
      placedBy = box ? 'element' : 'rectangle';
      clip = { x: found.x, y: found.y, width: found.width, height: found.height };
      element = { ...recipe.element, box: { x: found.x, y: found.y, w: found.width, h: found.height }, tag: found.tag };
      if (recipe.crop) origin = { x: recipe.crop.x, y: recipe.crop.y };
    } else if (recipe.crop) {
      const anchored = recipe.anchor ? await elementBox(session, recipe.anchor.selector, 0) : undefined;
      const doc = anchored
        ? { x: anchored.x + recipe.anchor!.offset.x, y: anchored.y + recipe.anchor!.offset.y }
        : recipe.crop.from === 'viewport'
          ? { x: recipe.crop.x + (recipe.scroll?.x ?? 0), y: recipe.crop.y + (recipe.scroll?.y ?? 0) }
          : { x: recipe.crop.x, y: recipe.crop.y };
      placedBy = anchored ? 'anchor' : 'rectangle';
      origin = recipe.kind === 'screen' ? { x: doc.x - layout.scroll.x, y: doc.y - layout.scroll.y } : doc;
    }

    const data = await shoot(session, recipe.kind, clip);
    if (!data) return { failure: 'the page returned no image' };
    const raw = decodePng(Buffer.from(data, 'base64'));
    const scale = imageScale(raw, recipe.kind, layout, clip?.width);
    const after = recipe.crop
      ? cropPixels(raw, { x: origin.x * scale, y: origin.y * scale, w: recipe.crop.w * scale, h: recipe.crop.h * scale })
      : raw;

    let facts: ElementFacts | undefined;
    let factChanges: string[] | undefined;
    if (recipe.facts?.length && element) {
      const objectId = await elementObject(session, element.selector, element.widen);
      if (objectId) {
        facts = await readFacts(session.client, objectId, recipe.facts, { scripts: session.scripts, sheets: session.sheets });
        await send(session.client, 'Runtime.releaseObject', { objectId });
        factChanges = diffFacts((before.facts ?? {}) as ElementFacts, facts);
      }
    }

    // Pixels at two scales do not line up, so the percentage would measure the
    // scaling. The scales are reported instead of a change that is not there.
    const sameScale = Math.abs(scale - recipe.scale) < 0.01;
    const diff = diffPixels(before.clean, after);
    const panels = [before.clean, after].map(p => ({ ...p, data: Buffer.from(p.data) }));
    if (recipe.kind === 'page' && recipe.viewportMark) {
      // Each panel gets the window as it stood when that panel was taken.
      const marks = [recipe.viewportMark, {
        x: layout.scroll.x, y: layout.scroll.y, w: layout.viewport.width, h: layout.viewport.height,
      }];
      const cropAt = [
        { x: recipe.crop?.x ?? 0, y: recipe.crop?.y ?? 0 },
        origin,
      ];
      const scales = [recipe.scale, scale];
      marks.forEach((mark, i) => strokeDashed(panels[i], {
        x: (mark.x - cropAt[i].x) * scales[i], y: (mark.y - cropAt[i].y) * scales[i],
        w: mark.w * scales[i], h: mark.h * scales[i],
      }, [66, 133, 244], Math.max(2, Math.round(scales[i] * 2))));
    }

    const compared: CaptureComparison = {
      against,
      changed: diff.changed,
      edges: diff.edges,
      share: Math.round(diff.share * 10000) / 10000,
      ...(diff.box ? { box: diff.box } : {}),
      size: { before: [before.clean.width, before.clean.height], after: [after.width, after.height] },
      placedBy,
      ...(sameScale ? {} : { scales: [recipe.scale, scale] as [number, number] }),
      ...(resize
        ? {
          resized: {
            from: [current.viewport.width, current.viewport.height, current.viewport.dpr],
            to: [width, height, dpr],
            ran: ranToResize,
            ...(laidOut ? {} : { hidden: true }),
          },
        }
        : {}),
      ...(factChanges?.length ? { factChanges } : {}),
    };
    const version = Math.max(...versions.map(v => v.version)) + 1;
    const record: CaptureRecord = {
      ...recipe,
      version,
      at: new Date().toISOString(),
      url: session.page.url(),
      viewport: layout.viewport,
      document: layout.document,
      scale,
      ...(recipe.scroll ? { scroll: layout.scroll } : {}),
      ...(element ? { element } : {}),
      frozen: session.frozen,
      pause: pauseOf(session),
      compared,
    };
    if (recipe.viewportMark) {
      record.viewportMark = { x: layout.scroll.x, y: layout.scroll.y, w: layout.viewport.width, h: layout.viewport.height };
    }

    const date = new Date().toISOString().split('T')[0];
    const dir = getOutputPath('screenshots', date);
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${shotFilename(recipe.kind, recipe.element?.selector, recipe.element?.widen ?? 0)}.png`);
    await writeCapture(path, sideBySide([...panels, diff.image]), record, after, facts as Record<string, unknown> | undefined);

    const where = diff.box ? `, box ${diff.box.x},${diff.box.y} ${diff.box.w}×${diff.box.h}` : '';
    const size = compared.size.before.join('×') === compared.size.after.join('×')
      ? '' : `, size ${compared.size.before.join('×')} → ${compared.size.after.join('×')}`;
    await appendEvent(session.session, 'comparison', {
      connection,
      path,
      series: recipe.series,
      version,
      against,
      compared,
      detail: `${recipe.element?.selector ?? recipe.kind} v${version} against v${against}: `
        + `${(compared.share * 100).toFixed(1)}% changed${where}${size}, placed by ${placedBy}`
        + `${compared.scales ? `, captured at ${compared.scales[0]}x and ${compared.scales[1]}x so the figures measure the scaling` : ''}`
        + `${compared.resized ? `, window set from ${compared.resized.from[0]}×${compared.resized.from[1]}@${compared.resized.from[2]}x to the recorded ${width}×${height}@${dpr}x${compared.resized.ran ? ' (the held page ran while it resized)' : ''}${compared.resized.hidden ? ' (the tab was in the background, so layout set by script did not follow the size)' : ''}` : ''}`
        + `${factChanges?.length ? ` · ${factChanges.join(' · ')}` : ''} - ${path}`,
    });
    return { path, record };
  } catch (error) {
    return { failure: String(error) };
  } finally {
    if (recipe.kind === 'screen' && recipe.scroll) {
      await send(session.client, 'Runtime.evaluate', {
        expression: `scrollTo(${current.scroll.x}, ${current.scroll.y})`,
      });
    }
    if (resize) {
      if (session.frozen) await releaseUi(session);
      // Back to the size Puppeteer holds, or to none, so a window-sized page
      // keeps following its window.
      if (pinned) {
        await session.page.setViewport(pinned)
          .catch((error) => debugLog('bench', `restoring the ${pinned.width}×${pinned.height} viewport failed: ${error}`));
      } else {
        await send(pageSession(session), 'Emulation.clearDeviceMetricsOverride');
      }
      await settleLayout(session);
    }
    if (heldBefore) await holdUi(session);
    else if (session.frozen) await releaseUi(session);
  }
}

/**
 * Let a running page lay itself out after a size change: two animation frames,
 * the first for the resize event and its handlers, the second for the layout
 * they cause.
 *
 * Chrome renders no frames for a tab in the background, and it dispatches
 * resize as part of rendering one, so a hidden page never settles: CSS follows
 * the new size and script does not. Returns false for a hidden page instead of
 * waiting on frames that will not come.
 */
async function settleLayout(session: BenchSession): Promise<boolean> {
  const { result } = await request(session.client, 'Runtime.evaluate', {
    expression: `document.visibilityState === 'hidden' ? false
      : new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 50))))`,
    awaitPromise: true,
    returnByValue: true,
  }, 2000).catch(() => ({ result: { value: false } }));
  return result?.value === true;
}

/**
 * The on-screen box of the element a selector names, in page coordinates.
 *
 * Runtime rather than DOM.getBoxModel: a note's selector may carry
 * :has-text(), which the DOM domain refuses, and the same match has to be made
 * for the outline and for the clip or the two disagree.
 */
async function elementBox(
  session: BenchSession,
  selector: string,
  widen: number
): Promise<{ x: number; y: number; width: number; height: number; tag: string } | undefined> {
  try {
    const { result } = await request(session.client, 'Runtime.evaluate', {
      expression: `(() => {
        let el = ${matchExpression(selector)};
        if (!el) return null;
        for (let out = 0; out < ${Math.max(0, Math.trunc(widen))}; out++) {
          if (!el.parentElement || el.parentElement === document.body) break;
          el = el.parentElement;
        }
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return JSON.stringify({
          x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height,
          tag: el.localName + (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
        });
      })()`,
      returnByValue: true,
    });
    return result?.value ? JSON.parse(result.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The versions of every capture the open sequence's notes cite, keyed by the
 * path the note holds - version 1, whose file name is the series.
 */
export async function seriesOfNotes(sequence: SequenceState | undefined): Promise<Record<string, CaptureVersion[]> | undefined> {
  const cited = (sequence?.steps ?? []).flatMap(step => (step.annotations ?? []).flatMap(note => note.screenshots ?? []));
  if (!cited.length) return undefined;
  const index = await seriesIndex();
  const found: Record<string, CaptureVersion[]> = {};
  for (const path of cited) {
    const versions = index.get(basename(path, '.png'));
    if (versions?.length) found[path] = versions;
  }
  return found;
}
