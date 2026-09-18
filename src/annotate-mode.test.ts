/**
 * Tests for annotate mode.
 *
 * The properties worth pinning: both clocks stop (a freeze that leaves CSS
 * animations running does not hold the state someone is trying to click), the
 * picker can be disarmed (while armed, every click is a pick and the app cannot
 * be driven at all), and a saved annotation reaches both the file and the event
 * stream - the event being what gets it to a session that is busy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from 'http';
import { initializePaths, setWorkingDirOverride } from './helpers/paths.js';
import { getEventStreamPath } from './session-events.js';
import {
  setFrozen,
  startAnnotateMode,
  stopAnnotateMode,
  tickAnnotateMode,
  saveAnnotation,
  discardPick,
  setPicker,
  getPendingPick,
  getAnnotateSession,
  isAnnotating,
  noteAtStep,
  removeAnnotation,
  notifyAnnotation,
  captureAnnotateScreenshot,
  saveAnnotateScreenshot,
  highlightAnnotation,
  forgetAnnotateSession,
  verifySourceLine,
  getSequenceState,
  selectSequence,
  stepSequence,
  removeSequence,
  gotoSequenceStep,
  setSequenceBaseUrl,
  playSequence,
  cancelSequence,
  type SequenceDriver,
} from './annotate-mode.js';

const SESSION = 'aaaaaaaa';
const CONNECTION = 'app';

const DESCRIBED = {
  tag: 'span',
  selector: '#row-3 > span',
  text: 'saving',
  component: 'StatusRow',
  source: { fileName: '/src/Row.tsx', lineNumber: 12, columnNumber: 4 },
  rect: { x: 10, y: 20, width: 100, height: 20 },
};

interface SentCall {
  method: string;
  params: any;
}

function createFakeClient() {
  const sent: SentCall[] = [];
  const handlers = new Map<string, Array<(payload: any) => any>>();
  let detached = false;

  const client: any = {
    sent,
    detached: () => detached,
    /** The page's own clock, as performance.now() would report it. */
    clock: 1000,
    /** How far the clock moves when a resume lands on the next callback. */
    stepMs: 40,
    /** true = nothing is scheduled, so a resume never pauses again. */
    quiet: false,
    /** true = an idle page: Debugger.pause arms a pause instead of taking one,
     *  so no paused event arrives. */
    idle: false,
    /** true = the page stays stopped after the usual release, as it does when
     *  the pause is held somewhere this session cannot see. */
    heldAfterRelease: false,
    /** true = DOM.querySelector finds nothing, as it does once the annotated
     *  element has been re-rendered away. */
    missingNode: false,
    send: vi.fn(async (method: string, params?: any) => {
      sent.push({ method, params });
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: client.missingNode ? 0 : 42 };
      if (method === 'Page.captureScreenshot') {
        return { data: Buffer.from('png-bytes').toString('base64') };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression ?? '').includes('getBoundingClientRect')) {
        return client.missingNode
          ? { result: { value: null } }
          : { result: { value: JSON.stringify({ x: 10, y: 20, width: 100, height: 40 }) } };
      }
      if (method === 'Runtime.evaluate' && String(params?.expression ?? '').includes('querySelector')) {
        return { result: client.missingNode ? {} : { objectId: 'node-1' } };
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: DESCRIBED } };
      if (method === 'Runtime.evaluate') {
        // The liveness probe: a held page never settles it.
        if (String(params?.expression ?? '').includes('setTimeout')) {
          if (client.heldAfterRelease) return new Promise(() => {});
          return { result: { value: true } };
        }
        return { result: { value: client.clock } };
      }
      if (method === 'Debugger.pause' && !client.idle) {
        setTimeout(() => client.emit('Debugger.paused', { reason: 'debugCommand', callFrames: [] }), 0);
      }
      if (method === 'Debugger.resume' && !client.quiet) {
        // Chrome runs to the next scheduled callback and pauses there, naming
        // what scheduled it and where it is.
        client.clock += client.stepMs;
        setTimeout(() => client.emit('Debugger.paused', {
          reason: 'EventListener',
          data: { eventName: 'instrumentation:setInterval.callback' },
          callFrames: [{
            functionName: 'tickCounter',
            location: { scriptId: 'script-1', lineNumber: 8, columnNumber: 2 },
          }],
        }), 0);
      }
      return {};
    }),
    on: (event: string, handler: (payload: any) => any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    off: (event: string, handler: (payload: any) => any) => {
      const list = handlers.get(event);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    detach: vi.fn(async () => { detached = true; }),
    emit: async (event: string, payload: any) => {
      for (const handler of [...(handlers.get(event) ?? [])]) await handler(payload);
    },
    sessionsHandedOut: 0,
    repair: undefined as string[] | undefined,
    calls: (method: string) => sent.filter(c => c.method === method),
    lastCall: (method: string) => [...sent].reverse().find(c => c.method === method),
    inspectModes: () => sent.filter(c => c.method === 'Overlay.setInspectMode').map(c => c.params.mode),
  };
  return client;
}

function createFakePage(client: any) {
  return {
    createCDPSession: async () => {
      // A repair session is a second, independent agent on the same page.
      if (client.sessionsHandedOut++ > 0) {
        client.repair = client.repair ?? [];
        return {
          send: async (method: string) => { client.repair.push(method); client.heldAfterRelease = false; return {}; },
          on: () => {}, off: () => {}, detach: async () => {},
        } as any;
      }
      return client;
    },
    url: () => 'http://localhost:5173/orders',
  } as any;
}

/** The test environment's fetch enforces CORS; the real control page is
 *  same-origin with its own server, so drive the routes over plain HTTP. */
