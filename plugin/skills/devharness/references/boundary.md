# The boundary: what the app sent, and what caused it

`launchChrome({ proxy: true })` puts an intercepting proxy in front of a
browser. What it holds is what reached the outside world — local reads and
writes never appear, which is the point: it answers "what did the app do
externally", and CDP answers the rest.

Read it with `proxy({ action, connectionReason })`.

| action | answers |
|---|---|
| `status` | is a proxy running, what is refused, how many holds stand |
| `events` | what crossed, newest last (`since`, `until`, `urlIncludes`) |
| `sockets` | what each socket did, and whether arrival on it names a cause |
| `body` | one event's kept payload (`id`) |
| `hold` / `holdFrame` | answer a URL, or replace or drop a socket message; `step` bounds either to one replay step |
| `release` / `holds` | remove one, list what stands |
| `refuse` | `unmatchedWrites: 'refuse'` answers every POST, PUT, PATCH or DELETE no hold covers with 403, recorded as `refused`; `'forward'` sends them on |

## Reading an event row

```
ev-42  cmd 12  GET http://app/api/save 200 (likely) <input>
ev-43          <- ws://app/live 240b (unprompted)
```

- **`cmd 12`** — the step this belongs to. Absent means no step owns it, which
  is a statement, not a gap: it is the app acting on its own.
- **`(likely)`** — how much the attribution rests on. See below.
- **`<input>`** — what the page says started it, where the page could say.

## What a step owns

A command's consequences arrive after it returns, so three mechanisms decide
ownership, in this order.

**1. The bucket closes at the command's return.** A bucket covers its own
command and nothing later. What crosses afterwards carries no command.

**2. The page says what started it.** Read per request and per send:

| root | means | owned by |
|---|---|---|
| `input` | a user gesture was dispatching | the command that drove it |
| `timer` | a `setTimeout`/`setInterval` callback was on the stack | nothing |
| `parser`, `preload` | the document's markup named it | the command that loaded that document |
| `script` | script asked, with no timer or gesture above it | the command in flight, by position |

A timer-rooted request or send is the app's own schedule: it weighs nothing and
enters no step's tally, so a poll firing a different number of times between a
recording and its replay is not drift. A gesture-rooted one is owned by the
command that drove the gesture even when its bytes leave afterwards.

**3. The settle window**, `stepSettleMs`, off by default. Holds a returning
command's cursor over what starts inside it, crediting by position. This is the
fallback for traffic the page cannot report on — a worker's first line, a page
attached to after its load, a page that has frozen `WebSocket.prototype`.

## Levels

A level is read from stored evidence at the time you read it, not stamped at
capture, so a change to the rule re-reads events already captured.

| level | evidence | weight |
|---|---|---|
| `observed` | a payload id ties this arrival to a send | 1 |
| `likely` | consumed a send's allowance, or a gesture started it | 0.7 |
| `positional` | it crossed while that command ran; nothing measured a cause | 0.3 |
| `unprompted` | nothing accounts for it: no send outstanding, or a timer started it | 0 |

The weight is what a comparison counts, so a wrong attribution costs a fraction
rather than moving a whole event onto another step.

## Sockets

`proxy({ action: 'sockets' })` reads each socket's shape off its own frames.

- A send opens an **allowance**; an arrival settles the oldest; an arrival with
  none outstanding is `unprompted` and makes the socket `push`.
- A **payload id** (top-level JSON `id`) pairs an arrival to its send directly,
  and is kept rather than consumed, so every frame of one subscription pairs to
  the send that opened it. A socket whose subprotocol names its ids becomes
  authoritative on them.
- A **timer-rooted send opens no allowance**, so a heartbeat cannot make the
  next push read as an answer.

`reply` means every arrival was accounted to a send. `push` means something
arrived unasked, so arrival on that socket names no cause.

## Ruling a shape

Where the wire cannot separate an answer from a push, a person watching can.
The bench's BOUNDARY tab assigns a verdict to a **payload shape** — the
class of message, not one frame:

`step` · `send` · `background` · `unknown`

A verdict outranks any reading of the wire, one decision settles every later
frame of that shape, and the rules are stored with a recording so a replay
weighs the same shapes the same way. A shape ruled `background` is left out of
both the weights and the counts, and stops holding a settle window open.

## What reaches a recording

`replay({ action: 'create' })` stores per step: weighted `shapes`, unweighted
`seen` counts, `windowMs` (how long the step's bucket was held), and the
sequence carries the shape rules. Steps whose events the ring had already
dropped are named in `shapesUnmeasured` and left out of the comparison rather
than compared against nothing.

A drift row sets the two runs beside each other:

```
- step 4 `input.click`: json:push 2 → 0 (held 41.2s recording, 0.3s replaying)
```

The hold times sit beside the difference because a step held far longer while
recording collected traffic arriving on the app's own schedule — read that
before reading the difference as behaviour.

## Limits worth knowing

- 2000 events per proxy, 64KB of body kept per exchange, 200 socket profiles.
- Only the app's host reaches the network; the browser's own service hosts are
  refused and counted (`proxy({ action: 'status' })`).
- Everything the proxy holds lives in memory for the session. A rebuild of
  devharness discards it, along with the browsers it launched.
