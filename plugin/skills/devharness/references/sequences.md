# Replay Sequences

A sequence is an ordered list of tool calls you can re-run. It's how devharness
turns "I clicked around and hit the bug" into something repeatable - a
regression test, a repro attached to an issue, or a multi-step automation.

Everything below is the `replay` tool: `replay({ action: '...' })`.

## Folders

Sequences may live in subfolders of the sequences dir:

```
.cdp-tools/sequences/
  _helpers/      preamble guards, forEach bodies - loaded, never run on their own
  spine/
  story/
```

Filenames are relative to that root (`spine/spine-01.json`), and `load` still
accepts the bare basename, so moving a file into a folder does not break calls
that name it.

`replay({ action: 'runAll', folder: 'spine' })` loads the WHOLE tree, then runs
only that folder. Loading everything matters: `conditional`'s `then` and
`forEach`'s `do` resolve by sequence NAME, not by path, so a spine sequence can
call a helper in `_helpers/` only if that helper was loaded too.

**Tags are the other axis.** `replay({ action: 'declare', name: '...', tags:
['ui'] })` labels a sequence; `replay({ action: 'runAll', tags: ['ui'] })` runs
only those, and composes with `folder`. Several tags mean *any of*. Tags are
lowercased and de-duplicated (a tag is matched, not displayed) and may not
contain spaces.

Every `runAll` reports the split whether or not you filtered - `3 passed (1
contract, 1 ui, 1 untagged)`. That is the point: a suite reporting "36 passed"
reads as interface coverage even when a third of it never issues an `input`
step, and folders cannot carry the distinction because they already carry
scenario shape.

A folder whose name starts with `_` is skipped by a bare `runAll` - those
sequences fail in isolation by design (unbound `{{var:}}`, an unmet
precondition). Naming one explicitly runs it anyway.

Failures are recorded and the suite continues unless `continueOnFailure: false`.
A sequence that only PROMPTS (recorded variables, none supplied) or that PAUSES
is reported as a failure, not a pass - it did not run.

## Rules for building one

These hold however you build a sequence - by hand, as a subagent, or from a
slash command. They are here, once, rather than restated by each of those.

- **Never hand-write sequence JSON.** Sequences come from recorded tool calls.
  Hand-edited JSON skips the validation the tools apply and does not port.
  The things that cannot be recorded have their own actions rather than being
  an exception to this: `addConditional` for a guarded branch, `declare` for
  the browsers and sockets a sequence needs. This covers a value you just
  minted or looked up (a created link's URL, a row's id) too: `create` and
  `insert` compare each step's literal against every earlier included step's
  `saveAs` capture and rewrite an exact match to `{{var:name.path}}`
  automatically - `saveAs` a step whose result you'll reuse and the later
  literal gets templatized for you, no manual edit needed.
- **Do the work with the tools; don't describe it.** Every call you make is
  recorded, and the sequence is assembled from that history afterwards.
- **Pass `connectionReason` on every browser call** - including the connection
  that is already active, and including tools where it is optional (`inspect`,
  `execution`, `storage`, `network`, `breakpoint`, `request`). A call without it
  records nothing about which browser it ran in, so on replay it lands wherever
  the run-level connection points - silently, and the run still passes. This is
  the most common way to produce a sequence that tests nothing.
- **Check `list` first.** Auth and setup flows often already exist; a
  `conditional` step can reuse one instead of re-recording it.
- **Keep the path minimal.** Skip exploratory calls (source searches, unrelated
  navigation); include only what is needed to reproduce.
- **Write a specific `expectedOutcome`** - file:line, variable names, expected
  vs actual values. "It works" is not an expected outcome.

## Getting a sequence

**Record what a human does** - `recordInteraction`

```
replay({ action: 'recordInteraction', connectionReason: 'signup-flow' })
```

Opens the page with a recording overlay and captures real mouse, keyboard and
navigation events. **This call blocks until the person finishes in the
browser** - there is no separate stop action. It returns the created sequence.
Pass `issueId` to name and link the recording to an issue (`bug-7-repro`).

Because it waits on a human, don't call it unattended - the same rule as
`issues({ action: 'resolve' })`.

