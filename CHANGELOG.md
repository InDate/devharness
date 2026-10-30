# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A scroll stays one row when the page stalls part-way through it.** A
  motion run closed after 120ms without a change, so a main thread busy for
  313ms in the middle of a smooth scroll split it into two rows, and the
  step mismatched its baseline. A scroll, and what the page's scroll handlers
  write, now waits for the `scrollend` Chrome fires once the scroll has
  nothing left to move, and closes 120ms after it unless the next tick of a
  wheel carries it on; a scroll that raises none closes after 1s still.
- **A baseline waits for its steps to settle before it replies.** Its reply
  came back while the last step's motion still ran, so a play started
  straight after navigated away from it and the baseline kept that step
  mid-motion, its later rows missing. It now waits for its steps' causes to
  settle, up to the 10s a run's reply waits, and takes its traffic again.
- **A slowed motion's row ends where the motion did, with its frames.** The
  page's motion watch stamped each run in page time, which devharness placed
  on wall time, so at a rate of 0.25 a run's end landed early by its wall
  length less its page length, and Chrome's frames, 4ms of page time apart,
  merged into one frame each. A run is now stamped and its frames spaced on
  wall time, and its row still shows its length in page time.
- **A slower `hold rate` slows frame-stepped motion and smooth scrolls.** The
  page clock slowed page time, while Chrome still handed the app a frame
  callback on every frame, so a canvas that moves a fixed step per frame ran
  at full speed; and Chrome runs a smooth scroll on its compositor, out of
  reach of page time and the CSS rate. Below a rate of 1 the app's frame
  callbacks now run on that share of Chrome's frames, and the page clock runs
  the page's smooth `scrollTo`, `scrollBy` and `scrollIntoView` on page time,
  over Chrome's own duration for the distance, with one `scrollend` at its
  end; an instant scroll or a wheel ends it. The trigger tracker credits its
  scroll events to the call for as long as it runs.
- **A rate set with `hold rate` holds across a navigation.** A new document
  starts its CSS animations and its page clock at 1×, while devharness kept
  the rate it was given, so after a navigation the page ran at real time and
  the bench's speed control still read the slower rate. Each new document now
  takes the rate again as its execution context is created, on a debugger
  connection and on a bench with none.
- **`replay create` keeps the `{{var:...}}` a run's step was written with.**
  History held a run's steps with their tokens resolved, and `create` matched
  the values back to earlier captures, which leaves common numbers such as 0
  as literals; a saved check then compared against the value one run read.
  A run's step now carries its params as written beside its history entry,
  and `create` puts back each param that held a token.

## [0.17.5] - 2026-10-29

### Fixed

- **A monitored port bound to `127.0.0.1` reads as up on Node 18.** The port
  probe connected to `localhost`, which Node 18 resolves to `::1` first; a
  server listening on IPv4 alone refused it, the port read as down, and a
  `block` monitor held calls on a server that was up. The probe now tries
  both address families, as Node 20 does by default.

## [0.17.4] - 2026-10-29

### Fixed

- **`insert` puts the steps into the sequence its `name` or `sequenceId`
  names.** A sequence left paused by an earlier run took every insert, and
  the steps landed in a new `<paused>-modified` copy while the named sequence
  kept its old steps. The paused sequence now takes the steps only when the
  name or id given is its own; any other target is read from memory or disk,
  changed and written back. A named insert with no `insertAfterStep` appends.

## [0.17.3] - 2026-10-29

### Fixed

- **A held call and the launch event that finishes it carry the time it was
  called.** Every launch event read "bench start finished: Bench open on
  <connection>" whichever call it finished, so one left unread from an
  earlier held call read as the finish of the current one. The held reply,
  the refusal of a call on a held connection, and the launch event now carry
  `calledAt`, and the event names its `connection`.

## [0.17.2] - 2026-10-29

### Added

- **A paused run names the step that runs next.** Every reply that leaves a
  run paused - `stepTo`, a breakpoint, a pause point, a person's input, a
  stopped step, a refused click, and `run status` - reads "step N of total
  runs next", and carries `replay.nextStep` and `totalSteps` in `_meta`. It
  read "at step 5 of 38", which left open whether step 5 had run.
- **Launch, bench start and run replies say whether the browser is headless
  or windowed**, and `_meta.launch.headless` carries it.

### Fixed

- **A launch no longer lands in a Chrome of the other visibility.** A launch
  with no port opened a tab in the Chrome on the session's port whatever its
  visibility, so a windowed bench start after a headless launch came up in a
  browser nobody could see, and reported open. It now takes a free port; one
  naming that port is refused with CHROME_PORT_VISIBILITY_MISMATCH.
