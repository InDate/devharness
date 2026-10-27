# Activity matrix

`matrix.json` holds each scenario of a page activity other than network and motion - storage writes, console output, page errors, native dialogs and navigations - against each capability devharness offers for it: seen, log (whether it stands in the observation log beside requests, frames and motion), credit, compare, source, and rule. Each cell carries what devharness is expected to do and how that stands today: works, gap, unmeasured or n/a, with its basis, `code` or `sequence:<name>`. A cell reads works only on a sequence basis. Defaults are written once per capability, per kind and per carrier, and a scenario carries only what differs.

Most scenarios run on the socket app (`node examples/socket-app/server.mjs`, `http://localhost:7788/`), named by the `data-testid` of the control that sets them off. One logs from `examples/modals/modal-test.html`, and one is the motion catalog's favicon 404. A scenario with no url is a case no demo page stages yet: a `console.error` from a handler, a throw, an unhandled rejection, an `alert`, a `prompt`, `beforeunload`, a client-side route change and a back navigation.

`matrix.html` renders it as a grid filtered by kind, trigger, carrier and standing; serve this folder with any static server, for example `python3 -m http.server -d examples/activity 4730`, and open `http://127.0.0.1:4730/matrix.html`.

Motion has its own matrix in `examples/motion/matrix.json`. The conditions behind Credit, Compare and Log stand in `docs/landscapes/attribution.landscape`.
