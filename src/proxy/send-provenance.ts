/**
 * What the page knows about a socket send, which the wire cannot show.
 *
 * At the proxy a keystroke, a `setInterval` heartbeat and a library resubscribe
 * are one shape: bytes leaving under whatever command was in flight. The page
 * holds what separates them - whether a trusted input event was being
 * dispatched, and whether a timer callback was on the stack.
 */

/** The binding the injected wrapper calls, once per send. */
export const SEND_BINDING = '__devharnessSocketSend';

/** One send, as the page reports it before the bytes leave. */
export interface SocketSendReport {
  url: string;
  /**
   * Which socket, counted per document rather than named by URL.
   *
   * Two components subscribing to one endpoint are two sockets on one URL, so
   * a URL cannot route a report to the socket that sent it.
   */
  socket: number;
  /**
   * Which send on that socket, counted from 1.
   *
   * The proxy counts the frames it forwards for the same socket, so the two
   * sequences line up and a report matches its own frame. Byte length cannot:
   * two sends of the same size swap roots, and an unmatched report is then
   * claimed by whichever later frame happens to share its length.
   */
  sequence: number;
  /** Payload bytes, kept as a check that the two sequences have not diverged. */
  size: number;
  root: 'input' | 'timer' | 'script';
  at: number;
}

/**
 * One request the page started while a trusted event was being dispatched.
 *
 * Only this case is reported. CDP already classifies a request as parser,
 * preload or timer rooted, and does it from the stack the browser itself
 * holds; what CDP cannot say is that an input event was dispatching, and that
 * is the one thing that ties a request to the command that drove the page.
 */
export interface RequestOriginReport {
  method: string;
  url: string;
  at: number;
}

/**
 * The wrapper installed into every document before its first line runs.
 *
 * Three measurements, none of which survive to the wire:
 *
 * - `event.isTrusted` is true only for an event the browser itself dispatched,
 *   which for a driven page means one `Input.dispatch*` produced. A send during
 *   such a dispatch was caused by the command that drove it.
 * - A counter held up while a timer callback runs names a send the app's own
 *   schedule produced. The callback is wrapped rather than the stack read,
 *   because a stack reaches only as far as the async depth allows and a
 *   library's own scheduler hides the timer behind its own frames.
 * - Byte length, which is what joins this report to the frame the proxy sees.
 *   The two carry no shared id.
 *
 * Every access is guarded: a page that has frozen `WebSocket.prototype`, or
 * runs with no `WebSocket` at all, must load exactly as it would untouched.
 */
