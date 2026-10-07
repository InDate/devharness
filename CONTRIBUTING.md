# Contributing

```sh
npm install
npm run build
npm run test:run
```

## Running your build

Two things ship: an MCP server published to npm, and a plugin served from
`plugin/` by the marketplace. They are tested separately because they install
separately. Set up both once:

```sh
npm install
npm run build

# the server, as a second MCP server beside the published one
claude mcp add devharness-dev -- node build/mcp-supervisor.js

# the plugin - its hooks, manifest and skill - from this checkout
claude plugin marketplace add ./
claude plugin install devharness@devharness-local
```

`plugin/` deliberately has no `package.json`: a plugin directory containing one
gets a full `npm install` on every install, which cost 175MB of dev
dependencies per version before this was split out. So the plugin carries the
manifest, the skill and the hooks, and `plugin/.mcp.json` points its server at
the *published* package.

That split decides what each half of the setup covers.

| Change | What picks it up |
| :--- | :--- |
| Anything under `src/` | `npm run build` - postbuild signals the supervisor, which restarts the child |
| `plugin/hooks/`, `plugin/.claude-plugin/`, `plugin/skills/` | `claude plugin marketplace update devharness-local`, then a new session for a `SessionStart` hook |
| The CLI (`devharness call`, `which`, …) | `node build/mcp-supervisor.js <command>` - the checkout is not on PATH |

Plugin ids are `name@marketplace`, so `devharness@devharness-local` installs
beside the published `devharness@indate-tools` rather than over it. Nothing
claims to be a released version, which is what separates this from linking
`node_modules/.bin/devharness` at your build. Do **not** do that: it works, but
it makes the plugin run your working tree while claiming to run a pinned
published version, which is the exact thing the version pin exists to prevent,
and you would be debugging against code no user has.

Check the marketplace manifest with `claude plugin validate .`. It warns that
`plugin/.claude-plugin/plugin.json` carries no `version`, which is true of the
published manifest too.

### Two errors that are expected here

`sh: devharness: command not found` from either plugin's `.mcp.json`, inside
this repo only. The plugin runs `npx -y devharness@<version>`; `npm exec` reads
this repo's `package.json`, sees the same name and version, decides the spec is
already satisfied, and skips the install - then looks for a `devharness` bin in
`node_modules/.bin`, which npm never links for a package's own bin. From any
other directory npx fetches from the registry and it works. Use `devharness-dev`
here; that is what it is for.

