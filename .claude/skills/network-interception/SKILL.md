---
name: network-interception
description: What building request interception and test doubles into devharness requires - which CDP seam reaches which traffic, what prior art (MSW, Polly.JS) already settled, and the measured limits that bound the design. Use when adding or designing anything that pauses, stubs, records or replays network traffic, when deciding between a CDP Fetch seam and a proxy, or when a sequence needs to drive part of a system without making real changes.
---

# Network interception in devharness

The goal a request for this keeps arriving as: drive part of an app without
the writes reaching the real system, and have the decision survive into a
replayable sequence.

Nothing here is built. `network` observes: `list`, `get`, `search`, `sockets`.
`grep -rn "Fetch\.\|setRequestInterception" src/` returns nothing.

## Seams, and what each one reaches

| Seam | Reaches | Costs |
|---|---|---|
| CDP `Fetch` domain | HTTP, both stages, any origin, no page change | never WebSocket frames; per target |
| Breakpoints (`src/tools/breakpoint-tools.ts`) | anything in JS, including socket handlers | bound to source positions; breaks on redeploy |
| `baseUrl` (`rebaseSequence`, `src/tools/replay-executor.ts:1191`) | whole run onto another origin | rewrites `^https?://` only, so `ws://` keeps its recorded origin |
| `storage` tool | client state that never crosses the wire | no effect on outbound calls |
| Proxy between browser and server | HTTP **and** frames, one place, survives redeploy | TLS handling, real infrastructure |

`teardown` (`src/command-recorder.ts:46-57`), persistent profiles and nested
setup sequences are already built and solve neighbouring problems: permit the
write and reverse it, bound it by identity, or reach a state without driving to
it. Check whether one of those already covers the case before building a seam.

## Two stages, and only one of them guarantees anything

`Fetch.enable` takes `patterns` with `requestStage`. Both stages can be armed
for one URL.

- **Request stage** — nothing has left. `continueRequest`, `fulfillRequest`,
  `failRequest`. This is the only stage where "no real change" holds.
- **Response stage** — the call went, the server acted. `Fetch.getResponseBody`
  reads what arrived, `continueResponse` passes it on. Use it to drive the UI
  through answers a server will not produce on demand. It cannot undo a write.

`Fetch.authRequired` / `continueWithAuth` is a third pause. Arming `Fetch`
against a site with basic auth and ignoring it hangs every challenged request.

Requests are concurrent; a gate holding one at a time stalls the rest. Steps
are serial (`gateNewStep`, `src/annotate-mode.ts:1220`) and that gate's shape
does not carry over unchanged.

## Capability checklist

Read off MSW and Polly.JS, which already settled this. Detail and the
devharness gap per row: `references/capabilities.md`.

- **Matching** — method and URL predicate with params and wildcards; regex; a
  predicate function; independent match on method, headers, body and **order**;
  URL split per component; a normaliser function per component.
- **Responding** — return or throw a response; any status and header; body in
  several types; request, params and cookies available; replay timing.
- **Lifecycle** — record / replay / passthrough; record-if-missing; expiry with
  warn / error / re-record; prune unused; diff-stable ordering on disk.

Three things to carry from it:

- **The identity function is the problem.** Polly's `matchRequestsBy` is
  configurable per URL component *and* accepts a normaliser, because real
  traffic carries tokens, emails and timestamps that differ every run.
  `{{env:NAME}}` and `baseUrl` are point fixes for two of those components.
- **`order` matters and is on by default.** GET, POST, GET of one URL returns
  different bodies; ordinal matching is how that replays.
- **Nobody has "refuse".** Polly's third mode is passthrough, MSW's is
  do-nothing. Neither runs against a system it cannot afford to write to, so
  default-deny on unmatched non-idempotent methods has no prior art to copy and
  is the thing that makes the guarantee real rather than intended.

## Storage

A sequence variable is already a step: `setVariable`
(`src/tools/annotate-tools.ts:636`) writes an `inspect.evaluateExpression` with
`saveAs`, and a whole-string `{{var:name}}` keeps the resolved value's real type
(`src/tools/interpolation.ts:6-10`). `CommandSequence` has `teardown` and no
setup counterpart, so anything that is not an action gets encoded as one. Two
consequences already visible:

- `setVariable` splices after the leading navigate, so nothing it defines is in
  force for the page load — and a rule must be armed before the first request.
- The run-level `variables` parameter is keyed by typed-text step
  (`src/tools/replay-tools.ts:269`) and reaches no capture, so a stub payload
  cannot be retargeted per run.

A declarative block on `CommandSequence` is underneath interception, storage
seeding and payload stubs alike.

## WebSockets

Frames are captured (`recordFrame`, `src/network-monitor.ts`). Intervening on
them is a different question, and these are measured against
`examples/socket-app`, not inferred:

| Finding | How |
|---|---|
| Protocol ping and pong never reach the capture | `/ping` records zero frames while the server pings once a second |
| Close frames never arrive as sent frames | a page `close()` left `1 out`, the binary frame sent before it |
| A replaced document delivers no close event | fixed by `Page.frameNavigated`; Puppeteer's `framenavigated` also fires same-document and closed a live socket |
| `framesDropped` counts frames | 300 sent, 200 held, 100 reported |

CDP has no pause-and-modify for a frame. The two routes are a shim over the
page's `WebSocket` constructor, which contradicts annotate mode's no-injection
principle (`src/annotate-mode.ts:93-98`), or a proxy. A frame carries no method,
URL or status, so a rule for one is a content predicate over app-specific
payloads with per-run correlation ids — there is no generic mechanism to offer.

Freeze does not compose with a socket. A held HTTP request leaves the far side
idle; a held socket is live, app-level heartbeats stop with the page's JS, and
the server hangs up. Read the app's real heartbeat interval before designing any
pause around a socket.

## Before building

The cheapest thing that changes the plan, in order:

1. List the flows that cannot be driven today, and for each, whether a real
   response exists to replay. Where one does, record-and-serve covers it and no
   gate is needed.
2. Spike `Fetch.requestPaused` with `freeze` (`src/annotate-mode.ts:691`, the two clocks at `:81-83`):
   pause, freeze, wait past the caller's own timeout, fulfil, unfreeze, confirm
   the page consumes it. Whether those compose is unverified and load-bearing.
3. Read one target app's traffic. Sockets carrying the writes makes `Fetch` a
   local maximum and the proxy the seam.

Scope: sites the user owns or is authorised to test.
