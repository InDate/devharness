import type { Page } from 'puppeteer-core';
import { appendEvent } from '../session-events.js';
import { holdableLayers, holdReading } from '../hold.js';
import type { BenchHandlers } from '../bench-control.js';
import { getProxy, checkOutcomesFor } from '../proxy/registry.js';
import { levelOf, causeOf } from '../proxy/intercept-proxy.js';
import { getIssues } from '../issue-tracker.js';
import { addFavourite, readFavourites, removeFavourite } from './favourites.js';
import { bodyHash, commentGithubId, stripCommentMarker } from '../github/gh-issues.js';
import { localProse } from '../github/issue-actions.js';
import { NO_TOOL_VALUES, type BenchView, type BoundaryEvent, type BoundaryState, type HiddenKind } from '../bench/wire.js';
import type { ActivityMove, ExpectedValue, KindCount } from '../bench/kinds.js';
import { discardPick, highlightAnnotation, moveAnnotation, noteAtStep, noteTargetFor, notifyAnnotation, removeAnnotation, rewordAnnotation, saveAnnotation } from './annotations.js';
import { beginCapture, cancelCapture, captureBenchScreenshot, discardBenchScreenshot, readMoreFacts, retakeCapture, saveBenchScreenshot, seriesOfNotes, setFactChoice } from './captures.js';
import { setInspectMode } from './cdp.js';
import { changeHold, haltSequence, openDevtools, resumePausedRun, setHeld, setPicker } from './controls.js';
import { stepTraffic, tickBench } from './page-hold.js';
import { addRecordingTimer, addRecordingVariable, cancelRecordingSequence, chooseStepSelector, dropRecordedStep, editRecordingVariable, flagRecordedStep, keepRecordedStep, recordSequence, stopRecordingSequence } from './recording.js';
import { clearBoundaryRule, hiddenOf, hideKind, nameTarget, namesOf, persistRules, ruleFrom, rulesOf, savePayloadFor, setBoundaryName, setBoundaryRule, setHiddenMode, setHiddenUse, setResponseMode, setResponseUse, unhideKind, useFrom } from './rules.js';
import { baselineSequence, playHere, playToStep, renameFromHome, runFromHome, runsView, stopRun } from './runs.js';
import { answerBenchDialog, cancelSequence, commentSequenceStep, describeSequence, dismissSequenceFailure, editSequenceStep, getSequenceState, gotoSequenceStep, insertSequenceCheck, insertSequenceTimer, moveSequenceStep, playSequence, removeSequence, removeSequenceStep, removeSequenceVariable, selectSequence, setSequenceBaseUrl, setSequenceVariable, stepSequence } from './sequence.js';
import { type BenchSession, sessions } from './session.js';
import { openSequence, openSteps, recordedStepOf, summariseBoundary, writeEvents } from './traffic.js';