- **The bench scrolls to the step a run stops on, and to a capture draft.**
  In a list of hundreds of steps they could sit far down the column.
- **A held view transition is named in the capture dialog, with a skip.**
  While one is active Chrome hit-tests the whole document as its root, and a
  hold keeps it active, so every pick took the whole page. The dialog names
  it and skips it to its end on a press.
- **A capture shows at its own size.** A small element was scaled up to the
  column's width, stretched and blurred; it is now drawn at its own pixels,
  centred, and shrunk only to fit.
- **An empty pause is one line.** A pause nothing crossed in opened to a fold
  reading "no events"; it now reads "paused · step N runs next".
- **A hover the page scrolls from under a still pointer is credited to the
  scroll that moved it.** The browser fires a scroll event a frame after the
  page moves, so a step's wheel could unhover an element before its own scroll
  event arrived, and the hover-left went to the step before, whose scroll
  event was the newest. The hover now takes the cause of the scroll moving the
  page at that moment.

## [0.17.1] - 2026-10-29

### Added

- **`keepDeclared` on `run sequence`.** The browsers a sequence declares stay
  open once the run ends, bench plays included, and the reply lists them under
  "Browsers left open". Without it the run closes them, as before.
- **`storage` `clear` takes `origins`.** Cookies (HttpOnly included),
  localStorage and IndexedDB are cleared per origin by the browser through
  `Storage.clearDataForOrigin`, so a database the app holds open is deleted
  too; the page script used before reached only the page's own origin and
  gave up after 3s on an open database. sessionStorage lives per tab and
  clears on the page's origin only. A first step of this kind returns a
  reused browser to a fresh visitor.

### Fixed

- **A bench play launches the browser a sequence declares.** A one-browser
  sequence was rebound onto the bench tab even where it declared that browser,
  so the declaration never launched and the steps drove the tab with whatever
  cookies it held. A declared browser is now left out of the rebind.
- **The startUrl opens in the browser step 1 runs in.** It went to the run's
  own connection, a browser the first steps may never touch. A declared
  browser the run launches opens at its own `url` and is not navigated again.
- **`navigate` survives a page that navigates itself once loaded.** A gate
  redirecting a signed-in browser replaced the document while the page was
  read, failing the call with "Execution context was destroyed". The read is
  taken again once the new document's load event fires.
- **`input` `press` lands on its selector.** The key went to whatever held
  focus, so a click between steps sent an Enter past the form it was recorded
  on. A press focuses its selector's element when focus sits outside it, and
  fails with ELEMENT_NOT_FOUND where the selector matches nothing.
- **A baseline and a bench Replay count step 1.** Step 1 ran before the play
  took its history index and start times, so the run's reply read "N of N ·
  N−1 passed" with step 1 missing from the table, the run log's tallies left
  it out, and the baseline stamped its click fingerprint with the play's end.
  The play now runs step 1 itself, after taking them.
- **A baseline's reply carries its play's outcome.** It read "All N steps
  played" whatever the play did; it now reads the run line, as "N of N · N
  passed". Its play reports no match against the baseline it replaces.

## [0.17.0] - 2026-10-29

### Removed

- **The devharness Agent Skill.** It reached few sessions, and those mostly on
  a stale copy, while each fact in it a session needs now arrives with the
  call it bears on: in the tool's description, the reply of the action's first
  use in a session, or the error a call meets. Its reference for people moved
  to `docs/bench.md`, `docs/boundary.md` and `docs/sequences.md`, and its other
  sections into `docs/instructions.md`. The server no longer asks a session to
  install the skill or warns of a stale copy.

### Added

- **The saved sequences list prints in full once a session.** The first
  `replay` `list` or `listSaved` of a session draws every saved sequence; each
  later one draws only those added (+), gone (−) or changed (~) since the last,
  or a one-line note when none did. `full: true` draws the whole list again.
  A rebuild starts the record afresh.
- **A driving call holds the page itself.** `input` with `hold: ['ui']` (or
  `code`, `network`) on press, click, scroll, drag, tap or swipe takes the hold
  right after its last event is dispatched, inside any settle or quiet window
  the page runs after the gesture, where a separate `hold` call lands only
  after the motion has finished. `holdAfterMs` lets the page run that long
  first, so a settle is frozen part-way; `_meta.hold` carries the reading. A
  swipe with `holdBeforeEnd: true` holds with the contact still down, and
  `input({ action: 'swipe', finish: true })` lifts it after the release.
