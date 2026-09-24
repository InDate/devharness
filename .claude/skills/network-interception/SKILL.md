---
name: network-interception
description: What devharness holds for intercepting traffic - the proxy a browser is launched through, the pins that answer a request or a socket frame, the rules a sequence carries, the step binding, the field predicate and the refuse mode - where each lives, what bounds it, and what prior art (MSW, Polly.JS) settled. Use when changing anything that pauses, stubs, records or replays network traffic, when a sequence has to drive part of a system without writing to it, or before proposing a seam that already exists.
---

# Network interception in devharness

The request this keeps arriving as: drive part of an app without the writes
reaching the real system, with the decision on a replayable sequence.

The seam is an intercepting proxy between the browser and the server
(`src/proxy/intercept-proxy.ts`), started per browser by
`launchChrome({ proxy: true })` and scoped to the app's host at launch
(`src/proxy/registry.ts:28`). It carries HTTP and socket frames through one
place. CDP `Fetch` is not used anywhere in `src/` (`grep -rn 'Fetch\.' src`
returns nothing), and the observing tools (`network`) stay on CDP, which sees
cache hits and service-worker replies the proxy never does. The design
record for the identity function is `docs/landscapes/match-identity.md`.

## What exists, and where

| Thing | Where | What it computes |
|---|---|---|
| Request pin | `Pin`, `intercept-proxy.ts:22` | `urlIncludes` substring, optional `method` and `step`; answers with status, headers, body; counts `hits` (`:42`) |
| Frame pin | `FramePin`, `:750` | `textIncludes` read as one `"key":value` field or as characters (`fieldOf`, `:249`); optional socket url, direction, `step`; `replaceWith` or drop |
| Request match | `matchPin`, `:1417` | narrowest accepted pin: constraints (method, step) first, then substring length |
| Frame match | `matchFramePin`, `:1362` | narrowest accepted pin: constraints (url, direction, step, field-on-a-parsed-frame) first, then text length; parses the frame once (`objectOf`, `:266`; `carries`, `:278`) |
| Step binding | `underStep`, `:1403` | a pin with `step` answers only while that replay step is the cursor (`src/tools/replay-executor.ts:2359`) |
| Refuse mode | `refuseUnmatchedWrites`, `:880`; branch at `:1474` | an unmatched request outside `GET`/`HEAD`/`OPTIONS` (`SAFE_METHODS`, `:46`) is answered 403, recorded `heldAs: 'refused'`, counted |
| Host scope | `allowOnly`, `:858`; `BROWSER_SERVICE_HOSTS`, `:532` | hosts outside the list are destroyed and counted; the app's host is on the list by construction (`src/tools/bench-tools.ts:423`) |
| Tool surface | `src/tools/proxy-tools.ts:41` | `hold`, `holdFrame` (with `step`, `:50`), `release`, `holds`, `refuse` (`unmatchedWrites`, `:51`), `status`, `events`, `sockets`, `body` |
| Bench rules | `setBoundaryRule`, `src/bench-mode.ts:1079` | a row's `answer` / `block` / `hide` becomes a pin; `block` is a 204 pin or a dropped frame; `hide` arms nothing |
| Rules on the file | `boundaryRules`, `src/command-recorder.ts:73`; `boundaryRefuse`, `:96` | key, verb, method, step, url, direction, body, status; the refuse setting |
| Arming from the file | `armSavedRules`, `src/bench-mode.ts:1322` | opening a sequence in the bench arms its rules and its refuse setting; closing clears them |
| Key derivation | `keyOf`, `src/bench/frontend/crossing.tsx:57`; `frameMatch`, `:93` | pathname for a request; for a frame, a naming key (`:72`) holding a value that does not move (`:79`), then the first such value, then the first non-digit string, then the first key |

## Identity, and its bounds

A rule finds a later crossing by the predicate its pin computes. What the
predicate reads and what it leaves out is the whole of what a rule can and
cannot do.

- A request is matched on a URL substring and, from the bench, its method.
  Query and origin are outside the key (`keyOf` takes the pathname, `:60`),
  so a key rebases for free under `baseUrl` and a path carrying an id
  (`/draft/42`) keys the rule to one run.
- A frame is matched on one top-level JSON field by value where the frame
  parses, and on characters where it does not. The field is chosen once, at
  staging, by `frameMatch`; the pin has no part in choosing it. A rule keyed
  on a moving value reads `never fired` on the row (`crossing.tsx`, the
  `hits` span), which is the reading that exposes the choice.
- A step-bound pin answers only under a replay cursor. During a live drive
  the cursor is a command index, so the pin answers nothing; a request that
  starts after its step released carries the next step or none.
