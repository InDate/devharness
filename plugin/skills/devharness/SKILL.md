---
name: devharness
description: Drive and debug a running app via the devharness MCP server - launch or attach to Chrome and Node.js, set breakpoints and logpoints, inspect call stacks and variables, watch console and network, manage dev servers, replay any earlier tool call by its history index, and record reproduction sequences that verify a fix. Use whenever a task involves running or debugging a live app, reproducing or verifying a bug, re-driving setup you already did (relaunching, re-logging in, refilling a form), or the user mentions breakpoints, Chrome DevTools, CDP, replay sequences, or devharness tools (launchChrome, navigate, breakpoint, inspect, replay, server, issues, etc.).
compatibility: Requires the devharness MCP server to be connected (tools such as launchChrome, breakpoint, inspect, replay, server, issues). The shell commands need `devharness` on PATH (`npm i -g devharness`); without it use `npx -y devharness@<version> <command>`. Previously published as cdp-tools-mcp.
version: 0.9.15
---

# devharness

CDP debugging for JS/TS in Chrome, Node.js, or any CDP target.

## Quick start

Every tool takes `connectionReason` — the name you gave the connection.

```
launchChrome({ reference: "app" })              # launches AND connects; do NOT then call connectDebugger
navigate({ action: 'goto', connectionReason: "app", url })   # caches interactive elements
content({ action: 'findInteractive' })          # summary; filter with search/types
content({ action: 'extractText', mode: 'outline' })          # prefer over screenshot
```

Node: `node --inspect=9229 app.js` → `connectDebugger({ reference: "api", port: 9229 })`.
`connectDebugger` is only for existing Node/remote debuggers.

Launched without a reference? `tab({ action: 'rename', reference: "unnamed-connection-default", newReference: "app" })`.

Paused: `inspect({ action: 'getCallStack' })` → `getVariables` → `evaluateExpression`.
Watch: `console({ action: 'list' })`, `network({ action: 'list' })` (needs `network({ action: 'enable' })` first).
Inside a worker: `inspect({ action: 'listTargets' })` → `evaluateExpression({ target, expression })`, and `console({ action: 'list', target })` — a service worker's console reaches no page listener.

## `.devharness/` must be git-ignored

State lands in `.devharness/` — config, server claims, logs, sequences, issues. Machine-local; carries pids, ports, and local paths into what may be a public repo.

Before the first tool that writes there (`server`, `replay` record, `issues`, `setDebugLogging`) in a git repo:

```
git check-ignore -q .devharness && echo ignored || echo NOT ignored
git ls-files .devharness          # already tracked?
```

Not ignored → **ask** before adding it to `.gitignore`. Already tracked → say so; `git rm -r --cached .devharness` untracks, but anything pushed stays in history.

## Repeat instead of retyping

Every response footer carries its own index: `**Repeat:** replay({ action: 'repeat', indices: [58] })`. On every call, not just failures (`replay`'s own calls aren't recorded).

- `indices` takes a list: `[58, 59, 60, 61]` re-runs four steps in order
- Use it for anything you already did — relaunch, re-login, refilling a form, getting back to the bug. Retyped arguments drift from what actually ran
- `replay({ action: 'history' })` when indices scrolled away
- Each call replays on the connection it was recorded with, so pass `connectionReason` explicitly when driving several browsers — implicit calls have no connection to replay against
- Worth keeping: `replay({ action: 'create', name, indices })`

## Recovering from a failed call

Two mechanisms, two different failure points — don't mix them.

**Validation failed** (`MISSING_PARAMETERS`, `INVALID_PARAMS`) → the error carries a `continuationToken` and `missingParameters`. Resend only what was missing:
```
{ continuationToken: '<token>', <missing field(s)> }
```
Server merges and re-validates. Same token, repeat until it passes. Expires in 5 min.

**Guard blocked a valid call** (dead port, breakpoint pause) → it was already recorded. Acknowledge (`server({ action: 'acknowledgePort' })`, `acknowledgeStartup`), then use the footer's `replay` hint. Don't rebuild the arguments; don't use a `continuationToken` here.

## The event stream

Everything devharness pushes at you - a guard block, a message from another session - appends one JSON line to `~/.devharness/events/<sessionId>.jsonl`. One file, one watch, and any kind added later arrives on the same watch.

Installed as a plugin, a `SessionStart` hook prints that path and the `Monitor` call at the top of every session. Arm it when you see it:

```
Monitor({
  command: "mkdir -p ~/.devharness/events && touch <streamPath> && tail -f -n0 <streamPath>",
  description: "devharness events",
  persistent: true,
  timeout_ms: 3600000
})
```

Nothing is lost without it: blocks and messages still surface on your next devharness call. The watch is what makes them arrive while you are doing something else, which for a dev server that died an hour ago is the difference that matters.

Each line carries `kind` and, where there is one, `resolve` - the call that clears it. `kind: "block"` also carries `guard`, one of `port`, `breakpoint`, `pendingStartup`, `bug`, `duplicateSession`; blocks are deduplicated, one line per *new* block rather than one per blocked call. `kind: "message"` carries `from` and the message id.

## Talking to another devharness session

Two devharness sessions on this machine reach each other by mailbox id - the session hitting a devharness bug and the session working on devharness itself, for example.

`message({ action: 'sessions' })` lists who is reachable and prints this session's own mailbox path.

```
message({ action: 'send', to: 'a1b2c3d4', text: 'Repro: ...', waitForReplyMs: 120000 })
```

That holds the call open until something lands in this session's mailbox, then returns it; answer with `message({ action: 'reply', replyTo: '<id>', text: '...' })`. The wait returns on ANY arrival, not only a tagged reply - two sessions blocking at the same moment both release instead of both timing out.