/** What the bench server calls, for one connection's session and page. */
export function benchRoutes(connection: string, session: BenchSession, page: Page): BenchHandlers {
  return {
    // Everything but `primary`: only the route knows which copy is asking.
    getState: async (): Promise<Omit<BenchView, 'primary'>> => {
      const sequence = await getSequenceState(connection);
      const series = await seriesOfNotes(sequence);
      return {
        connection,
        pageUrl: page.url(),
        frozen: session.frozen,
        held: holdReading(connection).held,
        queued: getProxy(connection)?.queue.list() ?? [],
        holdable: holdableLayers(connection),
        pickerArmed: session.pickerArmed,
        tickMs: session.tickMs,
        totalSteps: session.totalSteps,
        lastTick: session.lastTick,
        callbacks: session.callbacks.slice(-50),
        sequence,
        pending: session.pending,
        noteTarget: await noteTargetFor(connection),
        ...(session.pendingShot ? { shot: session.pendingShot } : {}),
        ...(session.shotArmed ? { shotArmed: session.shotArmed } : {}),
        factChoice: session.factChoice,
        ...(series ? { series } : {}),
      };
    },
    save: async (comment: string) => { await saveAnnotation(connection, comment); },
    discard: async () => { await discardPick(connection); },
    tick: async (request: { steps?: number; budgetMs?: number }) => { await tickBench(connection, request); },
    stepTraffic: async () => { await stepTraffic(connection); },
    releaseWaiting: async (id: number) => { getProxy(connection)?.queue.releaseOne(id); },
    openDevtools: async () => openDevtools(connection),
    changeHold: async (action, layers) => { await changeHold(connection, action, layers); },
    setPicker: async (armed: boolean) => { await setPicker(connection, armed); },
    setHeld: async (held: boolean, resume?: boolean) => {
      await setHeld(connection, held);
      if (!held && resume) resumePausedRun(connection);
    },
    selectSequence: async (name: string) => { await selectSequence(connection, name); },
    describeSequence: async (description: string, expectedOutcome: string) => {
      await describeSequence(connection, description, expectedOutcome);
    },
    commentSequenceStep: async (index: number, words: string) => {
      await commentSequenceStep(connection, index, words);
    },
    gotoSequenceStep: async (step: number) => { await gotoSequenceStep(connection, step); },
    stepSequence: async () => { await stepSequence(connection); },
    playSequence: async () => { await playSequence(connection); },
    baselineSequence: async () => { await baselineSequence(connection); },
    haltSequence: async () => { await haltSequence(connection); },
    cancelSequence: async () => { await cancelSequence(connection); },
    removeSequence: async (name: string) => { await removeSequence(connection, name); },
    dismissFailure: async () => { await dismissSequenceFailure(connection); },
    answerDialog: async (accept: boolean) => { await answerBenchDialog(connection, accept); },
    // A write's value is held by the write watch, which no proxy carries.
    proxyBody: async (id: string) => getProxy(connection)?.bodyOf(id)
      ?? sessions.get(connection)?.writeWatch?.writes.find(write => write.id === id)?.value
      ?? null,

    /**
     * Send one reading back to whoever is driving, with the evidence behind it.
     *
     * The classification is the code's job, so a person seeing a wrong one is
     * reporting a defect rather than correcting a label. Everything the rule
     * read goes with the note, because the next step is changing that rule and
     * a report without its inputs cannot be acted on.
     */
    proxyInvestigate: async (id: string, note: string) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      const event = live.eventsIn().find(e => e.id === id);
      if (!event) return 'that event has been dropped from the ring';
      const shape = event.evidence?.shape;
      const alike = shape
        ? live.eventsIn().filter(e => e.evidence?.shape === shape).length
        : 1;
      await appendEvent(sessions.get(connection)?.session ?? connection, 'investigate', {
        connection,
        note,
        reading: {
          level: levelOf(event), owned: causeOf(event) !== undefined,
          root: event.evidence?.initiator, shape, alike,
        },
        event: {
          id: event.id, at: event.at, kind: event.kind, direction: event.direction,
          url: event.url, method: event.method, status: event.status, size: event.size,
          preview: event.preview, commandIndex: event.commandIndex,
          runId: event.runId, step: event.step, evidence: event.evidence,
        },
      });
      return `sent \u00b7 ${shape ?? event.url} \u00b7 ${alike} of this kind`;
    },

    clearBoundary: async () => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      const held = live.eventsIn().length;
      live.clear();
      return held ? `cleared ${held} event${held === 1 ? '' : 's'}` : 'nothing was held';
    },

    allowHosts: async (hosts: string[]) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      live.allowOnly(hosts);
      return hosts.length
        ? `reaching ${hosts.join(', ')} and nothing else`
        : 'reaching every host';
    },

    // A proxied window in the same Chrome rather than a relaunch, so this
    // page and the bench tab beside it stay open; the bench follows the window.
    enableProxy: async (name: string) => {
      const sequences = sessions.get(connection)?.sequences;
      if (!sequences) return { failure: 'This bench holds no replay side to run tools through' };
      const port = Number(new URL(page.browser().wsEndpoint()).port);
      const launched = await sequences.callTool('connection', {
        action: 'launch', connection: name, newContextWindow: true, proxy: true,
        url: page.url(), copyCookiesFrom: connection, port,
      });
      if (launched.failed) return { failure: launched.result };
      const benched = await sequences.callTool('bench', { action: 'start', connection: name, openTab: false });
      const benchUrl = benched.meta?.bench?.state?.benchUrl;
      if (benched.failed || typeof benchUrl !== 'string') return { failure: benched.result };
      return { benchUrl };
    },

    /**
     * Answer this from now on with what it answered here.
     *
     * A request is held by its own URL, so the next call to it is answered
     * locally. A frame is held by what it carried, since a socket message has
     * no other durable handle on it.
     */
    proxyHold: async (id: string) => {
      const live = getProxy(connection);
      if (!live) return { text: 'no proxy' };
      const event = live.eventsIn().find(e => e.id === id);
      if (!event) return { text: 'gone' };
      const body = live.bodyOf(id);
      if (event.kind === 'request') {
        const pin = live.pin({
          urlIncludes: event.url,
          ...(event.method ? { method: event.method } : {}),
          ...(event.status ? { status: event.status } : {}),
          body: body ?? '',
        });
        // The pin's id goes back with the answer: without it the pane can hold
        // a value and never let go of it, since nothing else names which hold
        // belongs to which row.
        return { text: 'HELD', pin: pin.id };
      }
      if (body === undefined) return { text: 'BINARY - NOT HELD' };
      const pin = live.pinFrame({
        urlIncludes: event.url, direction: event.direction === 'out' ? 'sent' : 'received',
        textIncludes: body, replaceWith: body,
      });
      return { text: 'HELD', pin: pin.id };
    },

    proxyRelease: async (pin: string) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      return live.unpin(pin) ? 'RELEASED' : 'ALREADY GONE';
    },

    ruleCatalogue: async () => (await sessions.get(connection)?.sequences?.catalogueRules().catch(() => [])) ?? [],
    sequenceOutline: async (name: string) => sessions.get(connection)?.sequences?.outlineOf(name).catch(() => undefined),
    runs: () => runsView(),
    runFromHome: (name: string) => runFromHome(connection, name),
    playHere: (name: string) => playHere(connection, name),
    playToStep: (name: string, step: number) => playToStep(connection, name, step),
    renameFromHome: (from: string, to: string) => renameFromHome(connection, from, to),
    stopRun: (target: { runId?: string; connection?: string }) => stopRun(target),
    history: async () => sessions.get(connection)?.sequences?.history() ?? [],
    historyDetail: async (index: number) => sessions.get(connection)?.sequences?.historyDetail(index),
    tools: async () => sessions.get(connection)?.sequences?.tools() ?? [],
    toolValues: async () => (await sessions.get(connection)?.sequences?.toolValues()) ?? NO_TOOL_VALUES,
    servers: async () => (await sessions.get(connection)?.sequences?.servers()) ?? [],
    serverLog: async (id: string, stream: 'stdout' | 'stderr') =>
      (await sessions.get(connection)?.sequences?.serverLog(id, stream)) ?? { unavailable: 'no bench session' },
    running: async () => {
      const sequences = sessions.get(connection)?.sequences;
      if (!sequences) throw new Error('This bench holds no replay side to read from');
      return sequences.running();
    },
    favourites: () => readFavourites(),
    addFavourite: (call: { tool: string; label: string; args: Record<string, unknown> }) => addFavourite(call),
    removeFavourite: (id: string) => removeFavourite(id),
    sequenceNotes: async () => (await sessions.get(connection)?.sequences?.notes()) ?? [],
    issues: async (includeCompleted: boolean) => (await getIssues({ includeCompleted })).map(issue => ({
      id: issue.id,
      type: issue.type,
      status: issue.status,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      comments: issue.comments.map(comment => ({ at: comment.timestamp.getTime(), text: stripCommentMarker(comment.text) })),
      ...(issue.sequenceFile && { sequenceFile: issue.sequenceFile }),
      reportedAt: issue.reportedAt.getTime(),
      ...(issue.resolvedAt && { resolvedAt: issue.resolvedAt.getTime() }),
      ...(issue.github !== undefined && {
        github: {
          number: issue.github,
          ...(issue.githubRepo && { repo: issue.githubRepo }),
          ...(issue.githubSyncedAt && { syncedAt: issue.githubSyncedAt.getTime() }),
          bodyChanged: issue.githubBodyHash !== undefined && bodyHash(localProse(issue)) !== issue.githubBodyHash,
          unpushedComments: issue.comments.filter(comment => commentGithubId(comment.text) === null).length,
          marked: issue.githubSync === true,
          decided: issue.githubSync !== undefined,
        },
      }),
    })),
    callTool: async (tool: string, args: Record<string, unknown>) => {
      const sequences = sessions.get(connection)?.sequences;
      if (!sequences) throw new Error('This bench holds no replay side to run tools through');
      return sequences.callTool(tool, args);
    },
    proxyEvents: async (sinceId: string | null): Promise<BoundaryState> => {
      const proxy = getProxy(connection);
      if (!proxy) {
        return {
          running: false, allowed: [], refused: 0, refusals: [],
          refusesWrites: false, refusedWrites: 0,
          rules: rulesOf(connection), names: namesOf(connection),
          checkOutcomes: checkOutcomesFor(connection),
          events: writeEvents(connection), totals: null, steps: openSteps(connection),
          ...(sessions.get(connection)?.site ? { site: sessions.get(connection)!.site } : {}),
          hidden: hiddenOf(connection),
          ...(openSequence(connection) ? { forSequence: openSequence(connection) } : {}),
        };
      }
      const all = proxy.eventsIn();
      const rules = proxy.shapeRules();
      // Asked for by id rather than by clock: the list only grows, and an id
      // cannot land twice the way a millisecond can.
      const at = sinceId ? all.findIndex(e => e.id === sinceId) : -1;
      return {
        running: true,
        allowed: proxy.listAllowedHosts(),
        refused: proxy.blocked,
        refusals: proxy.refusals(),
        refusesWrites: proxy.refusesWrites,
        refusedWrites: proxy.refusedWrites,
        rules: rulesOf(connection),
        ...(sessions.get(connection)?.site ? { site: sessions.get(connection)!.site } : {}),
        checkOutcomes: checkOutcomesFor(connection),
        hidden: hiddenOf(connection),
        names: namesOf(connection),
        // The level and whether any step owns it are read here rather than
        // recomputed in the pane: both are policy over stored evidence, and a
        // second copy of that policy in the browser would drift from this one.
        events: [...all.slice(at + 1).map(event => ({
          ...event,
          level: levelOf(event),
          owned: causeOf(event) !== undefined,
          ...recordedStepOf(connection, event),
          root: event.evidence?.initiator,
          // What a person decided this shape is. A verdict settles every frame
          // of that kind, so a row carries the one assigned to its shape even
          // when the decision was made on a different frame.
          verdict: event.evidence?.shape ? rules[event.evidence.shape] : undefined,
        })) as unknown as BoundaryEvent[],
          ...writeEvents(connection, at >= 0 ? all[at].at : 0)].sort((a, b) => a.at - b.at),
        // Counted over everything the proxy holds, not over what this pane has
        // accumulated: a reader who opened the tab late would otherwise see a
        // summary of their own arrival time.
        totals: summariseBoundary(all, rules, proxy.socketShapes(), proxy.openSockets(),
          proxy.listPins().length + proxy.listFramePins().length),
        steps: openSteps(connection),
        queued: proxy.queue.list(),
        holding: proxy.queue.held,
        ...(openSequence(connection) ? { forSequence: openSequence(connection) } : {}),
      };
    },
    keepRecordedStep: async () => { await keepRecordedStep(connection); },
    addRecordingTimer: async (ms: number) => { await addRecordingTimer(connection, ms); },
    editRecordingVariable: async (name: string, value: string | null) => { await editRecordingVariable(connection, name, value); },
    addRecordingVariable: async (name: string, value: string) => {
      const session = sessions.get(connection);
      const failure = await addRecordingVariable(connection, name, value);
      if (session) session.sequenceFailure = failure;
    },
    chooseStepSelector: async (index: number) => { await chooseStepSelector(connection, index); },
    flagRecordedStep: async (reason: string, options?: Array<{ selector: string; note: string }>, detail?: string) => {
      await flagRecordedStep(connection, reason, options, detail);
    },
    dropRecordedStep: async () => { await dropRecordedStep(connection); },
    recordSequence: async (name: string, withAgent: boolean, startUrl: string) => {
      await recordSequence(connection, name, withAgent, startUrl);
    },
    recordInto: async (after: number) => {
      const open = sessions.get(connection)?.sequences?.active()?.name;
      if (!open) return;
      await recordSequence(connection, `${open}-insert-${Date.now().toString(36)}`, false, '', { name: open, after });
    },
    stopRecordingSequence: async () => { await stopRecordingSequence(connection); },
    cancelRecordingSequence: async () => { await cancelRecordingSequence(connection); },
    removeSequenceStep: async (index: number) => { await removeSequenceStep(connection, index); },
    insertSequenceTimer: async (after: number, ms: number) => { await insertSequenceTimer(connection, after, ms); },
    insertSequenceCheck: async (after: number, params: Record<string, unknown>, comment?: string) => { await insertSequenceCheck(connection, after, params, comment); },
    editSequenceStep: async (index: number, params: unknown) => { await editSequenceStep(connection, index, params); },
    moveSequenceStep: async (from: number, to: number, count: number) => { await moveSequenceStep(connection, from, to, count); },
    setSequenceVariable: async (name: string, value: string) => { await setSequenceVariable(connection, name, value); },
    removeSequenceVariable: async (name: string) => { await removeSequenceVariable(connection, name); },
    noteAtStep: async (step: number) => { await noteAtStep(connection, step); },
    moveAnnotation: async (id: string, step: number, after?: string) => {
      await moveAnnotation(connection, id, step, after);
    },
    rewordAnnotation: async (id: string, words: string) => { await rewordAnnotation(connection, id, words); },
    savePayload: (name: string, content: string) => savePayloadFor(connection, name, content),
    removeAnnotation: async (id: string) => { await removeAnnotation(connection, id); },
    notifyAnnotation: async (id: string) => { await notifyAnnotation(connection, id); },
    captureScreenshot: async (ask) => {
      const held = sessions.get(connection);
      if (!held) return;
      if (ask.kind !== 'element') {
        const armed = held.shotArmed;
        held.shotArmed = undefined;
        await setInspectMode(held, false).catch(() => {});
        ask = {
          ...ask,
          ...(armed ? { heldBefore: armed.heldBefore } : {}),
          ...(armed?.annotationId ? { annotationId: armed.annotationId } : {}),
        };
      }
      const taken = await captureBenchScreenshot(connection, ask);
      held.sequenceFailure = 'failure' in taken ? taken.failure : undefined;
    },
    beginCapture: async (annotationId) => { await beginCapture(connection, annotationId); },
    cancelCapture: async () => { await cancelCapture(connection); },
    setFactChoice: async (kinds) => { setFactChoice(connection, kinds); },
    readMoreFacts: async (kinds) => { await readMoreFacts(connection, kinds); },
    saveScreenshot: async (marked, crop, facts) => {
      const held = sessions.get(connection);
      if (!held) return;
      const saved = await saveBenchScreenshot(connection, marked, crop, facts);
      held.sequenceFailure = 'failure' in saved ? saved.failure : undefined;
    },
    discardScreenshot: async () => { await discardBenchScreenshot(connection); },
    retakeCapture: async (path, against) => {
      const held = sessions.get(connection);
      if (!held) return;
      const taken = await retakeCapture(connection, path, against);
      held.sequenceFailure = 'failure' in taken ? taken.failure : undefined;
    },
    highlightAnnotation: async (selector: string) => { await highlightAnnotation(connection, selector); },
    setBaseUrl: async (baseUrl: string) => { await setSequenceBaseUrl(connection, baseUrl); },

    setRule: async (rule: Record<string, unknown>) => {
      const parsed = ruleFrom(rule);
      if (!parsed) return;
      // Hiding keeps a kind out of the list and answers nothing: it has a
      // list of its own, so it cannot stand where a response to it stands.
      if (parsed.verb === 'hide') {
        hideKind(connection, rule);
        await persistRules(connection, false, `${parsed.key} hidden from the list`);
        return;
      }
      const made = !sessions.get(connection)?.boundaryRules?.has(parsed.key);
      setBoundaryRule(connection, parsed);
      // The steps it answers at in the open sequence, as the editor chose
      // them; one made from a row is used where it was made.
      const use = useFrom(rule.use)
        ?? (parsed.step !== undefined ? [parsed.step] : made ? 'all' as const : undefined);
      if (use) setResponseUse(connection, parsed.key, use);
      await persistRules(connection, false, parsed.verb === 'block' ? `${parsed.key} blocked` : `response to ${parsed.key} replaced`);
    },
    clearRule: async (key: string) => {
      clearBoundaryRule(connection, key);
      await persistRules(connection, false, `${key} let through again`);
    },
    ignoreTraffic: async (rule: Record<string, unknown>) => {
      hideKind(connection, rule);
      await persistRules(connection, false, `${rule.any ? `everything on ${String(rule.url ?? 'a socket')}` : String(rule.key ?? '')} ignored`);
    },
    unhideKind: async (key: string) => {
      unhideKind(connection, key);
      await persistRules(connection, false, `${key} listed again`);
    },
    setHiddenUse: async (key: string, on: boolean) => {
      setHiddenUse(connection, key, on);
      await persistRules(connection, false, `${key} ${on ? 'hidden' : 'listed'} in this sequence`);
    },
    setHiddenMode: async (key: string, mode: HiddenKind['mode']) => {
      setHiddenMode(connection, key, mode);
      await persistRules(connection, false, `${key} hidden ${mode === 'local' ? 'in this sequence only' : mode === 'optIn' ? 'where a sequence opts in' : 'unless a sequence opts out'}`);
    },
    setResponseUse: async (key: string, use: unknown) => {
      const parsed = useFrom(use);
      if (!parsed) return;
      setResponseUse(connection, key, parsed);
      const said = parsed === 'none' ? 'not used here'
        : parsed === 'all' ? 'used at every step' : `used at step ${parsed.map(n => n + 1).join(', ')}`;
      await persistRules(connection, false, `${key} ${said}`);
    },
    setResponseMode: async (key: string, mode: 'local' | 'optIn' | 'optOut') => {
      setResponseMode(connection, key, mode);
      const said = mode === 'local' ? 'answers in this sequence only'
        : mode === 'optIn' ? 'answers where a sequence opts in' : 'answers unless a sequence opts out';
      await persistRules(connection, false, `${key} ${said}`);
    },
    setName: async (key: string, name: string) => {
      setBoundaryName(connection, key, name);
      await persistRules(connection, false, name.trim() ? `${nameTarget(key)} named "${name.trim()}"` : `name taken off ${nameTarget(key)}`);
    },
    moveActivity: async (move: ActivityMove) => {
      const session = sessions.get(connection);
      if (!session?.sequences || session.recordingSequence) return;
      const failure = await session.sequences.saveMove(move);
      if (failure) session.sequenceFailure = failure;
    },
    setRecorded: async (step: number, kind: string, recorded: KindCount | undefined) => {
      const session = sessions.get(connection);
      if (!session?.sequences || session.recordingSequence) return;
      const failure = await session.sequences.saveRecorded(step, kind, recorded);
      if (failure) session.sequenceFailure = failure;
    },
    setExpected: async (step: number, kind: string, expected: ExpectedValue | undefined) => {
      const session = sessions.get(connection);
      if (!session?.sequences || session.recordingSequence) return;
      const failure = await session.sequences.saveExpected(step, kind, expected);
      if (failure) session.sequenceFailure = failure;
    },
    setRefuseWrites: async (on: boolean) => {
      const live = getProxy(connection);
      if (!live) return 'no proxy';
      live.refuseUnmatchedWrites(on);
      await persistRules(connection, false, on ? 'unmatched writes refused' : 'unmatched writes forwarded');
      return on
        ? 'unmatched writes are answered 403 and recorded as refused'
        : 'unmatched writes reach the server';
    },

    /**
     * Write the decisions: responses and hidden kinds to the site file, and the
     * open sequence's uses of them onto the sequence.
     *
     * The events are not written with them: they are a reading of one pass,
     * and a pass tomorrow reads differently. What a later run needs is the
     * decision, which is small and does not go stale.
     */
    saveRules: async () => (await persistRules(connection, true)) ?? 'no sequence is open',
  };
}
