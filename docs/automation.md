# Browser Automation

## Navigation

```javascript
// Navigate - automatically caches clickable elements
navigate({
  action: 'goto',
  url: 'https://myapp.com/login',
  connectionReason: 'test-debug-session'
})
// Response: "144 total clickable elements (53 in viewport)"

// Reload page
navigate({ action: 'reload', connectionReason: 'test-debug-session' })

// Go back/forward
navigate({ action: 'back', connectionReason: 'test-debug-session' })
navigate({ action: 'forward', connectionReason: 'test-debug-session' })

// Get page info
navigate({ action: 'info', connectionReason: 'test-debug-session' })
```

## Finding Elements

```javascript
// Get summary of all interactive elements (default mode)
content({
  action: 'findInteractive',
  connectionReason: 'test-debug-session'
})

// Search all elements by text
content({
  action: 'findInteractive',
  search: 'login',
  connectionReason: 'test-debug-session'
})

// Filter by type
content({
  action: 'findInteractive',
  types: ['button', 'link'],
  connectionReason: 'test-debug-session'
})

// Find all input fields
content({
  action: 'findInteractive',
  types: ['text', 'email', 'password', 'textarea'],
  connectionReason: 'test-debug-session'
})
```

## Element Interaction

```javascript
// Click element
input({
  action: 'click',
  selector: '#login-button',
  connectionReason: 'test-debug-session'
})

// Type text
input({
  action: 'type',
  selector: '#username',
  text: 'testuser@example.com',
  connectionReason: 'test-debug-session'
})

// Press key
input({
  action: 'press',
  key: 'Enter',
  connectionReason: 'test-debug-session'
})

// Hover
input({
  action: 'hover',
  selector: '.dropdown-menu',
  connectionReason: 'test-debug-session'
})
```

## Modal Handling

Auto-dismiss modals during interactions:

```javascript
input({
  action: 'click',
  selector: '#submit',
  handleModals: true,
  dismissStrategy: 'auto',  // or 'accept', 'reject', 'close', 'remove'
  connectionReason: 'test-debug-session'
})
```

**Strategies:**
- `auto`: Smart detection (cookies -> accept, GDPR -> accept, etc.)
- `accept`: Click accept/agree/ok buttons
- `reject`: Click reject/decline buttons
- `close`: Click X/close buttons
- `remove`: Remove modal from DOM

**Limitations:** English only, no Shadow DOM/iframe support

## DOM Inspection

```javascript
// Query selector
dom({
  action: 'querySelector',
  selector: '#main-content',
  connectionReason: 'test-debug-session'
})

// Get element properties
dom({
  action: 'getProperties',
  selector: '#user-form',
  connectionReason: 'test-debug-session'
})

// Get full DOM snapshot
dom({
  action: 'snapshot',
  maxDepth: 5,
  connectionReason: 'test-debug-session'
})
```

## Screenshots

```javascript
// Full page screenshot
screenshot({
  action: 'fullPage',
  connectionReason: 'test-debug-session'
})

// Viewport only
screenshot({
  action: 'viewport',
  connectionReason: 'test-debug-session'
})

// Specific element
screenshot({
  action: 'element',
  selector: '#chart',
  connectionReason: 'test-debug-session'
})

// PDF export
screenshot({
  action: 'pdf',
  connectionReason: 'test-debug-session'
})
```

## Console Monitoring

Console output uses compact formats to reduce token usage:

- **list/recent/search**: CSV format with token counts per message
- **get**: TOON format with smart truncation for large messages

