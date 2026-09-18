/**
 * A WebSocket app that drives every path through devharness frame capture.
 *
 * One endpoint per behaviour, so a sequence can open exactly the socket whose
 * handling it means to exercise: payload sizes either side of the truncation
 * cap, both opcodes that carry a payload, both close directions, protocol
 * pings, a frame error, a burst past the ring buffer, and a socket that says
 * nothing at all.
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7788);

const files = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/second.html': ['second.html', 'text/html'],
  '/socket-worker.js': ['socket-worker.js', 'text/javascript'],
};

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  // An SSE stream: one long-lived response whose body never completes. A
  // response-body reader that waits for the end never returns on this.
  if (path === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const ms = Number(url.searchParams.get('ms') ?? 1000);
    res.write('retry: 3000\n\n');
    let n = 0;
    const timer = setInterval(() => {
      n++;
      // Three shapes an app relies on: a plain message, a named event, and a
      // payload split across data lines.
      if (n % 3 === 1) res.write(`id: ${n}\ndata: ${JSON.stringify({ tag: 'tick', n })}\n\n`);
      else if (n % 3 === 2) res.write(`id: ${n}\nevent: price\ndata: ${JSON.stringify({ tag: 'price', n, value: n * 7 })}\n\n`);
      else res.write(`id: ${n}\ndata: {"tag":"split",\ndata: "n":${n}}\n\n`);
    }, ms);
    req.on('close', () => clearInterval(timer));
    return;
  }

  // Somewhere for a page-written record to be sent, so "written locally and
  // never sent" and "written and sent" are distinguishable at the boundary.
  if (path === '/draft' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log(`POST /draft ${body}`);
      // DRAFT_FAILS=1 turns this endpoint into a regression, for checking that
      // a replay reports boundary behaviour differing from its recording.
      if (process.env.DRAFT_FAILS === '1') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'draft store unavailable' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stored: true, bytes: body.length }));
    });
    return;
  }

  const entry = files[path];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': entry[1] });
  res.end(readFileSync(join(here, 'public', entry[0])));
});

const wss = new WebSocketServer({ server: http });

/** A payload of exactly `chars` characters, so truncation is checkable. */
function filler(chars, tag) {
  const head = `{"tag":"${tag}","body":"`;
  const tail = '"}';
  return head + 'x'.repeat(Math.max(0, chars - head.length - tail.length)) + tail;
}

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://x');
  const q = (name, fallback) => Number(url.searchParams.get(name) ?? fallback);
  const mode = url.pathname;
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(fn, ms));
  const once = (ms, fn) => timers.push(setTimeout(fn, ms));
  socket.on('close', () => timers.forEach(t => { clearInterval(t); clearTimeout(t); }));

  socket.on('message', (data, isBinary) => {
    // Echoed on every endpoint: a sent frame is what the inactivity sweep
    // reads as the page being in use, so every mode can exercise that path.
    socket.send(isBinary ? data : `echo:${data}`, { binary: isBinary });
  });

  if (mode === '/small') {
    every(q('ms', 500), () => socket.send(JSON.stringify({ tag: 'small', at: Date.now() })));
  } else if (mode === '/big') {
    // Above MAX_FRAME_PAYLOAD, so the stored payload is truncated and the
    // retained memory is whatever the capture holds onto behind it.
    every(q('ms', 1000), () => socket.send(filler(q('chars', 200000), 'big')));
  } else if (mode === '/binary') {
    every(q('ms', 700), () => {
      const bytes = Buffer.alloc(q('bytes', 3000));
      bytes.write('binary-frame');
      for (let i = 12; i < bytes.length; i++) bytes[i] = i % 256;
      socket.send(bytes, { binary: true });
    });
  } else if (mode === '/burst') {
    // Past MAX_FRAMES_PER_SOCKET, so the ring buffer discards and counts.
    const total = q('n', 300);
    once(200, () => {
      for (let i = 0; i < total; i++) socket.send(JSON.stringify({ tag: 'burst', i }));
    });
  } else if (mode === '/ping') {
    // Protocol-level pings. Chrome answers these below Blink, so whether they
    // reach the capture at all is the open question this endpoint settles.
    every(q('ms', 1000), () => socket.ping(Buffer.from('hb')));
  } else if (mode === '/heartbeat') {
    // An app-level heartbeat: an ordinary text frame the server sends to a page
    // nobody is touching, which must not hold the browser open.
    every(q('ms', 2000), () => socket.send(JSON.stringify({ tag: 'heartbeat', at: Date.now() })));
  } else if (mode === '/quiet') {
    // Opens and says nothing.
  } else if (mode === '/serverclose') {
    once(q('ms', 1500), () => socket.close(q('code', 1011), 'server closing'));
  } else if (mode === '/badframe') {
    // Invalid UTF-8 announced as text. Chrome fails the frame and drops the
    // socket, which is the only way to reach the frame-error path on purpose.
    once(500, () => {
      socket.send(JSON.stringify({ tag: 'about to send a bad frame' }));
      once(200, () => socket._socket.write(Buffer.from([0x81, 0x03, 0xff, 0xfe, 0xfd])));
    });
  } else {
    socket.send(JSON.stringify({ tag: 'unknown-endpoint', path: mode }));
  }
});

http.listen(PORT, () => {
  console.log(`socket-app on http://localhost:${PORT}`);
  console.log('sockets: /small /big /binary /burst /ping /heartbeat /quiet /serverclose /badframe');
  console.log('http:    /sse (text/event-stream), POST /draft');
});
