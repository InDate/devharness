/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useEscape } from './escape.js';

/**
 * Saving an unsaved sequence: the name it is written under, what it is for,
 * and what should be true at its end. Asked here rather than before the
 * recording, once the steps it names exist.
 */
export function SaveDialog({ name, description, expectedOutcome, failure, post, onClose }: {
  /** The name it holds in memory, `untitled-1` and the like, offered as the start. */
  name: string;
  description?: string;
  expectedOutcome?: string;
  /** The last save's refusal, such as a name already taken. */
  failure?: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [as, setAs] = useState(/^untitled-\d+$/.test(name) ? '' : name);
  const [what, setWhat] = useState(description ?? '');
  const [end, setEnd] = useState(expectedOutcome ?? '');
  const [saving, setSaving] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => { nameBox.current?.focus(); }, []);
  useEscape(true, onClose);
  const ready = as.trim().length > 0 && !saving;

  return (
    <div class="scrim savescrim">
      <form class="report savedialog" role="dialog" aria-label="save sequence"
        onSubmit={async (e: Event) => {
          e.preventDefault();
          if (!ready) return;
          setSaving(true);
          await post('/sequence/save', { name: as.trim(), description: what.trim(), expectedOutcome: end.trim() });
          setSaving(false);
          onClose();
        }}>
        <h2>save the sequence</h2>
        <p class="hint">Until it is saved it lives in memory, and a devharness restart loses it.</p>
        {failure && <p class="hint savefail">{failure}</p>}

        <label class="asklabel" for="savename">name it</label>
        <input id="savename" ref={nameBox} class="namebox" placeholder="three words is plenty"
          value={as} onInput={(e: Event) => setAs((e.target as HTMLInputElement).value)} />

        <label class="asklabel" for="savewhat">what is this sequence for? <span class="quiet">optional</span></label>
        <textarea id="savewhat" class="why" rows={2} value={what}
          placeholder="drive the orders list to the state where saving hangs"
          onInput={(e: Event) => setWhat((e.target as HTMLTextAreaElement).value)} />

        <label class="asklabel" for="saveend">what should be true when it ends? <span class="quiet">optional</span></label>
        <textarea id="saveend" class="why" rows={2} value={end}
          placeholder="the pill reads Saved and the row shows the new total"
          onInput={(e: Event) => setEnd((e.target as HTMLTextAreaElement).value)} />

        <div class="saveacts">
          <button class="cancel" type="button" onClick={onClose}>Cancel</button>
          <button class="save go" type="submit" disabled={!ready}>{saving ? 'saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