```javascript
// List console messages (CSV output)
console({
  action: 'list',
  type: 'error',
  limit: 50,
  connectionReason: 'test-debug-session'
})
// Output: id,type,preview,tokens,truncated
// cm-1,error,"Failed to fetch user data",25,false

// Get recent messages (CSV output)
console({
  action: 'recent',
  count: 20,
  connectionReason: 'test-debug-session'
})

// Search console (CSV output)
console({
  action: 'search',
  pattern: 'API.*failed',
  connectionReason: 'test-debug-session'
})

// Get full message details (TOON format with smart truncation)
console({
  action: 'get',
  id: 'cm-1',
  connectionReason: 'test-debug-session'
})
// For messages >100 tokens, shows summary with extraction helpers

// Extract specific portion of large message
console({
  action: 'get',
  id: 'cm-1',
  textOffset: 0,
  textLimit: 500,
  connectionReason: 'test-debug-session'
})

// Get specific args index
console({
  action: 'get',
  id: 'cm-1',
  argsIndex: 0,
  connectionReason: 'test-debug-session'
})

// Set object expansion depth (1-10, default: 2)
console({
  action: 'setObjectDepth',
  depth: 4,
  connectionReason: 'test-debug-session'
})

// Clear console
console({
  action: 'clear',
  reason: 'Starting fresh test',
  connectionReason: 'test-debug-session'
})
```

## Network Monitoring

```javascript
// Enable monitoring
network({
  action: 'enable',
  connectionReason: 'test-debug-session'
})

// List requests
network({
  action: 'list',
  resourceType: 'xhr',
  connectionReason: 'test-debug-session'
})

// Search requests
network({
  action: 'search',
  pattern: '/api/users',
  connectionReason: 'test-debug-session'
})

// Get specific request with body
network({
  action: 'get',
  id: 'request-123',
  includeBody: true,
  connectionReason: 'test-debug-session'
})

// Set network conditions (throttling)
network({
  action: 'setConditions',
  preset: 'slow-3g',
  connectionReason: 'test-debug-session'
})
```

## Storage

```javascript
// Get localStorage
storage({
  action: 'getLocalStorage',
  connectionReason: 'test-debug-session'
})

// Set localStorage
storage({
  action: 'setLocalStorage',
  key: 'theme',
  value: 'dark',
  connectionReason: 'test-debug-session'
})

// Get cookies
storage({
  action: 'getCookies',
  url: 'https://myapp.com',
  connectionReason: 'test-debug-session'
})

// Set cookie
storage({
  action: 'setCookie',
  name: 'session',
  value: 'abc123',
  domain: 'myapp.com',
  connectionReason: 'test-debug-session'
})

// Clear storage
storage({
  action: 'clear',
  types: ['localStorage', 'cookies'],
  reason: 'Reset test state',
  connectionReason: 'test-debug-session'
})
```

## Tab Management

Each tab is a connection:

```javascript
// Open a new tab in the Chrome already running on port 9222
connection({
  action: 'launch',
  name: 'second tab page',
  port: 9222,
  url: 'https://site2.com'
})

// List connections, with each one's URL and title
connection({ action: 'list' })

// Make a connection active and select its page
connection({
  action: 'switch',
  connectionReason: 'second-tab-page'
})

// Rename a connection
connection({
  action: 'rename',
  connectionReason: 'second-tab-page',
  name: 'checkout page tab'
})

// Close a connection; the last one in a Chrome kills that Chrome
connection({
  action: 'close',
  connectionReason: 'checkout-page-tab',
  reason: 'checkout flow checked'
})
```

## Automated Testing Pattern

1. **Navigate with element caching**
```javascript
navigate({ action: 'goto', url: 'https://myapp.com/signup', connectionReason: 'test-flow-run' })
```

2. **Find form elements from cache**
```javascript
content({ action: 'findInput', search: 'email', connectionReason: 'test-flow-run' })
```

3. **Fill form**
```javascript
input({ action: 'type', selector: '#email', text: 'test@example.com', connectionReason: 'test-flow-run' })
input({ action: 'type', selector: '#password', text: 'testpass123', connectionReason: 'test-flow-run' })
```

4. **Submit and monitor**
```javascript
input({ action: 'click', selector: '#submit-button', connectionReason: 'test-flow-run' })
console({ action: 'recent', count: 10, connectionReason: 'test-flow-run' })
network({ action: 'search', pattern: '/api/signup', connectionReason: 'test-flow-run' })
```

## Server Management

Manage development servers across multiple MCP sessions:

