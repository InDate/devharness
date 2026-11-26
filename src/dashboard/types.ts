/**
 * Dashboard Types
 * Shared interfaces for the dashboard hub, clients, and frontend
 */

export type ConnectionState = 'active' | 'idle' | 'paused';

export interface ActionInfo {
  tool: string;
  timestamp: number;
  connectionReference?: string;
}

export interface ConnectionInfo {
  reference: string;
  type: 'chrome' | 'node' | 'unknown';
  state: ConnectionState;
  createdAt: number;
  lastActivityAt: number;
}

export interface SessionInfo {
  pid: number;               // MCP process ID
  ppid?: number;             // Claude session process ID (parent)
  sessionId?: string;        // Full UUID from Claude Code
  shortId?: string;          // First 8 chars for display
  cwd: string;
  startedAt: number;
  lastHeartbeat: number;
  connections: ConnectionInfo[];
  lastAction?: ActionInfo;
  sessionEntryCount?: number;  // Count of new entries in session file since watching started
  allPids?: number[];          // All MCP PIDs that have reported for this session
  allPpids?: number[];         // All Claude session PIDs (parents)
  /** By MCP pid: its parent and the build file it runs, for the servers that report one. */
  servers?: Record<string, ServerRecord>;
}

/** One MCP server of a session: its parent pid and the build file it runs. */
export interface ServerRecord {
  ppid?: number;
  build?: string;
}

export interface ProjectInfo {
  cwd: string;
  sessions: SessionInfo[];
  issues: {
    bugs: number;
    features: number;
  };
}

export interface HubLockData {
  pid: number;
  port: number;
  startedAt: string;
}

export interface HeartbeatPayload {
  pid: number;
  ppid?: number;             // Claude session process ID (parent)
  /** The build file this server runs. */
  build?: string;
  sessionId?: string;
  shortId?: string;
  cwd: string;
  startedAt: number;
  connections: ConnectionInfo[];
  lastAction?: ActionInfo;
  sessionEntryCount?: number;
}

export interface DashboardState {
  projects: ProjectInfo[];
  hubPid: number;
  hubPort: number;
  hubStartedAt: number;
}

// WebSocket message types (Hub → Browser UI)
export type WSMessageType = 'state' | 'update' | 'session_added' | 'session_removed';

export interface WSMessage {
  type: WSMessageType;
  data: DashboardState | SessionInfo | { pid: number };
}

// MCP Client ↔ Hub WebSocket message types
export type MCPMessageType = 'mcp_heartbeat' | 'mcp_heartbeat_ack' | 'need_new_hub';

export interface MCPHeartbeatMessage {
  type: 'mcp_heartbeat';
  payload: HeartbeatPayload;
}

export interface MCPHeartbeatAckMessage {
  type: 'mcp_heartbeat_ack';
  allPids: number[];
  allPpids: number[];
  servers?: Record<string, ServerRecord>;
}

export interface MCPNeedNewHubMessage {
  type: 'need_new_hub';
}

export type MCPMessage = MCPHeartbeatMessage | MCPHeartbeatAckMessage | MCPNeedNewHubMessage;
