/** @jsxImportSource preact */
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Draft } from './markup.js';
import { Held } from './sequence.js';
import type {
  Annotation, BenchView, SequenceCard, SequenceStep,
} from '../wire.js';

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
export function Editing({ base }: { base: string }): preact.JSX.Element {
  const [state, setState] = useState<BenchView | null>(null);
  const [ended, setEnded] = useState(false);
  const [writingAt, setWritingAt] = useState<number | null>(null);

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

  const keep = async (marked: string, words: string) => {
    await post('/shot/save', { marked });
    await post('/save', { comment: words });
  };

  return (
    <div class="editing">

      {sequence?.failure && (
        <div class="failure">
          <span class="bad grow">{sequence.failure}</span>
          <button class="chip-toggle" onClick={() => void post('/sequence/failure/dismiss')}>
            DISMISS
          </button>
        </div>
      )}

      {state.frozen && <Held state={state} post={post} />}

      {/* One column, read top to bottom: the run's steps as quiet markers, and
          under each the findings taken while standing there. A sidecar beside
          it would put the place and the finding in two columns the eye has to
          join up. */}
      <main class="reel">
        {/* A capture or a pick taken with no step standing - nothing selected,
            or the run finished - leads the column. Placed after the catalogue
            it would sit below every tile, off the bottom of the screen, which
            reads as the capture having failed. */}
        {state.shot && !steps.some(step => step.current) && (
          <Draft
            shot={state.shot}
            picked={state.pending}
            onSave={(marked, words) => void keep(marked, words)}
            onDiscard={() => void post('/shot/discard')}
            onDropPick={() => void post('/discard')}
            onWiden={(widen) => void post('/shot', { selector: state.shot!.selector, widen })}
            steps={steps}
            filedAt={target}
            onStep={(step) => void post('/sequence/note', { step })}
          />
        )}

        {!state.shot && state.pending && !steps.some(step => step.current) && (
          <Picked
            picked={state.pending}
            onSave={(words) => void post('/save', { comment: words })}
            onShoot={() => void post('/shot', { selector: state.pending!.selector })}
            onDrop={() => void post('/discard')}
          />
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

        {steps.map(step => (
          <Fragment key={step.index}>
            <div
              class={['mark', step.current ? 'here' : '', step.failed ? 'failed' : ''].filter(Boolean).join(' ')}
              onClick={() => void post('/sequence/goto', { step: step.index })}
              title="run to here"
            >
              <span class="marktext">
                step {step.index + 1} · {step.label}
                {step.current ? ' · standing here' : ''}
              </span>
              <button
                class="marknote"
                title="write a finding against this step"
                onClick={(e: Event) => {
                  e.stopPropagation();
                  const open = writingAt === step.index;
                  setWritingAt(open ? null : step.index);
                  if (!open) void post('/sequence/note', { step: step.index });
                }}
              >{writingAt === step.index ? 'close' : 'note'}</button>
            </div>

            {(step.annotations ?? []).map(note => (
              <Finding
                key={note.id}
                note={note}
                base={base}
                post={post}
                at={step.index}
                steps={steps}
              />
            ))}

            {step.current && state.shot && (
              <Draft
                shot={state.shot}
                picked={state.pending}
                onSave={(marked, words) => void keep(marked, words)}
                onDiscard={() => void post('/shot/discard')}
                onDropPick={() => void post('/discard')}
                onWiden={(widen) => void post('/shot', { selector: state.shot!.selector, widen })}
                steps={steps}
                filedAt={target}
                onStep={(chosen) => void post('/sequence/note', { step: chosen })}
              />
            )}

            {writingAt === step.index && !state.shot && (
              <Picked
                picked={state.pending}
                onSave={async (words) => {
                  await post('/save', { comment: words });
                  setWritingAt(null);
                }}
                onShoot={() => void post('/shot', { selector: state.pending!.selector })}
                onDrop={() => void post('/discard')}
              />
            )}
          </Fragment>
        ))}

        {sequence?.name && findings.length === 0 && !state.shot && !state.pending && (
          <p class="hint nothing">
            nothing kept yet. Walk to the state that is wrong, hold it, capture it, and draw on
            what you see.
          </p>
        )}
      </main>
    </div>
  );
}

/**
 * An element pointed at, with nothing captured beside it.
 *
 * The pick is the start of a note, so the box to write it opens where the
 * finding will sit rather than waiting to be found somewhere else. Saving
 * sends only the words: the picked element is already held against the
 * session, and /save attaches it.
 */
function Picked({ picked, onSave, onShoot, onDrop }: {
  picked?: { tag: string; selector: string; text?: string } | null;
  onSave: (words: string) => void;
  onShoot: () => void;
  onDrop: () => void;
}) {
  const [words, setWords] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { box.current?.focus(); }, []);

  return (
    <article class="draft">
      {picked
        ? <>
            <div class="picked">
              <span class="tag">{picked.tag}</span>
              <span class="selector">{picked.selector}</span>
              <button class="drop" title="drop this pick" onClick={onDrop}>×</button>
            </div>
            {picked.text && <p class="pickedtext">{picked.text}</p>}
          </>
        : <p class="hint">about this step. Arm PICKER and click the app to point at an element.</p>}
      <textarea
        class="why"
        rows={2}
        ref={box}
        value={words}
        placeholder="what's wrong with it?"
        onInput={(e: Event) => setWords((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(words);
        }}
      />
      <div class="draftfoot">
        <button class="save" onClick={() => onSave(words)}>SAVE</button>
        {picked && <button class="tool" onClick={onShoot}>CAPTURE IT</button>}
        <span class="hint grow">
          {picked ? 'capture crops to the element, and widens from there' : ''}
        </span>
        <span class="hint">⌘↵</span>
      </div>
    </article>
  );
}

function Finding({ note, base, post, at, steps }: {
  note: Annotation;
  base: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  /** The step this note is filed against. */
  at: number;
  steps: SequenceStep[];
}) {
  /** The capture being read at full size, by its path. */
  const [open, setOpen] = useState<string | null>(null);

  return (
    <article class="finding">
      <div class="findinghead">
        <span class="findingat">+{note.tick}ms</span>
        <span class="grow" />
        <button class="tool" onClick={() => void post('/annotation/notify', { id: note.id })}>
          send to the session
        </button>
        {/* A note is stored in the step it belongs to, so one filed against
            the wrong step is wrong in the file. Carried whole rather than
            erased and taken again, which would lose the capture with it. */}
        <select
          class="movenote"
          title="the step this note is filed against"
          value={String(at)}
          onChange={(e: Event) => {
            const step = Number((e.target as HTMLSelectElement).value);
            if (step !== at) void post('/annotation/move', { id: note.id, step });
          }}
        >
          {steps.map(step => (
            <option key={step.index} value={String(step.index)}>
              step {step.index + 1}{step.label ? ` · ${step.label}` : ''}
            </option>
          ))}
        </select>
        <button class="tool" onClick={() => void post('/annotation/delete', { id: note.id })}>
          remove
        </button>
      </div>
      {/* The picture beside the words, not under them: a finding is read as
          one thing, and a full-width image between two of them buries the
          next. Opened, it takes the screen at the size it was captured. */}
      <div class="findingbody">
        {(note.screenshots ?? []).length > 0 && (
          <div class="findingshots">
            {(note.screenshots ?? []).map(path => (
              <button
                class="thumb"
                key={path}
                title="open it"
                onClick={() => setOpen(path)}
              >
                <img src={`${base}/shot/img?p=${encodeURIComponent(path)}`} alt={note.comment} />
              </button>
            ))}
          </div>
        )}
        <div class="findingtext">
          <p class="findingwords">{note.comment}</p>
          {note.target && <p class="findingwhere">{note.target.selector}</p>}
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
    </article>
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
