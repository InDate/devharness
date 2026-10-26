# Motion example

An inbox page whose animations each carry a fault that full-speed viewing does not show. Each fault surfaces only through one of the bench's animation tools: a frame step, a group timeline, a pause before the motion, or the absence of an animation where a style changed.

Serve the folder and open it on the bench:

```
python3 examples/motion/serve.py 4720
bench({ action: 'start', connection: 'motion-demo', url: 'http://127.0.0.1:4720/' })
```

Keys 1 to 4 press the four controls, so a sequence drives them with `input press`.

## Answer key

| Key | Control | Fault | Tool that shows it |
|---|---|---|---|
| 1 | New mail | The badge's `pop` keyframes dip to `scale(0.6)` between 50% and 55%, about 15ms, one frame at 60Hz. | Frame step through the 300ms animation. |
| 2 | Save | Frame 0 paints the toast at full opacity before it fades in, a one-frame flash. A 700ms timer then fades it out while its 1000ms fade-in is part-way, so it never reaches full opacity. | Pause before motion, then frame step from 0ms; the timer fires only while JS runs, so a held group shows the fade-in uninterrupted. |
| 3 | Folders | The panel animates `width` along with `transform`, which lays the page out on every frame. Of the five folder items, the third eases in where the others ease out, and the fifth starts at 260ms where the stagger puts it at 160ms. | Group timeline of the 13 animations the press starts. |
| 4 | Remove | `.row.removing` sets `transition: none`, so the row's height, margin and opacity change with no animation and the row snaps out. | The step changes styles and starts no animation. |

## Catalog page

`catalog.html` holds the range of motion a real site carries, so a model of motion is tested against more than CSS transitions started by a press. Each row pairs a driver with a mechanism. Rows marked clean carry no fault, so a detector that flags them has a false positive.

```
bench({ action: 'start', connection: 'motion-catalog-page', url: 'http://127.0.0.1:4720/catalog.html' })
```

The carousel and the canvas start at page load and run for the whole session. `?ambient=off` leaves both stopped and the marquee still, for a sequence that judges another row without background motion.

