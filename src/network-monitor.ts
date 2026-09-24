/**
 * Network Monitor
 * Tracks network requests from the browser
 */

import { Page, HTTPRequest, HTTPResponse } from 'puppeteer-core';
import type { InitiatorRoot } from './proxy/intercept-proxy.js';
import { SEND_BINDING, SEND_WRAPPER_SOURCE, type SocketSendReport, type RequestOriginReport } from './proxy/send-provenance.js';

export interface StoredNetworkRequest {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body?: string;
    bodySize?: number;
    bodyTokens?: number;
    bodyPath?: string;
  };
  timing?: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
  failed: boolean;
  errorText?: string;
}

/**
 * One WebSocket's life. Puppeteer's page events do not cover WebSockets, so
 * these come from the raw CDP Network domain.
 *
 * A socket that opened and is still open is healthy. One that CLOSED during a
 * run is the interesting case: an app whose reads come over a socket can keep
 * rendering the last synced snapshot afterwards and pass every assertion.
 */
/**
 * One frame that crossed a WebSocket.
 *
 * Payloads are held truncated and the buffer is capped per socket: a sync
 * transport can carry thousands of frames a minute, and holding them whole
 * grows without bound for the length of a session.
 */
export interface StoredSocketFrame {
  at: number;
  direction: 'sent' | 'received';
  /** 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number;
  /** Payload length as it arrived, before any truncation - base64 characters for a binary frame, not bytes. */
  size: number;
  /** Text and binary frames only; control frames carry nothing worth holding. */
  payload?: string;
  /** Set when `payload` holds the first MAX_FRAME_PAYLOAD characters only. */
  truncated?: boolean;
}

export interface StoredWebSocket {
  id: string;
  url: string;
  openedAt: number;
  closedAt?: number;
  /** Frame-level protocol errors, which do not necessarily close the socket. */
  errors: string[];
  /**
   * CDP target type that owns the socket - 'page', or a worker type such as
   * 'worker'/'shared_worker'/'service_worker'. An app that syncs from a worker
   * has its real transport here, not on the page.
   */
  target: string;
  /** CDP session the socket was seen on; scopes its id and its lifetime. */
  sessionId: string;
  /**
   * Its target is gone, so the close came with the teardown rather than from
   * the transport failing. Decided when the socket is read, not when it closed:
   * a close event and its target's detach race, and blaming whichever arrived
   * first made healthy navigations and identity changes look like drops.
   */
  closedWithTarget?: boolean;
  /** Frames that crossed it, oldest first, capped at MAX_FRAMES_PER_SOCKET. */
  frames: StoredSocketFrame[];
  /** Frames discarded to keep the buffer at its cap, so a reader sees the gap. */
  framesDropped: number;
  /**
   * The page sent a close frame.
   *
   * Chrome reports data frames to the inspector and handles close frames below
   * that, so `Network.webSocketFrameSent` does not carry opcode 8 and this is
   * never set by a page calling close() on a live document. Driven against
   * examples/socket-app: a page close produced webSocketClosed and no sent
   * frame. A close that comes with the document going away is caught by
   * `closedWithDocument`; an explicit close() on a live document has no
   * CDP-visible signal of intent at all.
   */
  clientClosed?: boolean;
  /**
   * Its document was replaced by a main-frame navigation, which takes every
   * socket the page held with it.
   *
   * Chrome delivers no `Network.webSocketClosed` for these: the CDP session
   * survives the navigation by design, and nothing else reports the teardown,
   * so without this they read open forever and a "is the transport up?" check
   * passes over a socket whose document is gone.
   */
  closedWithDocument?: boolean;
}

/** Frames held per socket. Older ones are discarded as newer arrive. */
const MAX_FRAMES_PER_SOCKET = 200;
/** Characters of a frame payload held. The full length is kept in `size`. */
const MAX_FRAME_PAYLOAD = 4096;
/**
 * Socket records held. Each navigation and each HMR reconnect opens another,
 * and a record keeps its frames after it closes, so an afternoon's navigations
 * accumulate without this. Closed records go first, oldest first; an open
 * socket is evicted only when every record is open.
 */
const MAX_SOCKETS = 50;

