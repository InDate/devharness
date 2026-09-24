# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The bench: a pane beside the app being driven.** It serves a page per
  session carrying the steps of a sequence, what crossed the boundary under
  each, the rules that answer a later run, and the notes and captures taken
  against a step. One floating bar holds everything acting on the session
  rather than on a tab - the sequence open, the run's position and controls,
  the picker, the capture, the proxy and the freeze - so no screen carries a
  second copy of a control and no two copies can disagree. The `bench` tool
  opens and drives it; `bench({ action: 'sweep' })` reports the captures no
  sequence refers to any more, and `sweep` with `remove: true` deletes them,
  reading every sequence store so a capture another sequence cites is never
  taken.

- **Pausing a run stops it on the step it reached and holds the page there.**
  The step in flight is cut short by its own abort signal rather than left to
  run out its settle against a page about to be frozen, so the state on screen
  is the one at the moment of the press. Carrying on resumes from that step:
  the step-through session stays open at the last step that completed, and the
  steps before it are not taken again. Only that one step repeats, because an
  input whose settle was cut may or may not have reached the page and
  re-running it is the only certain answer.

- **`devharness bench [sequence] [url]`**, opening the pane against the
  session the shell belongs to and launching a browser when none is bound. A
  bare word is read as a sequence name and an `http(s)` word as the page to
  start on, in either order.

- **The proxy records which side caused each crossing** - the step that drove
  it, the initiator behind it, the socket it rode - so a reading of the
  boundary separates what the app did on its own from what a step made it do.
  The allow list bounds which hosts the browser may reach, and a sequence
  carries what its boundary decided, so a later run is scoped and answered as
  the first one was.

### Changed

- **Annotate mode is now the bench** (`annotate-mode`, `annotate-control` and
  `annotate-tools` become `bench-mode`, `bench-control` and `bench-tools`, and
  the `annotate` tool becomes `bench`). The feature is the pane, not the act
  of annotating. No released version carried the annotate tool, so nothing
  published breaks; a configuration still naming `annotate` under `enabled` or
  `disabled` is ignored rather than failing, and the `bench` tool is
  discovered regardless.

### Fixed

- **Refusing unmatched writes no longer locks the bench out of its own
  controls.** The pane is served through the same proxy the app runs through,
  so turning the setting on refused the request that would turn it off, and
  the only way back was a call made from outside the browser. The bench's own
  origin is now exempt.

- **A step stopped part-way no longer runs the sequence's declared teardown.**
  An aborted step is recorded as a failure, and the run treated that as the
  end, tearing down in the middle of a session somebody had stopped to look
  at. It now counts as a pause.

- **A delay cut short names the step it interrupted** rather than the one
  after it, and an abort landing on the last step in range still produces a
  marker instead of none.

- **`envFile` on `run`/`runAll`: a KEY=value file supplying that run's
  `{{env:NAME}}` tokens.** A relative path resolves against the project
  directory (the one holding `.devharness`); absolute is used as-is. The
  file's values win over the server's own environment - the caller named this
  file for this run, and a stale ambient variable shadowing it would
  substitute a different credential with nothing in the output to say so - and
  a name the file omits falls through to `process.env`. `process.env` is never
  written: two background runs may name different files, and a global write
  would let one run's credentials resolve inside the other; it follows that
  changing the file needs no client restart, unlike the environment of a
  running server, which is fixed when it starts. A missing file, or a line
  that is neither blank, a `#` comment, nor `NAME=value` with a name matching
  `[A-Za-z_][A-Za-z0-9_]*`, fails as a parameter error before any step runs
  rather than halfway through a flow that has already logged in - a skipped
  line would read as a set variable. No `$VAR` expansion inside values: a
  password containing `$` is ordinary, and expanding it would type something
  else.