- **Frames of a motion, tiled.** `input` with `burst: { forMs, frames, clip }`
  records the frames the compositor swaps from the dispatch on, through
  `Page.startScreencast`, each stamped with its swap time, and saves them with
  a contact sheet (`+<ms>` under each tile) under
  `.devharness/screenshots/<date>/burst-<ts>/`; `_meta.burst` lists them. With
  `hold`, the capture ends at the hold. `screenshot({ action: 'burst' })`
  records the same with nothing dispatched.
- **A held settle is stepped through.** `hold({ action: 'seek', ms })` moves
  every CSS transition, CSS animation and web animation the bench has seen
  start on by `ms` of its own time, the page's JS untouched, and the frame is
  painted under the hold, so a settle is read and captured at 0, 25, 50, 75
  and 100 percent. `hold({ action: 'rate', playbackRate })` sets what the
  animations run at while released, and a release restores it.
- **One animation at a time.** `hold({ action: 'motion' })` sets rules on
  single animations as they start, matched by name and element: `slow`,
  `off` (jump to its end), `alone` (pause every other), `freezeAt` (hold it
  part-way while the rest run) and `duration`/`delay`. They stand across
  replays until cleared.
- **Animations as rows.** The bench's motion toggle, beside the proxy,
  records each animation the page starts as a MOTION row under the step that
  caused it, beside its traffic, counted in run tallies and compared with the
  last run; `bench({ action: 'motion', on })` sets it, and it holds across
  restarts. A MOTION row sets how that animation plays on the next run -
  speed, off, a freeze for the whole page or that animation alone - stored on
  the step under `motion` and applied when the step runs; a play stops on a
  freeze, and the hold strip's Motion line drags the frozen animation.
- **Recordings stay in memory until saved.** NEW starts recording at once;
  stopping keeps the steps as an unsaved sequence, which a play, record-more,
  save (name, purpose and outcome asked there) or throw-away acts on. A
  recording pauses and resumes from its bar, plays its steps so far without
  stopping, and takes a check after its latest step. A step comes out on one
  click, and undo puts back the last removal or change.
- **The bench's speed and seek.** The hold strip's Motion row sets the
  animations' speed and, while the screen is held, seeks them with each one's
  progress shown; a slowed page is marked on the disc. A burst a step films
  opens on the bench as a sheet of its frames.
- **Pick and capture with no sequence open.** The picker and capture buttons
  work before a sequence is chosen; a pick or capture waits in a loose card
  for the next note, and a pick is announced on the event stream.
- **A held page answers reads and captures.** A screen hold on an idle page
  now stops inside devharness's own script instead of arming a pause the next
  read walks into and hangs on, and `screenshot` viewport and fullPage run
  while a page is paused.
- **The page reads time from a clock devharness holds.** A script put in
  before the app's first line answers `setTimeout`, `setInterval`, `Date`,
  `performance.now`, `Event.timeStamp` and `AbortSignal.timeout`, and hands
  frame callbacks its time; it runs at wall time until the screen is held, and
  stops with the hold. A timer set before a hold fires as though the hold took
  no time, and a sequence replayed faster than it was recorded sees its timers
  fire at the same page moments. Workers keep wall time.
- **A press held at the frame it schedules.** `input` with `hold: ['ui']` and
  `holdBeforeFrame: true` stands the page at the first frame the input
  schedules: the page clock queues the app's frame callbacks from before the
  dispatch, so a flash painted on that frame, and the animations the input
  starts, are read at 0ms.
- **One frame at a time.** `hold({ action: 'frame', ms? })` moves a held
  screen one frame on: page time, the timers due in it, the queued frame
  callbacks once, and the CSS animations by the same span.
- **The animations an input started.** `hold({ action: 'group' })` lists the
  animations created since a frame stop, with element, property, delay,
  duration, easing and position.

### Changed

- **A hold records who took it, and ends by its owner.** Each held layer
  carries its owners: a person in the bench, an agent's call, a run's step or
  pause, a motion rule, the bench's own capture, or a breakpoint. A layer runs
  again when its last owner is released, so one surface's release leaves
  another's hold standing. An agent's `hold release`, `bench release` and
  `execution resume` end every hold of an agent, a run, a rule or a
  breakpoint; a person's hand hold ends in the bench, and an agent's call on
  it is refused with `HELD_BY_PERSON` and leaves the page stopped. A run ends
  the holds its steps took as it finishes or is cancelled, and releases an
  agent's or a rule's hold before a step that drives the page.
- **A replay puts nothing into the page.** The replay cursor marks each click
  with Chrome's overlay, drawn above the document, in place of a pointer and
  a key badge added to the app's DOM, which the page's own readers took as
  the app's: an animation row, a capture, an element. A key pressed is named
  by the bench's step list.
