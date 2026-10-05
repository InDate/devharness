/** @jsxImportSource preact */
import { useEffect, useRef } from 'preact/hooks';
import type { BenchView, HeldLayerView } from '../wire.js';
import { LAYER_WORDS, heldWords, waited } from './sequence.js';
import { Glyph } from './glyph.js';

type Layer = HeldLayerView['layer'];

/**
 * What each layer is, what stops it, the unit it moves by, and what a page
 * needs before it can be held: without the mechanism the layer runs whatever
 * is asked of it.
 */
const LAYERS: Array<{ layer: Layer; name: string; stops: string; needs: string; lacks: string }> = [
  { layer: 'code', name: 'Code', stops: 'the debugger stops the page\'s JS', needs: 'needs the debugger attached to this page', lacks: 'no debugger' },
  { layer: 'ui', name: 'Screen', stops: 'the page\'s JS and its CSS animations stop together', needs: 'needs the bench open on this page', lacks: 'no bench' },
  { layer: 'network', name: 'Traffic', stops: 'what crosses waits at the proxy, in arrival order', needs: 'needs a browser launched through the proxy', lacks: 'no proxy' },
];

/**
 * The hold, layer by layer: what holds each one, where it stands, and the
 * controls that move it. Opened from the state disc, so the colour that
 * prompted the click is answered by which layers stand still and why.
 *
 * A strip fixed above the page rather than a dialog over it: the held screen
 * stays readable while the controls move it. Its height is written to
 * `--holdbar`, which pushes the page, the sticky header and the state frame
 * down, so the strip sits outside the frame instead of covering what it frames.
 */
export function HoldPanel({ state, post, onClose, onGo }: {
  state: BenchView;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  /** Go to where a layer is read in full: the steps, the held panel, the Waiting list, DevTools. */
  onGo: (layer: Layer | 'sequence' | 'sequences') => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty('--holdbar', `${element.offsetHeight}px`));
    observer.observe(element);
    return () => { observer.disconnect(); root.style.setProperty('--holdbar', '0px'); };
  }, []);
  const heldOf = (layer: Layer) => state.held.find(held => held.layer === layer);
  const anyHeld = state.held.length > 0;
  const holdable = state.holdable.filter(layer => !heldOf(layer));
  const change = (action: 'hold' | 'release' | 'step', layers?: Layer[]) =>
    void post('/hold', { action, ...(layers ? { layers } : {}) });
  const sequence = state.sequence;
  const summary = anyHeld ? heldWords(state.held) : 'the page runs and its traffic crosses as it arrives';

  const stepAt = sequence?.name ? `step ${Math.min(sequence.currentStep + 1, sequence.total)} of ${sequence.total}` : null;
  const holders = [...new Set(state.held.filter(held => !held.via).map(held => held.source))];

  return (
    <div class="holdbar" ref={bar}>
      <div class={anyHeld ? 'holdrow holdtop layer-held' : 'holdrow holdtop'}>
        <b class="layername">Hold</b>
        <span class="holdbadges">
          {holders.length
            ? holders.map(source => <span key={source} class="badge holder" title={`held by the ${source}`}>{source}</span>)
            : <span class="badge running">running</span>}
        </span>
        <span class="layerstate" title={summary}>{summary}</span>
        <span class="holdreading" />
        {/* The layer rows' columns: step, step ten, hold or release, go to. */}
        <span class="holdslots">
          <span class="tool slot" />
          <button class={anyHeld ? 'tool' : 'tool off'} title={anyHeld ? 'Let every layer run' : 'Nothing is held'}
            aria-label="Release all" onClick={() => { if (anyHeld) change('release'); }}><Glyph of="play" /></button>
          <button class={holdable.length ? 'tool' : 'tool off'} title={holdable.length ? 'Hold every layer this page can hold' : 'Every layer is held'}
            aria-label="Hold all" onClick={() => { if (holdable.length) change('hold'); }}><Glyph of="hold" /></button>
          <button class="tool" title="Close" aria-label="Close" onClick={onClose}><Glyph of="cross" /></button>
        </span>
      </div>
      {sequence?.name
        ? <SequenceRow sequence={sequence} stepAt={stepAt ?? ''} post={post} onGo={() => onGo('sequence')} />
        : <NoSequenceRow onGo={() => onGo('sequences')} />}
      {LAYERS.map(({ layer, name, stops, needs, lacks }) => {
        const held = heldOf(layer);
        const available = state.holdable.includes(layer);
        const tone = held ? 'layer-held' : available ? 'layer-running' : 'layer-absent';
        const said = !available ? needs : !held ? stops : `${whereItStands(layer, held, state)} · ${ago(held.since)}`;
        return (
          <div class={`holdrow ${tone} row-${layer}`} key={layer}>
            <b class="layername">{name}</b>
            <span class="holdbadges">
              {!available ? <span class="badge absent" title={needs}>{lacks}</span>
                : !held ? <span class="badge running">running</span>
                : held.via ? <span class="badge holder" title={`held by the ${LAYER_WORDS[held.via]}'s hold`}>{LAYER_WORDS[held.via]}</span>
                : <span class="badge holder" title={`held by the ${held.source}`}>{held.source}</span>}
            </span>
            <span class="layerstate" title={said}>{said}</span>
            <span class="holdreading">{held && readingOf(layer, state, held)}</span>
            <LayerSlots layer={layer} held={held} available={available} state={state} change={change} post={post}
              go={available ? { title: GO_TITLES[layer], act: () => onGo(layer) } : { title: needs }} />
          </div>
        );
      })}
    </div>
  );
}

