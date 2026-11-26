/**
 * Dashboard Client
 * Connects to the dashboard hub via WebSocket for real-time updates
 */

import WebSocket from 'ws';
import type { HeartbeatPayload, ConnectionInfo, ActionInfo, MCPMessage, MCPHeartbeatMessage, ServerRecord } from './types.js';
import { RUNNING_BUILD } from './running-build.js';

const RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_ATTEMPTS = 3;

export class DashboardClient {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private lastAction: ActionInfo | undefined;
  private getConnections: () => ConnectionInfo[];
  private sessionId?: string;
  private shortId?: string;
  private sessionEntryCount = 0;
  private allPids: number[] = [];
  private allPpids: number[] = [];
  private servers: Record<string, ServerRecord> = {};
  private ppid: number;
  private onHubDown?: () => void;
  private hubDownTriggered = false;
  private connected = false;

  constructor(
    private pid: number,
    private cwd: string,
    private startedAt: number,
    hubPort: number,
    connectionGetter: () => ConnectionInfo[],
    sessionId?: string,
    shortId?: string,
    onHubDown?: () => void
  ) {
    this.wsUrl = `ws://localhost:${hubPort}/mcp-ws`;
    this.getConnections = connectionGetter;
    this.sessionId = sessionId;
    this.shortId = shortId;
    this.ppid = process.ppid;
    this.onHubDown = onHubDown;
  }

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          // Send initial heartbeat
          this.sendHeartbeat();
          resolve(true);
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.handleDisconnect();
        });

        this.ws.on('error', () => {
          this.connected = false;
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as MCPMessage;

      switch (message.type) {
        case 'mcp_heartbeat_ack':
          if ('allPids' in message) {
            this.allPids = message.allPids;
          }
          if ('allPpids' in message) {
            this.allPpids = message.allPpids;
          }
          this.servers = message.servers ?? {};
          break;

        case 'need_new_hub':
          // Hub is shutting down, trigger failover
          if (this.onHubDown && !this.hubDownTriggered) {
            this.hubDownTriggered = true;
            console.error('[devharness] Hub shutting down, triggering failover');
            this.onHubDown();
          }
          break;
      }
    } catch {
      // Ignore invalid messages
    }
  }

  private handleDisconnect(): void {
    this.ws = null;

    // Try to reconnect
    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect().catch(() => {
          // Reconnect failed
        });
      }, RECONNECT_DELAY);
    } else {
      // Max reconnect attempts reached, trigger failover
      if (this.onHubDown && !this.hubDownTriggered) {
        this.hubDownTriggered = true;
        console.error('[devharness] Hub unreachable after reconnect attempts, triggering failover');
        this.onHubDown();
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload: HeartbeatPayload = {
      pid: this.pid,
      ppid: this.ppid,
      build: RUNNING_BUILD,
      sessionId: this.sessionId,
      shortId: this.shortId,
      cwd: this.cwd,
      startedAt: this.startedAt,
      connections: this.getConnections(),
      lastAction: this.lastAction,
      sessionEntryCount: this.sessionEntryCount,
    };

    const message: MCPHeartbeatMessage = {
      type: 'mcp_heartbeat',
      payload,
    };

    this.ws.send(JSON.stringify(message));
  }

  reportAction(tool: string, connectionReference?: string): void {
    this.lastAction = {
      tool,
      timestamp: Date.now(),
      connectionReference,
    };

    // Send immediate update
    this.sendHeartbeat();
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getHubUrl(): string {
    return this.wsUrl.replace('ws://', 'http://').replace('/mcp-ws', '');
  }

  updateSessionEntryCount(count: number): void {
    this.sessionEntryCount = count;
    // Send immediate update
    this.sendHeartbeat();
  }

  updateSessionInfo(sessionId: string, shortId: string): void {
    this.sessionId = sessionId;
    this.shortId = shortId;
    // Send immediate update with new session info
    this.sendHeartbeat();
  }

  getAllPids(): number[] {
    return this.allPids;
  }

  getAllPpids(): number[] {
    return this.allPpids;
  }

  /** By MCP pid, the parent and build file of each server of this session, as the hub last acknowledged. */
  getServers(): Record<string, ServerRecord> {
    return this.servers;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getShortId(): string | undefined {
    return this.shortId;
  }

  getPid(): number {
    return this.pid;
  }

  getPpid(): number {
    return this.ppid;
  }
}