/** One message delivered on an EventSource stream. */
export interface StoredStreamEvent {
  at: number;
  /** The `event:` field, or 'message' where the stream sent none. */
  name: string;
  /** The `id:` field, where the stream sent one. */
  eventId?: string;
  /** Payload length as it arrived, before truncation. */
  size: number;
  data: string;
  truncated?: boolean;
}

/**
 * One EventSource stream.
 *
 * A stream's response body never completes, so the HTTP record for it carries
 * headers and nothing else - no status, no body, and a duration stamped on a
 * request still delivering. Its messages arrive on their own CDP event and are
 * held here.
 */
export interface StoredEventStream {
  id: string;
  url: string;
  openedAt: number;
  events: StoredStreamEvent[];
  eventsDropped: number;
  sessionId: string;
  target: string;
}

/**
 * One write to localStorage or sessionStorage.
 *
 * These cross no boundary, so a network record of a step that made one holds
 * nothing. The `storage` tool reads state when asked; without this, "this
 * button saved a draft and never sent it" has no evidence anywhere.
 */
export interface StoredStorageWrite {
  at: number;
  area: 'local' | 'session';
  origin: string;
  operation: 'added' | 'updated' | 'removed' | 'cleared';
  key?: string;
  /** Truncated the same way a frame payload is. */
  value?: string;
  previous?: string;
  truncated?: boolean;
}

/** Writes held before the oldest is discarded. */
const MAX_STORAGE_WRITES = 300;

/** Messages held per stream, and URLs remembered while waiting for a first one. */
const MAX_EVENTS_PER_STREAM = 200;
const MAX_PENDING_URLS = 200;

/** One request's reported initiator, on its way to whatever joins it. */
export interface RequestInitiatorReport {
  method: string;
  url: string;
  root: InitiatorRoot;
  at: number;
  /** The document that named this request, for a parser or preload root. */
  document?: string;
}

/**
 * Which class of the app's machinery started a request.
 *
 * `parser` and `preload` come straight from CDP and name the document load.
 * A script-started request is separated further by what stands above it in the
 * stack: a timer or animation frame above it means the app's own schedule
 * produced it, and no command did.
 */
function rootOfInitiator(initiator: any): InitiatorRoot {
  const type = initiator?.type;
  if (type === 'parser') return 'parser';
  if (type === 'preload') return 'preload';
  if (type !== 'script') return 'other';
  for (let frame = initiator?.stack; frame; frame = frame.parent) {
    const scheduled = String(frame.description ?? '');
    if (/^(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)$/.test(scheduled)) {
      return 'timer';
    }
  }
  return 'script';
}

export class NetworkMonitor {
  private sockets: Map<string, StoredWebSocket> = new Map();
  /** localStorage and sessionStorage writes, oldest first. */
  private storageWrites: StoredStorageWrite[] = [];
  /** EventSource streams, keyed the same way as sockets. */
  private streams: Map<string, StoredEventStream> = new Map();
  /**
   * CDP requestId to URL, so a stream can be named when its first message
   * arrives. A stream is materialised on that message rather than on the
   * request, because only then is it known to be one.
   */
  private pendingUrls: Map<string, string> = new Map();
  /**
   * Sessions still attached. Whether a socket's target is gone has to be
   * answered when the question is asked, not when the socket closed: the close
   * event and the target's detach race, and if the close lands first the socket
   * looks self-inflicted when its worker was actually being torn down.
   */
  private liveSessions: Set<string> = new Set();
  /**
   * A teardown is detaching the sessions. Detaches it produces carry nothing
   * about the sockets' transports, so they must not stamp a close on them.
   */
  private stoppingMonitoring = false;
  /**
   * Where each request's reported initiator goes, when a caller wants it.
   *
   * Set by whoever knows which browser this monitor watches, so the monitor
   * itself holds no reference to the proxy registry.
   */
  onRequestInitiator?: (report: RequestInitiatorReport) => void;
  /** Where each socket send's reported root goes, when a caller wants it. */
  onSocketSend?: (report: SocketSendReport) => void;
  /** Where a request started inside a trusted dispatch goes. */
  onRequestOrigin?: (report: RequestOriginReport) => void;
  private wsClient: any = null;
  /** The page wsClient belongs to, so re-entry can tell "again" from "elsewhere". */
  private wsPage: any = null;
  private requests: Map<string, StoredNetworkRequest> = new Map();
  private requestIdCounter = 0;
  private maxRequests = 1000;
  private isMonitoring = false;
  private lastActivityTime: number = Date.now();