function http(url: string, options: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(url, {
      method: options.method ?? 'GET',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readEvents(): Array<Record<string, unknown>> {
  const path = getEventStreamPath(SESSION);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/**
 * A note is stored in a sequence step, so a session that can save one needs a
 * sequence open. This is the smallest driver that holds notes: two steps and
 * the store behind them.
 */
function noteSequences() {
  const steps: any[] = [
    { label: 'navigate.goto /orders' },
    { label: 'input.click #save' },
  ];
  let open = true;
  return {
    steps,
    listNames: async () => ['orders'],
    active: () => (open ? { name: 'orders', currentStep: 1, total: steps.length, steps, variables: [] } : null),
    start: async () => { open = true; return undefined; },
    step: async () => undefined,
    goto: async () => undefined,
    finish: async () => undefined,
    cancel: async () => { open = false; },
    remove: async () => undefined,
    attachAnnotation: async (step: number, annotation: any) => {
      const command = steps[step];
      if (!command) return `step ${step + 1} is not in the sequence`;
      command.annotations = [...(command.annotations ?? []), annotation];
      return undefined;
    },
    attachScreenshot: async (id: string, path: string) => {
      for (const command of steps) {
        const note = (command.annotations ?? []).find((n: any) => n.id === id);
        if (!note) continue;
        note.screenshots = [...(note.screenshots ?? []), path];
        return undefined;
      }
      return 'that note is not in the open sequence';
    },
    detachAnnotation: async (id: string) => {
      let found = false;
      for (const command of steps) {
        const kept = (command.annotations ?? []).filter((note: any) => note.id !== id);
        if (kept.length !== (command.annotations ?? []).length) { found = true; command.annotations = kept; }
      }
      return found ? undefined : 'that note is not in the open sequence';
    },
    findAnnotation: (id: string) => {
      for (let step = 0; step < steps.length; step++) {
        const annotation = (steps[step].annotations ?? []).find((note: any) => note.id === id);
        if (annotation) return { annotation, step, sequence: 'orders' };
      }
      return undefined;
    },
    issue: async () => undefined,
    setBaseUrl: () => {},
    baseUrl: () => undefined,
  };
}

/** Every note the fake sequence is holding, step order then save order. */
function notesIn(sequences: ReturnType<typeof noteSequences>) {
  return sequences.steps.flatMap((command: any) => command.annotations ?? []);
}

let noteDriver: ReturnType<typeof noteSequences>;

/** The session exactly as startAnnotateMode leaves it. */
async function startBare(client: any) {
  noteDriver = noteSequences();
  return startAnnotateMode({
    page: createFakePage(client), connection: CONNECTION, sessionName: SESSION, sequences: noteDriver as any,
  });
}

/** A session in the state the rest of the work happens in: held, picker armed. */
async function start(client: any) {
  const state = await startBare(client);
  await setPicker(CONNECTION, true);
  await setFrozen(CONNECTION, true);
  return state;
}

/** Chrome reporting that the person clicked an element with the picker armed. */
async function pick(client: any) {
  await client.emit('Overlay.inspectNodeRequested', { backendNodeId: 7 });
}

let dir: string;
let previousDir: string | undefined;

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-annotate-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
  // Annotations are project-scoped; the env var only moves the global dir.
  setWorkingDirOverride(dir);
});

afterEach(async () => {
  forgetAnnotateSession(CONNECTION);
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

describe('startAnnotateMode', () => {
  it('stops both clocks - the page\'s JS and the compositor - when held', async () => {
    const client = createFakeClient();
    await start(client);

    expect(client.calls('Debugger.pause')).toHaveLength(1);
    expect(client.lastCall('Animation.setPlaybackRate').params).toEqual({ playbackRate: 0 });
  });

  it('touches neither clock on start, so the app can be driven to the state', async () => {
    const client = createFakeClient();
    await startBare(client);

    expect(client.calls('Debugger.pause')).toHaveLength(0);
    expect(client.calls('Animation.setPlaybackRate')).toHaveLength(0);
  });

  it('never turns on virtual time, which cannot be turned off again', async () => {
    const client = createFakeClient();
    await start(client);
    await tickAnnotateMode(CONNECTION, { budgetMs: 100 });

    expect(client.calls('Emulation.setVirtualTimePolicy')).toHaveLength(0);
  });

  it('arms Chrome\'s own picker rather than injecting one', async () => {
    const client = createFakeClient();
    await start(client);

    const inspect = client.lastCall('Overlay.setInspectMode');
    expect(inspect.params.mode).toBe('searchForNode');
    expect(inspect.params.highlightConfig).toBeDefined();
  });

  it('injects nothing into the page being annotated', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    // Runtime.callFunctionOn describes the picked node, and the only evaluation
    // is reading the page's clock. Anything else would be UI rendered into a
    // page that may be too frozen to run it.
    const expressions = client.calls('Runtime.evaluate').map((c: SentCall) => c.params.expression);
    expect(expressions.every((e: string) => e === 'performance.now()')).toBe(true);
    expect(client.calls('Runtime.addBinding')).toHaveLength(0);
  });

  it('serves a control pane and reports where it is', async () => {
    const client = createFakeClient();
    const state = await start(client);

    expect(state.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/$/);
  });

  it('opens the control tab when one can be opened', async () => {
    const client = createFakeClient();
    const opened: string[] = [];

    await startAnnotateMode({
      page: createFakePage(client),
      connection: CONNECTION,
      sessionName: SESSION,
      openControlTab: async (url: string) => { opened.push(url); return undefined; },
    });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('127.0.0.1');
  });

  it('re-arms an already running mode instead of freezing twice', async () => {
    const client = createFakeClient();
    await start(client);

    await start(client);

    expect(client.calls('Debugger.pause')).toHaveLength(1);
    expect(new Set(client.inspectModes())).toEqual(new Set(['searchForNode']));
  });
});

describe('picking an element', () => {
  it('holds the pick for the control pane rather than blocking on it', async () => {
    const client = createFakeClient();
    await start(client);

    await pick(client);

    expect(getPendingPick(CONNECTION)).toMatchObject({
      selector: '#row-3 > span',
      component: 'StatusRow',
    });
  });

  it('reports the picker as idle once it has fired', async () => {
    const client = createFakeClient();
    await start(client);

    await pick(client);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ picks: 1, pickerArmed: false });
  });

  it('saves what the element is, not a description of it', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await saveAnnotation(CONNECTION, 'flashes empty here');

    const annotations = notesIn(noteDriver);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      url: 'http://localhost:5173/orders',
      comment: 'flashes empty here',
      tick: 0,
      target: {
        selector: '#row-3 > span',
        component: 'StatusRow',
        source: { fileName: '/src/Row.tsx', lineNumber: 12 },
      },
    });
  });

  it('announces the annotation on the event stream', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await saveAnnotation(CONNECTION, 'flashes empty here');

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'annotation',
      connection: CONNECTION,
      selector: '#row-3 > span',
      component: 'StatusRow',
      comment: 'flashes empty here',
    });
    expect(events[0].detail).toContain('flashes empty here');
  });

  it('records the tick the pick happened at', async () => {
    const client = createFakeClient();
    client.stepMs = 100;
    await start(client);
    await tickAnnotateMode(CONNECTION, { budgetMs: 300 });
    await pick(client);

    await saveAnnotation(CONNECTION, 'gone by now');

    expect(notesIn(noteDriver)[0].tick).toBe(300);
  });

  it('re-arms the picker after a save, so picks continue without another call', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await saveAnnotation(CONNECTION, 'one');

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ picks: 1, annotations: 1, pickerArmed: true });
    expect(getPendingPick(CONNECTION)).toBeNull();
  });

  it('writes nothing on discard but still re-arms', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await discardPick(CONNECTION);

    expect(notesIn(noteDriver)).toHaveLength(0);
    expect(readEvents()).toHaveLength(0);
    expect(getPendingPick(CONNECTION)).toBeNull();
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ pickerArmed: true });
  });

  it('files the note against the step the + named, not the one the run is on', async () => {
    // A sequence's first step is the navigate; by the time anything is worth
    // annotating the run has moved past it, so the step has to be chosen.
    const client = createFakeClient();
    await start(client);
    await noteAtStep(CONNECTION, 0);
    await pick(client);

    await saveAnnotation(CONNECTION, 'wrong page opens');

    expect(noteDriver.steps[0].annotations).toHaveLength(1);
    expect(noteDriver.steps[0].annotations[0].comment).toBe('wrong page opens');
    expect(noteDriver.steps[1].annotations).toBeUndefined();
  });

  it('goes back to the step the run is on once a note has been filed', async () => {
    const client = createFakeClient();
    await start(client);
    await noteAtStep(CONNECTION, 0);
    await pick(client);
    await saveAnnotation(CONNECTION, 'first');
    await pick(client);

    await saveAnnotation(CONNECTION, 'second');

    expect(noteDriver.steps[0].annotations).toHaveLength(1);
    expect(noteDriver.steps[1].annotations).toHaveLength(1);
  });

  it('holds the pick when no sequence is open, so selecting one saves it', async () => {
    const client = createFakeClient();
    await startAnnotateMode({ page: createFakePage(client), connection: CONNECTION, sessionName: SESSION });
    await pick(client);

    expect(await saveAnnotation(CONNECTION, 'nowhere to go')).toBeUndefined();
    expect(getPendingPick(CONNECTION)).not.toBeNull();
  });

  it('shows the note under its step, which is where it was filed', async () => {
    // The write reaching the file is not enough: a note the pane does not show
    // reads as one that was never taken.
    const client = createFakeClient();
    await start(client);
    await noteAtStep(CONNECTION, 0);
    await pick(client);
    await saveAnnotation(CONNECTION, 'wrong page opens');

    const state = await getSequenceState(CONNECTION);

    expect(state!.steps[0].annotations).toHaveLength(1);
    expect(state!.steps[0].annotations![0].comment).toBe('wrong page opens');
    expect(state!.steps[1].annotations).toBeUndefined();
  });

  it('puts a saved note back on the event stream on demand', async () => {
    // A note reaches the stream once and scrolls past; NOTIFY hands the agent
    // the same element and comment again without them being described twice.
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await saveAnnotation(CONNECTION, 'pill never clears');
    const [note] = notesIn(noteDriver);

    await notifyAnnotation(CONNECTION, note.id);

    const events = readEvents().filter(e => e.kind === 'annotation');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      annotationId: note.id,
      notify: true,
      comment: 'pill never clears',
      selector: '#row-3 > span',
    });
    expect(String(events[1].detail)).toContain('pill never clears');
  });

  it('says so rather than announcing nothing for a note that is not there', async () => {
    const client = createFakeClient();
    await start(client);

    await notifyAnnotation(CONNECTION, 'never-saved');

    expect(readEvents().filter(e => e.kind === 'annotation')).toHaveLength(0);
    expect((await getSequenceState(CONNECTION))!.failure).toBe('that note is not in the open sequence');
  });

  it('files a pick against the step the run is on when no pen was used', async () => {
    // Armed from the top strip there is no pen lit, and the note still has to
    // land somewhere the person can predict.
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await saveAnnotation(CONNECTION, 'from the top strip');

    // noteSequences reports currentStep 1.
    expect(noteDriver.steps[1].annotations).toHaveLength(1);
    expect(noteDriver.steps[0].annotations).toBeUndefined();
  });

  it('carries every capture accepted while the pick waited', async () => {
    // The state a note describes is gone by the time anyone reads it, and the
    // words alone do not bring it back.
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span');
    await saveAnnotateScreenshot(CONNECTION);
    await captureAnnotateScreenshot(CONNECTION);
    await saveAnnotateScreenshot(CONNECTION);

    await saveAnnotation(CONNECTION, 'the pill is wrong');

    const [note] = notesIn(noteDriver);
    expect(note.screenshots).toHaveLength(2);
    for (const path of note.screenshots) expect(existsSync(path)).toBe(true);
  });

  it('adds a later capture to the note it was taken from', async () => {
    // Taken from a note's own camera, a capture that lands on its own leaves
    // the note without the picture its button just took.
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await saveAnnotation(CONNECTION, 'the pill is wrong');
    const [note] = notesIn(noteDriver);

    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span', 0, note.id);
    await saveAnnotateScreenshot(CONNECTION);

    expect(notesIn(noteDriver)[0].screenshots).toHaveLength(1);
  });

  it('keeps the note through a widen, so the picture still joins it', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await saveAnnotation(CONNECTION, 'the pill is wrong');
    const [note] = notesIn(noteDriver);

    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span', 0, note.id);
    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span', 2, note.id);
    await saveAnnotateScreenshot(CONNECTION);

    expect(notesIn(noteDriver)[0].screenshots).toHaveLength(1);
  });

  it('saves without captures when none were accepted', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);

    await saveAnnotation(CONNECTION, 'no picture');

    expect(notesIn(noteDriver)[0].screenshots).toBeUndefined();
  });

  it('drops captures gathered for a pick that was discarded', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span');
    await saveAnnotateScreenshot(CONNECTION);

    await discardPick(CONNECTION);
    await pick(client);
    await saveAnnotation(CONNECTION, 'a different note');

    expect(notesIn(noteDriver)[0].screenshots).toBeUndefined();
  });

  it('removes a note from the sequence it is stored in', async () => {
    const client = createFakeClient();
    await start(client);
    await pick(client);
    await saveAnnotation(CONNECTION, 'goes away');
    const [note] = notesIn(noteDriver);

    await removeAnnotation(CONNECTION, note.id);

    expect(notesIn(noteDriver)).toHaveLength(0);
  });

  it('saves nothing when no pick is waiting', async () => {
    const client = createFakeClient();
    await start(client);

    expect(await saveAnnotation(CONNECTION, 'stray')).toBeUndefined();
    expect(notesIn(noteDriver)).toHaveLength(0);
  });
});