- The bench holds one rule per key (`boundaryRules` is a `Map` keyed by
  `key`), so two bodies at two positions of one path is expressible from the
  `proxy` tool (two holds with two steps) and not from the bench.
- The refuse mode bounds the browser's HTTP. A `request` step with
  `destination: "node"` runs `fetch` from the server process
  (`src/tools/request-tools.ts:79`, `:114`) and passes through no proxy; a
  sent socket frame carries no method and is outside the mode.
- A tool-side `replay run` arms nothing from the file: rules and the refuse
  setting reach the proxy through the bench opening the sequence, or through
  the `proxy` tool directly.

## Prior art, and what devharness does differently

Read off MSW and Polly.JS; the per-row comparison is in
`references/capabilities.md`.

- **Polly's `matchRequestsBy`** is `Boolean | Function` per component -
  method, headers, body, and each of protocol, username, password,
  hostname, port, pathname, query, hash - with `order` a boolean, default
  `true`. devharness has method, a path substring and a step in place of
  the ordinal, and a fixed normaliser (`frameMatch`) in place of a function.
  A function form is unavailable: the sequence file is JSON and carries no
  code.
- **MSW's `onUnhandledRequest`** accepts `"bypass"`, `"warn"` (default) and
  `"error"`, and `"error"` throws and aborts the request. **Polly's**
  `recordIfMissing: false` errors on an unrecorded request. Both refuse
  every unmatched request or none. devharness's `refuseUnmatchedWrites`
  refuses by method and forwards reads, so a run reaches a real read-only
  surface while every write is answered or refused; that mode has no prior
  art, the all-or-nothing one does. An earlier version of this skill stated
  that neither library refuses; that was wrong.
- **Neither has a frame pin.** A frame carries no method, URL or status; the
  field predicate over the payload is the handle devharness gives it.

## Storage

A sequence variable is a step: `setVariable` (`src/tools/bench-tools.ts:868`)
writes an `inspect.evaluateExpression` with `saveAs`, and a whole-string
`{{var:name}}` keeps the resolved value's real type
(`src/tools/interpolation.ts:30`, `:195`). Tokens are resolved over step
params only; a rule's key or body is armed as the raw string
(`armSavedRules` passes `raw.body` straight through), so a token in a rule
is served literally. `teardown` (`src/command-recorder.ts:67`) and
persistent profiles cover the neighbouring cases: permit a write and reverse
it, or reach a state without driving to it.

## WebSockets

Frames are captured (`recordFrame`, `src/network-monitor.ts:594`, `:606`)
and intervened on at the proxy's frame hook. These are measured against
`examples/socket-app`, not inferred:

| Finding | How |
|---|---|
| Protocol ping and pong never reach the capture | `/ping` records zero frames while the server pings once a second |
| Close frames never arrive as sent frames | a page `close()` left `1 out`, the binary frame sent before it |
| A replaced document delivers no close event | fixed by `Page.frameNavigated`; Puppeteer's `framenavigated` also fires same-document and closed a live socket |
| `framesDropped` counts frames | 300 sent, 200 held, 100 reported |
| A sent frame can be replaced | a `"cmd":"push"` pin replacing `n:5` with `n:12` produced twelve pushes from `/live` |
| A field pin and a text pin split a stream | over those twelve, `"i":1` as a field took one hit and `i":1` as text took the three it also matches (`10`, `11`, `12`) |

Freeze does not compose with a socket. A held HTTP request leaves the far
side idle; a held socket is live, app-level heartbeats stop with the page's
JS, and the server hangs up. Read the app's real heartbeat interval before
designing any pause around a socket. The bench's no-injection principle
(`src/bench-mode.ts:93`) rules out a shim over the page's `WebSocket`
constructor, which is why the frame hook lives in the proxy.

## Before changing this

The cheapest thing that changes a plan, in order:

1. Read `docs/landscapes/match-identity.md`. The designs not taken are
   surveyed there with what holds each up; a proposal that matches one of
   them starts from its bounds.
2. Drive `examples/socket-app` through a proxied browser. `POST /session`
   then `POST /draft` is the ordinal case (`/draft` answers 401 without a
   session); `/live` is the frame case. Build first, drive second: a rebuild
   discards the proxy registry and every event in it (`CLAUDE.md`).
3. Read one target app's traffic before adding a matcher. Whether its
   payloads name themselves by a field `frameMatch` reads, and whether its
   writes go over HTTP or a socket, settles which bound above is met first.

Scope: sites the user owns or is authorised to test.