  /**
   * Start monitoring network requests on a page
   */
  startMonitoring(page: Page): void {
    // Remove any existing listeners first to avoid duplicates
    page.removeAllListeners('request');
    page.removeAllListeners('response');
    page.removeAllListeners('requestfailed');

    // Attach network listeners
    page.on('request', (request: HTTPRequest) => {
      this.onRequest(request);
    });

    page.on('response', async (response: HTTPResponse) => {
      await this.onResponse(response);
    });

    page.on('requestfailed', (request: HTTPRequest) => {
      this.onRequestFailed(request);
    });

    // WebSocket lifecycle rides the CDP Network domain - puppeteer surfaces no
    // page event for it. Failing to attach must not break HTTP monitoring.
    void this.startSocketMonitoring(page);

    this.isMonitoring = true;
  }

  /**
   * Subscribe to the CDP WebSocket lifecycle events for this page and its workers.
   *
   * Called again after every navigation (page-tools restartMonitoring), but the
   * page's CDP session and its auto-attach both survive navigation - so one
   * session per page is set up once and kept.
   *
   * Recreating it per navigation is worse than redundant. A second session
   * auto-attaches to the same workers and records every socket twice, and
   * detaching the first orphans whatever it had already recorded: nothing is
   * left to deliver those sockets' close events, so they read open forever. A
   * frozen-open entry is exactly what makes a "is the transport up?" check pass
   * over a dead socket.
   */
  private async startSocketMonitoring(page: Page): Promise<void> {
    if (this.wsClient && this.wsPage === page) return;
    // A genuinely different page: that session's sockets belong to a document
    // that is gone.
    const previous = this.wsClient;
    this.wsClient = null;
    if (previous) {
      try { await previous.detach(); } catch { /* already gone with its target */ }
      for (const sock of this.sockets.values()) if (!sock.closedAt) sock.closedAt = Date.now();
      this.liveSessions.clear();
    }
    try {
      this.wsPage = page;
      const client: any = await (page as any).createCDPSession();
      this.wsClient = client;
      await client.send('Network.enable');
      // Without a depth, a stack stops at the synchronous frames, so a fetch
      // from `.then`, `await` or a debounce carries no frame naming what
      // scheduled it and every one of them reads as plain script. The depth is
      // a Debugger setting and silently does nothing until that domain is on,
      // which is why the enable goes first on this session.
      void client.send('Debugger.enable')
        .then(() => client.send('Debugger.setAsyncCallStackDepth', { maxDepth: 8 }))
        .catch(() => { /* no debugger on this target; roots stay synchronous */ });
      this.reportSocketSends(client);
      // The page's own session outlives every navigation, so its sockets are
      // judged on their own close events, never as target teardown.
      this.liveSessions.add('page');
      this.bindSocketEvents(client, 'page', 'page');
      await this.watchNavigation(client);

      // A socket opened inside a Web Worker belongs to that worker's target and
      // emits nothing on the page session, so each worker needs its own session
      // with Network enabled. waitForDebuggerOnStart holds the worker before its
      // first line runs - otherwise a socket opened at worker boot is missed.
      client.on('Target.attachedToTarget', (e: any) => {
        // The child session is created before this event is dispatched, so no
        // session here means the connection is gone and nothing can be sent.
        const child = client.connection?.()?.session(e.sessionId);
        if (!child) return;
        // Listeners bind before either command below, both of which only
        // register handlers. An event landing between enable and bind is lost.
        this.liveSessions.add(e.sessionId);
        this.bindSocketEvents(child, String(e.targetInfo?.type || 'worker'), e.sessionId);
        // Both commands go out in one turn. CDP holds per-session order, so
        // Network is on before the target's first line runs. Awaiting the enable
        // deadlocks a service worker: its response arrives only once the target
        // runs, and the target runs only on the resume below.
        void child.send('Network.enable').catch(() => {});
        // The wrapper goes into this target too: a socket opened inside a Web
        // Worker reports nothing without it, and its sends then read only as
        // bytes leaving under whatever command was in flight. Installed before
        // the resume below, so a socket opened on the worker's first line is
        // already wrapped.
        this.reportSocketSends(child);

        if (e.waitingForDebugger) {
          void child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        }
        // The evaluation in `reportSocketSends` goes out while the target is
        // held, when it has no execution context to evaluate against, so it
        // installs nothing there. This is the target announcing the context
        // exists, which is the earliest point an evaluation can land, and it
        // replaces a fixed wait that was a guess.
        //
        // It is still later than the target's first line. Holding the resume
        // until the install lands would cover that, and it stalls a service
        // worker's registration for as long as it waits - which
        // `network-monitor.test.ts` pins against, because a registration that
        // hangs is worse than a heartbeat that reads as script. So a worker
        // that opens a socket and schedules on its first line reports `script`
        // for those sends, and the settle window is what covers it.
        child.on('Runtime.executionContextCreated', (created: any) => {
          void child.send('Runtime.evaluate', {
            expression: SEND_WRAPPER_SOURCE, awaitPromise: false, returnByValue: true,
            ...(created?.context?.id !== undefined ? { contextId: created.context.id } : {}),
          }).catch(() => { /* the target went with its page */ });
        });
      });

      // A target that goes away takes its sockets with it and delivers no
      // webSocketClosed for them - a navigation replaces the worker, and its
      // socket would otherwise read as open forever.
      client.on('Target.detachedFromTarget', (e: any) => {
        this.liveSessions.delete(e.sessionId);
        if (this.stoppingMonitoring) return;
        for (const sock of this.sockets.values()) {
          if (sock.sessionId === e.sessionId && !sock.closedAt) {
            sock.closedAt = Date.now();
          }
        }
      });
      await client.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } catch {
      // No CDP session: HTTP monitoring still works, sockets are simply unseen.
    }
  }

