/** @jsxImportSource preact */
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Draft } from './markup.js';
import { Held } from './sequence.js';
import { ActivityRows, listedKinds, stepTally, useActivity } from './activity.js';
import { RecordingRow } from './recorder.js';
import { Recording } from './recording.js';
import { LabelInput, Row } from './row.js';
import { Glyph } from './glyph.js';
import type {
  Annotation, BenchView, CaptureRect, CaptureVersion, FactKind, SequenceCard, SequenceStep, SequenceVariable,
} from '../wire.js';
import { useEscape } from './escape.js';

/** How long one step number pulses after a move, and how far behind the one before it each starts. */
const RIPPLE_PULSE_MS = 1050;
const RIPPLE_STEP_MS = 240;

const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Why a finding cannot be taken yet, on the controls that would take one. */
const NO_ADDRESS = 'open a sequence first - a finding is stored in the step it belongs to, '
  + 'and one taken outside a run has no state to return to';

/**
 * Working on a UI.
 *
 * One column, read top to bottom. The run's steps are quiet markers in the
 * flow, and the findings taken while standing at a step sit under that step's
 * marker. The marker says where you were; the finding says what you saw there,
 * and the two are read together rather than joined up across a gutter.
 */
export function Editing({ base, onReturn, returnsFromShot, starting, onStarted }: {
  base: string;
  /** A new sequence has been asked for and not yet started or dropped. */
  starting: boolean;
  /** The ask is over: the recording ran and ended, or the form was left. */
  onStarted: () => void;
  /** Go to the recording's own screen, where its controls are. */
  onReturn: () => void;
  /** Set when a capture was started from another tab, which it goes back to when settled. */
  returnsFromShot: boolean;
}): preact.JSX.Element {
  const [state, setState] = useState<BenchView | null>(null);
  const [ended, setEnded] = useState(false);
  const [writingAt, setWritingAt] = useState<number | null>(null);
  // The step a timer is being put after, with its slider open under it.
  const [timerAt, setTimerAt] = useState<number | null>(null);
  // The step whose instructions are open to change.
  const [editAt, setEditAt] = useState<number | null>(null);
  // The step whose bin has been clicked once; a second click removes it.
  const [removingAt, setRemovingAt] = useState<number | null>(null);
  // Steps whose rows are folded under their marker, by position.
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  // The position a step was just moved to, lit until its pulse ends.
  const [movedTo, setMovedTo] = useState<number | null>(null);
  // The move whose step numbers are being swapped over, top to bottom.
  const [renumbered, setRenumbered] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (movedTo === null) return;
    const span = renumbered ? Math.abs(renumbered.to - renumbered.from) : 0;
    const timer = setTimeout(() => { setMovedTo(null); setRenumbered(null); setSettling(false); },
      Math.max(1400, RIPPLE_PULSE_MS + span * RIPPLE_STEP_MS));
    return () => clearTimeout(timer);
  }, [movedTo]);
  // A drop opens the gap it lands in before the step moves: the markers either
  // side of it part, and the step held fades where it was.
  const [split, setSplit] = useState<{ above?: number; below?: number; from: number } | null>(null);
  // After a drop the steps stay folded while their numbers swap over, and
  // open back out once the last one has.
  const [settling, setSettling] = useState(false);
  // The row under the pointer after a move holds another step; its tools stay
  // down until the pointer leaves it.
  const [quietAt, setQuietAt] = useState<number | null>(null);
  // A move folds both steps it swaps, so the two markers pass each other
  // without their rows between them.
  const moveStep = (from: number, to: number) => {
    setQuietAt(from);
    // Focus left on the clicked arrow would hold the tools up through :focus-within.
    (document.activeElement as HTMLElement | null)?.blur();
    setFolded(was => new Set([...was, from, to]));
    setMovedTo(to);
    setRenumbered({ from, to });
    void post('/sequence/step/move', { from, to });
  };
  // A step being dragged, and the marker and side it would land on. Every
  // step folds while one is dragged, so the drop targets are the markers alone.
  const [dragging, setDragging] = useState<number | null>(null);
  // Where the drop line is drawn: halfway across the gap it stands for.
  const [dropAt, setDropAt] = useState<{
    step: number; side: 'before' | 'after'; top: number; left: number; width: number;
    /** The steps either side of the gap; one is absent at either end of the list. */
    above?: number; below?: number;
  } | null>(null);
  const landing = (from: number, { step: at, side }: { step: number; side: 'before' | 'after' }) =>
    side === 'before' ? (at > from ? at - 1 : at) : (at >= from ? at : at + 1);
  // Read from the pointer against every marker, not from the marker under it:
  // the gaps between markers and the space below the last one are drop places
  // too, and a marker's own box is a few pixels high.
  const dragOver = (e: DragEvent) => {
    if (dragging === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // The step held is no place to drop: either side of it is where it already is.
    const marks = [...document.querySelectorAll<HTMLElement>('.mark[data-step]')]
      .filter(mark => Number(mark.dataset.step) !== dragging);
    if (!marks.length) return;
    const at = marks.findIndex(mark => {
      const box = mark.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    const edge = (mark: HTMLElement) => mark.getBoundingClientRect();
    const beside = edge(marks[at < 0 ? marks.length - 1 : at]);
    const above = at > 0 ? edge(marks[at - 1]) : undefined;
    const top = at < 0 ? beside.bottom + 8 : above ? (above.bottom + beside.top) / 2 : beside.top - 8;
    const next = at < 0
      ? { step: Number(marks[marks.length - 1].dataset.step), side: 'after' as const }
      : { step: Number(marks[at].dataset.step), side: 'before' as const };
    if (dropAt?.step !== next.step || dropAt.side !== next.side || dropAt.top !== top) {
      const aboveMark = at < 0 ? marks[marks.length - 1] : at > 0 ? marks[at - 1] : undefined;
      setDropAt({
        ...next, top, left: beside.left, width: beside.width,
        ...(aboveMark ? { above: Number(aboveMark.dataset.step) } : {}),
        ...(at >= 0 ? { below: Number(marks[at].dataset.step) } : {}),
      });
    }
  };
  const dropStep = async () => {
    if (dragging === null || !dropAt) return;
    const from = dragging;
    const to = landing(from, dropAt);
    const { above, below } = dropAt;
    setDragging(null);
    setDropAt(null);
    if (to === from) return;
    setSettling(true);
    setSplit({ from, ...(above !== undefined ? { above } : {}), ...(below !== undefined ? { below } : {}) });
    await new Promise(resolve => setTimeout(resolve, 240));
    await post('/sequence/step/move', { from, to });
    // Read at once rather than on the next poll, so the step lands in the gap
    // while it is still open rather than after it has closed on the old order.
    const moved = await fetch(`${base}/state?client=${CLIENT_ID}`).then(res => res.json()).catch(() => null);
    if (moved) setState(moved);
    setSplit(null);
    // The folds held before the drag follow the steps they were set on.
    setFolded(was => new Set([...was].map(at => at === from ? to
      : from < to && at > from && at <= to ? at - 1
      : from > to && at >= to && at < from ? at + 1 : at)));
    setQuietAt(to);
    setMovedTo(to);
    setRenumbered({ from, to });
  };
  // On the whole page while a drag runs, so anywhere the pointer is, including
  // below the last step, reads as a place to drop.
  const onDrop = (e: DragEvent) => { e.preventDefault(); void dropStep(); };
  useEffect(() => {
    if (dragging === null) return;
    document.addEventListener('dragover', dragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', dragOver);
      document.removeEventListener('drop', onDrop);
    };
  });
  const removeStep = (index: number) => {
    setFolded(was => new Set([...was].filter(at => at !== index).map(at => at > index ? at - 1 : at)));
    void post('/sequence/step/remove', { index });
  };
  const toggleFold = (index: number) => setFolded(was => {
    const next = new Set(was);
    if (!next.delete(index)) next.add(index);
    return next;
  });
  const activity = useActivity(base, state?.sequence);
  // A recording that has ended - saved or thrown away - ends the ask for a new
  // one too; left standing, the form came back with the old name in it.
  const wasRecording = useRef(false);
  const recordingNow = state?.sequence?.recording === true;
  useEffect(() => {
    if (wasRecording.current && !recordingNow && starting) onStarted();
    wasRecording.current = recordingNow;
  }, [recordingNow]);
  useEscape(activity.reading !== null, () => activity.setReading(null));

  const post = async (path: string, body?: Record<string, unknown>) => {
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).catch(() => { /* the bench outlives a restart */ });
  };

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${base}/state?client=${CLIENT_ID}`);
        if (!res.ok) throw new Error(String(res.status));
        if (live) setState(await res.json());
      } catch {
        if (live) setEnded(true);
      }
    };
    void poll();
    const timer = setInterval(poll, 400);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  // A pick is the start of a note, so it opens the composer where the note
  // will land rather than leaving the pick to be noticed.
  const picked = state?.pending != null;
  const target = state?.noteTarget;
  useEffect(() => {
    if (picked && state?.primary && writingAt === null && target !== undefined) {
      setWritingAt(target);
    }
  }, [picked, state?.primary, target]);

  if (ended) return <p class="hint">the bench has been closed on this connection</p>;
  if (!state) return <p class="hint">reading the session…</p>;

  const sequence = state.sequence;
  const steps = sequence?.steps ?? [];
  const findings = steps.flatMap(step => step.annotations ?? []);
  // Each stored variable's first definition, which the list shows above the
  // steps rather than as a step of its own; a later store is a change and
  // stays in place.
  const firstStore = new Map<string, SequenceStep>();
  for (const step of steps) {
    if (step.captures && step.stores !== undefined && !firstStore.has(step.captures)) firstStore.set(step.captures, step);
  }
  const defined = [...firstStore.entries()].map(([name, step]) => ({ name, step }));
  const definesAt = new Set(defined.map(one => one.step.index));
  // A recording going into another sequence is shown in its place: that
  // sequence's steps around it, and its own numbered where they will land.
  const into = sequence?.recording ? sequence.into : undefined;
  const number = (index: number) => (into ? into.after + 2 + index : index + 1);
  // The position a step stood at before the move being swapped over, for the
  // steps that move shifted; undefined for the rest.
  const wasAt = (index: number): number | undefined => {
    if (!renumbered) return undefined;
    const { from, to } = renumbered;
    if (index === to) return from;
    if (from < to && index >= from && index < to) return index + 1;
    if (from > to && index > to && index <= from) return index - 1;
    return undefined;
  };
  // A variable's value as the list knows it: stored in the sequence, or
  // captured by the run.
  const valueOf = (name: string) => firstStore.get(name)?.stores
    ?? (sequence?.variables ?? []).find(one => one.name === name)?.value;
  // The last step the list shows: a variable's definition sits above the
  // steps, so the last step may not be the last one shown.
  const lastShown = [...steps].reverse().find(step => !definesAt.has(step.index))?.index;

  // A capture taken from a note joins it, and its words replace the note's;
  // taken otherwise, its words start a new note.
  const joins = state.shot?.annotationId
    ? findings.find(note => note.id === state.shot!.annotationId)
    : undefined;
  const keep = async (marked: string, words: string, crop: CaptureRect | null, facts: FactKind[]) => {
    await post('/shot/save', { marked, crop, facts });
    if (!joins) await post('/save', { comment: words });
    else if (words.trim() !== (joins.comment ?? '')) {
      await post('/annotation/reword', { id: joins.id, words: words.trim() });
    }
    if (returnsFromShot) onReturn();
  };
  const drop = async () => {
    await post('/shot/discard');
    if (returnsFromShot) onReturn();
  };
  /**
   * A step's notes, placed among its activity rows. A note's place counts
   * rows: 0 above them all, the row count below them all, and k just under the
   * k-th. An arrow moves it one place, and past either end into the next step.
   */
  const notesAt = (step: SequenceStep) => {
    const kinds = listedKinds(activity, step.index);
    const notes = step.annotations ?? [];
    const placeOf = (note: Annotation) => note.after === '' ? 0
      : note.after !== undefined && kinds.includes(note.after) ? kinds.indexOf(note.after) + 1
      : kinds.length;
    const afterAt = (place: number) => place === kinds.length ? undefined : place === 0 ? '' : kinds[place - 1];
    const moveTo = (id: string, to: number, after: string | undefined) => () =>
      void post('/annotation/move', { id, step: to, ...(after !== undefined ? { after } : {}) });
    const movesOf = (note: Annotation) => {
      const place = placeOf(note);
      const last = step.index === steps.length - 1;
      return {
        up: place > 0 ? moveTo(note.id, step.index, afterAt(place - 1))
          : step.index > 0 ? moveTo(note.id, step.index - 1, undefined) : undefined,
        down: place < kinds.length ? moveTo(note.id, step.index, afterAt(place + 1))
          : !last ? moveTo(note.id, step.index + 1, '') : undefined,
      };
    };
    // Each place is drawn once: with no rows, above-all and below-all are the
    // same place, drawn as below-all.
    const placeFor = (after: string | null) => after === null ? kinds.length
      : after === '' ? (kinds.length ? 0 : -1)
      : kinds.indexOf(after) + 1 < kinds.length ? kinds.indexOf(after) + 1 : -1;
    return (after: string | null) => notes
      .filter(note => placeOf(note) === placeFor(after))
      .map(note => joins?.id === note.id && draft
        ? <li key={note.id} class="draftslot">{draft}</li>
        : <Finding key={note.id} note={note} base={base} post={post} moves={movesOf(note)}
            series={state.series ?? {}} />);
  };

  // Marked up where its words will stand: in place of the note it joins, or
  // at the step standing, or at the head of the column with none standing.
  const draft = state.shot && (
    <Draft
      shot={state.shot}
      picked={state.pending}
      onSave={(marked, words, crop, facts) => void keep(marked, words, crop, facts)}
      onReadFacts={(kinds) => void post('/shot/facts/read', { kinds })}
      onDiscard={() => void drop()}
      onDropPick={() => void post('/discard')}
      onWiden={(widen) => void post('/shot', { selector: state.shot!.selector, widen })}
      steps={joins ? undefined : steps}
      said={joins?.comment}
      filedAt={target}
      onStep={(step) => void post('/sequence/note', { step })}
    />
  );

  return (
    <div class="editing">
      {dragging !== null && dropAt && landing(dragging, dropAt) !== dragging && (
        <div class="dropline" style={{ top: `${dropAt.top}px`, left: `${dropAt.left}px`, width: `${dropAt.width}px` }} />
      )}

      {sequence?.failure && (
        <div class="failure">
          <span class="bad grow">{sequence.failure}</span>
          {(() => {
            // A wait that failed its step: the row that says how is under the
            // step, which may be off screen.
            const failed = (activity.boundary?.waitOutcomes ?? []).find(one => one.state === 'failed');
            return failed && (
              <button class="chip-toggle" onClick={() => document.getElementById(`wait-${failed.step}-${failed.key ?? ''}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>Show</button>
            );
          })()}
          <button class="chip-toggle" onClick={() => void post('/sequence/failure/dismiss')}>
            Dismiss
          </button>
        </div>
      )}

      {state.frozen && <Held state={state} post={post} />}

      {/* Naming a new sequence, with none recording yet: the open sequence's
          steps belong to another run, so the form stands alone. */}
      {starting && !sequence?.recording && (
        <main class="reel">
          <Recording base={base} onCancel={onStarted} />
        </main>
      )}

      {sequence?.recording && <RecordingRow sequence={sequence} post={post} />}

      {/* One column, read top to bottom: the run's steps as quiet markers, and
          under each the findings taken while standing there. A sidecar beside
          it would put the place and the finding in two columns the eye has to
          join up. */}
      {!(starting && !sequence?.recording) && <main class="reel">
        {/* A capture or a pick taken with no step standing - nothing selected,
            or the run finished - leads the column. Placed after the catalogue
            it would sit below every tile, off the bottom of the screen, which
            reads as the capture having failed. */}
        {!joins && !steps.some(step => step.current) && draft}

        {!state.shot && state.pending && !steps.some(step => step.current) && (
          <ol class="activitycards">
            <Picked
              picked={state.pending}
              onSave={(words) => void post('/save', { comment: words })}
              onShoot={() => void post('/shot', { selector: state.pending!.selector })}
              onDrop={() => void post('/discard')}
              onCancel={() => void post('/discard')}
            />
          </ol>
        )}

        {!sequence?.name && (
          <p class="hint noaddress">
            A finding is stored in the step it belongs to, so that whoever reads it can run back
            to the state it was taken in. Open a sequence below, or record one under RECORD.
          </p>
        )}

        {!sequence?.name && (
          <Catalogue
            cards={sequence?.catalogue ?? []}
            onOpen={(name) => void post('/sequence/select', { name })}
          />
        )}

        {sequence?.name && (
          <VariablesBlock defined={defined} post={post} recording={!!sequence.recording}
            captured={steps.filter(step => step.captures && step.stores === undefined)
              .filter((step, k, all) => all.findIndex(one => one.captures === step.captures) === k)
              .map(step => ({
                name: step.captures!, step,
                variable: (sequence.variables ?? []).find(one => one.name === step.captures),
              }))}
            readers={(name) => steps.filter(one => one.reads?.includes(name)).map(one => one.index)}
            tallied={activity.tallied} passes={activity.passes} />
        )}

        {into && into.labels.slice(0, into.after + 1).map((label, k) => (
          <div key={`before${k}`} class="mark context"><span class="marktext">step {k + 1} · {label}</span></div>
        ))}

        {steps.filter(step => !definesAt.has(step.index)).map(step => (
          <Fragment key={step.index}>
            <div
              class={['mark', step.current ? 'here' : '', step.failed ? 'failed' : '',
                folded.has(step.index) || dragging !== null ? 'folded' : '', movedTo === step.index ? 'moved' : '',
                quietAt === step.index ? 'quiet' : '', dragging === step.index || split?.from === step.index ? 'dragged' : '',
                split?.above === step.index ? 'splitabove' : '', split?.below === step.index ? 'splitbelow' : '',
                wasAt(step.index) !== undefined ? 'renumbered' : '']
                .filter(Boolean).join(' ')}
              // Each renumbered step swaps its number in turn, from the top of
              // the moved range down, so the numbers read as shifting one by one.
              style={renumbered && wasAt(step.index) !== undefined
                ? {
                  '--ripple-delay': `${(step.index - Math.min(renumbered.from, renumbered.to)) * RIPPLE_STEP_MS}ms`,
                  '--ripple-pulse': `${RIPPLE_PULSE_MS}ms`,
                }
                : undefined}
              draggable={!sequence?.recording}
              onDragStart={(e: DragEvent) => {
                e.dataTransfer?.setData('text/plain', String(step.index));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                setDragging(step.index);
              }}
              data-step={step.index}
              onDragEnd={() => { setDragging(null); setDropAt(null); }}
              onClick={() => toggleFold(step.index)}
              onMouseLeave={() => {
                if (removingAt === step.index) setRemovingAt(null);
                if (quietAt === step.index) setQuietAt(null);
              }}
              title={folded.has(step.index) ? 'show the rows under this step' : 'fold the rows under this step'}
            >
              <span class="marktext">
                <span class="marknum">step {wasAt(step.index) === undefined
                  ? number(step.index)
                  : <span class="numswap"><span class="was">{number(wasAt(step.index)!)}</span><span class="now">{number(step.index)}</span></span>}
                </span> · <span>{withVariables(step.label, valueOf)}</span>
                {into && <span class="newtag"> · new</span>}
                {step.current ? ' · standing here' : ''}
              </span>
              {folded.has(step.index) && <FoldTally counts={{
                ...stepTally(activity, step.index),
                notes: (step.annotations ?? []).length,
                variables: step.captures ? 1 : 0,
              }} />}

              <span class="marktools">
              <button
                class="marknote"
                title="write a finding against this step"
                onClick={(e: Event) => {
                  e.stopPropagation();
                  const open = writingAt === step.index;
                  setWritingAt(open ? null : step.index);
                  if (!open) void post('/sequence/note', { step: step.index });
                }}
                aria-label={writingAt === step.index ? 'close the note' : 'write a note'}
              >{writingAt === step.index ? <Glyph of="cross" /> : <Glyph of="note" />}</button>
              {/* Standing here with the run paused: record new steps on the page
                  as it is, put into the sequence ahead of this step. */}
              {step.current && !sequence?.busy && !sequence?.recording && (
                <button class="marknote markrecord" title="record new steps here, ahead of this one"
                  aria-label="record from here"
                  onClick={(e: Event) => { e.stopPropagation(); void post('/sequence/record/into', { after: step.index - 1 }); }}
                ><Glyph of="record" /></button>
              )}
              {/* Where to stand to change the run: before this step, so a new
                  one can go in ahead of it, or after it. */}
              {!sequence?.recording && (
                <>
                  <button class="marknote" title="run to just before this step, and pause"
                    aria-label="run to before this step"
                    onClick={(e: Event) => {
                      e.stopPropagation();
                      void (step.index === 0
                        ? post('/sequence/select', { name: sequence?.name })
                        : post('/sequence/goto', { step: step.index - 1 }));
                    }}
                  ><Glyph of="before" /></button>
                  <button class="marknote" title="run through this step, and pause after it"
                    aria-label="run through this step"
                    onClick={(e: Event) => { e.stopPropagation(); void post('/sequence/goto', { step: step.index }); }}
                  ><Glyph of="after" /></button>
                </>
              )}
              {step.params && (
                <button
                  class="marknote"
                  title="change what this step is given"
                  aria-label={editAt === step.index ? 'close the step editor' : 'edit the step'}
                  onClick={(e: Event) => { e.stopPropagation(); setEditAt(editAt === step.index ? null : step.index); }}
                >{editAt === step.index ? <Glyph of="cross" /> : <Glyph of="pen" />}</button>
              )}
              {/* A recording takes a pause only after its latest action. */}
              {(!sequence?.recording || step.index === lastShown) && (
                <button
                  class="marknote"
                  title="wait a fixed time after this step"
                  aria-label={timerAt === step.index ? 'close the timer' : 'add a timer'}
                  onClick={(e: Event) => { e.stopPropagation(); setTimerAt(timerAt === step.index ? null : step.index); }}
                >{timerAt === step.index ? <Glyph of="cross" /> : <Glyph of="timer" />}</button>
              )}
              {/* Both routes renumber whatever is tied to step numbers. */}
              {!sequence?.recording && (
                <>
                  <button class="marknote" title="run this step sooner" aria-label="move this step up"
                    disabled={step.index === 0}
                    onClick={(e: Event) => { e.stopPropagation(); moveStep(step.index, step.index - 1); }}
                  ><Glyph of="up" /></button>
                  <button class="marknote" title="run this step later" aria-label="move this step down"
                    disabled={step.index === steps.length - 1}
                    onClick={(e: Event) => { e.stopPropagation(); moveStep(step.index, step.index + 1); }}
                  ><Glyph of="down" /></button>
                  <button class={removingAt === step.index ? 'marknote markremove sure' : 'marknote markremove'}
                    title={removingAt === step.index ? 'click again to take this step out of the run' : 'take this step out of the run'}
                    aria-label={removingAt === step.index ? 'confirm removing this step' : 'remove this step'}
                    onClick={(e: Event) => {
                      e.stopPropagation();
                      if (removingAt !== step.index) { setRemovingAt(step.index); return; }
                      setRemovingAt(null);
                      removeStep(step.index);
                    }}
                  ><Glyph of="clear" /></button>
                </>
              )}
              </span>
            </div>

            <div class={folded.has(step.index) || dragging !== null || split || settling ? 'stepbody folded' : 'stepbody'}><div class="stepbodyinner">
            {editAt === step.index && step.params && (
              <StepEditor step={step} variables={defined.map(one => one.name)
                .concat(steps.map(one => one.captures).filter((one): one is string => !!one && !firstStore.has(one)))}
                onCancel={() => setEditAt(null)}
                onSave={(params) => { void post('/sequence/step/edit', { index: step.index, params }); setEditAt(null); }} />
            )}
            {timerAt === step.index && (
              <TimerForm onCancel={() => setTimerAt(null)}
                onAdd={(ms) => { void post('/sequence/step/timer', { after: step.index, ms }); setTimerAt(null); }} />
            )}
            <ActivityRows activity={activity} step={step.index} base={base} recording={!!sequence?.recording}
              running={step.current && !!sequence?.busy}
              notesAt={notesAt(step)} />
            {step.tool === 'assert' && step.params && (
              <ol class="activitycards">
                <AssertRow step={step} valueOf={valueOf} />
              </ol>
            )}
            {step.captures && (
              <ol class="activitycards">
                <VariableRow name={step.captures} step={step.index} stores={step.stores}
                  usedBy={steps.filter(one => one.reads?.includes(step.captures!)).map(one => one.index)}
                  variable={(sequence?.variables ?? []).find(one => one.name === step.captures)} />
              </ol>
            )}
            </div></div>

            {!joins && step.current && draft}

            {writingAt === step.index && !state.shot && (
              <ol class="activitycards">
                <Picked
                  picked={state.pending}
                  onSave={async (words) => {
                    await post('/save', { comment: words });
                    setWritingAt(null);
                  }}
                  onShoot={() => void post('/shot', { selector: state.pending!.selector })}
                  onDrop={() => void post('/discard')}
                  onCancel={() => {
                    setWritingAt(null);
                    if (state.pending) void post('/discard');
                  }}
                />
              </ol>
            )}
          </Fragment>
        ))}


        {/* Where the next recorded action lands: below the newest new step. */}
        {into && (
          <div class="mark awaiting" role="status" aria-live="polite">
            <span class="marktext">awaiting action</span>
          </div>
        )}
        {into && into.labels.slice(into.after + 1).map((label, k) => (
          <div key={`rest${k}`} class="mark context">
            <span class="marktext">step {into.after + 2 + steps.length + k} · {label}</span>
          </div>
        ))}

        {/* What the newest pass produced after its last step ended, which no
            step held open for. A row moved up from here joins the last step,
            on the recording and on every run after. */}
        {sequence?.name && (activity.crossed.get(steps.length) ?? []).length > 0 && !sequence.recording && (
          <>
            <div class="mark tail"><span class="marktext">after the last step</span></div>
            <ActivityRows activity={activity} step={steps.length} base={base} recording={false} />
          </>
        )}

      </main>}
    </div>
  );
}

