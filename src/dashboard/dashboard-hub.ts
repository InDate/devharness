/**
 * Dashboard Hub
 * HTTP/WebSocket server that aggregates data from all MCP sessions
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOutputPath, resolveStateDir } from '../helpers/paths.js';
import { parseIssueFrontmatter, isCompletedStatus } from '../issue-tracker.js';
import { writeLock, removeLock, DEFAULT_PORT, MAX_PORT_ATTEMPTS } from './hub-lock.js';
import type {
  SessionInfo,
  ProjectInfo,
  DashboardState,
  HeartbeatPayload,
  WSMessage,
  MCPMessage,
  MCPHeartbeatMessage,
  ServerRecord,
} from './types.js';
import { RUNNING_BUILD } from './running-build.js';
import type { Orchestrator } from '../log-processor/orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DashboardHub {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wsServer: WebSocketServer | null = null;
  private sessions: Map<string, SessionInfo> = new Map();
  private wsClients: Set<WebSocket> = new Set();           // Browser UI clients
  private mcpClients: Map<WebSocket, number> = new Map();  // MCP clients (ws -> pid)
  private port: number = DEFAULT_PORT;
  private startedAt: number = Date.now();

  // --- Log-processor integration (STUBS) ---------------------------------------
  // The real wiring fed the Orchestrator's processed output into the hub and
  // loaded custom dashboard routes from `.devharness/config/dashboard/`. That
  // implementation was never committed (see log-processor/orchestrator.ts header);
  // these satisfy index.ts's calls so the build works with the feature inert.

  /** Connect a running Orchestrator so the hub can surface its processed logs. */
  connectLogProcessor(_orchestrator: Orchestrator): void {
    // intentionally inert — stub
  }

  /** Load custom dashboard routes from the given config dir. */
  async startRouteLoader(_dashboardConfigDir: string): Promise<void> {
    // intentionally inert — stub
  }

  async start(startPort = DEFAULT_PORT): Promise<boolean> {
    // Try ports until we find one available
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = startPort + attempt;
      try {
        await this.startOnPort(port);
        this.port = port;

        // Write lock file
        writeLock({
          pid: process.pid,
          port: this.port,
          startedAt: new Date().toISOString(),
        });

        return true;
      } catch (err: any) {
        if (err.code !== 'EADDRINUSE') {
          throw err;
        }
        // Port in use, try next
      }
    }

    return false;
  }

  private startOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer(this.handleRequest.bind(this));

      this.httpServer.on('error', reject);

      this.httpServer.listen(port, () => {
        // Set up WebSocket server
        this.wsServer = new WebSocketServer({ server: this.httpServer! });

        this.wsServer.on('connection', (ws, req) => {
          const url = req.url || '/';

          if (url === '/mcp-ws') {
            // MCP client connection
            this.handleMcpClientConnection(ws);
          } else {
            // Browser UI connection
            this.wsClients.add(ws);
            this.sendState(ws);
            ws.on('close', () => {
              this.wsClients.delete(ws);
            });
          }
        });

        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Broadcast need_new_hub to all MCP clients before closing
    const needNewHubMessage: MCPMessage = { type: 'need_new_hub' };
    const json = JSON.stringify(needNewHubMessage);
    for (const [ws] of this.mcpClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }

    // Small delay to allow message to be sent
    await new Promise(resolve => setTimeout(resolve, 50));

    // Close all MCP client connections
    for (const [ws] of this.mcpClients) {
      ws.close();
    }
    this.mcpClients.clear();

    // Close all browser UI connections
    for (const ws of this.wsClients) {
      ws.close();
    }
    this.wsClients.clear();

    // Close WebSocket server
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    // Remove lock file
    removeLock();
  }

  private handleMcpClientConnection(ws: WebSocket): void {
    // Will be updated with actual PID when first heartbeat arrives
    this.mcpClients.set(ws, 0);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as MCPMessage;
        if (message.type === 'mcp_heartbeat') {
          this.handleMcpHeartbeat(ws, message as MCPHeartbeatMessage);
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      const pid = this.mcpClients.get(ws);
      this.mcpClients.delete(ws);
      this.clientSessionKeys.delete(ws);

      // Clean up session if this was a known client
      if (pid && pid !== 0) {
        this.handleMcpClientDisconnect(pid);
      }
    });
  }

  // Track previous session key per client for cleanup when transitioning from PID to sessionId
  private clientSessionKeys: Map<WebSocket, string> = new Map();

  private handleMcpHeartbeat(ws: WebSocket, message: MCPHeartbeatMessage): void {
    const payload = message.payload;
    const pid = payload.pid;

    // Update the PID mapping
    this.mcpClients.set(ws, pid);

    // Use sessionId as key if available, otherwise fall back to PID
    const sessionKey = payload.sessionId || `pid-${pid}`;

    // Check if client's session key changed (PID -> sessionId transition)
    const previousKey = this.clientSessionKeys.get(ws);
    if (previousKey && previousKey !== sessionKey) {
      // Remove old PID-based entry
      this.sessions.delete(previousKey);
      this.broadcastUpdate('session_removed', { pid });
    }
    this.clientSessionKeys.set(ws, sessionKey);

    // Get existing session to preserve allPids/allPpids
    const existing = this.sessions.get(sessionKey);

    // Track all MCP PIDs that have reported for this session
    const allPids = existing?.allPids ? [...existing.allPids] : [];
    if (!allPids.includes(pid)) {
      allPids.push(pid);
    }

    // Track all Claude session PIDs (ppids)
    const allPpids = existing?.allPpids ? [...existing.allPpids] : [];
    if (payload.ppid && !allPpids.includes(payload.ppid)) {
      allPpids.push(payload.ppid);
    }
    const servers = { ...(existing?.servers ?? {}), [pid]: { ppid: payload.ppid, build: payload.build } };

    const session: SessionInfo = {
      pid,
      ppid: payload.ppid,
      sessionId: payload.sessionId,
      shortId: payload.shortId,
      cwd: payload.cwd,
      startedAt: payload.startedAt,
      lastHeartbeat: Date.now(),
      connections: payload.connections,
      lastAction: payload.lastAction,
      sessionEntryCount: payload.sessionEntryCount,
      allPids,
      allPpids,
      servers,
    };

    // Merge connections from existing session if same sessionId but different PID
    if (existing && existing.pid !== pid) {
      const existingRefs = new Set(existing.connections.map(c => c.reference));
      for (const conn of payload.connections) {
        if (!existingRefs.has(conn.reference)) {
          session.connections.push(conn);
        }
      }
      if (existing.startedAt < session.startedAt) {
        session.startedAt = existing.startedAt;
      }
    }

    const isNew = !this.sessions.has(sessionKey);
    this.sessions.set(sessionKey, session);

    // Broadcast update to browser UI
    this.broadcastUpdate(isNew ? 'session_added' : 'update', session);

    // Send ack back to MCP client
    const ack: MCPMessage = {
      type: 'mcp_heartbeat_ack',
      allPids: session.allPids || [],
      allPpids: session.allPpids || [],
      servers: session.servers ?? {},
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(ack));
    }
  }

  private handleMcpClientDisconnect(pid: number): void {
    // Find sessions that have this PID in allPids and remove it
    for (const [key, session] of this.sessions.entries()) {
      if (session.allPids?.includes(pid)) {
        session.allPids = session.allPids.filter(p => p !== pid);
        if (session.servers) delete session.servers[pid];

        if (session.allPids.length === 0) {
          this.sessions.delete(key);
          this.broadcastUpdate('session_removed', { sessionId: session.sessionId, pid });
        } else {
          session.pid = session.allPids[0];
          this.broadcastUpdate('update', session);
        }
        break;
      }
    }
  }

  getPort(): number {
    return this.port;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route handling
    if (url.pathname === '/health' && req.method === 'GET') {
      this.handleHealth(res);
    } else if (url.pathname === '/api/sessions' && req.method === 'GET') {
      this.handleGetSessions(res);
    } else if (url.pathname.match(/^\/api\/sessions\/\d+$/) && req.method === 'POST') {
      const pid = parseInt(url.pathname.split('/').pop()!, 10);
      this.handleUpdateSession(req, res, pid);
    } else if (url.pathname.match(/^\/api\/sessions\/\d+$/) && req.method === 'DELETE') {
      const pid = parseInt(url.pathname.split('/').pop()!, 10);
      this.handleDeleteSession(res, pid);
    } else if (url.pathname === '/api/projects' && req.method === 'GET') {
      this.handleGetProjects(res);
    } else if (url.pathname === '/' && req.method === 'GET') {
      this.serveIndex(res);
    } else if (url.pathname.startsWith('/static/') && req.method === 'GET') {
      this.serveStatic(res, url.pathname);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private handleHealth(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      sessions: this.sessions.size,
    }));
  }

  private handleGetSessions(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.from(this.sessions.values())));
  }

  private async handleUpdateSession(
    req: IncomingMessage,
    res: ServerResponse,
    pid: number
  ): Promise<void> {
    try {
      const body = await this.readBody(req);
      const payload = JSON.parse(body) as HeartbeatPayload;

      // Use sessionId as key if available, otherwise fall back to PID
      // This ensures multiple MCP processes for the same Claude session update the same entry
      const sessionKey = payload.sessionId || `pid-${pid}`;

      // Get existing session to preserve allPids/allPpids
      const existing = this.sessions.get(sessionKey);

      // Track all MCP PIDs that have reported for this session
      const allPids = existing?.allPids ? [...existing.allPids] : [];
      if (!allPids.includes(pid)) {
        allPids.push(pid);
      }

      // Track all Claude session PIDs (ppids)
      const allPpids = existing?.allPpids ? [...existing.allPpids] : [];
      if (payload.ppid && !allPpids.includes(payload.ppid)) {
        allPpids.push(payload.ppid);
      }
      const servers = { ...(existing?.servers ?? {}), [pid]: { ppid: payload.ppid, build: payload.build } };

      const session: SessionInfo = {
        pid,
        ppid: payload.ppid,
        sessionId: payload.sessionId,
        shortId: payload.shortId,
        cwd: payload.cwd,
        startedAt: payload.startedAt,
        lastHeartbeat: Date.now(),
        connections: payload.connections,
        lastAction: payload.lastAction,
        sessionEntryCount: payload.sessionEntryCount,
        allPids,
        allPpids,
        servers,
      };

      // Merge connections from existing session if same sessionId but different PID
      if (existing && existing.pid !== pid) {
        // Different PID but same session - merge connections
        const existingRefs = new Set(existing.connections.map(c => c.reference));
        for (const conn of payload.connections) {
          if (!existingRefs.has(conn.reference)) {
            session.connections.push(conn);
          }
        }
        // Keep the earliest startedAt
        if (existing.startedAt < session.startedAt) {
          session.startedAt = existing.startedAt;
        }
      }

      const isNew = !this.sessions.has(sessionKey);
      this.sessions.set(sessionKey, session);

      // Broadcast update
      this.broadcastUpdate(isNew ? 'session_added' : 'update', session);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, allPids: session.allPids, allPpids: session.allPpids }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  }

  private handleDeleteSession(res: ServerResponse, pid: number): void {
    // Find sessions that have this PID in allPids and remove it
    for (const [key, session] of this.sessions.entries()) {
      if (session.allPids?.includes(pid)) {
        // Remove this PID from allPids
        session.allPids = session.allPids.filter(p => p !== pid);
        if (session.servers) delete session.servers[pid];

        if (session.allPids.length === 0) {
          // No more PIDs - remove the session entirely
          this.sessions.delete(key);
          this.broadcastUpdate('session_removed', { sessionId: session.sessionId, pid });
        } else {
          // Update the session's pid to the first remaining PID
          session.pid = session.allPids[0];
          // Broadcast update so clients get the updated allPids
          this.broadcastUpdate('update', session);
        }
        break;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private handleGetProjects(res: ServerResponse): void {
    const state = this.buildDashboardState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.projects));
  }

  private serveIndex(res: ServerResponse): void {
    const html = this.getIndexHtml();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private serveStatic(res: ServerResponse, pathname: string): void {
    // Only serve bundle.js
    if (pathname === '/static/bundle.js') {
      const bundlePath = join(__dirname, '../../build/dashboard/bundle.js');
      if (existsSync(bundlePath)) {
        const content = readFileSync(bundlePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(content);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private getIndexHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>devharness Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
    }
    #app { padding: 20px; max-width: 1400px; margin: 0 auto; }
    h1 { margin-bottom: 20px; color: #00d4ff; font-size: 1.5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid #333;
    }
    th {
      background: #16213e;
      color: #888;
      font-weight: 500;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:hover { background: rgba(255,255,255,0.02); }
    .project-row { background: #16213e; cursor: pointer; }
    .project-row:hover { background: #1a2744; }
    .session-row { background: #1e1e3a; }
    .connection-row { background: #1a1a2e; }
    .indent-1 { padding-left: 32px; }
    .indent-2 { padding-left: 56px; }
    .state {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .state-active { background: #00c853; color: #000; }
    .state-idle { background: #546e7a; color: #fff; }
    .state-paused { background: #ff9100; color: #000; }
    .issues { display: flex; gap: 8px; }
    .bug { color: #ff5252; }
    .feature { color: #69f0ae; }
    .time-ago { color: #888; }
    .expand-icon {
      display: inline-block;
      width: 16px;
      font-size: 0.7rem;
    }
    .tree-line {
      color: #555;
      font-family: monospace;
      margin-right: 4px;
    }
    .no-sessions {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }
    .connected-badge {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: #00c853;
      border-radius: 50%;
      margin-left: 10px;
    }
    .disconnected-badge {
      background: #ff5252;
    }
    .issues-display { display: flex; gap: 8px; }
    .bug-count { color: #ff5252; }
    .feature-count { color: #69f0ae; }
    .no-issues { color: #555; }
    .session-row { cursor: pointer; }
    .session-row:hover { background: #252550; }
    .mcp-count {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 6px;
      background: #ff9100;
      color: #000;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 600;
    }
    .entry-count { color: #69f0ae; font-family: monospace; }
  </style>
</head>
<body>
  <div id="app">
    <h1>devharness Dashboard <span class="connected-badge" id="status-badge"></span></h1>
    <div id="content"></div>
  </div>
  <script src="/static/bundle.js"></script>
</body>
</html>`;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private buildDashboardState(): DashboardState {
    // Group sessions by cwd
    const projectMap = new Map<string, SessionInfo[]>();

    for (const session of this.sessions.values()) {
      const existing = projectMap.get(session.cwd) || [];
      existing.push(session);
      projectMap.set(session.cwd, existing);
    }

    // Build project list with issues
    const projects: ProjectInfo[] = [];
    for (const [cwd, sessions] of projectMap) {
      projects.push({
        cwd,
        sessions,
        issues: this.getIssuesForProject(cwd),
      });
    }

    // Sort projects by cwd
    projects.sort((a, b) => a.cwd.localeCompare(b.cwd));

    return {
      projects,
      hubPid: process.pid,
      hubPort: this.port,
      hubStartedAt: this.startedAt,
    };
  }

  private getIssuesForProject(cwd: string): { bugs: number; features: number } {
    try {
      const itemsDir = join(resolveStateDir(cwd), 'issues', 'items');
      if (!existsSync(itemsDir)) {
        return { bugs: 0, features: 0 };
      }

      let bugs = 0;
      let features = 0;

      for (const entry of readdirSync(itemsDir)) {
        if (!entry.endsWith('.md')) continue;

        const raw = readFileSync(join(itemsDir, entry), 'utf-8');
        const fm = parseIssueFrontmatter(raw);
        if (!fm) continue;

        // Only count active issues
        if (isCompletedStatus(fm.status)) continue;

        if (fm.type === 'bug') bugs++;
        else if (fm.type === 'feature') features++;
      }

      return { bugs, features };
    } catch {
      return { bugs: 0, features: 0 };
    }
  }

  private sendState(ws: WebSocket): void {
    const state = this.buildDashboardState();
    const message: WSMessage = { type: 'state', data: state };
    ws.send(JSON.stringify(message));
  }

  private broadcastUpdate(type: WSMessage['type'], data: any): void {
    const message: WSMessage = { type, data };
    const json = JSON.stringify(message);

    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  // Called when this hub's own session should be registered
  registerSelf(cwd: string, startedAt: number, sessionId?: string, shortId?: string): void {
    const sessionKey = sessionId || `pid-${process.pid}`;
    const session: SessionInfo = {
      pid: process.pid,
      ppid: process.ppid,
      sessionId,
      shortId,
      cwd,
      startedAt,
      lastHeartbeat: Date.now(),
      connections: [],
      allPids: [process.pid],
      allPpids: [process.ppid],
      servers: { [process.pid]: { ppid: process.ppid, build: RUNNING_BUILD } },
    };
    this.sessions.set(sessionKey, session);
    this.selfSessionKey = sessionKey;
  }

  // Update session info after session detection (replaces placeholder PID-based key)
  updateSessionInfo(sessionId: string, shortId: string): void {
    const existingSession = this.sessions.get(this.selfSessionKey);
    if (!existingSession) return;

    const oldKey = this.selfSessionKey;
    const newKey = sessionId;

    // If key is changing (from pid-based to sessionId-based), move the session
    if (newKey !== oldKey) {
      // Remove old entry and notify UI
      this.sessions.delete(oldKey);
      this.broadcastUpdate('session_removed', { sessionKey: oldKey, pid: existingSession.pid });
      this.selfSessionKey = newKey;
    }

    // Update session with real session info
    existingSession.sessionId = sessionId;
    existingSession.shortId = shortId;
    this.sessions.set(this.selfSessionKey, existingSession);

    // Broadcast new session to UI clients
    this.broadcastUpdate('session_added', existingSession);
  }

  // Session key for this hub's own session
  private selfSessionKey: string = '';

  // Update own session's state (called after each tool action)
  updateSelf(
    connections: SessionInfo['connections'],
    lastAction?: SessionInfo['lastAction'],
    sessionEntryCount?: number
  ): void {
    const session = this.sessions.get(this.selfSessionKey);
    if (session) {
      session.lastHeartbeat = Date.now();
      session.connections = connections;
      if (lastAction) {
        session.lastAction = lastAction;
      }
      if (sessionEntryCount !== undefined) {
        session.sessionEntryCount = sessionEntryCount;
      }
      this.broadcastUpdate('update', session);
    }
  }

  // Update just the session entry count (called from file watcher)
  updateSessionEntryCount(count: number): void {
    const session = this.sessions.get(this.selfSessionKey);
    if (session) {
      session.sessionEntryCount = count;
      this.broadcastUpdate('update', session);
    }
  }

  // Get all MCP PIDs for this hub's session (for duplicate detection)
  getAllPids(): number[] {
    const session = this.sessions.get(this.selfSessionKey);
    return session?.allPids || [process.pid];
  }

  /** By MCP pid, the parent and build file of each server of this hub's session. */
  getServers(): Record<string, ServerRecord> {
    return this.sessions.get(this.selfSessionKey)?.servers ?? {};
  }

  // Get all Claude session PIDs for this hub's session (for duplicate detection)
  getAllPpids(): number[] {
    const session = this.sessions.get(this.selfSessionKey);
    return session?.allPpids || [process.ppid];
  }
}
