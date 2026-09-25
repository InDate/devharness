# devharness Debugger Usage

Chrome DevTools Protocol debugging for JavaScript/TypeScript in Chrome, Node.js, or CDP-compatible environments.

## Quick Start

**Web apps (most common):**
```
1. launchChrome({ reference: "your-descriptive-name" })  # Auto-connects, ready immediately
2. navigate({ action: 'goto', connectionReason: "your-descriptive-name", url: "..." })
   # Navigation automatically caches interactive elements (links, buttons, inputs) for the page
3. content({ action: 'findInteractive', connectionReason: "your-descriptive-name" })
   # Shows summary of all interactive elements. Use search/types to filter
4. content({ action: 'extractText', mode: 'outline' })  # Read page content (preferred over screenshot)
5. Use other tools as needed with connectionReason parameter
```

**Alternative (rename later):**
```
1. launchChrome()                                  # Uses default "unnamed-connection-default"
2. tab({ action: 'rename', reference: "unnamed-connection-default", newReference: "your-name" })
3. Use other tools with connectionReason: "your-name"
```

**Node.js debugging:**
```
1. Start app: node --inspect=9229 app.js
2. connectDebugger({ reference: "my-app-debug", port: 9229 })
3. breakpoint({ action: 'set', connectionReason: "my-app-debug", ... })
```

## Basic Workflow