/**
 * A variable as a row of the list: its name where a row names what it is,
 * `=`, its value, and at the right end where the value comes from. A stored
 * value is changed in place on the row; a captured object or array opens to
 * its fields.
 */
function VariableRow({ name, step, variable, stores, onSave, onRemove, usedBy = [] }: {
  name: string;
  step: number;
  /** The steps that read it, by position. */
  usedBy?: number[];
  variable?: SequenceVariable;
  /** The fixed value the step stores, known before it runs. */
  stores?: string;
  onSave?: (value: string) => void;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const captured = variable !== undefined && variable.source === `step ${step + 1}`;
  const editable = stores !== undefined && !!onSave;
  const value = stores !== undefined ? JSON.stringify(stores) : captured ? variable!.value : '—';
  const from = stores !== undefined ? 'stored'
    : captured ? `captured at step ${step + 1}` : `captured at step ${step + 1}, not run yet`;
  // What reads it, which is what the value is for; a value nothing reads yet says so.
  const used = usedBy.length
    ? `used by step${usedBy.length === 1 ? '' : 's'} ${usedBy.map(n => n + 1).join(', ')}`
    : 'not used yet';
  return (
    <Row
      classes={['varrow', stores !== undefined || captured ? '' : 'waiting']}
      columns={['remove']}
      title={from}
      label={<span class="what varline">
        <span class="varname">{name}</span>
        <span class="vareq">=</span>
        {editing
          ? <LabelInput value={stores ?? ''} onSave={(next) => onSave?.(next)} onDone={() => setEditing(false)} />
          : <span class="varvalue">{value}</span>}
      </span>}
      reading={<span class="meta">{used}</span>}
      slots={onRemove ? { remove: onRemove } : {}}
      titles={{ remove: `stop storing ${name}` }}
      open={open && !!variable?.fields}
      onOpen={() => (editable ? setEditing(true) : setOpen(!open))}
    >
      <div class="body varbody">
        {(variable?.fields ?? []).map(field => (
          <div class="varfield" key={field.key}>
            <span class="quiet">{field.key}</span> {field.value}
          </div>
        ))}
      </div>
    </Row>
  );
}

/**
 * What an assert step checks, as a row of its list: the element and the
 * comparison, with any variable shown as its value, and whether the last run
 * found it held. A check that failed stops the run there, which the step
 * marks as failed.
 */
function AssertRow({ step, valueOf }: {
  step: SequenceStep;
  valueOf: (name: string) => string | undefined;
}) {
  const params = step.params as Record<string, unknown>;
  const said = (value: unknown) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
  const subject = params.selector !== undefined
    ? `${said(params.selector)} ${said(params.condition)}${params.attribute ? ` ${said(params.attribute)}` : ''}`
    : said(params.left);
  const compared = params.operator !== undefined ? ` ${said(params.operator)} ${said(params.right)}` : '';
  const outcome = step.failed ? 'failed' : step.done ? 'held' : 'pending';
  return (
    <Row
      classes={['assertrow', `assert-${outcome}`]}
      columns={[]}
      title={said(params.message) || undefined}
      label={<span class="what">{withVariables(`${subject}${compared}`.trim(), valueOf)}</span>}
      reading={<span class="meta">{outcome === 'failed' ? '✗ failed' : outcome === 'held' ? '✓ pass' : 'not run yet'}</span>}
      slots={{}}
      open={false}
      onOpen={() => {}}
    />
  );
}

/**
 * The variables a sequence defines, above its steps: each stored value the
 * first time a step stores it. A step storing it again later is a change
 * partway through, and stays where it runs.
 */
function VariablesBlock({ defined, captured, post, recording, readers, tallied, passes }: {
  defined: Array<{ name: string; step: SequenceStep }>;
  /** Variables a step captures from the page, listed here too; they change with their step, not here. */
  captured: Array<{ name: string; step: SequenceStep; variable?: SequenceVariable }>;
  /** The steps that read a variable, by position. */
  readers: (name: string) => number[];
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  /** While recording there is no file yet: adding, changing and dropping act on the recording itself. */
  recording: boolean;
  /** The last replay's differences from the recording across every step, as `N mismatch`. */
  tallied: string[];
  /** Runs whose traffic is held for comparison. */
  passes: number;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  // Focused as the form opens: `autofocus` is read on page load only, and a
  // box added later is left without the cursor.
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (adding) nameBox.current?.focus(); }, [adding]);
  // While recording there is no file yet: the value goes into the recording,
  // and lands above the steps with the rest once it is.
  const add = () => {
    if (name.trim()) void post(recording ? '/sequence/record/variable' : '/sequence/var/set', { name: name.trim(), value });
    setAdding(false); setName(''); setValue('');
  };
  return (
    <>
      {/* A + on the heading, shown on pointing as a step's note button is. */}
      <div class="mark varsmark">
        <span class="marktext">variables</span>
        <span class="marktools">
        <button class="marknote" title="store a named value for the whole sequence"
          aria-label={adding ? 'close' : 'add a variable'}
          onClick={(e: Event) => { e.stopPropagation(); setAdding(!adding); }}
        ><Glyph of={adding ? 'cross' : 'new'} /></button>
        </span>
      </div>
      {(defined.length > 0 || captured.length > 0) && (
        <ol class="activitycards">
          {captured.map(({ name: named, step, variable }) => (
            <VariableRow key={`captured|${named}`} name={named} step={step.index} variable={variable}
              usedBy={readers(named)} />
          ))}
          {defined.map(({ name: named, step }) => (
            <VariableRow key={named} name={named} step={step.index} stores={step.stores}
              usedBy={readers(named)}
              {...(recording ? {
                onSave: (next: string) => void post('/sequence/record/variable/edit', { name: named, value: next }),
                onRemove: () => void post('/sequence/record/variable/edit', { name: named, remove: true }),
              } : {
                onSave: (next: string) => void post('/sequence/var/set', { name: named, value: next }),
                onRemove: () => void post('/sequence/var/remove', { name: named }),
              })} />
          ))}
        </ol>
      )}
      {adding
        ? <div class="timerline open variable">
            <span>set</span>
            <input class="replinput vname" placeholder="name" value={name} ref={nameBox}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }} />
            <span>=</span>
            <input class="replinput vvalue" placeholder="value" value={value}
              onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }} />
            <button class="tool plain" onClick={add}>Add</button>
            <button class="tool plain" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        : null}
      <div class="mark varsmark stepsmark">
        <span class="marktext">
          steps
          {tallied.length > 0 && <> · last replay: {tallied.map((part, k) => (
            <Fragment key={part}>{k > 0 && ' · '}<span class={`tally ${part.split(' ')[1]}`}>{part}</span></Fragment>
          ))}</>}
          {passes > 1 && ` · ${passes} passes held`}
        </span>
      </div>
    </>
  );
}

