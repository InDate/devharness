/**
 * The bench - a second tab holding what crossed the app's boundary, the tick
 * controls, the comment box and the list of what has been recorded.
 *
 * It lives outside the page being driven for two reasons. The page is frozen
 * with `Debugger.pause`, so its JS does not run at all and an injected box could
 * not accept a keystroke. And keeping the UI out of the page means the page's
 * own DOM is never modified by the act of taking a note against it.
 *
 * Served from 127.0.0.1 while apps are typically on localhost - a different
 * site, so Chrome gives the bench its own renderer process and a hard
 * hold on the app pane cannot take it down with it.
 *
 * Every route is behind a random token in the path. The server accepts writes
 * (an annotation, a tick), and any page in any browser can reach a localhost
 * port; the token is what stops one that was not handed the URL.
 */

import { runAs } from './session-events.js';
import { arriveOn } from './call-origin.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve, sep, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getOutputPath } from './helpers/paths.js';
import { readCapture } from './capture-file.js';
import { deletePayload, listPayloads, readPayload } from './saved-payloads.js';
import { decodePng, encodePng } from './png.js';
import { diffPixels, sideBySide } from './pixel-diff.js';
import type { BenchView, BoundaryState, CaptureKind, CaptureRect, FactKind, RuleCatalogueEntry, SequenceOutline, HistoryEntry, HistoryDetail, ToolGroup, ToolRun, ToolValues, IssueRow, SequenceNote, ToolFavourite, ServerRow, ServerLog, RunningView } from './bench/wire.js';
import type { RunsView } from './bench/wire.js';
import type { ActivityMove, ExpectedValue, KindCount } from './bench/kinds.js';

const FACT_KINDS: FactKind[] = ['events', 'css', 'html', 'a11y'];

export type { BenchView } from './bench/wire.js';