const GO_TITLES: Record<Layer, string> = {
  code: 'Open Chrome\'s DevTools on the app tab, docked, on the line it stopped on',
  ui: 'Go to the Sequence tab, where the held screen is read',
  network: 'Go to the Waiting list on the Traffic tab, to let one message through at a time',
};

/**
 * The open sequence as one more thing that runs or stands still: paused where
 * a hold or a pause stopped it, playing, or stopped between runs. Its unit is
 * a step, so its step slot runs one, and its hold slot pauses a play or plays
 * from where it stands.
 */
function SequenceRow({ sequence, stepAt, post, onGo }: {
  sequence: NonNullable<BenchView['sequence']>;
  stepAt: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  onGo: () => void;
}) {
  const playing = sequence.playing === true || (sequence.busy && !sequence.recording);
  // The same reading as the Sequence tab's header: a run standing still past its last step finished.
  const still = !playing && !sequence.recording;
  const failed = still && !!sequence.failure;
  const finished = still && !failed && !sequence.paused && sequence.total > 0 && sequence.currentStep >= sequence.total;
  const status = sequence.recording ? 'recording' : playing ? 'playing' : sequence.paused ? 'paused'
    : failed ? 'failed' : finished ? 'finished' : 'stopped';
  const active = playing || sequence.paused === true || sequence.recording === true;
  const current = sequence.steps[Math.min(sequence.currentStep, sequence.steps.length - 1)];
  const said = finished ? `${sequence.name} · the run reached the end`
    : failed ? `${sequence.name} · ${sequence.failure}`
    : `${sequence.name}${current ? ` · ${current.label}` : ''}`;
  const reading = finished ? (sequence.total === 1 ? '1 step' : `all ${sequence.total} steps`) : stepAt;
  const idle = !playing && !sequence.recording;
  const atEnd = sequence.currentStep >= sequence.total;
  return (
    <div class={`holdrow ${sequence.recording ? 'row-recording' : 'row-sequence'}${active ? ' layer-held' : ''}`}>
      <b class="layername">Sequence</b>
      <span class="holdbadges">
        <span class={`badge ${active ? 'holder' : failed ? 'failed' : 'running'}`}>{status}</span>
      </span>
      <span class="layerstate" title={said}>{said}</span>
      <span class="holdreading"><span class="n-step">{reading}</span></span>
      <span class="holdslots">
        <button class={idle && !atEnd ? 'tool' : 'tool off'}
          title={!idle ? 'Steps once the run has stopped' : atEnd ? 'The run is at its last step' : 'Run the next step, then hold again'}
          aria-label="Step" onClick={() => { if (idle && !atEnd) void post('/sequence/step'); }}><Glyph of="step" /></button>
        <button class="tool off" title="A sequence moves one step at a time" aria-label="Step ten"><Glyph of="steps" /></button>
        {playing
          ? <button class="tool" title="Pause the run on the step it has reached, holding every layer"
              aria-label="Pause" onClick={() => void post('/sequence/halt')}><Glyph of="hold" /></button>
          : <button class={sequence.recording || atEnd ? 'tool off' : 'tool'}
              title={sequence.recording ? 'A recording has no run to play' : atEnd ? 'The run is at its last step' : `Play from step ${Math.min(sequence.currentStep + 1, sequence.total)}, letting go of every hold`}
              aria-label="Play" onClick={() => { if (!sequence.recording && !atEnd) void post('/sequence/play'); }}><Glyph of="play" /></button>}
        <button class="tool" title="Go to the step it is on, in the Sequence tab's step list" aria-label="Go to" onClick={onGo}><Glyph of="arrow" /></button>
      </span>
    </div>
  );
}