Tune how events become commands with `simplifyEvents` (default true),
`includeHovers` (false), `preferCoordinates` (false - `x,y` clicks for
canvas/3D) and `preferSelectors` (false - selector clicks even for canvas;
wins if both preference flags are set). Add `outputFormat: 'events'` or
`'commands'` to get the raw captured events / converted commands as JSON
alongside the summary, or `'review'` for a readable walkthrough of the captured
events (coordinates, element and selector per interaction, plus navigations,
pastes and comments). All three are only available here - raw events are not
stored with the sequence.

**Build one from calls you already made** - `create`

```
replay({ action: 'create', name: 'login-check', indices: [3, 4, 5] })
```

Every tool response footer shows its history index (`**Repeat:**` hint).
`replay({ action: 'history' })` lists them. This is usually faster than
recording when you've just done the steps yourself.

**Re-run calls you already made, without building a sequence** - `repeat`

```
replay({ action: 'repeat', indices: [12] })                // one call
replay({ action: 'repeat', indices: [58, 59, 60, 61] })    // a whole stretch, in order
```

`indices` takes a list, so this replays a run of work in one call - and that is
usually the point. Whenever you are about to redo something you already did
(relaunch the browser, log in again, retype a form, get back to the screen
where the bug shows), repeat those indices instead of re-issuing the calls by
hand: it is faster, and retyped arguments drift from what actually ran.

Every tool response carries its own index in the footer, so the numbers are
already in front of you. `replay({ action: 'history' })` lists them when they
have scrolled away. If the stretch turns out to be worth keeping, hand the same
indices to `create`.

## Managing them

- `list` - every sequence: the ones in memory, then the ones on disk. A fresh
  session holds none in memory, so this is what shows an existing suite.
- `get` / `delete` - sequences in memory. `get` takes
  `outputFormat: 'commands' | 'playwright' | 'puppeteer'` to return the raw
  command JSON or generated test code instead of the detail view (`'events'`
  and `'review'` are recordInteraction-only - a stored sequence has no raw
  events, and `get` says so rather than ignoring them)
- `load` / `listSaved` / `deleteSaved` - sequences on disk alone
- `export` - write to a file as `sequence`, `playwright`, or `puppeteer`
- `global: true` on `export` saves to `~/.cdp-tools/sequences/` instead of the
  working directory

`load` and `create` reject a sequence naming a tool that doesn't exist, listing
the offending step, rather than failing halfway through a run after earlier
steps already changed state.

**Editing a sequence file mid-session just works.** The sequences directories
are watched like a managed dev server's sources, and a run re-checks the file's
timestamp anyway - so the version you just saved is the version that runs. No
`load` needed to pick up an edit. A file caught mid-write leaves the loaded copy
in place rather than replacing a good sequence with a half-saved one, and a
sequence built from history has no file to reload from.

## Running

```
replay({ action: 'run', sequenceId: 'seq-login', connectionReason: 'my-app' })
```

**`run` does not block** (changed in 0.7): it returns a run id immediately and
executes in the background.

```
replay({ action: 'status', runId: 'run-3-...' })   // progress; full result once settled
replay({ action: 'cancel', runId: 'run-3-...' })   // stop it
```

`cancel` reaches the step that is in flight (including inside nested
`conditional` sequences), but what it can do there differs by tool - three
levels, and the difference matters:

- **Genuinely cancelled:** `wait` (all forms, mid-poll) and `request` with
  `destination: 'node'` (the socket is closed - the server sees it aborted).
- **Stops waiting, work continues:** `navigate` (deliberately no
  `Page.stopLoading` - a half-loaded page is worse than a loaded one),
  `inspect({ action: 'evaluateExpression' })`, `content({ action: 'parse' })`.
- **Checkpoint only:** `input` - an input event on the wire cannot be
  recalled, so cancelling stops events that had not gone out yet and undoes
  nothing already dispatched (a cancelled drag does still release the button).
  Same for `request` with `destination: 'browser'`, `screenshot`, and the
  non-waiting `content`/`inspect` actions.

`breakpoint({ action: 'await' })` is cancellable and now **fails** the step
(it used to report success). `dom`, `network` and everything else have no real
wait to interrupt, so they stop at the next step boundary. In every case, work
already dispatched to the browser may still take effect. Full table:
`docs/replay.md`.

