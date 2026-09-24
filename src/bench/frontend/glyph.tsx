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
    play: <path d="M4 3l9 5-9 5z" />,
    stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
    held: <><path d="M6 4v8" /><path d="M10 4v8" /></>,
    running: <path d="M5 3l8 5-8 5z" />,
    freeze: <><path d="M8 1.5v13" /><path d="M2.2 4.8 13.8 11.2" /><path d="M2.2 11.2 13.8 4.8" /><path d="M5.4 3.2 8 5.1l2.6-1.9" /><path d="M5.4 12.8 8 10.9l2.6 1.9" /></>,
    // Two shapes, not two colours: the hub is hollow while nothing is
    // carried and solid once something is, which reads at 13px where a
    // change of hue does not.
    cog: <><circle cx="8" cy="8" r="3" /><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" /></>,
    cogset: <><circle cx="8" cy="8" r="3" fill="currentColor" /><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" /></>,
    box: <rect x="2.6" y="4" width="10.8" height="8" rx="1" />,
    arrow: <><path d="M2.8 13.2 12.6 3.4" /><path d="M7.4 3.4h5.2v5.2" /></>,
    pen: <><path d="M2.6 13.4l1-3.2 6.7-6.7 2.2 2.2-6.7 6.7z" /><path d="M9.6 4.2l2.2 2.2" /></>,
    crop: <><path d="M4.4 1.6v10h10" /><path d="M1.6 4.4h10v10" /></>,
    undo: <><path d="M3 8a5 5 0 1 0 1.6-3.6" /><path d="M2.8 2.2v3.2H6" /></>,
    clear: <><path d="M3 4.4h10" /><path d="M6.4 4.4V3h3.2v1.4" /><path d="M4.4 4.4l.7 9h5.8l.7-9" /></>,
    tick: <path d="M3 8.4l3.2 3.2L13 4.8" />,
    cross: <><path d="M4 4l8 8" /><path d="M12 4l-8 8" /></>,
    // A boundary with something crossing it: what a proxy is for.
    proxy: <><path d="M8 1.4v2.6M8 6.7v2.6M8 12v2.6" /><path d="M1.8 8h11" /><path d="M10.2 5.6 12.8 8l-2.6 2.4" /></>,
    info: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4" /><path d="M8 4.9v.1" /></>,
    new: <><path d="M8 3.2v9.6" /><path d="M3.2 8h9.6" /></>,
    capture: <><rect x="1.8" y="4" width="12.4" height="9" rx="1.5" /><circle cx="8" cy="8.5" r="2.6" /><path d="M5.8 4l1-1.5h2.4l1 1.5" /></>,
    picker: <><path d="M8 1.5v3.5" /><path d="M8 11v3.5" /><path d="M1.5 8H5" /><path d="M11 8h3.5" /><circle cx="8" cy="8" r="2" /></>,
  };
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round">
      {marks[of]}
    </svg>
  );
}