- **`{{env:NAME}}` interpolation, so a credential need not live in the
  sequence file.** Any step param may hold it; it resolves from `process.env`
  when the step runs, alongside the existing `{{var:...}}` and `{{timestamp}}`
  tokens. The file holds the token, the value lives in the environment, and
  neither the file nor the tool call carries the secret. An unset or empty
  variable fails the step and names the variable - resolving to `''` would
  submit a blank password and surface as a confusing downstream failure
  instead of the missing configuration that caused it. A token-bearing step no
  longer holds `run` open for a `variables` answer, since its value arrives at
  run time by definition; it stays substitutable, and an explicitly supplied
  value wins over the environment.

- **`runAll` honours `killChromeOnFinish`,** as the suite's finish rather than
  each sequence's: only the last sequence carries it, so a `_helpers` preamble's
  browser survives between sequences, and a suite that stops early
  (`continueOnFailure: false`, a cancel) leaves the browsers up for the failure
  to be read in. It was cleared outright before, so a suite run left a browser
  behind with no way to ask for it back.

- **Guard blocks now push, instead of only surfacing on the next tool call.**
  Every new block appends one JSON line to `.devharness/logs/blocks.jsonl`
  (`{ts, guard, tool, detail, resolve}`) covering all five guards: `port`,
  `breakpoint`, `pendingStartup`, `bug`, `duplicateSession`. Until now a dev
  server that died while the agent was editing files stayed invisible until the
  agent happened to call devharness again. The skill and `docs/instructions.md`
  show the Claude Code `Monitor` command that tails it, so the block arrives as
  a notification. Lines are deduplicated per block, not per blocked call - the
  same block re-firing stays quiet until a call clears every guard.

- **The skill is 42% smaller** (13.6k -> 7.9k characters) with no loss of tool
  names, actions, or exact error strings. It loads into the context of every
  session that touches debugging, so prose there is a recurring cost: merged the
  duplicated quick-start and workflow sections, turned the pattern walkthroughs
  into a table, and cut explanation down to the non-obvious.

- **The skill now checks `.devharness/` is git-ignored** before the first tool
  that writes there, and asks before touching `.gitignore`. State written into a
  repo that does not ignore it gets committed, carrying pids, ports, and local
  paths into what may be a public repository.

### Fixed

- **`variables` stopped at the top-level sequence, and an unmatched key was
  dropped in silence.** Both failures ran the same way: the step executed on
  its RECORDED text while the call read as an override, so a recorded
  credential reached the live app with the run reporting success. A shared
  login helper reached by a `conditional` is exactly where a supplied password
  has to land, which made the top-level-only substitution miss the one case
  that matters. The substitutions now travel on the execution context
  (`ExecutionContext.variables`) and apply at every nesting depth, and a key
  naming no typed-text step is rejected before any side effects, with the
  substitutable keys listed - the rule `connections` already applied to a
  reference naming no recorded step. `runAll` holds one map for the whole
  suite, so it validates against the union of the selected sequences and each
  member substitutes on the keys that name its own steps.

- **The substituted value no longer reaches `debug.log`.** The executor logged
  `Substituted <key>: "<value>"`; these steps carry passwords and tokens, and
  the log outlives the run. It logs the key and the value's length now. Debug
  logging is off by default, so this bit only with `setDebugLogging` on.

- **The `variables` examples used a key that cannot match.** `docs/replay.md`
  and the skill's `references/sequences.md` both showed
  `variables: { 'var_2_#email': ... }`, while the executor builds the key with
  `selector.replace(/[^a-zA-Z0-9]/g, '_')` - `var_2__email`, two underscores.
  A key matching nothing is dropped in silence and the step runs on its
  recorded text, so a caller copying the example got no substitution, no
  error, and the recorded value typed into the live app - a recorded password
  among them. Both examples corrected, both files now state the transform and
  point at `get`/the run prompt as the source of the keys, and
  `replay-typed-text-variables.test.ts` pins the extractor and the executor to
  the same key so the examples can be copied from a passing test.