Several runs can execute concurrently - even of the same sequence - and the
run id is what tells them apart. Settled runs and their results are kept in
memory for 30 minutes (max 50); after that, or after a server restart (which
kills in-flight runs), the id returns `REPLAY_RUN_NOT_FOUND`. Nested sequences
(`conditional` flows, `replay run` steps) are part of their parent run, never
separate runs. Pass `wait: true` to block until completion and get the full
result in one call (the pre-0.7 behaviour).

Useful `run` parameters:

- `startUrl` - override the stored start URL for this run only (e.g. a
  freshly minted magic link)
- `baseUrl` - retarget every absolute URL at another origin, keeping paths and
  queries. Point a staging-recorded sequence at local
- `startFrom` - begin at step N (1-indexed)
- `stepTimeout` / `totalTimeout` - each step is bounded by
  `min(stepTimeout, remaining totalTimeout)` (defaults 30s / 5min); a step that
  exceeds it fails the run at that step. `wait` steps are exempt from
  `stepTimeout` (they have their own `timeoutMs`) but still capped by
  `totalTimeout`
- `variables` - substitute recorded typed text (see below)
- `killChromeOnFinish` - tears down the browsers this run OWNS: its own
  run-level connection, plus any browser a `launchChrome` step actually
  created. A step that reached an already-bound reference only borrowed that
  browser, so it is left running and a sequence can read from a long-lived
  instance you launched yourself without it being killed underneath you.
  Skipped for any browser whose port another live connection shares (a
  `launchChrome` step usually opens a tab in the same instance) - the run says
  which connection kept it alive

Step through interactively with `step`, `finish`, `insert`, `status`, `cancel`
(`run` with `stepTo: N` pauses after step N; the run's status becomes `paused`
and you drive it from there). A bare `cancel` prefers the paused session;
use `runId` to address a specific background run.

## Two different "variables" - don't confuse them

**1. `variables` on `run` replaces recorded typed text.** Keyed
`var_<0-based step index>_<selector, non-alphanumerics replaced by _>`, so a
step 2 typing into `#email` is `var_2__email` - two underscores, one from the
separator and one from the `#`. Read the keys off `replay({ action: 'get' })`
or off the prompt a `run` returns when typed text is present and `variables`
is omitted; a key that names no typed-text step is rejected before anything
runs, with the substitutable keys listed. Substitutions reach nested sequences
(a `conditional`'s `then`, a `forEach`'s `do`) at every depth, so a key naming
a step in a shared login helper lands there. `runAll` holds one map for the
whole suite and accepts a key that matches any member. The recorded literal
stays in the sequence file either way.

**For a credential, use `{{env:NAME}}` in the step instead.** Any step param
may hold it; it resolves from `process.env` when the step runs, so the file
holds the token and neither the file nor the tool call carries the secret. An
unset or empty variable fails the step, naming the variable - an empty value
would be typed as-is. A token-bearing step does not prompt for `variables`,
and an explicitly supplied value still wins over the environment.

```
{ tool: 'input', params: { action: 'type', selector: '#password',
                           text: '{{env:APP_PASSWORD}}' } }
```

`envFile` names a KEY=value file for the run - `replay({ action: 'run', name:
'login', envFile: 'sequences.env' })`. A relative path resolves against the
project directory (the one holding `.devharness`); its values win over the
server's own environment, a name it omits falls through to `process.env`, and
`process.env` is never written, so concurrent runs may name different files and
changing the file needs no client restart. A missing file or a line that is not
blank, a `#` comment, or `NAME=value` fails before any step runs. No `$VAR`
expansion inside values. `runAll` takes it too.

```
replay({ action: 'run', sequenceId: 'seq-signup',
         variables: { 'var_2__email': 'new@example.com' } })
```

**2. `saveAs` captures a value mid-run for later steps.** Supported on
`request` and on `inspect({ action: 'evaluateExpression' })`. Later steps read
it with `{{var:name}}` or `{{var:name.path}}`:

```
request({ url: '...', saveAs: 'login' })          // stores the whole response
inspect({ action: 'evaluateExpression',
          expression: 'document.querySelector("#pair").href',
          saveAs: 'pairingUrl' })                  // stores the value itself
navigate({ action: 'goto', url: '{{var:pairingUrl}}' })
assert({ left: '{{var:login.body.token}}', operator: 'exists' })
```

