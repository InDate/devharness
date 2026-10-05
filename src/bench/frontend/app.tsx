/** @jsxImportSource preact */
import { Fragment, render } from 'preact';
import type preact from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Traffic, Scope } from './boundary.js';
import { toggleVariables, useVariablesHidden } from './variables-shown.js';
import { History } from './history.js';
import { Tools, type ToolSeed } from './tools.js';
import { Issues } from './issues.js';
import { Running } from './running.js';
import { EnableProxy } from './enable-proxy.js';
import { ConnectionPicker } from './connection-picker.js';
import { DISC_TONES, discFill, discSaid } from './disc.js';
import { About } from './sequence.js';
import { Editing } from './editing.js';
import { Glyph } from './glyph.js';
import { ToolGlyph } from './tool-glyph.js';
import { onRevealResponse, setShowHidden, useShowHidden } from './focus.js';
import { CaptureDialog } from './capture.js';
import { HoldPanel } from './hold-panel.js';
import { goToSection } from './goto.js';
import { SavedHidden, SavedPayloads, SavedResponses, choicesIn, rearmRule } from './crossing.js';
import type { BenchView, BoundaryEvent, BoundaryState, DiscMode } from '../wire.js';
import './bench.css';
import { useEscape } from './escape.js';

/**
 * The bench: the panel beside a driven app.
 *
 * The server writes its own prefix onto the mount point. Deriving it from
 * `location.pathname` instead would fold whatever route served the page into
 * the base, and every call would go one level too deep.
 */
const root = document.getElementById('bench');
const BASE = root?.dataset.base ?? '';

const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** One arrival in a few words: `GET /draft 200`, `← /live frame`. */
function arrivalOf(event: BoundaryEvent): string {
  if (event.kind === 'write') return `${event.method} ${event.preview ?? ''}`.slice(0, 80);
  let path = event.url;
  try { path = new URL(event.url).pathname; } catch { /* not a URL */ }
  return event.kind === 'request'
    ? `${event.method ?? 'GET'} ${path} ${event.status ?? '…'}`
    : `${event.direction === 'out' ? '→' : '←'} ${path} frame`;
}

/** How long ago, coarsely: a count of seconds that ticks is noise. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 2 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/** A request answered with an error or never answered at all, as the server counts one. */
function isFailure(event: BoundaryEvent): boolean {
  return event.kind === 'request' && event.status !== undefined && (event.status >= 400 || event.status === 0);
}

/**
 * Which sequence is open and whether the page runs, under every tab.
 *
 * Both are properties of the session rather than of a tab: a held page has its
 * JS stopped, so a click on the app reaches nothing and a step driven into it
 * lands nowhere, and every tab reads the open sequence. Held inside one tab,
 * the state is unreadable from the others, and a page held from there reads as
 * an app that has broken.
 *
 * Fixed at the foot of the page rather than in the header: it is reached while
 * reading whatever is on screen, and the foot is the one edge no tab's own
 * content occupies.
 *
 * Polled on the tabs' own clock. It carries the run's position and what that
 * run is crossing, both of which move several times a second while a sequence
 * plays - a nine-step run finishes inside two seconds, so a slower clock
 * reports a run that looks like it never started.
 */