| Key | Use | Driver | Mechanism | Fault |
|---|---|---|---|---|
| q | Feedback: Like | press | Web Animations `animate()` on `#heart` | A second press within 400ms starts a new burst over the first without cancelling it; the scale jumps back to 1. |
| w | Feedback: switch | press | CSS transition on `::after` | Clean. A second press mid-way reverses from the current point. |
| e | State change: Details | press | JS frame loop writing `height` | No `Animation` object exists. A press mid-way restarts from the full or empty height, so the panel jumps. `height` lays out every frame. |
| r | State change: tabs | press | View Transitions | Clean. The ink and the pane cross-fade through pseudo-elements on the document. |
| t | State change: Compose | press | CSS keyframes on open | Close removes the class and the modal snaps out with no exit motion. |
| y | Waiting: Load messages | network, 60ms reply | CSS keyframes spinner and shimmer | The spinner shows with no delay threshold, so a fast reply flashes it for a few frames. The 36px skeleton rows give way to 56px rows, shifting the layout. |
| u | Waiting: Sync | network, 1.6s stream | CSS transition on `transform`, driven by bytes read; SVG stroke | Clean. The bar follows the bytes and the check draws when the stream ends. |
| i | Waiting: Send | network, 500 after 0.9s | CSS keyframes spinner | The failure path never hides the spinner; it spins beside "Failed to send". |
| o | Attention: Join with no `@` | press | CSS keyframes shake | The class is added and never removed, so a second invalid press shakes nothing. |
| p | Data change: Newest first | press | Web Animations FLIP | The measure loop starts at index 1, so Monday has no starting position and jumps to the bottom while the rest slide. |
| a | Data change: Count | press | JS timer writing text | No visual property moves. The count divides by `steps + 1` and ends at 1248, not 1280. |
| s | Data change: Live | network push, Server-Sent Events every 1.5s | CSS keyframes on each new item | Each item slides in, and the items below it jump down with no motion. The stream outlives the press by 6s. |
| g | Gesture: Quick reply sheet | press, or drag on the handle | JS spring in a frame loop; drag writes `transform` per pointer move | A drag released more than 120px down snaps the sheet shut. A release short of that springs back with an overshoot by design. |
| — | Pointer: card | hover | CSS transition | Clean. |
| k | Ambient: carousel | page load, then a 3s interval | CSS transition stepped by a timer | It keeps turning with the tab hidden and under `prefers-reduced-motion: reduce`. |
| — | Ambient: marquee | page load | CSS keyframes, infinite | Clean. It stops under reduced motion. |
| — | Ambient: sky | page load | Canvas in a frame loop | No DOM motion; pixels only. Every 120th frame runs a 90ms busy loop, so frames drop every two seconds. |
| — | Load: hero title | page load | CSS keyframes with a 100ms delay | Clean. |
| — | Scroll: top bar, three reveal cards | scroll position | CSS `animation-timeline: scroll()` and `view()` | Clean. These move with scroll position, with no time axis. |
| — | Scroll: hero background | scroll position | JS scroll listener writing `transform` | Clean. |
| — | Scroll: masthead | scroll position | JS scroll listener writing `height` | `height` lays out on every scroll event. |
| — | Scroll: Labels card | scroll position | IntersectionObserver, then a CSS transition | The reveal waits 400ms after the card enters, so it arrives after the scroll has stopped. |
| c | Waiting: Refresh | network, 600ms reply | Spinner after a 300ms threshold; list dims and swaps rows of equal height | Clean. The correct counterpart to Load messages. |
| v | Waiting: Refresh cached | network, 60ms reply | Same as Refresh | Clean. The reply beats the threshold, so no spinner shows. |
| b | Feedback rolled back: Star | press, then a 409 after 0.5s | CSS transition on colour and `transform` | The star fills at once and reverts when the server refuses, but the starred count keeps its increment: the end state is wrong. |
| n, m | Waiting: Search archive, Cancel | network, 2s reply, aborted | CSS keyframes spinner | Clean. Cancel aborts the fetch and the spinner stops. |
| d | Ambient started by a press: Typing | press, then every frame until pressed again | JS frame loop scheduling a fresh closure each frame | Clean. Function identity cannot tie one frame to the next, so the loop reads as a chain of one-shots. |
| f | Exit before removal: notices | press | CSS transition, removal on `transitionend` | The second notice has no `opacity` transition, so the `transitionend` the removal waits on never fires; it stays as an invisible gap. Press `f` twice to reach it. |
| h | Chain: Take the tour | press | Web Animations, each step awaiting `finished`, with 300ms timers between | Clean. Five animations in sequence, each started by the previous one ending. |
| j, l, z, x | Played by the app: Back up, Pause, Faster, Cancel | press | Web Animations on an SVG stroke, with the page calling `pause()`, `play()`, `updatePlaybackRate(4)` and `reverse()` | Clean. The app's own control of the animation runs alongside devharness's control of page time. |
| 5 | Shadow DOM: drafts chip | press | CSS keyframes inside an open shadow root | Clean. |
| 6 | Iframe: outbox | press | CSS transition in a `srcdoc` iframe, its own document | Clean. |
| / | Cross-document: Open message | navigation | `@view-transition { navigation: auto }` on both pages | Clean. `/` on `catalog-detail.html` comes back. |
| 7 | Platform: Settings | press | `<dialog>` with `@starting-style` and `allow-discrete` on `display` and `overlay` | Clean. Enters and exits, where Compose snaps out. |
| 8 | Platform: Menu | press | Popover with `@starting-style` | Clean. |
| 9 | Platform: FAQ | press | `<details>` with `interpolate-size` and `::details-content` height | Clean. Animates to `height: auto`. |
| 0 | Platform: Premium | press | CSS keyframes on a registered custom property (`@property --angle`) | Clean. The gradient turns; no geometry moves. |
| ; | Platform: Archive | press | CSS `offset-path` | Clean. The plane follows a curve and fades. |
| ' | Platform: Preview | press | CSS transition on `clip-path` | Clean. |
| , | Platform: Move dot | press | SVG SMIL `<animate>` | Clean. SMIL runs outside the CSS and Web Animations models. |
| . | Platform: Jump to Labels | press | `scrollIntoView({ behavior: 'smooth' })` and `scrollTo` | Clean. The page itself moves, which drives every scroll row above. |

| [ | Media: Play promo | press | `<video>` of `media/promo.webm`, 3s, looping | Clean. Pixels only; the element never moves. |
| ] | Media: Play envelope | press, after an XHR for `media/envelope.json` | lottie-web's SVG renderer, writing SVG `transform` attributes each frame | Clean. No CSS or Web Animations object exists. |
| - | Media: Spin | press, then every frame until pressed again | WebGL in a frame loop | Clean. Pixels only, drawn on the GPU. |
| = | Library: Plans | press | GSAP timeline on its own frame ticker, writing inline styles | The highlight moves by animating `left`, which lays out every frame, where GSAP's `x` would use a transform. |

`vendor/` holds GSAP 3.15.0 (GreenSock standard no-charge license) and lottie-web 5.13.0 (MIT, the SVG-only `lottie_light` build), copied from npm so the page loads with no network beyond the demo server. `media/promo.webm` is ffmpeg's `testsrc2` pattern. `media/envelope.json` is a hand-written Lottie file: one rectangle travelling and turning over 60 frames at 30fps.

Not covered: an animated GIF or WebP, and a spring library (react-spring, Motion's JS springs).

## Capability matrix

`matrix.json` holds every scenario on both pages against each capability of the workbench loop: seen, row placement, solo, hold and step, slow, snapshot crop, text flag, tune, and viewport and environment. Each cell carries what devharness is expected to do and how that stands today: works, gap, unmeasured or n/a, with its basis, `code` or `sequence:<name>`. A cell reads works only on a sequence basis. Defaults are written once per mechanism and per capability, and a scenario carries only what differs.

`matrix.html` renders it as a grid filtered by page, trigger, mechanism and standing: `http://127.0.0.1:4720/matrix.html`.
