/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CrossingRow, MissingRow, keyOf, lean, type RuleActions, type RowVerdict,
} from './crossing.js';
import { Recording } from './recording.js';
import { useActivity, rowOf, repeatsOf, originOf } from './activity.js';
import { onFocusRule, settleFocus, type RuleFocus } from './focus.js';
import { kindOf } from '../kinds.js';
import type {
  Annotation, BenchView, BoundaryEvent, BoundaryRule, CallbackEntry,
  SequenceCard, SequenceState, SequenceStep, SequenceVariable, TickResult,
} from '../wire.js';

export type {
  Annotation, BenchView, CallbackEntry, SequenceCard, SequenceState, SequenceStep,
  SequenceVariable, TickResult,
} from '../wire.js';
import { useEscape } from './escape.js';

/**
 * One bench owns the caret.
 *
 * The URL opens in any number of tabs and every copy polls the same state.
 * Without a claim each one takes focus the moment a pick lands, so the caret
 * jumps to whichever rendered last rather than staying where someone types.
 */
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

export function Notes({ base, starting, onDone }: {
  base: string;
  /** A new sequence has been asked for and not yet started or dropped. */
  starting: boolean;
  onDone: () => void;
}): preact.JSX.Element {
  const [state, setState] = useState<BenchView | null>(null);
  // A recording that has ended - saved or thrown away - ends the request for a
  // new one too; left standing, the form came back with the old name in it.
  const wasRecording = useRef(false);
  const recordingNow = state?.sequence?.recording === true;
  useEffect(() => {
    if (wasRecording.current && !recordingNow && starting) onDone();
    wasRecording.current = recordingNow;
  }, [recordingNow]);
  const [ended, setEnded] = useState(false);
  const [writingAt, setWritingAt] = useState<number | null>(null);
  const [editingAt, setEditingAt] = useState<{ step: number; field: 'why' | 'fork' } | null>(null);
  const [guarding, setGuarding] = useState<number | null>(null);
  const [asked, setAsked] = useState('');
  const activity = useActivity(base, state?.sequence);
  const { boundary, reading, setReading } = activity;
  useEscape(writingAt !== null, () => setWritingAt(null));
  useEscape(editingAt !== null, () => setEditingAt(null));
  useEscape(reading !== null, () => setReading(null));
  // A rule the proxy panel asked to see, met once the rows it lives on exist.
  const wanted = useRef<RuleFocus | null>(null);
  const [, askedFor] = useState(0);
  useEffect(() => onFocusRule((focus) => { wanted.current = focus; askedFor(n => n + 1); }), []);

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
    const timer = setInterval(poll, 250);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  // A pick is the start of a note, so it opens the composer where the note
  // will land rather than waiting to be noticed in a box somewhere else.
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

  // Naming a new sequence, with none being recorded yet. The open sequence's
  // steps and its boundary belong to a different run, and reading them under
  // a form that names another one puts two sequences on one screen. They
  // return the moment recording starts, when the steps below are its own.
  if (starting && !sequence?.recording) {
    return (
      <div class="notes">
        <Recording base={base} onCancel={onDone} />
      </div>
    );
  }

  const failedStep = sequence?.steps?.find(step => step.failed);
  const {
    ruleFor, crossed, gutter, stepCount, pass, stability, verdicts, missing, tallied, passes, move, actions,
  } = activity;
  if (wanted.current) {
    const { key, step } = wanted.current;
    const rows = step === undefined ? [...crossed.values()].flat() : (crossed.get(step) ?? []);
    const found = [...rows].reverse().find(event => keyOf(event) === key);
    if (found) {
      wanted.current = null;
      settleFocus();
      setTimeout(() => {
        setReading(rowOf(found.step ?? 0, found));
        document.getElementById(`crossing-${found.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 0);
    }
  }
  return (
    <div class="notes">
      {/* A recording produces the steps below it, so it is written at the head
          of them rather than on a screen of its own. It stays up while one is
          running, so reopening this tab mid-recording shows the recorder and
          its controls rather than an ordinary step list. */}
      {sequence?.recording && (
        <Recording base={base} />
      )}

      {/* Every control acts on the session rather than on this tab, so they
          all sit in the footing under it. What is left here is the reading
          this tab alone carries. */}
      {passes > 1 && <p class="hint">{passes} passes held</p>}

      {/* A browser is launched through a proxy or it is not, so this asks the
          session for a relaunch rather than pretending to switch one on. */}
      {boundary && !boundary.running && (
        <div class="noproxy">
          <span class="grow">
            Nothing records what crossed the boundary — this browser was not launched through a proxy.
          </span>
          {asked
            ? <span class="asked">{asked}</span>
            : <button class="save" onClick={async () => {
                const res = await fetch(`${base}/proxy/relaunch`, { method: 'POST' });
                setAsked(await res.text());
              }}>Ask the session to relaunch with a proxy</button>}
        </div>
      )}

      {state.frozen && <Held state={state} post={post} />}

      {sequence?.failure && (
        <div class="failure">
          <span class="bad grow">{sequence.failure}</span>
          {failedStep && failedStep.index > 0 && (
            <button
              class="chip-toggle"
              onClick={() => setGuarding(guarding === null ? failedStep.index : null)}
            >{guarding === null ? 'Guard this step' : 'Close'}</button>
          )}
          <button class="chip-toggle" onClick={() => void post('/sequence/failure/dismiss')}>
            Dismiss
          </button>
        </div>
      )}

      {/* Placed against the step before the one that failed, so the guard runs
          ahead of it rather than after the thing it was meant to protect. */}
      {guarding !== null && failedStep && (
        <Fork
          step={guarding - 1}
          steps={sequence?.steps ?? []}
          sequences={(sequence?.available ?? []).filter(name => name !== sequence?.name)}
          guarding={failedStep}
          post={post}
          onDone={() => setGuarding(null)}
        />
      )}

      {!sequence?.name && <p class="hint">pick a sequence to see its steps and write against them</p>}

      {tallied.length > 0 && (
        <p class="comparesummary differs">last replay: {tallied.join(' · ')}</p>
      )}

      {sequence?.name && (
        <ol class={sequence.busy ? 'steps running' : 'steps'}>
          {sequence.steps.map(step => (
            <StepRow
              key={step.index}
              step={step}
              verdictFor={(event) => verdicts.get(rowOf(step.index, event))}
              missing={missing.get(step.index) ?? []}
              onMove={sequence.recording ? undefined : (event, kind, to) => move(event, kind, step.index, to)}
              crossed={(crossed.get(step.index) ?? []).filter(e => !activity.isHidden(e))}
              base={base}
              reading={reading}
              onRead={(id) => setReading(reading === id ? null : id)}
              ruleFor={ruleFor}
              actions={actions}
              stability={stability}
              pass={pass}
              pending={state.pending}
              writing={writingAt === step.index}
              first={step.index === 0}
              last={step.index === sequence.steps.length - 1}
              editing={editingAt?.step === step.index ? editingAt.field : null}
              onEdit={(field) => setEditingAt(field ? { step: step.index, field } : null)}
              sequences={(sequence.available ?? []).filter(name => name !== sequence.name)}
              allSteps={sequence.steps}
              post={post}
              onWrite={() => {
                setWritingAt(writingAt === step.index ? null : step.index);
                void post('/sequence/note', { step: step.index });
              }}
              onSave={async (words) => {
                await post('/save', { comment: words });
                setWritingAt(null);
              }}
              onDiscardPick={() => void post('/discard')}
              onDrop={(id) => void post('/annotation/delete', { id })}
            />
          ))}
        </ol>
      )}

      {/* What the newest pass produced after its last step ended, which no
          step held open for. A row moved up from here joins the last step,
          on the recording and on every run after. */}
      {sequence?.name && gutter.length > 0 && (
        <div class="gutter">
          <p class="gutterhead">after the last step</p>
          <ol class="crossedlist">
            {gutter.map(event => (
              <CrossingRow
                key={rowOf(stepCount, event)}
                event={event}
                base={base}
                rule={ruleFor(event)}
                repeats={repeatsOf.get(event)}
                open={reading === rowOf(stepCount, event)}
                onOpen={() => setReading(reading === rowOf(stepCount, event) ? null : rowOf(stepCount, event))}
                actions={actions}
                moves={stepCount > 0 && !sequence.busy
                  ? { up: () => move(event, kindOf(event), stepCount, stepCount - 1) }
                  : undefined}
              />
            ))}
          </ol>
        </div>
      )}

    </div>
  );
}

/**
 * What crossed under each step.
 *
 * The stamps decide which step owns a crossing, not a clock: a request takes
 * the cursor as it is issued, so a response completing after the next step
 * began still carries the step that caused it.
 *
 * A pass shows its own crossings and nothing else - a restart starts a pass,
 * and the reading it replaces was of a run that is over. What survives is what
 * carries a rule: that is staged work rather than a reading, and it stays in
 * place so it can be seen not firing. One row per kind per step, holding the
 * newest crossing of that kind.
 */
/**
 * The mark on a run control, drawn rather than named.
 *
 * Beside the app the bar has room for the marks and not for the words, so the
 * word gives way and the mark carries the control alone. Every button keeps a
 * title and an aria-label, which is what the mark on its own leaves to a
 * reader who does not see it.
 */



/**
 * What the run is carrying, and what it will carry once it gets there.
 *
 * A step's `{{var:...}}` reads from here, so a step that looks wrong is often
 * a value that is wrong - and the value is captured by a step, which is why
 * each one says where it came from.
 *
 * Setting one writes a step that captures it, so between setting and running
 * there is a name with no value. Shown as waiting rather than left out, since
 * a name that vanishes on being set reads as a control that did nothing.
 */
/**
 * What the sequence is for, what it should end up doing, and where it runs.
 *
 * Stated while recording and never editable afterwards, so a sequence whose
 * purpose was skipped or has since changed stayed wrong. Reading a sequence
 * someone else recorded starts here: the steps say what it does, and only this
 * says whether it did what it meant to.
 */
export function About({ sequence, post }: {
  sequence: SequenceState;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  // Seeded when the panel opens and held while it is typed. Bound straight to
  // the sequence, the 250ms poll would overwrite each box with what is on disk
  // between one keystroke and the next.
  const [what, setWhat] = useState('');
  const [end, setEnd] = useState('');
  const [where, setWhere] = useState('');

  const edit = () => {
    setWhat(sequence.description ?? '');
    setEnd(sequence.expectedOutcome ?? '');
    setWhere(sequence.baseUrl ?? '');
    setOpen(true);
  };

  const describe = () => void post('/sequence/describe', {
    description: what,
    expectedOutcome: end,
  });

  if (!open) {
    return (
      <div class="about">
        <div class="aboutline">
          <span class="abouttext">
            {sequence.description || <span class="quiet">no purpose recorded</span>}
          </span>
          <button class="varnew" onClick={edit}>edit</button>
        </div>
        {sequence.expectedOutcome && (
          <div class="aboutline">
            <span class="asklabel">expects</span>
            <span class="abouttext">{sequence.expectedOutcome}</span>
          </div>
        )}
        {sequence.issue && (
          <div class="aboutline">
            <span class="asklabel">reproduces</span>
            <span class="abouttext">#{sequence.issue.id} {sequence.issue.title}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="about open">
      <label class="asklabel" for="aboutwhat">what is this sequence for?</label>
      <textarea
        id="aboutwhat" class="why" rows={2}
        value={what}
        placeholder="drive the orders list to the state where saving hangs"
        onInput={(e: Event) => setWhat((e.target as HTMLTextAreaElement).value)}
        onBlur={describe}
      />
      <label class="asklabel" for="aboutend">what should be true when it ends?</label>
      <textarea
        id="aboutend" class="why" rows={2}
        value={end}
        placeholder="the pill reads Saved and the row shows the new total"
        onInput={(e: Event) => setEnd((e.target as HTMLTextAreaElement).value)}
        onBlur={describe}
      />
      <label class="asklabel" for="aboutbase">run it against</label>
      <input
        id="aboutbase" class="namebox"
        value={where}
        placeholder="http://localhost:3102 - leave empty to use the recorded host"
        onInput={(e: Event) => setWhere((e.target as HTMLInputElement).value)}
        onBlur={() => void post('/sequence/baseurl', { baseUrl: where })}
      />
      <div class="aboutfoot">
        <button class="chip-toggle" onClick={() => { setOpen(false); setSure(false); }}>Done</button>
        <span class="grow" />
        <button
          class={sure ? 'chip-toggle bad' : 'varnew'}
          onClick={() => {
            if (!sure) { setSure(true); return; }
            void post('/sequence/delete', { name: sequence.name });
            setOpen(false);
            setSure(false);
          }}
        >{sure ? 'Erase it from disk' : 'delete this sequence'}</button>
      </div>
    </div>
  );
}

/** The guards replay can evaluate at run time. */
const GUARDS = ['selector', 'url', 'cookie', 'localStorage', 'indexedDB'] as const;

/**
 * A step that runs another sequence when its guard holds.
 *
 * Replay executes this, where a note against a step is read by nobody: the
 * guard is evaluated against the live page and the named sequence runs in
 * place. What it takes is what is on screen - a guard and a target - so the
 * control states the mechanism by being it.
 */
function Fork({ step, steps, sequences, guarding, post, onDone }: {
  step: number;
  /** Every step of this run, for naming where the fork rejoins it. */
  steps: SequenceStep[];
  sequences: string[];
  /** The step this guard is protecting, when it was opened from a failure. */
  guarding?: SequenceStep;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  onDone: () => void;
}) {
  const [not, setNot] = useState(false);
  const [guard, setGuard] = useState<typeof GUARDS[number]>('selector');
  const [value, setValue] = useState('');
  const [then, setThen] = useState('');
  const [rejoin, setRejoin] = useState('');

  const condition = `{{${not ? '!' : ''}${guard}:${value}}}`;
  const ready = value.trim().length > 0 && then.length > 0;
  // Every step after the one this lands on, which is the only place a run can
  // resume: replay goes forward, so a rejoin behind it would re-run this step.
  const landings = steps.filter(s => s.index > step);

  return (
    <div class={guarding ? 'fork guarding' : 'fork'}>
      {guarding && (
        <span class="asklabel wide">before step {guarding.index + 1}</span>
      )}
      <span class="asklabel">when</span>
      <button
        class={not ? 'tool bad' : 'tool'}
        title={not ? 'when it is absent' : 'when it is present'}
        onClick={() => setNot(!not)}
      >{not ? 'not' : 'is'}</button>
      <select class="seqpick narrow" value={guard}
        onChange={(e: Event) => setGuard((e.target as HTMLSelectElement).value as typeof GUARDS[number])}>
        {GUARDS.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <input
        class="namebox grow"
        value={value}
        placeholder={guard === 'selector' ? '.cookie-banner' : guard === 'url' ? 'matches:/orders/\\d+' : 'token'}
        onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
      />
      <span class="asklabel">run</span>
      <select class="seqpick" value={then}
        onChange={(e: Event) => setThen((e.target as HTMLSelectElement).value)}>
        <option value="">which sequence</option>
        {sequences.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <span class="asklabel">then</span>
      <select class="seqpick" value={rejoin}
        onChange={(e: Event) => setRejoin((e.target as HTMLSelectElement).value)}>
        <option value="">carry on from here</option>
        {landings.map(s => (
          <option key={s.index} value={String(s.index)}>
            skip to step {s.index + 1} · {s.label.slice(0, 34)}
          </option>
        ))}
      </select>
      <button
        class="save"
        disabled={!ready}
        onClick={() => {
          void post('/sequence/step/conditional', {
            step,
            condition,
            thenSequence: then,
            ...(rejoin === '' ? {} : { rejoinAt: Number(rejoin) }),
          });
          onDone();
        }}
      >Add</button>
    </div>
  );
}

export function Variables({ variables, steps, post }: {
  variables: SequenceVariable[];
  steps: SequenceStep[];
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const add = async () => {
    const named = name.trim();
    if (!named) return;
    await post('/sequence/var/set', { name: named, value });
    setName('');
    setValue('');
    setAdding(false);
  };

  const carried = new Set(variables.map(variable => variable.name));
  const waiting = steps
    .filter(step => step.captures && !carried.has(step.captures))
    .map(step => ({ name: step.captures as string, step: step.index + 1 }));

  return (
    <div class="vars">
      <span class="varslabel">carrying</span>
      {variables.length === 0 && waiting.length === 0 && !adding && (
        <span class="hint">nothing yet</span>
      )}
      {variables.map(variable => (
        <span
          class={open === variable.name ? 'var open' : 'var'}
          key={variable.name}
          onClick={() => setOpen(open === variable.name ? null : variable.name)}
          title={`from ${variable.source}`}
        >
          <b>{variable.name}</b>
          <span class="varvalue">{variable.value}</span>
          <span class="varfrom">{variable.source}</span>
          <button
            class="drop"
            title="stop carrying this"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              void post('/sequence/var/remove', { name: variable.name });
            }}
          >×</button>
          {open === variable.name && variable.fields && (
            <span class="varfields">
              {variable.fields.map(field => (
                <span class="varfield" key={field.key}>
                  <span class="quiet">{field.key}</span> {field.value}
                </span>
              ))}
            </span>
          )}
        </span>
      ))}
      {waiting.map(pending => (
        <span class="var waiting" key={pending.name} title={`step ${pending.step} captures this when it runs`}>
          <b>{pending.name}</b>
          <span class="varfrom">step {pending.step}, not run yet</span>
        </span>
      ))}
      {adding
        ? <span class="varadd">
            <input
              class="vname"
              placeholder="name"
              value={name}
              autoFocus
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void add(); }}
            />
            <input
              class="vvalue"
              placeholder="value"
              value={value}
              onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void add(); }}
            />
            <button class="chip-toggle" onClick={() => void add()}>Set</button>
            <button class="drop" title="cancel" onClick={() => setAdding(false)}>×</button>
          </span>
        : <button class="varnew" onClick={() => setAdding(true)}>+ set one</button>}
    </div>
  );
}

/**
 * Walking a held page forward.
 *
 * A hold on its own only stops time; what it is for is stepping into a state
 * that exists for 300ms. The controls appear with the hold and go with it,
 * because ticking a running page means nothing.
 *
 * The callbacks are the record of what each step actually ran, which is how a
 * transient state is told from a timer that happened to fire beside it.
 */
export function Held({ state, post }: {
  state: BenchView;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [ms, setMs] = useState(100);
  const recent = state.callbacks.slice(-8).reverse();

  return (
    <div class="held">
      <div class="tickbar">
        <span class="quiet">held at</span>
        <b>{state.tickMs}ms</b>
        <span class="quiet">{state.totalSteps} callback{state.totalSteps === 1 ? '' : 's'} run</span>
        <span class="rule" />
        <button class="chip-toggle" onClick={() => void post('/tick', { steps: 1 })}>+1 callback</button>
        <button class="chip-toggle" onClick={() => void post('/tick', { steps: 10 })}>+10</button>
        <span class="rule" />
        <input
          class="msin"
          type="number"
          min={1}
          step={50}
          value={ms}
          onInput={(e: Event) => setMs(Number((e.target as HTMLInputElement).value) || 1)}
        />
        <button class="chip-toggle" onClick={() => void post('/tick', { budgetMs: ms })}>Run that long</button>
      </div>
      {state.lastTick && (
        <p class="hint ticksaid">
          last step ran {state.lastTick.steps} callback{state.lastTick.steps === 1 ? '' : 's'}
          {' '}over {state.lastTick.actualMs}ms
          {state.lastTick.requestedMs !== undefined
            ? ` - ${state.lastTick.requestedMs}ms was asked for, and a step lands where the page's own work lands`
            : ''}
        </p>
      )}
      {recent.length > 0 && (
        <ol class="callbacks">
          {recent.map(entry => (
            <li key={entry.index}>
              <span class="num">{entry.index}</span>
              <span class="when">+{entry.at}ms</span>
              <span class="kind">{entry.kind ?? 'callback'}</span>
              <span class="fn">{entry.fn ?? '(anonymous)'}</span>
              {entry.url && (
                <span class="where" title={entry.url}>
                  {entry.url.split('/').pop()}{entry.line ? `:${entry.line}` : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One step: what was driven, what has been written against it, and the box for
 * writing more.
 *
 * The composer opens inside the step rather than above the list, because a
 * note is about a step and a box that floats somewhere else has to explain
 * which one it means.
 */
function StepRow({
  step, crossed, verdictFor, missing, onMove, base, reading, onRead, ruleFor, actions, stability, pass, pending,
  writing, first, last, editing, onEdit, sequences, allSteps, post, onWrite, onSave,
  onDiscardPick, onDrop,
}: {
  step: SequenceStep;
  /** What the proxy saw cross under this step on the newest pass. */
  crossed: BoundaryEvent[];
  base: string;
  /** A row of the latest replay against the recording of its kind on this step. */
  verdictFor: (event: BoundaryEvent) => RowVerdict | undefined;
  /** Kinds recorded on this step that the latest replay did not produce. */
  missing: Array<{ kind: string; verdict: RowVerdict }>;
  /** Move a kind to another step; absent while nothing can be moved, as during a recording. */
  onMove?: (event: BoundaryEvent | undefined, kind: string, to: number) => void;
  /** The one traffic row open for reading, by `rowOf`. */
  reading: string | null;
  onRead: (id: string) => void;
  /** The decision standing against one event's kind, when there is one. */
  ruleFor: (event: BoundaryEvent) => BoundaryRule | undefined;
  actions: RuleActions;
  /** How many passes each kind crossed in, of those still held. */
  stability: Map<string, { in: number; runs: number }>;
  /** The pass being read, so a row held over from an older one says so. */
  pass: string | undefined;
  /** Other sequences this one can hand off to at a guard. */
  sequences: string[];
  /** The whole run, for naming where a fork rejoins it. */
  allSteps: SequenceStep[];
  pending: { tag: string; selector: string; text?: string } | null;
  writing: boolean;
  first: boolean;
  last: boolean;
  editing: 'why' | 'fork' | null;
  onEdit: (field: 'why' | 'fork' | null) => void;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  onWrite: () => void;
  onSave: (words: string) => void;
  onDiscardPick: () => void;
  onDrop: (id: string) => void;
}) {
  const [sure, setSure] = useState(false);
  // Held locally while it is typed. Bound straight to the step, every poll
  // 250ms apart would overwrite the box with what is on disk, so nothing
  // longer than a quarter of a second could be written into it.
  const [said, setSaid] = useState('');
  const [words, setWords] = useState('');
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (writing) box.current?.focus(); }, [writing]);

  const notes = step.annotations ?? [];
  const classes = [
    'step',
    step.current ? 'now' : '',
    step.done ? 'done' : '',
    step.failed ? 'failed' : '',
    writing ? 'writing' : '',
  ].filter(Boolean).join(' ');

  const save = () => {
    onSave(words);
    setWords('');
  };

  return (
    <li class={classes}>
      <div class="stephead">
        <span class="num">{step.index + 1}</span>
        <span class="label" title={step.resolved ?? step.label}>
          <span class="wide">{step.resolved ?? step.label}</span>
          <span class="lean">{lean(step.resolved ?? step.label)}</span>
        </span>
        {step.captures && <span class="captures">→ {step.captures}</span>}
        {notes.length > 0 && !writing && <span class="tally">{notes.length}</span>}
        <div class="stepedit">
          <button class="write" onClick={onWrite}>{writing ? 'close' : 'note'}</button>
          <button class="tool" title="why this step is here"
            onClick={() => {
              setSaid(step.comment ?? '');
              onEdit(editing === 'why' ? null : 'why');
            }}>
            {step.comment ? 'why ✓' : 'why'}
          </button>
          <button class="tool" title="run another sequence here when a guard holds"
            onClick={() => onEdit(editing === 'fork' ? null : 'fork')}>
            fork
          </button>
          <button class="tool" disabled={first} title="run this step sooner"
            onClick={() => void post('/sequence/step/move', { from: step.index, to: step.index - 1 })}>↑</button>
          <button class="tool" disabled={last} title="run this step later"
            onClick={() => void post('/sequence/step/move', { from: step.index, to: step.index + 1 })}>↓</button>
          <button class={sure ? 'tool bad' : 'tool'} title="take this step out of the run"
            onClick={() => {
              if (!sure) { setSure(true); return; }
              void post('/sequence/step/remove', { index: step.index });
              setSure(false);
            }}>{sure ? 'sure?' : 'remove'}</button>
        </div>
      </div>

      {(crossed.length > 0 || missing.length > 0) && (
        <ol class="crossedlist">
          {crossed.map(event => (
            <CrossingRow
              // By row, so an arrival that replaces the row's event does not
              // remount it and drop an edit in progress.
              key={rowOf(step.index, event)}
              event={event}
              base={base}
              rule={ruleFor(event)}
              repeats={repeatsOf.get(event)}
              seen={stability.get(keyOf(event))}
              stale={event.runId !== pass && originOf.get(event) !== 'after'}
              open={reading === rowOf(step.index, event)}
              onOpen={() => onRead(rowOf(step.index, event))}
              actions={{ ...actions, waitFor: actions.waitFor, waitStep: step.index }}
              verdict={verdictFor(event)}
              moves={onMove && {
                ...(first ? {} : { up: () => onMove(event, kindOf(event), step.index - 1) }),
                down: () => onMove(event, kindOf(event), step.index + 1),
              }}
            />
          ))}
          {missing.map(({ kind, verdict }) => (
            <MissingRow
              key={`${step.index}|missing|${kind}`}
              kind={kind}
              verdict={verdict}
              open={reading === `${step.index}|missing|${kind}`}
              onOpen={() => onRead(`${step.index}|missing|${kind}`)}
              moves={onMove && {
                ...(first ? {} : { up: () => onMove(undefined, kind, step.index - 1) }),
                ...(last ? {} : { down: () => onMove(undefined, kind, step.index + 1) }),
              }}
            />
          ))}
        </ol>
      )}

      {step.comment && editing !== 'why' && <p class="stepwhat">{step.comment}</p>}

      {editing === 'fork' && (
        <Fork
          step={step.index}
          steps={allSteps}
          sequences={sequences}
          post={post}
          onDone={() => onEdit(null)}
        />
      )}

      {editing === 'why' && (
        <div class="stepedbox">
          <textarea
            class="why" rows={2}
            value={said}
            placeholder="what is this step for?"
            onInput={(e: Event) => setSaid((e.target as HTMLTextAreaElement).value)}
          />
          <button
            class="save"
            onClick={() => {
              void post('/sequence/step/comment', { step: step.index, words: said });
              onEdit(null);
            }}
          >Save</button>
        </div>
      )}

      {notes.map(note => (
        <div
          class="note"
          key={note.id}
          onMouseEnter={() => note.target && void post('/annotation/highlight', { selector: note.target.selector })}
          onMouseLeave={() => note.target && void post('/annotation/highlight', { selector: '' })}
        >
          <span class="notewords">{note.comment}</span>
          {note.target && (
            <span class="notewhere" title={note.target.selector}>{note.target.selector}</span>
          )}
          <button class="tool" title="hand this finding to the agent"
            onClick={() => void post('/annotation/notify', { id: note.id })}>send</button>
          <button class="drop" title="remove this note" onClick={() => onDrop(note.id)}>×</button>
        </div>
      ))}

      {writing && (
        <div class="composer">
          {pending
            ? <div class="picked">
                <span class="tag">{pending.tag}</span>
                <span class="selector">{pending.selector}</span>
                <button class="drop" title="write about the step instead" onClick={onDiscardPick}>×</button>
              </div>
            : <p class="hint">about this step. Arm the picker and click the app to point at an element.</p>}
          <textarea
            class="why"
            rows={3}
            ref={box as any}
            value={words}
            placeholder="what did you see?"
            onInput={(e: Event) => setWords((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
          />
          <div class="composerfoot">
            <button class="save" onClick={save}>Save the note</button>
            <span class="hint grow">⌘↵</span>
          </div>
        </div>
      )}
    </li>
  );
}