- **A person's input is recorded only on request.** `replay.watchPersonInput`
  defaults to `false`, so a launched browser no longer puts its clicks and
  typing into History or onto the next reply. `true` in config turns the watch
  on everywhere; `connection({ action: 'launch', watchInput: true })`, or
  RECORD MY INPUT on the bench, turns it on for one connection. A run pauses on
  a person's input only while it is on.
- **The bench pauses the page through its debugger connection.** The bench
  and the network monitor no longer run debugger agents of their own beside
  the page's debugger connection, whose records of whether the page stood
  stopped disagreed in the moments between a command and its event.
- **Stepping the screen reaches the page clock.** `hold step` on the ui layer
  runs the clock's next timer or held frame, page time moved on to it, before
  the page's own next callback. `hold rate` sets the page clock's rate with the
  CSS animations'.
- **Motion is no longer on the hold strip; the page's speed is.** The seek
  chips and the line per animation are gone from the bench's hold strip, and a
  Time row takes the speed chips' place: slow down, speed up and back to real
  time for the page's JS timing and CSS animations together, and where page
  time stands. A speed off real time frames the bench in the wait colour.
- **Motion rules act from an animation's first frame, on one animation of
  several alike.** A rule applies as Chrome creates the animation, and to the
  group a frame stop holds when set there; `element` is a selector the element
  matches, such as `div.item:nth-child(4)`. Per-animation speed (`slow`) is
  gone, from the rules and the MOTION row, since `rate` sets the speed for the
  whole page including its JS. A whole-page freeze holds the page as the
  animation is created and sets it to the point, in place of a wall-clock timer.

### Fixed

- **A bench play runs a sequence that steps a held screen.** The bench
  released every hold before each step, so a `hold frame` after an `input`
  with `holdBeforeFrame` met a running page and failed, and the play stopped
  at every step that held the screen. A hold a run's own step took now stands
  through the run's later steps, and the play carries on into a step that
  moves page time.
- **A replay credits a step with what its recording did.** A read-only step
  claims no traffic, as its recorded call claimed none; an animation a held
  press set off is credited to the press, read when Chrome creates it rather
  than when it reports it started; a held step is compared once its hold is
  released; and a release waits for Chrome to confirm the page runs before a
  check reads it.
- **A pause point is removed from its marker** once a run has passed it.
- **Chrome opens on its Terminal's macOS desktop.** A visible launch holds its
  window until that desktop shows. `CDP_TOOLS_DESKTOP_WAIT=0` disables it.
- **A step that holds the page no longer pauses its run.** The replay read the
  debugger pause a step's own code hold took as an unexpected breakpoint and
  paused the run after it.
- **Recorded steps survive a page load.** The bench listed only the events in
  the page in front, so a reload emptied the list while the recorder still held
  the earlier steps.
- **Stale watches exit.** `devharness watch` exits when its Claude process
  exits or `/clear` moves it to another session, instead of running forever.
- **A run that crosses the proxy starts from a fresh tab.** A given connection
  sitting on Chrome's new-tab page passed that URL as the proxied window's start
  URL, and the window failed to open with `ERR_INVALID_URL`, failing every
  `check:sequences` run on Chrome 156. The new-tab page now counts as blank, as
  `about:blank` did, and the window opens on the sequence's own start.

## [0.16.0] - 2026-10-21

### Added

- **A launch can turn on the watch of a person's input.**
  `connection({ action: 'launch', watchInput: true })` records the person's
  clicks and typing in that browser into History and onto the next reply while
  `replay.watchPersonInput` is off. RECORD MY INPUT on the bench now holds the
  watch the same way, across the page being replaced, where it used to watch
  only the page open when it was pressed.

## [0.15.0] - 2026-10-09

### Added

