# Command Replay

Record and replay command sequences for testing, automation, and debugging workflows.

> **Tip:** Use the `replay-agent` (`.claude/agents/replay-agent.md`) to build sequences through investigation - it records your tool calls automatically.
>
> For a condensed, agent-facing version of this material see
> `skills/devharness/references/sequences.md`. This document is the fuller
> reference with worked examples.

## Actions

Every capability below is the one `replay` tool, dispatched on `action`:

| Group | Actions |
|---|---|
| History | `history`, `repeat`, `runFromLog` |
| Authoring | `create`, `recordInteraction`, `insert`, `addConditional`, `declare` |
| Managing | `list`, `get`, `delete`, `export`, `load`, `listSaved`, `deleteSaved` |
| Running | `run`, `runAll`, `step`, `finish`, `status`, `cancel` |

There is no `stopInteraction` and no `save` action - see
[Recording Interactions](#recording-interactions) and
[Saving and Loading](#saving-and-loading).

## Recording Interactions

The easiest way to create a sequence is to record your interactions directly in
the browser.

```javascript
// Launch Chrome with a meaningful name
launchChrome({ reference: "my-signup-test" })

// Start recording - THIS CALL BLOCKS until you finish in the browser
replay({ action: 'recordInteraction', connectionReason: 'my-signup-test' })
```

**`recordInteraction` blocks until the person finishes in the browser overlay.**
There is no separate stop call. The tool call returns only once you click ✓
(complete) or ✕ (cancel) in the overlay, and its response *is* the created
sequence summary. Because it waits on a human, don't call it unattended.

If no connection exists for `connectionReason`, Chrome is auto-launched - but
only if you also pass `startUrl` (or an `issueId` whose issue carries one). If a
connection already exists and you pass `startUrl`, the page navigates there
first.

### The Recording Overlay

A visual overlay appears showing:
- Recording status (`REC` / `PAUSED`)
- Event count and duration
- Coordinates and element info
- Buttons: 💬 Comment | ⏸ Pause | ↺ Reset | ✓ Complete | ✕ Cancel

Pass `showOverlay: false` to suppress it.

### Add Comments

During recording, add comments to document expected behavior:
- Click the 💬 button in the overlay
- Or press **Ctrl/Cmd+Shift+C** (plain comment), **Ctrl/Cmd+Shift+B** (bug),
  **Ctrl/Cmd+Shift+F** (feature)

Comments are attached to the previous action and appear in exported tests.

**Bug and feature comments create issues.** Each `bug`/`feature` comment becomes
an entry in the issue tracker with its own copy of the sequence saved as
`<type>-<id>-repro`. When a recording contains any such comment, no plain
in-memory sequence is created - the issue sequences are the output.

### Naming

The sequence is named, in order of preference:
1. the `name` you passed,
2. `<issueType>-<issueId>-repro` when you passed `issueId`,
3. the `connectionReason`.

If a sequence with that name already exists you get a conflict response. Re-run
with a different `name`, or with `overwrite: true`.

### Recording Options

The conversion from raw input events to sequence commands is tunable. All four
flags default to today's behaviour, so omitting them changes nothing:

| Option | Default | Effect |
|---|---|---|
| `simplifyEvents` | `true` | Collapse noisy raw events (mousemove runs, key repeats) before conversion. `false` keeps them all. |
| `includeHovers` | `false` | Emit `input({ action: 'mousemove' })` steps for hovers. Needs `simplifyEvents: false` to keep more than the settled positions. |
| `preferCoordinates` | `false` | Emit `x,y` clicks even where a selector was captured. Use for canvas/3D/drag-heavy UIs. |
| `preferSelectors` | `false` | Emit selector clicks wherever a selector exists - *including* canvas elements, which otherwise fall back to coordinates. |

If both `preferCoordinates` and `preferSelectors` are `true`, **`preferSelectors`
wins** - the more portable of the two is chosen.

```javascript
replay({
  action: 'recordInteraction',
  connectionReason: 'canvas-bug',
  preferCoordinates: true,   // a WebGL canvas has no useful selectors
  includeHovers: true,       // the bug is a hover artefact
  simplifyEvents: false
})
```

`recordInteraction` also accepts `outputFormat`, which appends a dump to the
usual recording summary:

- `events` - the raw captured input events as JSON (this is the only place they
  are ever available; they are not stored with the sequence)
- `commands` - the converted command list as JSON
- `review` - a human-readable walkthrough of the captured events: one numbered
  entry per interaction with its coordinates, the element and selector found for
  it, plus navigations, pastes and the comments the person left while recording
- `playwright` / `puppeteer` - generated test code for the fresh recording

Use `outputFormat: 'events'` when a recording produced surprising commands and
you need to see what the recorder actually captured; `review` is the same
information in a form you can read, and is the better choice when you want to
decide whether a step should use a selector or coordinates.

### Recording Against an Issue

```javascript
replay({ action: 'recordInteraction', connectionReason: 'bug-7', issueId: 7 })
```

The issue's `type`, `title` and `startUrl` are used automatically, a fullscreen
issue overlay is shown, and the finished sequence is saved into the issues
folder and linked to issue #7.

## Exporting Tests

Export sequences as Playwright or Puppeteer tests:

```javascript
// Export as Playwright test
replay({ action: 'export', name: 'my-signup-test', format: 'playwright' })
// Creates: tests/e2e/my-signup-test.spec.ts
// Also saves: .devharness/sequences/my-signup-test.json

// Export as Puppeteer test
replay({ action: 'export', name: 'my-signup-test', format: 'puppeteer' })
// Creates: tests/puppeteer/my-signup-test.test.js

// Export sequence JSON only (default format)
replay({ action: 'export', name: 'my-signup-test', format: 'sequence' })
// Creates: .devharness/sequences/my-signup-test.json
```

`export` always writes the sequence JSON first, whatever the format. If a target
file already exists you get a conflict response; re-run with `overwrite: true`.

Only `navigate` and `input` steps are translated into Playwright/Puppeteer code
- debugging steps (`breakpoint`, `inspect`, `request`, ...) have no equivalent
and are dropped from the generated test.

### Configure Export Paths

In `.devharness/config.json`:

```json
{
  "replay": {
    "playwrightExportPath": "./tests/e2e",
    "puppeteerExportPath": "./tests/puppeteer"
  }
}
```

### Preview Before Export

```javascript
// Preview as Playwright code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'playwright' })

// Preview as Puppeteer code
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'puppeteer' })

// The raw command list as JSON (what actually gets executed)
replay({ action: 'get', name: 'my-signup-test', outputFormat: 'commands' })
```

`outputFormat` on `get` accepts `commands`, `playwright` and `puppeteer`.
`events` and `review` are not valid here and each returns an error explaining
why: a stored sequence holds converted *commands*, never the raw input events,
and both of those formats render events. The raw events exist only during a
recording - see [Recording Options](#recording-options) for
`outputFormat: 'events'` and `outputFormat: 'review'` on `recordInteraction`.

## Visual Replay Cursor

When replaying sequences, a visual cursor shows where clicks happen:

- **Animated cursor** moves to the click position before clicking
- **Green ripple** on the click
- **Key press toast** shows keyboard input

The cursor is only driven for *coordinate* clicks (`input({ action: 'click', x,
y })`) and for `input({ action: 'press' })`. Selector-based clicks execute
without a cursor effect.

Configure in `.devharness/config.json`:

```json
{
  "replay": {
    "showCursor": true
  }
}
```

## Creating Sequences from History

### From Command History

```javascript
// View command history
replay({ action: 'history', limit: 20 })

// Create sequence from history indices
replay({
  action: 'create',
  name: 'login-flow',
  indices: [1, 2, 3, 4, 5]
})
```

Every tool response footer shows its own history index, so you usually don't
need to call `history` first.

### With Metadata

Add description, expected outcome and a start URL for better documentation:

```javascript
replay({
  action: 'create',
  name: 'login-flow',
  description: 'Logs into the application with test credentials',
  expectedOutcome: 'User should be redirected to dashboard with welcome message',
  startUrl: 'http://localhost:3000/login',
  indices: [1, 2, 3, 4, 5]
})
```

These fields are saved to disk and displayed when listing sequences.

### Re-running History Directly

```javascript
// Execute commands straight from history without making a sequence
replay({ action: 'repeat', indices: [12, 13] })

// Execute lines from .devharness/history.log (1-indexed, line 1 = most recent)
replay({ action: 'runFromLog', lines: [3, 4, 5] })
```

Both stop at the first failing command. Both infer `connectionReason` from a
`launchChrome`/`connectDebugger` command in the selection if you don't pass one,
and error out if the commands need a connection and none can be determined.

## Tool-Name Validation

`create` and `load` reject a sequence whose steps name a tool that doesn't
exist, **before anything runs**:

```
Error: Sequence "login-flow" references 1 unknown tool name
The "load" action was rejected before any step ran, so no browser state was changed.

- Step 4: `navigatee` is not a known tool - did you mean `navigate`?

**Fix:** correct the `tool` field on the listed step(s).
```

Notes:
- Only the tool *name* is checked. Params are deliberately not validated against
  the tools' schemas, because a param may legitimately hold a `{{var:...}}` or
  `{{timestamp}}` token at rest that only resolves to its real type at run time.
- `conditional` is exempt - it is a virtual step tool the executor handles
  itself and it is never a registered tool (see [Conditional Steps](#conditional-steps)).
- A rejected `create` does not clobber an existing same-named sequence; a
  rejected `load` is dropped from memory so it can't be run by id.

## Managing Sequences

```javascript
// List all in-memory sequences
replay({ action: 'list' })

// View sequence details (by sequenceId or name)
replay({ action: 'get', sequenceId: 'seq-1234567890' })
replay({ action: 'get', name: 'login-flow' })  // memory first, then disk (fuzzy name match)

// Delete a sequence from memory
replay({ action: 'delete', sequenceId: 'seq-1234567890' })
```

## Saving and Loading

```javascript
// Export sequence to disk (working directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence' })
// Saves to: .devharness/sequences/<name>.json

// Export to global location (accessible from any directory)
replay({ action: 'export', sequenceId: 'seq-1234567890', format: 'sequence', global: true })
// Saves to: ~/.devharness/sequences/<name>.json

// List saved sequences on disk (add showAll: true to include completed issues)
replay({ action: 'listSaved' })

// Load sequence from disk
replay({ action: 'load', filename: 'login-flow.json' })

// Load into history (for editing)
replay({ action: 'load', filename: 'login-flow.json', intoHistory: true })

// Delete saved file
replay({ action: 'deleteSaved', filename: 'login-flow.json' })
```

`run` and `get` load by `name` from disk on their own, so `load` is only needed
when you want the sequence in memory (or in history) first.

### Editing a sequence mid-session

Edit the file and run it - the edit is what runs. The sequences directories are
watched the way a managed dev server watches its own sources, so an edited file
is re-read into memory shortly after you save it, and a run re-checks the file's
timestamp on the way past rather than waiting for the watcher. Both are needed:
the watcher keeps memory honest while you work, and the check at run time closes
the gap between saving a file and immediately running it.

In-memory copies used to shadow disk for the rest of the session - you edited a
sequence, ran it by name, and silently got the previous version, while `runAll`
reloaded the tree first and ran the new one. The same sequence behaved
differently depending on how it was invoked.

A file that is missing or mid-write leaves the loaded copy in place: a watcher
fires as readily during a write as after one, and dropping a good sequence
because it was caught half-saved is worse than the staleness this replaces. A
sequence built from history and never saved is untouched by any of this - there
is no file to reload it from.

## Running Sequences

### Basic Run

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-1234567890',
  connectionReason: 'test-session'
})
```

Or by name, which also finds it on disk:

```javascript
replay({ action: 'run', name: 'login-flow', connectionReason: 'test-session' })
```

### Background by Default (breaking change in 0.7)

**`run` no longer blocks.** It validates the request (sequence exists, tool
names known, `startFrom` in range, variables supplied), registers a run, and
returns immediately with a run id:

```javascript
replay({ action: 'run', name: 'login-flow' })
// -> Run started in the background ... Run id: `run-3-mdkq1x2`

replay({ action: 'status', runId: 'run-3-mdkq1x2' })   // progress while running,
                                                       // the full result once settled
replay({ action: 'cancel', runId: 'run-3-mdkq1x2' })   // stop it
```

While a run executes, `status` with its `runId` reports the current step and
tool; once the run settles it returns exactly what the old blocking `run`
would have returned (step results, debug state, `killChromeOnFinish` outcome).
Post-run cleanup - cursor/overlay removal, debug state, `killChromeOnFinish` -
happens in the background before the run's status turns terminal, exactly once.

Run states: `running` → (`cancelling` →) one of `completed`, `failed`,
`cancelled`, or `paused` (stepTo / breakpoint / click-validation - drive it
with `step`/`finish` as before).

Lifetime and limits:

- Several runs can execute concurrently, including two runs of the same
  sequence - the run id is what tells them apart.
- Settled runs and their results are kept **in memory for 30 minutes** (at
  most 50 records). After that, or after a server restart (including the
  supervisor's hot-restart on rebuild, which also kills any in-flight run),
  `status`/`cancel` with that id return `REPLAY_RUN_NOT_FOUND`.
- `cancel` with a `runId` aborts the run's controller. The run's signal is
  forwarded to every step's tool handler; cancellation also reaches nested
  sequences (`conditional` flows, nested `replay run` steps) - they share the
  parent run's signal. Status shows `cancelling` until the run actually stops.
  What a cancel does to the step that is currently in flight depends on the
  tool, and the three levels are genuinely different (see the table below).

**Which tools honour cancellation** (canonical list - `#110`):

| Tool | On cancel | What that means |
| --- | --- | --- |
| `wait` (all forms: `selector`, `selectorGone`, `expression`, `ms`) | **cancelled** | Polling/sleep stops mid-step. Nothing was in flight to abandon. |
| `request` (`destination: 'node'`) | **cancelled** | The external signal is composed into the fetch's controller, so the **socket is closed** - the server sees the request aborted. Its own `timeoutMs` is still reported as a timeout, separately. |
| `navigate` (`goto`, `reload`, `back`, `forward`) | **stops waiting** | Deliberate owner decision: `Page.stopLoading` is *not* called, because a half-loaded page that later steps act on is worse than a loaded one. The page finishes loading in the background; the step stops waiting for it. |
| `inspect` (`evaluateExpression`) | **stops waiting** | CDP cannot recall a `Runtime.evaluate`; the expression keeps running in the target. Other `inspect` actions read captured state and only get the entry checkpoint. |
| `content` (`parse`) | **stops waiting** | The plugin's `waitFor` predicate (default up to 8s) is abandoned. Extraction itself is one `page.evaluate`. |
| `input` (every action) | **checkpoint only** | Input events cannot be recalled: once `Input.dispatchMouseEvent` is on the wire, Chrome **will** process it. Cancellation prevents events that had *not* gone out yet - checkpoints sit after connection/selector resolution, immediately before each dispatch, and between events in multi-dispatch paths (Tab loops, drag stepping, clear-and-retype, pinch). A cancelled drag still releases the mouse button. **Nothing already dispatched is undone.** |
| `breakpoint({ action: 'await' })` | **checkpoint + fails the step** | Cancelling the wait removes a breakpoint the step created and fails the step. (Before #110 it reported `success: true` - a cancelled step recorded as passed.) |
| `request` (`destination: 'browser'`) | **checkpoint only** | The `fetch` runs inside the page and is unreachable from the server; it runs to its own timeout. |
| `screenshot`, `content` (other actions), `inspect` (other actions) | **checkpoint only** | Enough not to *start* a capture/read after the cancel; the capture itself is a single call with nothing to cancel. |
| `dom`, `network`, everything else | **next step boundary** | No real wait or loop to interrupt (`network` reads an in-memory buffer). The in-flight call finishes and the run stops before the next step. |

  Two caveats that apply to every row: work already dispatched to the browser
  may still take effect, and a "stops waiting" step leaves work running in the
  target that no one is watching any more.
- A nested run started by a sequence step (a `conditional` flow, or a
  `replay run` step - which is forced to `wait: true`) is part of its parent
  run, never a separate top-level run.

**Migration:** pass `wait: true` to keep the pre-0.7 blocking behaviour:

```javascript
replay({ action: 'run', name: 'login-flow', wait: true })  // blocks, returns full result
```

### Auto-Launch Chrome

If the sequence starts with `launchChrome`, no `connectionReason` is needed -
the launch step's `reference` becomes the run's connection.

```javascript
replay({ action: 'run', sequenceId: 'seq-my-flow' })
```

Otherwise, if the sequence needs a browser and no connection is active, Chrome
is launched as a **fresh instance** using `connectionReason` (or a reference
derived from the sequence name when you didn't pass one).

### Retargeting a Run

```javascript
// Point a staging-recorded sequence at local
replay({ action: 'run', name: 'checkout', baseUrl: 'http://localhost:3000' })

// Enter through a freshly minted link, once
replay({ action: 'run', name: 'magic-link-login', startUrl: 'https://app.example.com/m/abc123' })
```

- **`baseUrl`** rewrites the origin of *every absolute* `http(s)` URL in the
  sequence - the stored `startUrl`, any string param in any step (a
  `navigate goto` url, a `request` url, ...), and the launch `url` of any
  connection the sequence declares - keeping path, query and hash. Relative
  URLs are untouched. The stored sequence is never mutated.
- The retarget travels **into nested sequences**: a `conditional`'s `then` and
  a `forEach`'s `do` load from the recorder in their recorded form, and the
  run's origin is applied to each as it loads, at every depth. Without that a
  retargeted run drives two origins at once - the parent on the target
  deployment, the shared login/setup helper on the recorded one.
- **`runAll`** takes `baseUrl` too, and applies it to every sequence in the
  suite, so one call runs a recorded set against any deployment.
- **`startUrl`** replaces the sequence's start URL wholesale for this run,
  applied after any rebasing. It is per-sequence, so `runAll` ignores it.
- Neither is preserved across a mid-run pause and `step`/`finish` resume, which
  re-reads the stored sequence.

### Timeout Configuration

```javascript
replay({
  action: 'run',
  sequenceId: 'seq-slow-flow',
  connectionReason: 'test-session',
  stepTimeout: 60000,    // per step (default: 30000)
  totalTimeout: 600000   // whole run (default: 300000)
})
```

Each step's tool call is bounded by `min(stepTimeout, remaining totalTimeout)`.
A step that exceeds its bound fails the run at that step, like any other step
failure - the error names the step, the tool, and the limit that fired. The
run stops immediately; the timed-out tool call is not interrupted and may
still complete in the background (its side effects can still land).

Exceptions:

- `wait` steps are exempt from `stepTimeout` - a wait carries its own
  `timeoutMs` bound (default 15000) and fails itself on expiry. It is still
  capped by the remaining `totalTimeout`.
- Breakpoint pauses are unaffected: a step that hits a breakpoint returns
  immediately with pause info, so an intentional pause never trips the
  step timeout.

### Start From a Specific Step

```javascript
replay({
  action: 'run',
  name: 'login-flow',
  connectionReason: 'test-session',
  startFrom: 5  // Skip steps 1-4, start at step 5 (1-indexed)
})
```

`startFrom` beyond the sequence length is rejected.

### Pause, Step, Finish

```javascript
replay({ action: 'run', name: 'login-flow', stepTo: 3 })  // run steps 1-3, then pause
replay({ action: 'status' })                              // where am I?
replay({ action: 'step', stepCount: 2 })                  // run the next 2 steps
replay({ action: 'finish' })                              // run the rest
replay({ action: 'cancel' })                              // drop the paused session
```

A bare `cancel` prefers the paused session; with background runs in flight,
address the one you mean with `runId` (a bare `cancel` also works when exactly
one run is executing and nothing is paused). `status` without `runId` shows
the paused session plus all recent runs.

While paused you can run tools by hand and then splice them into the sequence:

```javascript
replay({ action: 'history' })                    // required before inserting by index
replay({ action: 'insert' })                     // show what's insertable
replay({ action: 'insert', insertIndices: [42, 43], insertAfterStep: 3 })
```

By default `insert` creates a new sequence named `<name>-modified` (override
with `newName`); pass `overwrite: true` to edit the sequence in place.

### Closing Chrome Afterwards

```javascript
replay({ action: 'run', name: 'smoke-test', connectionReason: 'ci-run',
         killChromeOnFinish: true })
```

`killChromeOnFinish` kills the browsers the run **owns**: its own (run-level)
connection, plus every browser a `launchChrome` step actually created. It runs
only after the run finishes - it is skipped on pause, breakpoint,
click-validation failure or abort.

Ownership is read from the launch itself, not guessed from the sequence: a
`launchChrome` step against a reference that already exists hands back someone
else's browser (`CHROME_CONNECTION_REUSED`), and those are left running - that
is the long-lived instance you started by hand, and killing it would take state
you cannot get back.

For the same reason the kill is **skipped entirely when another live connection
shares the port** — a `launchChrome` step normally opens a tab in the existing
instance rather than a new process, so killing by port would take those
browsers down too. The run says so instead: *"Chrome left running (port 9224
also serves duo-member-two, killChromeOnFinish)"*. Disconnect or close the other
connections first if you want the instance gone.

On `runAll` the flag means the **suite's** finish: only the last sequence
carries it. A teardown between sequences would destroy the state a `_helpers`
preamble just established, and a suite that stops early (`continueOnFailure:
false`, a cancel) leaves the browsers up for the failure to be read in.

### Preview Sequence

```javascript
replay({ action: 'get', name: 'login-flow' })
// Shows: commands, substitutable variables, metadata, and run instructions
```

## Variables: Two Unrelated Mechanisms

`replay` has two features that both get called "variables". They share nothing
but the word.

| | `variables` on `run` | `saveAs` + `{{var:...}}` |
|---|---|---|
| What it does | Replaces **recorded typed text** before the run | Captures a **value produced mid-run** for later steps |
| Set where | A parameter of `replay({ action: 'run' })` | A param on an individual sequence step |
| Read where | Only by `input({ action: 'type' })` steps | Any step param, via `{{var:name}}` |
| Naming | Auto-generated `var_<i>_<selector>` keys | Names you choose |

### 1. `variables` - substituting recorded typed text

Every recorded `input({ action: 'type' })` step gets an auto-generated key of
the form `var_<0-based step index>_<selector, non-alphanumerics replaced by _>`
(or `var_<i>_text` when the step has no selector).

The selector is transformed, not quoted: `#email` becomes `_email`, so step 2
against `#email` is keyed `var_2__email` - **two** underscores, one from the
separator and one from the `#`. A key that names no typed-text step is
rejected before anything runs, with the substitutable keys listed - the same
rule `connections` applies to a reference naming no recorded step, and for the
same reason: an ignored key would leave the step on its recorded text while
the call read as an override.

```javascript
// Original recording had: input({ action: 'type', selector: '#email', text: 'original@email.com' })
replay({
  action: 'run',
  sequenceId: 'seq-login-flow',
  connectionReason: 'test-session',
  variables: {
    'var_2__email': 'new@email.com',
    'var_3__password': 'newpassword'
  }
})
```

`replay({ action: 'get', name: '<sequence>' })` prints the keys as the executor
builds them, and so does the prompt a `run` returns when typed text is present
and `variables` is omitted. Read them from there rather than composing them by
hand.

The substitutions reach **nested sequences** - a `conditional`'s `then` and a
`forEach`'s `do`, at every depth - so a key naming a step in a shared login
helper lands there. `runAll` holds one map for the whole suite and validates it
against the union of the selected sequences: a key matching any member is
accepted, and each sequence substitutes on the keys that name its own steps.

A supplied value does not remove the recorded literal, which stays in the
sequence file under `.devharness/sequences/` (gitignored, still plaintext on
disk). For a credential, use `{{env:NAME}}` instead - see below.

### Keeping a secret out of the sequence file: `{{env:NAME}}`

Any step param may hold `{{env:NAME}}`, resolved from `process.env` when the
step runs. The file holds the token, the value lives in the environment, and
neither the file nor the tool call carries the secret.

```javascript
// In the sequence file:
{ tool: 'input', params: { action: 'type', selector: '#password', text: '{{env:APP_PASSWORD}}' } }

// The run needs nothing else:
replay({ action: 'run', name: 'login', connectionReason: 'app' })
```

- An **unset or empty** variable fails the step, naming the variable. Resolving
  to `''` would submit a blank password and surface as a confusing downstream
  failure instead of the missing configuration that caused it.
- The name must match `[A-Za-z_][A-Za-z0-9_]*`. `{{env:app-password}}` is not a
  token and passes through as literal text.
- A token-bearing step does **not** hold the run open for a `variables`
  answer - its value arrives at run time by definition. It stays substitutable,
  and an explicitly supplied `variables` value **wins over** the environment,
  because interpolation runs first and the substitution overwrites it.
- Environment values are strings, so a whole-string `{{env:PORT}}` yields
  `"3000"`, not `3000`.

#### Pointing a run at a file: `envFile`

```javascript
replay({ action: 'run', name: 'login', connectionReason: 'app',
         envFile: 'sequences.env' })
```

```bash
# sequences.env
APP_PASSWORD=hunter2
export APP_USER="alice"   # export prefix and surrounding quotes are accepted
```

- A **relative** path resolves against the project directory (the one holding
  `.devharness`); an absolute path is used as-is.
- The file's values **win** over the server's own environment. The caller named
  this file for this run; a stale ambient variable shadowing it would
  substitute a different credential with nothing in the output to say so. A
  name the file omits falls through to `process.env`.
- `process.env` is **never written**. Two background runs may name different
  files, and a global write would let one run's credentials resolve inside the
  other. It follows that changing the file needs no client restart, unlike the
  environment of a running server, which is fixed when it starts.
- A **missing file**, or a line that is neither blank, a `#` comment, nor
  `NAME=value` with a name matching `[A-Za-z_][A-Za-z0-9_]*`, fails as a
  parameter error before any step runs - not halfway through a flow that has
  already logged in. A skipped line would read as a set variable.
- There is **no `$VAR` expansion** inside values. A password containing `$` is
  ordinary, and expanding it would type something else.
- `runAll` takes it too, applying the same file to every sequence in the suite.

**If the sequence contains any typed text and you omit `variables` entirely,
`run` does not execute** - it returns a prompt listing the substitutable keys
and their recorded values. Pass `variables: {}` to accept the recorded values
as-is, or supply the keys you want to change.

### 2. `saveAs` and `{{var:name.path}}` - capturing values mid-run

A step can capture its own result into the run's variable store with `saveAs`.
Later steps read it back with `{{var:name}}` / `{{var:name.path}}` in any
param.

Supported on exactly two tools today:

| Step | What gets stored |
|---|---|
| `request` | the **whole response object** - address into it: `{{var:login.body.token}}` |
| `inspect({ action: 'evaluateExpression' })` | the **evaluated value itself** - use it directly: `{{var:pairingUrl}}` |

```json
{ "tool": "request", "params": {
    "url": "https://api.example.com/login", "method": "POST", "saveAs": "login" } }

{ "tool": "inspect", "params": {
    "action": "evaluateExpression",
    "expression": "document.querySelector('#pair').href",
    "saveAs": "pairingUrl" } }

{ "tool": "navigate", "params": { "action": "goto", "url": "{{var:pairingUrl}}" } }

{ "tool": "assert", "params": {
    "left": "{{var:login.body.token}}", "operator": "exists" } }
```

Behaviour worth knowing:

- A `saveAs` that cannot be honoured (unsupported tool, or a call that produced
  nothing capturable) **fails the step**. It is never a silent no-op, because the
  failure would otherwise surface far away as a confusing "no variable named ..."
  message.
- Async expressions work: a Promise returned by `evaluateExpression` is awaited
  by default, so an async IIFE (IndexedDB read, `crypto.subtle`, `fetch`)
  captures its **settled value**, not the Promise object. A rejection fails the
  step with the expression's own error.
- JSON-serializable results are captured **by value** (exact - a string `"42"`
  stays a string). Values that only render as a description (`[HTMLDivElement]`,
  `Array(3)`) come back as strings - capture a specific field, not a whole DOM
  object.
- The store is shared by reference across the whole run, including nested
  `conditional` sequences and steps running on other connections, and it
  survives a mid-run pause into `step`/`finish`.

### Interpolation Tokens

`{{var:...}}` and `{{timestamp}}` are resolved in a step's params immediately
before it executes.

- `{{timestamp}}` - milliseconds, computed **once per run** and reused by every
  step (including later `step`/`finish` calls), so all steps agree on it.
- `{{timestamp+3600000}}` / `{{timestamp-1000}}` - the same run timestamp with a
  millisecond offset, for expiry-style fields.
- `{{var:a.b.c}}` - dot-separated path. For a key containing a literal dot, use
  bracket notation for that segment: `{{var:a.b['exec.t1.s2'].c}}`.
- **Whole-string tokens keep their type.** `"right": "{{var:r.body.count}}"`
  resolves to the number `3`; `"name": "kit{{timestamp}}"` resolves to the
  string `"kit1699999999999"`.
- An unresolvable token fails the step with a message telling you which
  `saveAs` to add.

## Per-Step Connections (Multi-Device Sequences)

Any step may carry its own `connectionReason`. Steps that don't get the
run-level connection injected (for the tools that accept one).

```json
{ "tool": "input",    "params": { "action": "click", "selector": "#pair",
                                  "connectionReason": "device-a" } }
{ "tool": "inspect",  "params": { "action": "evaluateExpression",
                                  "expression": "document.querySelector('#code').textContent",
                                  "saveAs": "code", "connectionReason": "device-a" } }
{ "tool": "navigate", "params": { "action": "goto", "url": "{{var:code}}",
                                  "connectionReason": "device-b" } }
```

A per-step connection is honoured for **everything wrapped around the step**,
not just for dispatching it: pre/post-click state capture, click validation,
navigation validation, typed-text validation, breakpoint/pause detection,
failure diagnostics, and the wait for the *next* step's element (which follows
the next step's connection). That is what makes "device A scans, device B
confirms" work in a single run.

Details:

- Connection injection applies to `navigate`, `content`, `input`, `console`,
  `network`, `dom`, `screenshot`, `storage`, `inspect`, `execution`,
  `breakpoint`, `getSourceCode`, `detectModals`, `dismissModal`.
- `request` is handled separately: it only receives a connection when the step
  sets `destination: 'browser'`, so Node-targeted sequences never drag a Chrome
  launch in.
- Only the browser-only tools (the first group above) make a sequence
  "need a connection" and trigger Chrome auto-launch. A Node-only debugging
  sequence won't spuriously launch Chrome.
### Recording a multi-connection sequence

Recording **preserves** `connectionReason` (it used to be stripped, which meant
a recorded two-browser sequence silently replayed in one). Pass it explicitly on
**every** call while you drive the browsers, including the one that is already
active, then `create` decides what to do with it:

| Recording | `create` result |
|---|---|
| All steps on one connection | Hoisted off the steps, so the sequence stays portable and `run({ connectionReason })` still retargets it |
| Genuinely spans connections | Kept per step |
| **Mixed** — some steps named, others driven implicitly | Kept as-is, with a warning |

The mixed case can't be resolved automatically: nothing knows which browser the
bare steps belonged to, so hoisting could pin them to the wrong one. `create`
says so in its output; re-record naming every step rather than shipping it.

"Bare" means any step that would have the run-level connection injected — which
includes the tools whose `connectionReason` is *optional* (`inspect`,
`execution`, `storage`, `network`, `breakpoint`, `request`, `getSourceCode`),
not just the browser-only ones. Those are the ones people actually leave off.
`wait({ ms })` is a plain sleep and doesn't count; every other `wait` form does.

A sequence can be both multi-connection **and** mixed, and that combination is
the dangerous one: the bare steps land in a different browser depending on the
run-level `connectionReason`, and the run reports success either way. `create`
warns about both.

### Inserting into an existing sequence

`insert` splices history commands (which now carry their connection) into a
sequence whose own steps had theirs hoisted off. To compare like with like it
first re-stamps the hoisted connection — recorded on the sequence as
`recordedConnection` — onto its bare steps, then re-normalizes the merged array:

| Inserted steps came from | Result |
|---|---|
| The same browser as the sequence | Hoisted again — still portable |
| A different browser | Every step made explicit, so the sequence is a real multi-connection one and the run-time existence check applies |

Without that re-stamp the merge always looked "mixed" (one named reference plus
the sequence's own bare steps), the hoist was skipped, and an ordinary
same-browser insert silently left the sequence half-pinned to this session — so
a later `run({ connectionReason })` split it across two browsers and passed.

### Rebinding references at run time

Recorded references are per-session, so a sequence recorded elsewhere needs its
names mapped onto this session's:

```javascript
replay({
  action: 'run',
  sequenceId: 'duo-stock-propagation',
  connections: { 'duo-member-two': 'my-second-browser' },
})
```

Recorded name on the left, a reference from this session on the right. Both
sides are sanitized, so spaced forms work. A key matching nothing in the
sequence is rejected before anything runs, listing the references the sequence
actually uses — a typo fails loudly instead of being ignored. "The sequence"
includes any sequence reached through a `conditional` step, since a setup
sequence normally lives behind one; when such a sub-sequence can't be resolved
in memory the key is accepted rather than guessed at.

A step naming a connection other than the run's is checked against the live
session before it runs, whether or not the sequence spans several connections,
so a missing browser fails as *"step 3 needs connection duo-member-two, which
does not exist in this session"* instead of a generic "not connected to browser"
from inside the tool.

Mapping also renames the `reference` on `launchChrome` / `connectDebugger`
steps; otherwise a mapped sequence would launch the recorded name and then drive
a different one. Where a mapping renames a launch, it wins over the run-level
`connectionReason`, which would otherwise rename it straight back.

**Two recorded references cannot be mapped onto one browser.** That would run
the whole multi-browser sequence in a single browser and report success — the
original bug, re-entered through the API that exists to prevent it — so it is
rejected before anything runs.

The run-level connection is mapped too when it was *derived* from the sequence
(e.g. from a `launchChrome` step) rather than passed explicitly; otherwise it
would point at a reference that doesn't exist here and the `startUrl` navigation
and cursor injection would silently no-op.

`issues({ action: 'workOn' | 'resolve' })` accepts `connections` as well, so a
multi-browser repro sequence attached to an issue can be replayed in a fresh
session.

### Declaring the browsers a sequence needs

A multi-browser sequence can say which browsers it needs, instead of expecting
whoever runs it to have launched them first. Set it with `declare`:

```javascript
replay({
  action: 'declare',
  name: 'duo-stock-propagation',
  requiredConnections: [
    { reference: 'duo-member-two', profile: 'device-a', role: 'the member who draws stock' }
  ],
  requiredSockets: ['/api/sync/socket'],
})
```

Each list **replaces** its field and `[]` clears it — a declaration is a whole
statement about the run, and merging would make "drop the second browser"
unexpressible. Passing only one list leaves the other alone. The sequence is
written back to the file it came from; a memory-only sequence waits for
`export`. Declarations that cannot mean what they say (two references on one
profile, a reference declared twice, a profile name that is not a safe
directory segment, an empty socket pattern that would match every socket) are
refused here rather than on the next run.

It lands on the sequence next to `commands`:

```json
{
  "name": "duo-stock-propagation",
  "startUrl": "http://localhost:5173/",
  "requiredConnections": [
    { "reference": "duo-member-two", "role": "the member who draws stock",
      "url": "http://localhost:5173/login" }
  ],
  "commands": [ ... ]
}
```

| Field | Meaning |
|---|---|
| `reference` | The reference the steps use |
| `profile` | Named persistent Chrome profile to come up on (see below) |
| `url` | Opened on launch (defaults to the sequence's `startUrl`) |
| `forceNewInstance` | A separate browser process rather than a tab, default **true** — two identities sharing one browser share its storage, which defeats the point. Defaults to **false** when `profile` is set |
| `role` | Why this browser exists, for the run summary |

The run brings each one up before the first step. A reference already bound to
a live browser is reused, so a browser you launched by hand is not duplicated,
and a `connections` mapping wins over the declaration — the declaration
supplies a default, it does not override where the caller points the steps. A
browser that cannot be launched fails the run before any step executes, naming
the reference and its role.

The run **closes what it launched**, on every terminal outcome: completed,
failed, and cancelled. A pause is the exception — those browsers are the state
you stopped to inspect — but whatever ends the pause (`cancel`, `finish`, or
stepping off the end) closes them then. Browsers that were already up are left
alone, and a browser sharing its port with another live connection is left
running too. The run says which it closed:

```
**Browsers closed** (declared and launched): duo-member-two
```

#### Declaring the device, not just the browser

`profile` names a persistent Chrome profile (the same ones
`launchChrome({ profile })` creates, under `~/.devharness/profiles`):

```json
"requiredConnections": [
  { "reference": "device-a", "profile": "device-a", "role": "the enrolled device" }
]
```

The profile is the durable half. Its cookies, localStorage and IndexedDB —
including non-extractable CryptoKeys — survive between runs, so a device
enrolled once stays enrolled, while the reference is only a name for this
session. Declaring the pair is what lets a saved multi-device sequence be re-run
tomorrow without rewiring which reference means which device.

Steps still address browsers by `connectionReason`. There is no per-step
`profile`: a step names a browser, the declaration decides what that browser
is.

Two consequences worth knowing:

- **A profile implies reuse.** Only one live Chrome may hold a profile, so
  `forceNewInstance` defaults to `false` here — a Chrome already running that
  profile *is* the browser the declaration wants, whatever reference it is
  bound to. Set `forceNewInstance: true` explicitly if you really want a spawn
  attempt.
- **A profile-bearing reference cannot be rebound.** Elsewhere a `connections`
  mapping wins over a declaration, because a declaration is only a default. A
  profile is an identity claim: pointing `device-a` at another browser would run
  device-a's steps somewhere that is not device-a and report success. The run is
  refused instead. Two declarations naming the same profile are refused for the
  same reason — they would be one browser wearing two names.

Teardown kills the browser, never the profile: the directory is persistent, so
the next run finds the device exactly as this one left it.

### Saying what kind of sequence it is

`tags` are free-form labels the suite runner selects on:

```javascript
replay({ action: 'declare', name: 'spine-09-retire-asset', tags: ['ui'] })
replay({ action: 'declare', name: 'story-b1-pool',        tags: ['contract', 'slow'] })

replay({ action: 'runAll', tags: ['ui'] })              // only those
replay({ action: 'runAll', folder: 'spine', tags: ['ui'] })  // composes with folder
```

Several tags mean **any of**. Tags are lowercased, trimmed and de-duplicated on
the way in — a tag is matched, not displayed, and `tags: ['UI']` skipping a
sequence tagged `ui` would quietly run less than you asked for. Spaces are
refused for the same reason: `slow ui` is ambiguous in a filter, `slow-ui`
isn't.

Every `runAll` reports the split, filtered or not:

```
runAll folder "tagcheck": 3 passed, 0 failed (1 contract, 1 ui, 1 untagged)
```

That line is the point of the feature. A suite of 43 sequences reporting "36
passed" reads as interface coverage, and 14 of those may never issue an `input`
step — `navigate` → `request` → `assert`, with the browser present only to hold
the auth cookie. Good contract tests, but no UI regression can fail one of
them. The split makes the balance visible on every run instead of on an audit.

Folders can't carry this: they're already spoken for by scenario shape
(`spine/`, `story/`, `_helpers/`), and a sequence has one folder but can
legitimately be both `contract` and `slow`.

### Declaring the sockets a sequence depends on

`requiredSockets` is the same idea for transports: a list of URL substrings
naming the WebSockets the sequence's assertions ride on. Set by the same
action:

```javascript
replay({ action: 'declare', name: 'duo-stock-propagation',
         requiredSockets: ['/api/sync/socket'] })
```

A sequence that declares them is checked whether or not the caller asks for it
(`requireSockets: true` is only needed for a sequence that declares none). For
each entry the run fails when a matching socket closed or hit frame errors
while it executed, or when none is open at the end — including one that never
opened at all, which no "is it up now" final assertion can catch. Closes the
run did not cause are not blamed on it: a socket torn down with its target by a
navigation, or hung up by the page itself, is normal.

Match on the app's own path rather than the origin, so the declaration survives
`baseUrl` retargeting. Dev-server sockets (Vite HMR and friends) simply go
undeclared and are ignored.

### repeat / runFromLog

History retains the connection each command was recorded with, so both replay
each command against its own connection by default. An explicit
`connectionReason`:

- **retargets** a batch that used a single connection (what the parameter has
  always meant), and
- is **refused** for a batch spanning several connections, since no single value
  is honest there.

It is deliberately not silently ignored — for a while it was, which broke a
documented parameter with no signal at all.

### Exported test code

`outputFormat: 'playwright' | 'puppeteer'` gives each recorded connection its own
page (`page`, `pageDuoMemberTwo`, …), with a header naming the browsers. A
single-connection sequence generates exactly what it always did. Emitting every
step against one `page` would relocate the same silent collapse into the
exported test.

The generators only know `navigate` and `input` steps. Anything else —
`conditional`, `launchChrome`, `inspect`, `storage`, `wait`, `breakpoint` —
becomes a `// [not generated]` comment naming the step, and a sequence where
*nothing* could be generated exports a test that **throws** rather than an empty
one that passes. A setup sequence made of a conditional and a launch has no
Playwright equivalent at all; run it with `replay({ action: 'run' })` instead of
exporting it.

### Two deliberate non-behaviours

- **A run-level `connectionReason` does not override a step's own.** The step
  wins.
- **A per-step reference that doesn't exist fails the step.** It never falls
  back to the run-level connection.

The second is the whole point. Falling back is what let a two-browser sequence
replay in one browser and report success — the "member" steps ran in the owner's
browser, the owner saw their own optimistic update, and a cross-user propagation
assertion went green having never involved a second user.

## Conditional Steps

`conditional` is a virtual step tool: it is handled inside the executor, never
appears in the tool list, and is exempt from tool-name validation.

Not being a real tool, it is never recorded, so `create` and `insert` — which
both build steps out of recorded history — cannot produce one. `addConditional`
is its authoring action:

```javascript
replay({ action: 'addConditional',
         name: 'checkout-flow',              // or sequenceId
         condition: '{{selector:.cookie-banner}}',
         thenSequence: 'dismiss-cookie-banner',
         insertAfterStep: 2,                 // omit to append; 0 puts it first
         comment: 'EU builds only' })        // optional
```

which stores the step as:

```json
{ "tool": "conditional", "params": {
    "if": "{{selector:.cookie-banner}}",
    "then": "dismiss-cookie-banner" } }
```

Rejected before the sequence is touched: a condition that doesn't parse, an
unknown type, an uncompilable or over-long `url:matches` regex, a malformed
`indexedDB` path, a `thenSequence` naming no known sequence or naming this one
(which would recurse to `maxConditionalDepth`), an out-of-range
`insertAfterStep`. Values holding a `{{var:...}}` token are skipped — they are
substituted at run time.

A sequence already saved on disk is rewritten in place; otherwise it waits for
`export`. The response says which.

`then` is the name of another sequence, loaded and run inline when the condition
holds, and it shares the parent run's captured variables. A `launchChrome` step
inside it is skipped when that reference is already connected, and run when it
isn't - so a setup sequence spanning two browsers can create the second one.

Which browser the sub-sequence's *bare* steps run in follows from that:

| The nested `launchChrome` | Bare steps run in |
|---|---|
| **ran** (that browser didn't exist) | the browser it just launched |
| **skipped** (already connected), or absent | the calling run's connection |

That split is what makes both shapes work. A setup sequence is a launch plus
bare steps (`create` hoists the connection off them), so its steps have to
follow the browser it created - otherwise the run opens a browser, does the work
in the *caller's* browser, and still reports success. A nested login sequence
whose browser already exists keeps running in whatever browser called it. Steps
that name their own `connectionReason` are unaffected either way.

> **Two connections are not two devices.** A plain `launchChrome` reuses the
> running instance and opens a *tab* in it, so both references share one profile
> - one set of cookies, one localStorage, one IndexedDB. A duo test built that
> way has a single device identity wearing two names, and a "does it propagate
> to the other user" check passes without a second device ever existing. Give
> the second browser its own `profile` (and `forceNewInstance: true`) when the
> point of the test is that the two sides are genuinely separate:
>
> ```javascript
> launchChrome({ reference: 'duo-member-two', profile: 'member', forceNewInstance: true })
> ```
>
> `listConnections` shows the giveaway: same `port` means same instance and
> therefore shared storage.

Supported conditions:

| Condition | True when |
|---|---|
| `{{selector:CSS}}` / `{{!selector:CSS}}` | element exists / doesn't |
| `{{url:contains:STRING}}` | current URL contains the string |
| `{{url:matches:REGEX}}` | current URL matches the regex |
| `{{url:EXACT}}` | current URL equals the value |
| `{{cookie:NAME}}` / `{{!cookie:NAME}}` | cookie exists / doesn't |
| `{{localStorage:KEY}}` / `{{!localStorage:KEY}}` | key exists / doesn't |
| `{{indexedDB:DB/STORE/KEY}}` / `{{!indexedDB:...}}` | that record exists / doesn't |
| `{{indexedDB:DB/STORE}}` | the object store holds at least one record |

An element that isn't on the page counts as *absent*, not an error, so
`{{!selector:...}}` skips correctly. A malformed selector or a disconnected
browser still fails the run. The page is probed once with no retry (precede an
async marker with a `wait` step), and a hidden element counts as present.

Every condition reads the tool's structured result, never its printed text, so
stored *data* cannot answer a question about *structure*: a localStorage value
of `"null"` (or one containing "not found") is present, an empty string is
present, a cookie name matches exactly rather than as a suffix, and a URL
containing a comma compares in full.

A database or store that doesn't exist yet counts as *absent*, not as an
evaluation error - that is the state a wiped profile is in, and the state a
healing setup sequence exists to fix. A value that cannot be represented in
JSON (a non-extractable `CryptoKey`, a `Blob`) still counts as present.
Presence comes from the storage tool's structured result, not its printed text,
so a record whose *value* happens to read "No record found for this key." is
still present. A condition is written as text, so an all-digits key is probed as
a string and then, if that misses, as a number - IndexedDB keys `42` and `"42"`
are different keys.

A condition is interpolated like any other step parameter, so a captured
variable can drive it — `{{indexedDB:identity/keys/{{var:deviceId}}}}` after an
earlier `inspect({ saveAs: 'deviceId' })`.

A condition that is legitimately *not met* skips the nested sequence and the
step counts as a success. A condition that cannot be *evaluated* (bad format,
unknown type, invalid or over-long regex, tool error) fails the run.

Nesting is capped by `replay.maxConditionalDepth` (default 10) and regexes by
`replay.maxRegexLength` (default 500); both are `.devharness/config.json`
settings. Oscillating chains (A→B→A) are allowed up to the depth limit.

## forEach Steps

`forEach` is the second virtual step tool: handled inside the executor, never a
registered tool, exempt from tool-name validation via `VIRTUAL_STEP_TOOLS`.

```json
{ "tool": "forEach", "params": {
    "in": "{{var:shares}}",
    "as": "share",
    "do": "revoke-one-share",
    "where": "item.name !== 'Employees'",
    "maxItems": 50 } }
```

It exists because conditions are single-subject. `{{selector:X}}` answers "does
X exist"; there is no condition that answers "what is there", so a sequence could
provision a missing fixture but never remove an unexpected one. That asymmetry is
what made shared-fixture suites drift.

`in` resolves in one of two ways. `{{var:name}}` is a whole-string interpolation
token, so **the run's normal param interpolation resolves it before the step is
dispatched** and — because whole-string tokens preserve type — what the step
receives is the captured array itself, not a string. `resolveForEachItems`
therefore accepts an array directly; its string branches only matter for direct
calls and for `{{selectorAll:CSS}}`, which is not a var token and arrives
unresolved. `{{selectorAll:CSS}}` evaluates in the page and yields one plain
descriptor per element (`index`, `text`, `id`, `className`, `href`, `value`) —
DOM nodes cannot cross the CDP boundary.

`where` is evaluated as JavaScript in the page with `item` and `index` in scope,
**not** in the `{{...}}` condition grammar. A filter reads fields off an
arbitrary object, which that grammar cannot express, and adding a second
mini-language beside it would leave two half-expressive syntaxes. A `where` that
throws fails the run rather than excluding the item, matching how an
unevaluatable condition behaves.

Per-iteration the item is written to the shared variable store under `as` (and
its position under `<as>Index`). The store is shared by reference with nested
runs, so bindings are replaced rather than scoped, and a body's own `saveAs`
captures persist across iterations.

Budget is the parent's *remaining* total, decremented per iteration, so a loop
cannot extend the run's total the way a fresh copy would. Depth shares
`maxConditionalDepth`: a loop body that loops is the same runaway risk as a
conditional chain. `maxItems` (default 100) is a backstop, and hitting it is
logged rather than silently truncating.

An empty source is a success with `iterations: 0`, rendered as "N item(s) found,
none ran" — a converge loop with nothing to do must not look like a broken
selector.

## Teardown Steps

`CommandSequence.teardown` is an optional second command array, run by
`runTeardown` after the main loop in `executeSteps` reaches a terminal state.

Terminal means: all steps ran, a step failed, the run was aborted, or the total
timeout expired. It explicitly does **not** include the pause paths — `stepTo`
(detected as `targetEnd < commands.length` with nothing failed), an unexpected
breakpoint, or a click-validation failure, which return early and never reach the
teardown call. A paused run is not finished, and tearing down would destroy the
state the user paused to inspect.

Three deliberate departures from how nested sequences are otherwise run:

| Property | Why |
|---|---|
| Own `teardownTimeout` (default 60s), not `totalTimeout` | The commonest reason a run needs cleanup is that it timed out. Drawing on the exhausted parent budget would skip teardown in exactly that case. |
| The run's `AbortSignal` is not forwarded | `replay cancel` must stop the work, not the cleanup. A cancelled run is precisely one that has left something behind. |
| Shares `ctx.variableStore` | Teardown revokes what setup minted, and the capturing step may have run long before the failure. |

The synthetic sequence passed to the nested `executeSteps` call sets
`teardown: undefined`; without it the teardown run reaches the same code and runs
the teardown again, unboundedly.

Results land on `ExecutionResult.teardownResults` / `teardownFailed` and are
rendered in their own section — never merged into `results` or the
successful/failed counts. A broken cleanup must not turn a passing run red, nor
make a failing one look like it failed somewhere it did not.

Teardown is best-effort by construction: a killed devharness process takes any
pending teardown with it. It reduces accumulation; it cannot guarantee a clean
world, so assertions that depend on absence remain order-dependent regardless.

## Debug-Aware Replay

Replay handles debugging sequences specially.

### Fresh callFrameId Replacement

When replaying `inspect({ action: 'getVariables' })` with a recorded
`callFrameId`, replay fetches the current call stack on that step's connection
and swaps in a fresh ID.

### Auto-Resume

If the debugger is already paused when a run starts (or when checking an
existing connection), replay resumes it first, so a leftover pause from a
previous run can't stall the sequence.

### Expected vs Unexpected Breakpoints

Replay tracks breakpoints that the sequence itself sets (`breakpoint({ action:
'set' })`), including ±1 line to absorb CDP's 0-based/1-based resolution. After
each step it checks whether execution is paused:

- paused at a breakpoint this sequence set → **keep going**;
- paused anywhere else → **stop and report the breakpoint hit**, with the pause
  location and the connection to inspect it on.

### Debug State Output

After a run that completed with no failures, if breakpoints are active or
execution is paused, replay appends the current debug state:

```
## Debug State

⏸️ **Execution paused** at http://localhost:3101/client.js:6

**Next steps:**
- Inspect call stack: `inspect({ action: 'getCallStack', connectionReason: '...' })`
- Get variables: `inspect({ action: 'getVariables', connectionReason: '...', callFrameId: '<from call stack>' })`
- Resume execution: `execution({ action: 'resume', connectionReason: '...' })`
- Step over: `execution({ action: 'stepOver', connectionReason: '...' })`

🔴 **1 active breakpoint**
- List breakpoints: `breakpoint({ action: 'list', connectionReason: '...' })`
```

## Step Robustness

Beyond click validation, each step gets some automatic help:

- **Retries:** `input` `click` / `type` / `hover` retry up to 5 times, 500ms
  apart, when the failure looks like "element not found" - enough for a
  component that hasn't mounted yet.
- **Element pre-wait:** after a `navigate` step or a click, if the next step is
  an `input` with a selector, replay waits for that selector (5 tries, 500ms
  apart) on the *next step's* connection.
- **Navigation validation:** after every `navigate` step, replay checks the page
  didn't land on `about:blank`, a `chrome-error://` page, an `ERR_*`, or a
  "site can't be reached" title.
- **Port check:** before navigating to a `localhost` URL (including the
  sequence's `startUrl`), the port is checked and the run fails fast with a
  clear message rather than loading an error page.
- **Typed-text validation:** after `input({ action: 'type', selector })`, the
  field's value (or `innerText` for contenteditable) is compared against what
  was typed - exact match, or "ends with" when `append: true`.
- **Recorded delays:** delays captured during interaction recording are replayed
  (capped by `replay.maxDelayMs`, default 1000ms).

These are best-effort niceties with short, fixed budgets. When a step
genuinely depends on async work settling - a page load after `location.href`,
a spinner clearing, an async probe writing a global - add an explicit `wait`
step instead of relying on them.

## Explicit Waits (`wait` steps)

`wait` is a first-class sequence step for "the previous step kicked off async
work". Exactly one of four mutually exclusive forms:

```javascript
{ tool: 'wait', params: { selector: 'button:has-text("Join")' } }  // element appears
{ tool: 'wait', params: { selectorGone: '.spinner' } }             // element disappears
{ tool: 'wait', params: { expression: 'window.__probe !== "PENDING"' } }
{ tool: 'wait', params: { ms: 500 } }                              // fixed sleep, last resort
```

- The condition forms are polled **from the MCP side** as a synchronous check
  (default `pollIntervalMs` 100, `timeoutMs` 15000). Because nothing waits
  inside the page, a wait survives a navigation that happens mid-wait (each
  poll simply runs in whatever document exists at that moment) and never
  depends on in-page timers or promises resolving.
- `expression` must be synchronous - don't `await` in it. Kick async work off
  in a prior step, have it write a global, and wait on the global.
- On timeout the step returns an error (`WAIT_TIMEOUT`, including the last
  evaluation error if the predicate was throwing), which stops the sequence
  like any other failed step. A `wait` never hangs a run.
- The run-level `connectionReason` is injected like any other step, and a
  per-step `connectionReason` is honoured (multi-device sequences).
- `wait({ ms })` needs no browser at all and never triggers a Chrome
  auto-launch; `wait({ expression })` also works against a Node.js target.

## Click Validation

Click steps validate their effects. When validation fails, the sequence pauses
for inspection rather than failing outright.

### What Gets Validated

- **Console errors**: new errors after the click (default: enabled, fail mode `error`)
- **Navigation**: if the click caused navigation, that it succeeded (default: enabled)
- **DOM mutations**: whether the click changed anything (default: disabled)
- **Network requests**: failed POST requests (default: disabled)

New console warnings and logs are recorded as information only.

### Pause on Failure

When validation fails the sequence pauses **on the failed step** - the active
sequence's cursor is rewound so the next `step` re-runs it. You can:

- inspect the error state with `console`, `network`, `dom`, `screenshot`, ...
- retry the failed step: `replay({ action: 'step', stepCount: 1 })`
- run the rest: `replay({ action: 'finish' })`
- abandon it: `replay({ action: 'cancel' })`

There is no "skip this step" action - `step` always re-runs the step it is
parked on.

### Configuration

Configure in `.devharness/config.json` (values shown are the defaults):

```json
{
  "clickValidation": {
    "enabled": true,
    "validateNavigation": true,
    "requireDomChanges": false,
    "domChangesFailMode": "warn",
    "failOnConsoleErrors": true,
    "consoleErrorsFailMode": "error",
    "validateNetworkPayload": false,
    "networkFailMode": "warn",
    "postClickDelayMs": 100
  }
}
```

**Fail modes:**
- `error`: pauses the sequence for inspection
- `warn`: logs a warning and continues

## Use Cases

### Regression Testing

```javascript
// Record interactions directly - this call blocks until you click ✓ in the browser
launchChrome({ reference: "checkout-test" })
replay({ action: 'recordInteraction', connectionReason: 'checkout-test' })

// Export as Playwright test
replay({ action: 'export', name: 'checkout-test', format: 'playwright' })

// Run anytime to verify
replay({ action: 'run', name: 'checkout-test', connectionReason: 'test-run' })
```

### Debugging Workflows

```javascript
// Create a debug sequence from what you just did
replay({
  action: 'create',
  name: 'debug-auth-bug',
  description: 'Sets breakpoint on auth handler and triggers login',
  expectedOutcome: 'Debugger pauses at auth.js:42 showing user object',
  indices: [0, 1, 2, 3, 4, 5]
})

// Run to debug - debug state is shown automatically after the run
replay({ action: 'run', name: 'debug-auth-bug' })
```

### Verifying the Same Flow on Two Deployments

```javascript
replay({ action: 'run', name: 'checkout', baseUrl: 'http://localhost:3000' })
replay({ action: 'run', name: 'checkout', baseUrl: 'https://staging.example.com' })
```

### Cross-Device Handoff

Hand-author steps with per-step `connectionReason` and capture the handoff value
with `saveAs` - see [Per-Step Connections](#per-step-connections-multi-device-sequences).

### Automation

```javascript
replay({
  action: 'create',
  name: 'daily-smoke-test',
  description: 'Navigates key pages and checks for console errors',
  expectedOutcome: 'All pages load without errors',
  indices: [0, 1, 2, 3, 4, 5, 6, 7]
})

replay({ action: 'run', name: 'daily-smoke-test', killChromeOnFinish: true })
```

## Notes

- **Recording:** only tool calls are recorded, not responses.
- **Replay:** steps execute sequentially, and the run stops at the first failing
  step.
- **Persistence:** in-memory sequences are cleared on restart; use
  `export`/`load` for disk persistence. `run` and `get` load from disk by name
  automatically.
- **Connection stripping:** `connectionReason` is removed from commands as they
  are recorded into history, for portability.
- **Validation timing:** tool *names* are validated at `create`/`load` time;
  `run` does not re-validate, so a sequence edited on disk by hand is best
  round-tripped through `load` before running.
