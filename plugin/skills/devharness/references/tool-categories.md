# Tool Categories

Most tools are **grouped**: one tool name plus an `action` param, e.g.
`navigate({ action: 'goto', url })`, not a separate `navigateTo` tool. The
actions below are the complete enums accepted by each tool.

Nearly every tool also takes `connectionReason` to pick which connection it
runs against (see the skill's Quick Start).

**Connection**: `connection` (actions: launch, attach, list, switch, rename, close, status, browsers) and `browser` (actions: kill, resetLauncher)
- `name` creates (launch, attach) or renames a connection; `connectionReason` addresses one that exists (switch, rename, close, status)
- `launch` also connects - don't follow it with `attach`. `launch` with the `port` of a running Chrome opens a new tab in it
- `list` gives each connection's URL and title and drops dead ones; `switch` makes a connection active and selects its page
- `close` and both `browser` actions require a `reason`. Closing the last connection to a Chrome kills that Chrome. `browser` is separate so that allowing `connection` allows no kill
- `connection({ action: 'launch', profile: 'device-a' })` uses a **named persistent profile**: a stable user-data-dir under `~/.devharness/profiles` (override per project with `chrome.persistentProfileRoot`) that survives across runs, so logins, cookies and IndexedDB persist. Naming it is what makes it persistent - there is no separate flag. It does not pin a port. Only one live Chrome may hold a profile at a time. Unnamed launches stay throwaway and are deleted on exit
- `connection({ action: 'launch', port, forceNewInstance: true })` honours that exact port and errors if it is already taken, rather than quietly moving to another one

**Breakpoint**: `breakpoint` (actions: set, remove, list, setLogpoint, validate, resetCounter, waitForScript, setDOMBreakpoint, setEventBreakpoint, setXHRBreakpoint, await)
- `waitForScript`: block until a script URL loads, so you can breakpoint code that isn't parsed yet
- `await`: wait for a breakpoint to be hit rather than polling
- `setLogpoint`: non-pausing logging with `{expr}` interpolation, `maxExecutions` to cap noise

**Execution**: `execution` (actions: pause, resume, stepOver, stepInto, stepOut, acknowledge)
- `pause`/`resume` are the code layer of `hold`. A resume on a page the bench holds releases the whole hold

**Hold**: `hold` (actions: hold, step, release, status)
- Stops the app at one moment across its layers: `code` (the debugger), `ui` (code plus CSS animation, needs the bench open), `network` (frames and responses wait at the proxy, needs `proxy: true`). All three by default
- `step({ layer })` moves one layer on by its unit - a statement, a callback, a message - and stops it again
- While the bench or a paused sequence holds a page, a tool that drives it is refused, naming the hold

**Inspection**: `inspect` (actions: getCallStack, getVariables, evaluateExpression, searchCode, searchFunctions, listTargets)
- `listTargets` lists the service, dedicated and shared worker targets on this browser. `evaluateExpression({ target })` runs the expression inside one of them, addressed by target id or by a substring of its URL - a substring matching two targets is refused with both named. A worker's console reaches no page listener, so `console({ action: 'list' | 'recent', target })` reads it from that target; recording starts at first attach
- `evaluateExpression` awaits a returned Promise by default (async IIFEs resolve to their settled value; a rejection is reported as the expression's own error). Pass `awaitPromise: false` to inspect the Promise object itself. While paused at a breakpoint only already-settled promises can be resolved - a pending one fails fast because the event loop is stopped

**Source**: `source` (actions: get, loadMaps)

**Console**: `console` (actions: list, get, recent, search, clear, setObjectDepth)
- `target` on `list` and `recent` reads a worker's console instead of the page's

**Network**: `network` (actions: list, get, search, enable, disable, setConditions)

**Proxy**: `proxy` (actions: status, events, sockets, body, answer, answerFrame, withdraw, answers, refuse, stop)
- Needs `connection({ action: 'launch', proxy: true })`. Holds what reached the outside world, where `network` reads what CDP saw
- A proxy outlives its browser. `stop` drops it under one name; it stops, with what it recorded, once no other tab's name holds it. A proxy that no connection and no open bench uses is reported once on the event stream (`kind: "proxy"`, `idle: true`) with the `stop` call in `resolve`
- Each event carries the step that owns it, a level read from stored evidence, and what the page says started it. A timer-rooted request or send owns nothing, so an app's own polling stays out of every step
- `answer` answers a URL with a value; `answerFrame` replaces or drops one socket message
- Full model - roots, levels, socket shapes, ruling a payload shape, what reaches a recording: [boundary.md](boundary.md)

**Page**: `navigate` (actions: goto, reload, back, forward, info)

**DOM**: `dom` (actions: querySelector, getProperties, snapshot)

**Content**: `content` (actions: extractText, findInteractive, verify, parse)

**Screenshot**: `screenshot` (actions: fullPage, viewport, element, pdf)

**Input**: `input` (actions: click, type, press, hover, focus, focusNext, focusPrevious, drag, scroll, mousemove, pinch, tap, swipe)
- `tap` / `swipe`: real touch events via `Input.dispatchTouchEvent`. Mouse actions never produce touchstart/touchmove, so a component listening only for touch cannot be driven by `click` or `drag`. `tap` takes a selector or x/y; `swipe` takes `from`/`to` and `steps` (default 10) and emits touchstart, N touchmove, touchend

**Modal**: `modal` (actions: detect, dismiss)

**Storage**: `storage` (actions: getCookies, setCookie, getLocalStorage, setLocalStorage, removeLocalStorage, getSessionStorage, setSessionStorage, removeSessionStorage, idbListDatabases, idbListStores, idbGet, idbGetAll, idbPut, idbDelete, clear, writes, authenticatorAdd, authenticatorCredentials, authenticatorRemove). authenticatorAdd puts a virtual WebAuthn authenticator on the page, so a passkey prompt is answered with no person present (`userVerified: false` for presence alone); it stands until authenticatorRemove or the tab closes
- IndexedDB reads return typed descriptors for values JSON can't express - `{__type:'CryptoKey', algorithm, extractable, usages}` and analogues for Blob/ArrayBuffer/Map/Set/Date - so a non-extractable key is still observable. `idbPut` accepts JSON-expressible values only
- A read never creates a database: `idbGet` on an unknown name errors rather than silently creating it
- `clear` defaults to cookies + localStorage + sessionStorage. `indexedDB` is opt-in via `types` - dropping whole databases is far less recoverable

**HTTP / assertions**: `request`, `check`, `assert`, `download`
- `request`: HTTP request as a sequence step. `destination: 'node'` sends it from the MCP server process (no browser, no CORS/cookies); `destination: 'browser'` runs `fetch()` in a connected tab (that page's cookies/session/origin). `saveAs` captures the response for later steps
- `check`: read one thing - an element, a value, an expression, the URL, a cookie, storage, traffic crossing the proxy (`traffic` matched as a pin, with `count`), a `socket` open or closed, or time alone (`afterMs`) - and answer held or failed; `withinMs` reads again until it holds. Called directly it never fails the call on a failed check. As a sequence step, `holds` / `fails` are `continue`, `stop`, or `{ run: '<sequence>', resumeAt }` - a guard is a check whose pass runs a sequence
- `assert`: a check whose fail stops the sequence - use `{{var:name.path}}` templates against values captured by a prior `saveAs`
- **Capturing values with `saveAs`**: supported on `request` and on `inspect({ action: 'evaluateExpression' })`. They store different shapes - `request` stores the whole response object (so `{{var:login.body.token}}`), `inspect` stores the evaluated value itself (so `{{var:pairingUrl}}` is the string). A `saveAs` that cannot be honoured now fails the step rather than silently capturing nothing. Async expressions work: a returned Promise is awaited and the settled value is captured exactly (JSON-serializable values are captured by value, not from display text)

**Wait**: `wait` (exactly one of: selector, selectorGone, expression, ms)
- The primitive for "the previous step kicked off async work": `wait({ selector })` until an element appears (extended `:has-text()` selectors supported), `wait({ selectorGone })` until it disappears, `wait({ expression })` until a synchronous JS predicate evaluates truthy, `wait({ ms })` fixed sleep (last resort)
- Condition forms poll from the MCP side, so they survive a navigation mid-wait and never depend on in-page timers or promises resolving. Default timeout 15s (`timeoutMs`, `pollIntervalMs` tunable); on timeout the step fails cleanly (stopping a sequence) instead of hanging
- For async in-page work, kick it off in one step (store its result in a global), then `wait({ expression: 'window.__result !== undefined' })`
- A wait is a check with a time limit; written into a sequence from history it is stored as a `check` step

**Issues**: `issues` (actions: list, create, edit, workOn, resolve, acknowledge, comment, publish, sync, import, link, pullSequence)
- `create`/`comment`: track bugs and features as Markdown issues, optionally linked to a replay sequence
- `list`: `search` matches body and comment text. A listing holding one issue renders it in full, so `issues({ action: 'list', id: N })` returns body, labels, comments and timestamps and leaves the issue's own status and timestamps untouched - reading an issue does not need `workOn`
- `workOn`: start on an issue, auto-replaying its linked sequence
- **Comment as you go.** When working an issue, `comment` on it at the start (what you're about to change and why) and again when done (what you actually changed, files touched, tests added, and anything you found that contradicts the issue as written). The issue becomes the durable record - someone reviewing later reads the timeline, not your diff. Comment on surprises too: a repro that doesn't reproduce, a root cause elsewhere, or a fix you rejected and why
- `resolve` is **human-gated**: it opens a browser overlay and only a person clicking Fixed/Not Fixed can close the issue. Don't call it unattended - it will wait ~150s and then fail with `ISSUES_RESOLVE_TIMEOUT`. Record what you found with `comment` and ask the user to run `resolve` themselves
- `acknowledge`: acknowledge pending bugs to unblock other tools

**GitHub sync** (via the `gh` CLI). Everything except `publish` and `sync` is local, so the tracker keeps working offline.
- `publish` returns a draft and posts **nothing**; pass `confirm: true` to post it. The GitHub body is the local body verbatim plus the repro sequence, so the two stay comparable. Labels missing from the repo are created on confirm
- `sync` takes part only for issues marked with `issues({ action: 'edit', id, sync: true })`; a linked issue is left alone until marked. Without `confirm: true` it reads GitHub and returns the plan - what each marked issue would send or take, `_meta.github.plan` - and writes nothing on either side; show the plan to the person and re-run with `confirm: true` once they agree. Confirmed, it reconciles both ways: body, comments, closed state and labels down, local edits and comments up, closing upstream where closed here. When **both** sides changed since the last sync it reports a conflict and writes nothing for that issue; resolve with `take: 'local'` or `take: 'remote'` on that one issue
- `import` makes a GitHub-only issue local so there is somewhere to record findings - use it when told to "work on #110". `link` adopts an existing number with no network call, and is the recovery path if a publish dies after creating the issue
- `pullSequence` writes a sequence out of an issue to disk. Nothing is written until you ask, and nothing is ever run automatically: sequence steps are `{tool, params}` for **any** tool, so a sequence in a public issue is a script, not a macro. One authored by a GitHub account other than the one `gh` is logged in as is refused until a **person** has read it and re-run with `confirm: true` - an agent must not confirm on its own. One using `execution`, `server`, `request`, `download`, `browser`, `replay` or `config` is refused unless you pass `allowPrivilegedSteps: true`. Read the step list in the response before you do
- All of these are blocked while any bug is `pending` - `acknowledge` first

**Bench**: `bench` (actions: start, stop, hold, release, picker, tick, keepStep, dropStep, flagStep, sweep, retake, capture, list, status)
- The panel beside a driven app: it holds the page still, shows what crossed the boundary and what caused each thing, records and steps sequences, and collects element-level comments

- For when describing a UI problem costs more than pointing at it. `start` opens the bench in its own tab with the page still running and Chrome's element picker idle; the person arms the picker, clicks an element in the app tab, types a comment in the bench, saves. Each annotation records the selector, the text, the component name and the JSX source location where a dev build exposes one - so the report carries what the element *is*, not a description of where it sits
- Nothing is injected into the page being driven. The comment box, picker toggle, tick buttons and boundary stream live in the bench tab, served from `127.0.0.1` while apps sit on `localhost` - a different site, so Chrome gives it its own renderer process and freezing the app pane cannot take the UI down with it. Chrome's split view has no API (`splitViewId` is read-only), so the tab is opened beside the app for the person to split manually
- The screen hold stops two clocks. `Debugger.pause` holds the page's JS, and with it every timer and `rAF` callback; CSS animations run on the compositor and need `Animation.setPlaybackRate(0)` as well. Both are released on `stop`, and the page goes back to real time
- `tick({ steps })` runs that many callbacks and holds again - the exact unit, since one callback is one thing the page does and where its state changes. `tick({ budgetMs })` is the convenience for chasing a known timeout: it runs as many callbacks as it takes to cover that much page time and reports where it landed, which is rarely the number asked for. Either way this is how you walk into a state that only exists mid-interaction (a toast before it auto-dismisses, a spinner between two renders) and hold it there to be clicked. `Emulation.setVirtualTimePolicy` would give exact millisecond steps but is a one-way door - it replaces the page's clock with no way back, so the tab could never be handed over working
- Each step records the callbacks it ran through - what scheduled them, the function, the source line and the page time they landed at - and the bench keeps a running log beside the hold controls. This only exists while stepping: a freely running page is never paused, so there is nothing to observe it with short of tracing
- While the picker is armed every click is a pick; disarming it hands clicks back to the app. Driving the app also needs the page running - under a hold its JS is stopped, so a click reaches nothing - so `release` and `hold` toggle it without leaving the bench. Picking works in both states, since the picker is Chrome's rather than the page's
- Closing the bench tab ends it: the page is released back to real time, the debugger detaches and the server shuts down. `stop` does the same from the agent side. Annotations are written as they are saved, so neither loses anything
- `sweep` reports the note captures no sequence refers to any more, and with `remove: true` deletes them. It reads every sequence store, so a capture another sequence cites is never taken, and needs no browser
- Full reference, including pausing a run and the boundary panel: [bench.md](bench.md)
- Nothing blocks. `start` returns as soon as the bench is open, and on a bench already open it reports that and changes nothing - `picker` arms or disarms the picker; notes land on the session event stream as they are saved, and in the step of the sequence file they were written against. Keep working while the person writes
- While frozen, anything waiting on a timer stops - including a navigation's load timers. `stop` before driving the page with other tools

**Messages**: `message` (actions: sessions, send, read, reply)
- Text between two devharness sessions on this machine - a session hitting a devharness bug talking to the session working on devharness itself. `sessions` lists reachable mailboxes and this session's own mailbox path
- `send({ to, text, waitForReplyMs })` holds the call open until something lands in this session's mailbox (max 300000ms) and returns it; without `waitForReplyMs` it returns as soon as the line is written. `reply({ replyTo, text })` routes back to the sender of that message. The wait returns on ANY arrival, not only a tagged reply, so two sessions blocking at the same moment both release
- The mailbox is one append-only JSONL file per session under `~/.devharness/messages/`, holding the conversation and the read cursor; the global directory is what makes it reach across project roots. Nothing watches it. An arrival announces itself on that session's event stream, `~/.devharness/events/<id>.jsonl`, so one watch covers messages and guard blocks alike; without one, messages surface on the next `message({ action: 'read' })`

**Server**: `server` (actions: start, stop, restart, list, logs, stopAll, setAutoRun, clearLogs, remove, monitorPort, unmonitorPort, listMonitored, acknowledgePort, acknowledgeStartup, extendStartup, cancelPendingRestart)
- Use `global: true` to access servers started from a different working directory
- `start({ watch: true, watchPaths?: [...] })`: devharness watches the given paths (default: cwd) and auto-restarts the server on file changes, instead of relying on `--watch`/nodemon. Pause-aware: if a breakpoint debugger is paused on that server's inspector port, the restart queues instead of firing immediately - `cancelPendingRestart` discards a queued restart to keep debugging without it firing on resume

**Replay**: `replay` (actions: history, create, list, get, delete, export, load, listSaved, deleteSaved, run, runAll, step, finish, insert, addCheck, status, cancel, repeat, runFromLog, recordInteraction)
- `recordInteraction`: record mouse, keyboard, and navigation events with a visual overlay
- `runAll`: run every sequence in a folder and report one line each - `replay({ action: 'runAll', folder: 'spine', connectionReason: 'my-web-app' })`. Sequences may live in SUBFOLDERS of the sequences dir (`spine/`, `story/`, `_helpers/`); filenames are relative to that root (`spine/spine-01.json`) and `load` still accepts the bare basename. The whole tree is LOADED before anything runs, so a sequence in one folder can still reference a helper in another by name (a check's `{ run }`, a forEach's `do`) - those resolve by sequence name, not by path. Folders whose name starts with `_` are loaded but never run by a bare `runAll`, which is where preamble guards and forEach bodies belong; naming such a folder explicitly runs it anyway. A failure is recorded and the suite continues (`continueOnFailure`, default true). Scoped to one root: the project sequences dir, or the global one with `global: true`. Accepts `baseUrl`, so one call runs a suite against any deployment
- `addCheck`: add a check step - `replay({ action: 'addCheck', name: 'flow', check: { selector: '.cookie-banner', condition: 'present', holds: { run: 'dismiss-banner' }, fails: 'continue' } })`
- `export`: export a sequence to file - `format: sequence | playwright | puppeteer`
- `repeat`: instantly re-execute commands by history index - `replay({ action: 'repeat', indices: [0, 1, 2] })`. One index answers with that call's own reply; `params` replaces fields of that one call (`null` removes one). Each tool response shows its history index in its `Replay: N` footer. History also holds bench and CLI calls and every step of a sequence run, marked with the run's name
- `run`: does not block - returns a `runId` immediately and executes in the background; poll `status({ runId })` for progress and the final result (kept 30 min in memory), `cancel({ runId })` stops it at the next step boundary. `wait: true` blocks for the full result (pre-0.7 behaviour). `startUrl` overrides the stored start URL for one run; `baseUrl` retargets every absolute URL at another deployment's origin
- Use `global: true` with `export` to save to ~/.devharness/sequences/ instead of the working directory

**Dashboard**: `dashboard` (actions: open, status, stop)

**Config**: `config` (actions: status, useLocal, useGlobal, reset, backup, cloneFromGlobal, show, listTools, reload, restart, listProfiles, resetProfile, setDebugLogging, debugLoggingStatus)
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
