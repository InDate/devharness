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
