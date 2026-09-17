# Preact fixture

The same app as the React fixture, on Preact's dev transform. `npm install && npm run dev` serves it on 3103.

The two frameworks put their component and source information in different places, which is the point of
having both.

What a pick returns here:

| Field | Result |
| :--- | :--- |
| `component` | `StatusPill` |
| `source` | `StatusPill.jsx:3:10`, with `corrected: false` - Preact's transform reports the original line accurately |

Getting there takes a different route than React. Preact 10 keeps **no back-pointer from a DOM node to its
vnode** - `Object.keys(el)` on a rendered element is empty, where React leaves a `__reactFiber$…` key to
walk. What it does keep is the whole vnode tree on the container it rendered into, as an own `__k`. So the
walk goes up from the clicked element to find that container, then down the tree to the vnode whose `__e`
is the element.

One trap in that descent: a component vnode shares its element with the host it renders, so the first
match on the way down is the component's *call site* (`OrderRow.jsx:9`, where `<StatusPill />` appears).
The host vnode deeper in is the element itself. Taking the first match gives a plausible, wrong answer.