  /**
   * Install the page-side send wrapper and carry what it reports.
   *
   * The wrapper goes in before a document's first line runs, so a socket
   * opened at boot is wrapped, and is evaluated once against the document
   * already loaded - a page attached to after load would otherwise report
   * nothing until it navigated.
   */
  private reportSocketSends(client: any): void {
    // Issued in one turn and never awaited. A held target answers nothing
    // until it is resumed, so awaiting any of these before the resume that
    // follows would deadlock the target - the same reason `Network.enable` is
    // not awaited. CDP holds per-session order, so each of these is processed
    // before the resume and the wrapper is in before the target's first line.
    try {
      client.on('Runtime.bindingCalled', (e: any) => {
        if (e?.name !== SEND_BINDING) return;
        try {
          const payload = JSON.parse(String(e.payload));
          if (payload.kind === 'request') {
            this.onRequestOrigin?.({
              method: String(payload.method ?? 'GET'),
              url: String(payload.url ?? ''),
              at: Number(payload.at ?? Date.now()),
            });
            return;
          }
          this.onSocketSend?.({
            url: String(payload.url ?? ''),
            socket: Number(payload.socket ?? 0),
            sequence: Number(payload.sequence ?? 0),
            size: Number(payload.size ?? -1),
            root: payload.root === 'input' || payload.root === 'timer' ? payload.root : 'script',
            at: Number(payload.at ?? Date.now()),
          });
        } catch { /* a payload this build does not produce */ }
      });
      void client.send('Runtime.enable').catch(() => {});
      void client.send('Runtime.addBinding', { name: SEND_BINDING }).catch(() => {});
      // A worker target carries no Page domain, so this copy is for pages; the
      // evaluate below is what reaches a worker, and what reaches a page that
      // was attached to after its document had already loaded.
      void client.send('Page.enable').catch(() => {});
      void client.send('Page.addScriptToEvaluateOnNewDocument', { source: SEND_WRAPPER_SOURCE })
        .catch(() => { /* no Page here; the evaluate still installs it */ });
      void client.send('Runtime.evaluate', {
        expression: SEND_WRAPPER_SOURCE, awaitPromise: false, returnByValue: true,
      }).catch(() => { /* nothing to evaluate against yet */ });
    } catch {
      // No Runtime on this target: sends cross unreported and the wire's own
      // reading stands.
    }
  }

