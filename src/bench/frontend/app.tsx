/** @jsxImportSource preact */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Boundary, Scope } from './boundary.js';
import { About, Notes, Variables } from './sequence.js';
import { Editing } from './editing.js';
import { Glyph } from './glyph.js';
import type { BenchView, BoundaryState } from '../wire.js';
import './bench.css';

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

/**
 * Which sequence is open and whether the page runs, under every tab.
 *
 * Both are properties of the session rather than of a tab: a held page has its
 * JS stopped, so a click on the app reaches nothing and a step driven into it
 * lands nowhere, and every tab reads the open sequence. Held inside one tab,
 * the state was unreadable from the other three - a page stopped from STEPS
 * looked like an app that had broken.
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
function Footing({ base, onNew, onShot }: {
  base: string;
  onNew: () => void;
  /** A capture lands on the screen that holds the reel, so it opens there. */
  onShot: () => void;
}) {
  const [state, setState] = useState<BenchView | null>(null);
  const [gone, setGone] = useState(false);
  /** What this button has asked for and not yet seen confirmed. */
  const [asked, setAsked] = useState<boolean | null>(null);
  const [shooting, setShooting] = useState(false);
  /** Which reading is open over whatever tab is showing. */
  const [showing, setShowing] = useState<'about' | 'vars' | 'proxy' | null>(null);
  const [boundary, setBoundary] = useState<BoundaryState | null>(null);
  /** What the session answered when asked to relaunch through a proxy. */
  const [proxyAsked, setProxyAsked] = useState('');

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
    // Fast while a run is producing crossings, slow while it is not: paused,
    // the number belongs to a step that has stopped changing.
    const timer = setInterval(poll, running ? 400 : 1500);
    return () => { live = false; clearInterval(timer); };
  }, [base, running]);

  if (gone) {
    return <div class="footing">
      <div class="footbar">
        <span class="held closed" title="the bench has been closed on this connection">closed</span>
      </div>
    </div>;
  }
  if (!state) return <div class="footing"><div class="footbar"><span class="held waiting">…</span></div></div>;

  // What the poll last reported, unless this button has just asked for the
  // other thing. Freezing takes a moment and the poll is a second apart, so
  // reading only the poll leaves the button ignoring its own click.
  const frozen = asked ?? state.frozen;
  const sequence = state.sequence;
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
   * itself does not ask for it - RESTART and REPLAY release the freeze before
   * they drive, so neither names it.
   */
  const barred = (needs: { open?: boolean; idle?: boolean; running?: boolean }) => {
    if (needs.open && !sequence?.name) return 'pick a sequence first';
    if (needs.idle && sequence?.busy) return 'the run is going - stop it first';
    if (needs.running && frozen && !sequence?.paused) {
      return 'the page is frozen - let it run first';
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
  return (
    <>
    <div class="footing">
      {/* The run bar exists only while a sequence does: every control on it
          drives that run, and the bar above carries the selector that opens
          one. Stacked with the standing bar at the bottom, so this one
          appearing does not move the controls that are always there. */}
      {sequence?.name && (
        <div class="footbar">
          {/* A run stopped by hand and a run that reached its end both sit
              still, so the one that was stopped says so - and names the
              control that carries it on. */}
          <span class={sequence.playing ? 'at running' : sequence.paused ? 'at paused' : 'at'}>
            {sequence.playing ? 'running · '
              : sequence.paused ? (frozen ? 'paused · frozen · ' : 'paused · ')
              : ''}
            step <b>{Math.min(sequence.currentStep + 1, sequence.total)}</b> of {sequence.total}
          </span>
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
            const answered = here.filter(event => event.heldAs !== undefined).length;
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
              await post('/freeze', { frozen: false });
              await post('/sequence/goto', { step: 0 });
            }}><Glyph of="restart" /></button>
          <button class="chip-toggle" {...held(barred({ idle: true }))}
            title={barred({ idle: true }) ?? 'back to the first step and straight through'}
            aria-label="REPLAY"
            onClick={async () => {
              if (barred({ idle: true })) return;
              await post('/freeze', { frozen: false });
              await post('/sequence/goto', { step: 0 });
              await post('/sequence/play');
            }}><Glyph of="replay" /></button>
          <button class="chip-toggle" {...held(barred({ idle: true, running: true }))}
            title={barred({ idle: true, running: true }) ?? 'run the next step'}
            aria-label="STEP"
            onClick={async () => {
              if (barred({ idle: true, running: true })) return;
              if (sequence.paused) await post('/freeze', { frozen: false });
              await post('/sequence/step');
            }}
          ><Glyph of="step" /></button>
          <button
            class={sequence.paused ? 'chip-toggle waiting' : 'chip-toggle'}
            {...held(barred({ idle: true, running: true }))}
            title={barred({ idle: true, running: true })
              ?? (sequence.paused
                ? `carry on from step ${Math.min(sequence.currentStep + 1, sequence.total)}`
                : 'run from here')}
            aria-label="PLAY"
            onClick={async () => {
              if (barred({ idle: true, running: true })) return;
              // The pause froze the page, so carrying on lets it run again.
              if (sequence.paused) await post('/freeze', { frozen: false });
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
          <button class="chip-toggle"
            title={carrying
              ? 'the values this run carries, and where each came from'
              : 'nothing is carried between steps yet'}
            aria-label="VARIABLES"
            onClick={() => setShowing('vars')}
          ><Glyph of={carrying ? 'cogset' : 'cog'} /></button>
        </div>
      )}

      <div class="footbar">
        <select
          class="seqpick"
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
            : barred({ open: true }) ?? 'take the page as it stands'}
          aria-label="CAPTURE"
          onClick={async () => {
            if (shooting || barred({ open: true })) return;
            // Opened before the shot rather than after: the draft lands at the
            // head of that reel, and switching only once it arrives skips past
            // the moment it was taken.
            onShot();
            setShooting(true);
            await post('/shot', {});
            setShooting(false);
          }}><Glyph of="capture" /></button>
        <span class="rule" />
        {/* A browser is launched through a proxy or it is not, and a running
            one cannot gain one - so this states which, and asking is the only
            thing it can do about it. */}
        {boundary && (
          <button
            /* Three states, not two. A held page issues nothing, so a proxy
               that is recording and one whose page is stopped are both quiet -
               and reading the green one as "traffic is flowing" is how a
               frozen page gets mistaken for an app that has gone silent. */
            class={!boundary.running ? 'chip-toggle blind'
              : frozen ? 'chip-toggle stilled' : 'chip-toggle recording'}
            title={!boundary.running
              ? 'nothing records what crosses the boundary - open its controls'
              : frozen
                ? 'recording, and nothing is crossing: the page is frozen'
                : 'what crosses the boundary is being recorded - open its controls'}
            aria-label={!boundary.running ? 'NOT RECORDING'
              : frozen ? 'RECORDING WHILE FROZEN' : 'RECORDING'}
            onClick={() => setShowing('proxy')}
          ><Glyph of="proxy" /></button>
        )}
        <button
          class={frozen ? 'chip-toggle frozen' : 'chip-toggle'}
          title={frozen
            ? `the page is frozen at ${state.tickMs}ms — its JS is stopped, so it cannot be driven. Click to let it run.`
            : 'the page is running and can be driven. Click to freeze it.'}
          aria-label={frozen ? 'FROZEN' : 'FREEZE'}
          onClick={async () => {
            setAsked(!frozen);
            await post('/freeze', { frozen: !frozen });
            // Back to whatever the page reports: the request may have been
            // refused, and a button that keeps its own answer would report a
            // freeze that is not there.
            setAsked(null);
          }}
        ><Glyph of="freeze" /></button>
      </div>
    </div>

    {/* Outside the bar, not within it: `.footing` is transformed, and a
        transform makes its element the containing block for anything fixed
        inside it - the scrim would cover the bar rather than the screen. */}
    {(showing === 'proxy' || (showing !== null && sequence?.name)) && (
        <div class="scrim" onClick={() => setShowing(null)}>
          <div class="report" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <div class="reporthead">
              <span class="what">
                {showing === 'proxy' ? 'the boundary' : sequence?.name}
              </span>
              <button class="close" title="close" onClick={() => setShowing(null)}>×</button>
            </div>
            {showing === 'vars' && sequence && (
              <Variables
                variables={sequence.variables ?? []}
                steps={sequence.steps ?? []}
                post={post}
              />
            )}
            {showing === 'proxy' && (boundary?.running
              ? <Scope
                  allowed={boundary.allowed}
                  refusals={boundary.refusals ?? []}
                  refusesWrites={boundary.refusesWrites ?? false}
                  refusedWrites={boundary.refusedWrites ?? 0}
                  said={proxyAsked}
                  held={boundary.events.length}
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
              : <div class="noproxy">
                  <span class="grow">
                    This browser was not launched through a proxy, so nothing records what
                    crosses its boundary. A browser is launched through one or it is not;
                    a running one cannot gain one.
                  </span>
                  {proxyAsked
                    ? <span class="asked">{proxyAsked}</span>
                    : <button class="save" onClick={async () => {
                        const res = await fetch(`${base}/proxy/relaunch`, { method: 'POST' })
                          .catch(() => null);
                        setProxyAsked(res ? await res.text() : 'the bench did not answer');
                      }}>ASK THE SESSION TO RELAUNCH WITH A PROXY</button>}
                </div>)}
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

function Bench() {
  const [tab, setTab] = useState<'editing' | 'boundary' | 'notes'>('editing');
  // Asked for from the footing, answered on the steps screen: a recording
  // produces steps, so it is written where they are read.
  const [starting, setStarting] = useState(false);
  return (
    <>
      <header>
        <h1>bench</h1>
        <nav>
          <button class={tab === 'editing' ? 'on' : ''} onClick={() => setTab('editing')}>
            UI
          </button>
          <button class={tab === 'boundary' ? 'on' : ''} onClick={() => setTab('boundary')}>
            BOUNDARY
          </button>
          <button class={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
            STEPS
          </button>
        </nav>
      </header>
      {tab === 'editing' && <Editing base={BASE} />}
      {tab === 'boundary' && <Boundary base={BASE} />}
      {tab === 'notes' && (
        <Notes base={BASE} starting={starting} onDone={() => setStarting(false)} />
      )}
      <Footing
        base={BASE}
        onNew={() => { setTab('notes'); setStarting(true); }}
        onShot={() => { setStarting(false); setTab('editing'); }}
      />
    </>
  );
}

if (root) render(<Bench />, root);
