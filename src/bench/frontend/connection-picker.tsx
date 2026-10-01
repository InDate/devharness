/** @jsxImportSource preact */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConnectionRow, RunningView } from '../wire.js';
import { discFill, discSaid } from './disc.js';
import { ToolGlyph } from './tool-glyph.js';

/**
 * Which connection the bench works on, among every open one. Choosing another
 * opens its bench with no tab of its own where it has none, and this tab moves
 * there on the same tab and sequence. Traffic, hold, the element picker,
 * recording and Replay then act on that connection; History, Running, Issues
 * and the sequence list read the same on every one.
 *
 * Its mark carries a count of the open connections, badged as the tabs' counts
 * are and pulsing as they do when it rises. Each option carries its
 * connection's dot in the disc's colours, so a held page, held traffic, a run
 * or a recording on another connection shows before switching to it.
 *
 * The list is read again every five seconds, since agents' calls open and
 * close connections as well as the bench.
 */
export function ConnectionPicker({ base }: { base: string }) {
  const [own, setOwn] = useState('');
  // Null until the first list arrives, so opening the bench draws its count still.
  const [open, setOpen] = useState<ConnectionRow[] | null>(null);
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let live = true;
    fetch(`${base}/state`)
      .then(res => (res.ok ? res.json() : null))
      .then((view: { connection?: string } | null) => { if (live && view?.connection) setOwn(view.connection); })
      .catch(() => {});
    const read = () => fetch(`${base}/running`)
      .then(res => (res.ok ? res.json() : null))
      .then((view: RunningView | null) => { if (live && view) setOpen(view.connections); })
      .catch(() => {});
    void read();
    const timer = setInterval(read, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  const move = async (name: string) => {
    if (name === own || moving) return;
    setMoving(true);
    setFailure('');
    const answer = await fetch(`${base}/bench/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connection: name }),
    })
      .then(res => (res.ok ? res.json() : { failure: `The bench answered ${res.status}` }))
      .catch((error: unknown) => ({ failure: `The bench did not answer: ${String(error)}` })) as { benchUrl?: string; failure?: string };
    if (answer.benchUrl) {
      location.href = `${answer.benchUrl.replace(/\/$/, '')}/${location.search}`;
      return;
    }
    setMoving(false);
    setFailure(answer.failure ?? `no bench opened on ${name}`);
  };

  const listed = open ?? [];
  const rows = own && !listed.some(row => row.name === own)
    ? [{ name: own } as ConnectionRow, ...listed]
    : listed;
  const count = listed.length;
  const drawn = useRef<number | undefined>(undefined);
  const rises = useRef(0);
  if (open !== null) {
    if (drawn.current !== undefined && count > drawn.current) rises.current += 1;
    drawn.current = count;
  }

  if (!own) return null;
  return (
    <span class={failure ? 'connpick bad' : 'connpick'}>
      <span class="tabmark connmark" title={`${count} connection${count === 1 ? '' : 's'} open`}>
        <ToolGlyph tool="connection" />
        {count > 0 && (
          <span key={rises.current} class={rises.current > 0 ? 'tabbadge risen' : 'tabbadge'}>{count > 999 ? '999+' : count}</span>
        )}
      </span>
      <select value={own} disabled={moving}
        aria-label="Connection the bench works on"
        title={failure || 'the connection the bench works on; choosing another moves the bench to it'}
        onChange={(e: Event) => void move((e.target as HTMLSelectElement).value)}>
        {/* Chrome's customizable select copies the chosen option into
            `selectedcontent`; Preact's JSX types do not list the element. */}
        <button type="button">{h('selectedcontent', null)}</button>
        {rows.map(row => (
          <option key={row.name} value={row.name}>
            <span class="conndot" title={discSaid(row.modes ?? [])}
              style={{ background: discFill(row.modes ?? []) ?? 'var(--line)' }} />
            <span>{row.name}</span>
          </option>
        ))}
        </select>
    </span>
  );
}
