# React fixture

A React dev build for exercising the devharness bench. `npm install && npm run dev` serves it on 3102.

Three nested components (`App` → `OrderRow` → `StatusPill`) so a pick has something to name, and two
deliberately transient states: the saving pill lasts 600ms and the toast 1200ms, which is the window
the bench exists to hold open.

What a pick returns here:

| Field | Result |
| :--- | :--- |
| `component` | `StatusPill`, read off the fiber |
| `source.fileName` | the absolute original path |
| `source.lineNumber` | `3`, with `corrected: true` |

The correction matters. `@vitejs/plugin-react` prepends an HMR preamble and then reports JSX positions
against that shifted file, so it claims line 22 for a file four lines long - while its *column* stays
correct. The bench checks the reported position against the file and searches by column and tag when
it does not match, which is what turns 22 back into 3. The Preact fixture next door reports its line
correctly and comes back with `corrected: false`, so both frameworks land on the same answer by
different routes.
