/** @jsxImportSource preact */
import type preact from 'preact';
import { Glyph } from './glyph.js';

const WINDOW = <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5" /><path d="M1.8 5.6h12.4" /></>;
const PLUG = <path d="M5.5 2.2v3M10.5 2.2v3M3.6 5.2h8.8v2.6a4.4 4.4 0 0 1-8.8 0zM8 12.2v2" />;

/** Tools whose mark the bench already draws for the same thing elsewhere. */
const SHARED: Record<string, string> = {
  proxy: 'proxy',
  screenshot: 'capture',
  replay: 'replay',
  wait: 'timer',
  config: 'cog',
};

const MARKS: Record<string, preact.JSX.Element> = {
  connection: PLUG,
  browser: <>{WINDOW}<path d="M6.2 7.8l3.6 3.6M9.8 7.8l-3.6 3.6" /></>,
  breakpoint: <path d="M2.2 4h8.4L14 8l-3.4 4H2.2z" />,
  execution: <path d="M2.6 3.6 7.6 8l-5 4.4zM10.6 3.6v8.8M13.4 3.6v8.8" />,
  inspect: <><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 14 14" /></>,
  source: <path d="M5.4 4 1.8 8l3.6 4M10.6 4l3.6 4-3.6 4" />,
  console: <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5" /><path d="M4.6 6.4 6.8 8.4l-2.2 2M8.6 10.6h2.8" /></>,
  network: <><circle cx="8" cy="8" r="6.2" /><ellipse cx="8" cy="8" rx="2.6" ry="6.2" /><path d="M1.8 8h12.4" /></>,
  hold: <><circle cx="8" cy="8" r="6.2" /><path d="M6.6 5.6v4.8M9.4 5.6v4.8" /></>,
  navigate: <><circle cx="8" cy="8" r="6.2" /><path d="M10.6 5.4 9.2 9.2l-3.8 1.4L6.8 6.8z" /></>,
  dom: <><rect x="6" y="1.8" width="4" height="3" rx=".6" /><rect x="1.8" y="11.2" width="4" height="3" rx=".6" /><rect x="10.2" y="11.2" width="4" height="3" rx=".6" /><path d="M8 4.8v3M3.8 7.8h8.4M3.8 7.8v3.4M12.2 7.8v3.4" /></>,
  download: <path d="M8 2v8.4M4.6 7.2 8 10.6l3.4-3.4M2.4 13.6h11.2" />,
  input: <path d="M3.4 2.4l9.2 4.2-4 1.4-1.4 4zM8.6 8l4.4 4.4" />,
  content: <path d="M2.6 3.4h10.8M2.6 6.4h10.8M2.6 9.4h10.8M2.6 12.4h6.4" />,
  modal: <>{WINDOW}<rect x="4.6" y="7.4" width="6.8" height="4" rx=".6" /></>,
  bench: <>{WINDOW}<path d="M8 5.6v7.6" /></>,
  storage: <><ellipse cx="8" cy="3.8" rx="5" ry="1.8" /><path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" /></>,
  request: <path d="M14 2 1.8 7l5 1.8L8.8 14zM14 2 6.8 8.8" />,
  assert: <><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8.2l2 2 3.6-4" /></>,
  check: <path d="M2.4 4.4l1.2 1.2L6 3.2M8 4.4h5.6M2.4 10.6l1.2 1.2L6 9.4M8 10.6h5.6" />,
  server: <><rect x="2" y="2.4" width="12" height="4.6" rx="1" /><rect x="2" y="9" width="12" height="4.6" rx="1" /><path d="M4.6 4.7h.1M4.6 11.3h.1" /></>,
  issues: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v3.8M8 11v.1" /></>,
  dashboard: <><rect x="1.8" y="1.8" width="5.2" height="5.2" rx="1" /><rect x="9" y="1.8" width="5.2" height="5.2" rx="1" /><rect x="1.8" y="9" width="5.2" height="5.2" rx="1" /><rect x="9" y="9" width="5.2" height="5.2" rx="1" /></>,
  message: <path d="M2 3.4h12v7.4H7.2l-3 2.6v-2.6H2z" />,
};

