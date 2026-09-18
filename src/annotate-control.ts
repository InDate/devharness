/**
 * The annotate control pane - a second tab holding the comment box, the tick
 * controls and the list of what has been recorded.
 *
 * It lives outside the page being annotated for two reasons. The page is frozen
 * with `Debugger.pause`, so its JS does not run at all and an injected box could
 * not accept a keystroke. And keeping the UI out of the page means the page's
 * own DOM is never modified by the act of annotating it.
 *
 * Served from 127.0.0.1 while apps are typically on localhost - a different
 * site, so Chrome gives the control pane its own renderer process and a hard
 * freeze on the app pane cannot take it down with it.
 *
 * Every route is behind a random token in the path. The server accepts writes
 * (an annotation, a tick), and any page in any browser can reach a localhost
 * port; the token is what stops one that was not handed the URL.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { getOutputPath } from './helpers/paths.js';
import type { Annotation, AnnotationTarget, CallbackEntry, SequenceState, TickResult } from './annotate-mode.js';

export interface ControlHandlers {
  getState: () => Promise<ControlState>;
  save: (comment: string) => Promise<void>;
  discard: () => Promise<void>;
  tick: (request: { steps?: number; budgetMs?: number }) => Promise<void>;
  setPicker: (armed: boolean) => Promise<void>;
  setFrozen: (frozen: boolean) => Promise<void>;
  selectSequence: (name: string) => Promise<void>;
  gotoSequenceStep: (step: number) => Promise<void>;
  stepSequence: () => Promise<void>;
  playSequence: () => Promise<void>;
  cancelSequence: () => Promise<void>;
  removeSequence: (name: string) => Promise<void>;
  dismissFailure: () => Promise<void>;
  /** What the proxy has seen, when this browser was launched through one. */
  proxyEvents: (sinceId: string | null) => Promise<{
    running: boolean;
    allowed: string[];
    refused: number;
    events: Array<Record<string, unknown>>;
  }>;
  /** The payload kept for one event, for reading and for holding. */
  proxyBody: (id: string) => Promise<string | null>;
  /** Answer this from now on with what it answered here. */
  proxyHold: (id: string) => Promise<string>;
  recordSequence: (name: string, withAgent: boolean) => Promise<void>;
  stopRecordingSequence: () => Promise<void>;
  cancelRecordingSequence: () => Promise<void>;
  removeSequenceStep: (index: number) => Promise<void>;
  moveSequenceStep: (from: number, to: number) => Promise<void>;
  setSequenceVariable: (name: string, value: string) => Promise<void>;
  removeSequenceVariable: (name: string) => Promise<void>;
  keepRecordedStep: () => Promise<void>;
  flagRecordedStep: (reason: string, options?: Array<{ selector: string; note: string }>, detail?: string) => Promise<void>;
  chooseStepSelector: (index: number) => Promise<void>;
  dropRecordedStep: () => Promise<void>;
  noteAtStep: (step: number) => Promise<void>;
  removeAnnotation: (id: string) => Promise<void>;
  notifyAnnotation: (id: string) => Promise<void>;
  /** No selector captures the page; a selector captures that element's box. */
  captureScreenshot: (selector: string | undefined, widen: number, annotationId?: string) => Promise<void>;
  saveScreenshot: () => Promise<void>;
  discardScreenshot: () => Promise<void>;
  highlightAnnotation: (selector: string) => Promise<void>;
  setBaseUrl: (baseUrl: string) => Promise<void>;
}

export interface ControlState {
  connection: string;
  url: string;
  frozen: boolean;
  pickerArmed: boolean;
  tickMs: number;
  totalSteps: number;
  lastTick?: TickResult;
  /** Tail of the callback log, oldest first. */
  callbacks: CallbackEntry[];
  /** Absent when no sequence driver is wired in. */
  sequence?: SequenceState;
  pending: AnnotationTarget | null;
  /** Step the next saved note attaches to, when a step row named one. */
  noteStep?: number;
  /** The step a note would land on right now, chosen or fallen back to. */
  noteTarget?: number;
  noteTargetLabel?: string;
  /** A capture taken and waiting on the person. */
  shot?: { data: string; selector?: string; widen: number; label: string; annotationId?: string };
}

export interface ControlServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * The control pane, served whole. Exported so its script can be driven against
 * a DOM in tests - the pane holds behaviour a person depends on, such as a
 * delete button that has to survive the poll that redraws it.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devharness annotate</title>
