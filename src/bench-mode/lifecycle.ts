import type { Page } from 'puppeteer-core';
import { debugLog } from '../debug-logger.js';
import { recordReleased } from '../hold.js';
import { startBenchServer } from '../bench-control.js';
import { getProxy } from '../proxy/registry.js';
import type { AnnotationTarget } from '../annotation.js';
import { WriteWatch } from '../write-watch.js';
import { trackStyleSheets } from '../element-facts.js';
import { DESCRIBE_ELEMENT, verifySourceLine } from './annotations.js';
import { captureBenchScreenshot } from './captures.js';
import { HIGHLIGHT_CONFIG, setInspectMode } from './cdp.js';
import { type SequenceDriver } from './driver.js';
import { attachUiLayer, holdUi, releaseBench } from './page-hold.js';
import { benchRoutes } from './routes.js';
import { armSavedRules } from './rules.js';
import { type BenchReport, type BenchSession, getBenchSession, getStateOf, pageGone, sessions } from './session.js';

export async function startBench(params: {
  page: Page;
  connection: string;
  sessionName: string;
  /** Owns original source text - see SourceMapHandler.getOriginalContent. */
  sourceMapHandler?: { registerSourceMap: (scriptUrl: string, sourceMapURL: string) => void; getOriginalContent: (source: string) => Promise<string | null> };
  /** Drives replay's own step-through session; the bench never re-implements it. */
  sequences?: SequenceDriver;
  /** Opens the bench tab. Omitted in tests, which drive the handlers directly. */
  openBench?: (url: string) => Promise<Page | undefined>;
}): Promise<BenchReport> {
  const { page, connection, sessionName, openBench, sourceMapHandler, sequences } = params;
  const readOriginal = sourceMapHandler
    ? (fileName: string) => sourceMapHandler.getOriginalContent(fileName)
    : undefined;

  // A session whose page or tab has gone is ended and a new one begun; one
  // still standing is answered as it stands, its picker left as it is.
  const stale = sessions.get(connection);
  if (stale && (pageGone(stale.page) || pageGone(stale.benchPage))) {
    await stopBench(connection).catch(() => {});
  }
  if (sessions.has(connection)) return getBenchSession(connection)!;

  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('Overlay.enable');
  await client.send('Runtime.enable');
  await client.send('Animation.enable');

  const session: BenchSession = {
    client,
    page,
    connection,
    session: sessionName,
    startedAt: Date.now(),
    tickMs: 0,
    picks: 0,
    annotations: 0,
    pickerArmed: false,
    frozen: false,
    benchUrl: '',
    pending: null,
    pauseRequested: false,
    heldByOther: false,
    sequenceBusy: false,
    pauseTaken: false,
    factChoice: ['events'],
    sequences,
    scripts: new Map(),
    sheets: new Map(),
    totalSteps: 0,
    callbacks: [],
    stepBreakpointsSet: false,
  };
  sessions.set(connection, session);
  attachUiLayer(session);
  // The site's rules answer from the start, before any sequence is opened.
  await armSavedRules(connection).catch(error => debugLog('bench', `site rules not armed: ${error}`));

  client.on('Debugger.resumed', () => { session.pausedEvent = undefined; });
  client.on('Debugger.paused', (event: any) => {
    session.pauseTaken = true;
    session.pausedEvent = event;
    // A pause we did not ask for is someone else's - a breakpoint, a debugger
    // statement. Recorded so it can be reported; the bench still releases its
    // own hold normally, but never attaches a second agent to force theirs.
    if (!session.pauseRequested) {
      session.heldByOther = true;
      debugLog('bench', `page stopped by something else: reason=${event?.reason}`);
    }
  });

  // Debugger.enable replays scriptParsed for everything already loaded, so this
  // has to be listening before the enable rather than after it.
  client.on('Debugger.scriptParsed', (event: any) => {
    if (event?.scriptId && event?.url) session.scripts.set(event.scriptId, event.url);
    // Registration is lazy - the map is only fetched if something asks for the
    // file behind it, which is a pick on an element from that module.
    if (event?.url && event?.sourceMapURL) {
      sourceMapHandler?.registerSourceMap(event.url, event.sourceMapURL);
    }
  });
  await client.send('Debugger.enable');

  client.on('Overlay.inspectNodeRequested', async (event: any) => {
    try {
      const { object } = (await client.send('DOM.resolveNode', {
        backendNodeId: event.backendNodeId,
      } as any)) as any;
      const described = (await client.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: DESCRIBE_ELEMENT,
        returnByValue: true,
      } as any)) as any;

      const target = described.result?.value as AnnotationTarget | undefined;
      if (!target) return;
      if (target.source?.fileName) {
        target.source = await verifySourceLine(target.source, target.tag, readOriginal);
      }

      // Chrome's inspect mode stays on after a pick and turns every later
      // click in the app into another pick, so it is switched off here and
      // the button shows it off; picking again is a press of the picker.
      await setInspectMode(session, false).catch(() => { session.pickerArmed = false; });
      session.picks++;
      session.pending = target;

      // Picked from the capture dialog: the pick is the element to capture,
      // and stays pending so the note written with the capture is about it.
      const armed = session.shotArmed;
      if (armed) {
        session.shotArmed = undefined;
        const taken = await captureBenchScreenshot(connection, {
          kind: 'element', selector: target.selector, heldBefore: armed.heldBefore,
          ...(armed.annotationId ? { annotationId: armed.annotationId } : {}),
        });
        session.sequenceFailure = 'failure' in taken ? taken.failure : undefined;
      }
    } catch (error) {
      debugLog('bench', `pick failed: ${error}`);
      await setInspectMode(session, true).catch(() => {});
    }
  });

  // Navigation drops the hold with the old document.
  client.on('Page.frameNavigated', async (event: any) => {
    if (event.frame?.parentId) return;
    // Not while a sequence is being driven. A step that navigates would other-
    // wise be frozen the instant it lands, so nothing after it in the run can
    // render or be clicked - the drive holds it again when it is done.
    if (session.sequenceBusy) return;
    try {
      // Only a hold the navigation took away is put back. A page that was
      // running when it navigated lands running: held here, it would stop a
      // run that navigates between two of its steps, and stop a person
      // following a link.
      const wasHeld = session.frozen;
      session.stepBreakpointsSet = false;
      session.frozen = false;
      recordReleased(connection, 'ui');
      if (wasHeld) await holdUi(session);
      session.tickMs = 0;
      session.totalSteps = 0;
      session.lastTick = undefined;
      session.callbacks = [];
      session.scripts.clear();
      await setInspectMode(session, session.pickerArmed);
    } catch (error) {
      debugLog('bench', `re-arm after navigation failed: ${error}`);
    }
  });
  await client.send('Page.enable');
  // Storage the page writes never reaches the proxy; this is what shows it.
  session.writeWatch = new WriteWatch(client, page);
  await session.writeWatch.start().catch((error) => {
    debugLog('bench', `watching storage writes failed: ${error}`);
  });
  // Enabled while the page runs: CSS.enable goes unanswered on a held page,
  // and the element facts read the rules while it is held.
  await trackStyleSheets(client, session.sheets).catch((error) => {
    debugLog('bench', `CSS.enable failed, so captures will record no css: ${error}`);
  });

  const server = await startBenchServer(benchRoutes(connection, session, page));
  session.server = server;
  session.benchUrl = server.url;
  // The pane travels the same proxy as the app, so an allow list scoped to the
  // app refuses it and the pane never loads. Registered once its port is known,
  // and left out of the record: at four polls a second it would bury the app's
  // own traffic in its own.
  const liveProxy = getProxy(connection);
  if (liveProxy) {
    try { liveProxy.allowQuietly([new URL(server.url).host]); } catch { /* no host to add */ }
  }


  if (openBench) {
    try {
      session.benchPage = await openBench(server.url);
      // Closing the tab is how someone finishes: it releases the page and takes
      // the server with it, so there is no button that has to be found first.
      // stopBench closes this tab itself, which re-enters here - by then
      // the session is already gone, so the second pass is a no-op.
      session.benchPage?.on('close', () => {
        void stopBench(connection).catch((error) => {
          debugLog('bench', `cleanup after the bench tab closed failed: ${error}`);
        });
      });
    } catch (error) {
      debugLog('bench', `the bench tab failed to open: ${error}`);
    }
  }

  return getBenchSession(connection)!;
}

export async function stopBench(connection: string): Promise<BenchReport | undefined> {
  const session = sessions.get(connection);
  if (!session) return undefined;
  session.writeWatch?.stop();
  sessions.delete(connection);

  const state = getStateOf(session);
  // A sequence paused part-way is owed the teardown of whatever it launched,
  // and the recorder holding it outlives this bench. Closed here, that debt is
  // paid; left standing, the browsers the run opened stay open with nothing
  // left able to reach them.
  await session.sequences?.cancel().catch(() => {});
  const { client } = session;
  try {
    await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG } as any);
    await releaseBench(session);
    await client.send('Overlay.disable');
    await client.detach();
  } catch (error) {
    debugLog('bench', `stop cleanup failed: ${error}`);
  }
  // The bench tab closes after the server, so its last poll fails and the
  // page says so rather than hanging on a dead port.
  try {
    await session.server?.close();
    await session.benchPage?.close();
  } catch (error) {
    debugLog('bench', `bench server cleanup failed: ${error}`);
  }
  return state;
}