- **A pause point can notify the session.** A step's `pauseNotify` (the bell
  on the pause point line in the bench) makes a run stopping there append an
  `instruction` event and say so in its reply; an optional `pauseNote` is the
  reason, what the session carries out before `replay({ action: 'finish' })`.
  This is how a sequence holds an action no step can, such as a bench play.
  `replay({ action: 'pause', name, step, hold?, notify?, note?, remove? })`
  sets one from a session. (#117)
- **`check({ connectionOpen, condition: 'present' | 'absent' })`** reads the
  session's connection list, so a sequence asserts which browsers a run left
  open. (#121)
- **`bench start` takes `saveAs`** in a sequence and stores the bench page's
  address for later steps as `{{var:<name>.url}}`, so a check that drives the
  bench page replays after the bench restarts. (#120)

### Fixed

- **A bench play whose declared browser will not launch names it.** Every
  declared browser is attempted; the failure names each one that would not
  launch with its launch error, closes the browsers the play launched, and
  lists connections that were open before the play. The bench shows all of it
  instead of a one-line summary. (#116)
- **A run no longer navigates to `startUrl` before a launch step creates its
  connection**, which opened a stray Chrome under that name that the launch
  then found in its way. (#118)
- **`issues create` accepts `startUrl: 'about:blank'` with
  `includeSequence: false`**, the combination its own error recommended. (#119)
- **The bench's marker tools no longer stay drawn over the line after a
  click**; they stay up for keyboard focus only.

## [0.14.0] - 2026-10-07

### Added

- **`input scroll` takes `steps`, `durationMs` and `decay`**: a run of wheel
  events, each delta `decay` times the last, each sent at its own offset from
  the first, so a trackpad momentum tail reaches the page as one stream. The
  reply states the span the events went out over, and the asked span beside it
  where the two differ by more than one gap.
- **`replay run { bench: true, envFile }` reads the file**, and every later
  play in that bench, the pane's Replay button included, resolves
  `{{env:NAME}}` from it.
- **`drag`, `swipe`, `tap` and `scroll` at x/y name the element under each
  point**, or the viewport a point falls outside; `_meta.elements` carries
  both. A gesture on stale coordinates reads as a miss in its own reply.
- **`hold release` names the layers it released.**

### Changed

- **`repeat` and `runFromLog` over several indices print each step's reply**:
  an `inspect` step's reading in full, every other step's first line.
- **`connection launch` reports the viewport the loaded page measures**,
  marked where it differs from the size asked for.
- **`replay export` refuses `filename`.** The file is written under the
  sequence's own name, and the parameter changed nothing.
- **A failed auto-connect on `connection launch` is an error response.**
- **The docs bound "managed servers survive" to restart and rebuild.** Session
  end and `/reload-plugins` stop the servers the session started.

### Fixed

- **A bench play keeps each step of a two-browser sequence in the browser it
  names.** Opened on one of the sequence's own browsers, the bench counted one
  browser and rebound the other's steps onto its tab.
- **An insert during a paused run goes through.** The insert's own recording
  cleared the history-viewed flag it checked, so every one answered "Run
  `replay history` first".
- **An insert into a new sequence carries every declared field** - browsers,
  sockets, tags - with step-indexed fields renumbered.
- **Bench status, start and already-open read a debugger pause**, naming its
  location and every non-network hold, where a pause read as "Page running".
- **An armed code hold landing in devharness's timer wrapper lands in the app's
  callback**, and the resume of that step no longer records a release that
  dropped the hold.
- **The orphan-Chrome cleanup leaves a Chrome younger than the inactivity
  threshold alone**, so a launch still connecting is not killed.
- **`hold` refuses a connection with nothing attached.**
- **A second `devharness watch` from the same Claude process exits on start**,
  so each event arrives once after a rewind.
- **`ServerManager.close()` ends every port-detection loop and awaits the last
  write.** A loop outliving a test wrote a dead server's entry into the repo's
  `.devharness/servers.json`, blocking every devharness call.

## [0.12.1] - 2026-10-05

### Fixed

- **`input type` with no `selector` types into the focused element**, followed
  through open shadow roots. The recorder writes that step for a keystroke
  inside a shadow root, and the handler refused it, so the recording failed on
  replay. Nothing focused answers `TYPE_NO_FOCUSED_ELEMENT`.
- **`input press` takes a chord** such as `Meta+a`. It threw
  `Unknown key` on the form the recorder writes. On macOS, ⌘ with a, c, x, v or
  z also carries its editing command, which Chrome runs from no key event.
- **The bench plays a sequence holding a typed-text step.** Play ended at step
  0 with no failure line; the run had returned a prompt for replacement text.

### Changed

- **`BENCH_ALREADY_OPEN` names the call that opens another sequence in the
  open bench**, in place of stopping and restarting it.

### Added

- **socket-app: a field two shadow roots deep**, sent as `GET /search`, and the
  `shadow-field-typing` sequence over it.

## [0.12.0] - 2026-10-01

### Changed

- **One name for a connection: `connection`.** Every tool takes `connection`
  where it took `connectionReason`. `connection launch` and `attach` create the
  connection named in `connection` (it was `name`), and `rename` takes the new
  name in `newName`. A sequence's `requiredConnections` entries take
  `connection` (it was `reference`). Saved sequences, pulled issues,
  `history.log` lines, bench favourites and CLI calls are rewritten on read;
  an MCP call still written with `connectionReason` is refused, naming the
  field it became.
- **A connection name takes `proxied` as a fourth word**, for the proxied
  connection made from a three-word one: `user-one-join-proxied`.
- **Errors name the connection name**, not the old reference parameter.
- **The bench's Servers tab is Running**: Watcher (the event-stream watch, the
  sequence directories reloaded on edit, each watch-mode server's paths),
  Connections (switch and close) and Servers.

### Added

- **A call that fails on a field is repeated with only that field.** Every
  call enters history, a refused one included, and a field error's reply ends
  with `Replay N, fix: <fields>`, the repeat call spelled out on the first one
  of a session. `replay repeat` takes `params` for one recorded call (`null`
  removes a field) and answers with the tool's own reply. A refusal reads as
  one line per field. The `continuationToken` is gone.
- **`connection launch` with `newContextWindow: true`** adds a window to the
  Chrome already on `port`, with cookies and storage of its own; with
  `proxy: true` that window alone routes through the proxy, so a running
  Chrome gains a proxied window without a relaunch. `copyCookiesFrom` starts it
  with another connection's cookies.
- **Enable proxy** on the bench's Traffic tab, proxy panel and sequence
  notice: a proxied window in the same Chrome at the same page, under
  `<name>-proxied`, and the bench moves to it.
- **A connection picker in the bench header**: the open connections, counted
  on the connection mark, each with its state's dot; choosing one moves the
  bench to it. The bench's disc stands on the picker as the chosen
  connection's.
- **A sequence that crosses the proxy brings one up.** `replay declare` takes
  `proxy`, `create` sets it when the recording crossed one, and traffic or
  socket checks and boundary rules imply it. A run on a live connection
  outside the proxy plays in a proxied window it opens and closes, and says
  so in its summary. `recordedThroughProxy` in an older file reads as `proxy`.
- **The bench's Tools form marks the fields a run failed on**, with a red
  border and what was wrong under each.
- **The bench's tabs carry marks and counts**: crossings at the proxy, calls in
  history, connections and servers running, issues open. A count of 0 draws
  nothing, a rising count pulses, Traffic is red while the page runs outside a
  proxy, and the words go below 900px.
- **`bench start` with `openTab: false`** starts a bench with no tab of its own.

### Fixed

- **A held or paused page is no longer removed as dead** by `connection
  list`'s liveness probe, which ran script the held page could not answer.
- **The rename form in the bench's Tools tab shows `newName`**: a field's
  actions are read from every sentence of its description.
- **`build:verify` passes**: the Modal category's prose moved under its line,
  so its parameter names stopped counting as tools.

## [0.11.0] - 2026-09-30

### Added

- **Waits hold a replay step open.** Wait on a row makes its step wait for
  that kind of crossing. The response on the kind says how many, for how many
  seconds, and whether a miss fails the step or carries on; with no response,
  one within 10 seconds, failing on a miss. The step's list shows
  `waiting for <name> (N left)` under its rows until they have all crossed.

- **Saved responses belong to the site.** Each is kept once per host and port
  in `activity/_site/<host>-<port>.json`, with a response type: **Local**
  answers only in the sequence that made it, **Opt In** only in the sequences
  that opt in, **Opt Out** in every sequence except those that opt out. A sequence records its opt-ins (`responsesOn`, at every step or at
  a set of steps) and opt-outs (`responsesOff`) in its activity file. The proxy
  panel lists every response on disk by site; expanding one shows the response
  and its mode, and under it the sequences that opted in or out.
- **A pin can answer under several steps** (`steps`), so one response serves
  steps 2, 4 and 7 of a run with one hit count.
- **Captures are taken again and compared.** CAPTURE holds the page and opens
  a dialog: click an element, or take the window (Screen), the whole document
  (Page), or the document with the window's place marked (Page w/ VP). Each
  PNG carries its record - page, window size and pixel ratio, the element or
  the element around a crop, the crop, where the page's JS was stopped - and
  a clean copy. `bench({ action: 'retake' })` or the note's retake button
  writes the next version: before, after and the difference side by side,
  and a `comparison` event with the share changed and its box.
  `bench({ action: 'capture' })` reads a file's record.
- **An element capture can record what the element is**: the handlers on it
  and its ancestors, the CSS that applies with each rule's source, computed
  values, box, what covers it and the font drawn, its markup and its
  accessibility role, name and states. A retake names each that changed.

- **Steps move, fold and go on the UI tab.** A step marker drags to a new
  place, or moves one place with ↑ and ↓; the bin takes it out on a second
  click. A click on the marker folds its rows to a count per colour. The
  `steps` divider carries the last replay's differences and the passes held.
- **Consecutive moves of one step are one `sequence` event.** Moves of the
  same step within 2 seconds of each other are announced once, from where it
  started to where it ended.

### Fixed

- **A logpoint belongs to the connection it was set on.** At its limit it
  paused the active connection, counted matching lines from every tab, and a
  logpoint on the same line in a second tab overwrote the first. Setting one
  also wrote a stray copy into the active connection's breakpoint list.
- **`execution acknowledge` with no connection finds every paused one.** It
  read only the active connection and answered "not paused" while the pause
  guard kept blocking on another.
- **Suggested calls name the connection they came from**: the pause guard,
  `breakpoint await` and `resetCounter`, `acknowledge`, and the paused-page
  errors. Replies that suggested `listBreakpoints()`, `setBreakpoint()`,
  `navigateTo()` and other names that are not tools now name real calls.
- **A replay run takes its connection from an `attach` step**, so a Node.js
  sequence's bare `breakpoint` and `inspect` steps run on the process it
  attached to, and a sequence that attaches to Chrome runs without a browser
  launched ahead of it under the same name. A nested sequence treats an
  attach as it treats a launch. `repeat` and `runFromLog` fill a connection
  into every tool that takes one, not only browser tools; a bare `execution
  acknowledge` and `source loadMaps` stay bare.
- **Replay passes a `reason` when it releases a browser it launched**, which
  validation had refused, leaving the name bound until Chrome's exit handler
  ran.
- **`connection list`, `status`, `switch` and a reusing `launch` answer
  while a connection is paused.** Reading the page title waited for the page
  to resume, and the pause guard blocked `list`, `status` and `browsers`.
- **A tab opened in a proxied Chrome reaches its proxy.** The proxy was
  registered under the launching name only, so a second tab (`launch` with
  the same `port`, or `attach`) and a proxied launch that named no connection
  answered "No proxy" to the `proxy` tool, and their initiator notes were
  dropped. Every tab of the browser now resolves to the one proxy, which
  stops only when no tab's name still holds it.
- **A tool name matching an inherited property is unknown.** An MCP call
  named `toString` passed the unknown-tool check.
- **`modal dismiss` works in a tab that is not in front.** The button click
  waited on a rendering frame such a tab never produces, and failed after
  minutes.
- **`breakpoint set` returns after `execution pause`.** Its console link was
  the next JavaScript the page ran, so the pause stopped there and the set
  waited for a resume. `execution pause` now says the pause is requested and
  when it takes effect.

- **Moving, removing or adding a timer renumbers the armed waits.** The file's
  waits were renumbered and the session's armed copy kept the old step
  numbers, so a wait showed under the step now at its old place, and the next
  rules write put the old numbers back. Names given to kinds at a step are
  renumbered with them.

- **A step wait is honoured by a replay.** Waits were saved on the sequence
  and shown on screen, and nothing in a replay read them, so a step released
  on its settle time whatever it was waiting for.

- **A replacement for an event-stream (SSE) message answers it.** The proxy
  recorded each message of a `text/event-stream` response and passed the
  stream through unread, so a frame rule made from an SSE row never fired. Each
  message is now matched against the frame rules and passed on, replaced
  (keeping its `event:` and `id:` lines) or dropped. A compressed stream is
  still passed through untouched.

- **A new recording no longer inherits the open sequence's rules.** Starting a
  recording left the previously open sequence's rules armed, and saving it
  wrote them onto the new sequence. It now starts with the site's rules only.

- **An element capture in headless Chrome shows the page at its own width.**
  Taken from the bench's CDP session, a clipped capture dropped the size a
  headless launch set, and the element was drawn laid out at the bare window.

### Changed

- **Breaking: 41 tools become 29, and every call names its connection.**
  - `connection` (launch, attach, list, switch, rename, close, status,
    browsers) replaces `launchChrome`, `connectDebugger`,
    `disconnectDebugger`, `switchConnection`, `listConnections`,
    `getDebuggerStatus`, `getChromeStatus` and `tab`. `name` creates or
    renames a connection; `connectionReason` addresses one. `close` requires
    a `reason`; `list` gives each connection's URL and title and drops dead
    ones; `switch` selects the connection's page. A new tab in a running
    Chrome is `launch` with its `port`.
  - `browser` (kill, resetLauncher) replaces `killChrome` and
    `resetChromeLauncher`, so allowing `connection` allows no kill.
  - `source` (get, loadMaps), `modal` (detect, dismiss) and `download`
    replace `getSourceCode`, `loadSourceMaps`, `detectModals`,
    `dismissModal` and `saveToDisk`; debug logging is `config`
    `setDebugLogging` and `debugLoggingStatus`.
  - A call that acts on a connection without `connectionReason` is refused
    instead of reaching whichever connection was active. `execution
    acknowledge` alone keeps a bare form.
  - Saved sequences, sequences pulled from GitHub, `history.log` and CLI or
    bench calls using the old names are rewritten to the new calls where they
    are read. An MCP call to an old name returns `UNKNOWN_TOOL` with
    `replacedBy`. Permission allowlists naming the old tools need the new
    names. An old `tab create` becomes a launch on the reserved port, where
    it opens a tab in the Chrome there or starts one.
  - A sequence pulled from GitHub that uses `browser` is refused without
    `allowPrivilegedSteps`, as `execution`, `server`, `request` and
    `download` are.
- **Schema defaults moved into the handlers**, so history and saved
  sequences record what a call passed, not `autoConnect`, `headless` and
  `host` on every connection action.

- **A retake runs at the recorded window size and pixel ratio**, letting a
  held page run while it resizes so its handlers lay it out, then puts the
  size, scroll and freeze back. A tab in the background, where Chrome runs
  no resize handlers, and two captures at different scales are reported
  rather than counted as change.
- **`sweep` keeps every version of a capture a note cites**, and reports
  the versions of an uncited one with it.
- **One place for rules, saved as they are made.** A rule is made and
  edited in full on the traffic row it answers, and the proxy panel lists
  every rule as saved responses, a line opening its row. ON REPLAY and its
  save button are gone: each change is written onto the open sequence, and
  rules made while recording are written when it stops. A rule bound to a
  step reads that it answers during a replay rather than `never fired`.
- **The proxy button lights as traffic lands** - aqua for a step's, orange
  for the app's own, red for a failure - carries the count of rules in force,
  and opens what crossed in words, since a recording began while one runs.
  The crossing bar on STEPS is gone.
- **While recording, traffic lands under the step that caused it,** placed
  by time since no command stamps a person's click; the floating bar carries
  the recording's name and its stop and throw-away controls, and the steps
  are listed once, as a replay lists them.
- **Buttons read in sentence case.**
- **A sequence's activity lives in its own file.** `sequences/<name>.json`
  holds the actions; what the app did under each step, the saved responses,
  waits, refuse setting and traffic names go to `activity/<name>.json`,
  keyed to the sequence's id, and are read back with it. A sequence saved
  before this moves its activity out on its next save.
- **A rule made from a row answers at any step.** Bound to the row's step,
  it left the same call earlier in the run to the server; the step is kept
  for the editor to narrow back to.
- **A replay does not stop on a failure the recording had.** A click
  followed only by failed-request console errors, no more than that step
  failed when recorded, passes as recorded; a script error or a new failure
  still stops it.
- **Storage writes show under their steps.** localStorage, sessionStorage,
  cookies set by script and IndexedDB appear as rows beside the traffic, while
  recording and on replay, and are kept in each step's saved traffic.
- **`bench start` returns.** Its result carried the bench session whole,
  live page handle included, and serialising that never finished.
- **Saving a recording leaves the record form.** It came back with the old
  name in it.
- **A replay drives the app when the bench tab is in front.** Chrome drops
  synthesised clicks on a hidden tab, so a sequence played from the bench tab
  ran its navigate and reported every click done. The app's tab is brought
  forward for the length of a step or a play, and the bench put back after.
- **A replay drives the app after a note was saved.** Chrome's picker
  stays on after a pick, so a note left it swallowing every later click -
  a replayed sequence ran its navigate and nothing else - while the bench
  showed it off. A pick now switches it off, and a replay or recording
  switches it off before driving.
- **A kind of traffic can be named,** from its open row; the name replaces
  the payload on its rows and saved responses and is kept on the sequence.
- **A large frame is matched by its leading field** (`"tag":"big"`) though
  its preview is cut short, and a body past 16 kB is shown in part until
  asked for; a row's head stays one line.

## [0.10.1] - 2026-09-25

### Fixed

- **A note or capture taken while a recording runs is kept.** The sequence
  has no file until the recording stops, so a note saved mid-recording was
  refused with "no sequence open". Notes and their captures are now held
  against the recorded step, shown under it as the recording grows, and
  written onto the file when it lands; a cancelled recording discards them.

### Changed

- **`bench` start prints the event-stream watch when nothing reads the
  stream.** It counts the processes holding the stream open and, at zero,
  puts the `Monitor` call on its first line on every start, since notes,
  captures and sequence writes otherwise reach the agent only on its next
  call. The session-start hook and the skill state the watch as the
  session's first tool call.
- **A crop is settled from the region's own corner.** Accept and cancel
  sit inside the bottom-right of the region drawn instead of in the header.

## [0.10.0] - 2026-09-24

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

## Unattributed - shipped across 0.3.0 to 0.9.17

The entries below were written before this file carried a section per release.
Each shipped in some version between 0.3.0 and 0.9.17; which one is not
recorded here.

### Fixed

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