1. **Connect**:
   - `launchChrome({ reference: "name" })` - Launches AND auto-connects (ready immediately, don't call connectDebugger)
   - `connectDebugger({ reference: "name" })` - Only for existing Node.js/remote debuggers
2. **Navigate & interact**: Use connectionReason in all tool calls
   - `navigate({ action: 'goto', connectionReason: "name", url: "..." })`
   - `input({ action: 'click', connectionReason: "name", selector: "..." })`
3. **Debug**: `breakpoint({ action: 'set', connectionReason: "name", ... })`
4. **Inspect when paused**: `inspect({ action: 'getCallStack', ... })` → `inspect({ action: 'getVariables', ... })`
5. **Monitor**: `console({ action: 'list', connectionReason: "name" })`, `network({ action: 'list', connectionReason: "name" })`

## Key Practices

**Breakpoints:**
- Use conditional: `breakpoint({ action: 'set', condition: "userId === '123'" })`
- Prefer `breakpoint({ action: 'setLogpoint' })` for loops/high-frequency code
- Clean up with `breakpoint({ action: 'remove' })` or check `breakpoint({ action: 'list' })`

**DOM/Event/XHR Breakpoints (Chrome only):**
- `breakpoint({ action: 'setDOMBreakpoint' })`: Pause when element changes
  - `subtree-modified`: Children added/removed
  - `attribute-modified`: Attributes changed (class, style, etc.)
  - `node-removed`: Element deleted from DOM
- `breakpoint({ action: 'setEventBreakpoint' })`: Pause when events fire (click, submit, input, keydown, etc.)
- `breakpoint({ action: 'setXHRBreakpoint' })`: Pause when XHR/Fetch URL contains pattern
- Example: `breakpoint({ action: 'setDOMBreakpoint', selector: '.todo-list', domBreakpointType: 'subtree-modified' })`
- Note: DOM breakpoints use nodeIds which are invalidated on page reload

**Code search:**
- `inspect({ action: 'listTargets' })`: List worker targets (service, dedicated, shared)
- `inspect({ action: 'evaluateExpression', target })`: Evaluate inside a worker, addressed by target id or a URL substring
- `console({ action: 'list', target })`: Read a worker's console, which reaches no page listener
- `inspect({ action: 'searchCode' })`: Find patterns
- `inspect({ action: 'searchFunctions' })`: Locate definitions
- `getSourceCode`: View context

**Modal handling:**
- Use `handleModals: true` on `input({ action: 'click' | 'type' | 'hover' })`
- Strategies: `auto` (smart), `accept`, `reject`, `close`, `remove`
- Example: `input({ action: 'click', selector: '.btn', handleModals: true, dismissStrategy: 'auto' })`
- Limitation: English-only, no Shadow DOM/iframes

**Multiple connections:**
- `listConnections` → `switchConnection`
- Each connection = separate tab/process

## Common Patterns

**Bug debugging:**
1. `launchChrome` → `navigate({ action: 'goto' })`
2. `inspect({ action: 'searchCode' | 'searchFunctions' })`
3. `breakpoint({ action: 'set' | 'setLogpoint' })`
4. Trigger bug
5. `inspect({ action: 'getCallStack' })` + `inspect({ action: 'getVariables' })`
6. `inspect({ action: 'evaluateExpression' })`

**Performance:**
1. `network({ action: 'enable' })`
2. `navigate({ action: 'goto' })`
3. `network({ action: 'search' })` (find slow)
4. `network({ action: 'get' })` (timing)
5. `breakpoint({ action: 'setLogpoint' })` in slow paths

**Frontend state:**
1. `dom({ action: 'querySelector' })` + `dom({ action: 'getProperties' })`
2. `storage({ action: 'getLocalStorage' })` + `storage({ action: 'getCookies' })`
3. `inspect({ action: 'evaluateExpression' })`
4. `dom({ action: 'snapshot' })`

**UI verification:**
1. `content({ action: 'verify' })` - Run all default checks
2. Reports: dead buttons, small touch targets, overflow clipping, dead links, viewport issues
3. Filter checks: `checks: ['handlers', 'touch']` for specific issues
4. Available checks: `handlers`, `viewport`, `touch`, `overflow`, `clickability`, `links`, `scroll`

## Important Notes

- **After `launchChrome()`**: You are ALREADY connected. Do NOT call `connectDebugger()`. Use the `reference` parameter when launching, or rename later with `tab({ action: 'rename' })`
- **Interactive elements cache**: Navigation (goto, reload, back, forward) automatically caches all interactive elements. Cache expires after 5 minutes. `findInteractive` shows a summary by default; use `search` or `types` parameters to filter elements
- **Logpoint limits**: Default 20 executions. Use `breakpoint({ action: 'resetCounter' })` or adjust `maxExecutions`
- **Expression failures**: Wrapped in try-catch, shows `[Error: message]`. Search: `console({ action: 'search', pattern: "Logpoint Error" })`
- **CDP line mapping**: May map to nearest valid line. Use `breakpoint({ action: 'validate' })` first
- **Source maps**: Auto-handled. Use `loadSourceMaps` for manual
- **File paths**: Full URLs (`http://localhost:3000/app.js`) or `file://`
- **Network monitoring**: Must enable with `network({ action: 'enable' })`
- **Working an issue**: `comment` on it as you go - once when you start (what you're about to change and why) and once when you finish (what you actually changed, files touched, tests added, and anything that contradicts the issue as written). The issue is the durable record; someone reviewing later reads the timeline, not your diff
- **Closing an issue**: `issues({ action: 'resolve' })` waits on a browser overlay only a human can click - don't call it unattended, use `issues({ action: 'comment' })` to record findings instead

## Recovering from a failed tool call

- **Missing/invalid parameters**: the error includes a `continuationToken` and `missingParameters` (name/type/description/enum). Retry with just `{ continuationToken, <missing/bad field(s)> }` - don't resend everything. Expires after 5 min.
- **A validated call gets blocked by a guard** (port failure, dead server, breakpoint pause): the response footer shows `**Repeat:** replay({ action: 'repeat', indices: [N] })`. Acknowledge the guard (e.g. `server({ action: 'acknowledgePort' })`), then use that hint to resume the exact call. Don't reuse a `continuationToken` here - that's for fixing bad input, not for retrying an already-valid call.

## The event stream

Everything devharness pushes - a guard block, a message from another session, an annotation picked in the browser - appends one JSON line to `~/.devharness/events/<sessionId>.jsonl`. One file per session, so one watch covers every kind, including kinds added later.

Installed as a plugin, a `SessionStart` hook (`plugin/hooks/session-start.mjs`) creates that file and prints the `Monitor` call as session context before the first turn. In Claude Code, arm it as the session's first tool call:

```
Monitor({
  command: "mkdir -p ~/.devharness/events && touch <streamPath> && tail -f -n0 <streamPath>",
  description: "devharness events",
  persistent: true,
  timeout_ms: 3600000
})
```

With no watch, each event reaches the session only on its next devharness call, after the moment it was about. A Monitor expires at its timeout, so the expiry notice is the cue to arm it again. `bench({ action: 'start' })` counts the processes reading the stream and prints the call at the head of its response when the count is zero.

Line kinds:

```json
{"ts":"...","kind":"block","guard":"pendingStartup","tool":"navigate","detail":"died before port detected: \"web\"","resolve":"server({ action: 'acknowledgeStartup', serverId: 'web' })"}
{"ts":"...","kind":"message","from":"66ba2d65","id":"d94924a8-...","detail":"Message from 66ba2d65: ...","resolve":"message({ action: 'read' })"}
{"ts":"...","kind":"annotation","annotationId":"...","connection":"app","url":"http://localhost:5173/","tick":300,"comment":"flashes empty here","selector":"#row-3 > span","component":"StatusRow","detail":"StatusRow #row-3 > span - \"flashes empty here\""}
```

`guard` is one of `port`, `breakpoint`, `pendingStartup`, `bug`, `duplicateSession`. Blocks are deduplicated: one line per *new* block, not one per blocked call. Any client can tail the file.

## Restarting devharness

If devharness itself seems stuck or broken (not the target app), restart it yourself rather than asking the user to reconnect: `config({ action: 'restart' })`. Falls back to `kill -USR2 $(cat .devharness/mcp-supervisor.pid)` via Bash if that action reports `CONFIG_RESTART_NOT_SUPERVISED` (e.g. a bare `node build/index.js`, not through the supervisor). Editing devharness's own source and running `npm run build` triggers the same restart automatically via its postbuild hook - `config({ action: 'status' })` reports which build is actually answering (entry file, its timestamp, server and supervisor pids), so a rebuild that signalled the wrong supervisor is visible rather than silent. Either way, this kills any Chrome instances it launched (relaunch with `launchChrome`) but managed dev servers (`server` tool) survive and reattach automatically.

## Tool Categories

Most tools are **grouped**: one tool name plus an `action` param, e.g.
`navigate({ action: 'goto', url })`, not a separate `navigateTo` tool. The
actions below are the complete enums accepted by each tool.

Nearly every tool also takes `connectionReason` to pick which connection it
runs against (see Quick Start).

**Connection**: `launchChrome`, `killChrome`, `resetChromeLauncher`, `getChromeStatus`, `connectDebugger`, `disconnectDebugger`, `getDebuggerStatus`, `listConnections`, `switchConnection`
- These are individual tools, not actions
- `launchChrome` also connects - don't follow it with `connectDebugger`
- `launchChrome({ profile: 'device-a' })` uses a **named persistent profile**: a stable user-data-dir under `~/.devharness/profiles` (override per project with `chrome.persistentProfileRoot`) that survives across runs, so logins, cookies and IndexedDB persist. Naming it is what makes it persistent - there is no separate flag. It does not pin a port. Only one live Chrome may hold a profile at a time. Unnamed launches stay throwaway and are deleted on exit
- `launchChrome({ port, forceNewInstance: true })` honours that exact port and errors if it is already taken, rather than quietly moving to another one

**Tab**: `tab` (actions: list, create, rename, switch, close)

**Breakpoint**: `breakpoint` (actions: set, remove, list, setLogpoint, validate, resetCounter, waitForScript, setDOMBreakpoint, setEventBreakpoint, setXHRBreakpoint, await)
- `waitForScript`: block until a script URL loads, so you can breakpoint code that isn't parsed yet
- `await`: wait for a breakpoint to be hit rather than polling
- `setLogpoint`: non-pausing logging with `{expr}` interpolation, `maxExecutions` to cap noise

**Execution**: `execution` (actions: pause, resume, stepOver, stepInto, stepOut, acknowledge)

**Inspection**: `inspect` (actions: getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions)
- `evaluateExpression` awaits a returned Promise by default (async IIFEs resolve to their settled value; a rejection is reported as the expression's own error). Pass `awaitPromise: false` to inspect the Promise object itself. While paused at a breakpoint only already-settled promises can be resolved - a pending one fails fast because the event loop is stopped

**Source**: `getSourceCode`, `loadSourceMaps`
- Individual tools, not actions

**Console**: `console` (actions: list, get, recent, search, clear, setObjectDepth)

**Network**: `network` (actions: list, get, search, enable, disable, setConditions)

**Proxy**: `proxy` (actions: status, events, sockets, body, hold, holdFrame, release, holds)
- Needs a browser launched with `launchChrome({ proxy: true })`. Holds what reached the outside world, where `network` reads what CDP saw
- An event row carries the step that owns it, a level (`observed`, `likely`, `positional`, `unprompted`) read from stored evidence, and what the page says started it (`input`, `timer`, `parser`, `preload`, `script`)
- A timer-rooted request or send owns nothing and opens no allowance, so an app's own polling and heartbeats stay out of every step
- `hold` answers a URL with a value instead of reaching the server; `holdFrame` replaces or drops one socket message
- `sockets` reads each socket's shape from its own frames: `reply` means every arrival was accounted to a send, `push` means something arrived unasked so arrival names no cause

**Page**: `navigate` (actions: goto, reload, back, forward, info)

**DOM**: `dom` (actions: querySelector, getProperties, snapshot)

**Content**: `content` (actions: extractText, findInteractive, verify, parse)

**Screenshot**: `screenshot` (actions: fullPage, viewport, element, pdf)

**Input**: `input` (actions: click, type, press, hover, focus, focusNext, focusPrevious, drag, scroll, mousemove, pinch, tap, swipe)
- `tap` / `swipe`: real touch events via `Input.dispatchTouchEvent`. Mouse actions never produce touchstart/touchmove, so a component listening only for touch cannot be driven by `click` or `drag`. `tap` takes a selector or x/y; `swipe` takes `from`/`to` and `steps` (default 10) and emits touchstart, N touchmove, touchend

**Modal**: `detectModals`, `dismissModal`
- Individual tools, not actions

**Storage**: `storage` (actions: getCookies, setCookie, getLocalStorage, setLocalStorage, removeLocalStorage, getSessionStorage, setSessionStorage, removeSessionStorage, idbListDatabases, idbListStores, idbGet, idbGetAll, idbPut, idbDelete, clear)
- IndexedDB reads return typed descriptors for values JSON can't express - `{__type:'CryptoKey', algorithm, extractable, usages}` and analogues for Blob/ArrayBuffer/Map/Set/Date - so a non-extractable key is still observable. `idbPut` accepts JSON-expressible values only
- A read never creates a database: `idbGet` on an unknown name errors rather than silently creating it
- `clear` defaults to cookies + localStorage + sessionStorage. `indexedDB` is opt-in via `types` - dropping whole databases is far less recoverable

**HTTP / assertions**: `request`, `assert`, `saveToDisk`
- `request`: HTTP request as a sequence step. `destination: 'node'` sends it from the MCP server process (no browser, no CORS/cookies); `destination: 'browser'` runs `fetch()` in a connected tab (that page's cookies/session/origin). `saveAs` captures the response for later steps
- `assert`: assert a condition as a sequence step, failing the sequence if false - use `{{var:name.path}}` templates against values captured by a prior `saveAs`
- **`variables` on `run`/`runAll`**: replaces the text of recorded `input type` steps. Keys are BUILT from the selector - `var_<0-based step index>_<selector, non-alphanumerics replaced by _>` - so `#password` at step 3 is `var_3__password`, two underscores; read them off `get` or off the prompt a run returns rather than composing them by hand. A key naming no typed-text step is rejected before anything runs, with the substitutable keys listed. Substitutions reach the sequences a `conditional` or `forEach` nests into, so a key naming a step in a shared login helper lands there; `runAll` holds one map for the whole suite and accepts a key matching any member
- **`{{env:NAME}}`**: any step param may hold it, resolved from `process.env` when the step runs. This is how a credential stays OUT of the sequence file - the file holds the token, the value lives in the environment, and neither the file nor the tool call carries the secret. An unset or empty variable fails the step and names the variable; an empty value would otherwise be typed as-is. The name must match `[A-Za-z_][A-Za-z0-9_]*`. A token-bearing step does not hold the run open for a `variables` answer, and an explicitly supplied `variables` value still wins over the environment
- **`envFile` on `run`/`runAll`**: a KEY=value file supplying the `{{env:NAME}}` tokens for that run - `replay({ action: 'run', name: 'login', envFile: 'sequences.env' })`. A relative path resolves against the project directory (the one holding `.devharness`), absolute is used as-is. The file's values win over the server's own environment and a name it omits falls through to `process.env`; `process.env` is never written, so two background runs may name different files and changing the file needs no client restart. A missing file, or a line that is neither blank, a `#` comment, nor `NAME=value`, fails as a parameter error before any step runs. No `$VAR` expansion inside values
- **Capturing values with `saveAs`**: supported on `request` and on `inspect({ action: 'evaluateExpression' })`. They store different shapes - `request` stores the whole response object (so `{{var:login.body.token}}`), `inspect` stores the evaluated value itself (so `{{var:pairingUrl}}` is the string). A `saveAs` that cannot be honoured now fails the step rather than silently capturing nothing. Async expressions work: a returned Promise is awaited and the settled value is captured exactly (JSON-serializable values are captured by value, not from display text)

**Wait**: `wait` (exactly one of: selector, selectorGone, expression, ms)
- The primitive for "the previous step kicked off async work": `wait({ selector })` until an element appears (extended `:has-text()` selectors supported), `wait({ selectorGone })` until it disappears, `wait({ expression })` until a synchronous JS predicate evaluates truthy, `wait({ ms })` fixed sleep (last resort)
- Condition forms poll from the MCP side, so they survive a navigation mid-wait and never depend on in-page timers or promises resolving. Default timeout 15s (`timeoutMs`, `pollIntervalMs` tunable); on timeout the step fails cleanly (stopping a sequence) instead of hanging
- For async in-page work, kick it off in one step (store its result in a global), then `wait({ expression: 'window.__result !== undefined' })`

**Issues**: `issues` (actions: list, create, workOn, resolve, acknowledge, comment, publish, sync, import, link, pullSequence)
- `create`/`comment`: track bugs and features as Markdown issues, optionally linked to a replay sequence
- `list`: `search` matches body and comment text. A listing holding one issue renders it in full, so `issues({ action: 'list', id: N })` returns body, labels, comments and timestamps and leaves the issue's own status and timestamps untouched - reading an issue does not need `workOn`
- `workOn`: start on an issue, auto-replaying its linked sequence
- `resolve` is **human-gated**: it opens a browser overlay and only a person clicking Fixed/Not Fixed can close the issue. Don't call it unattended - it will wait ~150s and then fail with `ISSUES_RESOLVE_TIMEOUT`. Record what you found with `comment` and ask the user to run `resolve` themselves
- `acknowledge`: acknowledge pending bugs to unblock other tools
- **GitHub** (via the `gh` CLI; only `publish` and `sync` use the network): `publish` shows a draft and posts nothing until `confirm: true`; `sync` reconciles both ways and reports a conflict rather than overwriting when both sides changed; `import` materialises a GitHub-only issue locally; `link` stamps an existing number with no network call; `pullSequence` writes a sequence out of an issue body to disk (one authored by another GitHub account needs a person to read it and pass `confirm: true`)
- A sequence pulled from an issue is **never run automatically**, and one using `execution`, `saveToDisk`, `server`, `request` or `download` is refused unless you pass `allowPrivilegedSteps: true`. Read it first

**Bench**: `bench` (actions: start, stop, tick, list, status)
- The panel beside a driven app: it holds the page still, shows what crossed the boundary and what caused each thing, records and steps sequences, and collects element-level comments

- For when describing a UI problem costs more than pointing at it. `start` opens the bench in its own tab with the page still running and Chrome's element picker idle; the person arms the picker, clicks an element in the app tab, types a comment in the bench, saves. Each annotation records the selector, the text, the component name and the JSX source location where a dev build exposes one - so the report carries what the element *is*, not a description of where it sits
- Nothing is injected into the page being driven. The comment box, picker toggle, tick buttons and boundary stream live in the bench tab, served from `127.0.0.1` while apps sit on `localhost` - a different site, so Chrome gives it its own renderer process and freezing the app pane cannot take the UI down with it. Chrome's split view has no API (`splitViewId` is read-only), so the tab is opened beside the app for the person to split manually
- The freeze stops two clocks. `Debugger.pause` holds the page's JS, and with it every timer and `rAF` callback; CSS animations run on the compositor and need `Animation.setPlaybackRate(0)` as well. Both are released on `stop`, and the page goes back to real time
- `tick({ steps })` runs that many callbacks and freezes again - the exact unit, since one callback is one thing the page does and where its state changes. `tick({ budgetMs })` is the convenience for chasing a known timeout: it runs as many callbacks as it takes to cover that much page time and reports where it landed, which is rarely the number asked for. Either way this is how you walk into a state that only exists mid-interaction (a toast before it auto-dismisses, a spinner between two renders) and hold it there to be clicked. `Emulation.setVirtualTimePolicy` would give exact millisecond steps but is a one-way door - it replaces the page's clock with no way back, so the tab could never be handed over working
- Each step records the callbacks it ran through - what scheduled them, the function, the source line and the page time they landed at - and the bench keeps a running log beside the hold controls. This only exists while stepping: a freely running page is never paused, so there is nothing to observe it with short of tracing
- While the picker is armed every click is a pick; disarming it hands clicks back to the app. Driving the app also needs the page running - under a freeze its JS is stopped, so a click reaches nothing - so `unfreeze` and `freeze` toggle the hold without leaving the bench. Picking works in both states, since the picker is Chrome's rather than the page's
- Closing the bench tab ends it: the page is released back to real time, the debugger detaches and the server shuts down. `stop` does the same from the agent side. Annotations are written as they are saved, so neither loses anything
- Nothing blocks. `start` returns as soon as the bench is open; notes land on the session event stream as they are saved, and in the step of the sequence file they were written against. Keep working while the person writes
- While frozen, anything waiting on a timer stops - including a navigation's load timers. `stop` before driving the page with other tools

**Messages**: `message` (actions: sessions, send, read, reply)
- Text between two devharness sessions on this machine - a session hitting a devharness bug talking to the session working on devharness itself. `sessions` lists reachable mailboxes and this session's own mailbox path
- `send({ to, text, waitForReplyMs })` holds the call open until something lands in this session's mailbox (max 300000ms) and returns it; without `waitForReplyMs` it returns as soon as the line is written. `reply({ replyTo, text })` routes back to the sender of that message. The wait returns on ANY arrival, not only a tagged reply, so two sessions blocking at the same moment both release
- The mailbox is one append-only JSONL file per session under `~/.devharness/messages/`, holding the conversation and the read cursor; the global directory is what makes it reach across project roots. Nothing watches it. An arrival announces itself on that session's event stream, `~/.devharness/events/<id>.jsonl`, so one watch covers messages and guard blocks alike; without one, messages surface on the next `message({ action: 'read' })`

**Server**: `server` (actions: start, stop, restart, list, logs, stopAll, setAutoRun, clearLogs, remove, monitorPort, unmonitorPort, listMonitored, acknowledgePort, acknowledgeStartup, extendStartup, cancelPendingRestart)
- Use `global: true` to access servers started from a different working directory
- `start({ watch: true, watchPaths?: [...] })`: devharness watches the given paths (default: cwd) and auto-restarts the server on file changes, instead of relying on `--watch`/nodemon. Pause-aware: if a breakpoint debugger is paused on that server's inspector port, the restart queues instead of firing immediately - `cancelPendingRestart` discards a queued restart to keep debugging without it firing on resume

**Replay**: `replay` (actions: history, create, list, get, delete, export, load, listSaved, deleteSaved, run, runAll, step, finish, insert, addConditional, status, cancel, repeat, runFromLog, recordInteraction)
- `list`: every sequence - the ones in memory, then the ones on disk. A fresh session holds none in memory while the sequences dir holds a whole suite, so `list` is what shows what already exists; `listSaved` narrows it to the files
- `recordInteraction`: record mouse, keyboard, and navigation events with a visual overlay
- `runAll`: run every sequence in a folder and report one line each - `replay({ action: 'runAll', folder: 'spine', connectionReason: 'my-app' })`. Sequences may live in SUBFOLDERS of the sequences dir (`spine/`, `story/`, `_helpers/`); filenames are relative to that root (`spine/spine-01.json`) and `load` still accepts the bare basename. The whole tree is LOADED before anything runs, so a sequence in one folder can still reference a helper in another by name (a conditional's `then`, a forEach's `do`) - those resolve by sequence name, not by path. Folders whose name starts with `_` are loaded but never run by a bare `runAll`, which is where preamble guards and forEach bodies belong; naming such a folder explicitly runs it anyway. A failure is recorded and the suite continues (`continueOnFailure`, default true). Scoped to one root: the project sequences dir, or the global one with `global: true`. Accepts `baseUrl`, so one call runs a suite against any deployment - it reaches the nested sequences a conditional or forEach names, too. Accepts `killChromeOnFinish`, which means the SUITE's finish: only the last sequence carries it, so a preamble's browser survives between sequences
- `addConditional`: add a guarded branch step - `replay({ action: 'addConditional', name: 'flow', condition: '{{selector:.cookie-banner}}', thenSequence: 'dismiss-banner', insertAfterStep: 2 })`. `conditional` is virtual, never recorded, so this is its only authoring route. Syntax and branch target are validated up front; a sequence already on disk is rewritten in place
- `forEach`: a second virtual step - enumerate a source and run a sequence per item: `{ tool: 'forEach', params: { in: '{{var:shares}}', as: 'share', do: 'revoke-one-share', where: 'item.name !== "Employees"', maxItems: 50 } }`. `in` is either an array a prior `saveAs` captured or `{{selectorAll:CSS}}`; `where` is JavaScript with `item`/`index` in scope, not the condition grammar. Conditions probe one named thing, so this is what expresses "for everything that is there". An empty source is a success and the count is reported
- `teardown`: an optional command array beside a sequence's `commands`, run when the main steps reach a terminal state - success, a failed step, an abort, or the total timeout - but not when the run pauses. It has its own timeout budget and does not receive the run's abort signal, so a cancelled or timed-out run still cleans up; it shares the variable store, so it can revoke what setup minted. A failing teardown step never changes the run's verdict. Best-effort: a killed server takes pending teardown with it
- `export`: export a sequence to file - `format: sequence | playwright | puppeteer`
- `repeat`: instantly re-execute commands by history index - `replay({ action: 'repeat', indices: [0, 1, 2] })`. Each tool response shows its history index in the "Repeat" hint
- `run`: does not block - returns a `runId` immediately and executes in the background; poll `status({ runId })` for progress and the final result (kept 30 min in memory), `cancel({ runId })` interrupts the step in flight where the tool allows it (`wait` and `request` are genuinely cancelled, `navigate`/`inspect`/`content` stop waiting, `input` stops dispatching further events, the rest stop at the next step boundary - table in `docs/replay.md`). `wait: true` blocks for the full result (pre-0.7 behaviour). `startUrl` overrides the stored start URL for one run; `baseUrl` retargets every absolute URL at another deployment's origin - the sequence's own steps, a declared connection's launch url, and every sequence it reaches through a conditional or forEach
- Use `global: true` with `export` to save to ~/.devharness/sequences/ instead of the working directory

**Dashboard**: `dashboard` (actions: open, status, stop)

**Debug logging**: `setDebugLogging`, `getDebugLoggingStatus`

**Config**: `config` (actions: status, useLocal, useGlobal, reset, backup, cloneFromGlobal, show, listTools, reload, restart, listProfiles, resetProfile)
- `status`: Show where config is loaded from (local vs global)
- `useLocal`: Switch to project-local config (.devharness/config.json)
- `useGlobal`: Switch to global config (~/.devharness/config.json)
- `reset`: Reset config to defaults
- `backup`: Create timestamped backup
- `cloneFromGlobal`: Copy global config to local project
- `show`: Display current configuration
- `listTools`: List all toggleable tools with status and dependency conflicts
- `reload`: Re-read config.json now (also happens automatically on file edits, ~250ms debounce). Doesn't apply `tools.enabled`/`tools.disabled` - those need `restart`
- `restart`: Restart devharness itself via the mcp-supervisor (see "Restarting devharness" above) - use when the server seems stuck/broken, or to apply `tools.enabled`/`tools.disabled` changes
- `listProfiles`: List named persistent Chrome profiles and the root they live under
- `resetProfile`: Wipe and recreate a named profile (`config({ action: 'resetProfile', profile: 'device-a' })`). Refused while a live Chrome holds that profile - nothing is deleted in that case
