/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** The proxied connection's name: the bench connection's with `proxied` as a fourth word. */
function proxiedNameOf(connection: string): string {
  return connection ? `${connection}-proxied` : '';
}

/**
 * Enable proxy, with the name the proxied connection takes. Pressing it opens
 * a proxied window in this browser's Chrome at this page, with this
 * connection's cookies, and moves this tab to a bench on that window, on the
 * same tab and sequence; the page outside the proxy stays open.
 *
 * `centred` stands it alone in the middle of an empty pane; otherwise it sits
 * in a line with the text before it.
 */
export function EnableProxy({ base, centred, children }: {
  base: string;
  centred?: boolean;
  children?: ComponentChildren;
}) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let live = true;
    fetch(`${base}/state`)
      .then(res => (res.ok ? res.json() : null))
      .then((view: { connection?: string } | null) => {
        if (live && view?.connection) setName(current => current ?? proxiedNameOf(view.connection!));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [base]);

  const enable = async () => {
    if (!name || busy) return;
    setBusy(true);
    setFailure('');
    const answer = await fetch(`${base}/proxy/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => (res.ok ? res.json() : { failure: `The bench answered ${res.status}` }))
      .catch((error: unknown) => ({ failure: `The bench did not answer: ${String(error)}` })) as { benchUrl?: string; failure?: string };
    if (answer.benchUrl) {
      location.href = `${answer.benchUrl.replace(/\/$/, '')}/${location.search}`;
      return;
    }
    setBusy(false);
    setFailure(answer.failure ?? 'the proxy did not start');
  };

  return (
    <div class={centred ? 'enableproxy centred' : 'enableproxy'}>
      {children}
      <span class="enableproxyrow">
        <input class="enableproxyname" value={name ?? ''} aria-label="Name of the proxied connection"
          title="the proxied connection's name: this one's three words and proxied"
          onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void enable(); }} />
        <button class="save" disabled={!name || busy} onClick={() => void enable()}
          title="open this page in a proxied window of this Chrome, with this connection's cookies, and move the bench to it">
          {busy ? 'Enabling…' : 'Enable proxy'}
        </button>
      </span>
      {failure && <pre class="enableproxyfailure bad">{failure}</pre>}
    </div>
  );
}
