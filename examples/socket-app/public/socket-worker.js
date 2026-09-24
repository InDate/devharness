/** A socket owned by a worker target, so its `target` is not 'page'. */
let ws = null;
let beating = null;

// Opened and scheduled at module top level, before any message reaches this
// worker. This is the case a wrapper installed after the worker starts misses
// entirely: the socket exists and the heartbeat is scheduled through the
// original `setInterval`, so every beat reads as plain script. Driven by
// `?boot=` on the worker URL so the on-demand paths below still work alone.
const boot = new URL(self.location.href).searchParams.get('boot');
if (boot) {
  ws = new WebSocket(boot);
  ws.addEventListener('open', () => self.postMessage('socket open'));
  ws.addEventListener('message', (m) => self.postMessage(`frame ${String(m.data).length}b`));
  beating = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ beat: 1 }));
  }, 400);
}
self.addEventListener('message', (e) => {
  // A string opens the socket. An object drives what the worker then sends,
  // which is what makes a worker's own send roots observable: a worker
  // dispatches no input events, so every send from here is script or timer.
  if (typeof e.data === 'object' && e.data) {
    if (e.data.send && ws) ws.send(String(e.data.send));
    if (e.data.beat && ws && !beating) {
      beating = setInterval(() => ws.send(JSON.stringify({ beat: 1 })), e.data.beat);
    }
    if (e.data.stop && beating) { clearInterval(beating); beating = null; }
    return;
  }
  ws = new WebSocket(e.data);
  ws.addEventListener('open', () => self.postMessage('socket open'));
  ws.addEventListener('message', (m) => self.postMessage(`frame ${String(m.data).length}b`));
  ws.addEventListener('close', () => self.postMessage('socket closed'));
});
