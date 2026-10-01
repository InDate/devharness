/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Row } from './row.js';
import { Servers } from './servers.js';
import type { ConnectionRow, RunningView, ServerRow, ToolRun } from '../wire.js';

/**
 * What runs beside the bench, in three sections: what devharness watches -
 * this session's event stream and whether a watch reads it, the directories
 * sequences reload from, and each dev server's watch-mode paths - then the
 * connections, then the dev servers.
 *
 * Read again every few seconds, since agents' calls launch, close and restart
 * these as well as the rows here. A switch or close is a `connection` call
 * from the bench, so History lists it.
 */
export function Running({ base }: { base: string }) {
  const [view, setView] = useState<RunningView | null>(null);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const [running, listed] = await Promise.all([
        fetch(`${base}/running`).catch(() => null),
        fetch(`${base}/servers`).catch(() => null),
      ]);
      if (!live) return;
      if (running?.ok) { setView(await running.json()); setFailed(false); } else setFailed(true);
      if (listed?.ok) setServers(await listed.json());
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [base, reads]);

  return (
    <div class="runningtab">
      <section class="runsection">
        <div class="sectionhead">Watcher</div>
        {view ? <Watching view={view} servers={servers} />
          : <p class="hint">{failed ? 'the watch state did not load' : 'reading the watch…'}</p>}
      </section>
      <section class="runsection">
        <div class="sectionhead">Connections {view && <span class="quiet">{view.connections.length}</span>}</div>
        {view ? <Connections base={base} connections={view.connections} onChanged={() => setReads(n => n + 1)} />
          : <p class="hint">{failed ? 'the connections did not load' : 'reading the connections…'}</p>}
      </section>
      <section class="runsection">
        <div class="sectionhead">Servers</div>
        <Servers base={base} />
      </section>
    </div>
  );
}

/**
 * The event stream first: read by a watch or not, with the call that arms one
 * when none is. Then each place a change on disk reaches devharness: the
 * sequence directories and every watch-mode server's paths.
 */
function Watching({ view, servers }: { view: RunningView; servers: ServerRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen(open === key ? null : key);
  const watched = view.readers !== undefined && view.readers > 0;
  const state = view.readers === undefined ? 'lsof gave no reading'
    : watched ? `${view.readers} watch${view.readers === 1 ? '' : 'es'} reading` : 'no watch reading';
  const watchedServers = servers.filter(server => server.watchPaths?.length);

  return (
    <ol class="activitycards">
      <Row classes={['runrow', watched ? 'running' : 'stopped']}
        source="events"
        label={<span class="what">event stream</span>}
        title={view.stream}
        reading={<span class="meta">
          {view.readers === 0 ? <span class="bad">{state}</span> : state}
          {view.unread ? ` · ${view.unread} unread` : ''}
        </span>}
        slots={{}}
        open={open === 'stream'}
        onOpen={() => toggle('stream')}>
        <div class="body historybody">
          <p class="historyfacts servercmdfull">{view.stream}</p>
          <p class="historyfacts">
            {view.unread === undefined
              ? 'No watch has read this stream yet; the first one starts at its end.'
              : `${view.unread} event${view.unread === 1 ? '' : 's'} written past what a watch has read.`}
          </p>
          {!watched && (
            <div class="pbox">
              <div class="pboxhead">arms a watch, run in the session</div>
              <pre class="pboxbody">{view.watchCall}</pre>
            </div>
          )}
        </div>
      </Row>
      {view.sequenceDirs.map(dir => (
        <Row key={`seq:${dir}`} classes={['runrow', 'running']}
          source="sequences"
          label={<span class="what servercmd">{dir}</span>}
          title="an edit to a sequence file here reloads it"
          reading={<span class="meta">reloads on edit</span>}
          slots={{}} open={false} onOpen={() => {}} />
      ))}
      {watchedServers.map(server => (
        <Row key={`server:${server.id}`} classes={['runrow', server.running ? 'running' : 'stopped']}
          source="server"
          label={<>
            <span class="what">{server.id}</span>
            <span class="servercmd">{server.watchPaths!.join(', ')}</span>
          </>}
          title={server.watchPaths!.join('\n')}
          reading={<span class="meta">{server.running ? 'restarts on change' : 'stopped'}</span>}
          slots={{}} open={false} onOpen={() => {}} />
      ))}
    </ol>
  );
}

/** One row per connection, the active one marked: switch to it, or close it. */
function Connections({ base, connections, onChanged }: {
  base: string;
  connections: ConnectionRow[];
  onChanged: () => void;
}) {
  const [reading, setReading] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, ToolRun>>({});

  if (connections.length === 0) {
    return <p class="hint nothing">No connection is open. <code>connection({'{'} action: 'launch', connection {'}'})</code> opens one.</p>;
  }

  const act = async (row: ConnectionRow, word: string, args: Record<string, unknown>) => {
    if (busy[row.name]) return;
    setBusy(now => ({ ...now, [row.name]: word }));
    const run: ToolRun = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'connection', args: { ...args, connection: row.name } }),
    })
      .then(async res => (res.ok ? res.json() : { failed: true, result: `The bench answered ${res.status}: ${await res.text()}` }))
      .catch((error: unknown) => ({ failed: true, result: `The bench did not answer: ${String(error)}` }));
    setBusy(({ [row.name]: _, ...rest }) => rest);
    setFailures(({ [row.name]: _, ...rest }) => (run.failed ? { ...rest, [row.name]: run } : rest));
    onChanged();
  };
  const close = (row: ConnectionRow) => act(row, 'closing', { action: 'close', reason: 'closed from the bench Running tab' });

  return (
    <ol class="activitycards">
      {connections.map(row => {
        const doing = busy[row.name];
        const failure = failures[row.name];
        return (
          <Row key={row.name}
            classes={['runrow', row.connected ? 'running' : 'stopped']}
            source={row.type}
            label={<>
              <span class="what">{row.name}</span>
              {row.url && <span class="servercmd">{row.url}</span>}
            </>}
            title={row.title}
            reading={<span class="meta">
              {doing ? `${doing}…` : [
                `:${row.port}`,
                row.paused ? 'paused' : row.connected ? 'live' : 'not connected',
                row.active ? 'active' : '',
              ].filter(Boolean).join(' · ')}
            </span>}
            columns={['open', 'stop']}
            slots={{
              ...(row.active ? {} : { open: () => void act(row, 'switching', { action: 'switch' }) }),
              stop: () => void close(row),
            }}
            titles={{
              open: 'switch to this connection: make it active and select its page',
              stop: 'close this connection; the last one on a Chrome closes that Chrome',
            }}
            open={reading === row.name}
            onOpen={() => setReading(reading === row.name ? null : row.name)}>
            <div class="body historybody">
              <p class="historyfacts">
                {row.type} · port {row.port} · {row.paused ? 'paused at a breakpoint' : row.connected ? 'debugger connected' : 'debugger not connected'}
                {row.active && ' · active'}
              </p>
              {row.url && <p class="historyfacts servercmdfull">{row.title ? `${row.title} - ` : ''}{row.url}</p>}
              {failure && (
                <div class="pbox">
                  <div class="pboxhead"><span class="bad">failed</span></div>
                  <pre class="pboxbody">{failure.result || '(no text)'}</pre>
                </div>
              )}
              <div class="bodyfoot">
                <span class="footactions">
                  <button class="tool plain" disabled={!!doing} onClick={() => void close(row)}
                    title="close this connection; the last one on a Chrome closes that Chrome">Close</button>
                </span>
              </div>
            </div>
          </Row>
        );
      })}
    </ol>
  );
}