Note the asymmetry: `request` stores the response object (so you index into
`.body`), `inspect` stores the evaluated value directly. A `saveAs` that can't
be honoured fails the step rather than silently capturing nothing.

Values that only render as a description (`[HTMLDivElement]`, `Array(3)`) come
back as strings - capture a specific field rather than a whole DOM object.

## Waiting for async work

Recording by hand hides races: driving tools interactively puts seconds
between calls, so async work always looks settled. Replayed back-to-back, a
step after a navigation or an async kick-off reads state that isn't there
yet. `wait` is the sequence step for that:

```
{ tool: 'wait', params: { selector: 'button:has-text("Join")' } }   // appears
{ tool: 'wait', params: { selectorGone: '.spinner' } }              // disappears
{ tool: 'wait', params: { expression: 'window.__probe !== "PENDING"' } }
{ tool: 'wait', params: { ms: 500 } }                               // last resort
```

Exactly one form per step. Condition forms poll a **synchronous** check from
the MCP side (default: every 100ms, up to `timeoutMs` 15000), so they survive
a navigation mid-wait and don't depend on in-page timers or promises. On
timeout the step fails and stops the run - a `wait` never hangs. For async
in-page work, kick it off in one step, store the result in a global, then
`wait({ expression: 'window.__result !== undefined' })` and read it with
`inspect` + `saveAs`.

Historical note: sequences in the wild use a marker-div + hover-on-
`:has-text()` idiom (an `input({ action: 'hover' })` on an element that only
exists once async work settles). That was never stylistic - hover's short
implicit element-wait was the *only* step that waited at all before `wait`
existed. Don't copy the pattern into new sequences; use `wait` and `assert`.

## Multi-device / multi-browser sequences

Any step may carry its own `connectionReason`, and it is honoured for
validation and pause handling, not just dispatch. That's what makes
"device A scans, device B confirms" sequences work in one run:

```
{ tool: 'input',   params: { action: 'click', selector: '#pair',
                             connectionReason: 'device-a' } }
{ tool: 'inspect', params: { action: 'evaluateExpression',
                             expression: '...', saveAs: 'code',
                             connectionReason: 'device-a' } }
{ tool: 'navigate', params: { action: 'goto', url: '{{var:code}}',
                              connectionReason: 'device-b' } }
```

Steps without an explicit `connectionReason` use the run-level one.

**Recording one.** Pass `connectionReason` explicitly on **every** call while you
drive the browsers - including the one that happens to be active. Recording
preserves it, and `create` decides what to do with it:

- all steps on one connection - hoisted off the steps, so the sequence stays
  portable and `run({ connectionReason })` still retargets it
- genuinely spanning connections - kept per step
- **mixed** (some steps named, some driven implicitly through the active
  connection) - kept as-is with a warning, because nothing can tell which
  browser the bare steps belonged to. `create` says so; re-record naming every
  step rather than shipping it

"Bare" covers the tools whose `connectionReason` is *optional* (`inspect`,
`execution`, `storage`, `network`, `breakpoint`, `request`), not just the
browser-only ones - those are the ones actually left off. A sequence can be both
multi-connection and mixed, and that is the worst case: the bare steps land in a
different browser depending on the run-level `connectionReason`, green either
way. `create` warns about both.

**Inserting into one.** `insert` re-stamps the connection `create` hoisted off
(kept on the sequence as `recordedConnection`) before merging, so a same-browser
insert re-hoists and stays portable, while a cross-browser insert makes every
step explicit and becomes a real multi-connection sequence.

**Declaring the browsers it needs.** A sequence can bring up its own browsers
instead of expecting the caller to have launched them. Set it with `declare`:

```js
replay({ action: 'declare', name: 'duo-stock-propagation',
         requiredConnections: [
           { reference: 'duo-member-two', role: 'the member who draws stock',
             url: 'http://localhost:5173/login' }
         ] })
```

Each list replaces its field and `[]` clears it; passing one leaves the other
untouched. The sequence is written back to its file (a memory-only one waits
for `export`), and a declaration that cannot mean what it says is refused here
rather than on the next run. It lands on the sequence next to `commands`:

