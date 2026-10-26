# How tools capture and present motion for review

This survey covers how existing tools turn motion into something a person or a model can review: filmstrips and contact sheets, onion skins, motion paths, bounding boxes and overlays, value and easing curves, timeline scrubbers, flipbooks, region captures, and side-by-side comparison. It covers browser devtools, page-load performance tools, motion editors, visual regression services and agent browser tools. It also covers what a model is charged for the images it receives. Each section describes what a tool does, the mechanism it rests on, and where it stops. The last section maps the findings onto `examples/motion/matrix.json`.

Every claim carries a source URL. A statement marked *(from memory)* was not checked against a source during this survey. Arithmetic marked *(computed)* applies a cited formula to example sizes.

## 1. Capture: where frames and values come from

The tools below take motion from one of two sources: the browser's animation model, which gives values, or the compositor, which gives pixels. They then sample either source on a schedule.

### 1.1 Values from the animation model

The Chrome DevTools Protocol `Animation` domain reports animations as objects, not as pixels. `animationCreated`, `animationStarted`, `animationUpdated` and `animationCanceled` events carry an `Animation` record. Its `type` is one of `CSSTransition`, `CSSAnimation` or `WebAnimation`, and it carries `startTime`, `currentTime`, `playbackRate` and `playState`. Its `source` effect carries `delay`, `endDelay`, `duration`, `iterations`, `direction`, `fill`, `easing`, the target `backendNodeId`, and a `keyframesRule` whose keyframes each hold an `offset` and an `easing`. Scroll-driven animations carry a `viewOrScrollTimeline` with start and end scroll offsets in pixels, and for them `startTime` and `duration` are percentages. Control commands are `setPaused` and `seekAnimations` on a list of animation ids, `setPlaybackRate` on the whole document timeline, and `setTiming`, which accepts only `duration` and `delay`. [CDP Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)

The `KeyframeStyle` type carries only offset and easing, not the property values at each keyframe. Reading `scale(0.6)` at 50% requires resolving the animation to a JavaScript object (`resolveAnimation` returns a `Runtime.RemoteObject`) and reading its keyframes there. [CDP Animation.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Animation.pdl)

