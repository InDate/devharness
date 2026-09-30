# Troubleshooting

## Session Issues

### Chrome and my dev server closed while I was away

**Problem:** After a long break, connections are gone, Chrome is closed and a
dev server has stopped - but the MCP connection still works.

**Cause:** The session was suspended. With no request from the client for
`session.idleSuspendMinutes` (default 120), devharness releases what it holds
and exits; the supervisor stays connected and started a fresh server for your
next call.

**Solutions:**
- Relaunch Chrome (`connection({ action: 'launch' })`) and restart the dev server
  (`server({ action: 'start', serverId: '...' })`) - its config is kept.
- Raise or disable the threshold in `.devharness/config.json`:
  `{"session": {"idleSuspendMinutes": 0}}`. Read at supervisor startup, so it
  applies from the next reconnect.

A dev server another window is using is never stopped this way: it is only
released when no other live session claims it or is working in its directory.

### A dev server stopped when I opened a new session

**Problem:** Starting devharness in a project stopped a dev server that was
already running.

**Cause:** Every session that had claimed it was gone, so it was collected as
abandoned - otherwise a dev server from a window you closed days ago keeps
running until you reboot.

**Solutions:**
- Restart it (`server({ action: 'start', serverId: '...' })`).
- To keep a server outside this lifecycle, run it yourself rather than through
  the `server` tool; devharness only collects servers it manages, and only ones
  it can prove nobody is left to use.

## Chrome Connection Issues

### "Chrome is already running on port X"

**Solutions:**
- Use `browser({ action: 'kill', reason: "restart needed" })` to stop existing instance
- Launch on different port: `connection({ action: 'launch', port: 9224, name: 'new session' })`
- Check if another process is using the port: `lsof -i :9222`

### Chrome won't launch

**Solutions:**
- Check Chrome is installed in a standard location
- Verify no other Chrome debugging sessions are active
- Try `browser({ action: 'resetLauncher', reason: "stuck state" })` to reset launcher state

## Breakpoint Issues

### Breakpoint not hitting

**Problem:** Breakpoint set but never pauses

**Solutions:**
- Verify file URL matches exactly (use `searchCode` to find the right path)
- Check source maps are loading correctly
- Ensure code path is actually executed (add `console.log` to verify)
- Try setting logpoint first to confirm location is reachable

**Note:** Breakpoints survive rebuilds with cache-busting query params. If your bundler outputs `app.js?v=123` and rebuilds to `app.js?v=456`, existing breakpoints will automatically match the new script.

### Breakpoint shows as "pending"

**Problem:** Breakpoint status shows pending, not resolved

**Solutions:**
- The script may not be loaded yet - navigate to the page first
- Use `breakpoint({ action: 'waitForScript', url: '...' })` to wait for script to load
- Reload the page with `navigate({ action: 'reload' })`

### Wrong line number after setting breakpoint

**Problem:** CDP may map breakpoints to the nearest valid line

**Solutions:**
- Use `breakpoint({ action: 'validate', ... })` to check valid locations
- Set breakpoint on a line with executable code (not comments/whitespace)

## Element Issues

### Element not found

**Problem:** Selector doesn't match any elements

**Solutions:**
- Use `content({ action: 'findInteractive' })` to see available elements
- Check element is in viewport: might need to scroll first
- Wait for dynamic content: element may load asynchronously
- Try broader selector (class instead of ID)

### Cache not working

**Problem:** `findInteractive` shows "no cache" or stale data

**Solutions:**
- Cache expires after 5 minutes - navigate again to refresh
- Cache is page-specific - each URL has separate cache
- Clear navigation: `navigate({ action: 'goto', ... })` rebuilds cache

## Node.js Connection Issues

### Cannot connect to Node.js debugger

**Problem:** `connection({ action: 'attach' })` fails

**Solutions:**
- Ensure Node started with `--inspect` flag
- Check port number matches (default 9229)
- Verify Node process is still running
- Try `--inspect=0.0.0.0:9229` if connecting remotely

### Connection drops during debugging