An arriving message announces itself on the event stream, so the watch above covers it and there is no second watch to arm. `message({ action: 'read' })` is what takes them, advancing a cursor so each is returned once; the full history stays in the mailbox file.

## Running a tool from the shell

`devharness <command>` typed in a session's shell runs that tool **inside that session**, against the connections it already holds. The plugin does not put `devharness` on PATH - `npm i -g devharness` does, or run it as `npx -y devharness@<version> <command>`. The SessionStart hook reports which of those applies here. Candidates are the sessions rooted at the shell's directory or above it - project state such as issues and config resolves against the answering server's root - and the process tree picks among those, so `! devharness screenshot` uses the browser this session opened, not a new one. A directory no session is rooted in reports that rather than reaching another project.

- `devharness which` - which session this shell resolves to
- `devharness call <tool> '<json>'` - any tool: `devharness call config '{"action":"status"}'`
- `devharness sessions` / `send <id> "text"` / `read` / `reply <id> "text"` - the message tool, with `--wait=<ms>` to hold for an answer
- `devharness bug "<title>" [body words]` / `feature "<title>" [body words]` - files an acknowledged issue of that type; no sequence is recorded and Chrome stays closed
- `--session=<id>` names a session explicitly, `--json` prints the raw response, `--timeout=<ms>` bounds the call

Two differences from an MCP call. Guards do not apply - a dead dev server port, a paused breakpoint or a pending bug blocks a tool call through MCP and does not block this one. And a session the supervisor has suspended is not listening, so the CLI reports that rather than waiting.

## Restarting devharness

If devharness itself is stuck (not the target app), restart it — don't wait to be asked.

- `config({ action: 'restart' })` — SIGUSR2s the supervisor via `.devharness/mcp-supervisor.pid`; it replays the `initialize` handshake so the host never reconnects
- `CONFIG_RESTART_NOT_SUPERVISED` → `kill -USR2 $(cat .devharness/mcp-supervisor.pid)`
- `CONFIG_RESTART_STALE_PID` → supervisor died dirty; ask the user to run `/mcp`

**The triggering call returns an error — that's normal.** You get `MCP error -32000: MCP server is restarting...` instead of `CONFIG_RESTART_REQUESTED`, because the old process dies before flushing. Retry; the next call hits the new process. Expect a new PID in footers, and acknowledged port failures to reset.

`config({ action: 'status' })` reports version, entry file, its timestamp, and pids — check the timestamp before believing a rebuild landed; a build signals the supervisor in its own project's pidfile, not always this session's.

Restart kills Chrome instances this session launched (relaunch with `launchChrome`); managed servers survive and reattach. `config({ action: 'reload' })` hot-applies most config edits — restart is only needed for `tools.enabled`/`tools.disabled` or a genuinely stuck process.

## Practices

**Breakpoints** — conditional: `condition: "userId === '123'"`. Loops/hot paths: `setLogpoint` (20 executions default; `resetCounter` or `maxExecutions`). Clean up with `remove`, audit with `list`. CDP may snap to the nearest line — `validate` first. Source maps auto-load; `loadSourceMaps` to force. Paths are full URLs (`http://localhost:3000/app.js`) or `file://`.

**DOM/Event/XHR breakpoints** (Chrome only) — `setDOMBreakpoint` (`subtree-modified`, `attribute-modified`, `node-removed`), `setEventBreakpoint` (click, submit, input, keydown…), `setXHRBreakpoint` (URL substring). Example: `breakpoint({ action: 'setDOMBreakpoint', selector: '.todo-list', domBreakpointType: 'subtree-modified' })`. nodeIds die on reload.

**Expressions** — wrapped in try-catch, surface as `[Error: message]`. Find them: `console({ action: 'search', pattern: "Logpoint Error" })`.

**Element cache** — populated by goto/reload/back/forward, expires after 5 min.

**Modals** — `handleModals: true` on `input` click/type/hover, `dismissStrategy`: `auto` | `accept` | `reject` | `close` | `remove`. English-only, no Shadow DOM or iframes.

**Code search** — `inspect({ action: 'searchCode' | 'searchFunctions' })`, then `getSourceCode`.

**Connections** — `listConnections` → `switchConnection`. One connection per tab/process.

**Issues** — `comment` when you start (what you're changing, why) and when you finish (what changed, files, tests, anything contradicting the issue). The timeline is the durable record, not your diff. `resolve` waits on a browser overlay only a human can click — never call it unattended; `comment` instead.

## Patterns

| Task | Sequence |
|---|---|
| Bug | `launchChrome` → `goto` → `searchCode`/`searchFunctions` → `set`/`setLogpoint` → trigger → `getCallStack` + `getVariables` → `evaluateExpression` |
| Performance | `network enable` → `goto` → `network search` → `network get` (timing) → `setLogpoint` in slow paths |
| Frontend state | `dom querySelector` + `getProperties` → `storage getLocalStorage`/`getCookies` → `evaluateExpression` → `dom snapshot` |
| UI audit | `content({ action: 'verify' })` — dead buttons, touch targets, overflow, dead links, viewport. Filter: `checks: ['handlers','touch']` from `handlers`, `viewport`, `touch`, `overflow`, `clickability`, `links`, `scroll` |

## Load on demand

- Full tool/action catalogue: [references/tool-categories.md](references/tool-categories.md)
- Recording/replaying sequences — `saveAs`, per-step `connectionReason`, conditionals, verifying an issue fix: [references/sequences.md](references/sequences.md)