export interface BenchHandlers {
  /** Everything but `primary`, which only the route can decide. */
  getState: () => Promise<Omit<BenchView, 'primary'>>;
  save: (comment: string) => Promise<void>;
  discard: () => Promise<void>;
  tick: (request: { steps?: number; budgetMs?: number }) => Promise<void>;
  stepTraffic: () => Promise<void>;
  releaseWaiting: (id: number) => Promise<void>;
  openDevtools: () => Promise<string>;
  changeHold: (action: 'hold' | 'release' | 'step', layers?: Array<'code' | 'ui' | 'network'>) => Promise<void>;
  setPicker: (armed: boolean) => Promise<void>;
  setPersonInput: (on: boolean) => Promise<void>;
  setHeld: (held: boolean, resume?: boolean) => Promise<void>;
  selectSequence: (name: string) => Promise<void>;
  describeSequence: (description: string, expectedOutcome: string) => Promise<void>;
  commentSequenceStep: (index: number, words: string) => Promise<void>;
  /** Add, remove or set what the pause point before a step holds. */
  setPausePoint: (index: number, change: { on?: boolean; holds?: Array<'code' | 'ui' | 'network'> }) => Promise<void>;
  gotoSequenceStep: (step: number) => Promise<void>;
  stepSequence: () => Promise<void>;
  playSequence: () => Promise<void>;
  /** Play from the first step and keep what crossed under each step as its recorded traffic. */
  baselineSequence: () => Promise<void>;
  /** Stop the run at the step it reached, leaving the sequence open. */
  haltSequence: () => Promise<void>;
  cancelSequence: () => Promise<void>;
  removeSequence: (name: string) => Promise<void>;
  dismissFailure: () => Promise<void>;
  repairStep: (accept: 'selector' | 'element') => Promise<void>;
  /** Close the browser dialog over the app's page: OK, or Cancel. */
  answerDialog: (accept: boolean) => Promise<void>;
  /** What the proxy has seen, when this browser was launched through one. */
  proxyEvents: (sinceId: string | null) => Promise<BoundaryState>;
  /** Every response kept on disk, across every site and sequence. */
  ruleCatalogue: () => Promise<RuleCatalogueEntry[]>;
  /** One sequence's steps, for its row on the list of sequences. */
  sequenceOutline: (name: string) => Promise<SequenceOutline | undefined>;
  /** Every tool call this devharness holds in history, newest first. */
  history: () => Promise<HistoryEntry[]>;
  /** Runs going now, suites, and runs that ended. */
  runs: () => Promise<RunsView>;
  stopRun: (target: { runId?: string; connection?: string }) => Promise<void>;
  /** Start a sequence in a headless browser of its own; the failure text, or nothing. */
  runFromHome: (name: string) => Promise<string | undefined>;
  /** Open a sequence and play it in the bench's own browser. */
  playHere: (name: string) => Promise<void>;
  /** Open a sequence in the bench's own browser and run it through `step` (0-based). */
  playToStep: (name: string, step: number) => Promise<void>;
  renameFromHome: (from: string, to: string) => Promise<{ failure?: string; references: number }>;
  historyDetail: (index: number) => Promise<HistoryDetail | undefined>;
  /** Every tool this devharness serves, by the toolset that built it. */
  tools: () => Promise<ToolGroup[]>;
  toolValues: () => Promise<ToolValues>;
  /** The tracked issues; fixed and implemented ones only with `includeCompleted`. */
  issues: (includeCompleted: boolean) => Promise<IssueRow[]>;
  servers: () => Promise<ServerRow[]>;
  serverLog: (id: string, stream: 'stdout' | 'stderr') => Promise<ServerLog>;
  running: () => Promise<RunningView>;
  favourites: () => Promise<ToolFavourite[]>;
  addFavourite: (call: { tool: string; label: string; args: Record<string, unknown> }) => Promise<ToolFavourite[]>;
  removeFavourite: (id: string) => Promise<ToolFavourite[]>;
  /** Every note in the saved sequences, for quoting into an issue. */
  sequenceNotes: () => Promise<SequenceNote[]>;
  callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolRun>;
  /** The payload kept for one event, for reading and for holding. */
  proxyBody: (id: string) => Promise<string | null>;
  /** Answer this from now on with what it answered here. */
  /** Answers with the hold's id, so the bench can let go of it again. */
  proxyHold: (id: string) => Promise<{ text: string; pin?: string }>;
  proxyRelease: (pin: string) => Promise<string>;
  /** Report a reading that looks wrong, with everything the rule read. */
  proxyInvestigate: (id: string, note: string) => Promise<string>;
  /**
   * Open a proxied window under `name` in this browser's Chrome, at this page
   * with its cookies, and a bench on it with no tab of its own: the address
   * this tab moves to, or the failure.
   */
  enableProxy: (name: string) => Promise<{ benchUrl: string } | { failure: string }>;
  /** The bench on connection `name`, started with no tab of its own where none is open: the address this tab moves to, or the failure. */
  openBench: (name: string) => Promise<{ benchUrl: string } | { failure: string }>;
  /**
   * Scope what this browser may reach. An empty list reaches every host, which
   * is what browsing without a sequence needs.
   */
  allowHosts: (hosts: string[]) => Promise<string>;
  /** Drop the recorded events, keeping every rule and the scope. */
  clearBoundary: () => Promise<string>;
  /** Decide what happens to one kind of traffic from now on. */
  setRule: (rule: Record<string, unknown>) => Promise<void>;
  /** Drop the decision against one key. */
  clearRule: (key: string) => Promise<void>;
  /** Ignore traffic a rule matches: out of the list and out of every comparison. */
  ignoreTraffic: (rule: Record<string, unknown>) => Promise<void>;
  /** Show a hidden kind again, in every sequence. */
  unhideKind: (key: string) => Promise<void>;
  /** Hide a kind in the open sequence, or list it there. */
  setHiddenUse: (key: string, on: boolean) => Promise<void>;
  setHiddenMode: (key: string, mode: 'local' | 'optIn' | 'optOut') => Promise<void>;
  /** How the open sequence uses one response: 'none', 'all', or a list of step indexes. */
  setResponseUse: (key: string, use: unknown) => Promise<void>;
  /** Which sequences a response answers in by default. */
  setResponseMode: (key: string, mode: 'local' | 'optIn' | 'optOut') => Promise<void>;
  /** Hold a step open until `count` things have crossed under it. 0 clears. */
  /** Name a kind of traffic; an empty name drops it. */
  setName: (key: string, name: string) => Promise<void>;
  /** Mark what one kind on one step has to carry on replay; none unmarks it. */
  setExpected: (step: number, kind: string, expected: ExpectedValue | undefined) => Promise<void>;
  /** Replace what one kind on one step was recorded as; none removes it from the recording. */
  setRecorded: (step: number, kind: string, recorded: KindCount | undefined) => Promise<void>;
  /** Move one kind to the adjacent step, or between the last step and the gutter. */
  moveActivity: (move: ActivityMove) => Promise<void>;
  /** Answer every unmatched write 403, or forward it. */
  setRefuseWrites: (on: boolean) => Promise<string>;
  /** Write the decisions onto the open sequence. */
  saveRules: () => Promise<string>;
  recordSequence: (name: string, withAgent: boolean, startUrl: string) => Promise<void>;
  /** Record new steps on the page as it stands, into the open sequence after step `after`. */
  recordInto: (after: number) => Promise<void>;
  stopRecordingSequence: () => Promise<void>;
  cancelRecordingSequence: () => Promise<void>;
  removeSequenceStep: (index: number) => Promise<void>;
  /** Replace what a step is given. */
  editSequenceStep: (index: number, params: unknown) => Promise<void>;
  /** Put a fixed pause of `ms` after a step. */
  insertSequenceTimer: (after: number, ms: number) => Promise<void>;
  insertSequenceCheck: (after: number, params: Record<string, unknown>, comment?: string) => Promise<void>;
  moveSequenceStep: (from: number, to: number, count: number) => Promise<void>;
  setSequenceVariable: (name: string, value: string) => Promise<void>;
  removeSequenceVariable: (name: string) => Promise<void>;
  /** Store a named value after the last recorded action, for later steps to read. */
  addRecordingVariable: (name: string, value: string) => Promise<void>;
  /** Change a variable the recording stores, or with null drop it. */
  editRecordingVariable: (name: string, value: string | null) => Promise<void>;
  /** Put a fixed pause of `ms` after the last recorded action. */
  addRecordingTimer: (ms: number) => Promise<void>;
  keepRecordedStep: () => Promise<void>;
  flagRecordedStep: (reason: string, options?: Array<{ selector: string; note: string }>, detail?: string) => Promise<void>;
  chooseStepSelector: (index: number) => Promise<void>;
  dropRecordedStep: () => Promise<void>;
  noteAtStep: (step: number) => Promise<void>;
  removeAnnotation: (id: string) => Promise<void>;
  /** Carry one note to another step of the open sequence. */
  moveAnnotation: (id: string, step: number, after?: string) => Promise<void>;
  /** Replace one note's words. */
  rewordAnnotation: (id: string, words: string) => Promise<void>;
  /** Save a payload by name, re-arming the replacements that serve it; answers the failure, if any. */
  savePayload: (name: string, content: string) => Promise<string | undefined>;
  notifyAnnotation: (id: string) => Promise<void>;
  captureScreenshot: (ask: {
    kind: CaptureKind; selector?: string; widen?: number; annotationId?: string; viewportMark?: boolean;
  }) => Promise<void>;
  /** Hold the page and arm the picker for a capture: the dialog opening. */
  /** `annotationId` is the note the capture joins, when opened from one. */
  beginCapture: (annotationId?: string) => Promise<void>;
  cancelCapture: () => Promise<void>;
  setFactChoice: (kinds: FactKind[]) => Promise<void>;
  /** Read facts the held element capture was taken without. */
  readMoreFacts: (kinds: FactKind[]) => Promise<void>;
  /**
   * `marked` is the capture with its drawing baked in, as a base64 PNG,
   * `crop` the region kept, in the raw capture's pixels, and `facts` the
   * element facts to keep of those read.
   */
  saveScreenshot: (marked?: string, crop?: CaptureRect, facts?: FactKind[]) => Promise<void>;
  discardScreenshot: () => Promise<void>;
  /** Take a capture file's region again and compare it with version `against`. */
  retakeCapture: (path: string, against?: number) => Promise<void>;
  highlightAnnotation: (selector: string) => Promise<void>;
  setBaseUrl: (baseUrl: string) => Promise<void>;
}