describe('a pause that is not annotate\'s', () => {
  it('is left stopped rather than resumed', async () => {
    const client = createFakeClient();
    await start(client);

    // Someone else's breakpoint lands - annotate never asked for it.
    await client.emit('Debugger.paused', { reason: 'other', callFrames: [] });
    const resumesBefore = client.calls('Debugger.resume').length;

    await stopAnnotateMode(CONNECTION);

    // Releasing our own hold may resume once; nothing re-attaches to clear
    // theirs, because that would discard what they stopped to look at.
    expect(client.repair).toBeUndefined();
    expect(client.calls('Debugger.resume').length).toBeLessThanOrEqual(resumesBefore + 1);
  });

  it('does not re-attach a second agent to force the page on', async () => {
    const client = createFakeClient();
    await start(client);
    client.heldAfterRelease = true;   // the page stays stopped

    await stopAnnotateMode(CONNECTION);

    expect(client.repair).toBeUndefined();
  });
});

describe('an idle page, where the pause is armed rather than taken', () => {
  it('still reports the page as held', async () => {
    const client = createFakeClient();
    client.idle = true;
    await start(client);

    // Nothing is running to stop, but nothing can run either.
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true });
  });

  it('discards the armed pause instead of resuming something that is not paused', async () => {
    const client = createFakeClient();
    client.idle = true;
    await start(client);

    await setFrozen(CONNECTION, false);

    // Debugger.resume would fail with "Can only perform operation while paused"
    // and leave the armed pause to stop the page later, with no owner.
    expect(client.calls('Debugger.resume')).toHaveLength(0);
    expect(client.calls('Debugger.disable').length).toBeGreaterThan(0);
    expect(client.calls('Debugger.enable').length).toBeGreaterThan(1);
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: false });
  });

  it('releases cleanly on stop, leaving no armed pause behind', async () => {
    const client = createFakeClient();
    client.idle = true;
    await start(client);

    await stopAnnotateMode(CONNECTION);

    expect(client.calls('Debugger.resume')).toHaveLength(0);
    expect(client.calls('Debugger.disable').length).toBeGreaterThan(0);
    expect(client.detached()).toBe(true);
  });

  it('steps without resuming, since the armed pause is what the page runs into', async () => {
    const client = createFakeClient();
    client.idle = true;
    client.stepMs = 30;
    await start(client);

    // The page reaches a callback on its own and stops on the armed pause.
    const stepping = tickAnnotateMode(CONNECTION, { steps: 1 });
    await new Promise(r => setTimeout(r, 5));
    client.clock += 30;
    await client.emit('Debugger.paused', { reason: 'EventListener', callFrames: [] });
    const tick = await stepping;

    expect(client.calls('Debugger.resume')).toHaveLength(0);
    expect(tick).toMatchObject({ steps: 1 });

    // That pause is a real one, so the next step does resume - and the fake
    // answers a resume with the next pause, as Chrome would.
    client.idle = false;
    await tickAnnotateMode(CONNECTION, { steps: 1 });
    expect(client.calls('Debugger.resume')).toHaveLength(1);
  });
});

