# Motion time control: survey

How existing tools hold time deterministically, replay a moment, and change motion timing live with the change carried back to source. Each section states the mechanism, what supports it and where it stops, and how it treats the three clocks that sit outside page time: media, SVG SMIL, and scroll-driven timelines. The last section maps the findings onto `examples/motion/matrix.json`.

Every claim cites a URL. Claims marked *(memory)* were not confirmed against a fetched source. Claims marked *(inferred from source)* are read from engine or DevTools code and have not been run.

## 1. Chromium below the page: virtual time

### Emulation.setVirtualTimePolicy

`Emulation.setVirtualTimePolicy` is experimental. It switches every frame of the target to a synthetic time source and takes one of three policies: `advance`, `pause`, `pauseIfNetworkFetchesPending`. Its optional parameters are `budget` (virtual milliseconds to run before pausing again and firing `Emulation.virtualTimeBudgetExpired`), `maxVirtualTimeTaskStarvationCount` (tasks allowed to run before time is forced forward to prevent deadlock), and `initialVirtualTime` (the value `base::Time::Now` starts at). It returns `virtualTimeTicksBase`. A new call supersedes the previous budget. ([Emulation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Emulation.pdl))

What supports it:
- The scheduler jumps to the next delayed task when no immediate work is left, so timers run as fast as the CPU allows while the page sees time pass ([codereview 1424053002](https://codereview.chromium.org/1424053002)).
- Budget expiry is posted on the control task queue, the highest-priority queue, so it lands at the same point in every run ([codereview 2841463003](https://codereview.chromium.org/2841463003)).
- The `pause` policy waits for at least one loading task before advancing, so time cannot run ahead of the first fetch ([crrev 1c815652](https://crrev.com/1c815652bc24a83da99ca473d489accdeeafa435)).
- `--virtual-time-budget` exposes the same mechanism on the headless command line. Virtual time does not advance while network fetches are pending ([headless_shell_switches.cc](https://chromium.googlesource.com/chromium/src/+/b9b02e0537eac358b8facb9802e16adce590f0ea/headless/app/headless_shell_switches.cc)).
- Blink subsystems that wait on asynchronous work hold time with `WebScopedVirtualTimePauser`, an RAII helper ([web_scoped_virtual_time_pauser.h](https://crrev.com/7f65764097d0624640af0cac226377a8bc4bf66f/third_party/blink/public/platform/web_scoped_virtual_time_pauser.h)).

Where it stops:
- Frames are a separate axis. The original virtual time change says it "does not extend to RAF" ([codereview 1424053002](https://codereview.chromium.org/1424053002)). Chromium's own headless test helper pairs a paused policy with `HeadlessExperimental.beginFrame` calls, so it issues frames itself within each grant of virtual time ([virtual-time-controller.js](https://crrev.com/7e42384992ccc9874365ba5f28ae389d527d1401/headless/test/data/protocol/helpers/virtual-time-controller.js)).
- `HeadlessExperimental.beginFrame` takes `frameTimeTicks`, `interval` (default 16.666ms), `noDisplayUpdates` and `screenshot`, and returns `hasDamage`. It requires a target created with BeginFrameControl and is designed for `--run-all-compositor-stages-before-draw` ([HeadlessExperimental.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl)). `--deterministic-mode` is an experimental meta flag that turns on that setup ([headless_shell_switches.cc](https://chromium.googlesource.com/chromium/src/+/b9b02e0537eac358b8facb9802e16adce590f0ea/headless/app/headless_shell_switches.cc)). A headed browser does not offer BeginFrameControl *(memory)*. A third-party tool built on this pairing grants a budget, screenshots when the budget expires, then grants more ([deterministic-screenshots-chromium](https://github.com/rustyconover/deterministic-screenshots-chromium)).
- Blink's `AnimationClock`, which feeds the document timeline, reads a `TickClock` (`clock_->NowTicks()`) between frames and is fixed to the frame time within a rendering lifecycle. The file does not mention virtual time ([animation_clock.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/animation/animation_clock.cc)). Whether CSS and Web Animations follow virtual time in a headed, live session was not established here.
- No source found ties `HTMLMediaElement` to virtual time ([html_media_element.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/media/html_media_element.cc)). Media playback follows the media pipeline's own clock *(memory)*.

Bearing on devharness: virtual time drives the page as a whole and has no per-element control or speed setting. It answers "what state is the page in after N ms", not "show this one animation at 25%".

## 2. CDP Animation domain

### Commands and what the renderer does with them

The domain is experimental. It reports `animationCreated`, `animationStarted`, `animationUpdated` and `animationCanceled`, and offers `setPaused`, `seekAnimations`, `setTiming`, `setPlaybackRate`, `getPlaybackRate`, `getCurrentTime`, `releaseAnimations` and `resolveAnimation` ([Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)).

| Command | Parameters | Renderer behaviour ([inspector_animation_agent.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/inspector/inspector_animation_agent.cc)) |
|---|---|---|
| `setPlaybackRate` | `playbackRate` | Calls `Timeline().SetPlaybackRate(rate)` on the document of every inspected frame. Reapplied after a load commits; reset to 1 on `disable`. |
| `setPaused` | `animations[]`, `paused` | Captures the current time, calls `pause()`, restores the time. Unpause calls `Unpause()`. |
| `seekAnimations` | `animations[]`, `currentTime` or `currentTimes[]` | Plays a paused animation, clamps to the effect end, sets the current time. |
| `setTiming` | `animationId`, `duration`, `delay` | Calls `effect()->updateTiming()` in place, for CSS-created and script-created animations alike. |
| `resolveAnimation` | `animationId` | Returns a `Runtime.RemoteObject` for the `Animation`. |

The `Animation` type carries `type` (`CSSTransition`, `CSSAnimation`, `WebAnimation`), `source` (an `AnimationEffect` with delay, endDelay, iterations, duration, direction, fill, easing, target `backendNodeId`, keyframes), `cssId`, and `viewOrScrollTimeline` with `sourceNodeId`, `subjectNodeId`, `startOffset`, `endOffset` and `axis` ([Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)).

What supports it:
- `DocumentTimeline::SetPlaybackRate` recomputes the timeline's zero time so current time stays continuous across a rate change. At rate 0 it anchors to the current time. It marks compositor animations pending so they restart at the new rate ([document_timeline.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/animation/document_timeline.cc)). The rate therefore reaches animations running on the compositor thread, at the cost of a restart.
- `seekAnimations` with `currentTimes[]` places each animation of a group at its own time in one call.

Where it stops:
- `setTiming` changes only duration and delay. Easing, iterations, endDelay, direction and keyframes have no command ([Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)). A client can reach them by calling the Web Animations API's `effect.updateTiming({...})` or `effect.setKeyframes(...)` on the object `resolveAnimation` returns ([MDN updateTiming](https://developer.mozilla.org/en-US/docs/Web/API/AnimationEffect/updateTiming), [MDN setKeyframes](https://developer.mozilla.org/en-US/docs/Web/API/KeyframeEffect/setKeyframes)). Under CSS Animations Level 2, once script changes a CSS animation's timing, later style changes to those properties no longer override it *(memory)*. The live animation and the stylesheet can then disagree until the page reloads.
- The rate is per document timeline. Per-animation rate has no command, so "one plays, every other one holds" takes `setPaused` on the others.
- Only the three animation types are reported. `requestAnimationFrame` loops, timers, media, SMIL and canvas never appear ([DevTools Animations docs](https://developer.chrome.com/docs/devtools/css/animations)).
- The record only knows an animation once it is created. The answer key's `transition: none` row (index key 4) and the catalog's snap-outs leave no event to read.

### SMIL follows the document timeline in Blink

`SMILTimeContainer::Elapsed()` returns `GetDocument().Timeline().CurrentTimeInternal()` minus a reference time plus a presentation time. `Pause()`, `Unpause()` and `SetElapsed()` back `pauseAnimations()`, `unpauseAnimations()` and `setCurrentTime()` ([smil_time_container.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/svg/animation/smil_time_container.cc)). `DocumentTimeline` scales its current time by `playback_rate_` ([document_timeline.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/animation/document_timeline.cc)). So `Animation.setPlaybackRate` should slow and stop SMIL in Chromium as well, even though SMIL never appears in the Animation domain *(inferred from source)*. SMIL wakes on an internal timer, not `window.setTimeout`, so a script-level page clock does not own its scheduling. Its values are still computed from the document timeline at each wake *(inferred from source)*. The platform API stops all animations in one `<svg>` fragment and is not per element ([MDN pauseAnimations](https://developer.mozilla.org/en-US/docs/Web/API/SVGSVGElement/pauseAnimations)).

## 3. Chrome DevTools Animations panel, Workspaces, Changes

### What the panel does

- It captures CSS animations, CSS transitions, Web Animations and View Transitions, grouped by start time. It does not capture `requestAnimationFrame` animations ([docs](https://developer.chrome.com/docs/devtools/css/animations)).
- The speed buttons are `GlobalPlaybackRates = [1, 0.25, 0.1]`, with 0 labelled Pause ([AnimationTimeline.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/panels/animation/AnimationTimeline.ts)). The model sends them through `Animation.setPlaybackRate`, so they act on the whole document ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts)).
- Replay calls `group.seekTo(0)`, which is `seekAnimations` with per-animation `currentTimes`. Replay is disabled for scroll-driven groups ([AnimationTimeline.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/panels/animation/AnimationTimeline.ts)). A replay rewinds the captured `Animation` objects. It does not repeat the input that started them, so a timer or a script `animate()` call never runs a second time.
- Pause per group is `setPaused` over that group's ids ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts)).
- Scroll-driven groups get a timeline in pixels. Scrubbing one sets `scrollTop` or `scrollLeft` on the source node. The model groups scroll-driven animations by `sourceNodeId` and `axis`, and divides the reported offsets by device pixel ratio ([AnimationTimeline.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/panels/animation/AnimationTimeline.ts), [AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts), [docs](https://developer.chrome.com/docs/devtools/css/animations)).

### Timing edits and where they go

- Dragging the bar or its endpoints and releasing calls `animation.setTiming(duration, delay)` ([AnimationUI.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/panels/animation/AnimationUI.ts)). That sends `Animation.setTiming`. For CSS animations and transitions it also calls `cssModel.setEffectivePropertyValueForNode(node.id, prefix + 'duration', ...)` and the same for `delay` ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts)).
- `CSS.setEffectivePropertyValueForNode` "find[s] a rule with the given active property for the given node and set[s] the new value" ([CSS.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/CSS.pdl)). In Blink it edits the declaration that wins the cascade, checking the inline style first and then author rules from last to first. With no declaration it falls back to the inline style, or else the top matching rule ([inspector_css_agent.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/inspector/inspector_css_agent.cc)). When the winning declaration sits in an author stylesheet, the edit changes that stylesheet's text, not an inline style. The public docs say edits "apply inline styles" ([docs](https://developer.chrome.com/docs/devtools/css/animations)), which matches the code only when the inline style wins or nothing declares the property.
- A 2015 review gives the reason: to avoid "dealing with property lists", the timeline writes the property directly, so one edit can change every animation sharing that rule ([codereview 1159613003](https://codereview.chromium.org/1159613003)). An element with `transition: width 300ms, transform 300ms` gets a single duration back for both *(inferred from source)*.
- Dragging a keyframe offset calls `KeyframeStyle.setOffset`, which only updates frontend state (`this.#offset = offset * 100 + '%'`). Nothing reaches the page or the stylesheet ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts)). Keyframe and Bézier editing are not supported in the panel. Easing is edited in the Styles pane ([docs](https://developer.chrome.com/docs/devtools/css/animations)).

### Workspaces and Changes

- Workspaces map a served origin to a local folder. A project can declare itself in `.well-known/appspecific/com.chrome.devtools.json` with a UUID and root path. Edits to CSS, HTML and JS in Sources save to disk on Ctrl/Cmd+S. DOM edits in Elements are not saved. Built output relies on source maps, with support depending on the framework ([Workspaces](https://developer.chrome.com/docs/devtools/workspaces)).
- The Changes panel shows a diff of CSS edited in Styles or Sources, JS edited in Sources, and HTML with Local overrides on. It offers Copy and Revert per file. It loses everything on reload and does not see changes made outside DevTools ([Changes](https://developer.chrome.com/docs/devtools/changes)).
- Because a duration drag rewrites the winning rule's text, it should show in Changes and be saveable through a Workspace when that rule's file is mapped *(inferred from source; not run)*.

The full DevTools route from a live timing edit to source therefore runs: `setTiming` for the live object, then `setEffectivePropertyValueForNode` on the winning declaration, then a stylesheet text change, then a Workspace save. It covers duration and delay of CSS-declared motion only. JS-declared timing (GSAP, `animate()` options, frame-loop constants) and keyframe offsets have no route back.

## 4. Script-level clocks injected into the page

### Playwright `page.clock`

- It overrides `Date`, `Temporal.Now`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`, `requestAnimationFrame`/`cancelAnimationFrame`, `requestIdleCallback`/`cancelIdleCallback`, `performance` and `Event.timeStamp`. The API has `install`, `setFixedTime`, `setSystemTime`, `pauseAt`, `fastForward` (due timers fire once), `runFor` (fires timers and frames along the way) and `resume` ([Playwright clock](https://playwright.dev/docs/clock)).
- The injected implementation also wraps `Intl.DateTimeFormat` and `AbortSignal`. Animation frames sit on a 16ms grid: the delay is `16 - ticks % 16`. `performance.now()` returns the clock's ticks, which advance only through `runFor`, `fastForward` or `pauseAt`, or through real-time sync after `resume()`. The file never references `document.timeline`, `Animation`, CSS, `HTMLMediaElement` or SVG ([clock.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/clock.ts)).

What supports it: it controls the JS-visible clock completely, with no CDP involvement, and works in every Playwright browser. Where it stops: CSS transitions, CSS animations, Web Animations, View Transitions, SMIL, media, smooth scroll and scroll timelines all keep running on the engine's clock. A busy loop that spins on `performance.now()` with the clock paused never ends, because ticks advance only from outside *(inferred from source)*.

### Playwright screenshot `animations: "disabled"`

This option arrived in 1.20 and "rewinds all CSS animations and transitions to a consistent state" ([1.20 release notes](https://newreleases.io/project/npm/playwright/release/1.20.0)). It fast-forwards finite animations to their end, cancels infinite ones to their start for the capture, and is the default in `toHaveScreenshot` ([summary](https://qaskills.sh/blog/playwright-screenshot-animation-caret-disable), secondary; the official text is in the [Page API](https://playwright.dev/docs/api/class-page#page-screenshot)). It removes motion rather than sampling it.

### Puppeteer

No clock API or open feature request turned up in search. Puppeteer users reach the same ground through raw CDP sessions (`Emulation.setVirtualTimePolicy`, `Animation.*`) or by injecting a fake clock with `evaluateOnNewDocument`. timesnap is the example of the latter ([timesnap](https://github.com/tungs/timesnap)).

### Sinon fake-timers and Jest

- `@sinonjs/fake-timers` always fakes timers and `Date`. Where present it also fakes `performance`, `requestAnimationFrame`, `requestIdleCallback`, `queueMicrotask`, `nextTick`, `hrtime`, `Intl` and `Temporal`. It offers `tick`, `tickAsync` (lets promises settle first), `next`, `runAll` (stops at `loopLimit` 1000), `runToFrame`, `runToLast`, and `shouldAdvanceTime` to follow real time in `advanceTimeDelta` steps. Frames run "every 16 ticks" ([fake-timers](https://github.com/sinonjs/fake-timers)).
- Jest's `advanceTimersToNextFrame` moves to the next 16ms boundary ([Jest timer mocks](https://jestjs.io/docs/timer-mocks)). Jest's modern timers are built on `@sinonjs/fake-timers` *(memory)*.

It works anywhere JS runs, including jsdom, where there is no rendering at all. It reaches no engine-driven motion.

### timeweb and timesnap: page clock plus pause-and-seek

- timeweb overrides the same JS clock surface and also takes over CSS transitions, CSS animations, Web Animations, SVG animations and `<video>`. It finds animations through `transitionstart`/`animationrun` listeners, `document.getAnimations()` and a wrapped `Element.prototype.animate`, then pauses each one and seeks it to virtual time. It finds videos with a MutationObserver and a wrapped `document.createElement`, and pauses and seeks them the same way. `goTo` moves forward only, and `requestAnimationFrame` runs once per `goTo`. Iframes, `event.timeStamp` and audio analyser nodes do not work ([timeweb README](https://cdn.jsdelivr.net/npm/timeweb@0.3.2/README.md)).
- timesnap uses `evaluateOnNewDocument` to override the JS time functions and video playback. It warns that CSS-driven changes will likely not render as intended ([timesnap](https://github.com/tungs/timesnap)).

This is the one approach found that brings media and SVG under a single virtual clock. It does so by holding each element paused and setting its time every frame, not by changing what the element runs on.

### Remotion: time as an input

Remotion requires each frame to be a function of `useCurrentFrame()`. It renders frames in parallel tabs and out of order, so CSS animations and timer-driven motion flicker ([flickering](https://www.remotion.dev/docs/flickering)). For video it skips the media clock: `<OffthreadVideo>` extracts the exact frame with FFmpeg outside the browser and shows it in an `<img>` during render ([OffthreadVideo](https://www.remotion.dev/docs/offthreadvideo)). It shows how far media sits outside page time: the deterministic path takes video out of the page entirely.

## 5. Component and screenshot test tools

### Storybook interaction tests

A `play` function drives `userEvent` and `expect` after render. `step` groups calls under a label. The Interactions panel can pause, resume, rewind and step through the calls ([interaction testing](https://storybook.js.org/docs/writing-tests/interaction-testing)). Rewind remounts the story and re-runs the play function up to the chosen call *(memory)*. Time is not controlled: the docs show `mockdate` for a fixed `Date` and nothing for timers or animations ([interaction testing](https://storybook.js.org/docs/writing-tests/interaction-testing)).

### Chromatic

Chromatic pauses CSS animations at their last frame by default; `pauseAnimationAtEnd` is the switch. It pauses videos and GIFs on their first frame, or shows the `poster`. It cannot pause JS animations, so it points to `isChromatic()` for disabling them ([Chromatic animations](https://www.chromatic.com/docs/animations), [May 2024 changelog](https://www.chromatic.com/blog/chromatic-changelog-may-2024/)). This is a fixed sample point, end or start, not a controllable time.

## 6. Engine test harnesses

### web-platform-tests

- `web-animations/testcommon.js` has no virtual clock. Tests set `animation.currentTime` directly (`assert_phase_at_time`) and wait on real frames with `waitForAnimationFrames(n)`, `waitForNextFrame()` (polls until `document.timeline.currentTime` changes) and `waitForAnimationFramesWithDelay(ms)` (measured in frame time). Times compare within `TIME_PRECISION` = 0.0005ms ([testcommon.js](https://raw.githubusercontent.com/web-platform-tests/wpt/master/web-animations/testcommon.js)).
- Scroll-driven tests build a 100×100 scroller over a 500×500 child and compute expected progress as `(offset − start) / (end − start) × 100`. They assert a `CSSUnitValue` in `percent` ([scroll-timelines/testcommon.js](https://raw.githubusercontent.com/web-platform-tests/wpt/master/scroll-animations/scroll-timelines/testcommon.js)).
- Reftests delay the screenshot with `class="reftest-wait"` and a `TestRendered` event, and allow `<meta name=fuzzy>` tolerances. The docs give no animation guidance ([reftests](https://web-platform-tests.org/writing-tests/reftests.html)).

Determinism here comes from seeking each animation, not from controlling a clock. That is the same primitive as CDP `seekAnimations`.

### WebKit LayoutTests

- `runAnimationTest` takes tuples of `[animation-name, time, element-id, property, expected, tolerance]`. With a named animation it finds the `CSSAnimation` through `getAnimations()`, calls `pause()` and sets `currentTime = time * 1000`. Without a name it falls back to `setTimeout` in real time. It compares values with type-aware tolerance for matrices, filters, shapes and font variation ([animation-test-helpers.js](https://raw.githubusercontent.com/WebKit/WebKit/main/LayoutTests/animations/resources/animation-test-helpers.js)).
- Older tests used `internals.pauseAnimationAtTimeOnElement`, moved from TestRunner to Internals in 2013 ([commit](https://webkit.googlesource.com/WebKit/+/84dbb0d6733e2a9979463563ca4bd35d05e727c3)). `internals.suspendAnimations()` and `resumeAnimations()` stop all animations ([suspend-resume-animation.html](https://webkit.googlesource.com/WebKit/+/master/LayoutTests/animations/suspend-resume-animation.html)).

These harnesses check numbers before pixels. Each check is a computed-style value at a seeked time against an expected value and a tolerance.

## 7. Native UI frameworks

### Jetpack Compose

- `ComposeTestRule.mainClock` drives recomposition, animations and gestures, but not Android's measure and draw passes. With `autoAdvance = false`, the test calls `advanceTimeByFrame()`, `advanceTimeBy(ms)` (rounded up to a whole frame) or `advanceTimeUntil {}`. `waitForIdle()` then waits only for idling resources ([synchronization](https://developer.android.com/develop/ui/compose/testing/synchronization), [testing animations](https://developer.android.com/develop/ui/compose/animation/testing)).
- The official example pauses the clock, sets state, advances 50ms into a 250ms tween, and calls `onRoot().captureToImage()` for a golden comparison the project supplies itself. The frame-by-frame loop is `advanceTimeByFrame(); waitForIdle()` with assertions in between ([testing animations](https://developer.android.com/develop/ui/compose/animation/testing)).
- Android Studio's Animation Preview supports `updateTransition`, `AnimatedVisibility`, `animate*AsState`, `Crossfade`, `rememberInfiniteTransition` and `AnimatedContent`. It can play, pause, scrub, loop and change speed. It shows every animation in one view, can freeze one specific animation, has pickers for target state, and graphs curves ([Animation Preview](https://developer.android.com/develop/ui/compose/tooling/animation-preview)).
- Live Edit pushes edited composable function bodies to a running app on manual push, on save, or automatically. Signature and class changes need a restart, and the first edit in a file resets state. The deprecated Live Edit of literals updated `Int`, `String`, `Color`, `Dp` and `Boolean` constants. In both, the edit is made in source and pushed to the app. Neither writes a value from a tool back to the file ([iterative development](https://developer.android.com/develop/ui/compose/tooling/iterative-development)).

Compose owns its animation clock, so the test clock reaches every Compose animation. Scroll animations run on the same frame clock *(memory)*. Video in an `AndroidView` and other non-Compose views are outside it ([synchronization](https://developer.android.com/develop/ui/compose/testing/synchronization)).

### Flutter

- `tester.pump(duration)` "triggers a frame after `duration`". Under `FakeAsync`, the default in `flutter test`, it advances fake time. Under `flutter run` it waits in real time ([pump](https://api.flutter.dev/flutter/flutter_test/WidgetTester/pump.html)).
- `pumpAndSettle` pumps in 100ms steps until no frame is scheduled. It fails after a ten-minute timeout and throws on infinite animations such as an indeterminate spinner ([pumpAndSettle](https://api.flutter.dev/flutter/flutter_test/WidgetTester/pumpAndSettle.html)).
- `matchesGoldenFile` compares the image of the nearest `RepaintBoundary` ancestor of the found widget against a stored file. `flutter test --update-goldens` rewrites the files. Fonts differ across platforms and Flutter versions ([matchesGoldenFile](https://api.flutter.dev/flutter/flutter_test/matchesGoldenFile.html)).
- `timeDilation` "slows down animations by this factor". DevTools' Slow animations button sets it to 5 ([timeDilation](https://api.flutter.dev/flutter/scheduler/timeDilation.html), [DevTools inspector](https://docs.flutter.dev/tools/devtools/inspector)).

Flutter animations, scroll physics included, are driven by tickers off the binding's frame clock, so `pump` reaches them *(memory)*. Platform views such as video are outside it *(memory)*. The `RepaintBoundary` crop picks an ancestor, which is the same shape as the matrix's crop rule.

### React Native Reanimated

- `setUpTests({ fps: 60 })` in Jest setup, Jest fake timers, then `jest.advanceTimersByTime(ms)` or `runAllTimers()`. `toHaveAnimatedStyle` asserts current animated styles ([testing](https://docs.swmansion.com/react-native-reanimated/docs/guides/testing/)).
- 2.x documented `withReanimatedTimer`, `advanceAnimationByTime(ms)` and `advanceAnimationByFrame(n)` ([2.x testing](https://docs.swmansion.com/react-native-reanimated/docs/2.x/guide/testing/)).

These read style values per frame with no rendering.

## 8. Clocks outside page time, by tool

| Tool | Media (`<video>`) | SVG SMIL | Scroll-driven timeline | Browser smooth scroll |
|---|---|---|---|---|
| `Emulation.setVirtualTimePolicy` | No link to media found ([html_media_element.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/media/html_media_element.cc)) | Follows the document timeline, so it follows virtual time if that timeline does; not established | Position, not time | Not established |
| CDP `Animation.setPlaybackRate` | Not affected; media has its own `playbackRate` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)) | Scaled, through `Timeline().CurrentTimeInternal()` *(inferred from source)* | Reported with `viewOrScrollTimeline`; rate has no time axis to act on ([scroll-animations-1](https://drafts.csswg.org/scroll-animations-1/)) | Not affected *(memory)* |
| DevTools Animations panel | Not captured | Not captured | Captured; scrub sets `scrollTop`; replay disabled | Not captured |
| Playwright clock, Sinon, Jest | Not affected ([clock.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/injected/src/clock.ts)) | Not affected | Not affected | Not affected |
| timeweb | Paused and seeked each frame | Paused and seeked ("SVG animations") | Not mentioned | Not mentioned ([README](https://cdn.jsdelivr.net/npm/timeweb@0.3.2/README.md)) |
| Chromatic | First frame or poster | Not mentioned | Not mentioned | n/a ([docs](https://www.chromatic.com/docs/animations)) |
| Remotion | FFmpeg frame extraction during render ([OffthreadVideo](https://www.remotion.dev/docs/offthreadvideo)) | Must derive from frame number | Must derive from frame number | n/a |
| Compose, Flutter test clocks | Outside (platform views) *(memory)* | n/a | Framework scroll is on the frame clock *(memory)* | Same |

Media reference points:
- `HTMLMediaElement.playbackRate` multiplies the normal rate. Negative rates have little support, and Gecko mutes outside 0.25–4 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)). Chromium bounds the rate with `kMinPlaybackRate` and `kMaxPlaybackRate` ([html_media_element.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/media/html_media_element.cc)), which are 0.0625 and 16 *(memory)*.
- Chromium's `currentTime` reports the official playback position and does not advance while script runs ([crrev 2b47014e](https://chromium.googlesource.com/chromium/src.git/+/2b47014ed47455c497539af8fdf02cf54ea516be%5E)).
- `requestVideoFrameCallback` runs before `requestAnimationFrame` callbacks for each presented frame. It reports `mediaTime` (the frame's PTS), `presentedFrames` (gaps reveal dropped frames) and `expectedDisplayTime` ([video-rvfc](https://wicg.github.io/video-rvfc/)).

Scroll reference point: a scroll progress timeline's progress is `scroll offset ÷ (scrollable overflow − container size)`, from 0% to 100%, and the timeline is finite. An `auto` duration divides the range by the iteration count ([scroll-animations-1](https://drafts.csswg.org/scroll-animations-1/)).

## 9. Write-back: how a live change reaches source

| Tool | Live change | Path to source |
|---|---|---|
| DevTools Animations panel | `setTiming` (duration, delay) | `setEffectivePropertyValueForNode` rewrites the winning declaration; a Workspace saves the file ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts), [Workspaces](https://developer.chrome.com/docs/devtools/workspaces)) |
| DevTools Styles pane | Any declaration, including easing | Changes panel diff; Workspace save ([Changes](https://developer.chrome.com/docs/devtools/changes)) |
| DevTools keyframe drag | Frontend state only | None ([AnimationModel.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/core/sdk/AnimationModel.ts)) |
| Compose Live Edit | Edit source, push to app | Source is edited first ([iterative development](https://developer.android.com/develop/ui/compose/tooling/iterative-development)) |
| Flutter DevTools | `timeDilation` only | None; timing lives in Dart source ([inspector](https://docs.flutter.dev/tools/devtools/inspector)) |
| Compose Animation Preview | Speed, scrub, state pickers | None ([Animation Preview](https://developer.android.com/develop/ui/compose/tooling/animation-preview)) |

Two directions recur. In DevTools the value is edited in the tool, reaches the stylesheet text through the CSS domain, and is saved when the file is mapped. In Compose Live Edit and hot reload the source is edited and the running app takes the change. No surveyed tool edits a JS-declared timing value (a GSAP duration, an `animate()` option, a frame-loop constant, a spring constant) in the tool and writes it back to the file.

## 10. Mapping onto the matrix

**Hold and step; Slow.**
- `css-transition`, `css-keyframes`, `waapi`, `view-transition`: `Animation.setPlaybackRate` acts on the document timeline of every inspected frame and restarts compositor animations at the new rate (§2). That is the mechanism these mechanism defaults expect. It also bears on `frame` (key 6, srcdoc iframe), whose document is one of the inspected frames *(inferred from source)*.
- `backup` (j, l, z, x): the document timeline's rate scales time before each animation's own `playbackRate` applies, so the app's 4× should multiply with `rate` rather than be replaced by it *(inferred from source)*. The app's own `pause()` is a separate state from `setPaused`.
- Script clocks (Playwright, Sinon, Jest) own `requestAnimationFrame`, timers and `performance.now` on a 16ms grid (§4). That is the ground the page clock covers for `frame-loop`, `timer-text`, `canvas`, `webgl`, `lottie` and `gsap`. They leave engine-driven motion alone, which is why devharness pairs a page clock with `setPlaybackRate`.
- `sky`: under a paused injected clock, `performance.now()` advances only from outside, so the 90ms busy loop never ends unless time moves inside the callback. This agrees with the cell's note (§4).

**Hold and Slow, outside page time.**
- `smil` (`dot`, key `,`): Blink computes SMIL time from the document timeline (§2). `setPlaybackRate(0)` may already hold it and fractional rates may already slow it, before any `pauseAnimations` call. A sequence would move these cells from gap to measured. `pauseAnimations()` and `setCurrentTime()` are per `<svg>` fragment.
- `video` (`promo`, key `[`): none of the clocks reach media. Approaches in use are: pause and seek per frame (timeweb), `playbackRate` for slow (MDN; Chromium floor 0.0625 *(memory)*), a fixed first frame (Chromatic), and frame extraction outside the browser (Remotion). `requestVideoFrameCallback` gives `mediaTime` and `presentedFrames` for the Seen and Row cells as text.
- `scroll-timeline` (`scroll-bar`, `reveal`): the matrix's n/a for hold and slow matches the spec's position-based progress. CDP's `viewOrScrollTimeline` gives `sourceNodeId`, `axis` and pixel offsets, enough for a row in pixels. DevTools steps these by setting `scrollTop` (§3).
- `smooth-scroll` (`jump`, key `.`) and `scroll-listener` (`parallax`, `masthead`): no surveyed tool holds browser smooth scroll.

**Solo.**
- CDP has per-animation `setPaused` and `seekAnimations` with per-animation times. Holding all but one is a `setPaused` over the rest; the protocol has no single command for it.
- Compose Animation Preview's "freeze a specific animation" is the nearest product feature (§7).
- Script clocks are all-or-nothing, so the frame-loop scenarios have no per-loop freeze in any surveyed tool.

**Replay.**
- DevTools replay rewinds captured animation objects and does not re-run the trigger (§3). `toast` (key 2) shows the difference: the 700ms timer belongs to the trigger, not to the animation, so rewinding the transition leaves the timer out.
- Re-running the input, as Storybook rewind does *(memory)* and as Compose and Flutter tests do, replays the timers as well. devharness sequences sit on that side.

**Crop.**
- Flutter goldens crop to the nearest `RepaintBoundary` ancestor of the found widget. Compose captures the node the test names (§7). Both pick an ancestor element, which is the shape of the matrix's crop rule.
- `HeadlessExperimental.beginFrame` can return a screenshot with each frame, headless only (§1).

**Text flag.**
- WebKit's helpers and WPT compare computed values at seeked times against expected values with tolerances. Reanimated and Compose assert style values per frame (§6, §7). That is a numeric check before any image.
- Anomalies the matrix names fit that form: `badge` scale reversal, `folders` item 3 easing and item 5 delay against the 40ms stagger, `count` final value 1248 against 1280. None of the surveyed tools flags anomalies on its own; each checks against an expected value the author supplies.

**Tune.**
- `Animation.setTiming` covers duration and delay live. Easing, iterations and keyframes take `resolveAnimation` and the Web Animations API (§2).
- For CSS-declared motion, DevTools already joins the live edit to the winning declaration and a Workspace save. That is the cell rule's "names the rule and its line" with the write done by DevTools rather than by an LLM session. It fits `badge` keyframes only partly, because keyframe offsets have no write path.
- `folders` (index.html:44) has a two-property transition list, and the DevTools write replaces lists with one value (§3).
- `like`, `newest`, `tour`, `backup`, `details`, `sheet`, `count`, `plans` and `envelope` declare timing in JS or JSON. No surveyed tool writes these back. The Compose Live Edit pattern, where source is edited and the running page takes it, is the standing alternative.

**Viewport and environment.**
- `Emulation.setEmulatedMedia` takes media features, which covers `prefers-reduced-motion` for `carousel` and `marquee`. `Emulation.setCPUThrottlingRate` takes a slowdown factor ([Emulation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Emulation.pdl)).
- Frame rate is settable only through `beginFrame`'s `interval` in headless BeginFrameControl (§1). Script clocks fix 16ms. `badge`'s "two frames at 120Hz" cell has no headed-browser control among the surveyed tools.

**Seen and Row.**
- The Animation domain sees only the three animation types (§2). DevTools has the same limit (§3).
- Every scenario the matrix marks "The record listens to the Animation domain only" falls outside every surveyed inspector. timeweb finds CSS and Web Animations through events and `getAnimations()`, and video and SVG through DOM observation, but rAF-driven style writes are not detected by any surveyed tool.