export interface BenchServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * A posted mark: the whole value as text, or fields by value and fields by
 * shape as objects; anything else unmarks.
 */
function expectedIn(raw: unknown): ExpectedValue | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { value, fields, shape } = raw as { value?: unknown; fields?: unknown; shape?: unknown };
  const byValue = fields !== null && typeof fields === 'object' && Object.keys(fields).length
    ? fields as Record<string, unknown> : undefined;
  const byShape = shape !== null && typeof shape === 'object' && Object.keys(shape).length
    ? Object.fromEntries(Object.entries(shape as Record<string, unknown>).map(([path, type]) => [path, String(type)])) : undefined;
  if (byValue || byShape) return { ...(byValue ? { fields: byValue } : {}), ...(byShape ? { shape: byShape } : {}) };
  return typeof value === 'string' ? { value } : undefined;
}

/** A posted recording of one kind; anything without a count removes it. */
function recordedIn(raw: unknown): KindCount | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { n, statuses, presence, body } = raw as Record<string, unknown>;
  if (typeof n !== 'number' || n < 1) return undefined;
  return {
    n,
    ...(Array.isArray(statuses) ? { statuses: statuses.map(Number).filter(Number.isFinite) } : {}),
    ...(presence === true ? { presence: true as const } : {}),
    ...(typeof body === 'string' ? { body } : {}),
  };
}

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
 * How long a bench can go without polling before another may take the claim.
 * Three poll intervals: a tab that reloads gets its claim straight back, and
 * one that closed releases it within a second or so.
 */