/** A folded step's rows, as a count per colour; a colour with none is left out. */
function FoldTally({ counts }: { counts: Record<'traffic' | 'intercepted' | 'missing' | 'waits' | 'notes' | 'variables', number> }) {
  const order = ['traffic', 'intercepted', 'missing', 'waits', 'notes', 'variables'] as const;
  const shown = order.filter(kind => counts[kind] > 0);
  if (!shown.length) return null;
  return (
    <span class="foldtally">
      {shown.map(kind => (
        <span key={kind} class={`foldcount ${kind}`} title={`${counts[kind]} ${kind}`}>{counts[kind]}</span>
      ))}
    </span>
  );
}

/**
 * A step's label with each `{{var:name}}` shown as the value it stands for,
 * in the variable colour, and the variable's name on pointing at it. A
 * variable with no value yet shows by its name.
 */
function withVariables(label: string, valueOf: (name: string) => string | undefined): preact.ComponentChildren {
  const parts = label.split(/\{\{var:([A-Za-z_][A-Za-z0-9_]*)\}\}/);
  return parts.map((part, k) => (k % 2 === 1
    ? <span key={k} class="vartoken" title={`{{var:${part}}}`}>{valueOf(part) ?? part}</span>
    : part));
}

/**
 * What a step is given, as JSON to change. The variables the sequence has are
 * offered under it, each putting `{{var:name}}` where the cursor is, since
 * that token is what a step reads a variable by.
 */
