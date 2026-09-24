# Capability checklist

Read off MSW (`mswjs.io/docs/http/intercepting-requests/`, `/mocking-responses/`,
`/api/setup-worker/start/`) and Polly.JS (`netflix.github.io/pollyjs/#/configuration`,
source `docs/configuration.md`). Third column is what devharness has, with
the line that holds it.

## Matching

| Capability | Source | devharness |
|---|---|---|
| Method + URL predicate, `:param` and `*` tokens | MSW | method and a URL substring (`Pin`, `src/proxy/intercept-proxy.ts:22`; `matchPin`, `:1417`); no tokens |
| Regular expression predicate | MSW | none |
| Predicate function over the request, returning `{matches, params}` | MSW | none; the sequence file is JSON and carries no code |
| Match independently on method, headers, body, **order** | Polly | method; a replay step in place of the ordinal (`underStep`, `:1403`); no header or body match on a request |
| URL matched per component: protocol, username, password, hostname, port, pathname, query, hash | Polly | pathname as the bench key (`keyOf`, `src/bench/frontend/crossing.tsx:57`); host through the allow list (`allowOnly`, `:858`); query and hash outside the key |
| A normaliser function per component - drop an auth header, strip an email from a body, rewrite a hostname | Polly | a fixed normaliser for a frame's field (`frameMatch`, `crossing.tsx:93`; naming keys `:72`, moving values `:79`); `{{env:NAME}}` for credentials in step params only |
| One payload field compared by value | neither | `FrameField` (`:237`), `fieldOf` (`:249`), `objectOf` (`:266`), `carries` (`:278`) |
| Narrowest of several matching handlers answers | neither (MSW: first declared; Polly: one recording per identity) | constraints then text length, both matchers (`:1362`, `:1417`) |

MSW excludes query parameters from the predicate deliberately: they carry data,
not resource identity. Polly matches query by default and lets it be turned off.
devharness follows MSW here through `keyOf`.

## Responding

| Capability | Source | devharness |
|---|---|---|
| Return a response from the resolver | MSW | a pin's status, headers and body (`handle`, `:1436`) |
| **Throw** a response to short-circuit mid-resolver | MSW | none; a pin is data, not code |
| Status outside 2xx-5xx, and headers the Fetch API forbids (`Set-Cookie`) | MSW | any status and header the pin names; the proxy writes raw headers |
| Body as text, JSON, Blob, ArrayBuffer, FormData, URLSearchParams, ReadableStream | MSW | a string body; `content-type` from the pin (default `application/json`) |
| Request, requestId, path params and cookies in the resolver | MSW | none |
| Redirects, cookies and error responses as named cases | MSW | none |
| Replay timing: fixed delay, or scaled to the original latency | Polly | per-step `delay`; a pin answers at once |
| Replace or drop a socket frame, either direction | neither | `FramePin.replaceWith`, absent to drop (`:750`); the frame hook in `handleUpgrade` |

## Lifecycle

| Capability | Source | devharness |
|---|---|---|
| Modes: record / replay / passthrough | Polly | passthrough with pins; no record mode - a pin's body is taken from a captured event by hand (`proxy({ action: 'body' })`, the bench row) |
| `recordIfMissing` - replay what exists, pass through and record the rest | Polly | none |
| Unmatched request: bypass / warn / **error (aborts)** | MSW (`onUnhandledRequest`) | `refuseUnmatchedWrites` (`:880`, branch `:1474`): unmatched writes answered 403 and recorded `refused`; reads forwarded under either setting |
| Unrecorded request with `recordIfMissing: false` errors | Polly | as above, by method rather than for every request |
| `recordFailedRequests` - whether a >=400 is persisted | Polly | every event is recorded; the file holds decisions, not events |
| `expiresIn` + `expiryStrategy`: warn, error, or re-record | Polly | none; `hits` (`:42`, `:776`) and `never fired` on the row are the only reading of a stale pin |
| `keepUnusedRequests` - prune a recording to what the run used | Polly | none |
| `disableSortingHarEntries` - on-disk order chosen for diff readability | Polly | rules are written in staging order onto `boundaryRules` (`src/command-recorder.ts:73`) |
| Persister behind an interface: filesystem, localStorage, REST, custom | Polly | the sequence file (`saveBoundaryRules`, `src/tools/bench-tools.ts:757`) |
| Adapter per transport: fetch, XHR, node http, Playwright, Puppeteer | Polly | one proxy for the browser's HTTP and WebSocket; a node-side `request` step is outside it (`src/tools/request-tools.ts:79`) |
| A decision bound to one position in a run | Polly's `order` (by count) | `step` on a pin (by replay step), from the bench's STEPS view or `proxy({ action: 'hold', step })` (`src/tools/proxy-tools.ts:50`) |

`expiresIn` is the answer to stub drift. A stored double is one moment's
payload, and without expiry a sequence passing against it establishes that the
UI handles that shape and nothing about what the API returns now. devharness
has no expiry; the `hits` count is the reading a person has.

## What is novel here

A refuse keyed on method with reads passing through. MSW's `"error"` and
Polly's `recordIfMissing: false` refuse every unmatched request, which rules
out driving a real read-only surface under them. `refuseUnmatchedWrites`
forwards `GET`, `HEAD` and `OPTIONS` and answers every other unmatched method
403, so "this run writes nothing the rules do not answer" is a bound the
proxy holds. Its own bounds: node-side `request` steps and sent socket frames
are outside it, and a tool-side `replay run` arms it only where the tool set
it on the proxy first.