<style>
  :root {
    --bg: #ffffff; --fg: #202124; --muted: #5f6368; --line: #e0e0e0;
    --accent: #1a73e8; --panel: #f5f5f5; --warn: #b26500;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1f1f1f; --fg: #e8eaed; --muted: #9aa0a6; --line: #3c4043;
      --accent: #8ab4f8; --panel: #2a2a2a; --warn: #fdd663;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  h1 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; word-break: break-all; }
  #inertTag { margin-left: 8px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px;
              font: 10px -apple-system, sans-serif; letter-spacing: 0.5px; color: var(--muted);
              vertical-align: middle; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .idle { color: var(--muted); }
  .target { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel);
            border-radius: 6px; padding: 10px; margin-bottom: 12px; white-space: pre-wrap; word-break: break-all; }
  .component { color: var(--accent); font-weight: 600; }
  textarea { width: 100%; height: 84px; padding: 10px; border: 1px solid var(--line); border-radius: 6px;
             background: var(--bg); color: var(--fg); font: inherit; resize: vertical; }
  /* The browser's own [hidden] rule is a bare attribute selector, so any rule
     here carrying an id or a class outranks it and the element stays on screen
     with .hidden = true set against it. */
  [hidden] { display: none !important; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .grow { flex: 1; }
  button { cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
           border-radius: 6px; padding: 7px 13px; font: 500 12px -apple-system, sans-serif; letter-spacing: 0.3px; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.on { border-color: var(--accent); color: var(--accent); font-weight: 700; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .ctl .ctlhead { align-items: center; }
  .ctl .bicon { display: none; line-height: 0; }
  .ctl .chev { padding: 2px 6px; border-color: transparent; color: var(--muted); line-height: 1; }
  .ctl .chev:hover { color: var(--accent); }
  .ctl.collapsed .ctlbody { display: none; }
  .ctl.collapsed .bicon { display: inline-block; }
  .ctl.collapsed .blab { display: none; }
  .ctl.collapsed button { padding: 5px 8px; }
  .ctl .headstep { display: none; }
  .ctl.collapsed .headstep { display: inline-block; }
  button.save { background: #188038; border-color: #188038; color: #fff; font-weight: 600; }
  button.save:hover { background: #146c30; border-color: #146c30; }
  button.danger { color: #d93025; border-color: #d93025; font-size: 10px; letter-spacing: 0.4px; }
  button.danger:hover { background: #d93025; color: #fff; }
  /* The armed state has to read as a different button, or the second click
     lands on what still looks like the first one. */
  button.danger.armed { background: #d93025; color: #fff; font-weight: 700; }
  .hint { color: var(--muted); font-size: 12px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid var(--line); padding: 10px 0; font-size: 13px; }
  li .where { font: 11px ui-monospace, Menlo, monospace; color: var(--muted); word-break: break-all; }
  .tickbar { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }
  .log { max-height: 220px; overflow-y: auto; font: 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .log .line { display: flex; gap: 8px; border-top: 1px solid var(--line); padding: 3px 0; white-space: nowrap; }
  .log .line:first-child { border-top: 0; }
  .log .n { color: var(--muted); width: 34px; text-align: right; flex: none; }
  .log .t { color: var(--muted); width: 64px; flex: none; }
  .log .k { color: var(--accent); width: 96px; flex: none; overflow: hidden; text-overflow: ellipsis; }
  .log .w { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  select { padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
           color: var(--fg); font: inherit; font-size: 12px; max-width: 260px; }
  .cardlabel { font: 600 11px -apple-system, sans-serif; letter-spacing: 0.6px; color: var(--muted); }
  .seqdesc { color: var(--muted); font-size: 12px; margin: 6px 0 0; }

  .transport { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
  .tbtn { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 46px;
          padding: 6px 8px; font-size: 15px; line-height: 1; }
  .tbtn span { font: 500 9px -apple-system, sans-serif; letter-spacing: 0.4px; color: var(--muted); }
  .tbtn.play { background: var(--accent); border-color: var(--accent); color: #fff; font-size: 17px; }
  .tbtn.play span { color: rgba(255,255,255,0.85); }
  .tbtn:disabled span { color: var(--muted); }
  .progress { flex: 1; height: 5px; background: var(--panel); border-radius: 3px; overflow: hidden; }
  .progress .bar { height: 100%; width: 0; background: var(--accent); transition: width 160ms ease; }

  /* A step waiting on a decision, not an error: a left rule rather than a box,
     the question first, the detail under it, the choices as the loud part. */
  .held { margin: 6px 0 2px 24px; padding: 2px 0 2px 12px; border-left: 2px solid var(--line);
          font-size: 12px; color: var(--muted); }
  .held.flagged { border-left-color: #e8a33d; }
  .heldhead { font-size: 13px; color: var(--fg); }
  .held.flagged .heldhead { font-weight: 600; }
  .helddetail { margin-top: 3px; font-size: 11px; color: var(--muted); }
  .optrow { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%;
            margin-top: 6px; padding: 8px 10px; text-align: left; border-radius: 6px; }
  .optrow:hover { border-color: var(--accent); background: var(--panel); }
  .optsel { font: 11px/1.5 ui-monospace, Menlo, monospace; color: var(--fg); word-break: break-all; }
  .optnote { font-size: 11px; color: var(--muted); }
  .heldacts { display: flex; gap: 12px; margin-top: 8px; }
  button.quiet { border: 0; padding: 0; background: none; color: var(--muted); font-size: 11px;
                 text-decoration: underline; text-underline-offset: 2px; }
  button.quiet:hover { color: var(--accent); }
  button.quiet.drop:hover { color: #d93025; }
  .failure { display: flex; gap: 8px; align-items: center; margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 12px;
             background: rgba(217,48,37,0.12); color: #d93025; }
  @media (prefers-color-scheme: dark) { .failure { color: #f28b82; } }

  .steps { list-style: none; margin: 12px 0 0; padding: 0; max-height: 46vh; overflow-y: auto; }
  .steps li { padding: 7px 0; border-top: 1px solid var(--line); }
  .steps li:first-child { border-top: 0; }
  .steps .head { display: flex; gap: 8px; align-items: baseline; }
  .steps .mark { width: 16px; flex: none; text-align: center; color: var(--muted); font-size: 11px; }
  .steps .what { font-size: 13px; }
  .steps .call, .steps .res { display: block; margin-left: 24px; font: 11px/1.7 ui-monospace, Menlo, monospace;
                              color: var(--muted); word-break: break-all; }
  .steps .res { color: var(--accent); }
  .steps li.done .what { color: var(--muted); }
  .steps li.now { background: var(--panel); border-radius: 6px; padding-left: 6px; padding-right: 6px; }
  .steps li.now .mark, .steps li.now .what { color: var(--accent); font-weight: 600; }
  .steps li.fail .mark, .steps li.fail .what { color: #d93025; }

  .note { display: block; overflow: visible; margin: 6px 0 0 24px; padding: 6px 8px;
          background: var(--panel); border-left: 2px solid var(--accent); border-radius: 0 6px 6px 0; }
  .note .nrow { display: flex; gap: 8px; align-items: baseline; }
  .note .ntext { font-size: 12px; flex: 1; line-height: 1.45; }
  #shotImg { display: block; width: 100%; max-height: 320px; object-fit: contain;
             margin-top: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  .note .nmeta { margin-top: 4px; font: 10px ui-monospace, Menlo, monospace; color: var(--muted); }
  .note .ntext { position: relative; }
  .nshots { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .nshots img { height: 54px; width: 86px; object-fit: cover; cursor: zoom-in; flex: none;
                border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
  .nshots img:hover { border-color: var(--accent); }
  #shotModal { position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 50;
               display: flex; align-items: center; justify-content: center; padding: 20px; }
  #shotModalBox { display: flex; flex-direction: column; gap: 8px; align-items: stretch;
                  max-width: 94vw; max-height: 92vh; }
  #shotModalBox .mtitle { font-size: 14px; color: #fff; font-weight: 600; }
  #shotModalBox .msel { font: 11px ui-monospace, Menlo, monospace; color: #9aa; word-break: break-all; }
  #shotModalImages { overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                     padding-right: 4px; }
  #shotModalImages figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
  #shotModalImages img { max-width: 94vw; object-fit: contain; align-self: flex-start;
                         border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  #shotModalImages figcaption { font: 10px ui-monospace, Menlo, monospace; color: #9aa; }
  #shotModalBox .mname { font: 11px ui-monospace, Menlo, monospace; color: #ddd; }
  .note .nsel { display: none; position: absolute; inset: 0; overflow: hidden;
                font: 11px/1.45 ui-monospace, Menlo, monospace; color: var(--muted); word-break: break-all; }
  .note:hover .ncomment { visibility: hidden; }
  .note:hover .nsel { display: block; }
  .note .goback { padding: 2px 8px; font-size: 10px; }
  button.icon { display: inline-flex; align-items: center; justify-content: center;
                padding: 4px 6px; line-height: 0; }
  .note .ndrop { color: #d93025; border-color: transparent; }
  .note .ndrop:hover { border-color: #d93025; }
  .note:hover { outline: 1px solid var(--accent); }
  .steps li { position: relative; }
  /* No transition: it restarts on each rebuild and reads as a pulse. */
  /* Kept out of the way until the row is hovered: a list of steps reads worse
     with three controls on every line. */
  .steptools { display: flex; gap: 2px; align-items: center; margin-left: auto; opacity: 0; }
  .steps li:hover .steptools, .steptools.armed { opacity: 1; }
  .steptools button { padding: 1px 5px; font-size: 10px; line-height: 15px; border-color: transparent; }
  .steptools button:hover { border-color: var(--accent); }
  .steptools .stepdrop:hover { border-color: #d93025; color: #d93025; }
  .steps .addnote { padding: 1px 4px; border-color: transparent; line-height: 0; color: var(--muted); }
  .steps .addnote:hover { border-color: var(--accent); color: var(--accent); }
  /* The armed step stays lit once the pointer leaves the row, or there is
     nothing on screen saying where the next pick will be filed. */
  .steps .addnote.armed { border-color: var(--accent); color: var(--accent); }

  .steps .addnote svg { display: block; }

  /* Sits under the step it belongs to, quieter than the step itself: it is
     evidence for the step, not another step. */
  .traffic { margin: 4px 0 2px 24px; padding: 3px 0 3px 10px; border-left: 2px solid var(--line);
             font: 11px/1.6 ui-monospace, Menlo, monospace; color: var(--muted); }
  .traffic .thead { color: var(--fg); font: 11px -apple-system, sans-serif; letter-spacing: .3px; }
  .traffic .tfail { color: #d93025; }

  .tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
  .tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 12px;
         background: none; color: var(--muted); font-size: 11px; letter-spacing: .5px; }
  .tab:hover { color: var(--fg); }
  .tab.on { color: var(--fg); border-bottom-color: var(--accent); }
  .tabcount { color: var(--muted); font-size: 10px; }

  .events { list-style: none; margin: 8px 0 0; padding: 0;
            font: 11px/1.6 ui-monospace, Menlo, monospace; max-height: 460px; overflow: auto; }
  /* A pill per event rather than ruled rows: a separator between every line
     reads as a table, and this is a stream. */
  .events li { background: var(--panel); border: 1px solid transparent; border-radius: 7px;
               padding: 5px 9px; margin-bottom: 3px; }
  .events li:hover { border-color: var(--line); }
  .events li.open { border-color: var(--accent); }
  .evhead { display: flex; gap: 9px; align-items: baseline; cursor: pointer; }
  .events .evdir { flex: 0 0 30px; color: var(--muted); }
  .events .evurl { flex: 1; word-break: break-all; }
  .events .evmeta { flex: 0 0 auto; color: var(--muted); }
  .events .held { color: #e8a33d; }
  .events .bad { color: #d93025; }
  /* Symbols while collapsed, words once open: a control you have not used
     before is a guess until it is named. */
  .evtools { display: flex; gap: 4px; margin-left: 8px; opacity: 0; }
  .events li:hover .evtools, .events li.open .evtools { opacity: 1; }
  .evtools button { padding: 0 5px; font-size: 10px; line-height: 16px; border-color: transparent; }
  .evtools button:hover { border-color: var(--accent); color: var(--accent); }
  .evbody { margin-top: 6px; padding: 7px 9px; background: var(--bg); border-radius: 5px;
            white-space: pre-wrap; word-break: break-all; max-height: 230px; overflow: auto;
            color: var(--muted); }
  /* Only while the list is scrolled away from the top: at the top the newest
     row is already on screen and a button would announce what is visible. */
  .newabove { width: 100%; margin-top: 8px; padding: 5px; border-radius: 6px;
              border-color: var(--accent); color: var(--accent);
              font-size: 10px; letter-spacing: .5px; }
  .evactions { display: flex; gap: 8px; margin-top: 7px; }
  .evactions button { font-size: 10px; letter-spacing: .4px; padding: 4px 9px; }

  .vars { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  .vars ol { list-style: none; margin: 8px 0 0; padding: 0; }
  .varrow { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .varrow input { flex: 1; min-width: 80px; padding: 5px 7px; border: 1px solid var(--line);
                  border-radius: 5px; background: var(--bg); color: var(--fg);
                  font: 11px ui-monospace, Menlo, monospace; }
  .varrow .vnameinput { flex: 0 0 120px; }
  .vlabel { flex: 0 0 96px; font-size: 11px; color: var(--muted); }
  .vars li { display: flex; gap: 10px; align-items: baseline; padding: 4px 0;
             font: 12px ui-monospace, Menlo, monospace; }
  .vars .vname { color: var(--fg); min-width: 84px; }
  .vars .vval { color: var(--accent); flex: 1; word-break: break-all; }
  .vars .vsrc { color: var(--muted); font-size: 11px; flex: none; }
  .vars .vfields { margin: 2px 0 6px 94px; }
  .vars .vfields div { color: var(--muted); font: 11px ui-monospace, Menlo, monospace; }
  .unit { font: 600 11px -apple-system, sans-serif; letter-spacing: 0.5px; color: var(--muted); width: 52px; }
  #seqRecName { flex: 1; min-width: 180px; padding: 6px 8px; border: 1px solid var(--line);
                border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; }
  #seqBase { flex: 1; min-width: 180px; padding: 6px 8px; border: 1px solid var(--line);
             border-radius: 6px; background: var(--bg); color: var(--fg);
             font: 12px ui-monospace, Menlo, monospace; }
  input[type=number] { width: 72px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
                       background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; }
</style>
</head>
<body>
<h1>devharness annotate<span id="inertTag" hidden>inert</span></h1>
<div class="sub" id="sub">connecting…</div>

<div class="tabs">
  <button class="tab on" data-tab="annotate">ANNOTATE</button>
  <button class="tab" data-tab="proxy">PROXY <span class="tabcount" id="proxyCount"></span></button>
</div>

<div id="shotModal" hidden>
  <div id="shotModalBox">
    <div class="mtitle" id="shotModalTitle"></div>
    <div class="msel" id="shotModalSel"></div>
    <div id="shotModalImages"></div>
    <div class="mname">click outside, or Esc, to close</div>
  </div>
</div>

<div class="card ctl collapsed" id="ctlCard">
  <div class="row ctlhead" style="margin-top:0">
    <button id="ctlToggle" class="chev" title="expand the controls">▸</button>
    <button id="picker" title="arm the element picker">
      <span class="bicon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11Z"/></svg></span>
      <span class="blab" id="pickerLabel">ARM PICKER</span>
    </button>
    <button id="freeze" title="hold the page or let it run">
      <span class="bicon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v16M15 4v16"/></svg></span>
      <span class="blab" id="freezeLabel">RUNNING</span>
    </button>
    <button data-steps="1" class="headstep" title="run one callback, then hold">
      <span class="bicon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l9 7-9 7ZM19 5v14"/></svg></span>
      <span class="blab">+1</span>
    </button>
    <button id="shot" class="icon" title="save a picture of the page">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </button>
    <span class="grow"></span>
    <span class="tickbar" id="tickbar">0 callbacks · 0ms</span>
  </div>

  <div class="ctlbody">
    <div class="row">
      <strong class="unit">STEP</strong>
      <button data-steps="1">+1</button>
      <button data-steps="5">+5</button>
      <button data-steps="25">+25</button>
      <span class="hint">callback<span class="hint"> — one thing the page does</span></span>
    </div>
    <div class="row">
      <strong class="unit">RUN TO</strong>
      <button data-ms="100">+100ms</button>
      <button data-ms="500">+500ms</button>
      <input id="ms" type="number" min="1" step="50" placeholder="ms" />
      <button id="msGo">GO</button>
    </div>
    <div class="row"><span class="hint" id="lastTick">A step runs the page to its next scheduled callback, then freezes again. Callbacks are exact; a time target runs as many as it takes and reports where it landed.</span></div>
    <div class="row"><span class="hint">FREEZE holds the page; RUNNING lets it go so the app can be driven. Picking works in either state - the picker is Chrome's, not the page's - but while the page is frozen its JS is stopped, so a click on the app reaches nothing.</span></div>
  </div>
</div>

<div class="card" id="seqCard" hidden>
  <div class="row" style="margin-top:0" id="seqPickRow">
    <strong class="cardlabel">SEQUENCE</strong>
    <select id="seqPick"><option value="">select a sequence…</option></select>
    <button id="seqNew" title="record a new sequence from what you click">NEW</button>
    <button id="seqDelete" class="danger" title="erase this sequence from disk">DELETE</button>
  </div>
  <div class="row" id="seqNewRow" hidden>
    <strong class="unit" style="width:auto">RECORD</strong>
    <input id="seqRecName" type="text" placeholder="name a new sequence, then click through the app" />
    <button id="seqRecord">START</button>
    <button id="seqRecordLlm" title="record with the agent watching: it reviews what was captured before it is saved">START (WITH LLM)</button>
    <button id="seqRecordCancel" class="danger" hidden title="abandon this recording, saving nothing">CANCEL</button>
  </div>
  <div class="seqdesc" id="seqDesc"></div>
  <div class="transport">
    <button id="seqReset" class="tbtn" title="drop the run">⏮<span>reset</span></button>
    <button id="seqPlay" class="tbtn play" title="run to the end">▶<span>play</span></button>
    <button id="seqStep" class="tbtn" title="run one action, then hold">⏭<span>step</span></button>
    <div class="progress"><div class="bar" id="seqBar"></div></div>
    <span class="tickbar" id="seqPos"></span>
  </div>

  <div class="failure" id="seqFail" hidden>
    <span class="grow" id="seqFailText"></span>
    <button id="seqFailClose" title="dismiss">✕</button>
  </div>
  <ol class="steps" id="seqSteps"></ol>

  <div class="vars" id="seqVars">
    <div class="row" style="margin-top:0">
      <strong class="cardlabel">VARIABLES</strong>
      <span class="hint grow" id="varCount"></span>
    </div>
    <div class="varrow">
      <span class="vlabel">base url</span>
      <input id="seqBase" type="text" placeholder="the recorded origins" />
      <button id="seqBaseSet">SET</button>
    </div>
    <ol id="varList"></ol>
    <div class="varrow">
      <input id="varNewName" type="text" placeholder="name" class="vnameinput" />
      <input id="varNewValue" type="text" placeholder="value" />
      <button id="varAdd">ADD</button>
    </div>
  </div>
</div>

<div class="card" id="shotCard" hidden>
  <div class="row" style="margin-top:0">
    <strong class="cardlabel">SHOT</strong>
    <span class="hint grow" id="shotLabel"></span>
  </div>
  <img id="shotImg" alt="" />
  <div class="row">
    <button id="shotOut" title="take in the parent element as well">⊖ WIDER</button>
    <button id="shotIn" title="back in towards the element itself">⊕ TIGHTER</button>
    <span class="grow"></span>
    <button id="shotDiscard">DISCARD</button>
    <button id="shotSave" class="primary">SAVE</button>
  </div>
</div>

<div class="card" id="pickCard">
  <div id="idle" class="idle">Arm the picker, then click anything in the app tab.</div>
  <div id="picked" hidden>
    <div class="row" style="margin-top:0">
      <strong class="cardlabel">NOTE ON</strong>
      <span class="hint grow" id="noteOn"></span>
      <button id="pickShot" class="icon" title="take a picture of this element to save with the note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/></svg></button>
    </div>
    <div class="target" id="target"></div>
    <textarea id="comment" placeholder="What's wrong here?"></textarea>
    <div class="row">
      <span class="hint grow">⌘/Ctrl+Enter saves · Esc discards</span>
      <button id="discard">DISCARD</button>
      <button id="save" class="primary">SAVE</button>
    </div>
  </div>
</div>

<div class="card">
  <div class="row" style="margin-top:0"><strong class="grow" id="logCount">Callbacks</strong><button id="clearLog">CLEAR</button></div>
  <div class="log" id="log"><div class="hint">Nothing stepped yet. Each callback the page runs appears here as a step passes through it - only while stepping, since a freely running page is never paused to be observed.</div></div>
</div>

<div class="card" id="proxyCard" hidden>
  <div class="row" style="margin-top:0">
    <strong class="cardlabel">WHAT CROSSED THE BOUNDARY</strong>
    <span class="hint grow" id="proxyScope"></span>
    <button id="proxyClear">CLEAR</button>
  </div>
  <button id="proxyNew" class="newabove" hidden></button>
  <ol class="events" id="proxyEvents"></ol>
</div>

<script>
const BASE = window.location.pathname.replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
let pendingKey = null;
let stopped = false;

// A copy opened with ?inert=1 draws and polls but commands nothing, so it can
// be the subject of a recording: every click is captured and none of it acts.
const INERT = new URLSearchParams(location.search).get('inert') === '1';

async function post(path, body) {
  if (INERT) return;
  await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  await refresh();
}

function targetText(t) {
  const lines = ['<' + t.tag + '>  ' + t.selector];
  if (t.text) lines.push('text: ' + t.text);
  if (t.source && t.source.fileName) lines.push(t.source.fileName + (t.source.lineNumber ? ':' + t.source.lineNumber : ''));
  return lines.join('\n');
}

function render(state) {
  // A mirror says so, or the copy not taking the caret reads as a broken pane.
  $('sub').textContent = state.connection + ' · ' + state.url + (state.frozen ? ' · frozen' : '')
    + (state.primary ? '' : ' · mirror (the caret stays in the pane annotate opened)');
  $('tickbar').textContent = state.totalSteps + ' callback' + (state.totalSteps === 1 ? '' : 's') + ' · ' + state.tickMs + 'ms';
  const last = state.lastTick;
  if (last) {
    $('lastTick').textContent = last.quiet
      ? 'Nothing scheduled - the page is idle, so there was nothing to step to.'
      : 'Last step: ' + (last.requestedSteps !== undefined
          ? 'asked ' + last.requestedSteps + ', ran ' + last.steps + ' callback' + (last.steps === 1 ? '' : 's') + ' · ' + last.actualMs + 'ms'
          : 'asked ' + last.requestedMs + 'ms, ran ' + last.steps + ' callback' + (last.steps === 1 ? '' : 's') + ' · landed at ' + last.actualMs + 'ms');
  }
  $('picker').classList.toggle('on', state.pickerArmed);
  $('pickerLabel').textContent = state.pickerArmed ? 'PICKER ARMED' : 'ARM PICKER';
  $('freeze').classList.toggle('on', state.frozen);
  $('freezeLabel').textContent = state.frozen ? 'FROZEN' : 'RUNNING';
  for (const b of document.querySelectorAll('[data-steps],[data-ms],#msGo')) b.disabled = !state.frozen;

  const t = state.pending;
  const key = t ? t.selector + '|' + state.tickMs + '|' + (t.rect ? t.rect.y : '') : null;
  $('picked').hidden = !t;
  $('idle').hidden = !!t;
  if (t) {
    $('noteOn').textContent = state.noteTarget === undefined
      ? 'no sequence open - select one and this pick still saves'
      : 'step ' + (state.noteTarget + 1) + ': ' + state.noteTargetLabel
        + (state.noteStep === undefined ? '  (the step the run is on - pick a pen to change it)' : '');
    $('target').textContent = targetText(t);
    // Only the pane holding the claim takes the caret. A second copy - this
    // page opened as the app under test - would otherwise pull the caret out
    // of the pane being typed into every time a pick lands.
    if (key !== pendingKey && state.primary) { $('comment').value = ''; $('comment').focus(); }
  }
  pickedSelector = t ? t.selector : null;
  pendingKey = key;

  const shot = state.shot;
  $('shotCard').hidden = !shot;
  if (shot) {
    $('shotImg').src = 'data:image/png;base64,' + shot.data;
    $('shotLabel').textContent = shot.label + (shot.widen ? '' : '');
    $('shotOut').disabled = !shot.selector;
    $('shotIn').disabled = !shot.selector || !shot.widen;
    shotSelector = shot.selector || null;
    shotWiden = shot.widen;
    shotNote = shot.annotationId || null;
  }

  if (state.sequence) state.sequence.noteTarget = state.noteTarget;
  renderSequence(state.sequence, state.noteStep);
  renderLog(state.callbacks || []);
}

let seqNames = '';
let seqShape = '';
let recording = false;

function heldPanel(held) {
  const box = document.createElement('div');
  const flagged = held.verdict === 'flagged';
  box.className = 'held' + (flagged ? ' flagged' : '');

  const head = document.createElement('div');
  head.className = 'heldhead';
  head.textContent = flagged ? (held.reason || held.label) : 'Checking this step\u2026';
  box.append(head);

  if (flagged && held.detail) {
    const detail = document.createElement('div');
    detail.className = 'helddetail';
    detail.textContent = held.detail;
    box.append(detail);
  }

  for (const [i, option] of (held.options || []).entries()) {
    const row = document.createElement('button');
    row.className = 'optrow';
    const sel = document.createElement('span');
    sel.className = 'optsel';
    sel.textContent = option.selector;
    const note = document.createElement('span');
    note.className = 'optnote';
    note.textContent = option.note;
    row.append(sel, note);
    row.addEventListener('click', () => post('/sequence/record/choose', { index: i }));
    box.append(row);
  }

  if (flagged) {
    const acts = document.createElement('div');
    acts.className = 'heldacts';
    const keep = document.createElement('button');
    keep.className = 'quiet';
    keep.textContent = 'keep as recorded';
    keep.addEventListener('click', () => post('/sequence/record/keep'));
    const drop = document.createElement('button');
    drop.className = 'quiet drop';
    drop.textContent = 'drop step';
    drop.addEventListener('click', () => post('/sequence/record/drop'));
    acts.append(keep, drop);
    box.append(acts);
  }
  return box;
}

function renderSequence(seq, noteStep) {
  $('seqCard').hidden = !seq;
  if (!seq) return;
  seq.noteStep = noteStep;

  const names = (seq.available || []).join('\u0000');
  if (names !== seqNames) {           // rebuilding on every poll would fight the dropdown
    seqNames = names;
    const pick = $('seqPick');
    pick.replaceChildren(new Option('select a sequence…', ''));
    for (const name of seq.available || []) pick.add(new Option(name, name));
  }
  if (seq.name && $('seqPick').value !== seq.name) $('seqPick').value = seq.name;

  $('seqDesc').textContent = seq.description || '';
  // Left alone while it has focus, or typing fights the poll.
  if (document.activeElement !== $('seqBase')) $('seqBase').value = seq.baseUrl || '';
  $('seqPos').textContent = seq.total ? seq.currentStep + ' of ' + seq.total : '';
  $('seqBar').style.width = seq.total ? Math.round((seq.currentStep / seq.total) * 100) + '%' : '0';
  for (const id of ['seqStep', 'seqPlay', 'seqReset']) $(id).disabled = !seq.name || seq.busy;
  recording = !!seq.recording;
  if (recording) $('seqNewRow').hidden = false;
  // Disabled rather than hidden: this runs on every poll, and a control that
  // vanishes as the pointer reaches it cannot be used at all.
  const composing = recording || !$('seqNewRow').hidden;
  $('seqPick').disabled = composing;
  $('seqNew').disabled = composing;
  $('seqDelete').disabled = composing || !$('seqPick').value || seq.busy;
  $('seqRecord').textContent = recording ? 'SAVE' : 'START';
  $('seqRecord').classList.toggle('save', recording);
  $('seqRecName').disabled = recording;
  $('seqRecord').disabled = seq.busy && !recording;
  $('seqRecordLlm').hidden = recording;
  $('seqRecordCancel').hidden = !recording;
  // A sequence that went away under an armed button would delete the next one
  // selected in its place.
  if (deleteArmed && deleteArmed !== $('seqPick').value) disarmDelete();
  $('seqStep').firstChild.textContent = seq.busy ? '⣾' : '⏭';

  $('seqFail').hidden = !seq.failure;
  if (seq.failure) $('seqFailText').textContent = seq.failure;

  const done = seq.total > 0 && seq.currentStep >= seq.total;

  // A rebuild replaces the buttons in this list. A click whose press and
  // release straddle one lands on two different elements and never becomes a
  // click, so the list is rebuilt only when its contents change.
  const shape = JSON.stringify([seq.name, seq.recording, seq.steps, seq.currentStep, seq.busy,
                                noteStep, seq.noteTarget, seq.issue, done, seq.pendingStep]);
  const changed = shape !== seqShape;
  seqShape = shape;

  if (changed) $('seqSteps').replaceChildren(...(seq.steps || []).map((step) => {
    const li = document.createElement('li');
    li.className = step.failed ? 'fail' : (step.current && !done ? 'now' : (step.done ? 'done' : ''));

    const head = document.createElement('div');
    head.className = 'head';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = step.failed ? '✕'
      : step.done ? '✓'
      : (step.current && !done ? (seq.busy ? '⣾' : '▸') : String(step.index + 1));
    const what = document.createElement('span');
    what.className = 'what';
    // The comment is what someone is actually tracking; the call is the detail.
    what.textContent = step.comment || step.label;
    const add = document.createElement('button');
    add.className = 'addnote'
      + (seq.noteStep === step.index ? ' armed' : '')
      + (seq.noteStep === undefined && seq.noteTarget === step.index ? ' target' : '');
    add.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    add.title = 'annotate this step: arms the picker, then click the element';
    add.addEventListener('click', () => post('/sequence/note', { step: step.index }));
    head.append(mark, what);

    // One group: the pen sits with the reorder and remove controls rather than
    // floating in the corner on its own.
    const tools = document.createElement('span');
    tools.className = 'steptools' + (seq.noteStep === step.index ? ' armed' : '');
    tools.append(add);
    if (!seq.recording) {
      const up = document.createElement('button');
      up.textContent = '\u2191';
      up.title = 'move this step earlier';
      up.disabled = step.index === 0 || seq.busy;
      up.addEventListener('click', () => post('/sequence/step/move', { from: step.index, to: step.index - 1 }));
      const down = document.createElement('button');
      down.textContent = '\u2193';
      down.title = 'move this step later';
      down.disabled = step.index === (seq.steps || []).length - 1 || seq.busy;
      down.addEventListener('click', () => post('/sequence/step/move', { from: step.index, to: step.index + 1 }));
      const kill = document.createElement('button');
      kill.textContent = '\u2715';
      kill.className = 'stepdrop';
      kill.title = 'remove this step from the sequence';
      kill.disabled = seq.busy;
      kill.addEventListener('click', () => post('/sequence/step/remove', { index: step.index }));
      tools.append(up, down, kill);
    }
    head.append(tools);

    li.append(head);

    if (step.comment) {
      const call = document.createElement('span');
      call.className = 'call';
      call.textContent = step.label;
      li.append(call);
    }
    if (step.resolved) {
      const res = document.createElement('span');
      res.className = 'res';
      res.textContent = '└→ ' + step.resolved;
      li.append(res);
    }
    if (step.captures) {
      const cap = document.createElement('span');
      cap.className = 'call';
      cap.textContent = '└→ captures ' + step.captures;
      li.append(cap);
    }

    if (step.traffic) {
      const box = document.createElement('div');
      box.className = 'traffic';
      const head = document.createElement('div');
      head.className = 'thead' + (step.traffic.failed ? ' tfail' : '');
      const bits = [];
      if (step.traffic.requests) bits.push(step.traffic.requests + ' request(s)');
      if (step.traffic.opened) bits.push(step.traffic.opened + ' transport(s) opened');
      if (step.traffic.writes) bits.push(step.traffic.writes + ' local write(s)');
      if (step.traffic.failed) bits.push(step.traffic.failed + ' failed');
      head.textContent = bits.join(' · ');
      box.append(head);
      for (const line of step.traffic.lines || []) {
        const row = document.createElement('div');
        row.textContent = line;
        box.append(row);
      }
      li.append(box);
    }

    // The decision belongs to the step it is about, not to the top of the card.
    if (seq.pendingStep && seq.pendingStep.index === step.index) {
      li.append(heldPanel(seq.pendingStep));
    }

    for (const a of step.annotations || []) {
      const note = document.createElement('div');
      note.className = 'note';

      const row = document.createElement('div');
      row.className = 'nrow';
      // The selector takes the note's place while the row is hovered - the same
      // gesture that outlines the element on the page. The comment keeps its
      // space rather than being removed from the flow, so the row holds its
      // height and nothing below it shifts under the pointer.
      const body = document.createElement('span');
      body.className = 'ntext';
      const comment = document.createElement('span');
      comment.className = 'ncomment';
      comment.textContent = a.comment || '(no comment)';
      const sel = document.createElement('span');
      sel.className = 'nsel';
      sel.textContent = a.target.selector;
      body.append(comment, sel);
      const back = document.createElement('button');
      back.className = 'goback';
      back.textContent = 'STEP TO';
      back.title = 'run the sequence back to this step';
      back.disabled = seq.busy;
      back.addEventListener('click', () => post('/sequence/goto', { step: step.index }));
      // Puts this note on the session event stream, where an agent watching it
      // is handed the element and what was said about it without the person
      // describing either again.
      const tell = document.createElement('button');
      tell.className = 'goback';
      tell.textContent = 'NOTIFY';
      tell.title = 'send this note to the agent watching the event stream';
      tell.addEventListener('click', () => {
        post('/annotation/notify', { id: a.id });
        tell.textContent = 'SENT';
        setTimeout(() => { tell.textContent = 'NOTIFY'; }, 2000);
      });
      // The element the note names, clipped out of the page - a picture of the
      // thing being discussed rather than a page to find it in.
      const shot = document.createElement('button');
      shot.className = 'goback icon';
      shot.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="1" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
      shot.title = 'save a picture of this element';
      shot.addEventListener('click', () => post('/shot', { selector: a.target.selector, annotationId: a.id }));
      const drop = document.createElement('button');
      drop.className = 'goback ndrop';
      drop.textContent = '✕';
      drop.title = 'remove this note from the sequence';
      drop.addEventListener('click', () => post('/annotation/delete', { id: a.id }));
      row.append(body, back, tell, shot, drop);
      note.append(row);

      const shots = a.screenshots || (a.screenshot ? [a.screenshot] : []);
      if (shots.length) {
        const strip = document.createElement('div');
        strip.className = 'nshots';
        shots.forEach((path, i) => {
          const thumb = document.createElement('img');
          thumb.src = shotUrl(path);
          thumb.alt = path.split('/').pop();
          thumb.title = path.split('/').pop();
          thumb.addEventListener('click', () => openShot(a, i));
          strip.append(thumb);
        });
        note.append(strip);
      }

      if (seq.issue) {
        const sub = document.createElement('div');
        sub.className = 'nmeta';
        sub.textContent = seq.issue.type + '-' + String(seq.issue.id).padStart(3, '0') + ' · ' + seq.issue.title;
        note.append(sub);
      }

      // Hovering outlines the element in the page. The outline is drawn by
      // Chrome over the app tab, so it survives a frozen page where nothing in
      // the page could draw it.
      note.addEventListener('mouseenter', () => post('/annotation/highlight', { selector: a.target.selector }));
      note.addEventListener('mouseleave', () => post('/annotation/highlight', { selector: '' }));
      li.append(note);
    }
    return li;
  }));

  const vars = seq.variables || [];
  $('varCount').textContent = vars.length ? vars.length + ' carried' : 'none yet';
  $('varList').replaceChildren(...vars.map((variable) => {
    const li = document.createElement('li');
    li.className = 'varrow';
    const name = document.createElement('span');
    name.className = 'vlabel';
    name.textContent = variable.name;
    const value = document.createElement('input');
    value.type = 'text';
    value.value = String(variable.value ?? '').replace(/^"|"$/g, '');
    value.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') post('/sequence/var/set', { name: variable.name, value: value.value });
    });
    const set = document.createElement('button');
    set.textContent = 'SET';
    set.addEventListener('click', () => post('/sequence/var/set', { name: variable.name, value: value.value }));
    const kill = document.createElement('button');
    kill.className = 'stepdrop';
    kill.textContent = '\u2715';
    kill.title = 'remove this variable from the sequence';
    kill.addEventListener('click', () => post('/sequence/var/remove', { name: variable.name }));
    const src = document.createElement('span');
    src.className = 'vsrc';
    src.textContent = variable.source;
    li.append(name, value, set, kill, src);
    return li;
  }));
}

/** Distinguishes this tab from another showing the same pane. */
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

let loggedThrough = 0;

function renderLog(entries) {
  const box = $('log');
  const last = entries.length ? entries[entries.length - 1].index : 0;
  if (last === loggedThrough) return;        // nothing new; leave the scroll alone
  if (last < loggedThrough) { box.replaceChildren(); loggedThrough = 0; }  // reset after a navigation

  const fresh = entries.filter((e) => e.index > loggedThrough);
  if (loggedThrough === 0) box.replaceChildren();

  for (const e of fresh) {
    const line = document.createElement('div');
    line.className = 'line';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = '#' + e.index;
    const t = document.createElement('span'); t.className = 't'; t.textContent = e.at + 'ms';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = e.kind || 'callback';
    const w = document.createElement('span'); w.className = 'w';
    const where = e.url ? e.url.replace(/^https?:\/\/[^/]+/, '') + (e.line ? ':' + e.line : '') : '';
    w.textContent = [e.fn, where].filter(Boolean).join('  ');
    line.append(n, t, k, w);
    box.appendChild(line);
  }
  loggedThrough = last;
  $('logCount').textContent = 'Callbacks · ' + last;
  box.scrollTop = box.scrollHeight;          // follow the tail
}

async function refresh() {
  if (stopped) return;
  try {
    const res = await fetch(BASE + '/state?client=' + CLIENT_ID);
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    $('sub').textContent = 'annotate mode ended';
    stopped = true;
  }
}

function setCollapsed(collapsed) {
  $('ctlCard').classList.toggle('collapsed', collapsed);
  $('ctlToggle').textContent = collapsed ? '\u25b8' : '\u25be';
  $('ctlToggle').title = collapsed ? 'expand the controls' : 'collapse the controls';
  try { localStorage.setItem('devharness.controls', collapsed ? 'collapsed' : 'open'); } catch (e) {}
}

try { setCollapsed(localStorage.getItem('devharness.controls') !== 'open'); }
catch (e) { setCollapsed(true); }

// What the capture waiting in the pane is of, so WIDER and TIGHTER re-take it
// against the same element rather than starting over.
let shotSelector = null;
let shotWiden = 0;
/** The note the waiting capture joins, so WIDER and TIGHTER keep it. */
let shotNote = null;
/** The element of the pick waiting to be saved, for its own SHOT button. */
let pickedSelector = null;

$('shot').addEventListener('click', () => post('/shot', {}));

$('shotOut').addEventListener('click', () => post('/shot', { selector: shotSelector, widen: shotWiden + 1, annotationId: shotNote }));
$('shotIn').addEventListener('click', () => post('/shot', { selector: shotSelector, widen: Math.max(0, shotWiden - 1), annotationId: shotNote }));
function shotUrl(path) {
  return BASE + '/shot/img?p=' + encodeURIComponent(path);
}

function openShot(annotation, index) {
  const shots = annotation.screenshots || (annotation.screenshot ? [annotation.screenshot] : []);
  if (!shots.length) return;

  $('shotModalTitle').textContent = annotation.comment || '(no comment)';
  $('shotModalSel').textContent = annotation.target.selector;

  const figures = shots.map((path, i) => {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.src = shotUrl(path);
    img.alt = path.split('/').pop();
    const caption = document.createElement('figcaption');
    caption.textContent = path.split('/').pop()
      + (shots.length > 1 ? '   ' + (i + 1) + ' of ' + shots.length : '');
    figure.append(img, caption);
    return figure;
  });
  $('shotModalImages').replaceChildren(...figures);
  $('shotModal').hidden = false;

  const at = Math.min(Math.max(index, 0), figures.length - 1);
  if (at > 0) $('shotModalImages').scrollTop = figures[at].offsetTop - $('shotModalImages').offsetTop;
}

function closeShot() {
  $('shotModal').hidden = true;
  $('shotModalImages').replaceChildren();
}

// The backdrop closes; the panel itself does not, or choosing another capture
// would shut the modal instead of switching to it.
$('shotModal').addEventListener('click', closeShot);
$('shotModalBox').addEventListener('click', (e) => e.stopPropagation());

$('pickShot').addEventListener('click', () => post('/shot', { selector: pickedSelector }));
$('shotSave').addEventListener('click', () => post('/shot/save'));
$('shotDiscard').addEventListener('click', () => post('/shot/discard'));

$('ctlToggle').addEventListener('click', () => {
  setCollapsed(!$('ctlCard').classList.contains('collapsed'));
});

$('save').addEventListener('click', () => post('/save', { comment: $('comment').value }));
$('discard').addEventListener('click', () => post('/discard'));
$('picker').addEventListener('click', () => post('/picker', { armed: !$('picker').classList.contains('on') }));
$('freeze').addEventListener('click', () => post('/freeze', { frozen: !$('freeze').classList.contains('on') }));
for (const b of document.querySelectorAll('[data-steps]')) {
  b.addEventListener('click', () => post('/tick', { steps: Number(b.dataset.steps) }));
}
for (const b of document.querySelectorAll('[data-ms]')) {
  b.addEventListener('click', () => post('/tick', { budgetMs: Number(b.dataset.ms) }));
}
// Deleting erases a file: the first click arms and names what will go, the
// second sends. The arming expires after 12s, so a stray first click does not
// sit armed waiting for an unrelated second one.
let deleteArmed = null;
let deleteTimer = 0;

function disarmDelete() {
  deleteArmed = null;
  clearTimeout(deleteTimer);
  $('seqDelete').classList.remove('armed');
  $('seqDelete').textContent = 'DELETE';
  $('seqDelete').title = 'erase this sequence from disk';
}

$('seqPick').addEventListener('change', () => {
  disarmDelete();
  if ($('seqPick').value) post('/sequence/select', { name: $('seqPick').value });
});

$('seqDelete').addEventListener('click', () => {
  const name = $('seqPick').value;
  if (!name) return;
  if (deleteArmed === name) {
    disarmDelete();
    seqNames = '';                    // the list shrinks; let the next poll rebuild it
    post('/sequence/delete', { name });
    return;
  }
  deleteArmed = name;
  $('seqDelete').classList.add('armed');
  $('seqDelete').textContent = 'SURE?';
  $('seqDelete').title = 'erase "' + name + '" from disk';
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(disarmDelete, 12000);
});
// The recording request stays open until the recording ends, so STOP is a
// separate call rather than a reply to it.
function startRecording(withAgent) {
  if (recording) {
    post('/sequence/record/stop');
    $('seqNewRow').hidden = true;
    $('seqNew').classList.remove('on');
    $('seqRecName').value = '';
    return;
  }
  const name = $('seqRecName').value.trim();
  if (!name) { $('seqRecName').focus(); return; }
  recording = true;
  seqNames = '';
  post('/sequence/record', { name, withAgent });
}

// The record line stays out of the way until a new sequence is wanted.
$('seqNew').addEventListener('click', () => {
  const row = $('seqNewRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('seqRecName').focus();
});

$('seqRecordCancel').addEventListener('click', () => {
  post('/sequence/record/cancel');
  $('seqNewRow').hidden = true;
  $('seqNew').classList.remove('on');
  $('seqRecName').value = '';
});

$('seqRecord').addEventListener('click', () => startRecording(false));
$('seqRecordLlm').addEventListener('click', () => startRecording(true));

$('seqFailClose').addEventListener('click', () => post('/sequence/failure/dismiss'));
function addVariable() {
  const name = $('varNewName').value.trim();
  if (!name) { $('varNewName').focus(); return; }
  post('/sequence/var/set', { name, value: $('varNewValue').value });
  $('varNewName').value = '';
  $('varNewValue').value = '';
}

$('varAdd').addEventListener('click', addVariable);
$('varNewValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVariable(); });
$('seqBaseSet').addEventListener('click', () => post('/sequence/baseurl', { baseUrl: $('seqBase').value }));
$('seqBase').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') post('/sequence/baseurl', { baseUrl: $('seqBase').value });
});
$('seqStep').addEventListener('click', () => post('/sequence/step'));
$('seqPlay').addEventListener('click', () => post('/sequence/play'));
$('seqReset').addEventListener('click', () => post('/sequence/cancel'));
$('clearLog').addEventListener('click', () => {
  $('log').replaceChildren();
  loggedThrough = 0;
});
$('msGo').addEventListener('click', () => {
  const ms = Number($('ms').value);
  if (ms > 0) post('/tick', { budgetMs: ms });
});
document.addEventListener('keydown', (e) => {
  // Escape closes the enlarged capture before it discards a pick, or looking
  // at a picture would throw away the note being written.
  if (e.key === 'Escape' && !$('shotModal').hidden) { closeShot(); return; }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('picked').hidden) post('/save', { comment: $('comment').value });
  if (e.key === 'Escape' && !$('picked').hidden) post('/discard');
});

if (INERT) $('inertTag').hidden = false;

// The proxy tab polls on its own clock. Its list only grows, so each poll asks
// for what arrived after the last id rather than for the whole list again.
let activeTab = 'annotate';
let lastEventId = null;
let eventCount = 0;

function showTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('on', button.dataset.tab === name);
  }
  // display rather than the hidden attribute: the annotate cards manage that
  // themselves for their own reasons, and a tab must not take it over.
  for (const card of document.querySelectorAll('.card')) {
    const isProxy = card.id === 'proxyCard';
    card.style.display = (isProxy === (name === 'proxy')) ? '' : 'none';
  }
  $('proxyCard').hidden = false;
  if (name === 'proxy') pollProxy();
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

let unseenAbove = 0;

function clearUnseen() {
  unseenAbove = 0;
  $('proxyNew').hidden = true;
}

$('proxyNew').addEventListener('click', () => {
  $('proxyEvents').scrollTop = 0;
  clearUnseen();
});

$('proxyEvents').addEventListener('scroll', () => {
  if ($('proxyEvents').scrollTop <= 4) clearUnseen();
});

$('proxyClear').addEventListener('click', () => {
  $('proxyEvents').replaceChildren();
  eventCount = 0;
  $('proxyCount').textContent = '';
  clearUnseen();
});

const bytes = (n) => n < 1024 ? n + ' B'
  : n < 1024 * 1024 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' kB'
  : (n / 1048576).toFixed(1) + ' MB';

/** Status, size, how long it took, what it was - in that order of interest. */
function describe(event) {
  const parts = [];
  if (event.heldAs) parts.push(event.heldAs);
  else if (event.kind === 'request') parts.push(String(event.status ?? ''));
  parts.push(bytes(event.size));
  if (event.durationMs !== undefined && event.durationMs > 0) parts.push(event.durationMs + ' ms');
  if (event.contentType) parts.push(event.contentType);
  return parts.filter(Boolean).join(' \u00b7 ');
}

function eventRow(event) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'evhead';

  const dir = document.createElement('span');
  dir.className = 'evdir';
  dir.textContent = event.kind === 'request'
    ? (event.method || 'GET')
    : (event.direction === 'out' ? '->' : '<-');

  const url = document.createElement('span');
  url.className = 'evurl';
  url.textContent = event.kind === 'request' ? event.url : (event.preview || event.url);

  const meta = document.createElement('span');
  meta.className = 'evmeta' + (event.heldAs ? ' held' : (event.status >= 400 ? ' bad' : ''));
  meta.textContent = describe(event);

  const tools = document.createElement('span');
  tools.className = 'evtools';
  const chevron = document.createElement('button');
  chevron.textContent = '\u2304';
  chevron.title = 'open';
  const holdIcon = document.createElement('button');
  holdIcon.textContent = '\u25c9';
  holdIcon.title = 'hold this value';
  tools.append(chevron, holdIcon);

  head.append(dir, url, meta, tools);
  li.append(head);

  let body = null;
  const close = () => {
    if (body) { body.remove(); body = null; }
    li.classList.remove('open');
    chevron.textContent = '\u2304';
  };

  const open = async () => {
    if (body) return close();
    li.classList.add('open');
    chevron.textContent = '\u2303';
    body = document.createElement('div');
    const payload = document.createElement('div');
    payload.className = 'evbody';
    payload.textContent = 'reading\u2026';
    const actions = document.createElement('div');
    actions.className = 'evactions';
    const hold = document.createElement('button');
    hold.className = 'save';
    hold.textContent = 'HOLD THIS VALUE';
    hold.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch(BASE + '/proxy/hold?id=' + encodeURIComponent(event.id), { method: 'POST' });
      hold.textContent = (await res.text()) || 'HELD';
      hold.disabled = true;
      meta.classList.add('held');
    });
    actions.append(hold);
    body.append(payload, actions);
    li.append(body);

    const res = await fetch(BASE + '/proxy/body?id=' + encodeURIComponent(event.id));
    payload.textContent = (await res.text()) || '(nothing was kept for this one)';
  };

  head.addEventListener('click', open);
  chevron.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  holdIcon.addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(BASE + '/proxy/hold?id=' + encodeURIComponent(event.id), { method: 'POST' });
    meta.classList.add('held');
  });
  return li;
}

async function pollProxy() {
  if (stopped) return;
  try {
    const res = await fetch(BASE + '/proxy/events?since=' + encodeURIComponent(lastEventId ?? ''));
    const state = await res.json();
    $('proxyScope').textContent = state.running
      ? state.allowed.join(', ') + (state.refused ? ' \u00b7 ' + state.refused + ' refused' : '')
      : 'this browser was not launched through a proxy';
    const list = $('proxyEvents');
    // Newest first, and the scroll position is left alone. Appending and
    // scrolling to the end drags the reader off whatever they were looking at
    // every time the app makes a request.
    const atTop = list.scrollTop <= 4;
    for (const event of state.events) {
      list.prepend(eventRow(event));
      lastEventId = event.id;
      eventCount += 1;
    }
    if (state.events.length) {
      $('proxyCount').textContent = eventCount;
      if (atTop) list.scrollTop = 0;
      else {
        unseenAbove += state.events.length;
        const button = $('proxyNew');
        button.textContent = unseenAbove + ' NEW ABOVE';
        button.hidden = false;
      }
    }
  } catch { /* the pane outlives a restart; the next poll picks it up */ }
}

setInterval(() => { if (activeTab === 'proxy') pollProxy(); }, 500);

refresh();
setInterval(refresh, 250);
</script>
</body>
</html>`;

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * How long a pane can go without polling before another may take the claim.
 * Three poll intervals: a tab that reloads gets its claim straight back, and
 * one that closed releases it within a second or so.
 */
const PRIMARY_STALE_MS = 3000;

export async function startControlServer(handlers: ControlHandlers): Promise<ControlServer> {
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}`;

  // Which pane owns the caret.
  //
  // The pane's URL can be opened in any number of tabs - annotating the pane
  // itself puts a second copy in the app tab - and every copy polls this same
  // state. Without a claim, each one focuses its own comment box the moment a
  // pick lands, so the caret jumps to whichever copy rendered last instead of
  // staying in the pane the person is typing into.
  let primaryId: string | undefined;
  let primarySeenAt = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '');
      if (!path.startsWith(prefix)) return send(res, 404, 'Not found', 'text/plain');
      const route = path.slice(prefix.length) || '/';

      try {
        if (req.method === 'GET' && route === '/') {
          return send(res, 200, PAGE, 'text/html; charset=utf-8');
        }
        // The captures live on disk; the pane shows them. Only files under the
        // screenshots directory are served - the path arrives from a page, so
        // anything else would make this an open file reader on the machine.
        if (req.method === 'GET' && route === '/shot/img') {
          const wanted = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('p') ?? '';
          const root = resolve(getOutputPath('screenshots'));
          const file = resolve(wanted);
          if (!file.startsWith(root + sep)) return send(res, 403, 'Outside the screenshots directory', 'text/plain');
          try {
            const bytes = await readFile(file);
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            return res.end(bytes);
          } catch {
            return send(res, 404, 'No such capture', 'text/plain');
          }
        }

        if (req.method === 'GET' && route.startsWith('/proxy/body')) {
          const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
          const body = await handlers.proxyBody(id);
          return send(res, 200, body ?? '', 'text/plain; charset=utf-8');
        }

        if (req.method === 'POST' && route.startsWith('/proxy/hold')) {
          const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
          return send(res, 200, await handlers.proxyHold(id), 'text/plain; charset=utf-8');
        }

        if (req.method === 'GET' && route.startsWith('/proxy/events')) {
          const since = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('since') || null;
          return send(res, 200, JSON.stringify(await handlers.proxyEvents(since)), 'application/json');
        }

        if (req.method === 'GET' && route === '/state') {
          const client = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('client') ?? '';
          const now = Date.now();
          if (!primaryId || primaryId === client || now - primarySeenAt > PRIMARY_STALE_MS) {
            primaryId = client;
            primarySeenAt = now;
          }
          const state = await handlers.getState();
          return send(res, 200, JSON.stringify({ ...state, primary: primaryId === client }), 'application/json');
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          switch (route) {
            case '/save': await handlers.save(String(body.comment ?? '')); break;
            case '/discard': await handlers.discard(); break;
            case '/tick':
              await handlers.tick(
                body.steps !== undefined
                  ? { steps: Math.max(1, Number(body.steps) || 1) }
                  : { budgetMs: Math.max(1, Number(body.budgetMs) || 100) }
              );
              break;
            case '/picker': await handlers.setPicker(!!body.armed); break;
            case '/freeze': await handlers.setFrozen(!!body.frozen); break;
            case '/sequence/select': await handlers.selectSequence(String(body.name ?? '')); break;
            case '/sequence/goto': await handlers.gotoSequenceStep(Math.max(0, Number(body.step) || 0)); break;
            case '/sequence/step': await handlers.stepSequence(); break;
            case '/sequence/play': await handlers.playSequence(); break;
            case '/sequence/cancel': await handlers.cancelSequence(); break;
            case '/sequence/delete': await handlers.removeSequence(String(body.name ?? '')); break;
            case '/sequence/failure/dismiss': await handlers.dismissFailure(); break;
            case '/sequence/record':
              await handlers.recordSequence(String(body.name ?? ''), !!body.withAgent);
              break;
            case '/sequence/record/stop': await handlers.stopRecordingSequence(); break;
            case '/sequence/record/cancel': await handlers.cancelRecordingSequence(); break;
            case '/sequence/step/remove':
              await handlers.removeSequenceStep(Math.max(0, Number(body.index) || 0));
              break;
            case '/sequence/var/set':
              await handlers.setSequenceVariable(String(body.name ?? ''), String(body.value ?? ''));
              break;
            case '/sequence/var/remove':
              await handlers.removeSequenceVariable(String(body.name ?? ''));
              break;
            case '/sequence/step/move':
              await handlers.moveSequenceStep(
                Math.max(0, Number(body.from) || 0),
                Math.max(0, Number(body.to) || 0)
              );
              break;
            case '/sequence/record/keep': await handlers.keepRecordedStep(); break;
            case '/sequence/record/flag':
              await handlers.flagRecordedStep(String(body.reason ?? ''), body.options, body.detail);
              break;
            case '/sequence/record/choose':
              await handlers.chooseStepSelector(Math.max(0, Number(body.index) || 0));
              break;
            case '/sequence/record/drop': await handlers.dropRecordedStep(); break;
            case '/sequence/note': await handlers.noteAtStep(Math.max(0, Number(body.step) || 0)); break;
            case '/annotation/delete': await handlers.removeAnnotation(String(body.id ?? '')); break;
            case '/annotation/notify': await handlers.notifyAnnotation(String(body.id ?? '')); break;
            case '/shot':
              await handlers.captureScreenshot(
                body.selector ? String(body.selector) : undefined,
                Math.max(0, Number(body.widen) || 0),
                body.annotationId ? String(body.annotationId) : undefined
              );
              break;
            case '/shot/save': await handlers.saveScreenshot(); break;
            case '/shot/discard': await handlers.discardScreenshot(); break;
            case '/annotation/highlight': await handlers.highlightAnnotation(String(body.selector ?? '')); break;
            case '/sequence/baseurl': await handlers.setBaseUrl(String(body.baseUrl ?? '')); break;
            default: return send(res, 404, 'Not found', 'text/plain');
          }
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        }
        send(res, 404, 'Not found', 'text/plain');
      } catch (error) {
        send(res, 500, JSON.stringify({ error: String(error) }), 'application/json');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 rather than localhost: a different site from the app under test,
    // so the control pane gets its own renderer process.
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}${prefix}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