The SessionStart hook reporting that the `devharness` CLI is not on PATH. It
isn't - the plugin never installs one, and neither does npx. `npm i -g
devharness` fetches the *published* build, which is a different thing from your
checkout.

### Hot reload

`mcp-supervisor.js` is the `bin` entrypoint; it supervises `build/index.js` as a
child. On SIGUSR2 - from the postbuild hook, `kill -USR2 $(cat
.devharness/mcp-supervisor.pid)`, or the `config({ action: 'restart' })` tool -
it restarts that child and sends `notifications/tools/list_changed`. So a
rebuild is usually enough; no `/mcp` reconnect.

- Chrome instances the old child launched are killed - call `connection` action `launch` again.
- Managed dev servers survive and reattach; they live outside the child's lifetime. Supervisor shutdown (session end, `/reload-plugins`, SIGTERM/SIGINT/SIGHUP, host stdin closing) stops the servers the session owns.
- The **supervisor** keeps running its own older code until the client
  reconnects. A change under `src/supervisor/` needs `/mcp`, not a rebuild.
- `config({ action: 'restart' })` is itself in the frozen tool list, so testing a
  change to the restart mechanism runs the *old* tool until the restart completes.

The build reports `Sent SIGUSR2 to mcp-supervisor (PID n)` or `No pidfile ...
nothing to reload`. Read that line before reading code when behaviour
contradicts your source - but it is a claim about a pid, not proof your session
reloaded. The build signals whoever is named in *this repo's* pidfile, which is
someone else's supervisor when your session is supervised from another
directory. Ask the running server instead:

```
config({ action: 'status' })
```

`Built:` is the mtime of the `build/index.js` the process actually loaded;
`Running:` is which file that is. Older than the build you just ran means you
are talking to previous code. Check this before concluding your source is wrong
- hours have gone into debugging a fix that already worked.

## Before a PR

Two always, then whichever rows of the table your change touches:

```sh
npm run test:run      # vitest, ~15s; tests are colocated as *.test.ts
npm run build:verify  # starts the server, checks the shipped docs match the tools
```

| If you changed | Also run |
| :--- | :--- |
| `src/supervisor/`, `src/server-claims.ts` | `npm run stress:suspend` |
| the `Target.attachedToTarget` handler in `src/network-monitor.ts` | `npm run check:targets` |
| `src/worker-targets.ts`, or `target` on `inspect`/`console` | `npm run check:workers` |
| replay, `input` element handling, `examples/socket-app` | `npm run check:sequences` |
| `plugin/hooks/` | start a new session and read what the hook printed |
| a tool's name, actions or responses | the doc-sync list at the end of this section |

The three `check:`/`stress:` scripts need a build first and are deliberately
outside `npm test`: they spawn real processes and a real Chrome, which the
vitest suite never does.

`build:verify` is the release gate. It fails if `docs/instructions.md` or
`plugin/skills/devharness/references/tool-categories.md` disagree with the tools the
server actually registers, or if the skill's version stamp doesn't match
`package.json`. Those files ship to users, so drift there is a user-facing bug.

`npm run stress:suspend` drives the built supervisor as a real process — idle
suspend, orphan reaping, requests landing inside the teardown window, RSS/fd
across cycles, signal collisions, kill escalation. Needs a build first, takes
minutes, deliberately outside `npm test`. Run named scenarios (`-- race leak`),
change the loop count (`-- --cycles=200`), skip the slow real-Chrome ones
(`-- --skip=release,shared`); `STRESS_VERBOSE=1` shows supervisor stderr. Run it
whenever `src/supervisor/` or `src/server-claims.ts` changes — `release` and
`shared` pin the dev-server ownership rule, and a regression there kills a
server someone else is using.

`npm run check:targets` attaches the built `NetworkMonitor` to a real Chrome and
checks that a target held by auto-attach is released: a service worker
registers, a registration for a missing script rejects with its 404, and a
dedicated worker runs. Needs a build first, takes seconds, outside `npm test`
because the vitest suite never spawns Chrome. Run it whenever the
`Target.attachedToTarget` handler in `src/network-monitor.ts` changes — a resume
that waits on a pending CDP send leaves the target held, and every service
worker registration in a devharness-driven Chrome then hangs. `--headful` shows
the window; `CHECK_PORT` moves the fixture server off 45901.

`npm run check:workers` registers a service worker in a real Chrome and drives
`WorkerTargetRegistry` against it: the target is listed, an expression
evaluates inside `ServiceWorkerGlobalScope`, its console output is recorded,
and a reference matching nothing is refused. Needs a build first, outside
`npm test` for the same reason. Run it whenever `src/worker-targets.ts` or the
`target` parameter on `inspect`/`console` changes.

`npm run check:sequences` runs the socket-app's `prefs-*` sequences in headless
Chrome on `LAYOUT=1`, `2` and `3`, each held to its entry in the script's
`EXPECTED` table. Needs a build.

When you add, rename, or change a tool, update `docs/instructions.md`,
`docs/mcp-instructions.md` (if it affects the quick-start),
`plugin/skills/devharness/SKILL.md` and `references/tool-categories.md`, and
`docs/messages.md` (if it returns new response types). These are kept in sync by
hand; `build:verify` is what catches you.

## Releasing

Version lives in three places that must agree: `package.json`,
`plugin/skills/devharness/SKILL.md` frontmatter, and `plugin/.mcp.json` — the
last being the version the plugin actually installs. `build:verify` checks all
three.

```sh
npm run build:verify   # the gate — run it BEFORE bumping
npm version patch      # bumps all three, commits, tags, and pushes
```

`npm version` is the whole release. Its `version` hook
(`scripts/sync-skill-version.mjs`) stamps the skill and the pin into the version
commit, and `postversion` pushes the branch and tag with no confirmation step —
so make `main` exactly what should ship before bumping, and never run
`npm publish` by hand.

The tag triggers two workflows: `publish.yml` publishes to npm with provenance,
and `notify-marketplace.yml` asks
[InDate/indate-tools](https://github.com/InDate/indate-tools) to repin. The
marketplace opens a PR rather than repinning itself — publishing and pushing an
update to installed users are separate decisions.

Running `build:verify` after the tag is too late: the tag is public, the publish
run fails on whichever of the three is stale, and the marketplace has meanwhile
opened a PR pinning a version npm never received.