describe('closing the control tab', () => {
  /** A stand-in for the puppeteer Page of the control tab. */
  function fakeControlTab() {
    const handlers: Array<() => void> = [];
    return {
      on: (event: string, handler: () => void) => { if (event === 'close') handlers.push(handler); },
      close: async () => { for (const h of [...handlers]) h(); },
      closedByUser: async () => { for (const h of [...handlers]) h(); },
    } as any;
  }

  it('releases the page and ends the mode', async () => {
    const client = createFakeClient();
    const tab = fakeControlTab();
    await startAnnotateMode({
      page: createFakePage(client), connection: CONNECTION, sessionName: SESSION,
      openControlTab: async () => tab,
    });
    await setFrozen(CONNECTION, true);

    await tab.closedByUser();
    await new Promise(r => setTimeout(r, 10));

    expect(isAnnotating(CONNECTION)).toBe(false);
    expect(client.calls('Debugger.resume').length).toBeGreaterThan(0);
    expect(client.lastCall('Animation.setPlaybackRate').params).toEqual({ playbackRate: 1 });
    expect(client.calls('Debugger.disable')).toHaveLength(1);
    expect(client.detached()).toBe(true);
  });

  it('stops serving the control pane', async () => {
    const client = createFakeClient();
    const tab = fakeControlTab();
    const { controlUrl } = await startAnnotateMode({
      page: createFakePage(client), connection: CONNECTION, sessionName: SESSION,
      openControlTab: async () => tab,
    });

    await tab.closedByUser();
    await new Promise(r => setTimeout(r, 10));

    await expect(http(controlUrl + 'state')).rejects.toThrow();
  });

  it('keeps annotations already saved', async () => {
    const client = createFakeClient();
    const tab = fakeControlTab();
    const sequences = noteSequences();
    await startAnnotateMode({
      page: createFakePage(client), connection: CONNECTION, sessionName: SESSION,
      openControlTab: async () => tab,
      sequences: sequences as any,
    });
    await pick(client);
    await saveAnnotation(CONNECTION, 'still here afterwards');

    await tab.closedByUser();
    await new Promise(r => setTimeout(r, 10));

    const annotations = notesIn(sequences);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].comment).toBe('still here afterwards');
  });

  it('does not recurse when stop closes the tab itself', async () => {
    const client = createFakeClient();
    const tab = fakeControlTab();
    await startAnnotateMode({
      page: createFakePage(client), connection: CONNECTION, sessionName: SESSION,
      openControlTab: async () => tab,
    });

    await stopAnnotateMode(CONNECTION);
    await new Promise(r => setTimeout(r, 10));

    // The close handler fires during stop; the session is already gone by then,
    // so the page is released exactly once.
    expect(client.calls('Debugger.disable')).toHaveLength(1);
    expect(isAnnotating(CONNECTION)).toBe(false);
  });
});

describe('a step and the rest of devharness', () => {
  it('takes the debugger out of the way and puts it back', async () => {
    // Puppeteer's queries block on a paused isolate, and a step finds its
    // element that way - so a pause landing mid-step reads as a missing
    // element. The agent detaches for the step and returns afterwards.
    const client = createFakeClient();
    const sequences = (() => {
      const steps = [{ label: 'input.click #save' }];
      let open: { name: string; currentStep: number } | null = null;
      return {
        listNames: async () => ['one-step'],
        active: () => (open ? { name: 'one-step', currentStep: open.currentStep, total: 1, steps, variables: [] } : null),
        start: async () => { open = { name: 'one-step', currentStep: 0 }; return undefined; },
        step: async () => {
          // What the tool sees while the step runs.
          order.push(...client.sent.slice(-3).map((c: any) => c.method));
          if (open) open.currentStep += 1;
          return undefined;
        },
        goto: async () => undefined,
        finish: async () => undefined,
        cancel: async () => { open = null; },
        remove: async () => undefined,
        attachAnnotation: async () => undefined,
        detachAnnotation: async () => undefined,
        attachScreenshot: async () => undefined,
        record: async () => undefined,
        trafficIn: async () => ({ requests: 0, failed: 0, frames: 0, lines: [] }),
    stopRecording: async () => {},
    cancelRecording: async () => {},
    removeStep: async () => undefined,
    setVariable: async () => undefined,
    removeVariable: async () => undefined,
    moveStep: async () => undefined,
    recordedSoFar: () => [],
        findAnnotation: () => undefined,
        issue: async () => undefined,
        setBaseUrl: () => {},
        baseUrl: () => undefined,
      };
    })();
    const order: string[] = [];

    await startAnnotateMode({ page: createFakePage(client), connection: CONNECTION, sessionName: SESSION, sequences });
    await selectSequence(CONNECTION, 'one-step');
    await stepSequence(CONNECTION);

    expect(order).toContain('Debugger.disable');
    expect(client.calls('Debugger.setSkipAllPauses').map((c: any) => c.params.skip)).toEqual([true, false, true, false]);
    expect(client.calls('Debugger.enable').length).toBeGreaterThan(1);
  });

});