```json
"requiredConnections": [
  { "reference": "duo-member-two", "role": "the member who draws stock",
    "url": "http://localhost:5173/login" }
]
```

`url` defaults to the sequence's `startUrl`; `forceNewInstance` defaults to
**true** (a separate process, not a tab - two identities in one browser share
its storage); `role` shows up in the run summary. A reference already bound to
a live browser is reused, and a `connections` mapping wins over the
declaration. A browser that will not launch fails the run before step 1.

**`profile` makes the device durable.** Add the persistent profile the browser
should come up on - the same ones `launchChrome({ profile })` creates:

```json
{ "reference": "device-a", "profile": "device-a", "role": "the enrolled device" }
```

Storage (cookies, localStorage, IndexedDB, non-extractable CryptoKeys) survives
between runs, so a device enrolled once stays enrolled; the reference is just
this session's name for it. Steps still address browsers by `connectionReason` -
there is no per-step `profile`.

Two rules follow. `forceNewInstance` defaults to **false** when a profile is
named, because only one live Chrome may hold a profile and the one already
running it is the browser you asked for. And a profile-bearing reference may
**not** be rebound through `connections`, nor may two declarations share one
profile: a profile is an identity claim, not a default, and pointing it
elsewhere would run device-a's steps in a browser that is not device-a and pass.
Teardown kills the browser but never the profile directory.

The run closes what it launched on every terminal outcome - completed, failed,
cancelled - and reports *"Browsers closed (declared and launched): ..."*. A
pause keeps them (that is the state you stopped to inspect); whatever ends the
pause (`cancel`, `finish`, stepping off the end) closes them then. Browsers
that were already up, or that share a port with another live connection, are
left alone.

**Declaring the sockets it depends on.** `requiredSockets` is the same idea for
transports: URL substrings of the WebSockets the assertions ride on, set by the
same action (`replay({ action: 'declare', name: '...', requiredSockets:
['/api/sync/socket'] })`). A sequence that declares them is
checked without the caller asking - `requireSockets: true` is only for a
sequence that declares none. Per entry the run fails when a matching socket
closed or hit frame errors mid-run, or when none is open at the end (including
one that never opened - invisible to any final "is it up" assertion). Closes
the run did not cause are not blamed on it: a socket torn down with its target
by a navigation, or hung up by the page, is normal. Match the app's own path,
not the origin, so the declaration survives `baseUrl`; dev-server sockets (Vite
HMR) go undeclared and are ignored.

**Replaying one in a different session.** Recorded references are per-session,
so rebind them:

```
replay({ action: 'run', sequenceId: 'duo',
         connections: { 'duo-member-two': 'my-second-browser' } })
```

Recorded name on the left, a reference from this session on the right. A key
that matches nothing in the sequence is rejected up front, listing the real
ones, rather than being ignored - "the sequence" includes the sequences its
`conditional` steps pull in, so a setup sequence behind a conditional is
rebindable too. Mapping two recorded references onto one browser is rejected as
well - that would collapse the sequence into a single browser and pass.
`issues({ action: 'workOn' | 'resolve' })` takes `connections` too.

Any step naming a connection other than the run's is checked against the live
session first, so a missing browser fails as *"step 3 needs connection
duo-member-two, which does not exist in this session"* rather than as a generic
"not connected to browser" from somewhere inside the tool.

**A run-level `connectionReason` does not reach a step that names its own
connection.** Such a step resolves through `connections` alone. A sequence
whose steps all name one reference (a hand-built one, or one never hoisted by
`create`) run with a different `connectionReason` would drive the recorded
reference, and a stale window under that name in this session turns every step
into "element not found". The run is refused before step 1 with the mapping
that retargets it: `connections: { "<recorded>": "<connectionReason>" }`.

**repeat / runFromLog.** Each command replays against the connection it was
recorded with. An explicit `connectionReason` retargets a single-connection
batch and is refused for a multi-connection one.

**Exported code.** `outputFormat: 'playwright' | 'puppeteer'` gives each recorded
connection its own page rather than merging them into one. Only `navigate` and
`input` steps have equivalents; everything else (`conditional`, `launchChrome`,
`inspect`, `storage`, `wait`) becomes a `// [not generated]` comment, and a
sequence where nothing could be generated exports a test that **throws** instead
of an empty one that passes. Setup sequences are for `run`, not for export.