function StepEditor({ step, variables, onSave, onCancel }: {
  step: SequenceStep;
  variables: string[];
  onSave: (params: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(step.params ?? {}, null, 2));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const insert = (name: string) => {
    const area = box.current;
    const token = `{{var:${name}}}`;
    const at = area?.selectionStart ?? text.length;
    const to = area?.selectionEnd ?? at;
    const next = text.slice(0, at) + token + text.slice(to);
    setText(next);
    setTimeout(() => { area?.focus(); area?.setSelectionRange(at + token.length, at + token.length); }, 0);
  };
  const save = () => {
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setFailure('what a step is given has to be a JSON object');
        return;
      }
      onSave(parsed);
    } catch (error) {
      setFailure(`not JSON: ${String((error as Error).message ?? error)}`);
    }
  };
  return (
    <div class="stepeditor" onClick={(e: MouseEvent) => e.stopPropagation()}>
      <div class="stepeditorhead"><span class="quiet">{step.tool}</span></div>
      <textarea ref={box} class="stepedittext" spellcheck={false} value={text}
        rows={Math.min(14, text.split('\n').length + 1)}
        onInput={(e: Event) => { setText((e.target as HTMLTextAreaElement).value); setFailure(undefined); }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          if (e.key === 'Escape') onCancel();
        }} />
      <div class="stepeditorfoot">
        {variables.length > 0 && (
          <span class="stepeditorvars">
            <span class="quiet">insert</span>
            {variables.map(name => (
              <button key={name} class="tool plain" title={`put {{var:${name}}} at the cursor`}
                onClick={() => insert(name)}>{name}</button>
            ))}
          </span>
        )}
        {failure && <span class="bad">{failure}</span>}
        <span class="grow" />
        <button class="tool plain" title="⌘↵" onClick={save}>Save</button>
        <button class="tool plain" title="Esc" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * A fixed pause to put after a step, for a delay no crossing marks the end
 * of: a slider for the seconds, then Add.
 */