describe('stepping a sequence', () => {
  /** Stands in for replay's step-through session. */
  function fakeSequences() {
    const calls: string[] = [];
    let open: { name: string; currentStep: number } | null = null;
    const steps = [
      { label: 'navigate.goto /orders' },
      { label: 'input.click #save', comment: 'expect the saving pill' },
      { label: 'assert.text .toast', resolved: 'assert.text .toast contains 4471' },
    ];
    const variables = [{ name: 'orderId', value: '4471', source: 'step 2' }];
    let base = '';
    let saved = ['checkout-flow', 'login'];
    const driver: SequenceDriver & { calls: string[]; open: () => any; nextFailure?: string } = {
      calls,
      open: () => open,
      listNames: async () => [...saved],
      active: () => (open
        ? { name: open.name, description: 'checkout end to end', currentStep: open.currentStep, total: steps.length, steps, variables }
        : null),
      start: async (name: string) => { calls.push(`start:${name}`); open = { name, currentStep: 0 }; return undefined; },
      step: async () => { calls.push('step'); if (open) open.currentStep += 1; return driver.nextFailure; },
      finish: async () => { calls.push('finish'); if (open) open.currentStep = steps.length; return undefined; },
      goto: async (step: number) => { calls.push(`goto:${step}`); open = { name: open?.name ?? 'checkout-flow', currentStep: step + 1 }; return undefined; },
      attachScreenshot: async () => undefined,
      record: async () => undefined,
      trafficIn: async () => ({ requests: 0, failed: 0, frames: 0, lines: [] }),
    stopRecording: async () => {},
    cancelRecording: async () => {},
    removeStep: async () => undefined,
    setVariable: async () => undefined,
    removeVariable: async () => undefined,
    moveStep: async () => undefined,
    recordedSoFar: () => [],
      findAnnotation: () => undefined,
      issue: async () => undefined,
      setBaseUrl: (value: string) => { calls.push(`baseUrl:${value}`); base = value; },
      baseUrl: () => base || undefined,
      cancel: async () => { calls.push('cancel'); open = null; },
      attachAnnotation: async (step: number, annotation: any) => {
        calls.push(`attach:${step}`);
        const command: any = steps[step];
        if (!command) return `step ${step + 1} is not in the sequence`;
        command.annotations = [...(command.annotations ?? []), annotation];
        return undefined;
      },
      detachAnnotation: async (id: string) => {
        calls.push(`detach:${id}`);
        let found = false;
        for (const command of steps as any[]) {
          const kept = (command.annotations ?? []).filter((note: any) => note.id !== id);
          if (kept.length !== (command.annotations ?? []).length) { found = true; command.annotations = kept; }
        }
        return found ? undefined : 'that note is not in the open sequence';
      },
      remove: async (name: string) => {
        calls.push(`remove:${name}`);
        if (!saved.includes(name)) return `no saved sequence named "${name}"`;
        if (open?.name === name) open = null;
        saved = saved.filter(entry => entry !== name);
        return undefined;
      },
    };
    return driver;
  }

  async function startWithSequences(client: any, sequences: SequenceDriver) {
    const state = await startAnnotateMode({
      page: createFakePage(client), connection: CONNECTION, sessionName: SESSION, sequences,
    });
    await setPicker(CONNECTION, true);
    await setFrozen(CONNECTION, true);
    return state;
  }

  it('deleting takes the name out of what can be selected', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);

    const state = await removeSequence(CONNECTION, 'login');

    expect(sequences.calls).toEqual(['remove:login']);
    expect(state).toMatchObject({ available: ['checkout-flow'] });
    expect(state!.failure).toBeUndefined();
  });

  it('drops a run open on the sequence being deleted', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');

    const state = await removeSequence(CONNECTION, 'checkout-flow');

    expect(state).toMatchObject({ available: ['login'], total: 0, currentStep: 0 });
    expect(state!.name).toBeUndefined();
  });

  it('states it on the failure line when the name matched nothing', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);

    const state = await removeSequence(CONNECTION, 'never-recorded');

    expect(state!.failure).toBe('no saved sequence named "never-recorded"');
    expect(state).toMatchObject({ available: ['checkout-flow', 'login'] });
  });

  it('offers what can be selected before anything is running', async () => {
    const client = createFakeClient();
    await startWithSequences(client, fakeSequences());

    const state = await getSequenceState(CONNECTION);

    expect(state).toMatchObject({ available: ['checkout-flow', 'login'], total: 0, busy: false, variables: [] });
    expect(state!.name).toBeUndefined();
  });

  it('selecting opens the session without running a step', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);

    const state = await selectSequence(CONNECTION, 'checkout-flow');

    expect(sequences.calls).toEqual(['start:checkout-flow']);
    expect(state).toMatchObject({ name: 'checkout-flow', currentStep: 0, total: 3 });
    expect(state!.steps[0]).toMatchObject({ index: 0, current: true, done: false });
    expect(state!.steps[1]).toMatchObject({ comment: 'expect the saving pill' });
    expect(state!.steps[2]).toMatchObject({ resolved: 'assert.text .toast contains 4471' });
    expect(state!.variables).toEqual([{ name: 'orderId', value: '4471', source: 'step 2' }]);
    expect(state!.description).toBe('checkout end to end');
  });

  it('releases the page for the step and holds it again after', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');

    await stepSequence(CONNECTION);

    // Input is discarded while V8 is stopped, so the step cannot land frozen.
    expect(client.calls('Debugger.resume').length).toBeGreaterThan(0);
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true });
    expect(sequences.calls).toContain('step');
  });

  it('disarms the picker for the step, so it does not eat the click', async () => {
    const client = createFakeClient();
    await startWithSequences(client, fakeSequences());
    await selectSequence(CONNECTION, 'checkout-flow');

    await stepSequence(CONNECTION);

    const modes = client.inspectModes();
    expect(modes).toContain('none');
    expect(modes[modes.length - 1]).toBe('searchForNode');   // put back afterwards
  });

  it('leaves a page that was already running alone', async () => {
    const client = createFakeClient();
    await startWithSequences(client, fakeSequences());
    await selectSequence(CONNECTION, 'checkout-flow');
    await setFrozen(CONNECTION, false);

    await stepSequence(CONNECTION);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: false });
  });

  it('advances the marked step', async () => {
    const client = createFakeClient();
    await startWithSequences(client, fakeSequences());
    await selectSequence(CONNECTION, 'checkout-flow');

    await stepSequence(CONNECTION);
    const state = await getSequenceState(CONNECTION);

    expect(state!.currentStep).toBe(1);
    expect(state!.steps[0]).toMatchObject({ done: true, current: false });
    expect(state!.steps[1]).toMatchObject({ done: false, current: true });
  });

  it('holds the last position when the run ends, rather than reading as unstarted', async () => {
    // replay drops its session as the last step runs; falling back to "selected
    // but not started" would put the cursor at 0 while the page shows the end.
    const client = createFakeClient();
    const sequences = fakeSequences();
    let closed = false;
    sequences.active = () => (closed
      ? { name: 'checkout-flow', description: '', currentStep: 3, total: 3, steps: [], variables: [] }
      : { name: 'checkout-flow', description: '', currentStep: 2, total: 3, steps: [], variables: [] });
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');

    closed = true;
    const state = await getSequenceState(CONNECTION);

    expect(state!.currentStep).toBe(3);
    expect(state!.steps).toEqual([]);
  });

  it('plays to the end and cancels back to nothing', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');

    await playSequence(CONNECTION);
    expect((await getSequenceState(CONNECTION))!.currentStep).toBe(3);
    // Play steps rather than handing the whole run over: each action gets its
    // own release of the page, which is the path that survives a navigation.
    expect(sequences.calls.filter(c => c === 'step')).toHaveLength(3);

    const after = await cancelSequence(CONNECTION);
    expect(sequences.calls.at(-1)).toBe('cancel');
    expect(after!.name).toBeUndefined();
  });

  it('shows why a step stopped, since replay reports a failure rather than throwing', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');
    sequences.nextFailure = 'Could not validate navigation';

    await stepSequence(CONNECTION);

    expect((await getSequenceState(CONNECTION))!.failure).toBe('Could not validate navigation');
  });

  it('clears the failure when the next step is taken', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');
    sequences.nextFailure = 'boom';
    await stepSequence(CONNECTION);

    sequences.nextFailure = undefined;
    await stepSequence(CONNECTION);

    expect((await getSequenceState(CONNECTION))!.failure).toBeUndefined();
  });

  it('goes back to the step an annotation was taken at', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');
    await stepSequence(CONNECTION);
    await stepSequence(CONNECTION);

    const state = await gotoSequenceStep(CONNECTION, 0);

    expect(sequences.calls).toContain('goto:0');
    expect(state!.currentStep).toBe(1);
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true });
  });

  it('records which step an annotation was taken at', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');
    await stepSequence(CONNECTION);
    await pick(client);

    await saveAnnotation(CONNECTION, 'pill never clears');

    // Stored in the command the run had reached: the step it belongs to is the
    // one holding it, so no step number is written beside the note.
    expect(sequences.calls).toContain('attach:1');
  });

  it('tells the driver which connection to drive, so it can rebind the sequence', async () => {
    // A sequence names the connections it was recorded against; without being
    // told which tab is meant here, its steps drive something else entirely.
    const bound: Array<{ name: string; connection: string }> = [];
    const client = createFakeClient();
    const sequences = fakeSequences();
    const realStart = sequences.start;
    sequences.start = async (name: string, connection: string) => {
      bound.push({ name, connection });
      return realStart(name, connection);
    };
    await startWithSequences(client, sequences);

    await selectSequence(CONNECTION, 'checkout-flow');

    expect(bound).toEqual([{ name: 'checkout-flow', connection: CONNECTION }]);
  });

  it('carries a base url so a recorded port can be pointed elsewhere', async () => {
    const client = createFakeClient();
    const sequences = fakeSequences();
    await startWithSequences(client, sequences);
    await selectSequence(CONNECTION, 'checkout-flow');

    const state = await setSequenceBaseUrl(CONNECTION, 'http://localhost:9500');

    expect(sequences.calls).toContain('baseUrl:http://localhost:9500');
    expect(state!.baseUrl).toBe('http://localhost:9500');
  });

  it('reports no sequence state when no driver is wired in', async () => {
    const client = createFakeClient();
    await startAnnotateMode({ page: createFakePage(client), connection: CONNECTION, sessionName: SESSION });

    expect(await getSequenceState(CONNECTION)).toBeUndefined();
  });
});

