/**
 * An HTTP/HTTPS/WS/WSS proxy Chrome is launched through, so a value can be
 * held and served back in place of what the server would say.
 *
 * Observation stays on CDP, which sees what the renderer receives including
 * cache hits and service-worker replies. This exists for intervention only.
 *
 * Nothing is parsed unless it is pinned. An unpinned request is forwarded and
 * its bytes are piped back untouched - no decompression, no chunk handling, no
 * header rewriting - so the correctness surface is exactly the traffic asked
 * for. A half-right proxy corrupts responses in ways that are miserable to
 * find; a byte pipe cannot.
 */
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { request as httpsRequest } from 'https';
import { connect as netConnect, type Socket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { mintProxyCertificate, type ProxyCertificate } from './certificate.js';

/** A value held in place of what the server would answer. */
export interface Pin {
  id: string;
  /** Matched as a substring of the full URL. */
  urlIncludes: string;
  /** Only this method, when given. */
  method?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Times it has answered, so a pin that never fires is visible as one. */
  hits: number;
}

export interface SocketFrame {
  at: number;
  url: string;
  direction: 'sent' | 'received';
  binary: boolean;
  size: number;
  /** Text frames only, truncated by the caller's own rule. */
  text?: string;
  /** What the proxy did with it. Absent means it went through unchanged. */
  heldAs?: 'replaced' | 'dropped';
}

/**
 * One thing the proxy saw cross the boundary.
 *
 * Requests and frames are one kind here rather than two, because what is
 * wanted between two steps is "what reached the outside world", and that
 * question does not care which transport carried it.
 */
export interface ProxyEvent {
  id: string;
  at: number;
  kind: 'request' | 'frame';
  /** Leaving the browser, or arriving at it. */
  direction: 'out' | 'in';
  url: string;
  method?: string;
  status?: number;
  binary?: boolean;
  size: number;
  /** First characters of the payload, for a list. The whole body is kept
   *  separately and only up to BODY_CAP. */
  preview?: string;
  heldAs?: 'replaced' | 'dropped';
}

/** Events held before the oldest is discarded. */
const MAX_EVENTS = 2000;
/** Response body kept per exchange, for turning one into a held value later. */
const BODY_CAP = 64 * 1024;
const PREVIEW_CHARS = 200;

/**
 * A frame held in place of what would have crossed.
 *
 * Matched on the payload rather than on position: a socket carries no method,
 * URL or status, so the only durable handle on one message is what is in it.
 */
export interface FramePin {
  id: string;
  /** Substring of the connection's URL, when the hold is for one socket. */
  urlIncludes?: string;
  direction?: 'sent' | 'received';
  /** Substring of the text payload. Binary frames are never matched. */
  textIncludes: string;
  /** Sent in its place. Absent drops the frame, and nothing arrives at all. */
  replaceWith?: string;
  hits: number;
}

export class InterceptProxy {
  private certificate: ProxyCertificate | null = null;
  private front = createHttpServer();
  /** Fed sockets after CONNECT rather than listening; it terminates the TLS. */
  private inner = createHttpsServer();
  /** The same, for a CONNECT tunnel that turns out to carry no TLS. */
  private innerPlain = createHttpServer();
  private upgrades = new WebSocketServer({ noServer: true });
  private pins = new Map<string, Pin>();
  private framePins = new Map<string, FramePin>();
  private events: ProxyEvent[] = [];
  private bodies = new Map<string, string>();
  private eventSeq = 0;
  private frameHandlers = new Set<(frame: SocketFrame) => void>();
  private pinSeq = 0;
  private port = 0;

  /** What the proxy saw in a window, oldest first. */
  eventsIn(since?: number, until?: number): ProxyEvent[] {
    return this.events.filter(e =>
      (since === undefined || e.at >= since) && (until === undefined || e.at < until));
  }

  /** The kept body for one event, where there is one. */
  bodyOf(id: string): string | undefined {
    return this.bodies.get(id);
  }

  private record(event: Omit<ProxyEvent, 'id'>, body?: string): ProxyEvent {
    const stored: ProxyEvent = { id: `ev-${++this.eventSeq}`, ...event };
    this.events.push(stored);
    if (body !== undefined) this.bodies.set(stored.id, body);
    if (this.events.length > MAX_EVENTS) {
      for (const gone of this.events.splice(0, this.events.length - MAX_EVENTS)) {
        this.bodies.delete(gone.id);
      }
    }
    return stored;
  }

  /** Every frame that crosses a proxied socket, both directions. */
  onFrame(handler: (frame: SocketFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  private announce(frame: SocketFrame): void {
    for (const handler of this.frameHandlers) {
      try { handler(frame); } catch { /* a reader must not break the pipe */ }
    }
  }

  pin(spec: Omit<Pin, 'id' | 'hits' | 'status' | 'headers'> & {
    status?: number;
    headers?: Record<string, string>;
  }): Pin {
    const pin: Pin = {
      id: `pin-${++this.pinSeq}`,
      urlIncludes: spec.urlIncludes,
      ...(spec.method ? { method: spec.method.toUpperCase() } : {}),
      status: spec.status ?? 200,
      headers: spec.headers ?? { 'content-type': 'application/json' },
      body: spec.body,
      hits: 0,
    };
    this.pins.set(pin.id, pin);
    return pin;
  }

  unpin(id: string): boolean {
    return this.pins.delete(id) || this.framePins.delete(id);
  }

  /** Hold a frame: replace what it carries, or drop it so nothing arrives. */
  pinFrame(spec: Omit<FramePin, 'id' | 'hits'>): FramePin {
    const pin: FramePin = { id: `frame-${++this.pinSeq}`, hits: 0, ...spec };
    this.framePins.set(pin.id, pin);
    return pin;
  }

  listFramePins(): FramePin[] {
    return [...this.framePins.values()];
  }

  private matchFramePin(
    url: string, direction: SocketFrame['direction'], text: string | undefined,
  ): FramePin | undefined {
    if (text === undefined) return undefined;
    for (const pin of this.framePins.values()) {
      if (pin.urlIncludes && !url.includes(pin.urlIncludes)) continue;
      if (pin.direction && pin.direction !== direction) continue;
      if (text.includes(pin.textIncludes)) return pin;
    }
    return undefined;
  }

  listPins(): Pin[] {
    return [...this.pins.values()];
  }

  private matchPin(url: string, method: string): Pin | undefined {
    for (const pin of this.pins.values()) {
      if (pin.method && pin.method !== method.toUpperCase()) continue;
      if (url.includes(pin.urlIncludes)) return pin;
    }
    return undefined;
  }

  /** Answer from a pin, or forward and pipe the bytes back untouched. */
  private handle(secure: boolean, req: IncomingMessage, res: ServerResponse): void {
    // A request straight to the proxy carries an absolute URI; one arriving
    // through a CONNECT tunnel carries only a path, and its host is a header.
    const host = req.headers.host ?? '';
    const path = req.url ?? '/';
    const url = /^https?:\/\//i.test(path) ? path : `${secure ? 'https' : 'http'}://${host}${path}`;
    const pin = this.matchPin(url, req.method ?? 'GET');

    if (pin) {
      pin.hits += 1;
      res.writeHead(pin.status, { ...pin.headers, 'content-length': Buffer.byteLength(pin.body) });
      res.end(pin.body);
      this.record({
        at: Date.now(), kind: 'request', direction: 'out', url,
        method: req.method ?? 'GET', status: pin.status,
        size: Buffer.byteLength(pin.body), preview: pin.body.slice(0, PREVIEW_CHARS),
        heldAs: 'replaced',
      }, pin.body);
      return;
    }

    let target: URL;
    try { target = new URL(url); } catch { res.writeHead(400).end('bad request line'); return; }

    const send = secure ? httpsRequest : httpRequest;
    const upstream = send({
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
      ...(secure ? { rejectUnauthorized: false } : {}),
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      // Tapped rather than buffered: the bytes still pipe through untouched and
      // a copy is kept up to the cap, so an exchange can become a held value
      // later without the proxy having to parse anything now.
      let kept = '';
      let size = 0;
      answer.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (kept.length < BODY_CAP) kept += chunk.toString('utf8', 0, BODY_CAP - kept.length);
      });
      answer.on('end', () => this.record({
        at: Date.now(), kind: 'request', direction: 'out', url,
        method: req.method ?? 'GET', status: answer.statusCode ?? 0,
        size, preview: kept.slice(0, PREVIEW_CHARS),
      }, kept));
      answer.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }

  /** Terminate the page's socket, open our own upstream, forward with a hook. */
  private handleUpgrade(secure: boolean, req: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = req.headers.host ?? '';
    const url = `${secure ? 'wss' : 'ws'}://${host}${req.url}`;

    this.upgrades.handleUpgrade(req, socket, head, (client) => {
      client.on('error', () => { /* handled by the close pairing below */ });
      const upstream = new WebSocket(url, {
        rejectUnauthorized: false,
        headers: { ...(req.headers.origin ? { origin: req.headers.origin } : {}) },
      });
      const pending: Array<[any, boolean]> = [];

      const forward = (from: WebSocket, to: WebSocket, direction: SocketFrame['direction']) => {
        from.on('message', (data: any, binary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          const text = binary ? undefined : buf.toString('utf8');
          const held = this.matchFramePin(url, direction, text);
          if (held) held.hits += 1;

          const heldAs = held
            ? (held.replaceWith === undefined ? 'dropped' as const : 'replaced' as const)
            : undefined;
          this.announce({
            at: Date.now(), url, direction, binary, size: buf.length,
            ...(text !== undefined ? { text } : {}),
            ...(heldAs ? { heldAs } : {}),
          });
          this.record({
            at: Date.now(), kind: 'frame', direction: direction === 'sent' ? 'out' : 'in',
            url, binary, size: buf.length,
            ...(text !== undefined ? { preview: text.slice(0, PREVIEW_CHARS) } : {}),
            ...(heldAs ? { heldAs } : {}),
          }, text);

          if (held && held.replaceWith === undefined) return;
          const payload = held?.replaceWith !== undefined ? held.replaceWith : data;
          const asBinary = held?.replaceWith !== undefined ? false : binary;
          if (to.readyState === WebSocket.OPEN) to.send(payload, { binary: asBinary });
          else if (to === upstream) pending.push([payload, asBinary]);
        });
      };

      forward(client, upstream, 'sent');
      forward(upstream, client, 'received');

      upstream.on('open', () => {
        for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary });
      });
      const close = (a: WebSocket, b: WebSocket) => a.on('close', (code, reason) => {
        try { b.close(code >= 1000 && code < 5000 ? code : 1011, reason); } catch { /* already gone */ }
      });
      close(client, upstream);
      close(upstream, client);
      upstream.on('error', () => { try { client.close(1011); } catch { /* already gone */ } });
      client.on('error', () => { try { upstream.close(1011); } catch { /* already gone */ } });
    });
  }

  async start(): Promise<{ port: number; spkiFingerprint: string; chromeArgs: string[] }> {
    this.certificate = mintProxyCertificate();
    this.inner = createHttpsServer(
      { cert: this.certificate.cert, key: this.certificate.key, ALPNProtocols: ['http/1.1'] },
      (req, res) => this.handle(true, req, res));
    this.inner.on('upgrade', (req, socket, head) => this.handleUpgrade(true, req, socket as Socket, head));

    this.front.on('request', (req, res) => this.handle(false, req, res));
    this.front.on('upgrade', (req, socket, head) => this.handleUpgrade(false, req, socket as Socket, head));
    this.innerPlain = createHttpServer((req, res) => this.handle(false, req, res));
    this.innerPlain.on('upgrade', (req, socket, head) => this.handleUpgrade(false, req, socket as Socket, head));

    // Chrome tunnels every WebSocket through CONNECT, ws:// included, so a
    // tunnel is not TLS by virtue of being a tunnel. The first byte says which
    // it is: a TLS record starts 0x16, an HTTP request line starts with a
    // letter. Routing every tunnel to the TLS server fails the handshake on a
    // plaintext one and the page sees its socket close before any reply.
    this.front.on('connect', (_req, socket: Socket, head: Buffer) => {
      // A peer resetting a tunnel is ordinary. Unhandled, its error event ends
      // the process and takes every other connection with it.
      socket.on('error', () => socket.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const route = (first: Buffer) => {
        socket.unshift(first);
        (first[0] === 0x16 ? this.inner : this.innerPlain).emit('connection', socket);
      };
      if (head?.length) { route(head); return; }
      // Read one byte in paused mode and put it back. A 'data' listener would
      // switch the socket to flowing and the handshake would stream past
      // before the TLS server had attached, which reads as a hang rather than
      // an error.
      const peek = () => {
        const first = socket.read(1) as Buffer | null;
        if (first === null) { socket.once('readable', peek); return; }
        route(first);
      };
      peek();
    });

    // Every stream here belongs to a peer that may vanish: a reset, a half-open
    // socket, a request line Node rejects. Each one is a normal event for a
    // proxy and none of them may reach the default error handler.
    for (const server of [this.front, this.inner, this.innerPlain]) {
      server.on('clientError', (_err, socket) => (socket as Socket).destroy());
      server.on('connection', (socket) => socket.on('error', () => socket.destroy()));
    }
    this.inner.on('tlsClientError', (_err, socket) => (socket as any).destroy());
    this.front.on('error', () => { /* reported through start()'s rejection */ });

    await new Promise<void>((resolve) => this.front.listen(0, '127.0.0.1', resolve));
    this.port = (this.front.address() as any).port;

    return {
      port: this.port,
      spkiFingerprint: this.certificate.spkiFingerprint,
      chromeArgs: [
        `--proxy-server=http://127.0.0.1:${this.port}`,
        // Chrome bypasses proxies for loopback by default, which would take
        // every locally served app straight past this with no error.
        '--proxy-bypass-list=<-loopback>',
        `--ignore-certificate-errors-spki-list=${this.certificate.spkiFingerprint}`,
        // QUIC does not traverse an HTTP proxy; without this, traffic to a
        // site offering HTTP/3 simply goes around.
        '--disable-quic',
        // Chrome's own traffic goes through the proxy too, and there is a great
        // deal of it: variations, update checks, optimization-guide model
        // downloads, extension fetches. Measured on one launch, 29 of 35
        // events were Chrome talking to Google and 6 were the app. Left on,
        // the count between two steps says nothing about the app.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-pings',
      ],
    };
  }

  async stop(): Promise<void> {
    this.upgrades.close();
    await new Promise<void>((resolve) => this.front.close(() => resolve()));
  }
}