const TOGGLE = <rect x="1.8" y="4.8" width="12.4" height="6.4" rx="3.2" />;

/**
 * Marks for the actions of the tools that took over single-operation tools,
 * `tool.action`: each is the mark that tool carried before it became an action.
 */
const ACTION_MARKS: Record<string, preact.JSX.Element> = {
  'connection.launch': <>{WINDOW}<path d="M6.6 7.6v3.6l3-1.8z" /></>,
  'connection.attach': PLUG,
  'connection.list': <path d="M5.6 4h8M5.6 8h8M5.6 12h8M2.4 4h.1M2.4 8h.1M2.4 12h.1" />,
  'connection.switch': <path d="M3 5.4h9.6M10.2 3l2.4 2.4-2.4 2.4M13 10.6H3.4M5.8 8.2 3.4 10.6 5.8 13" />,
  'connection.rename': <path d="M1.8 13.2h12.4M2.8 13.2V4.6h4.6v8.6M7.4 7h5.8v6.2" />,
  'connection.close': <>{PLUG}<path d="M2.2 13.8 13.8 2.2" /></>,
  'connection.status': <><ellipse cx="8" cy="9.2" rx="3.2" ry="4" /><path d="M8 5.2v8M4.8 7.6H2.4M11.2 7.6h2.4M4.8 10.8H2.4M11.2 10.8h2.4M6.2 3.6 5.2 2M9.8 3.6l1-1.6" /></>,
  'connection.browsers': <>{WINDOW}<path d="M4 9.6h1.8l1-1.8 1.6 3 1-1.2H12" /></>,
  'browser.kill': <>{WINDOW}<path d="M6.2 7.8l3.6 3.6M9.8 7.8l-3.6 3.6" /></>,
  'browser.resetLauncher': <>{WINDOW}<path d="M10.4 9.6a2.4 2.4 0 1 1-.8-1.8" /><path d="M9.8 7v1.4H8.4" /></>,
  'source.get': <path d="M5.4 4 1.8 8l3.6 4M10.6 4l3.6 4-3.6 4" />,
  'source.loadMaps': <path d="M1.8 4.2 5.8 2.6l4.4 1.6 4-1.6v9.6l-4 1.6-4.4-1.6-4 1.6zM5.8 2.6v9.6M10.2 4.2v9.6" />,
  'modal.detect': <>{WINDOW}<rect x="4.6" y="7.4" width="6.8" height="4" rx=".6" /></>,
  'modal.dismiss': <>{WINDOW}<path d="M6.4 7.6l3.2 3.2M9.6 7.6l-3.2 3.2" /></>,
  'config.setDebugLogging': <>{TOGGLE}<circle cx="11" cy="8" r="1.6" fill="currentColor" /></>,
  'config.debugLoggingStatus': <>{TOGGLE}<circle cx="5" cy="8" r="1.6" /></>,
};

function Mark({ children }: { children: preact.ComponentChildren }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round">
      {children}
    </svg>
  );
}

/** One stroked mark per tool, drawn like the bench's other glyphs; a plain box for a tool with none. */
export function ToolGlyph({ tool }: { tool: string }) {
  if (SHARED[tool]) return <Glyph of={SHARED[tool]} />;
  return <Mark>{MARKS[tool] ?? <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" />}</Mark>;
}

/** Whether `tool`'s `action` carries a mark of its own. */
export function hasActionMark(tool: string, action: string): boolean {
  return `${tool}.${action}` in ACTION_MARKS;
}

/** The mark of one action, where the action was a tool of its own; null for the rest. */
export function ActionGlyph({ tool, action }: { tool: string; action: string }) {
  const mark = ACTION_MARKS[`${tool}.${action}`];
  return mark ? <Mark>{mark}</Mark> : null;
}