function Footing({ base, onNew, onShot, onSequence, onVariables, onGo }: {
  base: string;
  /** Go to where a held layer, or the sequence, is read in full. */
  onGo: (layer: 'code' | 'ui' | 'network' | 'sequence' | 'sequences') => void;
  /** Show the Sequence tab, whose head the variables button toggles. */
  onVariables: () => void;
  onNew: () => void;
  /** The sequence open on the session, and whether a run is going in it; a recording reports nothing. */
  onSequence: (name: string | null, busy: boolean) => void;
  /** A capture lands on the screen that holds the reel, so it opens there. */
  onShot: () => void;
}) {
  const [state, setState] = useState<BenchView | null>(null);
  const [gone, setGone] = useState(false);
  const variablesHidden = useVariablesHidden();
  // The header's place for the state disc, found once both are on the page.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('statedisc-slot')); }, []);
  /** What this button has asked for and not yet seen confirmed. */
  const [asked, setAsked] = useState<boolean | null>(null);
  const [shooting, setShooting] = useState(false);
  /** Which reading is open over whatever tab is showing. */
  const [showing, setShowing] = useState<'about' | 'proxy' | 'hold' | null>(null);
  // A response a traffic row asked to see: the panel opens on it.
  const [revealed, setRevealed] = useState<string | null>(null);
  const showHidden = useShowHidden();
  useEffect(() => onRevealResponse((key) => { setRevealed(key); setShowing('proxy'); }), []);
  useEscape(showing !== null, () => setShowing(null));
  const [boundary, setBoundary] = useState<BoundaryState | null>(null);
  /** What the session answered when asked to relaunch through a proxy. */
  const [proxyAsked, setProxyAsked] = useState('');
  // A first click on Baseline, where one stands, arms it; the second replaces it.
  const [rebaselining, setRebaselining] = useState(false);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${base}/state?client=${CLIENT_ID}-hold`);
        if (!res.ok) throw new Error(String(res.status));
        if (live) { setState(await res.json()); setGone(false); }
      } catch {
        if (live) setGone(true);
      }
    };
    void poll();
    const timer = setInterval(poll, 300);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  /**
   * What the boundary holds, read only while a run is going.
   *
   * The counts change as each step crosses, and watching them is how a run
   * that is producing nothing is told from one that is working. Polled here
   * rather than always: with no run going nothing moves, and a second request
   * a second would be for a number that does not change.
   */
  const running = state?.sequence?.busy === true;
  const recording = state?.sequence?.recording === true;
  /**
   * Whether anything is carried between steps.
   *
   * A value the run already holds, or a step that captures one and has not
   * run yet, or a step whose call reads one - any of the three and the run
   * has variables in it.
   */
  const carrying = (state?.sequence?.variables?.length ?? 0) > 0
    || (state?.sequence?.steps ?? []).some(step =>
      step.captures !== undefined || step.label.includes('{{var:'));
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/proxy/events?since=`).catch(() => null);
      if (live && res?.ok) setBoundary(await res.json());
    };
    void poll();
    // Fast while a run or a recording is producing crossings, which the proxy
    // button lights for as they land; slower otherwise, when what arrives is
    // the app's own traffic.
    const timer = setInterval(poll, running || recording ? 400 : 800);
    return () => { live = false; clearInterval(timer); };
  }, [base, running, recording]);

  /**
   * What the proxy button is lit for: the newest arrivals since the last poll,
   * by the worst of them - a failure, then something a step caused, then the
   * app's own. It fades back after a moment, so a steady colour means quiet.
   */
  const [lit, setLit] = useState<'failed' | 'caused' | 'own' | null>(null);
  /** The newest arrival, kept after the light fades, so the panel can say what lit it. */
  const [latest, setLatest] = useState<{ tone: 'failed' | 'caused' | 'own'; said: string; at: number } | null>(null);
  const lastSeen = useRef<string | undefined>(undefined);
  useEffect(() => {
    const events = boundary?.events ?? [];
    const newest = events[events.length - 1];
    if (!newest || newest.id === lastSeen.current) return;
    const first = lastSeen.current === undefined;
    const from = events.findIndex(event => event.id === lastSeen.current) + 1;
    lastSeen.current = newest.id;
    // The first read is what was there already, not something arriving.
    if (first) return;
    const fresh = events.slice(from);
    const tone = fresh.some(isFailure) ? 'failed' : fresh.some(event => event.owned) ? 'caused' : 'own';
    setLit(tone);
    const shown = fresh.find(isFailure) ?? fresh.find(event => event.owned) ?? newest;
    setLatest({ tone, said: arrivalOf(shown), at: shown.at });
    const timer = setTimeout(() => setLit(null), 1500);
    return () => clearTimeout(timer);
  }, [boundary]);

  const openName = state?.sequence?.name ?? null;
  const reporting = state !== null && state.sequence?.recording !== true;
  const busyNow = state?.sequence?.busy === true;
  useEffect(() => {
    if (reporting) onSequence(openName, busyNow);
  }, [reporting, openName, busyNow]);

  if (gone) {
    return <div class="footing">
      <div class="footbar">
        <span class="held closed" title="the bench has been closed on this connection">closed</span>
      </div>
    </div>;
  }
  if (!state) return <div class="footing"><div class="footbar"><span class="held waiting">…</span></div></div>;

  // What the poll last reported, unless this button has just asked for the
  // other thing. Holding takes a moment and the poll is a second apart, so
  // reading only the poll leaves the button ignoring its own click.
  const frozen = asked ?? state.frozen;
  const sequence = state.sequence;
  const trafficHeld = state.held.some(layer => layer.layer === 'network');
  const waiting = state.queued.length;
  // What the proxy panel counts: everything it holds, or while a recording
  // runs only what crossed after it began - the rest belongs to no step of it.
  const since = sequence?.recording ? sequence.recordingSince : undefined;
  const counted = (boundary?.events ?? []).filter(event => since === undefined || event.at >= since);
  const notesTaken = (sequence?.steps ?? []).reduce((n, step) => n + (step.annotations?.length ?? 0), 0);
  const writtenCount = counted.filter(event => event.kind === 'write').length;
  const crossedCount = counted.length - writtenCount;
  const counts = {
    caused: counted.filter(event => event.owned).length,
    own: counted.filter(event => !event.owned).length,
    failed: counted.filter(isFailure).length,
    // Answered, dropped or refused by the proxy rather than by the server.
    intercepted: counted.filter(event => event.answeredAs !== undefined).length,
    sockets: boundary?.totals?.sockets.open ?? 0,
    sinceRecording: since !== undefined,
  };
  const post = async (path: string, body?: Record<string, unknown>) => {
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).catch(() => { /* the bench outlives a restart */ });
  };

  /**
   * What stops a control acting, named so the tooltip carries the thing to
   * clear rather than the control reading as broken.
   *
   * Conditions in the order they are cleared: a sequence is opened, the run it
   * drives finishes, the page it drives is let go. A control that clears one
   * itself does not ask for it - RESTART and REPLAY release the hold before
   * they drive, so neither names it.
   */
  const barred = (needs: { open?: boolean; idle?: boolean; running?: boolean }) => {
    if (needs.open && !sequence?.name) return 'pick a sequence first';
    if (needs.idle && sequence?.busy) return 'the run is going - stop it first';
    if (needs.running && frozen && !sequence?.paused) {
      return 'the page is held - let it run first';
    }
    return null;
  };
  // Marked rather than disabled. A disabled button takes no mouse events, so
  // Chrome shows no tooltip on it - the reason it cannot act would be readable
  // only while it could. Marked, it stays hoverable and the click is dropped.
  const held = (stop: string | null) => ({
    'aria-disabled': stop ? true : undefined,
    title: stop ?? undefined,
  });
  // What the session is doing, as colours for the disc and the frame, every
  // one that holds, in this order: recording, a held page, a run, a pause.
  // The first is the outer line and the disc's first slice; each after it is
  // a line just inside the one before and the next slice.
  const modes: DiscMode[] = ([
    ['recording', state.sequence?.recording === true],
    // The page held - its screen or its code - and the traffic held, each in
    // its own colour: held traffic leaves the page running, so the two are
    // different conditions and the frame says which stands.
    ['frozen', frozen === true || state.held.some(layer => layer.layer !== 'network')],
    ['traffic', trafficHeld],
    // Any run the bench is making counts, not only one started by play: a
    // run to a step drives the page the same way.
    ['playing', state.sequence?.playing === true || (state.sequence?.busy === true && !state.sequence?.recording)],
    ['paused', state.sequence?.paused === true],
  ] as const).filter(([, on]) => on).map(([mode]) => mode);
  // A held layer something is waiting on pulses: the traffic while messages
  // wait at the proxy, the page while its code hold is armed for the next JS.
  const codeArmed = state.held.some(layer => layer.layer === 'code' && layer.standing?.armed === true);
  const waitingOn = new Set<string>([
    ...(trafficHeld && waiting > 0 ? ['traffic'] : []),
    ...(codeArmed ? ['frozen'] : []),
  ]);
  // The first layer something waits on, in the frames' order, takes the
  // whole disc on each pulse.
  const attention = modes.find(mode => waitingOn.has(mode));
  const tone = DISC_TONES;
  const said = discSaid(modes);
  const disc = discFill(modes);

  return (
    <>
      {/* The whole screen framed in each state's colour, and the disc naming them. */}
      {modes.map((mode, k) => (
        <div key={mode} class={`stateframe ${mode}${waitingOn.has(mode) ? ' waiting' : ''}`} aria-hidden="true"
          style={{
            inset: `${4 + k * 5}px`, top: `calc(var(--holdbar, 0px) + ${4 + k * 5}px)`,
            borderRadius: `${14 - k * 4}px`, borderColor: tone[mode],
          }} />
      ))}
      {showing === 'hold' && createPortal(
        <HoldPanel state={state} post={post} onClose={() => setShowing(null)} onGo={onGo} />,
        document.body,
      )}
      {slot && createPortal(
        <button class={`statedisc${modes.length ? ' on' : ''}${attention ? ' attention' : ''}`}
          title={`${said} - open the hold`} aria-label={said}
          style={{ ...(disc ? { background: disc } : {}), ...(attention ? { '--attention': tone[attention] } : {}) }}
          onClick={() => setShowing(showing === 'hold' ? null : 'hold')} />,
        slot,
      )}
      {state.shotArmed && (
        <CaptureDialog heldBefore={state.shotArmed.heldBefore} facts={state.factChoice} post={post}
          note={state.shotArmed.annotationId
            ? (state.sequence?.steps ?? []).flatMap(step => step.annotations ?? [])
              .find(note => note.id === state.shotArmed!.annotationId)?.comment ?? ''
            : undefined} />
      )}
    <div class="footing">
      {/* The run bar exists only while a sequence does: every control on it
          drives that run, and the bar above carries the selector that opens
          one. Stacked with the standing bar at the bottom, so this one
          appearing does not move the controls that are always there. */}
      {/* A recording is not a run: it has no position to step from and
          nothing to replay yet, so its bar carries the recording's own
          controls rather than the run's, which could not act on it. */}
      {sequence?.recording && (
        <div class="footbar recbar">
          {/* The name is on the sequence picker below, so this line counts:
              the steps taken, what crossed since it began, what was noted. */}
          <span class="recdot" title="recording" />
          <span class="at">
            {/* Only what has happened: a count of nothing is left off, so a
                recording that has just begun shows the disc alone. The colours
                are the ones these rows carry in the step list. */}
            {([
              [sequence.total, sequence.total === 1 ? 'step' : 'steps', ''],
              [crossedCount, 'boundary', 'n-boundary'],
              [writtenCount, writtenCount === 1 ? 'activity' : 'activities', 'n-local'],
              [notesTaken, notesTaken === 1 ? 'note' : 'notes', 'n-note'],
            ] as const).filter(([count]) => count > 0).map(([count, word, tone], k) => (
              <Fragment key={word}>
                {k > 0 && ' · '}
                <b class={tone || undefined}>{count}</b> {word}
              </Fragment>
            ))}
          </span>
          <span class="grow" />
          <button class="chip-toggle bin" title="throw this recording away" aria-label="throw it away"
            onClick={() => void post('/sequence/record/cancel')}><Glyph of="clear" /></button>
          <button class="chip-toggle keep" title="save this recording" aria-label="save"
            onClick={() => void post('/sequence/record/stop')}><Glyph of="save" /></button>
        </div>
      )}
      {sequence?.name && !sequence.recording && (
        <div class="footbar">
          {/* A run stopped by hand, a run whose last step failed and a run that
              reached its end all sit still with nothing in flight, so the line
              names which: a run ending leaves no other mark on the bar. */}
          {(() => {
            // A browser dialog stops the run where it stands, so the line
            // names the wait ahead of any other state; the box above the
            // steps says on what, and holds what answers it.
            const dialog = sequence.dialog;
            if (dialog) {
              return (
                <span class="at waitdialog" title={dialog.why ?? dialog.text}>
                  waiting · step <b>{Math.min(sequence.currentStep + 1, sequence.total)}</b> of {sequence.total}
                </span>
              );
            }
            const still = !sequence.playing && !sequence.busy;
            const failed = still && !!sequence.failure;
            const finished = still && !failed && !sequence.paused
              && sequence.total > 0 && sequence.currentStep >= sequence.total;
            if (finished) {
              return (
                <span class="at runend" title="the run reached the end of the sequence">
                  <Glyph of="tick" /> finished · {sequence.total === 1 ? <><b>1</b> step</> : <>all <b>{sequence.total}</b> steps</>}
                </span>
              );
            }
            return (
              <span class={sequence.playing ? 'at running' : sequence.paused ? 'at paused' : failed ? 'at runfail' : 'at'}
                title={failed ? sequence.failure : sequence.heldAt ? `breakpoint at ${sequence.heldAt}` : undefined}>
                {sequence.playing ? 'running · '
                  : sequence.paused && sequence.heldAt ? 'paused at breakpoint · '
                  : sequence.paused ? (frozen ? 'paused · held · ' : 'paused · ')
                  : failed ? 'failed · '
                  : ''}
                step <b>{Math.min(sequence.currentStep + 1, sequence.total)}</b> of {sequence.total}
              </span>
            );
          })()}
          {/* What this step crossed, not what the run has: a running total
              only climbs, so it states that the run is doing something, while
              the step's own count separates a step that made a call from one
              that made none. Beside the position, because it is a reading of
              that position. */}
          {boundary && (() => {
            // `currentStep` is the step about to run, so the crossings on
            // screen are the ones the step before it produced - the step in
            // flight during a run, and the last one taken while stopped.
            const ran = sequence.currentStep - 1;
            const here = boundary.events.filter(event => event.step === ran);
            // Answered from a rule rather than by the server: the payload came
            // from the sequence, so it is the second thing worth a number.
            const answered = here.filter(event => event.answeredAs !== undefined).length;
            // Nothing crossed, so nothing is stated. A nought is a reading to
            // interpret, and its absence says the same thing without one.
            if (here.length === 0) return null;
            return (
              <>
                <span class="rule" />
                <span class="crossings"
                  title={`${here.length} crossed the boundary under this step`}
                >{here.length}</span>
                {answered > 0 && <span class="rule" />}
                {answered > 0 && (
                  <span class="answered"
                    title={`${answered} answered from a rule, never reaching the server`}
                  >{answered}</span>
                )}
              </>
            );
          })()}
          <span class="rule" />
          {/* Released without asking whether it is frozen: a frozen page
              cannot be driven, and the poll's copy of that flag can be a
              moment old. */}
          <button class="chip-toggle" {...held(barred({ idle: true }))}
            title={barred({ idle: true }) ?? 'back to the first step, without running'}
            aria-label="RESTART"
            onClick={async () => {
              if (barred({ idle: true })) return;
              await post('/hold/page', { held: false });
              await post('/sequence/goto', { step: 0 });
            }}><Glyph of="restart" /></button>
          <button class="chip-toggle" {...held(barred({ idle: true }))}
            title={barred({ idle: true }) ?? 'back to the first step and straight through'}
            aria-label="REPLAY"
            onClick={async () => {
              if (barred({ idle: true })) return;
              await post('/hold/page', { held: false });
              await post('/sequence/goto', { step: 0 });
              await post('/sequence/play');
            }}><Glyph of="replay" /></button>
          <button class="chip-toggle" {...held(barred({ idle: true, running: true }))}
            title={barred({ idle: true, running: true }) ?? 'run the next step'}
            aria-label="STEP"
            onClick={async () => {
              if (barred({ idle: true, running: true })) return;
              if (sequence.paused) await post('/hold/page', { held: false });
              await post('/sequence/step');
            }}
          ><Glyph of="step" /></button>
          <button
            class={sequence.paused ? 'chip-toggle waiting' : 'chip-toggle'}
            {...held(barred({ idle: true }))}
            title={barred({ idle: true })
              ?? (sequence.paused
                ? `carry on from step ${Math.min(sequence.currentStep + 1, sequence.total)}`
                : 'run from here')}
            aria-label="PLAY"
            onClick={async () => {
              if (barred({ idle: true })) return;
              // Play lets go of any hold itself before it drives the page.
              await post('/sequence/play');
            }}
          ><Glyph of="play" /></button>
          {sequence.playing && (
            /* Holds the run where it stands rather than closing it: the step
               reached is what someone stopped to look at, and PLAY carries on
               from there. Shown for a play alone - a single step finishes
               before a control for stopping it could be pressed, and a bar
               that grows one while it runs changes shape twice for nothing. */
            <button class="chip-toggle" title="stop on the step it has reached"
              aria-label="PAUSE"
              onClick={() => void post('/sequence/halt')}
            ><Glyph of="held" /></button>
          )}
          <span class="rule" />
          {/* What the sequence is for and what it has crossed: read while
              deciding what to do next, not while doing it, so it opens over
              the screen rather than occupying a strip of every one. */}
          <button class="chip-toggle" title="what this sequence is for, and what it crossed"
            aria-label="ABOUT"
            onClick={async () => {
              setShowing('about');
              const res = await fetch(`${base}/proxy/events?since=`).catch(() => null);
              if (res?.ok) setBoundary(await res.json());
            }}><Glyph of="info" /></button>
          {/* The hub fills once the run carries a value or a step captures
              one, so the bar states whether there is anything in there before
              it is opened. Two shapes rather than two colours: at this size a
              change of hue is the hardest thing on the bar to notice. */}
          <button
            title={variablesHidden
              ? 'list the variables at the top of the steps'
              : 'hide the variables at the top of the steps'}
            aria-label="VARIABLES"
            class={variablesHidden ? 'chip-toggle' : 'chip-toggle chosen'}
            onClick={() => { onVariables(); toggleVariables(); }}
          ><Glyph of={carrying ? 'cogset' : 'cog'} /></button>
          {/* A play that keeps its traffic, in a section of its own: it
              replaces what later plays are compared against. */}
          <span class="rule" />
          {(() => {
            // The baseline standing is the newest recorded traffic on any
            // step; its time is what the button's words carry.
            const at = Math.max(0, ...(sequence.steps ?? []).map(step => step.traffic?.recordedAt ?? 0));
            const stop = barred({ idle: true })
              ?? (boundary && !boundary.running ? 'a baseline keeps what crosses the proxy, and this browser was not launched through one' : null);
            const when = at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
            return (
              <button class={rebaselining ? 'chip-toggle sure' : 'chip-toggle'} {...held(stop)}
                title={stop ?? (rebaselining
                  ? 'click again to replace the baseline with a fresh play from the first step'
                  : when
                    ? `baseline from ${when} - play from the first step and keep its traffic in its place`
                    : 'play from the first step and keep its traffic as the baseline later plays are compared against')}
                aria-label="BASELINE"
                onMouseLeave={() => setRebaselining(false)}
                onClick={async () => {
                  if (stop) return;
                  if (when && !rebaselining) { setRebaselining(true); return; }
                  setRebaselining(false);
                  await post('/hold/page', { held: false });
                  await post('/sequence/baseline');
                }}><Glyph of="baseline" /></button>
            );
          })()}
        </div>
      )}

      <div class="footbar">
        {/* A recording has no file until it stops, so its name is in no list
            of saved sequences; it is stated here, and the selector waits. */}
        {sequence?.recording
          ? (
            <select class="seqpick" disabled title="stop or throw away the recording to open another sequence">
              <option>{sequence.into
                ? `${sequence.into.name} · adding after step ${sequence.into.after + 1}`
                : `${sequence.name} · recording`}</option>
            </select>
          )
          : (
            <select
              class={sequence?.name ? 'seqpick loaded' : 'seqpick'}
              value={sequence?.name ?? ''}
              onChange={(e: Event) => void post('/sequence/select', {
                name: (e.target as HTMLSelectElement).value,
              })}
            >
              <option value="">pick a sequence</option>
              {(sequence?.available ?? []).map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
        {/* Recording writes a sequence that does not exist yet, so this asks
            for one rather than opening anything the selector lists. */}
        <button class="chip-toggle" title="record a new sequence" aria-label="NEW"
          onClick={onNew}><Glyph of="new" /></button>
        <span class="rule" />
        <button class={state.pickerArmed ? 'chip-toggle on' : 'chip-toggle'}
          {...held(barred({ open: true }))}
          title={barred({ open: true }) ?? 'turn the next click in the app into a pick'}
          aria-label="PICKER"
          onClick={() => { if (!barred({ open: true })) void post('/picker', { armed: !state.pickerArmed }); }}
        ><Glyph of="picker" /></button>
        <button class="chip-toggle" {...held(shooting ? 'capturing…' : barred({ open: true }))}
          title={shooting ? 'capturing…'
            : barred({ open: true }) ?? 'hold the page and choose what to capture'}
          aria-label="CAPTURE"
          onClick={async () => {
            if (shooting || barred({ open: true })) return;
            // Opened before the shot rather than after: the draft lands at the
            // head of that reel, and switching only once it arrives skips past
            // the moment it was taken.
            onShot();
            setShooting(true);
            await post('/shot/begin');
            setShooting(false);
          }}><Glyph of="capture" /></button>
        <span class="rule" />
        {/* A browser is launched through a proxy or it is not, and a running
            one cannot gain one - so this states which, and asking is the only
            thing it can do about it. */}
        {boundary && (
          <button
            /* Three states, not two. A held page starts no traffic of its own,
               though what the server pushes still crosses, so reading the green
               one as "the app is working" is how a frozen page gets mistaken
               for an app that has gone quiet on its own. */
            class={!boundary.running ? 'chip-toggle blind'
              : frozen ? 'chip-toggle stilled'
              : lit ? `chip-toggle recording lit-${lit}` : 'chip-toggle recording'}
            title={!boundary.running
              ? 'nothing records what crosses the boundary - open its controls'
              : trafficHeld
                ? `recording: traffic is held at the proxy, ${waiting} waiting to reach the page`
              : frozen
                ? 'recording: the held page starts nothing, and what the server sends still arrives here'
                : `${counts.caused} caused by steps · ${counts.own} the app's own`
                  + `${counts.failed ? ` · ${counts.failed} failed` : ''}`
                  + `${counts.sinceRecording ? ' since recording began' : ''} - open for the rest`}
            aria-label={!boundary.running ? 'NOT RECORDING'
              : frozen ? 'RECORDING WHILE HELD' : 'RECORDING'}
            onClick={() => setShowing('proxy')}
          >
            <Glyph of="proxy" />
            {/* The rules in force, since they change what the app is answered with. */}
            {/* The responses answering in what is open now: a site response this
                sequence does not use changes nothing it sees. */}
            {(boundary.rules ?? []).filter(rule => rule.verb !== 'hide' && !rule.off).length > 0 && (
              <span class="badge">{(boundary.rules ?? []).filter(rule => rule.verb !== 'hide' && !rule.off).length}</span>
            )}
          </button>
        )}
        <button
          class={frozen ? 'chip-toggle frozen' : 'chip-toggle'}
          title={frozen
            ? `held at ${state.tickMs}ms: its code and screen are stopped${trafficHeld ? ', and traffic waits at the proxy' : ''}, so it cannot be driven. Click to let it all run.`
            : `the page is running and can be driven. Click to hold its code, screen${boundary?.running ? ' and traffic' : ''}.`}
          aria-label={frozen ? 'HELD' : 'HOLD'}
          onClick={async () => {
            setAsked(!frozen);
            // Letting the page run carries on a run the hold paused.
            await post('/hold/page', { held: !frozen, resume: frozen });
            // Back to whatever the page reports: the request may have been
            // refused, and a button that keeps its own answer would report a
            // hold that is not there.
            setAsked(null);
          }}
        ><Glyph of="hold" /></button>
        <button class={showHidden ? 'chip-toggle showhidden on' : 'chip-toggle showhidden'}
          title={showHidden ? 'leave ignored traffic out of the list again' : 'show the ignored traffic, dimmed'}
          aria-label={showHidden ? 'HIDE IGNORED' : 'SHOW IGNORED'} aria-pressed={showHidden}
          onClick={() => setShowHidden(!showHidden)}
        ><Glyph of={showHidden ? 'eye' : 'eyeoff'} /></button>
      </div>
    </div>

    {/* Outside the bar, not within it: `.footing` is transformed, and a
        transform makes its element the containing block for anything fixed
        inside it - the scrim would cover the bar rather than the screen. */}
    {(showing === 'proxy' || (showing === 'about' && sequence?.name)) && (
        <div class="scrim" onClick={() => setShowing(null)}>
          <div class="report" onClick={(e: MouseEvent) => e.stopPropagation()}>
            {showing === 'proxy'
              ? (() => {
                  // The state the button shows, in its colour, so opening the
                  // panel answers what the colour meant.
                  const tone = !boundary?.running ? 'blind' : frozen ? 'stilled' : 'recording';
                  return (
                    <div class={`panelstatus ${tone}`}>
                      <div class="panelstatushead">
                        <span class="statusdot" />
                        <span class="statustitle">
                          {tone === 'blind' ? 'Not recording'
                            : tone === 'stilled' ? (trafficHeld ? 'Recording, traffic held' : 'Recording, page held')
                            : 'Recording traffic'}
                        </span>
                        <span class="grow" />
                        <button class="close" title="close" onClick={() => setShowing(null)}>×</button>
                      </div>
                      <p class="statussub">
                        {tone === 'blind' ? 'This browser was launched without a proxy, so nothing records what crosses.'
                          : tone === 'stilled' && trafficHeld ? `The page is held and what the server sends waits at the proxy: ${waiting} waiting. It crosses in order on release, or one message at a time from the held panel, and is recorded as it crosses.`
                          : tone === 'stilled' ? 'The page is held, so it starts nothing. What the server sends still crosses and is recorded; the page handles it once released.'
                          : counts.sinceRecording ? `Counted since "${sequence?.name}" began recording.`
                          : 'Counted since the proxy started.'}
                      </p>
                      {tone !== 'blind' && (
                        <p class="statuscounts">
                          <span class="caused"><b>{counts.caused}</b> caused by steps</span>
                          <span class="own"><b>{counts.own}</b> the app's own</span>
                          <span class="intercepted"><b>{counts.intercepted}</b> intercepted</span>
                          {counts.failed > 0 && <span class="failed"><b>{counts.failed}</b> failed</span>}
                          <span class="quiet"><b>{counts.sockets}</b> socket{counts.sockets === 1 ? '' : 's'} open</span>
                        </p>
                      )}
                      {tone !== 'blind' && latest && (
                        <p class="statuslatest">
                          <span class={`latestdot ${latest.tone}`} />
                          <span class="quiet">latest</span>
                          <span class="latestwhat">{latest.said}</span>
                          <span class="quiet">{ago(latest.at)}</span>
                        </p>
                      )}
                    </div>
                  );
                })()
              : (
                <div class="reporthead">
                  <span class="what">{sequence?.name}</span>
                  <button class="close" title="close" onClick={() => setShowing(null)}>×</button>
                </div>
              )}
            {showing === 'proxy' && boundary?.running && (
                <SavedResponses
                  base={base}
                  reveal={revealed}
                  rules={boundary.rules ?? []}
                  choices={choicesIn(boundary.events ?? [], boundary.steps, boundary.forSequence)}
                  replaying={sequence?.busy === true && !sequence?.recording}
                  names={boundary.names}
                  onSet={(rule, next) => void rearmRule(post, rule, next)}
                  onClear={(key) => void post('/boundary/rule/clear', { key })}
                  site={boundary.site}
                  sequence={sequence?.name}
                  onUse={(key, use) => void post('/boundary/rule/use', { key, use })}
                  onMode={(key, mode) => void post('/boundary/rule/mode', { key, mode })}
                />
            )}
            {showing === 'proxy' && boundary?.running && (
              <SavedHidden
                base={base}
                hidden={boundary.hidden ?? []}
                site={boundary.site}
                sequence={sequence?.name}
                onUse={(key, on) => void post('/boundary/hidden/use', { key, on })}
                onMode={(key, mode) => void post('/boundary/hidden/mode', { key, mode })}
                onClear={(key) => void post('/boundary/hidden/clear', { key })}
              />
            )}
            {showing === 'proxy' && <SavedPayloads base={base} />}
            {showing === 'proxy' && (boundary?.running
              ? <Scope
                  allowed={boundary.allowed}
                  refusals={boundary.refusals ?? []}
                  refusesWrites={boundary.refusesWrites ?? false}
                  refusedWrites={boundary.refusedWrites ?? 0}
                  said={proxyAsked}
                  held={boundary.events.length}
                  counts={counts}
                  onRefuse={async (on) => {
                    const res = await fetch(`${base}/boundary/refuse`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ on }),
                    });
                    setProxyAsked(await res.text());
                  }}
                  onClear={async () => {
                    const res = await fetch(`${base}/proxy/clear`, { method: 'POST' });
                    setProxyAsked(await res.text());
                  }}
                  onOpen={async () => {
                    const res = await fetch(`${base}/proxy/allow`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ hosts: [] }),
                    });
                    setProxyAsked(await res.text());
                  }}
                  onAllow={async (hosts) => {
                    const res = await fetch(`${base}/proxy/allow`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ hosts }),
                    });
                    setProxyAsked(await res.text());
                  }}
                />
              : <EnableProxy base={base}>
                  <span class="grow">Nothing records what crosses this page's boundary until it runs through a proxy.</span>
                </EnableProxy>)}
            {showing === 'about' && sequence && <About sequence={sequence} post={post} />}
            {showing === 'about' && sequence && boundary?.totals && (
              <dl class="facts">
                <div><dt>crossed under a step</dt>
                  <dd>{boundary.totals.owned} of {boundary.totals.events}</dd></div>
                <div><dt>failed</dt><dd>{boundary.totals.failed}</dd></div>
                <div><dt>sockets open</dt><dd>{boundary.totals.sockets.open}</dd></div>
                <div><dt>answered by a rule</dt><dd>{boundary.rules.length}</dd></div>
                <div><dt>steps</dt><dd>{sequence?.total ?? 0}</dd></div>
              </dl>
            )}
          </div>
        </div>
      )}
    </>
  );
}