- **`baseUrl` now reaches nested sequences and declared connections.** A
  retarget rewrote the sequence handed to the executor and nothing else. A
  `conditional`'s `then` and a `forEach`'s `do` load from the recorder later,
  in their recorded form, and a declared connection's launch `url` was copied
  through untouched - so a retargeted run drove two origins at once: the
  parent on the target deployment, the shared login/setup helper and the
  browser's opening page on the recorded one. The origin now travels on the
  execution context (`rebaseOrigin`) and is applied at every nesting depth,
  and `rebaseSequence` rewrites `requiredConnections[].url`. `runAll` inherits
  this, which is where it bites: a suite's shared setup lives in exactly those
  helper sequences.

- **Tool calls no longer run before state recovery finishes.** The transport
  started serving at `server.connect()`, but managed servers, monitored ports
  and pending startup failures were only restored several steps later - so the
  opening calls of a session were answered against an empty world. A dev server
  that had died in the previous session did not block, and an
  `acknowledgeStartup` issued in that window acknowledged a failure that had not
  been restored yet: it reported success, the next call went through, and then
  the block reappeared as recovery landed. Calls now wait on a startup gate
  (capped at 30s so a hung port or Docker check cannot wedge the session;
  `config` stays exempt so `config({ action: 'restart' })` is still reachable).

- **`npm version` works again, and bumps all three places the version lives.**
  Its lifecycle hook stamps the skill frontmatter, but still looked for it at
  `skills/cdp-tools/SKILL.md` - a path from before the skill moved into
  `plugin/` - so every release attempt died on an ENOENT stack with
  package.json already bumped and no commit or tag made. It now resolves
  `plugin/skills/devharness/SKILL.md`, and also bumps the `devharness@<version>`
  pin in `plugin/.mcp.json`. That pin was left to whoever remembered: forget it
  and the failure lands late and loud, with the tag already public, `publish.yml`
  failing its verify step, and `notify-marketplace` having meanwhile opened a PR
  pinning a version npm never received.

- **`npm run build` hot-reloads the live server again.** Its postbuild hook
  still looked for the supervisor pidfile under the pre-0.9.0 `.cdp-tools/`,
  so every build silently found nothing and left the running server on stale
  code while the build looked successful. It now checks `.devharness/` first
  and falls back to `.cdp-tools/`.

- **The skill setup nudge no longer fires when the skill came from a plugin.**
  It only looked in `.claude/skills/` and `.agents/skills/`, so a plugin install
  - which ships the skill itself - still got told to go and install one. It now
  also checks the plugin cache, and looks for `devharness` rather than the old
  `cdp-tools` directory name.

### Changed

- **Plugin content moved to `plugin/`** (`plugin/.claude-plugin/`,
  `plugin/.mcp.json`, `plugin/skills/`). The Claude Code plugin now pins that
  subdirectory rather than the whole repository.

  A plugin directory containing a `package.json` gets a full `npm install` on
  install, dev dependencies included: 175MB per installed version, for a plugin
  that only needs a manifest and a skill. The subtree has no `package.json`, so
  nothing runs.

  npm consumers symlinking the skill need the new path:
  `node_modules/devharness/plugin/skills/devharness`.

- **Renamed from `cdp-tools-mcp` to `devharness`.** Old name described the
  transport. `cdp-tools-mcp` is deprecated on npm and points here. No tool
  names or arguments changed.

- **State moved `.cdp-tools/` -> `.devharness/`**, project-local and `~/`.
  Migrated, not switched: the old directory is renamed into place on first run,
  so profiles (logins, IndexedDB), config, sequences, and issues carry over.
  Rename is atomic, so the data is never half-moved.

  If the rename fails (cross-device, permissions, directory held open), the old
  location keeps being used and logs why. Starting from an empty directory would
  be indistinguishable from data loss.

  `DEVHARNESS_DIR` supersedes `CDP_TOOLS_DIR`, which still works.

### Changed - BREAKING

