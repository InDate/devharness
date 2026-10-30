/** @jsxImportSource preact */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConnectionRow, RunningView } from '../wire.js';
import { discFill, discSaid } from './disc.js';
import { ToolGlyph } from './tool-glyph.js';
import { Glyph } from './glyph.js';
import { setBrowserChoice, useBrowserChoice } from './browser-choice.js';

/**
 * Which connection the bench works on, among every open one. Choosing another
 * opens its bench with no tab of its own where it has none, and this tab moves
 * there on the same tab and sequence. Traffic, hold, the element picker,
 * recording and Replay then act on that connection; History, Running, Issues
 * and the sequence list read the same on every one.
 *
 * Its mark carries a count of the open connections, badged as the tabs' counts
 * are and pulsing as they do when it rises. Each option carries its
 * connection's dot in the disc's colours on its right, so a held page, held
 * traffic, a run or a recording on another connection shows before switching
 * to it. The bench's own disc, drawn by the footing through the slot, stands
 * on the right of the closed select as the chosen connection's dot.
 *
 * Where any open connection belongs to a group, the list holds two kinds of
 * row, each with its own mark: every group, and each browser. The bench's own
 * group reads every browser of it and lights those browsers' rows; another
 * group moves the bench to one of its browsers. A browser of the bench's group
 * narrows the tabs to it with the bench left where it is, lights its row, and
 * the face then carries its dot in place of the bench's disc. A connection
 * outside the group moves the bench, as above. A connection whose page is a
 * bench carries the bench's mark and stands dimmed, never chosen: a bench
 * opened on it would record and hold the page the person works in.
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
  const choice = useBrowserChoice();

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
  // The chosen connection first, so the list opens with its row on the closed face.
  const rows = own
    ? [listed.find(row => row.name === own) ?? ({ name: own } as ConnectionRow), ...listed.filter(row => row.name !== own)]
    : listed;
  const group = rows[0]?.group;
  const members = group ? rows.filter(row => row.group === group) : [];
  const groups = [...new Set(rows.map(row => row.group).filter((name): name is string => !!name))];
  const groupValue = (name: string) => `group:${name}`;
  const chosenMember = choice && members.some(row => row.name === choice) ? choice : null;

  // A choice naming no member of the group is cleared once the group is read,
  // so the address never holds a browser the tabs cannot read.
  useEffect(() => {
    if (open !== null && own && choice && !chosenMember) setBrowserChoice(null, 'replace');
  }, [open, own, choice, chosenMember]);

  // The bench's own group reads every browser of it in place; another group
  // moves the bench to that group's first browser, which then reads them all.
  const pick = (value: string) => {
    const named = groups.find(name => value === groupValue(name));
    if (named !== undefined && named === group) { setBrowserChoice(null); return; }
    if (named !== undefined) { void move(rows.find(row => row.group === named)!.name); return; }
    if (members.some(row => row.name === value)) { setBrowserChoice(value); return; }
    void move(value);
  };
  const lit = (row: ConnectionRow) => chosenMember ? row.name === chosenMember : group !== undefined && row.group === group;
  const option = (row: ConnectionRow) => (
    <option key={row.name} value={row.name} class={lit(row) ? 'lit' : undefined}
      disabled={row.bench && row.name !== own}
      title={row.bench ? `${row.name} shows the bench; a bench opened on it would read its own page` : undefined}>
      {row.bench ? <Glyph of="bench" /> : groups.length > 0 && <Glyph of="browser" />}
      <span class="connname">{row.name}</span>
      <span class={row.modes?.length ? 'conndot' : 'conndot idle'} title={discSaid(row.modes ?? [])}
        style={discFill(row.modes ?? []) ? { background: discFill(row.modes ?? []) } : undefined} />
    </option>
  );
  const count = listed.length;
  const drawn = useRef<number | undefined>(undefined);
  const rises = useRef(0);
  if (open !== null) {
    if (drawn.current !== undefined && count > drawn.current) rises.current += 1;
    drawn.current = count;
  }

  // One structure from the first render, keyed: the footing finds the disc's
  // slot once, on mount, and draws into that element for good.
  return (
    <span class={['connpick', failure ? 'bad' : '', chosenMember && chosenMember !== own ? 'memberface' : ''].filter(Boolean).join(' ')}>
      <span key="mark" class="tabmark connmark" title={`${count} connection${count === 1 ? '' : 's'} open`}>
        <ToolGlyph tool="connection" />
        {count > 0 && (
          <span key={rises.current} class={rises.current > 0 ? 'tabbadge risen' : 'tabbadge'}>{count > 999 ? '999+' : count}</span>
        )}
      </span>
      {/* The disc stands over the face's right end, where each row's dot
          stands in the open list, so the list reads as the face extended. */}
      <span key="face" class="connface">
        {own && (
          <select value={group ? chosenMember ?? groupValue(group) : own} disabled={moving}
            aria-label="Connection the bench works on"
            title={failure || (group
              ? `group ${group}: a browser of it narrows the tabs to that browser; a connection outside it moves the bench`
              : 'the connection the bench works on; choosing another moves the bench to it')}
            onChange={(e: Event) => pick((e.target as HTMLSelectElement).value)}>
            {/* Chrome's customizable select copies the chosen option into
                `selectedcontent`; Preact's JSX types do not list the element. */}
            <button type="button">{h('selectedcontent', null)}</button>
            {groups.map(name => (
              <option key={groupValue(name)} value={groupValue(name)}>
                <Glyph of="group" />
                <span class="connname">{name}</span>
              </option>
            ))}
            {rows.map(option)}
          </select>
        )}
        <span id="statedisc-slot" class="statedisc-slot" />
      </span>
    </span>
  );
}
