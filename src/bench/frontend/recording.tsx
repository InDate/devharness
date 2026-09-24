/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BenchView, HeldStep, SequenceStep } from '../wire.js';

const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * Recording a sequence.
 *
 * The steps land on their own as the app is driven; what only the person doing
 * it can supply is why. So the page asks for the purpose before the first
 * click, and against each step offers the two things that are known at the
 * moment it is taken: what it is for, and whether the run could have gone
 * another way here.
 */
export function Recording({ base, onCancel }: {
  base: string;
  /** Leave the form without recording. Absent where nothing is behind it. */
  onCancel?: () => void;
}): preact.JSX.Element {
  const [state, setState] = useState<BenchView | null>(null);
  const [ended, setEnded] = useState(false);
  const [name, setName] = useState('');
  // Held from the moment the form opens: bound to the poll it would be
  // rewritten between one keystroke and the next by the page's own URL.
  const [where, setWhere] = useState<string | null>(null);

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

  if (ended) return <p class="hint">the bench has been closed on this connection</p>;
  if (!state) return <p class="hint">reading the session…</p>;

  const sequence = state.sequence;
  const recording = sequence?.recording === true;
  const steps = sequence?.steps ?? [];

  if (!recording) {
    return (
      <Start
        name={name}
        onName={setName}
        startUrl={where ?? state.pageUrl ?? ''}
        onStartUrl={setWhere}
        onStart={(withAgent) => void post('/sequence/record', {
          name: name.trim(),
          startUrl: (where ?? state.pageUrl ?? '').trim(),
          ...(withAgent ? { withAgent } : {}),
        })}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div class="recorder">
      <div class="topbar">
        <span class="recname">{sequence?.name}</span>
        <span class="recdot" title="recording" />
        <span class="quiet">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
        {sequence?.withAgent && <span class="watching">agent reading each step</span>}
        <span class="grow" />
        <button class="chip-toggle" onClick={() => void post('/sequence/record/cancel')}>
          THROW IT AWAY
        </button>
        <button class="save" onClick={() => void post('/sequence/record/stop')}>
          STOP AND KEEP
        </button>
      </div>

      <Purpose
        description={sequence?.description ?? ''}
        expected={sequence?.expectedOutcome ?? ''}
        onSave={(description, expectedOutcome) =>
          void post('/sequence/describe', { description, expectedOutcome })}
      />

      {sequence?.pendingStep && (
        <Held
          held={sequence.pendingStep}
          onChoose={(index) => void post('/sequence/record/choose', { index })}
          onKeep={() => void post('/sequence/record/keep')}
          onDrop={() => void post('/sequence/record/drop')}
        />
      )}

      <ol class="taken">
        {steps.map(step => (
          <Taken
            key={step.index}
            step={step}
            onComment={(words) => void post('/sequence/step/comment', { step: step.index, words })}
          />
        ))}
      </ol>

      {steps.length === 0 && (
        <p class="hint nothing">
          nothing taken yet. Drive the app in the other tab and the steps land here.
        </p>
      )}
    </div>
  );
}

/**
 * Naming the sequence and choosing who watches it.
 *
 * One field and one button: the two ways to record differ only in whether the
 * agent reads each step, so that is a choice beside the field rather than a
 * second button competing with the first.
 */
function Start({ name, onName, startUrl, onStartUrl, onStart, onCancel }: {
  name: string;
  onName: (name: string) => void;
  /** Where the recording opens, seeded with the page being driven. */
  startUrl: string;
  onStartUrl: (url: string) => void;
  onStart: (withAgent: boolean) => void;
  /** Leave without recording, where there is a screen to go back to. */
  onCancel?: () => void;
}) {
  const [withAgent, setWithAgent] = useState(false);
  const ready = name.trim().length > 0;

  return (
    <div class="recorder">
      <form
        class="startbox"
        onSubmit={(e: Event) => { e.preventDefault(); if (ready) onStart(withAgent); }}
      >
        <h2>record a sequence</h2>
        <p class="lede">
          Drive the app as you normally would. Every click and keystroke lands here as a step.
        </p>

        <label class="asklabel" for="recname">name it</label>
        <input
          id="recname"
          class="namebox"
          placeholder="three words is plenty"
          value={name}
          onInput={(e: Event) => onName((e.target as HTMLInputElement).value)}
        />

        {/* The page the run starts on, driven to before the first step is
            taken. Seeded with the one already open, which is where someone
            recording from here almost always means to begin. */}
        <label class="asklabel" for="recwhere">start it on</label>
        <input
          id="recwhere"
          class="namebox"
          placeholder="http://localhost:3000/"
          value={startUrl}
          onInput={(e: Event) => onStartUrl((e.target as HTMLInputElement).value)}
        />

        <fieldset class="whowatches">
          <legend class="asklabel">who is watching</legend>
          <Choice
            on={!withAgent}
            onPick={() => setWithAgent(false)}
            title="just me"
            said="Steps land as you take them. Nothing interrupts the run."
          />
          <Choice
            on={withAgent}
            onPick={() => setWithAgent(true)}
            title="the agent, step by step"
            said={'Each step is held as it lands — the page freezes, capture pauses — while the '
              + 'agent reads it, and it offers a selector to swap in where the recorded one would '
              + 'not survive a second run.'}
          />
        </fieldset>

        <button class="save go" type="submit" disabled={!ready}>
          {withAgent ? 'START WITH THE AGENT' : 'START RECORDING'}
        </button>
        {/* Under the button it undoes, and quiet: leaving is the lesser of
            the two things to do from here. */}
        {onCancel && (
          <button class="cancel" type="button" onClick={onCancel}>CANCEL</button>
        )}
      </form>
    </div>
  );
}

/** One of the two ways to record, with what it costs stated under it. */
function Choice({ on, onPick, title, said }: {
  on: boolean;
  onPick: () => void;
  title: string;
  said: string;
}) {
  return (
    <button type="button" class={on ? 'choice on' : 'choice'} onClick={onPick}>
      <span class="pip" />
      <span class="choicebody">
        <span class="choicetitle">{title}</span>
        <span class="choicesaid">{said}</span>
      </span>
    </button>
  );
}

/**
 * What the sequence is for, and what it should end up doing.
 *
 * Asked at the top and kept editable: the purpose is usually clear before the
 * first click, and the expectation often only once the last one lands.
 */
function Purpose({ description, expected, onSave }: {
  description: string;
  expected: string;
  onSave: (description: string, expected: string) => void;
}) {
  const [what, setWhat] = useState(description);
  const [end, setEnd] = useState(expected);
  const held = useRef({ description, expected });
  const whatBox = useRef<HTMLTextAreaElement>(null);
  const endBox = useRef<HTMLTextAreaElement>(null);

  // Another pane may have written these; take theirs unless this one is mid-edit.
  useEffect(() => {
    if (held.current.description !== description) {
      held.current.description = description;
      setWhat(description);
    }
    if (held.current.expected !== expected) {
      held.current.expected = expected;
      setEnd(expected);
    }
  }, [description, expected]);

  // Read off the boxes rather than the state behind them: a blur that arrives
  // before the input it followed has re-rendered carries the previous value,
  // and the words typed into the other box are dropped without a trace.
  const save = () => {
    const nowWhat = whatBox.current?.value ?? what;
    const nowEnd = endBox.current?.value ?? end;
    held.current = { description: nowWhat, expected: nowEnd };
    onSave(nowWhat, nowEnd);
  };

  return (
    <div class="purpose">
      <label class="asklabel" for="recwhat">what is this sequence for?</label>
      <textarea
        id="recwhat"
        ref={whatBox}
        class="why"
        rows={2}
        value={what}
        placeholder="drive the orders list to the state where saving hangs"
        onInput={(e: Event) => setWhat((e.target as HTMLTextAreaElement).value)}
        onBlur={save}
      />
      <label class="asklabel" for="recend">what should be true when it ends?</label>
      <textarea
        id="recend"
        ref={endBox}
        class="why"
        rows={2}
        value={end}
        placeholder="the pill reads Saved and the row shows the new total"
        onInput={(e: Event) => setEnd((e.target as HTMLTextAreaElement).value)}
        onBlur={save}
      />
    </div>
  );
}

/**
 * A step held while the agent reads it.
 *
 * Two states, and they are not the same thing to look at: while it is being
 * read there is nothing to answer, so the panel offers no action and says so;
 * once it is flagged the reason stands at the top, any selector it found is a
 * row to click, and keeping or dropping the step ends the hold.
 */
function Held({ held, onChoose, onKeep, onDrop }: {
  held: HeldStep;
  onChoose: (index: number) => void;
  onKeep: () => void;
  onDrop: () => void;
}) {
  const flagged = held.verdict === 'flagged';
  return (
    <div class={flagged ? 'held flagged' : 'held'}>
      <div class="heldhead">
        {flagged ? (held.reason ?? held.label) : 'the agent is reading this step…'}
      </div>
      {!flagged && <p class="hint">the page is held while it reads. Nothing to do here yet.</p>}
      {flagged && held.detail && <div class="helddetail">{held.detail}</div>}
      {flagged && held.label !== held.reason && <div class="heldlabel">{held.label}</div>}

      {(held.options ?? []).map((option, index) => (
        <button key={option.selector} class="optrow" onClick={() => onChoose(index)}>
          <span class="optsel">{option.selector}</span>
          <span class="optnote">{option.note}</span>
        </button>
      ))}

      {flagged && (
        <div class="heldacts">
          <button class="chip-toggle" onClick={onDrop}>DROP STEP</button>
          <button class="save" onClick={onKeep}>KEEP AS RECORDED</button>
        </div>
      )}
    </div>
  );
}

/**
 * One step as it lands, with the one thing only the recorder knows.
 *
 * Why the step is there, and nothing else. A step is a projection of the
 * page's captured events - removing one means rewinding that buffer, which is
 * what the held-step DROP does - so there is no per-step remove here, and a
 * guard belongs on a saved sequence where replay can evaluate it.
 */
function Taken({ step, onComment }: {
  step: SequenceStep;
  onComment: (words: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState(step.comment ?? '');

  return (
    <li class="took">
      <div class="tookhead">
        <span class="num">{step.index + 1}</span>
        <span class="label">{step.label}</span>
        <span class="grow" />
        <button class="tool" onClick={() => setOpen(!open)}>
          {step.comment ? 'why ✓' : 'why'}
        </button>
      </div>

      {step.comment && !open && <p class="tookwhat">{step.comment}</p>}

      {open && (
        <div class="tookedit">
          <textarea
            class="why"
            rows={2}
            value={words}
            placeholder="what is this step for?"
            onInput={(e: Event) => setWords((e.target as HTMLTextAreaElement).value)}
          />
          <button class="save" onClick={() => { onComment(words); setOpen(false); }}>SAVE</button>
        </div>
      )}
    </li>
  );
}
