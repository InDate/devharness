# The bench

A pane beside the app being driven. Load this when the task is judging a UI
feature, letting someone point at what is wrong, walking a sequence step by
step, or reading what crossed the boundary under a step.

```
bench({ action: 'start', connectionReason: 'app' })          # returns the pane's URL
bench({ action: 'start', connectionReason: 'app', sequence: 'checkout', step: 3 })
```

`start` returns as soon as the pane is open and never blocks. Open its URL in a
tab beside the app — Chrome's split view has no API, so the person splits it.
Launch the browser with `proxy: true` or the boundary records nothing; a
running browser cannot gain one.

## Nothing is injected into the app

The pane is served from `127.0.0.1` while apps sit on `localhost` — a different
site, so Chrome gives it its own renderer. A frozen page cannot accept a
keystroke, which is why the UI cannot live inside it.

## The two toggles

**PICKER** decides whether a click points at something or reaches the app.
**FREEZE** decides whether the page runs at all. They are independent:

- Driving the app needs the picker disarmed **and** the page running.
- Picking works either way — the picker is Chrome's, not the page's.

While the page is held, anything waiting on a timer stops, including a
navigation's load timers, so other devharness tools report it as paused at a
breakpoint. `bench({ action: 'unfreeze' })` or `stop` clears that — **not**
`execution({ action: 'resume' })`, which leaves the bench holding a page it no
longer has.

## Walking into a transient state

```
bench({ action: 'tick', steps: 1 })        # one callback - the exact unit
bench({ action: 'tick', budgetMs: 800 })   # as many as cover that page time
```

One callback is one thing the page does, so `steps: 1` is the smallest real
move. `budgetMs` is for chasing a known timeout and reports where it landed,
which is rarely the number asked for. Each step records the callbacks it ran
through — what scheduled them, the function, the source line, the page time —
and that only exists while stepping: a freely running page is never paused.

## Driving a sequence from the pane

The run bar appears only while a sequence is open: position, RESTART, REPLAY,
STEP, PLAY, and PAUSE while a play is walking the steps.

**PAUSE stops on the step it reached and freezes the page there.** The step in
flight is cut short by its abort signal rather than left to run out its settle,
so what is on screen is the state at the moment of the press. PLAY carries on
from that step and releases the freeze the pause put there.

That one step is taken again on resume. An input whose settle was cut may or
may not have reached the page, and re-running it is the only certain answer —
so a step that writes may write twice. Nothing earlier re-runs.

Beside the position, two numbers, each hidden when zero: what crossed the
boundary under that step (aqua) and how much of it a rule answered (orange).

## Notes and captures

The person picks a step, clicks the element in the app tab, types, saves. Each
note records the selector, the text, the component name and the JSX source
location where a dev build exposes one, and is stored **in the step of the
sequence file** — so it travels with the sequence rather than beside it.

- A saved note carries a step picker: moving it takes its capture with it.
- CAPTURE takes the page as it stands and opens the UI screen where the draft
  lands. Mark it up with box, arrow or pen; **crop** cuts the capture down to a
  region and the marks move with it.
- The draft chooses which step it is filed against before it is saved.

`bench({ action: 'list' })` reads back what was recorded. Saves reach the
session event stream, so with a watch armed they arrive mid-task. Keep working
while the person writes.

## The boundary panel

The proxy control states three things and opens the rest:

| reads | means |
|---|---|
| red | no proxy — nothing records what crosses |
| green | recording |
| frost | recording, and nothing is crossing: the page is frozen |

Inside: the sites the browser may load (add and remove by host), what the list
has blocked, whether writes no rule answers are refused, and what the proxy is
holding. Pressing it with no proxy asks the session to relaunch through one.

## Captures no note refers to

```
bench({ action: 'sweep' })                  # report only
bench({ action: 'sweep', remove: true })    # delete them
```

Removing a note leaves its capture on disk. `sweep` reads every sequence store,
local and global, so a capture another sequence cites is never taken; it skips
`screenshot-*` files, which no annotation cites; and a capture held by an
unsaved draft counts as cited. Needs no browser.

## From a shell

```
devharness bench                      # the pane against this shell's session
devharness bench checkout             # opening that sequence
devharness bench checkout http://…    # and starting the page there
```

A bare word is read as a sequence name, an `http(s)` word as a URL, in either
order.

## Ending it

Closing the pane's tab releases the page, detaches the debugger and shuts its
server down. `stop` does the same from the agent side. Notes are written as
they are saved, so neither loses anything.