describe('capturing the page', () => {
  it('holds the capture rather than writing it, until it is accepted', async () => {
    // A clip that caught the wrong element is apparent while it is on screen,
    // not in a directory of files nobody opened.
    const client = createFakeClient();
    await start(client);

    const taken = await captureAnnotateScreenshot(CONNECTION);

    expect('shot' in taken).toBe(true);
    expect(readEvents().filter(e => e.kind === 'screenshot')).toHaveLength(0);
  });

  it('writes the accepted capture and announces where it landed', async () => {
    const client = createFakeClient();
    await start(client);
    await captureAnnotateScreenshot(CONNECTION);

    const saved = await saveAnnotateScreenshot(CONNECTION);

    expect('path' in saved).toBe(true);
    if (!('path' in saved)) return;
    expect(existsSync(saved.path)).toBe(true);
    expect(readEvents().find(e => e.kind === 'screenshot')).toMatchObject({ path: saved.path });
  });

  it('names the file after the element it is a picture of', async () => {
    const client = createFakeClient();
    await start(client);
    await captureAnnotateScreenshot(CONNECTION, '.session-row:has-text("8d76da6e") .entry-count');

    const saved = await saveAnnotateScreenshot(CONNECTION);

    if (!('path' in saved)) throw new Error('expected a path');
    expect(saved.path).toContain('session-row');
    expect(saved.path).toContain('entry-count');
    expect(saved.path.endsWith('.png')).toBe(true);
    // A class selector starts with a dot, which would make the file hidden and
    // absent from the directory it was saved to.
    expect(saved.path.split('/').pop()!.startsWith('.')).toBe(false);
  });

  it('widens the clip by walking out to the parent', async () => {
    const client = createFakeClient();
    await start(client);

    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span', 2);

    const box = client.calls('Runtime.evaluate')
      .filter((c: any) => String(c.params?.expression ?? '').includes('getBoundingClientRect')).at(-1);
    expect(box.params.expression).toContain('out < 2');
    expect(client.lastCall('Page.captureScreenshot').params.clip).toBeDefined();
  });

  it('refuses to save when nothing is waiting', async () => {
    const client = createFakeClient();
    await start(client);

    expect(await saveAnnotateScreenshot(CONNECTION)).toMatchObject({
      failure: 'nothing is waiting to be saved',
    });
  });

  it('captures past the viewport for a whole page, and not for a clip', async () => {
    const client = createFakeClient();
    await start(client);

    await captureAnnotateScreenshot(CONNECTION);
    const whole = client.lastCall('Page.captureScreenshot');
    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span');
    const clipped = client.lastCall('Page.captureScreenshot');

    expect(whole.params.captureBeyondViewport).toBe(true);
    expect(whole.params.clip).toBeUndefined();
    expect(clipped.params.captureBeyondViewport).toBe(false);
    expect(clipped.params.clip).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
  });

  it('records the selector on the event, so the picture says what it is of', async () => {
    const client = createFakeClient();
    await start(client);
    await captureAnnotateScreenshot(CONNECTION, '#row-3 > span');

    await saveAnnotateScreenshot(CONNECTION);

    expect(readEvents().find(e => e.kind === 'screenshot')).toMatchObject({ selector: '#row-3 > span' });
  });

  it('reports a selector that matches nothing rather than writing a blank', async () => {
    const client = createFakeClient();
    client.missingNode = true;
    await start(client);

    const shot = await captureAnnotateScreenshot(CONNECTION, '.gone');

    expect(shot).toMatchObject({ failure: expect.stringContaining('.gone') });
    expect(client.calls('Page.captureScreenshot')).toHaveLength(0);
    expect(readEvents().filter(e => e.kind === 'screenshot')).toHaveLength(0);
  });
});

describe('highlighting an annotated element', () => {
  it('outlines the node the selector finds', async () => {
    const client = createFakeClient();
    await start(client);

    await highlightAnnotation(CONNECTION, '#row-3 > span');

    const query = client.calls('Runtime.evaluate').at(-1);
    expect(query.params.expression).toContain('#row-3 > span');
    expect(client.calls('Overlay.highlightNode')).toHaveLength(1);
  });

  it('matches on text, so a note survives its row moving', async () => {
    // :has-text() is devharness's own extension; DOM.querySelector refuses it,
    // which would leave every durable selector unable to highlight.
    const client = createFakeClient();
    await start(client);

    await highlightAnnotation(CONNECTION, '.session-row:has-text("8d76da6e") .entry-count');

    const query = client.calls('Runtime.evaluate').at(-1);
    // The text is tested against the row, then the cell is found inside it.
    // Flattened to `.session-row .entry-count` the text is tested against the
    // cell, whose own text is a number, and nothing ever matches.
    expect(query.params.expression).toContain('".session-row"');
    expect(query.params.expression).toContain('".entry-count"');
    expect(query.params.expression).toContain('8d76da6e');
    expect(query.params.expression).not.toContain(':has-text');
    expect(client.calls('Overlay.highlightNode')).toHaveLength(1);
  });

  it('clears the outline for an empty selector', async () => {
    const client = createFakeClient();
    await start(client);

    await highlightAnnotation(CONNECTION, '');

    expect(client.calls('Overlay.hideHighlight')).toHaveLength(1);
    expect(client.calls('Overlay.highlightNode')).toHaveLength(0);
  });

  it('clears rather than leaving a stale outline when the element has gone', async () => {
    // An outline left over the wrong element reads as a match.
    const client = createFakeClient();
    client.missingNode = true;
    await start(client);

    await highlightAnnotation(CONNECTION, '.gone');

    expect(client.calls('Overlay.highlightNode')).toHaveLength(0);
    expect(client.calls('Overlay.hideHighlight')).toHaveLength(1);
  });
});

describe('the callback log', () => {
  async function startWithScript(client: any) {
    const state = await start(client);
    await client.emit('Debugger.scriptParsed', { scriptId: 'script-1', url: 'http://localhost:5173/src/App.tsx' });
    return state;
  }

  it('records each callback a step runs through', async () => {
    const client = createFakeClient();
    client.stepMs = 25;
    await startWithScript(client);

    const tick = await tickAnnotateMode(CONNECTION, { steps: 3 });

    expect(tick!.ran).toHaveLength(3);
    expect(tick!.ran[0]).toMatchObject({
      index: 1,
      kind: 'setInterval',
      fn: 'tickCounter',
      url: 'http://localhost:5173/src/App.tsx',
      line: 9,
    });
  });

  it('numbers and timestamps them in order across ticks', async () => {
    const client = createFakeClient();
    client.stepMs = 20;
    await startWithScript(client);

    await tickAnnotateMode(CONNECTION, { steps: 2 });
    const tick = await tickAnnotateMode(CONNECTION, { steps: 2 });

    expect(tick!.ran.map(e => e.index)).toEqual([3, 4]);
    expect(getAnnotateSession(CONNECTION)!.callbacks.map(e => e.at)).toEqual([20, 40, 60, 80]);
  });

  it('keeps the log bounded so a long session cannot grow without limit', async () => {
    const client = createFakeClient();
    client.stepMs = 1;
    await startWithScript(client);

    await tickAnnotateMode(CONNECTION, { steps: 250 });

    const log = getAnnotateSession(CONNECTION)!.callbacks;
    expect(log).toHaveLength(200);
    // The tail is kept: the oldest 50 are the ones dropped.
    expect(log[log.length - 1].index).toBe(250);
    expect(log[0].index).toBe(51);
  });

  it('records nothing when the page had nothing scheduled', async () => {
    const client = createFakeClient();
    await startWithScript(client);
    client.quiet = true;

    const tick = await tickAnnotateMode(CONNECTION, { budgetMs: 100 }, 10);

    expect(tick!.ran).toEqual([]);
    expect(getAnnotateSession(CONNECTION)!.callbacks).toEqual([]);
  });

  it('falls back to a bare entry when the frame names nothing', async () => {
    const client = createFakeClient();
    client.send = vi.fn(async (method: string, params?: any) => {
      client.sent.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: (client.clock += 0) } };
      if (method === 'Debugger.pause') {
        setTimeout(() => client.emit('Debugger.paused', { reason: 'debugCommand', callFrames: [] }), 0);
      }
      if (method === 'Debugger.resume') {
        client.clock += 10;
        setTimeout(() => client.emit('Debugger.paused', { reason: 'other' }), 0);
      }
      return {};
    });
    await start(client);

    const tick = await tickAnnotateMode(CONNECTION, { steps: 1 });

    expect(tick!.ran[0]).toMatchObject({ index: 1 });
    expect(tick!.ran[0].kind).toBeUndefined();
    expect(tick!.ran[0].fn).toBeUndefined();
  });
});

