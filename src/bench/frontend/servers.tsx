/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Row } from './row.js';
import type { ServerLog, ServerRow, ToolRun } from '../wire.js';

/**
 * The dev servers devharness manages, running ones first, one row each: the
 * runner, the id and command, and where it listens and for how long. A row
 * starts or restarts its server, stops it, and opens to its facts and the end
 * of its log, read from the file devharness writes it to.
 *
 * Each action is a `server` call from the bench, so History lists it. The
 * list is read again every few seconds, since servers start, crash and stop
 * under agents' calls as well as here.
 */
export function Servers({ base }: { base: string }) {
  const [servers, setServers] = useState<ServerRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<Record<string, ToolRun>>({});
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/servers`).catch(() => null);
      if (!live) return;
      if (res?.ok) { setServers(await res.json()); setFailed(false); } else setFailed(true);
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [base, reads]);

  const call = async (args: Record<string, unknown>): Promise<ToolRun> => fetch(`${base}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'server', args }),
  })
    .then(async res => (res.ok ? res.json() : { failed: true, result: `The bench answered ${res.status}: ${await res.text()}` }))
    .catch((error: unknown) => ({ failed: true, result: `The bench did not answer: ${String(error)}` }));

  // One action at a time per server; the word shows on its row until the call returns.
  const acting = useRef(new Set<string>());
  const act = async (server: ServerRow, word: string, args: Record<string, unknown>) => {
    if (acting.current.has(server.id)) return;
    acting.current.add(server.id);
    setBusy(now => ({ ...now, [server.id]: word }));
    const run = await call(args);
    acting.current.delete(server.id);
    setBusy(({ [server.id]: _, ...rest }) => rest);
    if (run.failed) setLogs(now => ({ ...now, [server.id]: run }));
    setReads(n => n + 1);
  };

  if (!servers) return failed ? <p class="hint nothing">the servers did not load</p> : <div class="hint">reading the servers…</div>;
  if (servers.length === 0) {
    return <p class="hint nothing">No dev server is managed yet. <code>server({'{'} action: 'start', command, cwd, id {'}'})</code> starts one.</p>;
  }

  const ordered = [...servers].sort((a, b) => Number(b.running) - Number(a.running) || a.id.localeCompare(b.id));

  return (
    <ol class="activitycards">
      {ordered.map(server => {
        const doing = busy[server.id];
        const last = logs[server.id];
        return (
          <Row key={server.id}
            classes={['serverrow', server.running ? 'running' : 'stopped']}
            source={server.runnerType}
            label={<>
              <span class="what">{server.id}</span>
              <span class="servercmd">{server.command}</span>
            </>}
            title={server.cwd}
            reading={<span class="meta">
              {doing ? `${doing}…` : server.running
                ? `${server.port !== undefined ? `:${server.port} · ` : ''}up ${server.uptime}`
                : 'stopped'}
            </span>}
            columns={['here', 'stop', 'clear']}
            slots={{
              here: () => void act(server, server.running ? 'restarting' : 'starting',
                server.running ? { action: 'restart', serverId: server.id } : { action: 'start', id: server.id }),
              ...(server.running ? { stop: () => void act(server, 'stopping', { action: 'stop', serverId: server.id }) } : {}),
              clear: () => void act(server, 'clearing logs', { action: 'clearLogs', serverId: server.id }),
            }}
            titles={{
              here: server.running ? 'restart this server' : 'start this server again, as it was saved',
              stop: 'stop this server',
              clear: "empty this server's log files, so they hold only what comes next",
            }}
            open={reading === server.id}
            onOpen={() => setReading(reading === server.id ? null : server.id)}>
            <div class="body historybody">
              <p class="historyfacts">
                {server.running ? `pid ${server.pid}` : 'not running'} · {server.runnerType}
                {server.autoRun && ' · starts with devharness'} · {server.cwd}
              </p>
              <p class="historyfacts servercmdfull">{server.command}</p>
              {last?.failed && (
                <div class="pbox">
                  <div class="pboxhead"><span class="bad">failed</span></div>
                  <pre class="pboxbody">{last.result || '(no text)'}</pre>
                </div>
              )}
              <LogView base={base} id={server.id} />
              <div class="bodyfoot">
                <span class="footactions">
                  <button class="tool plain" disabled={!!doing}
                    title="empty this server's log files, so the view holds only what comes next"
                    onClick={() => void act(server, 'clearing logs', { action: 'clearLogs', serverId: server.id })}>Clear logs</button>
                </span>
              </div>
            </div>
          </Row>
        );
      })}
    </ol>
  );
}

/** Colour and cursor codes a terminal draws with, which read as noise as text. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The end of one server's log, read from disk every two seconds while shown.
 * The view stays at the bottom as lines arrive, until it is scrolled up to
 * read back; scrolling to the bottom again follows the log once more.
 */
function LogView({ base, id }: { base: string; id: string }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [log, setLog] = useState<ServerLog | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  useEffect(() => {
    let live = true;
    setLog(null);
    following.current = true;
    const read = async () => {
      const res = await fetch(`${base}/servers/log?id=${encodeURIComponent(id)}&stream=${stream}`).catch(() => null);
      if (live && res?.ok) setLog(await res.json());
    };
    void read();
    const timer = setInterval(read, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [base, id, stream]);

  useEffect(() => {
    if (following.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log?.text]);

  const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`);
  const text = log?.text?.replace(ANSI, '') ?? '';

  return (
    <div class="pbox">
      <div class="pboxhead">
        <button class={stream === 'stdout' ? 'logstream on' : 'logstream'} onClick={() => setStream('stdout')}>stdout</button>
        <button class={stream === 'stderr' ? 'logstream on' : 'logstream'} onClick={() => setStream('stderr')}>stderr</button>
        <span class="grow" />
        {log?.path && <span class="logpath" title={log.path}>{log.path}{log.size !== undefined && ` · ${kb(log.size)}`}</span>}
      </div>
      {log === null ? <pre class="pboxbody logtail">reading…</pre>
        : log.command ? <pre class="pboxbody logtail">This runner keeps no log file. Its logs: {log.command}</pre>
        : log.unavailable ? <pre class="pboxbody logtail">{log.unavailable}</pre>
        : (
          <pre ref={box} class="pboxbody logtail"
            onScroll={() => {
              const at = box.current;
              if (at) following.current = at.scrollHeight - at.scrollTop - at.clientHeight < 24;
            }}>{text || '(empty)'}</pre>
        )}
    </div>
  );
}