function TimerForm({ onAdd, onCancel }: { onAdd: (ms: number) => void; onCancel: () => void }) {
  const [seconds, setSeconds] = useState('1');
  const add = () => {
    const ms = Math.round((Number(seconds) || 0) * 1000);
    if (ms > 0) onAdd(ms);
  };
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => { slider.current?.focus(); }, []);
  return (
    <div class="timerline open timer">
      <label class="waitslider timerslider">
        <span class="waitlabel">wait</span>
        <input type="range" min={0.5} max={30} step={0.5} value={seconds} ref={slider}
          onInput={(e: Event) => setSeconds((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') add(); if (e.key === 'Escape') onCancel(); }} />
        <span class="waitvalue">{seconds} s</span>
      </label>
      <button class="tool plain" onClick={add}>Add</button>
      <button class="tool plain" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/**
 * A note being written, as a note row: Note in the first column, the words
 * where the note's words will sit, and what can be done with it at the right
 * end. A picked element is named under it, and can be dropped to write about
 * the step instead. Enter saves; Escape and Cancel leave nothing behind.
 */
function Picked({ picked, onSave, onShoot, onDrop, onCancel }: {
  picked?: { tag: string; selector: string; text?: string } | null;
  onSave: (words: string) => void;
  onShoot: () => void;
  onDrop: () => void;
  onCancel: () => void;
}) {
  const [words, setWords] = useState('');
  return (
    <li class="crossed listrow noterow composing open">
      <div class="crossedhead rowhead">
        <span class="dir">Note</span>
        <span class="way" />
        <span class="rowlabel">
          {picked && <span class="what quiet">about {picked.tag} · {picked.selector}</span>}
          {picked && (
            <button class="tool plain" title="drop the pick and write about the step instead" onClick={onDrop}>×</button>
          )}
        </span>
        <span class="rowright composeactions">
          <button class="tool plain" disabled={!words.trim()} title="⌘↵" onClick={() => onSave(words)}>Save</button>
          {picked && (
            <button class="tool plain" title="capture the picked element, then mark it up" onClick={onShoot}>Capture</button>
          )}
          <button class="tool plain" title="Esc" onClick={onCancel}>Cancel</button>
        </span>
      </div>
      <NoteWords
        value=""
        placeholder={picked ? "what's wrong with it?" : 'what did you see at this step?'}
        onInput={setWords}
        onSave={onSave}
        onCancel={onCancel}
      />
    </li>
  );
}

/**
 * A note's words being written, on their own line under the row: as many
 * lines as they need, growing as they are typed. Enter starts a new line,
 * ⌘↵ saves and Escape leaves.
 */
function NoteWords({ value, placeholder, onInput, onSave, onCancel }: {
  value: string;
  placeholder?: string;
  onInput?: (words: string) => void;
  onSave: (words: string) => void;
  onCancel: () => void;
}) {
  const [words, setWords] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  // Grown to what it holds, so every line written is on screen.
  const fit = () => {
    const area = box.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };
  useEffect(() => {
    fit();
    const area = box.current;
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  }, []);
  return (
    <textarea
      ref={box}
      class="notewords"
      rows={1}
      value={words}
      placeholder={placeholder}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onInput={(e: Event) => {
        const next = (e.target as HTMLTextAreaElement).value;
        setWords(next);
        onInput?.(next);
        fit();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (words.trim()) onSave(words); }
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      }}
    />
  );
}

function Finding({ note, base, post, moves, series }: {
  note: Annotation;
  base: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  /** One place up or down among the activity rows, where there is one. */
  moves: { up?: () => void; down?: () => void };
  /** Versions of each capture, by the path the note holds. */
  series: Record<string, CaptureVersion[]>;
}) {
  /** The capture being read at full size, by its path. */
  const [open, setOpen] = useState<string | null>(null);
  useEscape(open !== null, () => setOpen(null));
  const [unfolded, setUnfolded] = useState(false);
  const [rewording, setRewording] = useState(false);
  const [draft, setDraft] = useState(note.comment ?? '');
  /** Per capture, the two takes read against each other; the earlier is what a retake compares with. */
  const [pairs, setPairs] = useState<Record<string, { now?: number; then?: number }>>({});
  const [retaking, setRetaking] = useState<string | null>(null);
  const pairOf = (path: string) => takesOf(series[path] ?? [], pairs[path]);
  const shots = note.screenshots ?? [];
  const [firstLine, ...restLines] = (note.comment ?? '').split('\n');
  const more = restLines.some(line => line.trim());
  // One line, like the activity beside it: what was said, and on pointing at
  // it what can be done with it. The capture and the element are read on
  // opening it, as a row's payload is.
  return (
    <Row
      classes={['noterow']}
      columns={['remove', 'rename', 'capture', 'send', 'up', 'down']}
      source="Note"
      title={note.target?.selector}
      // Opened, the words are read whole on the row beneath, so the line leaves them there.
      label={<span class="what">{unfolded ? '' : `${firstLine || '(no words)'}${more ? ' …' : ''}`}</span>}
      reading={<span class="meta">
        +{note.tick}ms{shots.length ? ` · ${shots.length} capture${shots.length === 1 ? '' : 's'}` : ''}
      </span>}
      slots={{
        rename: () => { setUnfolded(true); setRewording(true); },
        capture: () => void post('/shot/begin', { annotationId: note.id }),
        send: () => void post('/annotation/notify', { id: note.id }),
        ...(moves.up ? { up: moves.up } : {}),
        ...(moves.down ? { down: moves.down } : {}),
        remove: () => void post('/annotation/delete', { id: note.id }),
      }}
      titles={{
        remove: 'remove this note', send: 'hand this note to the session', rename: 'change what this note says',
        capture: 'hold the page and take a capture for this note',
        up: 'move this note up one place', down: 'move this note down one place',
      }}
      open={unfolded}
      onOpen={() => setUnfolded(!unfolded)}
      onEnter={() => note.target && void post('/annotation/highlight', { selector: note.target.selector })}
      onLeave={() => note.target && void post('/annotation/highlight', { selector: '' })}
    >
      <div class="notebody">
        {/* The words whole, on their own row: the line above holds the first
            of them, cut to its width. */}
        {rewording
          ? <div class="noteedit">
              <NoteWords
                value={note.comment ?? ''}
                placeholder="what did you see?"
                onInput={setDraft}
                onSave={(words) => { void post('/annotation/reword', { id: note.id, words: words.trim() }); setRewording(false); }}
                onCancel={() => setRewording(false)}
              />
              <div class="bodyfoot">
                <span class="grow" />
                <span class="footactions">
                  <button class="tool plain" disabled={!draft.trim()} title="⌘↵"
                    onClick={() => { void post('/annotation/reword', { id: note.id, words: draft.trim() }); setRewording(false); }}>Save</button>
                  <button class="tool plain" title="Esc" onClick={() => setRewording(false)}>Cancel</button>
                </span>
              </div>
            </div>
          : <p class="notefull" title="click to edit" onClick={(e: MouseEvent) => {
              e.stopPropagation();
              setDraft(note.comment ?? '');
              setRewording(true);
            }}>{note.comment || '(no words)'}</p>}
        {shots.map(path => (
          <CaptureCompare key={path} path={path} base={base} versions={series[path] ?? []}
            pair={pairOf(path)} onPair={(next) => setPairs({ ...pairs, [path]: next })}
            onOpen={setOpen} words={note.comment} />
        ))}
        {/* The last line: what the note points at and what the takes measured,
            and what can be done with them. */}
        <div class="bodyfoot">
          <span class="footsummary">
            <span class="findingwhere">{note.target ? note.target.selector : 'about the step'}</span>
            {shots.map(path => (
              <PairFigure key={path} base={base} versions={series[path] ?? []} pair={pairOf(path)} path={path} />
            ))}
          </span>
          <span class="grow" />
          <span class="footactions">
            {shots.map((path, k) => {
              const versions = series[path] ?? [];
              const { then } = pairOf(path);
              return (
                <button key={path} class="tool plain" disabled={!versions.length || retaking === path}
                  title={versions.length ? `take this region again and compare it with v${then}` : 'captured before retake was recorded'}
                  onClick={async () => {
                    setRetaking(path);
                    await post('/shot/retake', { path, against: then });
                    setRetaking(null);
                  }}>{retaking === path ? 'Retaking…' : shots.length > 1 ? `Retake ${k + 1}` : 'Retake'}</button>
              );
            })}
          </span>
        </div>
      </div>

      {open && (
        <div class="scrim" onClick={() => setOpen(null)}>
          <div class="report shotview" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <div class="reporthead">
              <span class="what">{note.comment}</span>
              <button class="close" title="close" onClick={() => setOpen(null)}>×</button>
            </div>
            <img
              class="shotfull"
              src={`${base}/shot/img?p=${encodeURIComponent(open)}`}
              alt={note.comment}
            />
          </div>
        </div>
      )}
    </Row>
  );
}

/**
 * Choosing which sequence to work in.
 *
 * What decides it is what the sequence holds: how far it goes, what it is for,
 * and how much has already been written against it - a name alone makes every
 * one of them look the same.
 */
function Catalogue({ cards, onOpen }: {
  cards: SequenceCard[];
  onOpen: (name: string) => void;
}) {
  if (cards.length === 0) {
    return <p class="hint nothing">no sequences recorded yet</p>;
  }
  return (
    <div class="tiles">
      {cards.map(card => (
        <button class="tile" key={card.name} onClick={() => onOpen(card.name)}>
          <span class="tilename">{card.name}</span>
          {card.description && <span class="tilewhat">{card.description}</span>}
          {card.expectedOutcome && (
            <span class="tileexpect">expects {card.expectedOutcome}</span>
          )}
          <span class="tilecounts">
            <span>{card.steps} step{card.steps === 1 ? '' : 's'}</span>
            {card.notes > 0 && (
              <span class="tilenotes">{card.notes} note{card.notes === 1 ? '' : 's'}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

type ShotLayout = 'side' | 'stack' | 'overlay' | 'changes';

/** How two takes are laid out, kept per viewer across notes and reloads. */
function useShotLayout(): [ShotLayout, (next: ShotLayout) => void] {
  const read = (): ShotLayout => {
    try {
      const held = localStorage.getItem('bench.shotLayout');
      return held === 'stack' || held === 'overlay' || held === 'changes' ? held : 'side';
    } catch { return 'side'; }
  };
  const [layout, setLayout] = useState<ShotLayout>(read);
  return [layout, (next) => {
    setLayout(next);
    try { localStorage.setItem('bench.shotLayout', next); } catch { /* per-viewer only */ }
  }];
}

/**
 * One capture of a note, and its takes against each other.
 *
 * Two takes are chosen - the later and the one it is read against, which is
 * also what a retake is compared with - and laid side by side, one above the
 * other, or one over the other with a wipe between them. The figures are the
 * ones the retake measured, shown when the pair chosen is the pair it compared.
 */
/** The two takes read against each other: the ones chosen, else the latest and what it was compared with. */
function takesOf(versions: CaptureVersion[], chosen?: { now?: number; then?: number }): { now: number; then: number } {
  const latest = versions[versions.length - 1];
  const now = chosen?.now ?? latest?.version ?? 1;
  return { now, then: chosen?.then ?? latest?.compared?.against ?? Math.max(1, now - 1) };
}

function CaptureCompare({ path, base, versions, pair, onPair, onOpen, words }: {
  path: string;
  base: string;
  versions: CaptureVersion[];
  pair: { now: number; then: number };
  onPair: (next: { now: number; then: number }) => void;
  onOpen: (path: string) => void;
  words?: string;
}) {
  const latest = versions[versions.length - 1];
  const [layout, setLayout] = useShotLayout();
  const [wipe, setWipe] = useState(50);
  const nowV = pair.now;
  const thenV = pair.then;
  const setLater = (now: number) => onPair({ now, then: thenV });
  const setEarlier = (then: number) => onPair({ now: nowV, then });
  const now = versions.find(v => v.version === nowV);
  const then = versions.find(v => v.version === thenV);
  const img = (take: CaptureVersion | undefined, fallback: string) => {
    const src = take?.path ?? fallback;
    // The take alone: a retake's file is a comparison sheet, and two sheets
    // laid against each other compare nothing.
    return <img src={`${base}/shot/img?p=${encodeURIComponent(src)}&clean=1`} alt={words ?? ''} onClick={() => onOpen(src)} />;
  };
  const measured = now?.compared && now.compared.against === thenV ? now.compared : undefined;
  const pairing = versions.length > 1;
  const picker = (value: number, onChange: (next: number) => void) => (
    <select value={String(value)} onChange={(e: Event) => onChange(Number((e.target as HTMLSelectElement).value))}>
      {versions.map(v => <option key={v.version} value={String(v.version)}>v{v.version}</option>)}
    </select>
  );
  const label = (take: CaptureVersion | undefined) =>
    take ? `v${take.version} · ${new Date(take.at).toLocaleTimeString()}` : '';

  return (
    <div class="capture" onClick={(e: MouseEvent) => e.stopPropagation()}>
      {pairing && (
        <div class="pboxhead">
          {picker(nowV, setLater)}<span>vs</span>{picker(thenV, setEarlier)}
          <span class="grow" />
          {(['side', 'stack', 'overlay', 'changes'] as const).map(choice => (
            <button key={choice} class={layout === choice ? 'tool plain chosen' : 'tool plain'} aria-pressed={layout === choice}
              onClick={() => setLayout(choice)}>
              {choice === 'side' ? 'Side by side' : choice === 'stack' ? 'Stacked' : choice === 'overlay' ? 'Overlay' : 'Changes'}
            </button>
          ))}
        </div>
      )}
      {!pairing
        ? <div class="takes single">{img(latest, path)}</div>
        : layout === 'changes'
          ? <div class="takes changes">
              <Changes base={base} earlier={then?.path ?? path} later={now?.path ?? path} labels={[`v${thenV}`, `v${nowV}`]} />
            </div>
        : layout === 'overlay'
          ? <div class="takes overlay">
              <div class="overlaid">
                {img(then, path)}
                <div class="over" style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>{img(now, path)}</div>
              </div>
              <div class="wipe">
                <span>v{thenV}</span>
                <input type="range" min="0" max="100" value={wipe}
                  onInput={(e: Event) => setWipe(Number((e.target as HTMLInputElement).value))} />
                <span>v{nowV}</span>
              </div>
            </div>
          : <div class={layout === 'side' ? 'takes side' : 'takes stack'}>
              <figure>{img(then, path)}<figcaption>{label(then)}</figcaption></figure>
              <figure>{img(now, path)}<figcaption>{label(now)}</figcaption></figure>
            </div>}
      {/* Only what changes how the takes are read: captured at two scales,
          the figure measures the scaling; and what the element itself did.
          How the window was set for the retake is in the figure's tooltip. */}
      {measured && (measured.scales || (measured.factChanges ?? []).length > 0) && (
        <ul class="comparison">
          {measured.scales && (
            <li class="bad">
              taken at {measured.scales[0]}x and {measured.scales[1]}x, so the pixel figure measures the scaling: compare by eye
            </li>
          )}
          {(measured.factChanges ?? []).map(line => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

/** A pair of takes compared by the server, shared by every reader of the same pair. */
interface PairDiff {
  strip?: string;
  share?: number;
  box?: { x: number; y: number; w: number; h: number };
  failed?: boolean;
}

const pairDiffs = new Map<string, Promise<PairDiff>>();

/**
 * Two takes against each other, compared the way a retake compares them: the
 * strip of earlier, later and what changed, and what changed as a share.
 * Asked for once per pair, so the strip and the figure on the note's last
 * line read one comparison.
 */
function usePairDiff(base: string, earlier: string | undefined, later: string | undefined): PairDiff | undefined {
  const [held, setHeld] = useState<PairDiff | undefined>(undefined);
  useEffect(() => {
    if (!earlier || !later) { setHeld(undefined); return; }
    let live = true;
    const key = `${earlier}|${later}`;
    let asked = pairDiffs.get(key);
    if (!asked) {
      asked = fetch(`${base}/shot/diff?a=${encodeURIComponent(earlier)}&b=${encodeURIComponent(later)}`)
        .then(async (res): Promise<PairDiff> => {
          if (!res.ok) return { failed: true };
          const measured = JSON.parse(res.headers.get('x-diff') ?? '{}') as PairDiff;
          return { ...measured, strip: URL.createObjectURL(await res.blob()) };
        })
        .catch((): PairDiff => ({ failed: true }));
      pairDiffs.set(key, asked);
    }
    void asked.then(result => { if (live) setHeld(result); });
    return () => { live = false; };
  }, [base, earlier, later]);
  return held;
}

/** What changed between the pair shown, in words, with how the retake was taken in its tooltip. */
function PairFigure({ base, versions, pair, path }: {
  base: string;
  versions: CaptureVersion[];
  pair: { now: number; then: number };
  path: string;
}) {
  const now = versions.find(v => v.version === pair.now);
  const then = versions.find(v => v.version === pair.then);
  const diff = usePairDiff(base, versions.length > 1 ? then?.path ?? path : undefined, versions.length > 1 ? now?.path ?? path : undefined);
  if (versions.length < 2) return null;
  const resized = now?.compared?.resized;
  const setup = resized
    ? `retaken with the window at ${resized.from.slice(0, 2).join('×')} (${resized.to.slice(0, 2).join('×')} before)`
      + (resized.hidden ? '; the tab was in the background, so script layout kept the old size' : '')
    : undefined;
  const words = !diff ? 'comparing…'
    : diff.failed ? 'these takes could not be compared'
    : !diff.share ? `v${pair.then} → v${pair.now}: no pixels changed`
    : `v${pair.then} → v${pair.now}: ${(diff.share * 100).toFixed(1)}% of pixels changed`
      + (diff.box ? ` in ${diff.box.w}×${diff.box.h} at ${diff.box.x},${diff.box.y}` : '');
  return <span class={diff?.share ? 'figure changed' : 'figure'} title={setup}>{words}</span>;
}

/** The strip for the pair shown, each panel named above it. */
function Changes({ base, earlier, later, labels }: { base: string; earlier: string; later: string; labels: [string, string] }) {
  const diff = usePairDiff(base, earlier, later);
  if (!diff) return <p class="quiet">comparing…</p>;
  if (diff.failed || !diff.strip) return <p class="quiet">these takes could not be compared</p>;
  return (
    <div class="strip">
      <div class="striplabels"><span>{labels[0]}</span><span>{labels[1]}</span><span>changed</span></div>
      <img src={diff.strip} alt={`${labels[0]}, ${labels[1]} and what changed`} />
    </div>
  );
}