const PRIMARY_STALE_MS = 3000;

/** This module's own directory, for reaching the built bench bundle. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The bench's page: a mount point and its bundle, nothing else.
 *
 * Everything the page draws comes from the component tree, so the markup here
 * stays a shell - a second copy of the layout in a string is a second thing to
 * keep in step.
 */
const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>bench</title>
<link rel="stylesheet" href="{{base}}/bench.css" />
</head>
<body>
<div id="bench" data-base="{{base}}"></div>
<script type="module" src="{{base}}/bench.js"></script>
</body>
</html>`;

export async function startBenchServer(handlers: BenchHandlers): Promise<BenchServer> {
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}`;

  // Which bench owns the caret.
  //
  // The URL can be opened in any number of tabs, and every copy polls this same
  // state. Without a claim, each one focuses its own comment box the moment a
  // pick lands, so the caret jumps to whichever copy rendered last instead of
  // staying in the one the person is typing into.
  let primaryId: string | undefined;
  let primarySeenAt = 0;

  const server: Server = createServer((req, res) => {
    // The bench page is a person's; a request the agent sends marks itself.
    void arriveOn('bench', () => runAs(req.headers['x-devharness-by'] === 'agent' ? 'agent' : 'person', async () => {
      const path = (req.url ?? '/').split('?')[0].replace(/\/$/, '');
      if (!path.startsWith(prefix)) return send(res, 404, 'Not found', 'text/plain');
      const route = path.slice(prefix.length) || '/';

      try {
        if (req.method === 'GET' && route === '/') {
          return send(res, 200, SHELL.replaceAll('{{base}}', prefix), 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && (route === '/bench.js' || route === '/bench.css')) {
          const file = join(HERE, '../build/bench', route === '/bench.js' ? 'bundle.js' : 'bundle.css');
          try {
            const bytes = await readFile(file);
            res.writeHead(200, {
              'content-type': route === '/bench.js'
                ? 'text/javascript; charset=utf-8'
                : 'text/css; charset=utf-8',
              'cache-control': 'no-store',
            });
            return res.end(bytes);
          } catch {
            return send(res, 404, 'Run npm run build:bench', 'text/plain');
          }
        }
        // The captures live on disk; the pane shows them. Only files under the
        // screenshots directory are served - the path arrives from a page, so
        // anything else would make this an open file reader on the machine.
        if (req.method === 'GET' && route === '/shot/img') {
          const asked = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          const wanted = asked.get('p') ?? '';
          const root = resolve(getOutputPath('screenshots'));
          const file = resolve(wanted);
          if (!file.startsWith(root + sep)) return send(res, 403, 'Outside the screenshots directory', 'text/plain');
          try {
            // A retake's picture is before, after and the difference side by
            // side; `clean` asks for the take alone, which the file carries
            // beside the picture. A capture with no clean copy is its picture.
            const clean = asked.get('clean') === '1' ? (await readCapture(file).catch(() => undefined))?.clean : undefined;
            const bytes = clean ? encodePng(clean) : await readFile(file);
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            return res.end(bytes);
          } catch {
            return send(res, 404, 'No such capture', 'text/plain');
          }
        }

        if (req.method === 'GET' && route === '/runs') {
          return send(res, 200, JSON.stringify(await handlers.runs()), 'application/json');
        }
        if (req.method === 'GET' && route === '/history') {
          return send(res, 200, JSON.stringify(await handlers.history()), 'application/json');
        }
        if (req.method === 'GET' && route === '/history/entry') {
          const index = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('index'));
          const detail = Number.isInteger(index) ? await handlers.historyDetail(index) : undefined;
          return detail
            ? send(res, 200, JSON.stringify(detail), 'application/json')
            : send(res, 404, 'No such call in history', 'text/plain');
        }
        if (req.method === 'GET' && route === '/tools') {
          return send(res, 200, JSON.stringify(await handlers.tools()), 'application/json');
        }
        if (req.method === 'GET' && route === '/servers/log') {
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          const stream = query.get('stream') === 'stderr' ? 'stderr' : 'stdout';
          return send(res, 200, JSON.stringify(await handlers.serverLog(query.get('id') ?? '', stream)), 'application/json');
        }
        if (req.method === 'GET' && route === '/running') {
          return send(res, 200, JSON.stringify(await handlers.running()), 'application/json');
        }
        if (req.method === 'GET' && route === '/servers') {
          return send(res, 200, JSON.stringify(await handlers.servers()), 'application/json');
        }
        if (req.method === 'GET' && route === '/favourites') {
          return send(res, 200, JSON.stringify(await handlers.favourites()), 'application/json');
        }
        if (req.method === 'POST' && route === '/favourites/add') {
          const body = await readJson(req);
          const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
            ? body.args as Record<string, unknown>
            : {};
          const added = await handlers.addFavourite({ tool: String(body.tool ?? ''), label: String(body.label ?? ''), args });
          return send(res, 200, JSON.stringify(added), 'application/json');
        }
        if (req.method === 'POST' && route === '/favourites/remove') {
          const body = await readJson(req);
          return send(res, 200, JSON.stringify(await handlers.removeFavourite(String(body.id ?? ''))), 'application/json');
        }
        if (req.method === 'GET' && route === '/issues/notes') {
          return send(res, 200, JSON.stringify(await handlers.sequenceNotes()), 'application/json');
        }
        if (req.method === 'GET' && route === '/issues') {
          const all = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('all') === '1';
          return send(res, 200, JSON.stringify(await handlers.issues(all)), 'application/json');
        }
        if (req.method === 'GET' && route === '/tools/values') {
          return send(res, 200, JSON.stringify(await handlers.toolValues()), 'application/json');
        }
        if (req.method === 'POST' && route === '/tools/call') {
          const body = await readJson(req);
          const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
            ? body.args as Record<string, unknown>
            : {};
          return send(res, 200, JSON.stringify(await handlers.callTool(String(body.tool ?? ''), args)), 'application/json');
        }
        if (req.method === 'GET' && route === '/sequence/outline') {
          const name = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('name') ?? '';
          const outline = await handlers.sequenceOutline(name);
          return outline
            ? send(res, 200, JSON.stringify(outline), 'application/json')
            : send(res, 404, 'No such sequence', 'text/plain');
        }
        if (req.method === 'GET' && route === '/boundary/catalogue') {
          return send(res, 200, JSON.stringify(await handlers.ruleCatalogue()), 'application/json');
        }
        if (req.method === 'GET' && route === '/payloads') {
          return send(res, 200, JSON.stringify(await listPayloads()), 'application/json');
        }
        if (req.method === 'GET' && route === '/payloads/read') {
          const name = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('name') ?? '';
          const content = readPayload(name);
          return content === undefined
            ? send(res, 404, 'No such payload', 'text/plain')
            : send(res, 200, content, 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route === '/payloads/delete') {
          const body = await readJson(req);
          return send(res, 200, JSON.stringify({ ok: deletePayload(String(body.name ?? '')) }), 'application/json');
        }
        if (req.method === 'POST' && route === '/payloads/save') {
          const body = await readJson(req);
          const failure = await handlers.savePayload(String(body.name ?? ''), String(body.content ?? ''));
          return send(res, failure ? 400 : 200, JSON.stringify(failure ? { failure } : { ok: true }), 'application/json');
        }

        // Any two takes of a capture against each other, by the same comparison
        // a retake makes: earlier, later and the difference as one strip, with
        // what it measured in a header.
        if (req.method === 'GET' && route === '/shot/diff') {
          const asked = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          const root = resolve(getOutputPath('screenshots'));
          const files = [asked.get('a') ?? '', asked.get('b') ?? ''].map(wanted => resolve(wanted));
          if (files.some(file => !file.startsWith(root + sep))) {
            return send(res, 403, 'Outside the screenshots directory', 'text/plain');
          }
          try {
            // The take alone where the file carries it; a retake's picture is a strip already.
            const take = async (file: string) => (await readCapture(file).catch(() => undefined))?.clean
              ?? decodePng(await readFile(file));
            const [before, after] = await Promise.all(files.map(take));
            const diff = diffPixels(before, after);
            res.writeHead(200, {
              'content-type': 'image/png',
              'cache-control': 'no-store',
              'x-diff': JSON.stringify({ changed: diff.changed, share: diff.share, box: diff.box }),
            });
            return res.end(encodePng(sideBySide([before, after, diff.image])));
          } catch {
            return send(res, 404, 'No such capture', 'text/plain');
          }
        }

        if (req.method === 'GET' && route.startsWith('/proxy/body')) {
          const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
          const body = await handlers.proxyBody(id);
          return send(res, 200, body ?? '', 'text/plain; charset=utf-8');
        }

        if (req.method === 'POST' && route === '/boundary/save') {
          return send(res, 200, await handlers.saveRules(), 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route === '/proxy/clear') {
          return send(res, 200, await handlers.clearBoundary(), 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route === '/boundary/refuse') {
          const body = await readJson(req);
          return send(res, 200, await handlers.setRefuseWrites(!!body.on), 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route === '/proxy/allow') {
          const body = await readJson(req);
          const hosts = Array.isArray(body.hosts) ? body.hosts.map(String) : [];
          return send(res, 200, await handlers.allowHosts(hosts), 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route === '/bench/open') {
          const { connection } = await readJson(req);
          return send(res, 200, JSON.stringify(await handlers.openBench(String(connection ?? ''))), 'application/json');
        }
        if (req.method === 'POST' && route === '/proxy/enable') {
          const { name } = await readJson(req);
          return send(res, 200, JSON.stringify(await handlers.enableProxy(String(name ?? ''))), 'application/json');
        }
        if (req.method === 'POST' && route.startsWith('/proxy/investigate')) {
          const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          const said = await handlers.proxyInvestigate(
            params.get('id') ?? '', params.get('note') ?? '');
          return send(res, 200, said, 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route.startsWith('/proxy/release')) {
          const pin = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('pin') ?? '';
          return send(res, 200, await handlers.proxyRelease(pin), 'text/plain; charset=utf-8');
        }
        if (req.method === 'POST' && route.startsWith('/proxy/hold')) {
          const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
          const held = await handlers.proxyHold(id);
          return send(res, 200, JSON.stringify(held), 'application/json');
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
          const state: BenchView = { ...await handlers.getState(), primary: primaryId === client };
          return send(res, 200, JSON.stringify(state), 'application/json');
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          switch (route) {
            case '/save': await handlers.save(String(body.comment ?? '')); break;
            case '/discard': await handlers.discard(); break;
            case '/step-traffic': await handlers.stepTraffic(); break;
            case '/hold/let': await handlers.releaseWaiting(Number(body.id)); break;
            case '/devtools': {
              const said = await handlers.openDevtools();
              return send(res, 200, said, 'text/plain; charset=utf-8');
            }
            case '/hold': {
              const action = ['hold', 'release', 'step'].includes(String(body.action)) ? body.action as 'hold' | 'release' | 'step' : undefined;
              const layers = Array.isArray(body.layers)
                ? body.layers.filter((layer: unknown): layer is 'code' | 'ui' | 'network' => layer === 'code' || layer === 'ui' || layer === 'network')
                : undefined;
              if (action) await handlers.changeHold(action, layers);
              break;
            }
            case '/tick':
              await handlers.tick(
                body.steps !== undefined
                  ? { steps: Math.max(1, Number(body.steps) || 1) }
                  : { budgetMs: Math.max(1, Number(body.budgetMs) || 100) }
              );
              break;
            case '/picker': await handlers.setPicker(!!body.armed); break;
            case '/input/person': await handlers.setPersonInput(!!body.on); break;
            case '/hold/page': await handlers.setHeld(!!body.held, body.resume === true); break;
            case '/sequence/select': await handlers.selectSequence(String(body.name ?? '')); break;
            case '/sequence/describe':
              await handlers.describeSequence(
                String(body.description ?? ''), String(body.expectedOutcome ?? ''));
              break;
            case '/sequence/step/pause':
              await handlers.setPausePoint(Math.max(0, Number(body.step) || 0), {
                ...(typeof body.on === 'boolean' ? { on: body.on } : {}),
                ...(Array.isArray(body.holds)
                  ? { holds: body.holds.filter((layer: unknown): layer is 'code' | 'ui' | 'network' => layer === 'code' || layer === 'ui' || layer === 'network') }
                  : {}),
              });
              break;
            case '/sequence/step/comment':
              await handlers.commentSequenceStep(
                Math.max(0, Number(body.step) || 0), String(body.words ?? ''));
              break;
            case '/sequence/goto': await handlers.gotoSequenceStep(Math.max(0, Number(body.step) || 0)); break;
            case '/sequence/step': await handlers.stepSequence(); break;
            case '/sequence/play': await handlers.playSequence(); break;
            case '/sequence/baseline': await handlers.baselineSequence(); break;
            case '/sequence/halt': await handlers.haltSequence(); break;
            case '/runs/stop': await handlers.stopRun({
              ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
              ...(typeof body.connection === 'string' ? { connection: body.connection } : {}),
            }); break;
            case '/sequence/cancel': await handlers.cancelSequence(); break;
            case '/sequence/delete': await handlers.removeSequence(String(body.name ?? '')); break;
            case '/runs/here': await handlers.playHere(String(body.name ?? '')); break;
            case '/sequence/playto':
              await handlers.playToStep(String(body.name ?? ''), Math.max(0, Number(body.step) || 0));
              break;
            case '/runs/start':
              return send(res, 200, JSON.stringify({ failure: (await handlers.runFromHome(String(body.name ?? ''))) ?? null }), 'application/json');
            case '/sequence/rename':
              return send(res, 200, JSON.stringify(await handlers.renameFromHome(String(body.from ?? ''), String(body.to ?? ''))), 'application/json');
            case '/sequence/failure/dismiss': await handlers.dismissFailure(); break;
            case '/sequence/repair': await handlers.repairStep(body.accept === 'element' ? 'element' : 'selector'); break;
            case '/dialog/answer': await handlers.answerDialog(body.accept === true); break;
            case '/sequence/record':
              await handlers.recordSequence(
                String(body.name ?? ''), !!body.withAgent, String(body.startUrl ?? ''));
              break;
            case '/sequence/record/into':
              await handlers.recordInto(Number.isInteger(body.after) ? Math.max(-1, body.after as number) : -1);
              break;
            case '/sequence/record/stop': await handlers.stopRecordingSequence(); break;
            case '/sequence/record/cancel': await handlers.cancelRecordingSequence(); break;
            case '/sequence/step/edit':
              await handlers.editSequenceStep(Math.max(0, Number(body.index) || 0), body.params);
              break;
            case '/sequence/step/timer':
              await handlers.insertSequenceTimer(Math.max(0, Number(body.after) || 0), Math.min(600000, Math.max(0, Number(body.ms) || 0)));
              break;
            case '/sequence/step/check':
              if (body.params && typeof body.params === 'object') {
                await handlers.insertSequenceCheck(Math.max(0, Number(body.after) || 0), body.params as Record<string, unknown>,
                  typeof body.comment === 'string' ? body.comment : undefined);
              }
              break;
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
                Math.max(0, Number(body.to) || 0),
                Math.max(1, Number(body.count) || 1)
              );
              break;
            case '/sequence/record/keep': await handlers.keepRecordedStep(); break;
            case '/sequence/record/variable/edit':
              await handlers.editRecordingVariable(String(body.name ?? ''),
                body.remove === true ? null : String(body.value ?? '').slice(0, 4000));
              break;
            case '/sequence/record/variable':
              await handlers.addRecordingVariable(String(body.name ?? '').trim(), String(body.value ?? '').slice(0, 4000));
              break;
            case '/sequence/record/timer':
              await handlers.addRecordingTimer(Math.min(600000, Math.max(0, Number(body.ms) || 0)));
              break;
            case '/sequence/record/flag':
              await handlers.flagRecordedStep(String(body.reason ?? ''), body.options, body.detail);
              break;
            case '/sequence/record/choose':
              await handlers.chooseStepSelector(Math.max(0, Number(body.index) || 0));
              break;
            case '/sequence/record/drop': await handlers.dropRecordedStep(); break;
            case '/sequence/note': await handlers.noteAtStep(Math.max(0, Number(body.step) || 0)); break;
            case '/annotation/delete': await handlers.removeAnnotation(String(body.id ?? '')); break;
            case '/annotation/move':
              await handlers.moveAnnotation(
                String(body.id ?? ''), Math.max(0, Number(body.step) || 0),
                typeof body.after === 'string' ? body.after : undefined,
              );
              break;
            case '/annotation/reword':
              await handlers.rewordAnnotation(String(body.id ?? ''), String(body.words ?? '').slice(0, 4000));
              break;
            case '/annotation/notify': await handlers.notifyAnnotation(String(body.id ?? '')); break;
            case '/shot':
              await handlers.captureScreenshot({
                kind: body.selector ? 'element' : body.kind === 'screen' ? 'screen' : 'page',
                ...(body.selector ? { selector: String(body.selector) } : {}),
                widen: Math.max(0, Number(body.widen) || 0),
                ...(body.annotationId ? { annotationId: String(body.annotationId) } : {}),
                ...(body.viewport ? { viewportMark: true } : {}),
              });
              break;
            case '/shot/begin':
              await handlers.beginCapture(body.annotationId ? String(body.annotationId) : undefined);
              break;
            case '/shot/cancel': await handlers.cancelCapture(); break;
            case '/shot/facts/read':
              await handlers.readMoreFacts((Array.isArray(body.kinds) ? body.kinds : [])
                .filter((k: unknown): k is FactKind => typeof k === 'string' && FACT_KINDS.includes(k as FactKind)));
              break;
            case '/shot/facts':
              await handlers.setFactChoice((Array.isArray(body.kinds) ? body.kinds : [])
                .filter((k: unknown): k is FactKind => typeof k === 'string' && FACT_KINDS.includes(k as FactKind)));
              break;
            case '/shot/save': {
              const crop = body.crop && typeof body.crop === 'object'
                ? {
                  x: Number(body.crop.x) || 0, y: Number(body.crop.y) || 0,
                  w: Number(body.crop.w) || 0, h: Number(body.crop.h) || 0,
                }
                : undefined;
              const facts = Array.isArray(body.facts)
                ? body.facts.filter((k: unknown): k is FactKind => typeof k === 'string' && FACT_KINDS.includes(k as FactKind))
                : undefined;
              await handlers.saveScreenshot(typeof body.marked === 'string' ? body.marked : undefined, crop, facts);
              break;
            }
            case '/shot/discard': await handlers.discardScreenshot(); break;
            case '/shot/retake':
              await handlers.retakeCapture(
                String(body.path ?? ''),
                body.against === undefined ? undefined : Math.max(1, Number(body.against) || 1));
              break;
            case '/annotation/highlight': await handlers.highlightAnnotation(String(body.selector ?? '')); break;
            case '/sequence/baseurl': await handlers.setBaseUrl(String(body.baseUrl ?? '')); break;
            case '/boundary/rule': await handlers.setRule(body); break;
            case '/boundary/rule/clear': await handlers.clearRule(String(body.key ?? '')); break;
            case '/boundary/ignore': await handlers.ignoreTraffic(body); break;
            case '/boundary/hidden/clear': await handlers.unhideKind(String(body.key ?? '')); break;
            case '/boundary/hidden/use': await handlers.setHiddenUse(String(body.key ?? ''), body.on === true); break;
            case '/boundary/hidden/mode':
              if (body.mode === 'local' || body.mode === 'optIn' || body.mode === 'optOut') {
                await handlers.setHiddenMode(String(body.key ?? ''), body.mode);
              }
              break;
            case '/boundary/rule/use': await handlers.setResponseUse(String(body.key ?? ''), body.use); break;
            case '/boundary/rule/mode':
              if (body.mode === 'local' || body.mode === 'optIn' || body.mode === 'optOut') {
                await handlers.setResponseMode(String(body.key ?? ''), body.mode);
              }
              break;
            case '/boundary/name':
              await handlers.setName(String(body.key ?? ''), String(body.name ?? '').slice(0, 80));
              break;
            case '/sequence/activity/move':
              await handlers.moveActivity({
                kind: String(body.kind ?? ''),
                at: Math.max(0, Number(body.at) || 0),
                to: Math.max(0, Number(body.to) || 0),
                ...(typeof body.origin === 'string' ? { origin: body.origin } : {}),
                ...(recordedIn(body.recorded) ? { recorded: recordedIn(body.recorded) } : {}),
              });
              break;
            case '/sequence/recorded':
              await handlers.setRecorded(
                Math.max(0, Number(body.step) || 0), String(body.kind ?? ''), recordedIn(body.recorded));
              break;
            case '/sequence/expected':
              await handlers.setExpected(
                Math.max(0, Number(body.step) || 0), String(body.kind ?? ''), expectedIn(body.expected));
              break;
            default: return send(res, 404, 'Not found', 'text/plain');
          }
          return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        }
        send(res, 404, 'Not found', 'text/plain');
      } catch (error) {
        send(res, 500, JSON.stringify({ error: String(error) }), 'application/json');
      }
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 rather than localhost: a different site from the app under test,
    // so the bench gets its own renderer process.
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
