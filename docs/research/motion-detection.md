# Detecting and tracing motion that has no Animation object

This survey covers how existing tools notice and trace on-screen motion that does not run through an `Animation` object: JS writing styles each frame (GSAP, Motion, react-spring, hand-written `requestAnimationFrame` loops), SVG attribute writes (lottie-web), canvas and WebGL, video, SVG SMIL, smooth scrolling, and a style change that should have animated and did not. Each section names an approach, what it depends on, and where it stops. The last section maps the findings onto `examples/motion/matrix.json`.

Every claim cites a URL. Claims marked **(from memory)** were not confirmed against a source during this survey.

## 1. Tools built on the Animation model

**What they are.** Chrome DevTools' Animations panel "supports CSS animations, CSS transitions, web animations, and the View Transitions API", and states "`requestAnimationFrame` animations are not yet supported" ([Chrome DevTools: Animations](https://developer.chrome.com/docs/devtools/css/animations)). It groups animations by start time, scrubs a group, and edits duration, keyframe offsets and delay (same source). Firefox's Animation inspector covers CSS transitions, `@keyframes` and Web Animations, including on `::before`/`::after`. A lightning bolt marks properties running on the compositor ([Firefox source docs](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)). WebKit's Graphics tab, which replaced the Canvas tab in Safari Technology Preview 100, lists Web Animation objects alongside canvases ([STP 100 notes](https://webkit.org/?p=10024), [WebKit bug 205434](https://bugs.webkit.org/show_bug.cgi?id=205434), [WWDC 2020 session 10663](https://developer.apple.com/jp/videos/play/wwdc2020/10663/?time=1194)).

**What holds them up.** The CDP `Animation` domain types each animation as one of `CSSTransition`, `CSSAnimation` or `WebAnimation`. It emits `animationCreated`, `animationStarted`, `animationUpdated` and `animationCanceled`, and offers `setPlaybackRate` ("Sets the playback rate of the document timeline"), `setTiming`, `seekAnimations`, `setPaused` and `resolveAnimation` ([Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)). Every entity these tools show is an `Animation` with an effect, a target and timing.

**Where they stop.** The type enum has no member for a frame-callback loop, an SVG SMIL element, a media element, a smooth scroll or a canvas. Those mechanisms produce no `animationCreated` event and are not governed by the document-timeline rate.