describe('freeze and picker as independent toggles', () => {
  it('starts running with the picker idle, which is what driving needs', async () => {
    const client = createFakeClient();
    await startBare(client);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: false, pickerArmed: false });
  });

  it('holds and arms on demand, both from the pane', async () => {
    const client = createFakeClient();
    await startBare(client);

    await setFrozen(CONNECTION, true);
    await setPicker(CONNECTION, true);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true, pickerArmed: true });
  });

  it('held + picker idle: the page stays held, so clicks reach nothing', async () => {
    const client = createFakeClient();
    await start(client);

    await setPicker(CONNECTION, false);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true, pickerArmed: false });
    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('none');
    expect(client.calls('Debugger.resume')).toHaveLength(0);
  });

  it('running + picker idle: the app can be driven, still annotating', async () => {
    const client = createFakeClient();
    await start(client);

    await setPicker(CONNECTION, false);
    const state = await setFrozen(CONNECTION, false);

    expect(state).toMatchObject({ frozen: false, pickerArmed: false });
    expect(client.calls('Debugger.resume').length).toBeGreaterThan(0);
    expect(client.calls('EventBreakpoints.disable').length).toBeGreaterThan(0);
    expect(isAnnotating(CONNECTION)).toBe(true);
  });

  it('running + picker armed: picking works without holding the page', async () => {
    const client = createFakeClient();
    await start(client);
    await setFrozen(CONNECTION, false);

    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: false, pickerArmed: true });
    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('searchForNode');

    await pick(client);
    expect(getPendingPick(CONNECTION)).toMatchObject({ selector: '#row-3 > span' });
  });

  it('re-freezing after running holds it again', async () => {
    const client = createFakeClient();
    await start(client);
    await setFrozen(CONNECTION, false);

    const state = await setFrozen(CONNECTION, true);

    expect(state).toMatchObject({ frozen: true });
    expect(client.calls('Debugger.pause')).toHaveLength(2);
  });

  it('a step holds the page first, so stepping works from running', async () => {
    const client = createFakeClient();
    client.stepMs = 30;
    await start(client);
    await setFrozen(CONNECTION, false);

    const tick = await tickAnnotateMode(CONNECTION, { steps: 2 });

    expect(tick).toMatchObject({ steps: 2 });
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ frozen: true });
  });

  it('toggling is idempotent - freezing twice does not double-pause', async () => {
    const client = createFakeClient();
    await start(client);

    await setFrozen(CONNECTION, true);

    expect(client.calls('Debugger.pause')).toHaveLength(1);
  });

  it('stops cleanly from the running state', async () => {
    const client = createFakeClient();
    await start(client);
    await setFrozen(CONNECTION, false);

    const state = await stopAnnotateMode(CONNECTION);

    expect(state).toMatchObject({ frozen: false });
    expect(client.calls('Debugger.disable')).toHaveLength(1);
    expect(isAnnotating(CONNECTION)).toBe(false);
  });
});

describe('setPicker', () => {
  it('disarms so the app can be driven normally while still frozen', async () => {
    const client = createFakeClient();
    await start(client);

    await setPicker(CONNECTION, false);

    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('none');
    expect(getAnnotateSession(CONNECTION)).toMatchObject({ pickerArmed: false });
    expect(isAnnotating(CONNECTION)).toBe(true);
  });

  it('leaves the picker disarmed across a tick', async () => {
    const client = createFakeClient();
    await start(client);
    await setPicker(CONNECTION, false);

    await tickAnnotateMode(CONNECTION, { budgetMs: 50 });

    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('none');
  });
});

describe('tickAnnotateMode', () => {
  it('steps one callback when nothing is asked for - the smallest real move', async () => {
    const client = createFakeClient();
    client.stepMs = 40;
    await start(client);

    const tick = await tickAnnotateMode(CONNECTION);

    expect(tick).toMatchObject({ requestedSteps: 1, steps: 1, actualMs: 40 });
  });

  it('steps exactly the callbacks asked for', async () => {
    const client = createFakeClient();
    client.stepMs = 40;
    await start(client);

    const tick = await tickAnnotateMode(CONNECTION, { steps: 5 });

    expect(tick).toMatchObject({ requestedSteps: 5, steps: 5, actualMs: 200 });
  });

  it('runs to the next callbacks until a millisecond target is covered', async () => {
    const client = createFakeClient();
    client.stepMs = 40;
    await start(client);

    const tick = await tickAnnotateMode(CONNECTION, { budgetMs: 100 });

    // 40ms per callback, so three of them clear a 100ms request.
    expect(tick).toMatchObject({ requestedMs: 100, actualMs: 120, steps: 3 });
    expect(tick!.requestedSteps).toBeUndefined();
  });

  it('reports where it landed rather than what was asked for', async () => {
    const client = createFakeClient();
    client.stepMs = 75;
    await start(client);

    const tick = await tickAnnotateMode(CONNECTION, { budgetMs: 100 });

    expect(tick!.actualMs).toBe(150);
    expect(tick!.requestedMs).toBe(100);
  });

  it('sets the step breakpoints once, not per tick', async () => {
    const client = createFakeClient();
    await start(client);

    await tickAnnotateMode(CONNECTION, { budgetMs: 50 });
    await tickAnnotateMode(CONNECTION, { budgetMs: 50 });

    const events = client.calls('EventBreakpoints.setInstrumentationBreakpoint')
      .map((c: SentCall) => c.params.eventName);
    expect(events).toEqual(['setTimeout.callback', 'setInterval.callback', 'requestAnimationFrame.callback']);
  });

  it('accumulates page time across ticks', async () => {
    const client = createFakeClient();
    client.stepMs = 50;
    await start(client);

    await tickAnnotateMode(CONNECTION, { budgetMs: 50 });
    const tick = await tickAnnotateMode(CONNECTION, { budgetMs: 50 });

    expect(tick!.tickMs).toBe(100);
  });

  it('reports a quiet page rather than pretending it stepped', async () => {
    const client = createFakeClient();
    await start(client);
    client.quiet = true;

    const tick = await tickAnnotateMode(CONNECTION, { budgetMs: 100 }, 10);

    expect(tick).toMatchObject({ steps: 0, actualMs: 0, quiet: true });
  });

  it('counts callbacks and page time across ticks', async () => {
    const client = createFakeClient();
    client.stepMs = 20;
    await start(client);

    await tickAnnotateMode(CONNECTION, { steps: 2 });
    const tick = await tickAnnotateMode(CONNECTION, { steps: 3 });

    expect(tick).toMatchObject({ totalSteps: 5, tickMs: 100 });
  });

  it('returns undefined when the mode is not running', async () => {
    expect(await tickAnnotateMode('nothing-here', { budgetMs: 100 })).toBeUndefined();
  });
});

