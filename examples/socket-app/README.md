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
`write IndexedDB`, `write Cache Storage`, `write a file` (the origin-private
file system) and `register a service worker` each leave a record in the page
and cross no boundary. `remove all of these` undoes every one, and the
`stored:` readout lists which the page holds, as one attribute each, for a
synchronous check to read.
A network record of these holds nothing - measured: after a localStorage write
and an IndexedDB write, it held the document and a favicon 404.

`storage({ action: 'writes' })` reports the localStorage and sessionStorage
ones as they happen, read off the CDP DOMStorage domain, with the value written
and the value replaced. IndexedDB emits no write event and stays outside it.

`write a draft, then POST it` writes the same record and sends it, so the two
cases are separable: one click produces a boundary crossing, the other produces
none while changing what the app holds. It sends the session token, so it needs
`POST /session` first.

`DRAFT_FAILS=1` makes `POST /draft` answer 500, for checking what a replay does
with an endpoint that has regressed. Note what happens: the 500 logs a console
error, so click validation stops the run at that step before any behaviour
comparison is reached. Boundary drift covers the class that logs nothing.

## Dialogs the browser draws

`native dialogs` hands control to the browser's own UI three ways, and each
upload crosses as `POST /upload`:

- **choose a file to upload** - an `<input type="file">`'s picker. A
  devharness call that opens it holds it with no OS window, for
  `modal({ action: 'answer', files })`.
- **choose with showOpenFilePicker** - the File System Access picker. A call
  that opens it is refused by Chrome, and the page logs `AbortError`.
- **forget the upload (asks first)** - a `confirm`, which stops the page's
  scripts until it is answered.

## What the page adds

- **open 60 sockets** — past `MAX_SOCKETS`, for the eviction order.
- **open one from a worker** — a socket whose `target` is not `page`.
- **navigate with sockets open** — sockets closed by their document going away.
- **send a text / binary frame**, **close from the page** — the `sent` paths,
  including the opcode-8 frame that sets `clientClosed`.
- **what's new** — a banner shown until it is dismissed once in the browser
  (`localStorage` `socket-app:seen-whats-new`). A fresh profile meets it and the
  run after does not, which is the state a guard step exists for.

## A field no selector reaches

`a field inside shadow roots` nests a `<textarea>` two open shadow roots deep,
as a component library nests a field, with hosts that carry nothing a selector
can name.
Enter sends its text as `GET /search?q=`, and `searched:` shows what arrived.

- A keystroke recorded into it resolves to no selector, so its `input type`
  step carries text alone and types into whatever holds focus.
- `press Meta+a` then `type` replaces the text. A select-all that did not run
  arrives as both queries run together.

## A setting reached through several steps

`preferences` sits behind three clicks: **open settings**, a row of the
accounts list (rows carry no test id), then **preferences**. Its toggles each
send `POST /prefs` with the key they changed, and `on:` lists the keys set.
Only the Dark toggle carries a test id (`dark-toggle`), so a recording reaches
it by test id, by position (`.prefs li:nth-child(3) button`) or by text
(`Dark mode`), depending on what the recorder or the person picked.

`LAYOUT=2` serves the toggles as a release changes them:

- a **Compact** toggle is inserted above Dark, so the third row is now Compact;
- **Dark mode** is renamed **Dark theme**.

`LAYOUT=3` does both and moves **preferences** behind an **advanced** button,
so the path gains a step. The two are kept apart because a path that breaks
first stops every sequence before the toggle it was recorded to reach.

A sequence recorded on layout 1 meets layout 2 according to how it reached the
toggle: by position it clicks Compact and the click succeeds, by text it finds
nothing, by test id it still works. On layout 3 every sequence walking the old
path fails at the hidden **preferences** button, each copy of the path on its
own.

## Sequences

`sequences/` holds three that exercise every kind of check a sequence carries,
and one that takes every store the page keeps through its lifecycle.
Copy them, with `activity/`, into the project's `.devharness/` to run them.

- **checks-lifecycle** — the /live connection end to end: a guard that runs
  `dismiss-whats-new` when the banner is there, element waits, a wait on three
  `"tag":"push"` frames under the `ask for 3` click (in `activity/`, armed when
  the bench runs the sequence), page asserts with and without a time limit, a
  value assert on a captured session token, a guard that runs
  `socket-reconnect` after the drop, and a fixed pause.
- **socket-reconnect** — retries, and while retry is still offered runs itself
  again, one level deeper, then checks the state reads `open`. The server
  refuses the first reconnect after a drop, so a run goes two levels deep;
  the replay's nesting limit bounds a server that never lets it back in.
- **dismiss-whats-new** — closes the banner.
- **hold-traffic** — holds the network layer on an open /live connection. The
  page's ask for three pushes waits at the proxy, the server sees nothing and
  the page receives nothing. One step lets the ask through and the three
  pushes wait in its place; the next lets one push through; release delivers
  the other two in the order the server sent them. Needs `proxy: true`.
- **state-lifecycle** — writes each store once, writes two again, reloads with
  a worker running, opens and closes a worker with its own socket, removes
  every write, then removes them again on an empty app. A baseline of it holds
  each store's set, changed and removed rows, and none under the second clear.

- **native-dialogs** - each of the three dialogs above, answered by the
  step after the one that opened it: a fixture file for the picker, OK for the
  confirm, and the page's `AbortError` for the File System Access picker.
- **native-dialogs-by-hand** - the same three with no recorded answers. Run
  from the bench, each dialog opens on screen and the run waits for the
  person to answer it there or with the bench's OK and Cancel.
- **shadow-field-typing** - clicks the shadow-DOM search field, types with no
  selector, selects all with `Meta+a`, types a replacement and presses Enter;
  `searched:` reads `prompt cache`. The click is at fixed coordinates under
  the what's-new banner, so it runs on a profile that still shows it.

- **prefs-by-testid**, **prefs-by-position**, **prefs-by-text** - the path
  to preferences, then the Dark toggle by test id, by row position and by
  label. Recorded on layout 1. On `LAYOUT=2` by-testid passes, by-text fails
  at the click with element not found, and by-position pauses at its click:
  the step's stored fingerprint names `dark-toggle` and the click hit Compact.
  The boundary comparison alone reports nothing for by-position: `POST /prefs`
  crosses in both runs, and the body that names the toggle is not compared.
- **prefs-autoplay** - a copy of the same path turning Autoplay on. On
  `LAYOUT=3` it and prefs-by-testid fail at the hidden **preferences** button,
  each copy of the path needing the same fix of its own.
- **hidden-tab-click-lands** - puts a second tab in front of the app's tab and
  clicks the app: the click brings the app's tab to the front and lands.

The first run in a browser runs `dismiss-whats-new`; the second skips it.