/**
 * The Sequence row with no sequence open: present so the strip keeps its
 * shape, faded as a layer the page cannot hold is, and each slot dimmed with
 * what it waits on.
 */
function NoSequenceRow({ onGo }: { onGo: () => void }) {
  const off = 'Opens once a sequence is open';
  return (
    <div class="holdrow layer-absent">
      <b class="layername">Sequence</b>
      <span class="holdbadges"><span class="badge absent" title="no sequence is open">none</span></span>
      <span class="layerstate">no sequence open - pick one in the footer, or from the list on the Sequence tab</span>
      <span class="holdreading" />
      <span class="holdslots">
        <button class="tool off" title={off} aria-label="Step"><Glyph of="step" /></button>
        <button class="tool off" title={off} aria-label="Step ten"><Glyph of="steps" /></button>
        <button class="tool off" title={off} aria-label="Play"><Glyph of="play" /></button>
        <button class="tool" title="Go to the list of sequences on the Sequence tab" aria-label="Go to" onClick={onGo}><Glyph of="arrow" /></button>
      </span>
    </div>
  );
}

/**
 * The name a script's URL is read by: its file, or for a page served at a
 * directory - an inline script in `/` - the host and path, since the URL
 * names no file. A script with no URL, run by eval, has neither.
 */
