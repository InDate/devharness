/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Row } from './row.js';
import type { HistoryDetail, HistoryEntry } from '../wire.js';

/** Each channel in words, for a row's tooltip. */
const WHERE: Record<HistoryEntry['from'], string> = {
  mcp: 'the MCP connection',
  cli: 'the devharness CLI',
  bench: 'the bench',
};

/**
 * Every tool call this devharness has run, newest first, one row each: the
 * tool, what it acted on, where it came in, and whether it failed. A row
 * opens to what the call was given and all it returned.
 *
 * History lives in the server process, so a rebuild, which restarts that
 * process, starts the list again from nothing.
 */
export function History({ base }: { base: string }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/history`).catch(() => null);
      if (live && res?.ok) setEntries(await res.json());
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  if (!entries) return <div class="hint">reading the history…</div>;
  if (entries.length === 0) return <p class="hint nothing">no tool calls since devharness started</p>;

  return (
    <ol class="activitycards">
      {entries.map(entry => (
        <Row key={entry.index}
          classes={['historyrow', entry.failed ? 'failed' : entry.failed === undefined ? 'running' : '']}
          source={entry.tool}
          label={<span class="what">{entry.label}</span>}
          title={[`#${entry.index}`, entry.connection, entry.said].filter(Boolean).join(' · ')}
          reading={<>
            <span class="where" title={entry.run
              ? `a step of ${entry.run}, run from ${WHERE[entry.from]}`
              : `came in through ${WHERE[entry.from]}`}>
              {entry.run && <span class="whererun">{entry.run} · </span>}{entry.from}
            </span>
            {entry.failed && <span class="meta bad">failed</span>}
            {entry.failed === undefined && <span class="meta">running</span>}
            <span class="meta">{new Date(entry.at).toLocaleTimeString()}</span>
          </>}
          slots={{}} columns={[]}
          open={reading === entry.index}
          onOpen={() => setReading(reading === entry.index ? null : entry.index)}>
          <CallDetail base={base} entry={entry} />
        </Row>
      ))}
    </ol>
  );
}

/** An opened call: its parameters and its response, read when the row opens and again once a running call ends. */
function CallDetail({ base, entry }: { base: string; entry: HistoryEntry }) {
  const { index } = entry;
  const running = entry.failed === undefined;
  const [detail, setDetail] = useState<HistoryDetail | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`${base}/history/entry?index=${index}`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(read => { if (live) setDetail(read); });
    return () => { live = false; };
  }, [base, index, running]);

  if (detail === undefined) return <div class="body"><p class="quiet">reading…</p></div>;
  if (detail === null) return <div class="body"><p class="quiet">history no longer holds this call</p></div>;
  return (
    <div class="body historybody">
      <p class="historyfacts">
        #{index}{entry.connection && <> · {entry.connection}</>} · {new Date(entry.at).toLocaleString()}
      </p>
      <div class="pbox">
        <div class="pboxhead">given</div>
        <pre class="pboxbody">{JSON.stringify(detail.params, null, 2)}</pre>
      </div>
      <div class="pbox">
        <div class="pboxhead">returned</div>
        <pre class="pboxbody">{detail.result ?? 'still running'}</pre>
      </div>
    </div>
  );
}