- **`replay({ action: 'run' })` no longer blocks.** It validates the request, registers a run, and returns immediately with a `runId` (in the text and in `_meta.replay.runId`); the sequence executes in the background.
  - **Migration:** pass `wait: true` to keep the old blocking behaviour and get the full result in one call: `replay({ action: 'run', name: '...', wait: true })`. Anything that awaited `run` and read its result (scripts, prompts, other tooling) must either add `wait: true` or poll `replay({ action: 'status', runId })`.
  - `status` with a `runId` reports a running run's current step, and returns the complete final result (step results, debug state, `killChromeOnFinish` outcome) once the run settles. Without `runId` it shows the paused step-through session plus all recent runs.
  - `cancel` with a `runId` aborts that run - it takes effect at the next step boundary (a tool call already in flight is not interrupted; per-step cancellation is #110). A bare `cancel` still drops the paused session first, or cancels the only executing run.
  - Concurrent runs are supported, including two runs of the same sequence; the `runId` distinguishes them. Nested sequences (`conditional` flows, `replay run` steps - which are forced to `wait: true`) belong to their parent run and never register separately.
  - Settled runs are kept in memory for 30 minutes (max 50 records). Unknown/expired ids - including every id from before a server restart, which also kills in-flight runs - return `REPLAY_RUN_NOT_FOUND`.
  - Internal callers that need the result (`issues workOn`/`resolve` auto-replay, the `cdp-tools-mcp run` CLI) now pass `wait: true` and behave exactly as before.

### Added
- **DOM Assertions** (#132): `assert({ selector, condition })` asserts about the page and polls until it holds, instead of a hand-written wait loop inside `inspect({ evaluateExpression })`. Conditions: `present` (in the DOM), `visible` (rendered, non-zero box, not hidden), `hittable` (`elementFromPoint` at its centre lands inside it - nothing covering it), `absent`, `enabled`, plus `text`/`attribute`/`count` compared with the existing operators. Failures report what was actually there - match count, visible/hittable, and *what covered it* - so a covered control names its occluder rather than failing blankly.
  - `hittable` exists because the other two are not the same question. Measured on a swipe-action row, the destructive button was in the DOM and painted while hit-testing its centre returned the row surface on top of it: present, visible, and unreachable. A suite asserting `visible` there passes on a button no user can press.
  - The deadline belongs to the harness (default 5000ms, `timeoutMs` to change it). A hand-rolled poll picks its own, and one exceeding the evaluation timeout dies as "did not respond" - losing the diagnostic entirely, silently.
  - Removing the reason to open an evaluate step matters beyond tidiness: once a step has a JS window into the page, *acting* through it is one line away, which is how suites end up calling `button.click()` instead of driving real input.
- **WebSocket Health** (#128): `network({ action: 'sockets' })` reports the WebSocket lifecycle - what opened, what closed and after how long, and which hit frame errors. Puppeteer raises no page event for sockets, so these come from the CDP `Network` domain. `replay({ action: 'run'|'runAll', requireSockets: true })` diffs that health across a run and fails it when a socket closed or errored while it executed, so a sequence that passes every assertion while its transport was down is reported as the failure it is. The diff is against the start, so a socket already dead beforehand is not blamed on the sequence, and unlike a final "is it up now" assertion it catches a drop that recovered mid-run.
  - **A sequence declares the sockets its assertions ride on** via `requiredSockets` (URL substrings, e.g. `["/api/sync/socket"]`), and a run enforces the declaration whether or not the caller passed a flag - the caller cannot be expected to know which socket carries an app's data, and a declaration cannot be forgotten by whoever starts the run. Declaring also makes *absence* a failure: a socket that never opened closes nothing, so counting closures alone passes an app that never connected. Match on the path rather than the origin so the declaration survives `baseUrl` retargeting; dev-server sockets simply go undeclared. Verdicts now apply to background runs too, not only `wait: true` ones, and a connection whose socket health cannot be read fails the run instead of silently skipping the check.
  - Sockets opened inside a **Web Worker** are included (#129). They belong to the worker's own CDP target and emit nothing on the page session, so the monitor auto-attaches to child targets (`Target.setAutoAttach` with `waitForDebuggerOnStart`, which holds the worker before its first line so a socket opened at worker boot is not missed) and enables `Network` on each. `sockets` output labels every entry with its owning target - `[page]` or `[worker]` - because for an app that syncs from a worker the real transport is the `[worker]` line, and the `[page]` ones may be nothing but the dev server's HMR socket.
- **Self-Restart Tool**: `config({ action: 'restart' })` restarts cdp-tools itself via the mcp-supervisor (`src/self-restart.ts` reads `.cdp-tools/mcp-supervisor.pid` and sends it `SIGUSR2` - the same mechanism the `postbuild` hook and a manual `kill -USR2` already used), so a session can recover a stuck/broken server or apply `tools.enabled`/`tools.disabled` changes without shelling out or asking the user to reconnect. Returns `CONFIG_RESTART_NOT_SUPERVISED` if this server isn't running through the supervisor (e.g. bare `node build/index.js`), or `CONFIG_RESTART_STALE_PID` if the pidfile points at a dead process.
- **Agent Skill**: Bundled an [Agent Skills](https://agentskills.io)-compatible skill at `skills/cdp-tools/` (with `references/tool-categories.md`) mirroring `docs/instructions.md`, so skills-aware clients (e.g. Claude Code) can load the full workflow guide and tool catalog progressively instead of it living entirely in the MCP `instructions` field. The MCP `instructions` payload itself (`docs/mcp-instructions.md`) is now a short quick-start plus a pointer to the skill, since MCP clients inject `instructions` into every session unconditionally. See [docs/README.md](docs/README.md#agent-skill) for setup.
  - **Install nudge**: On startup, the server checks whether the skill is already symlinked into a scanned location (`.claude/skills/cdp-tools` or `.agents/skills/cdp-tools`, project- or user-level). If not found anywhere, the `instructions` payload asks the model to offer setting it up (never to symlink it in unprompted). The nudge stops appearing once installed.
- **Page-Parser Plugins**: `content({ action: 'parse', name })` runs a user-provided parser plugin in the page and returns its JSON output; `content({ action: 'parse' })` (no name) lists available plugins and flags which match the current URL. Plugins are loaded from `~/.cdp-tools/parsers/` (global) or `./.cdp-tools/parsers/` (project, overrides global), dynamically imported at call time (cache-busted), so adding or editing a parser needs no rebuild/restart. Each plugin default-exports `{ name, description, match?, waitFor?, extract }` where `waitFor`/`extract` run in the page. No plugins ship with the package — write your own; see [docs/parser-plugins.md](docs/parser-plugins.md) for the contract and a worked AI Overview example.
- **Replay Retargeting**: `replay({ action: 'run', baseUrl })` rewrites the origin of every absolute URL in a sequence (startUrl + command params) so one recorded sequence runs against any deployment; `startUrl` on `run` replaces the entry URL for that run only (e.g. a freshly minted link). Neither survives a mid-run pause/step resume.
- **UI Verification** (#26): `content({ action: 'verify' })` detects dead buttons, viewport issues, touch targets, overflow clipping, dead links, horizontal scroll
- **DOM Change Detection** (#27): Input actions report DOM changes via MutationObserver (added/removed elements, visibility changes)
- **Replay Agent**: `.claude/agents/replay-agent.md` for building sequences through investigation
- **Variable Inspection Fallbacks**: `getVariables` gracefully degrades when data exceeds token limits (#20)
- **Breakpoint Pause Detection**: Input actions (click, type, hover) now detect and report when they trigger breakpoints
- **TOON Format**: Token-Oriented Object Notation for compact inspection output (~58% token reduction)
- **Webpack Eval Support**: Code search (`searchCode`, `searchFunctions`) now extracts actual source lines from webpack eval wrappers instead of showing unhelpful `eval(__webpack_require__...)` lines
- **Lazy Source Map Loading**: Source maps are now registered and loaded on-demand instead of eagerly, improving startup performance
  - Size limits prevent performance issues (1MB inline, 10MB file)
  - Support for URL-encoded data URIs (not just base64)
  - Concurrent load protection prevents duplicate loads
  - Error tracking for debugging without blocking operations

### Fixed
- **Cache-Busting Breakpoints**: Breakpoints now work across rebuilds when scripts have changing query params (e.g., `app.js?v=123`)
  - Falls back to base URL matching when exact URL not found
  - Prefers most recently loaded script when multiple matches exist
- **Connection Reference Lookups**: References are now normalized (lowercase, trimmed, spaces→hyphens) for more flexible lookups

### Changed
- `loadSourceMaps` tool now registers maps for lazy loading and reports count; actual loading happens on-demand
- Long code search results truncated to 200 chars to prevent huge responses from minified code

---

## [0.2.0] - 2025-11-22

### Added
- **Enhanced Replay System**: Major improvements to command replay for workflow automation
  - Connection injection: Replay sequences across different Chrome sessions
  - Variable substitution: Replace text inputs with new values during replay
  - `intoHistory` option: Load sequences into history without executing
  - Step/total timeout configuration for replay control
  - Auto-launch Chrome if no active connection
  - Element validation after navigation/click actions
- **Chrome Lifecycle Tracking**: Track Chrome process close events with reasons
  - Close reasons: `inactivity`, `manual`, `crash`, `external`, `signal`, `unknown`
  - View close history via `getChromeStatus()`
  - Better debugging for unexpected Chrome terminations
- **Password Popup Prevention**: Automatically disable Chrome's password manager
  - Prevents save password prompts that block automation
  - Disables password leak detection popups
- **Startup Metrics**: Track MCP server startup performance
  - Measure import, port reservation, server creation times
  - View metrics when debug logging is enabled
  - New `npm run startup:measure` script for diagnostics

### Changed
- Simplified replay sequence storage format (commands inline, not indices)
- `recordCommand` is now async for better error handling
- Improved inactivity cleanup logging for debugging

### Fixed
- Circular dependency issues with port configuration (extracted to dedicated module)

### Technical
- Port configuration extracted to `src/port-config.ts`
- Added stdin close handler for proper cleanup when parent process terminates
- Added uncaught exception and unhandled rejection handlers

---

## [0.1.0] - 2025-11-14

### Added
- Initial release of CDP Tools MCP
- 72 tools for Chrome DevTools Protocol debugging
- Connection management (Chrome and Node.js)
- Breakpoint and logpoint support
- Execution control (pause, resume, step)
- Variable inspection and code search
- Network monitoring and request inspection
- Console log monitoring and search
- Browser automation (navigation, interaction)
- DOM inspection and querying
- Screenshot and PDF generation
- Storage access (cookies, localStorage)
- Content extraction and modal handling
- Token-efficient responses with smart truncation
- Automatic file saving for large data
- Pagination support for logs and requests

### Features
- **Runtime Debugging**: Set breakpoints, inspect variables, step through code
- **Logpoints**: Add logging without code changes (max 20 executions by default)
- **Network Analysis**: Monitor HTTP traffic with request/response inspection
- **Browser Automation**: Automate interactions to reproduce bugs
- **Token Optimization**: Smart truncation, file saving, and pagination
- **Multi-Connection**: Debug Chrome and Node.js simultaneously
- **Source Map Support**: Debug TypeScript with automatic source map loading

### Technical
- Built with Model Context Protocol SDK
- Uses Chrome DevTools Protocol via chrome-remote-interface
- TypeScript implementation with full type safety
- Comprehensive error handling and validation
- Zod schemas for parameter validation

[0.1.0]: https://github.com/InDate/cdp-tools-mcp/releases/tag/v0.1.0
