---
name: evidence-timeline
description: How a recorded sequence shows what the app did at its boundary - the one-list decision, what a step owns, when repeated events collapse, and which parts have prior art behind them. Use when changing how the control pane orders, groups or attributes steps and traffic, when deciding where an observed event belongs, or before inventing a rule for any of it.
---

# The evidence timeline

A sequence holds two kinds of entry: **actions**, which replay, and
**observations**, which are evidence and never execute.

They sit in **one chronological list**, not two lanes. Reading order carries
cause. Lanes exist where the axis is wall-clock microseconds; this axis is a
read order. Cypress is the closest precedent - commands and network in one
list behind a per-kind filter.

## What a step owns

Only three things are caused *at* an action. Everything after is consequence.

| Event | Direction | When | Kind |
|---|---|---|---|
| localStorage / sessionStorage write | out, never leaves the browser | at the action | initiating |
| HTTP request issued | out | at the action | initiating, opens a pair |
| HTTP response | in | later | consequence of that request |
| WebSocket or SSE opened | out | at the action | initiating, opens a transport |
| frame or message received | in | any time until close | consequence of the transport |
| frame sent | out | any time | initiating, by whichever action sent it |

Opening a transport does not make that action responsible for its traffic. A
later action can send on a socket opened earlier, and what comes back belongs
where it arrived.

A time window is reliable for initiating events, which are synchronous with the
click. It is wrong for consequences: measured against `examples/socket-app`, a
click that opened a socket attributed its POST and none of its frames, because
the first frame arrived 500ms after the next click had already closed the
window. Frames piled onto whichever entry stayed open longest.

## Rules with prior art behind them

Detail and URLs: `references/prior-art.md`.

- **A group breaks on any intervening event of a different kind, and on a
  change in the group key.** Chrome's console compares only against the
  immediately preceding message.
- **Never break a group on a time gap.** Nothing in the surveyed field does.
  Time opens a group and never closes one. A gap threshold silently splits a
  burst a reader would read as one.
- **Floor, not ceiling.** Chrome renders fewer than five similar messages
  individually rather than collapsing two into a group.
- **An action and the thing it sent are two entries.** No tool merges them.
- **A request and its response are one entry.** Every HTTP-layer tool. Two
  entries only below HTTP, or where client and server report separately.
- **Attribution is stored at capture, not computed at read.** Datadog writes an
  `action.id` onto each observation and types it as a string *or an array*, so
  an observation belonging to two actions is representable rather than resolved.
  Read-time windowing is wrong at every boundary.
- **Ship the exclusion list with the window.** A polling endpoint or a socket
  heartbeat holds an activity window open forever. Datadog names this as its one
  failure mode and answers it with a URL exclusion list.

## Where this is new ground

Two choices have no prior art. Treat them as decisions, not as patterns.

- **Frames inline versus a container per connection.** Chrome, HAR, Playwright
  and OpenTelemetry all put frames inside one durable entry for the connection.
  The cost, which no source addresses: a frame's moment never reaches the outer
  timeline, so a frame that arrived between two clicks cannot be read as having
  done so. Inline placement fixes that and needs the grouping rules above to
  stay readable.
- **Re-parenting an observation after the fact.** Recorders edit steps; Chrome's
  Recorder has no reorder at all and Selenium IDE reorders actions. Nobody moves
  an observation onto a different action. With attribution stored as an id it is
  a one-field edit, and there is no interface to copy.