Two other tools rely on the same model:
- **Motion DevTools** ("Inspect, edit and export animations made with CSS and Motion One", version 2.0.0, last updated June 8, 2023, per the [Chrome Web Store listing](https://chromewebstore.google.com/detail/motion-devtools/mnbliiaiiflhmnndmoidhddombbmgcdk)). It does not claim to cover Motion's JS-driven values.
- **Playwright's `animations: 'disabled'`.** It iterates `root.getAnimations()` across the document and its shadow roots. It calls `finish()` on finite animations and `cancel()` on infinite ones, and listens for `transitionrun` and `animationstart` to catch new ones. The source has no video or SMIL handling ([screenshotter.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/screenshotter.ts)).

## 2. DOM mutation recording: rrweb and session replay

**Mechanism.** rrweb records with a `MutationObserver` using `attributes: true, attributeOldValue: true` over the subtree. It also patches `CSSStyleDeclaration.prototype.setProperty` and `removeProperty` with Proxies to emit `StyleDeclaration` events ([observer.ts](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/rrweb/src/record/observer.ts)). Its incremental sources include `Mutation`, `Scroll`, `MediaInteraction`, `StyleSheetRule`, `CanvasMutation` and `StyleDeclaration` ([types/index.ts](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/types/src/index.ts)).

**Why inline style writes are visible.** In CSSOM, setting `el.style.left` invokes `setProperty()`. When the declaration block has an owner node, that runs "update style attribute for", which sets the `style` content attribute to the serialized block ([CSSOM](https://drafts.csswg.org/cssom/)). The page therefore produces a `style` attribute mutation record for every per-frame inline write: GSAP writing inline styles, Motion's JS path, react-spring, and hand-written loops. lottie-web's SVG renderer writes `transform` attributes each frame (per `examples/motion/README.md`), which also produce attribute records. One observer therefore sees every DOM-writing driver, whatever library runs it.

**Media.** rrweb listens for `play`, `pause`, `seeked`, `volumechange` and `ratechange`. On each it records `currentTime`, `volume`, `muted`, `playbackRate` and `loop`, throttled by `sampling.media` (default 500 ms) ([observer.ts](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/rrweb/src/record/observer.ts)). Playback between those events is not sampled.

**Canvas and WebGL.** Canvas is not recorded by default ([canvas recipe](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/docs/recipes/canvas.md)). With `recordCanvas: true` there are two modes ([canvas-manager.ts](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/rrweb/src/record/observers/canvas/canvas-manager.ts)):
- **Commands:** patches the 2D and WebGL contexts and flushes one batch of commands per canvas per animation frame, stamped with a rAF id.
- **Bitmaps:** at a numeric `sampling.canvas` FPS, takes `createImageBitmap(canvas)` on a rAF loop and encodes it in a worker. For WebGL without `preserveDrawingBuffer` the code has a workaround comment: "Preferably we set `preserveDrawingBuffer` to true, but that's not always possible".

`CanvasContext` covers `2D`, `WebGL` and `WebGL2` ([types](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/types/src/index.ts)). Sentry's replay SDK makes canvas opt-in through `replayCanvasIntegration()` and blocks media by default (`blockAllMedia: true`) ([Sentry docs](https://docs.sentry.io/platforms/javascript/session-replay/)).

**Scroll.** Scroll events are recorded, with a configurable minimum interval (example: 150 ms) ([optimize-storage recipe](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/docs/recipes/optimize-storage.md)). A smooth scroll arrives as a throttled series of offsets.

**Where it stops.**
- The record holds attribute values, not computed values. A class toggle records only the `class` attribute. Whether a transition followed is left to the stylesheet when the replayer rebuilds the DOM.
- **(From memory)** rrweb replays CSS transitions and keyframes by letting the replay iframe's styles run them again, not from recorded frames. A missing transition is reproduced, not flagged.
- Mutation records carry no attribution to the script or frame callback that caused them. **(From memory)** MutationObserver delivers records as a microtask batch with no stack.
- SMIL changes the animated value, not the attribute. **(From memory)** SMIL produces no attribute mutation, so rrweb records nothing for it.

The CDP equivalent of the observer is `DOM.attributeModified` (node id, name, value) and `DOM.characterDataModified`. `DOM.setNodeStackTracesEnabled`/`getNodeStackTraces` give stacks for node creation only ([DOM.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl)).

## 3. Computed-style tracking through CDP

The CSS domain has experimental computed-style tracking ([CSS.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/CSS.pdl)):
- `trackComputedStyleUpdates(propertiesToTrack)` with `takeComputedStyleUpdates()`, which "Polls the next batch" and returns node ids whose tracked computed properties changed. It applies only to "nodes pushed to the front-end by the DOM agent".
- `trackComputedStyleUpdatesForNode(nodeId)`, which emits a throttled `computedStyleUpdated` and tracks one node at a time.

This reads the result of the cascade, not its cause. It therefore reports a change from any source:
- an inline write;
- a class toggle with `transition: none`;
- a CSS animation;
- a scroll-driven animation.

It returns node ids only. The values must be read again with `CSS.getComputedStyleForNode` **(from memory: that command exists in the same domain)**. Canvas, WebGL and video change pixels, not computed style, so they do not appear.

## 4. Execution recording: Replay.io

Replay records "the inputs to the runtime, so replaying the recording re-runs exactly the same execution". The recording boundary is the API between the browser executable and the system libraries it links to ([Replay docs: time travel](https://docs.replay.io/basics/time-travel/how-does-time-travel-work), [How Replay works](https://www.replay.io/blog/how-replay-works), [How to time travel every time](https://www.replay.io/blog/how-to-time-travel-every-time)). "Everything you see in Replay DevTools is computed at replay time and not record time", including the video of the session (docs, same page). The aim is "effective determinism": JS state and DOM contents match the recording, while lower-level details may differ ([Effective determinism](https://blog.replay.io/effective-determinism)).

**What holds it up.** Any style write, attribute write or canvas call from any frame callback can be examined after the fact, because the execution is re-run rather than summarized.

**Where it stops.** The pages fetched do not describe how paints, the compositor, canvas, WebGL, video decoding or smooth scroll are reproduced. Motion that runs outside JS, on the compositor or the media pipeline, has no stated treatment. Replay requires its own recording browser (same docs).

## 5. Performance traces: DevTools Performance panel and Lighthouse

**Animations track.** Animations are named by CSS property or element. Non-compositing ones carry a red triangle and list their compositing failure reasons ([Performance reference](https://developer.chrome.com/docs/devtools/performance/reference)). Lighthouse's `non-composited-animations` audit reads trace `Animation` events and pairs a begin (`ph: 'b'`) with a status (`ph: 'n'`) by `id2.local`. From the status event it takes `args.data.compositeFailed` and `unsupportedProperties`, plus `nodeId` from the begin event ([trace-elements.js](https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/gather/gatherers/trace-elements.js)). It reports six actionable bits from the mask, including "Unsupported CSS property" (`1 << 13`) ([non-composited-animations.js](https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/core/audits/non-composited-animations.js)).

These events exist only for `Animation` objects. A GSAP tween or a rAF loop writing `left` produces no `Animation` event, so the audit cannot report it.

**What does show non-Animation motion in a trace:**
- **Main track, per frame:** rAF callbacks followed by Recalculate Style and Layout. Initiator arrows link "Style or layout invalidation -> Recalculate styles or Layout" ([Performance reference](https://developer.chrome.com/docs/devtools/performance/reference)). A `Layout` event in every frame, initiated by a script, is the trace signature of a JS loop animating a layout property. The pipeline reference states that changing geometry "width, height, or its position" runs layout, paint and composite ([web.dev rendering performance](https://web.dev/articles/rendering-performance)).
- **Invalidation tracking:** the `disabled-by-default-devtools.timeline.invalidationTracking` category gates style-invalidation events ([StyleInvalidator.cpp](https://chromium.googlesource.com/chromium/blink/+/HEAD/Source/core/css/invalidation/StyleInvalidator.cpp)). Chromium added schedule-invalidation events carrying a stack trace in 2015 ([review 731293006](https://codereview.chromium.org/731293006)). Whether current DevTools still exposes this was not confirmed.
- **Forced reflow insight:** flags JS that forces layout recalculation and shows the call stack ([Performance insights](https://developer.chrome.com/docs/performance/insights), [Insights sidebar](https://developer.chrome.com/blog/devtools-insights-sidebar)).
- **Frames track:** shows dropped frames and partially presented frames ([Performance reference](https://developer.chrome.com/docs/devtools/performance/reference)). This is the frame-level view of a canvas loop that stalls.
- **Screenshots:** with Screenshots enabled the panel captures "a screenshot of every frame while recording" (same source). This is the only trace data that holds canvas, WebGL and video motion.
- **Layout shifts track:** shows shifts as purple diamonds with culprit elements (same source). The Layout shift culprits insight names "the DOM elements responsible for unexpected movement" ([Performance insights](https://developer.chrome.com/docs/performance/insights)).

**Where it stops.** A trace attributes cost to scripts and frames. It does not label a sequence of style writes as one motion with a start, an end and a property curve. Recovering that requires joining invalidation events, initiators and screenshots.

## 6. Web performance observers in the page

**Long Animation Frames (LoAF).**
- A frame is reported when its duration exceeds 50 ms ([LoAF spec](https://raw.githubusercontent.com/w3c/long-animation-frames/main/index.bs)).
- Each entry has `renderStart`, `styleAndLayoutStart`, `blockingDuration` and `scripts` ([Chrome: LoAF](https://developer.chrome.com/docs/web-platform/long-animation-frames)).
- Each `PerformanceScriptTiming` carries:
  - `invoker` and `invokerType`; rAF callbacks are `user-callback`, example invoker `Window.requestAnimationFrame`;
  - `sourceURL`, `sourceFunctionName` and `sourceCharPosition`;
  - `forcedStyleAndLayoutDuration`;
  - in the spec, `forcedStyleDuration` and `forcedLayoutDuration` (same sources).
- Scripts under 5 ms are omitted (spec), and the spec does not report which elements a script wrote.

LoAF identifies a frame loop that blocks, such as the catalog's 90 ms busy loop every 120 frames. It does not identify a loop that writes `left` cheaply each frame.

**Layout Instability.**
- A node is unstable when its starting point moves, checked "both with and without transforms". A transform-only change does not shift.
- Each entry attributes up to five sources with `node`, `previousRect` and `currentRect`. Its value is the impact fraction times the distance fraction.
- `hadRecentInput` is true within 500 ms of excluding input ([Layout Instability spec](https://wicg.github.io/layout-instability/)).
- Shifts within 500 ms of a discrete input "will have the hadRecentInput flag set"; scrolls and drags are not counted as recent input ([web.dev CLS](https://web.dev/articles/cls)).

The API reports where a box moved between two frames, from any driver: a JS loop animating `height`, a class toggle that snaps, or skeleton rows replaced by taller rows. It does not report opacity, colour, transform or pixel motion. A shift caused by a press is still emitted, but carries `hadRecentInput: true`.

**PerformanceObserver** is the delivery mechanism for both entry types. No entry type reports style writes or computed-style changes; that statement covers the entry types in the sources above.

## 7. Time virtualization

These tools control motion by owning the time sources a page reads. In doing so they define which motion counts as time-driven.

- **Playwright `page.clock`** overrides `Date`, `setTimeout`/`setInterval`, `requestAnimationFrame`, `requestIdleCallback`, `performance` and `Event.timeStamp`. It offers `install`, `pauseAt`, `runFor` and `fastForward` ([Playwright clock](https://playwright.dev/docs/clock)). The page says nothing about CSS animations or media.
- **timesnap** overrides time functions to "record snapshots at virtual times". Pages with CSS transitions or animations "will likely not render as intended" ([timesnap](https://github.com/tungs/timesnap)).
- **timeweb** extends the same approach to more drivers ([timeweb](https://github.com/tungs/timeweb)):
  - CSS and Web Animations: detects new ones through `transitionstart` and `animationrun` listeners, `document.getAnimations` and an override of `Element.prototype.animate`, then "pauses the animations and seeks when needed".
  - Video and SVG: detects elements through a mutation observer and a `document.createElement` override, then "pauses those elements and seeks when needed".
  - Stated failures: iframes, `event.timeStamp` and audio analyser nodes.
- **CDP `Emulation.setVirtualTimePolicy`** replaces real time with a synthetic base, with policies `advance`, `pause` and `pauseIfNetworkFetchesPending` ([Emulation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Emulation.pdl)).
- **CDP `HeadlessExperimental.beginFrame`** "Sends a BeginFrame to the target and returns when the frame was completed". It takes `frameTimeTicks` and `interval` and returns `hasDamage` and an optional screenshot ([HeadlessExperimental.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl)). `hasDamage` is a per-frame bit telling whether anything on screen changed, whatever drove it.

**Where it stops.**
- JS-level overrides govern only what reads JS time. Media and SMIL have their own clocks and need explicit pause and seek, as timeweb does.
- Programmatic smooth scroll in Chromium is a compositor curve whose duration is "proportional to scroll delta; used for programmatic scrolls" ([scroll_offset_animation_curve.h](https://chromium.googlesource.com/chromium/src/+/a753229/cc/animation/scroll_offset_animation_curve.h)). No source surveyed states whether JS time overrides or `setVirtualTimePolicy` govern it.

## 8. Library-level inspection and control

Each library exposes its own timeline or loop, and that is the only place its motion exists as an object.

- **GSAP.** `gsap.ticker` updates the global timeline on each `requestAnimationFrame`, falls back to `setTimeout` without rAF, and applies `lagSmoothing` (500 ms threshold, 33 ms adjusted lag by default) ([gsap.ticker](https://gsap.com/docs/v3/GSAP/gsap.ticker/)). **GSDevTools** scrubs "every animation on the global timeline" or one passed `animation`, with in/out markers and timeScale. It does not work with ScrollTrigger-driven animations or with other libraries, because it "depends on some unique capabilities baked into the GSAP architecture" ([GSDevTools docs](https://gsap.com/docs/v3/Plugins/GSDevTools)).
  - Lag smoothing means a page clock that jumps more than 500 ms between ticks advances GSAP by only 33 ms. **(Inference from the cited defaults.)**
- **Motion.**
  - Runs animations "either via `requestAnimationFrame` or via the Web Animations API"; independent transforms such as `x` cannot run on WAAPI ([Motion: WAAPI improvements](https://motion.dev/docs/improvements-to-the-web-animations-api-dx)).
  - Motion values on the WAAPI path appear in the Animation domain; those on its JS path do not.
  - Its `frame` loop batches `read`, `update` and `render` steps on one rAF ([Motion: frame](https://motion.dev/docs/frame)).
  - `MotionGlobalConfig` has options to skip animations, make them instant and use manual timing ([global-config.ts](https://raw.githubusercontent.com/motiondivision/motion/main/packages/motion-utils/src/global-config.ts)). `MotionConfig`'s `skipAnimations` sets values instantly ([Motion React config](https://motion.dev/docs/react-motion-config)).
- **react-spring.** Coordinates rAF through `rafz`, which allows swapping the rAF implementation (`raf.use`) and a `frameLoop` of `'demand' | 'always'` ([rafz README](https://raw.githubusercontent.com/pmndrs/react-spring/main/packages/rafz/README.md)). Spring state lives in the library and reaches the DOM as style writes.
- **lottie-web.** Offers `pause`, `goToAndStop(value, isFrame)`, `setSpeed` and the global `lottie.freeze()`. `setSubframe(true)` updates "on every requestAnimationFrame with intermediate values" ([lottie-web wiki](https://github.com/airbnb/lottie-web/wiki/Usage)). An `enterFrame` event fires per frame (same source).
- **Visual testing practice.** Chromatic pauses CSS animations and videos itself, but "won't disable [JS animations] by default". It recommends `isChromatic()` with `MotionGlobalConfig.skipAnimations` ([Chromatic animations](https://www.chromatic.com/docs/animations/)). This is the industry position that JS motion needs cooperation from the library.

**Where it stops.** Each hook covers one library and needs page-side code or an injected global. None reports motion from another driver.

## 9. Pixel and media sources

These sources cover motion with no DOM write at all: canvas, WebGL and video.

**Screens and screenshots.**
- `Page.startScreencast` delivers frames with `everyNthFrame`, and each frame's metadata includes `scrollOffsetX`, `scrollOffsetY` and a frame-swap `timestamp` ([Page.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)). That gives a per-frame scroll offset for smooth scroll without reading the DOM.
- `Page.captureScreenshot` takes a `clip` (same source).

**Frame comparison.** speedline computes visual progress as "the distance between the histogram of the current frame and the final frame", and has an SSIM variant, read from DevTools trace screenshots ([speedline](https://github.com/paulirish/speedline)). This is the established method for measuring change between frames when nothing is known about the driver.

**Canvas and WebGL commands.**
- Spector.js records the WebGL command list and state for one frame, by injection on request or `spyCanvases` ([Spector.js extension docs](https://github.com/BabylonJS/Spector.js/blob/release/documentation/extension.md)).
- WebKit's Web Inspector records 2D, WebGL and WebGL2 actions per canvas ([WebKit canvas debugging](https://webkit.org/?p=8452), [WebGL2 recording commit](https://webkit.googlesource.com/WebKit/+/b83074ad1a9a4c31949d33d83371c0a2ab121dab%5E%21/LayoutTests/TestExpectations)).
- rrweb's command mode (section 2) does the same in-page.

**Video.**
- `requestVideoFrameCallback` runs per presented frame with `mediaTime`, `presentedFrames` (for missed-frame detection) and `expectedDisplayTime` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)).
- The experimental CDP `Media` domain emits `playerCreated`, `playerPropertiesChanged` and `playerEventsAdded` per media player ([Media domain reference](https://cdpstatus.reactnative.dev/devtools-protocol/tot/Media)).

**Overlays.** `Overlay.setShowPaintRects`, `setShowLayoutShiftRegions` and `setShowFPSCounter` draw on the page ([Overlay.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Overlay.pdl)). They show regions as pixels in a screenshot and return no data.

## 10. Mechanism notes

- **SVG SMIL.**
  - `SVGSVGElement.pauseAnimations()` stops "the animation clock corresponding to this document fragment". `setCurrentTime`, `getCurrentTime` and `animationsPaused` complete the API ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SVGSVGElement/pauseAnimations)).
  - SMIL is absent from the Animation domain's type enum ([Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)) and from Playwright's disable path ([screenshotter.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/screenshotter.ts)).
  - timeweb is the only surveyed tool that handles SVG time ([timeweb](https://github.com/tungs/timeweb)).
  - **(From memory)** `document.getAnimations()` does not return SMIL animations.
- **Smooth scroll.**
  - In Chromium, programmatic smooth scroll is a `ScrollOffsetAnimationCurve`. Its duration is proportional to the distance for programmatic scrolls and constant for keyboard scrolls; the CSSOM View spec leaves the size-to-duration relation to user agents ([curve header](https://chromium.googlesource.com/chromium/src/+/a753229/cc/animation/scroll_offset_animation_curve.h), [older curve source](https://mojo.googlesource.com/mojo/+/0c0edc5df38af2f322eb384a922613a48fd714dc/cc/animation/scroll_offset_animation_curve.cc)).
  - `scrollend` fires when "the scroll position has no more pending updates", including smooth scrolling, and does not fire if the position did not change ([MDN scrollend](https://developer.mozilla.org/en-US/docs/Web/API/Document/scrollend_event)).
  - The traceable boundaries are therefore the first `scroll` event, the per-frame offsets (screencast metadata or `scroll` events) and `scrollend`.
- **Canvas/WebGL** have no DOM trace. The choices are command capture (section 9), pixel capture, or ownership of the rAF that drives them (section 7).

## 11. Motion that should have happened and did not

A transition starts only when all of these hold: a matching `transition-property`; before-change and after-change values that differ and are transitionable; and a combined duration greater than 0 s. Otherwise "the transition is immediate (i.e. there will be no animation)". `transitionrun` fires when a transition is created, before its delay ([CSS Transitions](https://drafts.csswg.org/css-transitions-1/)).

**Finding: no surveyed tool flags a style change that started no animation.**
- The Animations panels, Lighthouse and Motion DevTools list animations that exist.
- rrweb and Replay reproduce the snap.
- Layout Instability reports the geometry jump, but a jump caused by a press within 500 ms is marked `hadRecentInput: true` ([spec](https://wicg.github.io/layout-instability/)). Opacity and colour snaps are not reported at all.
- Chromatic and Playwright suppress animation rather than detect its absence.

The primitives that make the absence observable all exist:
- a computed-style change on a node: `CSS.trackComputedStyleUpdates`, or a before/after read of computed style;
- the absence, in the same frame, of an animation on that node and property: no `transitionrun`/`animationstart`, no `Animation.animationCreated`, or nothing new in `getAnimations()`;
- the property's class (layout, paint or composite) from the pipeline reference ([web.dev](https://web.dev/articles/rendering-performance)).

The CSS Transitions spec's start conditions also explain why no transition ran:
- `transition-property` did not match;
- the combined duration was 0;
- the property is not transitionable, for example `display` without `allow-discrete` **(from memory: `transition-behavior: allow-discrete`, not covered in the fetched excerpt)**.

## 12. Mapping onto the matrix

The matrix capabilities are seen, row, solo, hold, slow, crop, flag, tune and env. The mechanisms in question are `frame-loop`, `timer-text`, `scroll-listener`, `smooth-scroll`, `canvas`, `webgl`, `video`, `smil`, `lottie` and `gsap`, plus the no-motion cases `remove`, `compose` and `newest`.

**Seen.**
- Every driver that writes the DOM produces a `style` or attribute mutation through CSSOM's style-attribute update (section 2): `frame-loop` (details, sheet), `scroll-listener` (parallax, masthead), `gsap` (plans), `lottie` (envelope) and `timer-text` (count, as character data). The CDP form is `DOM.attributeModified`/`characterDataModified`, and the cascade-level form is `CSS.trackComputedStyleUpdates` (section 3). These are the sources the matrix's "The record listens to the Animation domain only" notes point to.
- `smil` (dot) changes no attribute; it is seen through `SVGSVGElement.getCurrentTime()` and `animationsPaused()` per SVG root.
- `video` (promo) is seen through media events, `currentTime` and `requestVideoFrameCallback`, or the CDP Media domain.
- `canvas`/`webgl` (sky, spin) are seen only as pixels, as context calls (Spector.js and rrweb's patch approach), or as the rAF callback that draws them.
- `smooth-scroll` (jump) is seen as `scroll` events to `scrollend`, or as screencast `scrollOffsetY` per frame.

**Row.** Attribution of a style write to a press step needs the frame or callback that wrote it.
- LoAF supplies `invoker` and `sourceURL` only for scripts ≥5 ms in frames >50 ms.
- Trace initiators supply it for every frame, but only during a trace.
- rrweb's canvas manager shows the in-page pattern: stamp each write with the current rAF id ([canvas-manager.ts](https://raw.githubusercontent.com/rrweb-io/rrweb/HEAD/packages/rrweb/src/record/observers/canvas/canvas-manager.ts)).
- The `typing` scenario's fresh closure per frame matches the matrix note that function identity cannot link frames.

**Hold and slow.**
- Time virtualization covers rAF and timers (`frame-loop`, `gsap`, `lottie`, `canvas`, `webgl`, `timer-text`).
- GSAP's `lagSmoothing` (500 ms/33 ms) changes how a jump in page time reaches a GSAP timeline.
- `video` and `smil` need their own pause and seek (`pause()`/`currentTime`/`playbackRate`; `pauseAnimations()`/`setCurrentTime()`), as timeweb does. This matches the matrix gaps for both.
- `smooth-scroll` runs as a compositor curve. No source settles whether page time governs it, which matches the matrix's "unmeasured".

**Solo.** Per-library controls (GSDevTools' `animation`, lottie's per-instance `pause`, `SVGSVGElement.pauseAnimations()` per fragment, `HTMLMediaElement.pause()`) isolate within one mechanism only. No surveyed tool freezes all mechanisms but one.

**Crop.** Layout Instability's `previousRect`/`currentRect` give the boxes a shift occupied, up to five sources. That covers the "elements it shifted" half of the crop rule for `live`, `load`, `details` and `remove`. Screencast and `captureScreenshot` `clip` carry the crop itself.

**Flag.**
- "Lays out every frame" (`plans` writing `left`, `masthead`, `details`, the folders panel's `width`) appears in a trace as a script-initiated Layout per frame. For Animation objects only, it appears in Lighthouse's `compositeFailed` mask. The property class comes from the pipeline reference.
- The `sky` busy loop is a LoAF entry with its `sourceURL`.
- `remove` and `compose` close are the section 11 case: a computed change with no `transitionrun` and no `animationCreated`. Layout Instability marks the row's neighbours with `hadRecentInput: true` because the press preceded it.
- `newest` (Monday jumps) is the same case per item in a set.
- `count`'s wrong end value needs only the final text, which `characterDataModified` supplies.

**Tune.** Only Animation objects take live timing (`Animation.setTiming`). For JS drivers, tuning lives in library parameters (GSAP timeline durations, lottie `setSpeed`, Motion config) or in source. LoAF's `sourceURL` and `sourceCharPosition` and trace stack traces are the surveyed ways to name the line.

**Env.**
- Layout Instability values are viewport-relative (impact and distance fractions), so the same shift scores differently across sizes.
- At 120 Hz, Chromium's `beginFrame` `interval` sets the frame spacing a virtual run reports to the compositor.