Two things that deliberately do not happen: a run-level `connectionReason` does
**not** override a step's own, and a per-step reference that doesn't exist in
this session **fails the step** - it never falls back to the run-level
connection. Falling back is what made a two-browser sequence silently replay in
one browser and report success.

## Conditional steps

`conditional` is a virtual step tool - it runs another sequence inline when a
condition holds. It's handled inside the executor and never appears in the tool
list, which is why it's exempt from tool-name validation.

Not being a tool, it is never recorded, so `create`/`insert` cannot produce
one. `addConditional` is its authoring route:

```javascript
replay({ action: 'addConditional',
         name: 'checkout-flow',          // or sequenceId
         condition: '{{selector:.login-button}}',
         thenSequence: 'perform-login',  // name of another sequence
         insertAfterStep: 0 })           // omit to append
```

which stores `{ tool: 'conditional', params: { if, then } }`. Use it for state
that varies between runs - "log in first, but only if logged out".

Condition syntax and the branch target are checked before the sequence is
touched. A sequence already saved on disk is rewritten in place; otherwise it
waits for `export`. The response says which.

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

A database or store that doesn't exist yet counts as **absent**, not as an
evaluation error - that's the state a wiped profile is in, and the state a
healing setup sequence exists to fix.
| `{{indexedDB:DB/STORE/KEY}}` / `{{!indexedDB:...}}` | that record exists / doesn't |
| `{{indexedDB:DB/STORE}}` | the object store holds at least one record |

A database or store that doesn't exist yet is **absent**, not an error - that's
the state a wiped profile is in. A value JSON can't represent (a
non-extractable `CryptoKey`, a `Blob`) still counts as present, so a device
identity is probeable directly instead of through some UI proxy. An all-digits
key is tried as a string and then as a number, since IndexedDB keys `42` and
`"42"` differ.

Conditions are interpolated like any other parameter, so a captured variable can
drive one: `{{indexedDB:identity/keys/{{var:deviceId}}}}`.

**Not met and cannot-evaluate are different outcomes.** A condition that is
legitimately false skips the nested sequence and the step counts as a
**success**. A condition that can't be evaluated at all - bad format, unknown
type, invalid or over-long regex, tool error - **fails the run**. Don't write a
conditional expecting a malformed condition to fall through quietly.

The nested sequence shares the parent run's captured variables (`saveAs` values
flow both ways) and inherits its remaining timeout budget. A `launchChrome` step
inside it is skipped when that reference is already connected and run when it
isn't, so a setup sequence spanning two browsers can create the second one
itself.

**Which browser its bare steps run in** follows from that: if the nested launch
actually ran, they run in the browser it created (a setup sequence is a launch
plus bare steps, since `create` hoists the connection off them - leaving them on
the caller would open a browser and then do the work in the wrong one); if the
launch was skipped or absent, they run in the calling run's connection, so a
nested login sequence still works wherever it's called from. Steps naming their
own `connectionReason` are unaffected.

**Two connections are not two devices.** A plain `launchChrome` opens a tab in
the running instance, so both references share one profile - one cookie jar, one
localStorage, one IndexedDB. A duo test built that way has ONE device identity
under two names, and a cross-user propagation check passes without a second
device existing. When the two sides must be genuinely separate, launch the
second with its own profile:
`launchChrome({ reference: 'duo-member-two', profile: 'member', forceNewInstance: true })`.
Same `port` in `listConnections` means same instance, so shared storage.

Nesting depth is capped by `replay.maxConditionalDepth` (default 10) and regexes
by `replay.maxRegexLength` (default 500), both in `.cdp-tools/config.json`.
Oscillating chains (A->B->A) are allowed up to the depth cap. Full detail:
`docs/replay.md`.

## `forEach` steps

A condition asks whether ONE named thing exists, so `conditional` can express
"add it if it's missing" but never "remove everything that shouldn't be here".
`forEach` is the other half: enumerate a source, run a sequence per item.

```javascript
{ tool: 'forEach', params: {
    in: '{{var:shares}}',                 // an array a previous saveAs captured
    as: 'share',                          // bound per iteration
    do: 'revoke-one-share',               // sequence name, run once per item
    where: 'item.name !== "Employees"',   // optional filter
    maxItems: 50 } }                      // optional cap (default 100)
```

