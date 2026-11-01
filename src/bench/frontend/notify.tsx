/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useEscape } from './escape.js';

/**
 * Words for the session, sent with the bench as it stands at Send: the tab
 * and what is open on it, the step a sequence rests on, the layers held.
 * The state is read at Send rather than at open, so a change made while
 * typing goes with the words.
 */
export function NotifyDialog({ base, view, onClose }: {
  base: string;
  /** The tab and what is open on it, read when Send is pressed. */
  view: () => Record<string, string>;
  onClose: () => void;
}) {
  const [words, setWords] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  useEscape(true, onClose);
  const ready = words.trim().length > 0 && !sending;

  const send = async () => {
    if (!ready) return;
    setSending(true);
    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: words.trim(), view: view() }),
    }).catch(() => null);
    setSending(false);
    if (!res?.ok) { setFailure(res ? `the session refused it: ${res.status}` : 'the session could not be reached'); return; }
    onClose();
  };

  return (
    <div class="scrim savescrim">
      <form class="report savedialog" role="dialog" aria-label="notify the session"
        onSubmit={(e: Event) => { e.preventDefault(); void send(); }}>
        <h2>notify the session</h2>
        <p class="hint">The words go to the session with the bench as it stands when you press Send.</p>
        {failure && <p class="hint savefail">{failure}</p>}
        <textarea id="notifywords" ref={box} class="why" rows={4} value={words}
          placeholder="the total on step 3 is wrong - look at the orders response"
          onInput={(e: Event) => setWords((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          }} />
        <div class="saveacts">
          <button class="cancel" type="button" onClick={onClose}>Cancel</button>
          <button class="save go" type="submit" disabled={!ready}>{sending ? 'sending…' : 'Send'}</button>
        </div>
      </form>
    </div>
  );
}
