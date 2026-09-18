/**
 * Network Monitor
 * Tracks network requests from the browser
 */

import { Page, HTTPRequest, HTTPResponse } from 'puppeteer-core';

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
   * The page sent a close frame - it hung up on purpose (an app dropping a
   * socket on sign-out or an identity change), rather than losing the
   * transport. `Network.webSocketClosed` carries no close code, so the sent
   * opcode-8 frame is the only CDP-visible signal of intent.
   */
  clientClosed?: boolean;
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

export class NetworkMonitor {
  private sockets: Map<string, StoredWebSocket> = new Map();
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
      // The page's own session outlives every navigation, so its sockets are
      // judged on their own close events, never as target teardown.
      this.liveSessions.add('page');
      this.bindSocketEvents(client, 'page', 'page');

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
        if (e.waitingForDebugger) {
          void child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        }
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
   * Funnel one session's WebSocket lifecycle into the shared store.
   *
   * CDP requestIds are unique per session, not globally, so the store is keyed
   * by session and id together - two targets can otherwise overwrite each
   * other's sockets.
   */
  private bindSocketEvents(client: any, target: string, sessionId: string): void {
    const key = (requestId: string) => `${sessionId}:${requestId}`;
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
  getRequests(filter?: { resourceType?: string; limit?: number; offset?: number }): StoredNetworkRequest[] {
    let filtered = Array.from(this.requests.values());

    // Filter by resource type
    if (filter?.resourceType) {
      filtered = filtered.filter(req => req.resourceType === filter.resourceType);
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