**`in` takes two forms.** `{{var:name}}` reads an array a previous `saveAs`
captured - which is how anything non-DOM is enumerated, since
`inspect({ action: 'evaluateExpression', saveAs: 'shares' })` can return exactly
the list you want and is a recordable step. `{{selectorAll:CSS}}` enumerates the
DOM, yielding `{ index, text, id, className, href, value }` per element -
elements themselves cannot cross the CDP boundary, so `index` is what the body
uses to address one again.

**`as` binds the item**, readable in the body as `{{var:share.id}}` like any
captured variable, with its position in `{{var:shareIndex}}`. The binding is
replaced per iteration, not scoped - the variable store is shared by reference
across nested runs, so a body's own `saveAs` captures also survive into the next
iteration.

**`where` is JavaScript, not the `{{...}}` condition grammar**, evaluated in the
page with `item` and `index` in scope. Conditions probe the browser for one named
thing; a filter has to read fields off an arbitrary object, which that grammar
cannot express. A `where` that cannot be evaluated **fails the run** - the same
rule a malformed condition follows, because silently excluding every item makes a
typo look like an empty result set.

An empty source is a **success**, and the run output says how many items were
found - a converge loop with nothing left to clean up would otherwise be
indistinguishable from a broken selector. A body failure stops the run and names
which item it was on. Depth shares `maxConditionalDepth` with `conditional`.

## `teardown` - steps that always run

A sequence can carry a `teardown` array beside its `commands`:

```json
{ "name": "mint-and-check",
  "commands": [ ... ],
  "teardown": [
    { "tool": "request",
      "params": { "url": "/api/share/revoke/{{var:mint.body.id}}", "method": "POST" } }
  ] }
```

They run once the main steps reach a terminal state - success, a failed step, an
abort, or the total timeout - which is what makes cleanup survive the cases that
need it. Three properties, each deliberate:

- **Their own timeout budget** (`teardownTimeout`, default 60s), not drawn from
  the run's `totalTimeout`. The commonest reason a run needs cleaning up after is
  that it timed out; sharing the budget would skip teardown exactly then.
- **The run's abort signal is NOT passed down**, so `replay cancel` stops the
  work and not the cleanup. A cancelled run is precisely one that left something
  behind.
- **The variable store is shared**, so teardown can revoke what setup minted even
  though the capturing step ran long before the failure.

They do **not** run when a run *pauses* - `stepTo`, a breakpoint, a click
validation failure. A paused run is not over, and its state is what you stopped
to look at.

A failing teardown step never changes the run's verdict; it is reported in its
own section. Otherwise a broken cleanup would mask the failure it was cleaning up
after.

**Teardown is always best-effort.** A killed devharness process takes any pending
teardown with it, so it reduces accumulation and cannot guarantee a clean world.
An assertion that depends on nothing being left over ("No assets yet") stays
order-dependent whether or not teardown exists - mint your own fixture and assert
on that instead, and teardown becomes hygiene rather than correctness.

## When a sequence is flaky

Name the symptom rather than adding sleeps - each of these has a real mechanism
behind it, documented in `docs/replay.md`:

| Symptom | What to reach for |
|---|---|
| Clicks land before the element exists | Click/type/hover already retry; add an explicit `wait({ selector })` step for work the previous step kicked off |
| Consent banners or dialogs block interaction | `handleModals: true` on the input action, with a `dismissStrategy` |
| Stale content while requests are in flight | `wait({ expression })` on a flag the app sets, not a fixed sleep |
| localhost URL fails because nothing is running | The port check fails fast - start the server (`server({ action: 'start' })`) |
| A run hangs or takes far too long | `stepTimeout` / `totalTimeout`; a step exceeding its budget fails the run at that step |
| A step ran against the wrong browser | See the multi-device section - almost always a bare `connectionReason` |

## Verifying a fix

`issues({ action: 'workOn', id: N })` replays an issue's linked sequence so you
can see the bug reproduce, fix it, then replay again. Closing the issue is
`resolve`, which is human-gated - an agent should record findings with
`comment` and leave the closing to a person.
