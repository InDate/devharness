# Capability checklist

Read off MSW (`mswjs.io/docs/http/intercepting-requests/`, `/mocking-responses/`)
and Polly.JS (`netflix.github.io/pollyjs/#/configuration`). Third column is what
devharness has today.

## Matching

| Capability | Source | devharness |
|---|---|---|
| Method + URL predicate, `:param` and `*` tokens | MSW | none |
| Regular expression predicate | MSW | none |
| Predicate function over the request, returning `{matches, params}` | MSW | none |
| Match independently on method, headers, body, **order** | Polly | none |
| URL matched per component: protocol, username, password, hostname, port, pathname, query, hash | Polly | `baseUrl` rewrites origin only |
| A normaliser function per component — drop an auth header, strip an email from a body, rewrite a hostname | Polly | `{{env:NAME}}` for credentials only |

MSW excludes query parameters from the predicate deliberately: they carry data,
not resource identity. Polly matches query by default and lets it be turned off.

## Responding

| Capability | Source | devharness |
|---|---|---|
| Return a response from the resolver | MSW | none |
| **Throw** a response to short-circuit mid-resolver | MSW | none |
| Status outside 2xx–5xx, and headers the Fetch API forbids (`Set-Cookie`) | MSW | none |
| Body as text, JSON, Blob, ArrayBuffer, FormData, URLSearchParams, ReadableStream | MSW | none |
| Request, requestId, path params and cookies in the resolver | MSW | none |
| Redirects, cookies and error responses as named cases | MSW | none |
| Replay timing: fixed delay, or scaled to the original latency | Polly | per-step `delay` |

## Lifecycle

| Capability | Source | devharness |
|---|---|---|
| Modes: record / replay / passthrough | Polly | none |
| `recordIfMissing` — replay what exists, pass through and record the rest | Polly | none |
| `recordFailedRequests` — whether a ≥400 is persisted | Polly | none |
| `expiresIn` + `expiryStrategy`: warn, error, or re-record | Polly | none |
| `keepUnusedRequests` — prune a recording to what the run used | Polly | none |
| `disableSortingHarEntries` — on-disk order chosen for diff readability | Polly | sequences are hand-ordered |
| Persister behind an interface: filesystem, localStorage, REST, custom | Polly | sequence files |
| Adapter per transport: fetch, XHR, node http, Playwright, Puppeteer | Polly | CDP only |

`expiresIn` is the answer to stub drift. A stored double is one moment's
payload, and without expiry a sequence passing against it establishes that the
UI handles that shape and nothing about what the API returns now.

## What none of them have

A mode that refuses an unmatched call. Polly passes through, MSW does nothing.
Both assume a system it is safe to write to. Default-deny on unmatched
non-idempotent methods is what turns "without making real changes" from an
intention into a step that fails loudly, and there is no prior art to copy.
