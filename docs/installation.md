# Installation

## Claude Code CLI

```bash
claude mcp add devharness -- npx -y devharness
```

## Claude Desktop

Add to your config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "devharness": {
      "command": "npx",
      "args": ["-y", "devharness"]
    }
  }
}
```

Restart and ask Claude to debug your application.

## From Source

```bash
git clone https://github.com/InDate/devharness.git
cd devharness
npm install
npm run build
npm start
```

## Configuration

### Multi-Session Support

Each MCP server instance automatically uses a unique debugging port to prevent conflicts when running multiple LLM sessions simultaneously.

**Port Configuration:**
- **Auto-assigned**: Ports auto-assigned starting from 9222
- **Manual override**: Set `MCP_DEBUG_PORT` environment variable or configure in config file
- **Valid range**: 1024-65535

### Environment Variables

```bash
# Set specific debug port
export MCP_DEBUG_PORT=9223
```

### Config File

Create `.devharness/config.json` to customize settings:

```json
{
  "chrome": {
    "defaultDebugPort": 9222
  }
}
```

The `defaultDebugPort` sets the starting port for Chrome debugging. If the port is in use, the next available port is used automatically.

### Idle Sessions

An editor window left open for days keeps its devharness server alive, holding
Chrome instances, dev servers and monitor buffers nobody is using. Two things
stop that:

- **Idle suspend.** After two hours with no request from the client, the server
  releases what it holds - connections, the Chrome instances it launched,
  monitor buffers, and the dev servers it owns - and exits. The supervisor
  stays connected, so the MCP connection itself survives: the next tool call
  starts a fresh server. You will need to relaunch Chrome (`connection` action `launch`) and
  restart dev servers (`server({ action: 'start', serverId: '...' })`); their
  config is kept.
- **Shared dev servers are protected.** A dev server is only stopped when no
  other live session claims it or is working in its directory, so a window that
  goes idle never takes down a server another window is using. Ownership is
  tracked in `.devharness/server-claims/`, keyed by the supervisor process that
  owns each session.
- **Abandoned dev servers are collected.** A window closed for good used to
  leave its dev servers running until reboot. The next session in that
  directory now stops any whose owning sessions are all gone.
- **Orphan reaping.** When the client that launched devharness is gone, the
  server tree shuts itself down, rather than waiting for a stdin EOF that never
  arrives when an `npm exec` wrapper is holding the pipe open.

```json
{
  "session": {
    "idleSuspendMinutes": 120,
    "clientPollSeconds": 60
  }
}
```

Set `idleSuspendMinutes` to `0` to never suspend. Both values can also be set
via `CDP_TOOLS_IDLE_SUSPEND_MINUTES` and `CDP_TOOLS_CLIENT_POLL_SECONDS`, which
take precedence over the config file. Unlike most settings these are read by the
supervisor at startup, so a change takes effect on the next reconnect rather
than hot-reloading.

### Debug Logging

Enable debug logging to track server operations:

```javascript
// Enable debug logging
config({ action: 'setDebugLogging', enabled: true })

// Check status
config({ action: 'debugLoggingStatus' })
// Logs written to: .devharness/logs/debug.log
```

### Password Popup Prevention

Chrome is automatically configured to prevent password-related popups that can block automation:

- Password save prompts disabled
- Password leak detection disabled
- Mock keychain used on macOS

No configuration needed - this is enabled by default.
