# socket-app

A WebSocket app for exercising devharness frame capture (`network({ action: 'sockets' })`).

```
node examples/socket-app/server.mjs        # http://localhost:7788
PORT=7900 node examples/socket-app/server.mjs
```

It depends on `ws`, which the repo root already has; there is nothing to install.

## What each endpoint is for

| Path | Exercises |
|---|---|
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

## What the page adds

- **open 60 sockets** — past `MAX_SOCKETS`, for the eviction order.
- **open one from a worker** — a socket whose `target` is not `page`.
- **navigate with sockets open** — sockets closed by their document going away.
- **send a text / binary frame**, **close from the page** — the `sent` paths,
  including the opcode-8 frame that sets `clientClosed`.