  /**
   * Funnel one session's WebSocket lifecycle into the shared store.
   *
   * CDP requestIds are unique per session, not globally, so the store is keyed
   * by session and id together - two targets can otherwise overwrite each
   * other's sockets.
   */
  private bindSocketEvents(client: any, target: string, sessionId: string): void {
    const key = (requestId: string) => `${sessionId}:${requestId}`;
    // DOMStorage is a separate domain and silent until enabled.
    void client.send('DOMStorage.enable').catch(() => {});
    const areaOf = (id: any): 'local' | 'session' => id?.isLocalStorage ? 'local' : 'session';
    const originOf = (id: any): string => id?.securityOrigin ?? id?.storageKey ?? '(origin not given)';
    const held = (value: unknown): { value?: string; truncated?: boolean } => {
      if (typeof value !== 'string') return {};
      const kept = JSON.parse(JSON.stringify(value.slice(0, MAX_FRAME_PAYLOAD)));
      return value.length > MAX_FRAME_PAYLOAD ? { value: kept, truncated: true } : { value: kept };
    };
    const write = (entry: StoredStorageWrite) => {
      this.storageWrites.push(entry);
      if (this.storageWrites.length > MAX_STORAGE_WRITES) {
        this.storageWrites.splice(0, this.storageWrites.length - MAX_STORAGE_WRITES);
      }
    };

    client.on('DOMStorage.domStorageItemAdded', (e: any) => {
      const kept = held(e.newValue);
      write({
        at: Date.now(), area: areaOf(e.storageId), origin: originOf(e.storageId),
        operation: 'added', key: e.key, ...kept,
      });
    });
    client.on('DOMStorage.domStorageItemUpdated', (e: any) => {
      const kept = held(e.newValue);
      const before = held(e.oldValue);
      write({
        at: Date.now(), area: areaOf(e.storageId), origin: originOf(e.storageId),
        operation: 'updated', key: e.key, ...kept,
        ...(before.value !== undefined ? { previous: before.value } : {}),
      });
    });
    client.on('DOMStorage.domStorageItemRemoved', (e: any) => {
      write({
        at: Date.now(), area: areaOf(e.storageId), origin: originOf(e.storageId),
        operation: 'removed', key: e.key,
      });
    });
    client.on('DOMStorage.domStorageItemsCleared', (e: any) => {
      write({
        at: Date.now(), area: areaOf(e.storageId), origin: originOf(e.storageId),
        operation: 'cleared',
      });
    });

    client.on('Network.requestWillBeSent', (e: any) => {
      if (!e?.requestId || !e?.request?.url) return;
      this.pendingUrls.set(key(e.requestId), e.request.url);
      if (this.pendingUrls.size > MAX_PENDING_URLS) {
        const oldest = this.pendingUrls.keys().next().value;
        if (oldest) this.pendingUrls.delete(oldest);
      }
      // The page holds what the wire cannot: which of the app's own machinery
      // asked for this. Reported as it is sent, so a listener on the proxy side
      // can match it to the bytes before the response completes.
      const report = this.onRequestInitiator;
      if (report) {
        const root = rootOfInitiator(e.initiator);
        // CDP names the document on a parser root and the top frame's script
        // on a script one. Only the first is the load a subresource belongs to.
        const document = (root === 'parser' || root === 'preload')
          ? (typeof e.initiator?.url === 'string' ? e.initiator.url : e.documentURL)
          : undefined;
        report({
          method: String(e.request.method ?? 'GET'),
          url: String(e.request.url),
          root,
          at: Date.now(),
          ...(typeof document === 'string' ? { document } : {}),
        });
      }
    });

    client.on('Network.eventSourceMessageReceived', (e: any) => {
      const id = key(e.requestId);
      let stream = this.streams.get(id);
      if (!stream) {
        stream = {
          id: e.requestId,
          url: this.pendingUrls.get(id) ?? '(url not seen)',
          openedAt: Date.now(),
          events: [],
          eventsDropped: 0,
          sessionId,
          target,
        };
        this.streams.set(id, stream);
      }
      const data = typeof e.data === 'string' ? e.data : '';
      const event: StoredStreamEvent = {
        at: Date.now(),
        name: e.eventName || 'message',
        ...(e.eventId ? { eventId: e.eventId } : {}),
        size: data.length,
        // Rebuilt through JSON for the same reason frame payloads are: a slice
        // holds its parent string alive.
        data: JSON.parse(JSON.stringify(data.slice(0, MAX_FRAME_PAYLOAD))),
        ...(data.length > MAX_FRAME_PAYLOAD ? { truncated: true } : {}),
      };
      stream.events.push(event);
      if (stream.events.length > MAX_EVENTS_PER_STREAM) {
        stream.events.splice(0, stream.events.length - MAX_EVENTS_PER_STREAM);
        stream.eventsDropped += 1;
      }
    });

    client.on('Network.webSocketCreated', (e: any) => {
      this.sockets.set(key(e.requestId), {
        id: e.requestId, url: e.url, openedAt: Date.now(), errors: [], target, sessionId,
        frames: [], framesDropped: 0,
      });
      this.evictSockets();
      this.lastActivityTime = Date.now();
    });
    client.on('Network.webSocketClosed', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (sock) sock.closedAt = Date.now();
      this.lastActivityTime = Date.now();
    });
    client.on('Network.webSocketFrameError', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (sock) sock.errors.push(String(e.errorMessage || 'frame error'));
    });
    client.on('Network.webSocketFrameSent', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (!sock) return;
      // Opcode 8 is the close frame. Sent by the page means it hung up.
      if (e?.response?.opcode === 8) sock.clientClosed = true;
      this.recordFrame(sock, 'sent', e?.response);
      // A sent frame is the page acting, which is what the inactivity sweep
      // reads as the browser being in use. A received frame is the server
      // talking to an idle page, so it must not hold the connection open.
      this.lastActivityTime = Date.now();
    });
    // Received frames carry what the app is actually driven by. Without them a
    // socket-carried mutation is invisible: the lifecycle says a transport
    // stayed up and nothing says what crossed it.
    client.on('Network.webSocketFrameReceived', (e: any) => {
      const sock = this.sockets.get(key(e.requestId));
      if (!sock) return;
      this.recordFrame(sock, 'received', e?.response);
    });
  }

  /**
   * Close the page's sockets when its document is replaced.
   *
   * Read off the CDP event rather than Puppeteer's `framenavigated`, which also
   * fires for a same-document navigation - measured: a hash change closed a
   * live socket. CDP reports those on `Page.navigatedWithinDocument` and keeps
   * `Page.frameNavigated` for a document that was actually replaced.
   *
   * Main frame only, and only sockets on the page session: a worker's socket
   * lives in its own target, and its teardown arrives as a target detach.
   */
  private async watchNavigation(client: any): Promise<void> {
    await client.send('Page.enable').catch(() => {});
    client.on('Page.frameNavigated', (e: any) => {
      if (e?.frame?.parentId) return;
      const at = Date.now();
      for (const sock of this.sockets.values()) {
        if (sock.sessionId !== 'page' || sock.closedAt) continue;
        sock.closedAt = at;
        sock.closedWithDocument = true;
      }
    });
  }

  /**
   * Keep the socket map at MAX_SOCKETS.
   *
   * A record that carried no frame and no error goes before one that did: the
   * case this cap exists for is a run of HMR reconnects, and evicting on age
   * alone discards the app's own transport to make room for the noise that
   * displaced it. Within a class, closed before open, then oldest first.
   */
  private evictSockets(): void {
    if (this.sockets.size <= MAX_SOCKETS) return;
    const rank = (s: StoredWebSocket): [number, number, number] =>
      [s.frames.length > 0 || s.errors.length > 0 ? 1 : 0, s.closedAt ? 0 : 1, s.openedAt];
    const order = [...this.sockets.entries()].sort(([, a], [, b]) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    for (const [k] of order.slice(0, this.sockets.size - MAX_SOCKETS)) this.sockets.delete(k);
  }

  /**
   * Hold one frame against its socket.
   *
   * Control frames (close, ping, pong) carry no payload worth holding, so only
   * their opcode and timing are kept. Chrome answers protocol-level ping and
   * pong below Blink, so those two rarely reach here at all; an app-level
   * heartbeat arrives as an ordinary text frame. The buffer
   * drops its oldest entry once it is full, and counts the drop so a reader
   * sees that frames are missing rather than reading a short log as complete.
   */
  private recordFrame(
    sock: StoredWebSocket,
    direction: 'sent' | 'received',
    response: { opcode?: number; payloadData?: string } | undefined
  ): void {
    const opcode = response?.opcode ?? 1;
    const data = typeof response?.payloadData === 'string' ? response.payloadData : '';
    const frame: StoredSocketFrame = { at: Date.now(), direction, opcode, size: data.length };
    if (opcode === 1 || opcode === 2) {
      // Rebuilt through JSON rather than sliced: V8 returns a SlicedString that
      // holds its parent alive, so 200 slices of a 1MB payload retain 200MB
      // while every stored payload reads as 4096 characters. Measured.
      frame.payload = JSON.parse(JSON.stringify(data.slice(0, MAX_FRAME_PAYLOAD)));
      if (data.length > MAX_FRAME_PAYLOAD) frame.truncated = true;
    }
    sock.frames.push(frame);
    if (sock.frames.length > MAX_FRAMES_PER_SOCKET) {
      sock.frames.splice(0, sock.frames.length - MAX_FRAMES_PER_SOCKET);
      sock.framesDropped += 1;
    }
  }

  /** Storage writes in a window, oldest first. */
  getStorageWrites(since?: number, until?: number): StoredStorageWrite[] {
    return this.storageWrites.filter(w =>
      (since === undefined || w.at >= since) && (until === undefined || w.at < until));
  }

  /** Every EventSource stream seen, oldest first, with its own events array. */
  getStreams(): StoredEventStream[] {
    return [...this.streams.values()]
      .map(s => ({ ...s, events: [...s.events] }))
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  /** Every WebSocket seen, oldest first. */
  getSockets(): StoredWebSocket[] {
    return [...this.sockets.values()]
      .map(s => ({
        ...s,
        // Its own array: the stored one keeps receiving frames and gets spliced
        // while a response built from this is still being serialised.
        frames: [...s.frames],
        // Answered now rather than at close time - see closedWithTarget. The
        // page session is never detached while monitoring runs, so a page
        // socket is only ever judged on its own close.
        closedWithTarget: !!s.closedAt && !this.liveSessions.has(s.sessionId),
      }))
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  /** Requests started in a window, counted before any limit is applied. */
  countRequestsIn(since?: number, until?: number): number {
    return this.getRequests({ since, until }).length;
  }

  /** Open / closed / errored counts, for a health check. */
  getSocketHealth(): { total: number; open: number; closed: number; errored: number } {
    const all = this.getSockets();
    return {
      total: all.length,
      open: all.filter(s => !s.closedAt).length,
      closed: all.filter(s => s.closedAt).length,
      errored: all.filter(s => s.errors.length > 0).length,
    };
  }

  /**
   * Stop monitoring, page events and CDP session both.
   *
   * Disarming the auto-attach detaches every child session with it, which
   * releases any target Chrome holds before its first line - measured: a
   * registration pending on a held worker completes the moment the disarm
   * lands. Leaving it armed made "monitoring off" read as a control that rules
   * devharness out while every target stayed held.
   */
  async stopMonitoring(page: Page): Promise<void> {
    page.removeAllListeners('request');
    page.removeAllListeners('response');
    page.removeAllListeners('requestfailed');
    this.isMonitoring = false;

    const client = this.wsClient;
    // Cleared before the awaits: startSocketMonitoring reads wsClient to decide
    // whether a page is already monitored, and a re-enable landing mid-teardown
    // has to arm a fresh session rather than adopt the one being detached.
    this.wsClient = null;
    this.wsPage = null;
    if (!client) {
      this.liveSessions.clear();
      return;
    }
    this.stoppingMonitoring = true;
    try {
      await client.send('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => {});
      await client.detach().catch(() => {});
    } finally {
      this.stoppingMonitoring = false;
      this.liveSessions.clear();
    }
  }

  /**
   * Handle request start
   */
  private onRequest(request: HTTPRequest): void {
    const id = `network-${this.requestIdCounter++}`;
    this.lastActivityTime = Date.now();

    const storedRequest: StoredNetworkRequest = {
      id,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: request.headers(),
      postData: request.postData(),
      timing: {
        startTime: Date.now(),
      },
      failed: false,
    };

    this.requests.set(id, storedRequest);

    // Keep only last N requests
    if (this.requests.size > this.maxRequests) {
      const firstKey = this.requests.keys().next().value;
      if (firstKey) {
        this.requests.delete(firstKey);
      }
    }
  }

  /**
   * Handle response
   */
  private async onResponse(response: HTTPResponse): Promise<void> {
    const request = response.request();
    const url = request.url();

    // Find the stored request
    const storedRequest = Array.from(this.requests.values()).find(
      r => r.url === url && !r.response
    );

    if (storedRequest && storedRequest.timing) {
      storedRequest.timing.endTime = Date.now();
      storedRequest.timing.duration = storedRequest.timing.endTime - storedRequest.timing.startTime;

      try {
        // Get response body (only for certain content types to avoid binary data issues)
        let body: string | undefined;
        let bodySize: number | undefined;
        let bodyTokens: number | undefined;

        const contentType = response.headers()['content-type'] || '';
        const isText = contentType.includes('text') ||
                      contentType.includes('json') ||
                      contentType.includes('javascript');

        if (isText) {
          try {
            body = await response.text();
            // Track body size and estimate token count
            if (body) {
              bodySize = body.length;
              // Rough estimation: 1 token ≈ 4 characters
              bodyTokens = Math.ceil(bodySize / 4);
            }
          } catch {
            // Ignore errors when reading body
          }
        }

        storedRequest.response = {
          status: response.status(),
          statusText: response.statusText(),
          headers: response.headers(),
          body,
          bodySize,
          bodyTokens,
        };
      } catch (error) {
        // Response might not be available
      }
    }
  }

  /**
   * Handle request failure
   */
  private onRequestFailed(request: HTTPRequest): void {
    const url = request.url();

    // Find the stored request
    const storedRequest = Array.from(this.requests.values()).find(
      r => r.url === url && !r.failed
    );

    if (storedRequest) {
      storedRequest.failed = true;
      storedRequest.errorText = request.failure()?.errorText;
      if (storedRequest.timing) {
        storedRequest.timing.endTime = Date.now();
        storedRequest.timing.duration = storedRequest.timing.endTime - storedRequest.timing.startTime;
      }
    }
  }

  /**
   * Get all requests
   */
  getRequests(filter?: {
    resourceType?: string;
    limit?: number;
    offset?: number;
    /** Epoch ms. Requests that STARTED at or after this. */
    since?: number;
    /** Epoch ms. Requests that started before this. */
    until?: number;
  }): StoredNetworkRequest[] {
    let filtered = Array.from(this.requests.values());

    // Filter by resource type
    if (filter?.resourceType) {
      filtered = filtered.filter(req => req.resourceType === filter.resourceType);
    }

    // Windowed on start, not on completion: a request belongs to the action
    // that issued it, and a slow one finishing after the next action still
    // belongs to the one that made it.
    if (filter?.since !== undefined) {
      filtered = filtered.filter(req => (req.timing?.startTime ?? 0) >= filter.since!);
    }
    if (filter?.until !== undefined) {
      filtered = filtered.filter(req => (req.timing?.startTime ?? 0) < filter.until!);
    }

    // Apply offset and limit
    const offset = filter?.offset || 0;
    const limit = filter?.limit || filtered.length;

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Get a request by ID
   */
  getRequest(id: string): StoredNetworkRequest | undefined {
    return this.requests.get(id);
  }

  /**
   * Clear all requests
   */
  clearSockets(): void {
    this.sockets.clear();
  }

  clear(): void {
    this.requests.clear();
    this.requestIdCounter = 0;
  }

  /**
   * Get request count
   */
  getCount(resourceType?: string): number {
    if (resourceType) {
      return Array.from(this.requests.values()).filter(
        req => req.resourceType === resourceType
      ).length;
    }
    return this.requests.size;
  }

  /**
   * Check if monitoring
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get the timestamp of the last network activity
   */
  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  /**
   * Check if there has been network activity within the specified duration
   * @param withinMs - Duration in milliseconds to check for activity
   */
  hasRecentActivity(withinMs: number): boolean {
    return Date.now() - this.lastActivityTime < withinMs;
  }
}