describe('stopAnnotateMode', () => {
  it('restores both clocks, closes the control pane and detaches', async () => {
    const client = createFakeClient();
    const closed: string[] = [];
    const state0 = await startAnnotateMode({
      page: createFakePage(client),
      connection: CONNECTION,
      sessionName: SESSION,
      openControlTab: async () => ({ close: async () => { closed.push('tab'); } }) as any,
      sequences: noteSequences() as any,
    });
    await setPicker(CONNECTION, true);
    await setFrozen(CONNECTION, true);
    await pick(client);
    await saveAnnotation(CONNECTION, 'one');

    const state = await stopAnnotateMode(CONNECTION);

    expect(client.calls('Debugger.resume').length).toBeGreaterThan(0);
    expect(client.calls('EventBreakpoints.disable')).toHaveLength(1);
    expect(client.lastCall('Animation.setPlaybackRate').params).toEqual({ playbackRate: 1 });
    expect(client.calls('Debugger.disable')).toHaveLength(1);
    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('none');
    expect(client.detached()).toBe(true);
    expect(closed).toEqual(['tab']);
    expect(state).toMatchObject({ picks: 1, annotations: 1, controlUrl: state0.controlUrl });
    expect(isAnnotating(CONNECTION)).toBe(false);
  });

  it('stops serving the control pane', async () => {
    const client = createFakeClient();
    const { controlUrl } = await start(client);

    await stopAnnotateMode(CONNECTION);

    await expect(http(controlUrl)).rejects.toThrow();
  });

  it('returns undefined when nothing is running', async () => {
    expect(await stopAnnotateMode('nothing-here')).toBeUndefined();
  });
});

describe('the control pane', () => {
  it('serves its own state, and refuses a request without the token', async () => {
    const client = createFakeClient();
    const { controlUrl } = await start(client);
    await pick(client);

    const state = JSON.parse((await http(`${controlUrl}state`)).body);
    expect(state).toMatchObject({
      connection: CONNECTION,
      frozen: true,
      pickerArmed: false,
      tickMs: 0,
      pending: { selector: '#row-3 > span' },
    });

    const base = controlUrl.replace(/\/[a-f0-9]{32}\/$/, '');
    expect((await http(`${base}/state`)).status).toBe(404);
  });

  it('saves the comment typed into it', async () => {
    const client = createFakeClient();
    const { controlUrl } = await start(client);
    await pick(client);

    await http(`${controlUrl}save`, { method: 'POST', body: { comment: 'wrong colour' } });

    const annotations = notesIn(noteDriver);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].comment).toBe('wrong colour');
  });

  it('gives the caret to one pane when the same URL is open twice', async () => {
    // Annotating the pane itself puts a second copy in the app tab. Both poll
    // this state, and without a claim both focus their own comment box when a
    // pick lands - pulling the caret out of the one being typed into.
    const client = createFakeClient();
    const { controlUrl } = await start(client);

    const first = JSON.parse((await http(`${controlUrl}state?client=aaa`)).body);
    const second = JSON.parse((await http(`${controlUrl}state?client=bbb`)).body);
    const firstAgain = JSON.parse((await http(`${controlUrl}state?client=aaa`)).body);

    expect(first.primary).toBe(true);
    expect(second.primary).toBe(false);
    expect(firstAgain.primary).toBe(true);
  });

  it('hands the claim on once the holder stops polling', async () => {
    // A pane that was closed must not keep the caret from the one still open.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = createFakeClient();
      const { controlUrl } = await start(client);
      await http(`${controlUrl}state?client=aaa`);

      vi.advanceTimersByTime(4000);
      const next = JSON.parse((await http(`${controlUrl}state?client=bbb`)).body);

      expect(next.primary).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles the picker from the pane', async () => {
    const client = createFakeClient();
    const { controlUrl } = await start(client);

    await http(`${controlUrl}picker`, { method: 'POST', body: { armed: false } });

    expect(client.lastCall('Overlay.setInspectMode').params.mode).toBe('none');
  });
});

describe('the breakpoint guard', () => {
  it('lets annotate run while the page is paused - it owns that pause', async () => {
    const { checkBreakpointPause } = await import('./tool-response.js');
    const paused = [{
      reference: CONNECTION,
      port: 9222,
      cdpManager: { isPaused: () => true, getPausedInfo: () => ({ location: 'app.js:1', callStack: [] }) },
    }] as any;

    expect(checkBreakpointPause(paused, 'annotate', undefined, 'tick').blocked).toBe(false);
    // Still blocking for a tool that would drive a page it does not control.
    expect(checkBreakpointPause(paused, 'input', undefined, 'click').blocked).toBe(true);
  });
});

describe('verifySourceLine', () => {
  // What @vitejs/plugin-react does: prepend an HMR preamble, then report JSX
  // positions against the shifted file while the column stays correct.
  const COMPONENT = [
    'export function StatusPill({ saving }) {',
    '  // a comment',
    "  return <span className={saving ? 'a' : 'b'}>{saving}</span>;",
    '}',
  ].join('\n');

  let file: string;
  beforeEach(() => {
    file = join(dir, 'StatusPill.jsx');
    writeFileSync(file, COMPONENT);
  });

  it('leaves a line alone when it already points at the element', async () => {
    const result = await verifySourceLine({ fileName: file, lineNumber: 3, columnNumber: 10 }, 'span');

    expect(result).toEqual({ fileName: file, lineNumber: 3, columnNumber: 10 });
    expect(result.corrected).toBeUndefined();
  });

  it('corrects a line shifted by a transform, using the column and tag', async () => {
    const result = await verifySourceLine({ fileName: file, lineNumber: 22, columnNumber: 10 }, 'span');

    expect(result).toMatchObject({ lineNumber: 3, columnNumber: 10, corrected: true });
  });

  it('picks the candidate nearest the reported line when a tag repeats', async () => {
    writeFileSync(file, ['  <span a />', '', '', '', '', '', '', '  <span b />'].join('\n'));

    const near = await verifySourceLine({ fileName: file, lineNumber: 7, columnNumber: 3 }, 'span');

    expect(near.lineNumber).toBe(8);
  });

  it('leaves the position alone when nothing in the file matches', async () => {
    const result = await verifySourceLine({ fileName: file, lineNumber: 22, columnNumber: 10 }, 'div');

    expect(result).toEqual({ fileName: file, lineNumber: 22, columnNumber: 10 });
  });

  it('leaves the position alone when the file cannot be read', async () => {
    const missing = join(dir, 'nope.jsx');

    const result = await verifySourceLine({ fileName: missing, lineNumber: 9, columnNumber: 2 }, 'span');

    expect(result).toEqual({ fileName: missing, lineNumber: 9, columnNumber: 2 });
  });

  it('does nothing without a column, which is what makes the search possible', async () => {
    const result = await verifySourceLine({ fileName: file, lineNumber: 22 }, 'span');

    expect(result).toEqual({ fileName: file, lineNumber: 22 });
  });

  it('prefers the source map over disk, so a bundled app is covered too', async () => {
    // Nothing on disk under this name; the map is the only thing that knows it.
    const bundled = join(dir, 'never-written.jsx');
    const readOriginal = async () => COMPONENT;

    const result = await verifySourceLine(
      { fileName: bundled, lineNumber: 22, columnNumber: 10 }, 'span', readOriginal);

    expect(result).toMatchObject({ lineNumber: 3, corrected: true });
  });

  it('falls back to disk when no map carries the file', async () => {
    const readOriginal = async () => null;

    const result = await verifySourceLine(
      { fileName: file, lineNumber: 22, columnNumber: 10 }, 'span', readOriginal);

    expect(result).toMatchObject({ lineNumber: 3, corrected: true });
  });

  it('falls back to disk when the map lookup throws', async () => {
    const readOriginal = async () => { throw new Error('map is broken'); };

    const result = await verifySourceLine(
      { fileName: file, lineNumber: 22, columnNumber: 10 }, 'span', readOriginal);

    expect(result).toMatchObject({ lineNumber: 3, corrected: true });
  });
});