Chrome's Animations panel documentation states the panel's scope: CSS animations, CSS transitions, Web Animations and View Transitions, with "`requestAnimationFrame` animations … not yet supported." [Chrome DevTools: Inspect animations](https://developer.chrome.com/docs/devtools/css/animations)

Library runtimes expose their own value models. lottie-web offers `goToAndStop(value, isFrame)`, `setSpeed`, `playSegments`, `setSubframe` (false snaps to the After Effects frame rate), `getDuration(inFrames)`, and `enterFrame` and `drawnFrame` events. [lottie-web README](https://github.com/airbnb/lottie-web) GSAP exposes timelines that GSDevTools scrubs, and GSAP's global time scale can be set to 0. [GSDevTools](https://gsap.com/docs/v3/Plugins/GSDevTools/), [Percy: freezing animations](https://www.browserstack.com/docs/percy/stabilize-screenshots/animations)

### 1.2 Pixels from the compositor

CDP offers three pixel paths. [CDP Page.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl), [CDP HeadlessExperimental.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl)

- **`Page.captureScreenshot`** takes one image in `png`, `jpeg` (with `quality`) or `webp`. Its `clip` is a `Viewport` of `x`, `y`, `width`, `height` and `scale` in device-independent pixels. Experimental flags add `captureBeyondViewport` and `optimizeForSpeed`.
- **`Page.startScreencast`** pushes `screencastFrame` events as frames are produced. It takes `format`, `quality`, `maxWidth`, `maxHeight` and `everyNthFrame`, plus `maxFramesInFlight` (default 3) and `sendLastFrame`. Each frame must be acknowledged with `screencastFrameAck` before more are sent. Frame metadata carries scroll offsets, page scale and a swap `timestamp`. Because the stream is acknowledgement-limited, its delivered rate depends on the consumer, and frames can be skipped.
- **`HeadlessExperimental.beginFrame`** drives one frame at a caller-chosen `frameTimeTicks` and `interval` (default about 16.666 ms). It can return a `screenshot` of that frame, and it reports `hasDamage`. It needs a headless target created with BeginFrameControl and is "designed for use with `--run-all-compositor-stages-before-draw`." This is the only CDP path where frame time and the captured image are tied by construction.

The Performance panel records "a screenshot of every frame while recording" when Screenshots is enabled. A Capture settings menu sets frame size and a count cap "to customize visual recording fidelity within memory budgets." [Chrome DevTools: Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference)

Video recorders sample at fixed rates:

| Tool | Sampling |
|---|---|
| Playwright MCP | `browser_start_video` defaults to 25 fps. A `cursor` option paces actions by 800 ms. [Playwright MCP](https://github.com/microsoft/playwright-mcp) |
| Chrome DevTools MCP | `screencast_start` and `screencast_stop` write an `.mp4`. [chrome-devtools-mcp tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) |
| sitespeed.io | Records at 30 fps by default and discourages lower rates because they reduce Visual Metrics precision. [sitespeed.io: Video](https://www.sitespeed.io/documentation/sitespeed.io/video/) |
| WebPageTest | Captures every 100 ms on desktop and every 16 ms on mobile, keeping only frames that differ from the previous one. The filmstrip is then built on a 100 ms grid that repeats the last frame (Patrick Meenan in a WebPageTest forum thread, which now redirects; quoted in search results). [WebPageTest forum: Variable time between videoFrames](https://forums.webpagetest.org/t/variable-time-between-videoframes/9481) |

### 1.3 Time control at capture

Some tools control time so that a capture is repeatable:

- **Playwright's clock** overrides `Date`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`, `performance` and `Event.timeStamp`. Its methods include `pauseAt`, `runFor` (which fires timers and animation frames along the way), `fastForward` (which fires due timers once) and `resume`. The page does not say whether CSS animations follow the clock. [Playwright: Clock](https://playwright.dev/docs/clock)
- **CDP `beginFrame`** sets frame time directly (section 1.2).

Visual regression tools take the opposite path: they remove motion before capture.

- **Playwright's `toHaveScreenshot`** defaults `animations: "disabled"`. Finite CSS animations, transitions and Web Animations jump to their end, so `transitionend` fires. Infinite ones reset to their initial state. It also waits "until two consecutive page screenshots yield the same result." [Playwright PageAssertions](https://playwright.dev/docs/api/class-pageassertions)
- **Chromatic** pauses CSS animations and transitions on their last frame by default. `pauseAnimationAtEnd: false` pauses them on the first frame instead. Chromatic pauses video and GIFs on the first frame, or uses the `poster` image. It does not control JavaScript animations, and it recommends `isChromatic()` or app-side flags for them. [Chromatic: Animations](https://www.chromatic.com/docs/animations/)
- **Percy** freezes "most CSS `animation` and `transition` styles" and animated GIFs. SVG animations "will not be frozen by Percy in all browsers." Percy recommends turning motion off in libraries: `$.fx.off`, `$.Velocity.mock`, and GreenSock `globalTimeScale(0)`. [Percy: Freezing animations](https://www.browserstack.com/docs/percy/stabilize-screenshots/animations)
- **Lost Pixel** has no animation option. It waits a fixed `waitBeforeScreenshot` (default 1000 ms). [Lost Pixel config](https://docs.lost-pixel.com/user-docs/api-reference/lost-pixel.config.js-or-ts)

What holds this up: one stable frame per state makes pixel diffs repeatable. Where it stops: a fault that exists only between frames, or on frame 0, is removed by design. A frame-0 flash, a mid-run dip and an interrupted fade are invisible to a capture taken at the end state.

## 2. Presentation techniques

### 2.1 Filmstrip and contact sheet

A filmstrip lays sampled frames along a time axis. A contact sheet tiles them in a grid.

- **WebPageTest's filmstrip** offers thumbnail intervals of 0.1 s, 0.5 s, 1 s and 5 s, with some guides listing a 60 fps option. Borders encode events: yellow for "something changed since the previous frame", dotted for a reported layout shift, and red for the Largest Contentful Paint frame. A "Highlight Layout Shifts" option "will highlight the area of the content shift reported by Chrome in red." [Meenan, Analyzing Web Vitals with WebPageTest](https://calendar.perfplanet.com/2020/analyzing-web-vitals-with-webpagetest/), [WebPageTest compare page](https://www.webpagetest.org/video/compare.php?tests=230221_AiDcZS_80Y-r:2-c:0-e:filmstrip)
- **sitespeed.io** hides frames identical to the one before unless `--filmstrip.showAll` is set. [sitespeed.io: Video](https://www.sitespeed.io/documentation/sitespeed.io/video/)
- **Lighthouse** reduces a load to 8 thumbnails by default (`NUMBER_OF_THUMBNAILS = 8`). They are spread evenly over a timeline of at least 3000 ms, each takes the latest analysed frame at or before its slot, and they are encoded as JPEG. [Lighthouse screenshot-thumbnails.js](https://github.com/GoogleChrome/lighthouse/blob/main/core/audits/screenshot-thumbnails.js)
- **Playwright's Trace Viewer** renders the trace's screencast "as a film strip." Hovering magnifies a frame, and dragging across the timeline filters the actions, console and network panes to that span. [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- **Chrome's Performance panel** shows the frame under the cursor when hovering the overview, and a thumbnail in the Summary tab for a selected frame. [Chrome DevTools: Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference)

For models, IG-VLM (Kim et al., 2024) samples six frames, one from the start of each of six intervals, and tiles them 3×2 into a single image for a vision-language model with no video training. It reports beating prior methods on nine of ten zero-shot video question-answering benchmarks. The 3×2 layout was chosen so the grid stays close to square. [arXiv 2403.18406](https://arxiv.org/pdf/2403.18406)

What holds it up: evenly spaced frames make change over time comparable at a glance, and a single grid image costs one image's tokens. Where it stops: interval sampling misses any event shorter than the interval. A 100 ms grid cannot show a 15 ms event *(computed)*. Deduplicated strips (WebPageTest, sitespeed.io) drop frames with no change, which keeps strips short, but it also hides how long a still state lasted unless timestamps are kept.

### 2.2 Timeline scrubber

A scrubber maps a pointer position to a time and seeks the motion to it.

- **Chrome's Animations panel** scrubs the selected group. For time-based groups, the group pauses during the drag and resumes afterwards if it was playing. Seeks are clamped to the group's duration. For scroll-driven groups the axis is pixels, and dragging sets the page's scroll position. Speed buttons are `GlobalPlaybackRates = [1, 0.25, 0.1]` (100%, 25%, 10%), disabled for scroll-driven groups. [AnimationTimeline.ts](https://chromium.googlesource.com/devtools/devtools-frontend/+/refs/heads/main/front_end/panels/animation/AnimationTimeline.ts)
- **Firefox's Animations view** places every animation on the selected subtree on one timeline. It has a playback-rate dropdown, a current-time readout, and a draggable playhead. [Firefox: Work with animations](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)
- **GSDevTools** adds a scrubber, in and out markers (`I` and `O`), loop, and timeScale on the up and down arrow keys to a GSAP page. An animation menu lists the global timeline and every animation with an `id`. `globalSync` keeps one animation scrubbed in the context of the root timeline. Settings persist across reloads by default. [GSDevTools](https://gsap.com/docs/v3/Plugins/GSDevTools/)
- **Theatre.js** loops playback inside a shift-drag "focus range." [Theatre.js: Sequences](https://www.theatrejs.com/docs/latest/manual/sequences)
- **Lottie Creator** steps one frame with Page Up and Page Down, and ten frames with Shift held. Its scrubber "highlights individual frames" and is constrained to frames while dragging. [LottieFiles Creator: Timeline](https://docs.lottiefiles.com/en/creator/07_animation/timeline), [LottieFiles release note](https://releases.lottiefiles.com/log/better-player-control-and-improved-playhead-scrubbing)
- **LottieFiles' VS Code preview** scrubs a local `.lottie` or JSON file with speed and loop controls. [LottieFiles VS Code preview](https://docs.lottiefiles.com/en/integrations/vscode/04_inspect/previewing-local-lottie-files)

What holds it up: a seek is a write to the animation's current time, so any state can be reached without waiting. Where it stops: a scrubber reaches only motion whose time it owns. Chrome's panel cannot scrub `requestAnimationFrame` motion. GSDevTools sees only GSAP. Lottie's scrubber sees only the Lottie file.

### 2.3 Rows, group previews and schematic timing

Chrome's Animations panel groups animations "by start time, ignoring delays," so animations started in one script block share a group. Asynchronous ones land in separate groups. [Chrome DevTools: Inspect animations](https://developer.chrome.com/docs/devtools/css/animations)

The group preview is a schematic, not a screenshot. It is a 100×32 SVG with one line per animation, x from delay to delay plus one iteration, on a scale floored at 750 ms. At most 10 lines are drawn (`MAX_ANIMATION_LINES_TO_SHOW`). [AnimationGroupPreviewUI.ts](https://chromium.googlesource.com/devtools/devtools-frontend/+/refs/heads/main/front_end/panels/animation/AnimationGroupPreviewUI.ts) *(From memory: older DevTools versions also captured screencast frames for a group and showed them in a popover. No such file exists in the current `panels/animation` directory.)* [panels/animation listing](https://chromium.googlesource.com/devtools/devtools-frontend/+/refs/heads/main/front_end/panels/animation/)

In the details pane, each animation is a row. Infinite iterations draw as a darker first iteration followed by fainter repeats. Colour marks a shared effect and is otherwise random. [Chrome DevTools: Inspect animations](https://developer.chrome.com/docs/devtools/css/animations)

Firefox colours bars by origin: blue for transitions, orange for `@keyframes`, green for Web Animations. Delay and `endDelay` draw cross-hatched. A transition over several properties draws one bar per property. [Firefox: Work with animations](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)

Safari's Graphics tab lists Web Animations, CSS animations and CSS transitions next to canvases, with a Keyframes section holding each keyframe's CSS. [WebKit bug 205434](https://bugs.webkit.org/show_bug.cgi?id=205434), [WebKit bug 212509](https://bugs.webkit.org/show_bug.cgi?id=212509), [WWDC20 notes](https://wwdcnotes.com/documentation/wwdc20-10646-whats-new-in-web-inspector/)

What holds it up: timing is shown as text and geometry, with no pixels, so a stagger or a misplaced delay reads from bar positions. Where it stops: grouping by start time puts motion started by timers or replies in a different group from the input that caused it.

### 2.4 Value-over-time and easing curves

- **Firefox** draws each bar's outline as its easing: a concave bar for ease-in and a convex one for ease-out. Expanding a bar lists each animated property with keyframe dots, and hovering a dot shows its value. [Firefox: Work with animations](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)
- **Chrome** keeps easing editing out of the Animations panel. The Styles pane's Easing Editor edits cubic Bézier curves, and its `linear()` editor moves stops and offers presets such as Spring, Bounce and Material emphasized. [Chrome DevTools: Inspect animations](https://developer.chrome.com/docs/devtools/css/animations), [Chrome: linear() easing](https://developer.chrome.com/docs/css-ui/css-linear-easing-function)
- **After Effects' Graph Editor** shows a value graph and a speed graph. Speed on the vertical axis shows acceleration as slope and peaks. A reference graph can overlay the other view. [Adobe: Animation basics](https://helpx.adobe.com/il_he/after-effects/desktop/animate-in-after-effects/animation-basics/animation-basics.html), [Adobe community: graph editor views](https://community.adobe.com/t5/after-effects-discussions/why-does-my-graph-editor-look-different/m-p/12620933), [AEJuice: speed graph](https://aejuice.com/blog/how-to-use-the-speed-graph-in-after-effects)
- **Rive** plots value over time, with the x-axis time and the y-axis change in the property. Interpolation types are Linear, Cubic, Cubic Value (which can overshoot), Hold and Elastic. The Graph Editor replaces the timeline and shows only selected objects. [Rive: Interpolation and easing](https://rive.app/docs/editor/animate-mode/interpolation-easing)
- **Theatre.js** has a multi-track curve editor of speed curves, coloured per track, and a tween editor between two keyframes. [Theatre.js: Sequences](https://www.theatrejs.com/docs/latest/manual/sequences)
- **Jitter** edits a two-handle easing graph per animation, with presets such as Slow Down, Accelerate, Smooth, Natural and Linear. [Jitter changelog: custom easings](https://jitter.video/changelog/2025-02-18-custom-easings), [Jitter help: easing](https://help.jitter.video/en/articles/16072578-fix-robotic-animations-with-the-right-easing-curve)
- **Framer** sets springs either by Time and Bounce or by stiffness, damping and mass, with a graph editor for Bézier curves. Its academy lesson advises judging a transition in the final layout rather than alone. [Framer: time-based springs](https://www.framer.com/updates/time-based-springs), [Framer academy: transitions and easing](https://framer.com/academy/lessons/framer-animations-transitions-and-easing)

What holds it up: a curve plotted from keyframes and easing is exact and costs no image. A non-monotonic dip or a sibling with a different easing appears as a different shape. Where it stops: curves exist only where the tool has the keyframes. Motion written per frame by script, such as a spring loop, a scroll listener or GSAP's ticker, has no declared curve. Its value-over-time has to be sampled, not read.

### 2.5 Onion skinning

- **Adobe Animate** draws past and future frames over the current one with separate colours. Opacity falls with distance from the current frame, under a starting-opacity slider and a decrease slider. Start and end markers in the timeline header set the span, and outline mode is available. [Adobe Animate: Frame-by-frame animation](https://helpx.adobe.com/pe/animate/using/frame-by-frame-animation.html)
- **GitHub's image diff** includes "Onion Skin," described as useful "when elements move around by small, hard to notice amounts," alongside 2-up and Swipe. [GitHub: Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)

What holds it up: several instants appear in one image, so displacement between frames is visible as offset copies. Where it stops: overlapping semi-transparent copies of the same element become unreadable after a few frames. A change in opacity alone produces no offset to see.

### 2.6 Motion paths and trails

- **Blender motion paths** draw "each frame … by a small dot on the paths". Before and after the current frame use separate colours, keyed frames get large yellow squares, frame numbers are optional, and a Step setting thins the dots. Paths are computed on request ("Calculate Path"). [Blender manual: Motion paths](https://docs.blender.org/manual/en/latest/animation/motion_paths.html)
- **After Effects** draws a position property's path in the Composition panel with dots per frame. Their spacing shows speed, and switching keyframes to Auto Bezier evens it out. [ProVideo Coalition: AE hidden gems ch. 4](https://www.provideocoalition.com/creating_motion_graphics_with_after_effects_hidden_gems_chapter_4_-_keyfram/)
- **TraceVLA** (Zheng et al., ICLR 2025) applies a trail to model input. Co-Tracker tracks a 40×40 grid over 6 frames, keeps points whose movement exceeds a threshold, samples 5, and draws them as 2 px lines in fixed colours. The model receives both the clean frame and the overlaid frame, because the overlay "may obstruct the robot's end-effector or key objects." [arXiv 2412.10345](https://arxiv.org/html/2412.10345v3)

What holds it up: a path compresses a whole run's positions into one still image, and dot spacing encodes speed without a time axis. Where it stops: a path encodes position only. Scale, opacity and colour changes, which make up most of the matrix's faults, leave no trail. An overlay can hide what it marks, which is why TraceVLA sends the unmarked frame as well.

### 2.7 Bounding boxes, overlays and marks

Browsers draw regions as live overlays:

- **Rendering tab:** Paint flashing draws repainted areas green, Layout Shift Regions briefly purple, and layer borders orange, olive and cyan. Frame Rendering Stats plots frames as blue, yellow or red lines. [Chrome DevTools: Rendering](https://developer.chrome.com/docs/devtools/rendering/performance)
- **Performance panel:** the Layout shifts track draws purple diamonds, and hovering one highlights the shifted element. The Animations track marks non-composited animations with red triangles and gives "reasons for compositing failures." [Chrome DevTools: Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference)
- **Firefox:** a white lightning bolt means all properties of a bar run on the compositor and a grey one means some do. Tooltips explain why, for example "Animations of 'transform' cannot be run on the compositor when geometric properties are animated." [Firefox: Work with animations](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)

The geometry behind layout-shift boxes is exposed to pages. Each `LayoutShift` entry carries `value`, `hadRecentInput` (input within 500 ms), and up to 5 `sources`, each with `node`, `previousRect` and `currentRect`. [WICG Layout Instability](https://github.com/WICG/layout-instability)

For models, Set-of-Mark prompting overlays alphanumeric labels, masks and boxes on regions from segmentation models. With these marks, GPT-4V zero-shot outperformed a fine-tuned state-of-the-art model on RefCOCOg. [arXiv 2310.11441](https://arxiv.org/abs/2310.11441) Agent tools use the same idea:

- **browser-use:** `highlight_elements` (default true) draws boxes "for AI vision." [browser-use: browser parameters](https://docs.browser-use.com/customize/browser/all-parameters) A copy of its source describes drawing boxes with index labels in Python onto screenshots. [browser-use python_highlights.py (mirror)](https://huggingface.co/spaces/Speedofmastery/HMM/blob/main/browser-use-main/browser_use/browser/python_highlights.py)
- **Playwright MCP:** `browser_snapshot` accepts `boxes` to add bounding boxes to the accessibility snapshot as text. [Playwright MCP](https://github.com/microsoft/playwright-mcp)

What holds it up: a box or label ties a pixel region to an identifier the model can name back, and coordinates can travel as text with no image. Where it stops: a box marks one instant. A moving element needs one box per sampled frame, or a union box.

### 2.8 Cropped and region captures

Region capture exists at every layer:

- **CDP:** the `clip` of `captureScreenshot`. [CDP Page.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)
- **Playwright:** `clip` and `mask` with `maskColor` in assertions. [Playwright PageAssertions](https://playwright.dev/docs/api/class-pageassertions)
- **Playwright MCP:** `browser_take_screenshot` takes an element `target` and cannot be combined with `fullPage`. [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- **Chrome DevTools MCP:** `take_screenshot` takes a `uid` from the snapshot, which is "incompatible with" `fullPage`, plus `format` and `quality`. It can also save to a file instead of attaching the image. [chrome-devtools-mcp tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- **Claude's computer-use toolset:** a `zoom` action takes `region: [x0, y0, x1, y1]` and returns that region "at full resolution and scaled to fit your usual screenshot dimensions." It is meant for small text and dense UI. [Claude: Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

What holds it up: model cost scales with pixel area (section 3), so a crop to the moving region cuts cost in proportion to the area removed. Where it stops: every element-scoped capture above crops to the element's own box. None crops to the area the element covered over the run, or to the neighbours it pushed. Claude's vision guide warns against "cropping out key visual context solely to enlarge the text," and lists more errors on "very small images under 200 pixels." [Claude: Vision](https://platform.claude.com/docs/en/build-with-claude/vision)

### 2.9 Side-by-side, before and after, and strobing

- **Chromatic's Diff Inspector** offers 1 Up (changes over the baseline), 2 Up (side by side), neon-green highlighting of changed pixels, and "diff strobing", which toggles rapidly between baseline and new image. Its focus mode switches on for small pixel changes and adds a magnifier. `diffThreshold` sets what counts as a change. [Chromatic: Diff Inspector (tenant copy)](https://bbc.chromatic.com/docs/diff-inspector)
- **GitHub's image diff:** 2-up, swipe and onion skin (section 2.5). [GitHub: Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)
- **Applitools** grades difference by match level. Strict flags changes a person would notice, Layout compares structure and relative position while tolerating content changes, and Ignore Colors is Strict without colour. Levels apply per test, per checkpoint or per region. [Applitools: Match levels](https://applitools.com/docs/eyes/concepts/best-practices/match-levels)
- **Playwright and Lost Pixel** fail on pixel thresholds. Playwright uses a YIQ `threshold` with `maxDiffPixels` or `maxDiffPixelRatio`. Lost Pixel's `threshold` is a fraction below 1 and a pixel count at 1 or more, using `pixelmatch` or `odiff`. [Playwright PageAssertions](https://playwright.dev/docs/api/class-pageassertions), [Lost Pixel config](https://docs.lost-pixel.com/user-docs/api-reference/lost-pixel.config.js-or-ts)
- **Playwright's Trace Viewer** gives each action Before, Action and After DOM snapshots. The Action snapshot marks the target node and the click point. [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- **WebPageTest** compares filmstrips of several runs on one time axis. [Catchpoint: Interpreting results](https://docs.catchpoint.com/wpt/docs/interpreting-instant-test-results.md), [WebPageTest compare page](https://www.webpagetest.org/video/compare.php?tests=230221_AiDcZS_80Y-r:2-c:0-e:filmstrip)
- **sitespeed.io** ships a script that joins two runs' videos side by side, "slightly slowed down." [sitespeed.io: Video](https://www.sitespeed.io/documentation/sitespeed.io/video/)

What holds it up: one state against another, with the difference marked, needs no knowledge of how the motion was made. Where it stops: these tools compare one still per state, so a change in timing with the same end state shows no difference. Filmstrip comparison on a shared time axis is the only form above that compares timing, and it is limited by its sampling interval.

### 2.10 Flipbook and slowed playback

Slowed playback reruns the motion at a lower rate:

| Tool | Rates |
|---|---|
| Chrome Animations panel | 100%, 25%, 10% ([AnimationTimeline.ts](https://chromium.googlesource.com/devtools/devtools-frontend/+/refs/heads/main/front_end/panels/animation/AnimationTimeline.ts)) |
| Firefox | A rate dropdown ([Firefox](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/work_with_animations/index.html)) |
| GSDevTools | timeScale ([GSDevTools](https://gsap.com/docs/v3/Plugins/GSDevTools/)) |
| lottie-web | `setSpeed` ([lottie-web](https://github.com/airbnb/lottie-web)) |

A flipbook steps discrete frames: Lottie Creator's Page Up and Page Down ([LottieFiles Creator: Timeline](https://docs.lottiefiles.com/en/creator/07_animation/timeline)), or `beginFrame` one interval at a time ([CDP HeadlessExperimental.pdl](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/HeadlessExperimental.pdl)).

For people, an animated GIF is a common hand-off format. browser-use's `generate_gif` records the agent's actions. [browser-use: agent parameters](https://docs.browser-use.com/customize/agent/all-parameters) For models, animation formats are not read: Claude reads GIF but "Animations are unsupported, and only the first frame is used." OpenAI accepts "non-animated GIF." [Claude: Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [OpenAI: Images and vision](https://developers.openai.com/api/docs/guides/images-vision)

## 3. Handing motion to a model within a token budget

### 3.1 What an image costs

| Model family | Cost rule | Limits |
|---|---|---|
| Claude | `⌈width/28⌉ × ⌈height/28⌉` visual tokens. | Claude 4.7 and later: 2,576 px long edge and 4,784 tokens. Other models: 1,568 px and 1,568 tokens. Larger images are downscaled. Images returned in a computer-use `tool_result` are rejected, not downscaled. Over 20 images in a request, each side is limited to 2000 px. |
| OpenAI patch models | 32 px patches times a model multiplier. | Per-model patch budgets. |
| OpenAI tile models | 85 base tokens plus 170 per 512 px tile, after fitting to 2048 and a 768 px short side. `low` detail costs the base only. | |
| Gemini video | 1 frame per second by default, 258 tokens per frame (66 at low media resolution). `fps` and clip offsets are settable in static mode. The docs warn that "fast action sequences might lose detail due to the 1 FPS sampling rate." | |

Sources: [Claude: Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Claude: Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [OpenAI: Images and vision](https://developers.openai.com/api/docs/guides/images-vision), [Gemini: Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding).

Claude's computer-use guide puts one screenshot at about 1,000 to 1,800 input tokens. It advises pruning old screenshots in batches, for example keeping the last three and pruning every 25 turns, so that prompt caching keeps working. [Claude: Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

Example sizes under Claude's formula *(computed)*:

| Image | Visual tokens |
|---|---|
| 1280×800 viewport | 46 × 29 = 1,334 |
| 320×200 crop | 12 × 8 = 96 |
| Six such crops tiled 3×2 into one 960×400 image | 35 × 15 = 525 |
| Six separate viewport screenshots | 8,004 |

Sampling arithmetic *(computed)*: at Gemini's default 1 fps, a 300 ms animation receives at most one frame. A 15 ms keyframe dip falls between samples at any interval longer than 15 ms. At 60 Hz, one frame lasts 16.7 ms.

### 3.2 How agent browser tools hand over the page

- **Playwright MCP** defaults to text. `browser_snapshot` returns the accessibility tree and is described as "better than screenshot." It can be scoped by `target` and `depth` or written to a file. `browser_take_screenshot` is documented as unusable for acting on ("can't perform actions based on the screenshot"). Coordinate tools appear only with the `vision` capability. `--image-responses allow|omit|only` sets whether images reach the client at all. Video and tracing are opt-in `devtools` tools. [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- **Chrome DevTools MCP** also defaults to text. `take_snapshot` says "Prefer taking a snapshot over taking a screenshot." `take_screenshot` supports JPEG and WebP quality and element `uid`s, and can save to a file instead of attaching. `emulate` sets CPU throttling, network, viewport with device pixel ratio, colour scheme, forced colours, contrast and `prefersReducedMotion` in one call. [chrome-devtools-mcp tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) Traces come back as text: the raw trace is parsed and only saved to a file on request, and the response attaches a trace summary. [performance.ts](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/performance.ts) The summary comes from DevTools' AI `PerformanceTraceFormatter`, the same code that serves DevTools' own AI assistance. [devtools-frontend commit f66ca8e](https://chromium.googlesource.com/devtools/devtools-frontend/+/f66ca8e4bd64b0ea34bd49b99e1aa4df1758ebc9) A secondary account of a Paul Irish talk gives one example trace at about 15 million lines of JSON. [WorkOS: Chrome DevTools MCP](https://workos.com/blog/chrome-devtools-bringing-browser-state-to-your-coding-agent) The tool list has no animation tool. [chrome-devtools-mcp tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- **browser-use** sets `use_vision` to `True` (always screenshot), `False` (never, and no screenshot tool) or `"auto"` (tool available, used on request), with `vision_detail_level` low, high or auto. A separate `page_extraction_llm` can be a small model, because it "only needs to extract text from the page." Highlighted, indexed elements tie screenshot regions to DOM actions. [browser-use: agent parameters](https://docs.browser-use.com/customize/agent/all-parameters), [browser-use: browser parameters](https://docs.browser-use.com/customize/browser/all-parameters)
- **Stagehand** has three agent modes. DOM mode works from a hybrid accessibility tree. Hybrid mode adds coordinate tools that act from screenshots. CUA mode is screenshot-only through a provider's computer-use model. The default viewport is 1288×711 with a warning that other sizes "may reduce performance." [Stagehand: Agent](https://docs.stagehand.dev/v3/basics/agent) The reference names DOM as the default, while a 3.4 changelog entry, reported in search results, says hybrid became the default for compatible models. [Stagehand agent reference](https://docs.stagehand.dev/v3/references/agent)
- **Claude computer use** recommends 1024×768 or 1280×720 for desktops, and 1280×800 or 1366×768 for web apps, "avoid[ing] resolutions above 1920x1080." `zoom` provides full-resolution regions on demand. Retina screenshots should be halved. [Claude: Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

No agent tool surveyed hands motion to the model as motion. Each hands over still images, a video file written to disk, or text summaries of traces. The text-first defaults (Playwright MCP, Chrome DevTools MCP, browser-use `"auto"`) treat the image as an escalation the model asks for.

## 4. Where the standing approaches stop, taken together

- **Value tools and pixel tools are separate.** Chrome's and Firefox's panels show timing, easing and keyframes, but not pixels. Filmstrips, screencasts and diffs show pixels without the value or the animation id that produced them. Playwright's Trace Viewer ties screenshots to *actions*, not to animations.
- **Mechanism coverage is partial everywhere.** The CDP `Animation` domain covers CSS transitions, CSS animations and Web Animations, including View Transitions. Script-driven, canvas, WebGL, video and SMIL motion is outside it. Chrome documents the `requestAnimationFrame` gap. Library tools (GSDevTools, Lottie) each see one library.
- **Stabilisers erase transient faults.** Playwright, Chromatic and Percy freeze to an end or start state, so a fault visible only mid-run cannot appear in their output.
- **Sampling sets the shortest visible event.** The limits are 100 ms in WebPageTest's filmstrip, 25 to 30 fps in recorders, 1 fps in Gemini video, and every frame only in Performance screenshots and `beginFrame`.
- **Crops follow element boxes.** No surveyed crop follows the area a motion covered or the neighbours it displaced. The data for the displaced part exists for layout shifts (`previousRect` and `currentRect`, up to 5 sources).
- **Live tuning is narrow.** Chrome's panel drags duration, delay and keyframe offsets. CDP `setTiming` takes duration and delay only. Easing edits happen in Styles. Editors (After Effects, Rive, Jitter, Theatre.js) tune their own documents, not a running page.

## 5. Mapping onto the matrix

This section maps the findings onto the matrix's capabilities (`seen`, `row`, `solo`, `hold`, `slow`, `crop`, `flag`, `tune`, `env`) and names the scenarios each finding bears on. It records what exists elsewhere; it does not propose devharness's design.

**Seen.** For the `css-transition`, `css-keyframes`, `waapi` and `view-transition` mechanisms, CDP `Animation` events are the standing source, and Chrome's panel and Firefox's view rest on the same engine model. Scroll-driven animations arrive with `viewOrScrollTimeline` offsets (`scroll-bar`, `reveal`). For `frame-loop`, `timer-text`, `scroll-listener`, `gsap` and `lottie` (`details`, `sheet`, `typing`, `count`, `parallax`, `masthead`, `plans`, `envelope`), only library runtimes (GSDevTools for `plans`, the lottie-web API for `envelope`) or pixel capture register them. For `canvas`, `webgl` and `video` (`sky`, `spin`, `promo`), surveyed tools register only pixels. Chromatic and Percy treat video and GIF as things to pause rather than motion to read. SVG SMIL (`dot`) is not among the `Animation` types in CDP *(inference from the type enum)*, and Percy notes SVG animation is not reliably frozen.

**Row.** Chrome groups by start time ignoring delay, which fits `folders`' 13 animations and `tour`'s chain only if each starts in one task. The Trace Viewer and WebPageTest align frames to actions and to the network waterfall respectively, which bears on reply-driven rows (`load`, `send`, `star`, `refresh`, `search`). No surveyed tool keeps a repeating source as one row (`carousel`, `typing`, `marquee`). Chrome draws infinite iterations as repeats of one row but treats each new transition as a new animation.

**Solo.** CDP `setPaused` and `seekAnimations` act on a list of animation ids, so freezing all but one is expressible for the `Animation`-domain mechanisms. Chrome's panel replays a whole group, and GSDevTools selects one animation but scrubs it in the context of the global timeline (`globalSync`). No surveyed tool freezes every other motion on the page while one plays.

**Hold and step.** For held states, the standing primitives are `setPaused`, `seekAnimations` and document-timeline `setPlaybackRate(0)`. Frame-exact stepping with an image per step is `beginFrame`. For a clock that owns `requestAnimationFrame` and timers, Playwright's clock is the standing example (`runFor`). Lottie steps by frame (`goToAndStop(n, true)`). `badge` (one frame at 60 Hz) and `toast` (frame 0) are reachable only by per-frame capture: Performance screenshots, `beginFrame`, or a stepped clock. WebPageTest's 100 ms grid, Gemini's 1 fps and the end-state stabilisers miss both *(computed from the cited intervals)*.

**Slow.** The standing rates are Chrome's 100%, 25% and 10%, Firefox's dropdown, GSDevTools' timeScale and lottie-web's `setSpeed`. Each slows only the motion its tool owns. `backup`'s app-side `updatePlaybackRate(4)` meets the same document-timeline rate that CDP `setPlaybackRate` sets.

**Crop.** The standing forms are a CDP `clip`, element-scoped screenshots (Playwright MCP `target`, Chrome DevTools MCP `uid`) and Claude's `zoom` region. All of them crop to one box. For the matrix's rule (the smallest ancestor holding every box the motion occupied plus the elements it shifted), the nearest standing data are `LayoutShift` `previousRect` and `currentRect` (`live`, `load`, `remove`, `notices`) and per-frame boxes as in Set-of-Mark overlays. Claude's 28 px patch cost favours crops. Its sub-200 px accuracy warning bears on tiny targets such as `badge`'s `#count` and the `typing` dots. The 3×2 grid result (IG-VLM) is the standing evidence for tiling several crops into one image.

**Text flag.** Standing text flags are Chrome's non-composited animation reasons and Firefox's geometric-property tooltip (`folders` width, `plans` left, `masthead` and `details` height), dropped frames in the Performance Frames track (`sky`), and layout-shift entries (`load`, `live`). Faults readable from declared values rather than pixels are `badge`'s keyframe dip, `folders`' item-3 easing and item-5 delay, and `toast`'s timer cutting the fade-in at 70%. The surveyed tools display these as shapes and bar positions (Firefox easing outlines, Chrome bar positions) but state none of them in text. Faults that are the absence of motion (`remove`, `compose` close, `join`'s second press, `newest`'s Monday) show in filmstrips and onion skins as a jump between adjacent frames. No surveyed tool reports them as text.

**Tune.** Chrome's panel drags duration, delay and keyframe offsets, which CDP exposes only as `setTiming(duration, delay)`. Easing is edited in Styles with the Bézier and `linear()` editors. Matrix cells that need source edits (`count`'s divisor, `send`'s failure branch, `star`'s rollback, `like`'s cancel-before-animate) fall outside every surveyed tuning surface. Editors (After Effects, Rive, Jitter, Framer, Theatre.js) tune their own files, which bears on `envelope`'s JSON.

**Viewport and environment.** Chrome DevTools MCP's `emulate` sets `prefersReducedMotion`, viewport with device pixel ratio, and CPU throttling in one call. That covers `carousel`'s and `marquee`'s reduced-motion cells, and the width-dependent cells of `details`, `faq`, `folders`, `reveal`, `labels` and `sheet`. Frame-rate dependence (`badge`'s one frame at 60 Hz against two at 120 Hz) maps to `beginFrame`'s `interval` parameter. No other surveyed tool exposes frame rate as an input.

**Before and after.** The matrix's tune-and-replay loop corresponds to the comparison forms in section 2.9. Diff tools (Chromatic 2 Up and strobe, GitHub onion skin, Applitools Layout match) compare states. Only filmstrips on a shared time axis (WebPageTest compare, sitespeed.io's side-by-side video) compare timing.