type Tab = 'editing' | 'traffic' | 'history' | 'tools' | 'running' | 'issues';

/** The tab's word in the address, and back. A word no tab has opens Sequence; `servers`, the Running tab's earlier word, opens Running. */
const TAB_WORDS: Record<Tab, string> = { editing: 'sequence', traffic: 'traffic', history: 'history', tools: 'tools', running: 'running', issues: 'issues' };

/**
 * Where the bench stands, as the address holds it: the tab, the open
 * sequence, and within a tab the issue open on Issues and the tool and action
 * chosen on Tools. Each move pushes an entry, so the browser's back and
 * forward return to the list after a sequence or an issue is opened, to the
 * tool chosen before, and to the tab before.
 */
interface Place {
  tab: Tab;
  sequence: string | null;
  issue: number | null;
  tool: string | null;
  action: string | null;
}

/** A tab's own place, cleared: a tab opened from its button opens on its list. */
const TAB_START = { issue: null, tool: null, action: null } as const;

function placeOf(): Place {
  const query = new URLSearchParams(location.search);
  const word = query.get('tab');
  const tab = word === 'servers' ? 'running' : (Object.keys(TAB_WORDS) as Tab[]).find(key => TAB_WORDS[key] === word) ?? 'editing';
  const issue = Number(query.get('issue'));
  return {
    tab,
    sequence: query.get('sequence') || null,
    issue: tab === 'issues' && Number.isInteger(issue) && issue > 0 ? issue : null,
    tool: tab === 'tools' ? query.get('tool') || null : null,
    action: tab === 'tools' ? query.get('action') || null : null,
  };
}

