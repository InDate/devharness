/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { RunningView } from '../wire.js';

/**
 * Which connection the bench works on, among every open one. Choosing another
 * opens its bench with no tab of its own where it has none, and this tab moves
 * there on the same tab and sequence. Traffic, hold, the element picker,
 * recording and Replay then act on that connection; History, Running, Issues
 * and the sequence list read the same on every one.
 *
 * The list is read again every five seconds, since agents' calls open and
 * close connections as well as the bench.
 */
export function ConnectionPicker({ base }: { base: string }) {
  const [own, setOwn] = useState('');
  const [open, setOpen] = useState<string[]>([]);
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
      .then((view: RunningView | null) => { if (live && view) setOpen(view.connections.map(row => row.name)); })
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

  if (!own) return null;
  const names = open.includes(own) ? open : [own, ...open];

  return (
    <select class={failure ? 'connpick bad' : 'connpick'} value={own} disabled={moving}
      aria-label="Connection the bench works on"
      title={failure || 'the connection the bench works on; choosing another moves the bench to it'}
      onChange={(e: Event) => void move((e.target as HTMLSelectElement).value)}>
      {names.map(name => <option key={name} value={name}>{name}</option>)}
    </select>
  );
}