function fileOf(url: string): string {
  if (!url) return '(script)';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').pop();
    return last || `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split('/').pop() || url;
  }
}

/** How long ago, coarsely, as the rest of the bench says it. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 2 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/**
 * What a held layer counts, at the row's right end as the sequence list puts
 * its notes: the callbacks the screen has run and the page time they took,
 * the messages waiting at the proxy.
 */
function readingOf(layer: Layer, state: BenchView, held?: HeldLayerView) {
  if (layer === 'code') {
    const at = held?.standing?.at;
    if (typeof at !== 'string' || !at) return null;
    // A script with no URL - one run by eval or injected - has nothing to name.
    const [url, line] = [at.slice(0, at.lastIndexOf(':')), at.slice(at.lastIndexOf(':') + 1)];
    const file = fileOf(url);
    return <span class="n-where" title={url || 'a script with no URL'}>{file}:{line}</span>;
  }
  if (layer === 'ui') {
    return <>
      <span class="n-callbacks">{state.totalSteps} callback{state.totalSteps === 1 ? '' : 's'}</span>
      <span class="n-ms">{state.tickMs}ms</span>
    </>;
  }
  if (layer === 'network') {
    return <span class="n-waiting">{state.queued.length} waiting</span>;
  }
  return null;
}

/**
 * The same four slots on every row - step, a bigger step, hold or release, go to -
 * so each control sits at one place down the strip. A slot a layer has no use
 * for is drawn dimmed, as the site's rows draw an action they lack.
 */
function LayerSlots({ layer, held, available, state, change, post, go }: {
  /** Where the layer is read in full; no act where the page cannot hold the layer. */
  go: { title: string; act?: () => void };
  layer: Layer;
  held: HeldLayerView | undefined;
  available: boolean;
  state: BenchView;
  change: (action: 'hold' | 'release' | 'step', layers?: Layer[]) => void;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const own = held !== undefined && held.via === undefined && held.keptBy === undefined;
  const coversCode = layer === 'ui' && state.held.some(other => other.via === 'ui');
  const waiting = state.queued.length;
  const step = !own ? null
    : layer === 'code' ? { title: 'Step over: run to the next statement and stop', act: () => change('step', ['code']) }
    : layer === 'ui' ? { title: 'Run the next callback and stop', act: () => void post('/tick', { steps: 1 }) }
    : waiting > 0 ? { title: 'Let the oldest waiting message through to the page', act: () => change('step', ['network']) }
    : null;
  const stepMany = own && layer === 'ui'
    ? { title: 'Run the next ten callbacks and stop', act: () => void post('/tick', { steps: 10 }) }
    : null;
  const toggle = !available ? null
    : held
      ? {
          title: held.via
            ? `Release: the ${LAYER_WORDS[held.via]} holds this, so the ${LAYER_WORDS[held.via]} is released too`
            : coversCode
              ? 'Release the screen: its animations run again, and the code stays held where it stopped'
              : `Release the ${LAYER_WORDS[layer]}`,
          glyph: 'play', act: () => change('release', [layer]),
        }
      : { title: `Hold the ${LAYER_WORDS[layer]} alone`, glyph: 'hold', act: () => change('hold', [layer]) };
  const stepOff = layer === 'network' && own ? 'Nothing is waiting at the proxy'
    : held?.via ? `Stepped with the ${LAYER_WORDS[held.via]}`
    : held?.keptBy ? `The ${LAYER_WORDS[held.keptBy]}'s pause holds this: hold the ${LAYER_WORDS[held.keptBy]} again to step it`
    : 'Steps once the layer is held';
  return (
    <span class="holdslots">
      <button class={step ? 'tool' : 'tool off'} title={step?.title ?? stepOff} aria-label="Step"
        onClick={() => step?.act()}><Glyph of="step" /></button>
      <button class={stepMany ? 'tool' : 'tool off'} title={stepMany?.title ?? (layer === 'ui' ? stepOff : 'Steps one at a time')}
        aria-label="Step ten" onClick={() => stepMany?.act()}><Glyph of="steps" /></button>
      <button class={toggle ? 'tool' : 'tool off'} title={toggle?.title ?? 'This page cannot hold this layer'}
        aria-label={held ? 'Release' : 'Hold'} onClick={() => toggle?.act()}><Glyph of={toggle?.glyph ?? 'hold'} /></button>
      <button class={go.act ? 'tool' : 'tool off'} title={go.title} aria-label="Go to"
        onClick={() => go.act?.()}><Glyph of="arrow" /></button>
    </span>
  );
}

/** Where a held layer stands: a line of code, the page's own clock, the queue. */
function whereItStands(layer: Layer, held: HeldLayerView, state: BenchView): string {
  if (layer === 'code') {
    const at = held.standing?.at;
    const fn = held.standing?.fn;
    if (typeof at === 'string' && at) return `stopped in ${fn ?? '(anonymous)'}`;
    if (held.via) return 'stops at the next callback the page runs';
    return 'armed: the page stops at the next thing it runs';
  }
  if (layer === 'ui') {
    const last = state.callbacks[state.callbacks.length - 1];
    return last ? `last ${last.kind ?? 'callback'} ${last.fn ?? ''}`.trimEnd() : 'no callback run since the hold';
  }
  const oldest = state.queued[0];
  return oldest ? `the oldest has waited ${waited(oldest.ageMs)}` : 'nothing has arrived since the hold';
}