```javascript
// Start a server (any command)
server({
  action: 'start',
  command: 'npm run dev',
  cwd: '/path/to/project',
  id: 'next-frontend'
})

// Start with environment variables
server({
  action: 'start',
  command: 'flask run',
  cwd: '/path/to/api',
  id: 'flask-api',
  env: { FLASK_DEBUG: '1' }
})

// List running servers
server({ action: 'list' })

// Get server logs (delta since last view)
server({ action: 'logs', serverId: 'next-frontend' })

// Get all logs
server({ action: 'logs', serverId: 'next-frontend', lines: 100 })

// Stop a server
server({ action: 'stop', serverId: 'next-frontend' })

// Restart a server
server({ action: 'restart', serverId: 'flask-api' })

// Enable auto-start on MCP startup
server({ action: 'setAutoRun', serverId: 'next-frontend', autoRun: true })

// Remove server from config
server({ action: 'remove', serverId: 'old-server' })

// Stop all servers
server({ action: 'stopAll' })
```

### Docker Support

Run Docker containers and Docker Compose stacks:

```javascript
// Docker container
server({
  action: 'start',
  command: 'docker run -p 3000:3000 myimage',
  id: 'docker-app',
  runner: 'docker'  // Optional - auto-detected from command
})

// Docker Compose
server({
  action: 'start',
  command: 'docker compose up',
  cwd: '/path/to/project',
  id: 'compose-stack',
  runner: 'docker-compose'  // Optional - auto-detected
})
```

### Port Monitoring

Monitor ports to detect server failures:

```javascript
// Start monitoring with different severity levels
server({
  action: 'monitorPort',
  port: 3000,
  monitoringLevel: 'block',  // or 'error' or 'inform'
  description: 'Frontend dev server'
})

// Monitoring levels:
// - 'inform': Info message prepended to tool responses
// - 'error': Error message prepended to tool responses
// - 'block': All tools blocked until acknowledged

// List monitored ports
server({ action: 'listMonitored' })

// Acknowledge a port failure (unblocks tools if level is 'block')
server({ action: 'acknowledgePort', port: 3000 })

// Stop monitoring
server({ action: 'unmonitorPort', port: 3000 })
```

### Auto-Start with Monitoring

```javascript
// Start server and auto-monitor its port
server({
  action: 'start',
  command: 'npm run dev',
  cwd: '/path/to/project',
  id: 'my-app',
  monitorPort: true  // Auto-adds detected port to monitoring
})
```

### Cross-Directory Access

When running MCP from a different directory than where the server was started:

```javascript
// Access servers using global state
server({ action: 'list', global: true })
server({ action: 'logs', serverId: 'my-app', global: true })
server({ action: 'stop', serverId: 'my-app', global: true })
```

## Configuration Management

Manage devharness configuration across projects:

```javascript
// Check where config is loaded from
config({ action: 'status' })

// View current configuration
config({ action: 'show' })

// Switch to project-local config
config({ action: 'useLocal' })

// Switch to global config (~/.devharness/config.json)
config({ action: 'useGlobal' })

// Reset config to defaults
config({ action: 'reset' })

// Create a timestamped backup
config({ action: 'backup' })

// Copy global config to local project
config({ action: 'cloneFromGlobal' })
```

### Configuration Locations

- **Local**: `.devharness/config.json` in the working directory
- **Global**: `~/.devharness/config.json` in your home directory

When a local config doesn't exist, it's automatically seeded from global settings. The `configLocation` setting persists your preference.

## Performance Investigation Pattern

1. **Enable network monitoring**
```javascript
network({ action: 'enable', connectionReason: 'perf-check-run' })
```

2. **Navigate and capture requests**
```javascript
navigate({ action: 'goto', url: 'http://localhost:3000', connectionReason: 'perf-check-run' })
```

3. **Find slow requests**
```javascript
network({ action: 'list', connectionReason: 'perf-check-run' })
// Look for long timing.duration values
```

4. **Set logpoints in suspect code**
```javascript
breakpoint({
  action: 'setLogpoint',
  url: 'http://localhost:3000/api-client.js',
  lineNumber: 75,
  logMessage: 'API call started at {Date.now()}',
  connectionReason: 'perf-check-run'
})
```