**Solutions:**
- Check if Node process crashed (look at terminal output)
- Verify Node didn't restart (e.g., from nodemon)
- Reconnect with the same name: `connection({ action: 'attach', name: 'same ref', port: 9229 })`

### "Reference already in use" but no connection exists

**Problem:** Chrome was killed externally or tab was closed manually, but MCP still shows reference in use

**Solutions:**
- This is now auto-handled - stale connections are automatically detected and cleaned up
- Use `connection({ action: 'list' })`, which drops dead connections
- As fallback, use `browser({ action: 'kill', reason: "cleanup" })` then relaunch

## Replay Issues

### Replay times out

**Problem:** Replay hangs or times out

**Solutions:**
- Increase step timeout: `stepTimeout: 60000` (60 seconds)
- Increase total timeout: `totalTimeout: 600000` (10 minutes)
- Check if page is waiting for user interaction (modal blocking?)

### Stale callFrameId error

**Problem:** `getVariables` fails with invalid call frame

**Solutions:**
- This should be auto-fixed - replay replaces stale IDs automatically
- If still failing, ensure debugger is actually paused
- Check breakpoint was hit with `inspect({ action: 'getCallStack' })`

### Variables not substituted

**Problem:** Replay uses original values instead of substituted ones

**Solutions:**
- Variable names are generated as `var_<index>_<selector>`
- Use `replay({ action: 'get', name: '...' })` to see variable names
- Pass empty `variables: {}` to keep original values explicitly

## Console/Network Monitoring

### Console messages not appearing

**Solutions:**
- Console monitoring starts automatically on connection
- Check message type filter: `console({ action: 'list', type: 'log' })`
- Clear and retry: `console({ action: 'clear', reason: 'reset' })`

### Network requests missing

**Solutions:**
- Enable monitoring first: `network({ action: 'enable' })`
- Monitoring must be enabled before requests are made
- Check resource type filter if used

## Source Map Issues

### Source maps not loading

**Solutions:**
- Source maps load lazily - they load when needed
- Check file size limits: inline (1MB), file (10MB)
- Manually load: `source({ action: 'loadMaps', directory: './dist' })`

### Wrong file shown in call stack

**Solutions:**
- Verify source map is valid (check `.map` file exists and is valid JSON)
- Check `sourcesContent` is present in source map
- Try rebuilding with fresh source maps

## Server Management Issues

### Server won't start

**Problem:** `server({ action: 'start' })` fails

**Solutions:**
- Check working directory exists and is correct
- Verify the command works when run manually
- Check for port conflicts: `lsof -i :<port>`
- Check server logs: `server({ action: 'logs', serverId: '...' })`

### Docker server not detected

**Problem:** Docker container starts but port not detected

**Solutions:**
- Ensure port mapping is in the command: `-p 3000:3000`
- Runner may need explicit type: `runner: 'docker'`
- Check Docker is running: `docker ps`

### Port monitoring blocks all tools

**Problem:** Monitoring level is `block` and port went down

**Solutions:**
- Acknowledge the failure: `server({ action: 'acknowledgePort', port: <port> })`
- Check server status: `server({ action: 'list' })`
- Restart the server: `server({ action: 'restart', serverId: '...' })`

### Server logs not updating

**Solutions:**
- Logs are fetched incrementally (delta since last view)
- Use `lines: 100` to fetch all recent logs
- Clear logs: `server({ action: 'clearLogs', serverId: '...' })`

## General Tips

### Enable debug logging

```javascript
config({ action: 'setDebugLogging', enabled: true })
// Check logs at: .devharness/logs/debug.log
```

### Check connection status

```javascript
// List all connections
connection({ action: 'list' })

// Check specific connection
connection({ action: 'status', connectionReason: 'my-session' })
```

### Check Chrome status

```javascript
connection({ action: 'browsers' })
// Shows running instances, ports, and recent close events
```

### Reset everything

```javascript
// Kill all Chrome instances
browser({ action: 'kill', reason: "full reset" })

// Reset launcher state
browser({ action: 'resetLauncher', reason: "stuck" })

// Start fresh
connection({ action: 'launch', name: 'fresh start' })
```