function addressOf(place: Place): string {
  const query = new URLSearchParams();
  if (place.tab !== 'editing') query.set('tab', TAB_WORDS[place.tab]);
  if (place.sequence) query.set('sequence', place.sequence);
  if (place.issue !== null) query.set('issue', String(place.issue));
  if (place.tool) query.set('tool', place.tool);
  if (place.action) query.set('action', place.action);
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ''}`;
}

function samePlace(a: Place, b: Place): boolean {
  return a.tab === b.tab && a.sequence === b.sequence && a.issue === b.issue
    && a.tool === b.tool && a.action === b.action;
}

/** A count as the badge prints it: four digits and more print as 999+, so the badge holds its width. */
function badgeOf(count: number): string {
  return count > 999 ? '999+' : String(count);
}

/**
 * One tab: its mark, a count badged on the mark's corner, and its word, which
 * the narrow layout drops. The name and the count's detail sit in the title and
 * the aria-label, so the button reads and announces the same at every width.
 * A count of 0 draws no badge. A count above the last one this tab drew pulses
 * the badge once: each rise remounts it under a new key, so the animation runs
 * again on every new event, and the first reading after the bench opens draws
 * still.
 */
function TabButton({ on, unproxied, word, mark, count, detail, onClick }: {
  on: boolean;
  unproxied?: boolean;
  word: string;
  mark: preact.JSX.Element;
  count?: number;
  detail?: string;
  onClick: () => void;
}) {
  const named = detail ? `${word}: ${detail}` : word;
  const drawn = useRef<number | undefined>(undefined);
  const rises = useRef(0);
  if (count !== undefined) {
    if (drawn.current !== undefined && count > drawn.current) rises.current += 1;
    drawn.current = count;
  }
  return (
    <button class={[on ? 'on' : '', unproxied ? 'unproxied' : ''].filter(Boolean).join(' ')}
      title={named} aria-label={named} onClick={onClick}>
      <span class="tabmark">
        {mark}
        {count !== undefined && count > 0 && (
          <span key={rises.current} class={rises.current > 0 ? 'tabbadge risen' : 'tabbadge'}>{badgeOf(count)}</span>
        )}
      </span>
      <span class="tabword">{word}</span>
    </button>
  );
}

async function postTo(path: string, body?: Record<string, unknown>): Promise<void> {
  await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).catch(() => { /* the bench outlives a restart */ });
}

function Bench() {
  const [at, setAt] = useState<Place>(placeOf);
  const tab = at.tab;
  // Asked for from the footing, answered on Sequence: a recording produces steps, so
  // it is written where they are read.
  const [starting, setStarting] = useState(false);
  // The tab a capture was started from, to go back to once it is kept or
  // dropped: every capture opens on Sequence, where the reel it lands in is.
  const [shotFrom, setShotFrom] = useState<Exclude<Tab, 'editing'> | null>(null);
  const [busy, setBusy] = useState(false);
  // The call a History row's Go to opens the Tools tab on; the Tools tab
  // button clears it, so the tab opened from its button starts empty.
  const [toolSeed, setToolSeed] = useState<ToolSeed | null>(null);
  // The counts on the tabs: what crossed the proxy and whether there is one,
  // calls in history and how many failed, connections open and servers
  // running, issues open.
  const [counts, setCounts] = useState<{
    traffic?: number; proxied?: boolean; history?: number; failed?: number; running?: number; issues?: number;
  }>({});
  useEffect(() => {
    let live = true;
    // Asked for after the last event read, so a poll carries the new events only; the totals cover them all.
    let trafficSince = '';
    const read = async () => {
      const boundary = await fetch(`${BASE}/proxy/events?since=${encodeURIComponent(trafficSince)}`)
        .then(res => (res.ok ? res.json() : null)).catch(() => null) as
        { running: boolean; events: Array<{ id: string }>; totals: { events: number } | null } | null;
      if (boundary?.events.length) trafficSince = boundary.events[boundary.events.length - 1].id;
      const [history, servers, running, issues] = await Promise.all([
        fetch(`${BASE}/history`).then(res => (res.ok ? res.json() : null)).catch(() => null),
        fetch(`${BASE}/servers`).then(res => (res.ok ? res.json() : null)).catch(() => null),
        fetch(`${BASE}/running`).then(res => (res.ok ? res.json() : null)).catch(() => null),
        fetch(`${BASE}/issues`).then(res => (res.ok ? res.json() : null)).catch(() => null),
      ]) as [Array<{ failed?: boolean }> | null, Array<{ running: boolean }> | null, { connections: unknown[] } | null, unknown[] | null];
      if (!live) return;
      setCounts({
        ...(boundary && { proxied: boundary.running, ...(boundary.totals && { traffic: boundary.totals.events }) }),
        ...(history && { history: history.length, failed: history.filter(entry => entry.failed).length }),
        ...(servers && running && { running: servers.filter(server => server.running).length + running.connections.length }),
        ...(issues && { issues: issues.length }),
      });
    };
    void read();
    const timer = setInterval(read, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  /** The sequence the session last reported open; undefined before the first report. */
  const shown = useRef<string | null | undefined>(undefined);
  /**
   * The sequence a history move has posted for and the session has not yet
   * reported. Polls in flight while the post lands still carry the old name,
   * and each would push that name back onto the history.
   */
  const pending = useRef<{ sequence: string | null } | null>(null);

  const go = (next: Place) => {
    if (!samePlace(next, placeOf())) history.pushState(null, '', addressOf(next));
    setAt(next);
  };
  const goTab = (next: Tab) => go({ ...TAB_START, tab: next, sequence: placeOf().sequence });
  /** A move within the tab shown, such as opening an issue or choosing a tool. */
  const goWithin = (within: Partial<Omit<Place, 'tab' | 'sequence'>>) => go({ ...placeOf(), ...within });

  const reach = (sequence: string | null) => {
    if (sequence === shown.current) return;
    const asked = { sequence };
    pending.current = asked;
    void postTo(sequence ? '/sequence/select' : '/sequence/cancel', sequence ? { name: sequence } : {})
      .then(() => setTimeout(() => {
        if (pending.current !== asked) return;
        pending.current = null;
        // A select the session refused leaves the address naming a sequence
        // that is not open; it is set back to the one that is.
        if (shown.current !== undefined && shown.current !== placeOf().sequence) {
          history.replaceState(null, '', addressOf({ ...placeOf(), sequence: shown.current }));
        }
      }, 1000));
  };

  const onSequence = (name: string | null, running: boolean) => {
    setBusy(running);
    const first = shown.current === undefined;
    shown.current = name;
    if (pending.current) {
      if (pending.current.sequence === name) pending.current = null;
      return;
    }
    const here = placeOf();
    if (here.sequence === name) return;
    const next = addressOf({ ...here, sequence: name });
    if (first) history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  };

  useEffect(() => {
    const onPop = () => {
      const back = placeOf();
      setAt(back);
      reach(back.sequence);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const home = () => {
    if (busy) return;
    go({ ...TAB_START, tab: 'editing', sequence: null });
    reach(null);
  };

  return (
    <>
      <header>
        <h1 class="home" role="link" aria-disabled={busy ? true : undefined}
          title={busy ? 'the run is going - stop it first' : 'the list of sequences'}
          onClick={home}>bench</h1>
        <nav>
          <TabButton on={tab === 'editing'} word="Sequence" mark={<Glyph of="sequence" />}
            onClick={() => goTab('editing')} />
          <TabButton on={tab === 'traffic'} unproxied={counts.proxied === false} word="Traffic"
            mark={<Glyph of="request" />}
            count={counts.proxied === false ? undefined : counts.traffic}
            detail={counts.proxied === false
              ? 'this page runs outside a proxy, so no traffic is seen; Enable proxy on this tab opens it in a proxied window'
              : counts.traffic === undefined ? undefined : `${counts.traffic} crossings at the proxy`}
            onClick={() => goTab('traffic')} />
          <TabButton on={tab === 'history'} word="History" mark={<Glyph of="history" />}
            count={counts.history}
            detail={counts.history === undefined ? undefined : `${counts.history} calls in this session's history, ${counts.failed} failed`}
            onClick={() => goTab('history')} />
          <TabButton on={tab === 'tools'} word="Tools" mark={<Glyph of="tools" />}
            onClick={() => { setToolSeed(null); goTab('tools'); }} />
          <TabButton on={tab === 'running'} word="Running" mark={<Glyph of="pulse" />}
            count={counts.running}
            detail={counts.running === undefined ? undefined : `${counts.running} connections and servers running`}
            onClick={() => goTab('running')} />
          <TabButton on={tab === 'issues'} word="Issues" mark={<ToolGlyph tool="issues" />}
            count={counts.issues}
            detail={counts.issues === undefined ? undefined : `${counts.issues} open`}
            onClick={() => goTab('issues')} />
        </nav>
        {/* The state disc is drawn by the footing, which reads the state, into
            the slot on the connection picker's right, as the chosen connection's dot. */}
        <span class="grow" />
        <ConnectionPicker base={BASE} />
      </header>
      {tab === 'editing' && (
        <Editing
          base={BASE}
          onReturn={() => { if (shotFrom) goTab(shotFrom); setShotFrom(null); }}
          returnsFromShot={shotFrom !== null}
          starting={starting}
          onStarted={() => setStarting(false)}
        />
      )}
      {tab === 'traffic' && <Traffic base={BASE} />}
      {tab === 'history' && <History base={BASE} onGoTo={seed => {
        setToolSeed(seed);
        go({
          ...TAB_START, tab: 'tools', sequence: placeOf().sequence, tool: seed.tool,
          action: typeof seed.args.action === 'string' ? seed.args.action : null,
        });
      }} />}
      {tab === 'running' && <Running base={BASE} />}
      {tab === 'issues' && (
        <Issues base={BASE} issue={at.issue} onIssue={issue => goWithin({ issue })}
          onGoToNote={(sequence, step) => {
            // The run is started here and the address follows it, so the
            // Sequence tab opens on the sequence the note belongs to.
            void postTo('/sequence/playto', { name: sequence, step });
            go({ ...TAB_START, tab: 'editing', sequence });
          }} />
      )}
      {tab === 'tools' && (
        <Tools base={BASE} client={`${CLIENT_ID}-hold`} seed={toolSeed}
          tool={at.tool} action={at.action} onPlace={(tool, action) => goWithin({ tool, action })} />
      )}
      <Footing
        base={BASE}
        onSequence={onSequence}
        onNew={() => { goTab('editing'); setStarting(true); }}
        onVariables={() => goTab('editing')}
        onGo={(layer) => {
          if (layer === 'code') { void postTo('/devtools'); return; }
          goTab(layer === 'network' ? 'traffic' : 'editing');
          if (layer === 'network') goToSection('waiting');
          if (layer === 'sequence') goToSection('step-here');
        }}
        onShot={() => {
          setStarting(false);
          if (tab !== 'editing') setShotFrom(tab);
          goTab('editing');
        }}
      />
    </>
  );
}

if (root) render(<Bench />, root);