export const SEND_WRAPPER_SOURCE = `(() => {
  // A page's global is \`window\`, a worker's is \`self\`, and a socket opened
  // inside a worker is the case a page-only wrapper misses entirely.
  var g = typeof globalThis !== 'undefined' ? globalThis : self;

  // The timer count lives on the global rather than in this closure, because
  // this source is evaluated more than once against one global - a worker is
  // held at its first line, where the schedulers are not installed yet, and is
  // evaluated against again once it runs. A closure per evaluation would leave
  // the wrapper reading a count that the later install increments.
  if (typeof g.__devharnessInTimer !== 'number') g.__devharnessInTimer = 0;

  var wrapScheduler = function (original) {
    if (typeof original !== 'function') return original;
    return function (callback) {
      if (typeof callback !== 'function') return original.apply(this, arguments);
      var rest = Array.prototype.slice.call(arguments, 1);
      return original.apply(this, [function () {
        g.__devharnessInTimer++;
        try { return callback.apply(this, arguments); } finally { g.__devharnessInTimer--; }
      }].concat(rest));
    };
  };

  // Each assignment is guarded on the original being callable, and left alone
  // otherwise: replacing a scheduler that reads as undefined would leave the
  // app calling a non-function, which is the app breaking under a measurement
  // that exists only to watch it. Each wrapper marks itself, so an evaluation
  // that finds one already in place wraps nothing twice - a double wrap would
  // hold the count up across a callback that already finished, and every later
  // send would read as timer-rooted.
  var installSchedulers = function () {
    try {
      ['setTimeout', 'setInterval', 'requestAnimationFrame'].forEach(function (name) {
        var original = g[name];
        if (typeof original !== 'function' || original.__devharnessWrapped) return;
        var wrapped = wrapScheduler(original);
        if (typeof wrapped !== 'function') return;
        wrapped.__devharnessWrapped = true;
        // Defined rather than assigned. On a worker global these live on
        // \`WorkerGlobalScope.prototype\` as non-writable, so a plain assignment
        // does nothing and fails silently in sloppy mode - the wrapper read as
        // installed while the app went on calling the original.
        try {
          Object.defineProperty(g, name, {
            value: wrapped, writable: true, configurable: true, enumerable: true,
          });
        } catch (e) { g[name] = wrapped; }
      });
    } catch (e) { /* a frozen global: roots fall back to script */ }
  };

  // Run before the guard below, on every evaluation. A worker evaluated while
  // held has no schedulers on its global yet, and the evaluation that follows
  // its resume is what installs them.
  installSchedulers();
  try { Promise.resolve().then(installSchedulers); } catch (e) { /* no promises here */ }

  if (typeof g.WebSocket === 'undefined') return;
  if (g.__devharnessSendWrapped) return;
  g.__devharnessSendWrapped = true;

  var sizeOf = function (data) {
    try {
      if (typeof data === 'string') {
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(data).length;
        return new Blob([data]).size;
      }
      if (data && typeof data.byteLength === 'number') return data.byteLength;
      if (data && typeof data.size === 'number') return data.size;
    } catch (e) { /* unmeasurable payload */ }
    return -1;
  };

  // Two conditions, and the second is what makes the first mean anything.
  //
  // \`isTrusted\` is true for every event the browser generates, which includes
  // \`load\`, \`message\`, \`visibilitychange\` and a real pointer crossing the
  // window. On its own it says the event was not synthesised by page script -
  // not that a command produced it - so a page refetching inside a socket
  // \`message\` handler would read as driven by whatever command last ran.
  //
  // The type narrows it to the events \`Input.dispatch*\` produces. A page can
  // still receive a real one from a person at the keyboard, so this measures
  // "a user gesture was being dispatched", and the harness driving the browser
  // is what makes that gesture a command's.
  var DRIVEN_EVENTS = {
    click: 1, dblclick: 1, mousedown: 1, mouseup: 1, pointerdown: 1, pointerup: 1,
    keydown: 1, keyup: 1, keypress: 1, input: 1, change: 1, submit: 1,
  };
  var dispatchingTrusted = function () {
    try {
      var dispatching = typeof g.event !== 'undefined' ? g.event : undefined;
      if (!dispatching || !dispatching.isTrusted) return false;
      return DRIVEN_EVENTS[dispatching.type] === 1;
    } catch (e) { return false; }
  };

  var report = function (payload) {
    try { g.${SEND_BINDING}(JSON.stringify(payload)); }
    catch (e) { /* the binding is gone; the call still goes */ }
  };

  var absolute = function (value) {
    try { return new URL(String(value), g.location && g.location.href).href; }
    catch (e) { return String(value); }
  };

  try {
    var send = g.WebSocket.prototype.send;
    var sockets = 0;
    g.WebSocket.prototype.send = function (data) {
      var root = dispatchingTrusted() ? 'input' : (g.__devharnessInTimer > 0 ? 'timer' : 'script');
      // Numbered on first send rather than at construction: a socket that
      // never sends needs no number, and the proxy numbers the same way.
      try {
        if (typeof this.__devharnessSocket !== 'number') {
          this.__devharnessSocket = ++sockets;
          this.__devharnessSends = 0;
        }
        this.__devharnessSends++;
      } catch (e) { /* sealed socket: the sequence falls back to 0 */ }
      report({
        kind: 'send', url: String(this.url || ''), size: sizeOf(data),
        socket: this.__devharnessSocket || 0, sequence: this.__devharnessSends || 0,
        root: root, at: Date.now(),
      });
      return send.apply(this, arguments);
    };
  } catch (e) { /* a frozen prototype: sends are unreported */ }

  // A request started inside a trusted dispatch belongs to the command that
  // drove the page, however late its bytes leave. Nothing else is reported
  // here: every other class is already measured from the stack CDP holds, and
  // reporting them twice would put two answers against one request.
  try {
    var fetched = g.fetch;
    if (typeof fetched === 'function') {
      g.fetch = function (resource, init) {
        if (dispatchingTrusted()) {
          var url = (resource && typeof resource === 'object' && resource.url)
            ? resource.url : resource;
          var method = (init && init.method)
            || (resource && typeof resource === 'object' && resource.method)
            || 'GET';
          report({
            kind: 'request', method: String(method).toUpperCase(),
            url: absolute(url), at: Date.now(),
          });
        }
        return fetched.apply(this, arguments);
      };
    }
  } catch (e) { /* fetch is not replaceable here */ }

  try {
    if (typeof g.XMLHttpRequest === 'function') {
      var open = g.XMLHttpRequest.prototype.open;
      var xhrSend = g.XMLHttpRequest.prototype.send;
      g.XMLHttpRequest.prototype.open = function (method, url) {
        // Kept on the request, because \`send\` is where the dispatch is read
        // and by then the method and URL are only here.
        try { this.__devharnessCall = { method: String(method || 'GET'), url: url }; }
        catch (e) { /* sealed instance */ }
        return open.apply(this, arguments);
      };
      g.XMLHttpRequest.prototype.send = function () {
        if (dispatchingTrusted()) {
          var call = this.__devharnessCall || {};
          report({
            kind: 'request', method: String(call.method || 'GET').toUpperCase(),
            url: absolute(call.url || ''), at: Date.now(),
          });
        }
        return xhrSend.apply(this, arguments);
      };
    }
  } catch (e) { /* a frozen prototype: requests are unreported */ }
})();`;
