# Prior art, with sources

Surveyed 2026-09-18. Each claim carries where it came from.

## One list or lanes

| Tool | Shape | Source |
|---|---|---|
| Cypress Command Log | one list; app events appended unnumbered and grey; "Show HTTP Requests" toggle | docs.cypress.io/app/core-concepts/open-mode |
| Sentry breadcrumbs | one list, mixed kinds, insertion order — explicitly *not* sorted by timestamp | develop.sentry.dev/sdk/data-model/event-payloads/breadcrumbs/ |
| Wireshark | one chronological packet list; per-connection view is a derived display filter | wireshark.org/docs/wsug_html_chunked/ChAdvFollowStreamSection.html |
| Chrome Performance panel | stacked lanes on one time axis | developer.chrome.com/docs/devtools/performance/reference |
| Playwright Trace Viewer | separate Actions / Console / Network tabs, joined by a time selection | playwright.dev/docs/trace-viewer |
| Charles Proxy | ships both orderings, user-switchable (Structure / Sequence) | charlesproxy.com/documentation/using-charles/requests-responses/ |

A single list cannot offer per-kind sorting without destroying its own ordering.
Playwright's Network tab sorts by status, method, duration and size; a
chronological list gives that up. Lanes give up the interleaving: two events in
adjacent lanes at one pixel have no stated order.

## Grouping

**Chrome console, repeat count** — adjacency run-length. `tryToCollapseMessages`
compares the candidate against `lastMessage` only, so any intervening message of
any kind ends the run. `isEqual` compares source, level, type, line, url,
scriptId, text, parameters, stack trace and timestamp. Turning timestamps on
disables the mechanism entirely — a visible per-row time and a collapsed run
contradict each other.
`front_end/panels/console/ConsoleView.ts`, `core/sdk/ConsoleModel.ts`

**Chrome console, "group similar"** — key-bucket, not adjacency. Key is
`source:level:type:pageLoadSequenceNumber` plus the title, pooled into a map, so
intervening events of another kind do not break it. Fewer than five sharing a
key render individually. Command, Result and System types are excluded, as are
Javascript and Network errors — errors are never silently folded away.
`front_end/panels/console/ConsoleViewMessage.ts`

**Datadog rage clicks** — more than three clicks in a sliding one-second window
collapse into one action. A window that opens a group.
docs.datadoghq.com/real_user_monitoring/browser/frustration_signals/

**Wireshark reassembly** — the boundary is the protocol's own framing, not a gap
or a count. All but the final segment are marked as segments of a reassembled
PDU. wireshark.org/docs/wsug_html_chunked/ChAdvReassemblySection.html

**Jaeger** — no automatic span collapsing. Collapse-below-a-duration was
proposed in 2018 and never shipped; volume was answered with virtualisation
instead. jaegertracing/jaeger-ui#435, #160; jaeger-ui PR 4190

## Action and send, request and response

Two entries for the action and what it sent: Cypress (numbered command plus a
badged request entry), Datadog (Action and Resource are sibling events), Sentry
(`ui.click` and xhr breadcrumbs), Playwright (Actions sidebar, Network tab).

One entry for a request and its response: Chrome Network (one row, tabs for
headers/response/timing), HAR 1.2 (one `entries` element holding `request` and
`response`), Burp Proxy history (one row, tabs on the selected item).

Two entries only below HTTP (Wireshark, one row per frame) or where client and
server report separately — and even there the field disagrees: OpenTelemetry
makes them parent and child spans, Zipkin makes them one shared span.

## Attribution

| Mechanism | Tool | Stated failure |
|---|---|---|
| Quiescence window, id stored at capture | Datadog: activity ends after 100ms with no in-flight xhr/fetch, no resource timing, no DOM mutation | polling and long-polling hold the window open forever; answered with `excludedActivityUrls` |
| Time window applied at read | Playwright: selecting an action filters the other tabs to that span | none stated; wrong for a request answered after its action ends |
| Call stack at issue time | Chrome Network Initiator column | the top frame is usually library code; the application frame needs expanding |
| Explicit propagation, span parenting | OpenTelemetry | implicit context breaks under native async/await in browsers; four bad options, all documented |

Datadog's `action.id` is typed as a string **or an array of strings**:
`DataDog/rum-events-format/schemas/rum/_action-child-schema.json`

Correctness order: span parenting, then call stack, then quiescence window, then
read-time windowing.

## Editability

Recorders edit, observers do not.

- Chrome DevTools Recorder: add step before/after, remove, edit target, value,
  selectors, timeouts, JSON round trip. **No reorder** — reachable only by
  editing the exported JSON. developer.chrome.com/docs/devtools/recorder/reference
- Selenium IDE: insert, cut/copy/paste, drag-and-drop reorder of steps.
  SeleniumHQ/selenium-ide PR 1346
- Playwright traces, Sentry breadcrumbs and replays, Datadog RUM, LogRocket:
  read-only. Mutation happens before recording (Sentry's `beforeBreadcrumb`),
  never after.
- Fiddler and Burp: delete an entry, edit and reissue a request; no reorder, no
  re-parent.

Nobody re-parents an observation after the fact. Attribution is computed once at
record time and is thereafter immutable.

## Long-lived connections

One durable entry containing its frames is the dominant pattern:

- Chrome: one row for the socket, a **Messages** tab with Data, Length, Time; SSE
  gets an **EventStream** tab. developer.chrome.com/docs/devtools/network/reference
- HAR: `_webSocketMessages` on the entry, each `{type, time, opcode, data}`,
  since Chrome 76.
- Playwright: WebSocket in HAR and traces as of 1.61; each connection's messages
  in its own `.jsonl` so frames append without a rewrite. microsoft/playwright PR 41200
- OpenTelemetry, gRPC streams: one span covering the full lifetime of the
  streams. opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/

Wireshark is the lone inversion — every frame a row, the connection recovered by
a filter.

The cost of the container, addressed by no source: a frame carries its timestamp
inside the container, so its moment never appears on the outer timeline.
