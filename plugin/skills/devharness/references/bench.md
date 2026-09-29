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
breakpoint. `bench({ action: 'release' })` or `stop` clears that — **not**
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

**PAUSE stops on the step it reached and holds the page there.** The step in
flight is cut short by its abort signal rather than left to run out its settle,
so what is on screen is the state at the moment of the press. PLAY carries on
from that step and releases the hold the pause put there.

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
- CAPTURE holds the page and opens a dialog: click an element in the app tab,
  or take **Screen** (the window), **Page** (the whole document) or **Page w/
  VP** (the document with the window's place marked). Cancel releases a hold
  the dialog made; a hold already on stays.
- An element capture can also record its `events` (handlers on it and every
  ancestor), `css` (rules that apply with their source, computed values, box,
  what covers it, rendered font), `html` and `a11y`, read at the frozen moment.
- The draft opens with box, arrow, pen and **crop**; marks move with a crop.
  It chooses which step it is filed against before it is saved.

`bench({ action: 'list' })` reads back what was recorded. Saves reach the
session event stream, so with a watch armed they arrive mid-task. Keep working
while the person writes.

## Before and after

Each capture PNG carries its record: page, window size and pixel ratio, the
element or the crop's anchor, the crop, whether the page was held and where its
JS stood, and the element facts. Viewers show the marked picture; the clean
copy the comparison uses travels inside the file.

```
bench({ action: 'retake', capture: '<path>' })            # against version 1
bench({ action: 'retake', capture: '<path>', against: 2 })
bench({ action: 'capture', capture: '<path>' })           # record and facts
```

A retake writes the next version of the series: before, after and the
difference side by side (changed red, anti-aliased edges amber), and a
`comparison` event with the share changed, its box, how the region was found
(`element`, `anchor`, `rectangle`) and each element fact that changed. The
bench shows the versions under the note's thumbnail with its own retake.

| the retake finds | it does |
|---|---|
| another window size or pixel ratio | runs the page at the recorded one, held pages included, then puts the size back |
| the app tab in the background | resizes anyway and says so: Chrome runs no resize handlers there, so script-set layout keeps the old size |
| captures at two scales | reports both scales instead of a percentage |
| another URL, or no record in the PNG | refuses |

## The boundary panel

The proxy control states three things and opens the rest:

| reads | means |
|---|---|
| red | no proxy — nothing records what crosses |
| green | recording |
| frost | recording, and nothing is crossing: the page is frozen |
| filled for a moment | traffic landed: aqua a step's, orange the app's own, red a failure |

A count on it is the rules in force. Inside: what crossed (since recording
began, while one runs), the saved responses, the sites the browser may load,
what the list has blocked, whether writes no rule answers are refused, and what
the proxy is holding. Pressing it with no proxy asks the session to relaunch
through one.

A rule is made and edited on the traffic row it answers; the saved responses
list every rule, and a line opens its row, or the same editor in place where
no row carries it. Every change is written onto the open sequence; rules made
while recording are written when it stops. A rule bound to a step answers only
during a replay, and reads so.

Every saved response is kept once per site, in
`activity/_site/<host>-<port>.json`, with a response type. **Local** answers
only in the sequence it belongs to (`owner`) and is offered to no other; **Opt
In** answers only in the sequences that opt into it; **Opt Out** answers in
every sequence on the site except those that opt out. A row it answers reads
`Intercepted: Local Response` or, for the two shared types, `Intercepted:
Global Response`. A sequence's activity file records only where
it differs: `responsesOn` lists what it opts into, at every step or at the
steps given, and `responsesOff` what it opts out of. A step number names an
action in one sequence, so steps belong to the sequence's use, never to the
response. A response made from a row is Local to the open sequence, used at
the step chosen or at every step. Opening a sequence arms the site's responses
as its uses say; a new recording starts from the modes alone. Deleting a
response deletes it from every sequence on the site.

**Wait** on a traffic row holds that row's step open in a replay until that
kind has crossed under it: the response on the kind sets how many, for how
many seconds, and whether a miss fails the step or carries on (one, 10
seconds, fail, with no response). The step's list shows `waiting for <name>
(N left)` under its rows until they have all come. Waits are kept on the
sequence as `{ step, key, count }`.

Writes the page keeps to itself - localStorage, sessionStorage, cookies set by
script, IndexedDB - are rows too, in violet, under the step they landed in, and
are kept in that step's traffic on the file. IndexedDB names the database and
store, not the value; cookies are compared twice a second, so one set and
cleared inside that window is not seen.

A sequence's actions are in `sequences/<name>.json`; what the app did under
each step, the saved responses and the traffic names are in
`activity/<name>.json`, read and written with it. A site's responses are in
`activity/_site/<host>-<port>.json`.

A kind of traffic can be named from its open row ("call it"); the name stands in
for the payload on every row of that kind and in the saved responses, and is
written onto the sequence as `boundaryNames`, keyed as its rule would be.

## Captures no note refers to

```
bench({ action: 'sweep' })                  # report only
bench({ action: 'sweep', remove: true })    # delete them
```

Removing a note leaves its capture on disk. `sweep` reads every sequence store,
local and global, so a capture another sequence cites is never taken; every
version of a cited series is kept with it; it skips `screenshot-*` files, which
no annotation cites; and a capture held by an unsaved draft counts as cited.
Needs no browser.

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
