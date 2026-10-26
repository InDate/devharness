# devharness MCP Server

Chrome DevTools Protocol debugging for JavaScript/TypeScript in Chrome, Node.js, or CDP-compatible environments - breakpoints, variable inspection, browser automation, dev server management, and record/replay verification.

**Quick start (web apps):**
1. `connection({ action: 'launch', connection: "my-web-app" })` - launches AND auto-connects, ready immediately (do not attach after this)
2. `navigate({ action: 'goto', connection: "my-web-app", url: "..." })` - also caches interactive elements for the page
3. `content({ action: 'findInteractive', connection: "my-web-app" })` / `content({ action: 'extractText', mode: 'outline', connection: "my-web-app" })` to read the page
4. Use other tools with `connection: "my-web-app"`

**Node.js:** start with `node --inspect=9229 app.js`, then `connection({ action: 'attach', connection: "my-web-app", port: 9229 })`.

Each tool's description, and the reply of its first use in a session, carry how to use it. The full reference is `docs/instructions.md` in the devharness package.

If devharness itself seems stuck or broken (not the target app), restart it yourself: `config({ action: 'restart' })` (falls back to `kill -USR2 $(cat .devharness/mcp-supervisor.pid)` if that's unavailable). This kills any Chrome instances it launched (relaunch with `connection` action `launch`); managed dev servers (`server` tool) survive this restart and reattach. Ending the session or `/reload-plugins` stops the servers this session started.
