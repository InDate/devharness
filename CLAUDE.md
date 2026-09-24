# devharness

Working *on* this repo, as opposed to using its tools against another app.
`CONTRIBUTING.md` holds the build, test, hot-reload and release mechanics, and
the `devharness-contributing` skill holds the code conventions.

## A rebuild discards what the running child held in memory

`npm run build` signals SIGUSR2 from its postbuild hook, and the supervisor
restarts `build/index.js`. Everything that child held goes with it, not only the
Chrome instances listed under Hot reload in `CONTRIBUTING.md`:

- The proxy registry (`src/proxy/registry.ts`). A proxy started by
  `launchChrome({ proxy: true })` is gone, and every event it captured with it.
- Live connections, so a `connectionReason` resolves to nothing until a fresh
  `launchChrome`.

A drive that checks a change has to run after the rebuild that carries the
change. Build first, drive second. Rebuilding part-way through a drive discards
the evidence collected so far and returns `Connection not found`.
