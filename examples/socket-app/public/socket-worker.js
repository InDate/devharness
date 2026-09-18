/** A socket owned by a worker target, so its `target` is not 'page'. */
let ws = null;
self.addEventListener('message', (e) => {
  ws = new WebSocket(e.data);
  ws.addEventListener('open', () => self.postMessage('socket open'));
  ws.addEventListener('message', (m) => self.postMessage(`frame ${String(m.data).length}b`));
  ws.addEventListener('close', () => self.postMessage('socket closed'));
});
