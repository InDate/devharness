/** @jsxImportSource preact */
import type preact from 'preact';

/**
 * One stroked mark per control.
 *
 * The marks carry the controls where a word will not fit, and sit beside the
 * word where it does. Drawn rather than typed: a glyph font would be a second
 * download for eight shapes, and an emoji renders differently per platform.
 */
export function Glyph({ of }: { of: string }) {
  const marks: Record<string, preact.JSX.Element> = {
    restart: <><path d="M3.5 3v10" /><path d="M13 3 6 8l7 5z" /></>,
    replay: <><path d="M13 8a5 5 0 1 1-1.6-3.6" /><path d="M13.2 2.2v3h-3" /></>,
    step: <><path d="M3 3l7 5-7 5z" /><path d="M12.5 3v10" /></>,
    steps: <><path d="M1.5 3l5 5-5 5z" /><path d="M7 3l5 5-5 5z" /><path d="M14 3v10" /></>,
    play: <path d="M4 3l9 5-9 5z" />,
    headless: <><path d="M3 2.5l8 4.5-8 4.5z" /><rect x="10.6" y="10.6" width="3.8" height="3.8" rx="0.6" /></>,
    stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
    held: <><path d="M6 4v8" /><path d="M10 4v8" /></>,
    running: <path d="M5 3l8 5-8 5z" />,
    // A raised open hand, palm out: the gesture for stop and hold.
    hold: <><path d="M5.6 8.4V3.6a1.1 1.1 0 0 1 2.2 0V7.6" /><path d="M7.8 7.4V2.6a1.1 1.1 0 0 1 2.2 0v4.8" /><path d="M10 7.6V4a1.1 1.1 0 0 1 2.2 0v5.2a5 5 0 0 1-5 5h-.5a4 4 0 0 1-3-1.4L1.9 10.3a1.1 1.1 0 0 1 1.6-1.5l2.1 1.8" /></>,
    // Two shapes, not two colours: the hub is hollow while nothing is
    // carried and solid once something is, which reads at 13px where a
    // change of hue does not.
    cog: <><circle cx="8" cy="8" r="3" /><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" /></>,
    cogset: <><circle cx="8" cy="8" r="3" fill="currentColor" /><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" /></>,
    box: <rect x="2.6" y="4" width="10.8" height="8" rx="1" />,
    code: <><path d="M5.5 4.5 2 8l3.5 3.5" /><path d="M10.5 4.5 14 8l-3.5 3.5" /></>,
    screen: <><rect x="2" y="3" width="12" height="8.5" rx="1" /><path d="M6 14h4" /><path d="M8 11.5V14" /></>,
    network: <><path d="M2 6h10" /><path d="M9.5 3.5 12 6 9.5 8.5" /><path d="M14 10H4" /><path d="M6.5 7.5 4 10l2.5 2.5" /></>,
    trash: <><path d="M2.5 4.2h11" /><path d="M6.2 4.2V2.6h3.6v1.6" /><path d="M3.8 4.2l.8 9.2h6.8l.8-9.2" /><path d="M6.6 6.6v4.6M9.4 6.6v4.6" /></>,
    arrow: <><path d="M2.8 13.2 12.6 3.4" /><path d="M7.4 3.4h5.2v5.2" /></>,
    pen: <><path d="M2.6 13.4l1-3.2 6.7-6.7 2.2 2.2-6.7 6.7z" /><path d="M9.6 4.2l2.2 2.2" /></>,
    crop: <><path d="M4.4 1.6v10h10" /><path d="M1.6 4.4h10v10" /></>,
    undo: <><path d="M3 8a5 5 0 1 0 1.6-3.6" /><path d="M2.8 2.2v3.2H6" /></>,
    clear: <><path d="M3 4.4h10" /><path d="M6.4 4.4V3h3.2v1.4" /><path d="M4.4 4.4l.7 9h5.8l.7-9" /></>,
    tick: <path d="M3 8.4l3.2 3.2L13 4.8" />,
    // A beetle: body, head, and three legs a side.
    bug: <><path d="M6.2 5.4a1.8 1.8 0 0 1 3.6 0" /><ellipse cx="8" cy="9.4" rx="3.1" ry="4" /><path d="M8 6.2v7.2" /><path d="M4.9 8H2.8M4.9 10.6H3M11.1 8h2.1M11.1 10.6H13M5.5 6.4 4.3 5.2M10.5 6.4l1.2-1.2" /></>,
    // A four-point sparkle and a small one: something new.
    feature: <><path d="M7 2.2l1.2 3.3 3.3 1.2-3.3 1.2L7 11.2 5.8 7.9 2.5 6.7l3.3-1.2z" /><path d="M12.2 10.4v3.4M10.5 12.1h3.4" /></>,
    star: <path d="M8 1.9l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.9 4.1-.5z" />,
    starred: <path d="M8 1.9l1.8 3.8 4.1.5-3 2.9.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.9 4.1-.5z" fill="currentColor" />,
    // Two opening quotation marks: words taken from elsewhere into the text.
    quote: <><path d="M6.8 4C4.6 4.9 3.4 6.7 3.4 9.3V12h3.1V9H4.6" /><path d="M12.6 4c-2.2.9-3.4 2.7-3.4 5.3V12h3.1V9h-1.9" /></>,
    note: <><path d="M3.5 2.5h6.5l2.5 2.5v8.5h-9z" /><path d="M10 2.5V5h2.5" /><path d="M5.5 8h5M5.5 10.5h3.5" /></>,
    save: <><path d="M3 2.8h8.2l1.8 1.8v8.6H3z" /><path d="M5.4 2.8v3.4h5V2.8" /><path d="M5.4 13.2V9.4h5.2v3.8" /></>,
    cross: <><path d="M4 4l8 8" /><path d="M12 4l-8 8" /></>,
    // A boundary with something crossing it: what a proxy is for.
    proxy: <><path d="M8 1.4v2.6M8 6.7v2.6M8 12v2.6" /><path d="M1.8 8h11" /><path d="M10.2 5.6 12.8 8l-2.6 2.4" /></>,
    info: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4" /><path d="M8 4.9v.1" /></>,
    warning: <><path d="M8 1.8 14.6 13.6H1.4z" /><path d="M8 6.2v3.4" /><path d="M8 11.6v.1" /></>,
    error: <><circle cx="8" cy="8" r="6.2" /><path d="M5.8 5.8l4.4 4.4" /><path d="M10.2 5.8l-4.4 4.4" /></>,
    action: <><path d="M3 2.5l9 4.2-3.8 1.4-1.4 3.8z" /><path d="M8.6 8.6l4 4" /></>,
    variable: <><path d="M5.6 2.8c-1.4 0-2 .6-2 1.8v1.6c0 .9-.5 1.5-1.4 1.8.9.3 1.4.9 1.4 1.8v1.6c0 1.2.6 1.8 2 1.8" /><path d="M10.4 2.8c1.4 0 2 .6 2 1.8v1.6c0 .9.5 1.5 1.4 1.8-.9.3-1.4.9-1.4 1.8v1.6c0 1.2-.6 1.8-2 1.8" /></>,
    up: <><path d="M8 13V3.5" /><path d="M4.5 7 8 3.5 11.5 7" /></>,
    down: <><path d="M8 3v9.5" /><path d="M4.5 9 8 12.5 11.5 9" /></>,
    record: <circle cx="8" cy="8" r="4.2" fill="currentColor" />,
    baseline: <><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></>,
    before: <><path d="M3.5 3.5h9" /><path d="M4.5 11l3.5-3.5 3.5 3.5" /></>,
    after: <><path d="M3.5 12.5h9" /><path d="M4.5 5l3.5 3.5 3.5-3.5" /></>,
    // Out and back: a request and its response.
    request: <><path d="M2.5 5.5h10" /><path d="M10 3l2.5 2.5L10 8" /><path d="M13.5 10.5h-10" /><path d="M6 8l-2.5 2.5L6 13" /></>,
    // A message on an open connection.
    frame: <><path d="M2.5 3.5h11v7h-6.2l-3 2.6v-2.6H2.5z" /></>,
    store: <><ellipse cx="8" cy="4" rx="5" ry="1.8" /><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" /><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" /></>,
    timer: <><circle cx="8" cy="9" r="5.2" /><path d="M8 6.2V9l1.8 1.4" /><path d="M6.4 1.8h3.2" /></>,
    eye: <><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
    eyeoff: <><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z" /><path d="M2.5 13.5 13.5 2.5" /></>,
    new: <><path d="M8 3.2v9.6" /><path d="M3.2 8h9.6" /></>,
    capture: <><rect x="1.8" y="4" width="12.4" height="9" rx="1.5" /><circle cx="8" cy="8.5" r="2.6" /><path d="M5.8 4l1-1.5h2.4l1 1.5" /></>,
    // Three steps joined in order, each with its line.
    sequence: <><circle cx="3.4" cy="3.4" r="1.4" /><circle cx="3.4" cy="8" r="1.4" /><circle cx="3.4" cy="12.6" r="1.4" /><path d="M3.4 4.8v1.8M3.4 9.4v1.8" /><path d="M7 3.4h6.6M7 8h6.6M7 12.6h4.6" /></>,
    // A clock face with its hand turned back: what has already run.
    history: <><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" /><path d="M2.4 2.2v3h3" /><path d="M8 5.2V8l2 1.4" /></>,
    // A wrench.
    tools: <path d="M10.4 1.9a3.4 3.4 0 0 0-3.8 4.6l-4.3 4.3a1.4 1.4 0 0 0 2 2l4.3-4.3a3.4 3.4 0 0 0 4.6-3.8l-2.1 2.1-1.9-.4-.4-1.9z" />,
    // A trace with a beat in it: something live.
    pulse: <path d="M1.4 8.6h3l1.8-4.8 3.4 8.4 1.8-3.6h3.2" />,
    picker: <><path d="M8 1.5v3.5" /><path d="M8 11v3.5" /><path d="M1.5 8H5" /><path d="M11 8h3.5" /><circle cx="8" cy="8" r="2" /></>,
  };
  // `goto:<mark>` draws the tab a go-to lands on, with an arrow badged on its
  // top-right corner where a tab carries its count.
  if (of.startsWith('goto:')) {
    return (
      <span class="gotomark">
        <Glyph of={of.slice('goto:'.length)} />
        <span class="gotoarrow">
          <svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true" focusable="false"
            fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1.6 6.4 6.4 1.6" /><path d="M2.8 1.6h3.6v3.6" />
          </svg>
        </span>
      </span>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round">
      {marks[of]}
    </svg>
  );
}
