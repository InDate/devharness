# socket-app

A WebSocket app for exercising devharness frame capture (`network({ action: 'sockets' })`).

```
node examples/socket-app/server.mjs        # http://localhost:7788
PORT=7900 node examples/socket-app/server.mjs
```

It depends on `ws`, which the repo root already has; there is nothing to install.

## The lifecycle, which is the point

`/live` is one connection the page drives by command. Nothing on it happens on
a timer - every message is a reply to something an action asked for, so a
recording of it reads as a story rather than as noise arriving underneath one.

Controls are gated on the connection's state and disabled rather than hidden,
so the order a sequence has to follow is readable from the page:

| state | what is available |
|---|---|
| disconnected | CONNECT |
| open | send 1, send 5, ask for 3, ask for 5, drop, disconnect |
| failed | retry |

`drop the connection` destroys the socket server-side without a close frame, so
the page sees `1006` rather than a clean hang-up, and arms the server to refuse
the next attempt. The path that produces is: drop, retry refused with `1013`,
retry accepted. A reconnect with a failure in the middle of it.

`POST /session` then `POST /draft` is the same idea over HTTP: the draft
endpoint answers 401 without a session token, so a sequence replayed out of
order fails at the boundary instead of passing quietly.

## What each endpoint is for

These are single-purpose and fire on their own schedule. They exist to exercise
capture, not to tell a story - use `/live` for that.

| Path | Exercises |
|---|---|
| `/live` | a connection driven by command: connect, send, ask for N, drop, retry, disconnect |
| `/small?ms=` | ordinary text frames, both directions |
| `/big?chars=` | payloads past `MAX_FRAME_PAYLOAD`, and what truncation retains |
| `/binary?bytes=` | opcode 2, where the stored payload is base64 |
| `/burst?n=` | `MAX_FRAMES_PER_SOCKET` and the `framesDropped` count |
| `/ping?ms=` | protocol ping/pong, and whether either reaches the capture |
| `/heartbeat?ms=` | a server talking to an idle page, against the inactivity sweep |
| `/quiet` | a socket that opens and says nothing |
| `/serverclose?code=` | a close frame from the server |
| `/badframe` | a frame error (invalid UTF-8 announced as text) |

Every endpoint echoes what the page sends, so the `sent` direction is reachable
from all of them.

## Ingress that is not a socket

| Path | Exercises |
|---|---|
| `/sse?ms=` | an `EventSource` stream: plain messages, a named `price` event, a payload split across `data:` lines, and `retry:` |

The HTTP record for a stream holds its method, headers and
`resourceType: eventsource`, and nothing else - `Status: N/A`, no response
headers, no body, and a `timing.duration` stamped on a request still
delivering, because the body never completes.

Its messages come from `network({ action: 'streams' })`, which reads them off
`Network.eventSourceMessageReceived`. Measured against this endpoint: named
events keep their name, `id:` is kept, and a payload split across two `data:`
lines arrives reassembled with the newline the spec puts between them.

## Egress that never reaches the network

`write localStorage`, `write sessionStorage`, `write a cookie`,
`write IndexedDB` each leave a record in the page and cross no boundary.
A network record of these holds nothing - measured: after a localStorage write
and an IndexedDB write, it held the document and a favicon 404.

`storage({ action: 'writes' })` reports the localStorage and sessionStorage
ones as they happen, read off the CDP DOMStorage domain, with the value written
and the value replaced. IndexedDB emits no write event and stays outside it.

`write a draft, then POST it` writes the same record and sends it, so the two
cases are separable: one click produces a boundary crossing, the other produces
none while changing what the app holds.

`DRAFT_FAILS=1` makes `POST /draft` answer 500, for checking what a replay does
with an endpoint that has regressed. Note what happens: the 500 logs a console
error, so click validation stops the run at that step before any behaviour
comparison is reached. Boundary drift covers the class that logs nothing.

## What the page adds

- **open 60 sockets** — past `MAX_SOCKETS`, for the eviction order.
- **open one from a worker** — a socket whose `target` is not `page`.
- **navigate with sockets open** — sockets closed by their document going away.
- **send a text / binary frame**, **close from the page** — the `sent` paths,
  including the opcode-8 frame that sets `clientClosed`.
