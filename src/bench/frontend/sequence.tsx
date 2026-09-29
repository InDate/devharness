/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import type { HeldLayerView, SequenceState } from '../wire.js';

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

export const LAYER_WORDS: Record<HeldLayerView['layer'], string> = { code: 'code', ui: 'screen', network: 'traffic' };

/** Which layers stand still and what holds each: "code, screen and traffic held by the bench". */
export function heldWords(held: HeldLayerView[]): string {
  if (held.length === 0) return 'nothing held';
  const bySource = new Map<string, string[]>();
  for (const layer of held) {
    const words = bySource.get(layer.source) ?? [];
    words.push(LAYER_WORDS[layer.layer]);
    bySource.set(layer.source, words);
  }
  return [...bySource].map(([source, words]) => {
    const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
    return `${list} held by the ${source}`;
  }).join(' · ');
}

/** How long a crossing has waited, in the unit that keeps it short. */
export function waited(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
