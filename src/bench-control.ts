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
 * freeze on the app pane cannot take it down with it.
 *
 * Every route is behind a random token in the path. The server accepts writes
 * (an annotation, a tick), and any page in any browser can reach a localhost
 * port; the token is what stops one that was not handed the URL.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve, sep, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getOutputPath } from './helpers/paths.js';
import type { BenchView, BoundaryState } from './bench/wire.js';

export type { BenchView } from './bench/wire.js';

export interface BenchHandlers {
  /** Everything but `primary`, which only the route can decide. */
  getState: () => Promise<Omit<BenchView, 'primary'>>;
  save: (comment: string) => Promise<void>;
  discard: () => Promise<void>;
  tick: (request: { steps?: number; budgetMs?: number }) => Promise<void>;
  setPicker: (armed: boolean) => Promise<void>;
  setFrozen: (frozen: boolean) => Promise<void>;
  selectSequence: (name: string) => Promise<void>;
  describeSequence: (description: string, expectedOutcome: string) => Promise<void>;
  commentSequenceStep: (index: number, words: string) => Promise<void>;
  addSequenceConditional: (
    index: number, condition: string, thenSequence: string, rejoinAt?: number
  ) => Promise<void>;
  gotoSequenceStep: (step: number) => Promise<void>;
  stepSequence: () => Promise<void>;
  playSequence: () => Promise<void>;
  /** Stop the run at the step it reached, leaving the sequence open. */
  haltSequence: () => Promise<void>;
  cancelSequence: () => Promise<void>;
  removeSequence: (name: string) => Promise<void>;
  dismissFailure: () => Promise<void>;
  /** What the proxy has seen, when this browser was launched through one. */
  proxyEvents: (sinceId: string | null) => Promise<BoundaryState>;
  /** The payload kept for one event, for reading and for holding. */
  proxyBody: (id: string) => Promise<string | null>;
  /** Answer this from now on with what it answered here. */
  /** Answers with the hold's id, so the bench can let go of it again. */
  proxyHold: (id: string) => Promise<{ text: string; pin?: string }>;
  proxyRelease: (pin: string) => Promise<string>;
  /** Report a reading that looks wrong, with everything the rule read. */
  proxyInvestigate: (id: string, note: string) => Promise<string>;
  /**
   * Ask the session to relaunch this browser through a proxy.
   *
   * The proxy is chosen at launch, so a running browser cannot gain one. This
   * puts the request on the event stream and returns; the relaunch is the
   * agent's to make, and the sequence being worked on is named so the bench
   * comes back where it was.
   */
  requestProxy: () => Promise<string>;
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
  /** Hold a step open until `count` things have crossed under it. 0 clears. */
  setWait: (step: number, count: number) => Promise<void>;
  /** Answer every unmatched write 403, or forward it. */
  setRefuseWrites: (on: boolean) => Promise<string>;
  /** Write the decisions onto the open sequence. */
  saveRules: () => Promise<string>;
  recordSequence: (name: string, withAgent: boolean, startUrl: string) => Promise<void>;
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
  /** Carry one note to another step of the open sequence. */
  moveAnnotation: (id: string, step: number) => Promise<void>;
  notifyAnnotation: (id: string) => Promise<void>;
  /** No selector captures the page; a selector captures that element's box. */
  captureScreenshot: (selector: string | undefined, widen: number, annotationId?: string) => Promise<void>;
  /** `marked` is the capture with its drawing baked in, as a base64 PNG. */
  saveScreenshot: (marked?: string) => Promise<void>;
  discardScreenshot: () => Promise<void>;
  highlightAnnotation: (selector: string) => Promise<void>;
  setBaseUrl: (baseUrl: string) => Promise<void>;
}

export interface BenchServer {
  url: string;
  port: number;
  close: () => Promise<void>;
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
    void (async () => {
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
        if (req.method === 'POST' && route === '/proxy/relaunch') {
          return send(res, 200, await handlers.requestProxy(), 'text/plain; charset=utf-8');
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
            case '/sequence/describe':
              await handlers.describeSequence(
                String(body.description ?? ''), String(body.expectedOutcome ?? ''));
              break;
            case '/sequence/step/comment':
              await handlers.commentSequenceStep(
                Math.max(0, Number(body.step) || 0), String(body.words ?? ''));
              break;
            case '/sequence/step/conditional':
              await handlers.addSequenceConditional(
                Math.max(0, Number(body.step) || 0),
                String(body.condition ?? ''),
                String(body.thenSequence ?? ''),
                body.rejoinAt === undefined || body.rejoinAt === null
                  ? undefined
                  : Math.max(0, Number(body.rejoinAt) || 0));
              break;
            case '/sequence/goto': await handlers.gotoSequenceStep(Math.max(0, Number(body.step) || 0)); break;
            case '/sequence/step': await handlers.stepSequence(); break;
            case '/sequence/play': await handlers.playSequence(); break;
            case '/sequence/halt': await handlers.haltSequence(); break;
            case '/sequence/cancel': await handlers.cancelSequence(); break;
            case '/sequence/delete': await handlers.removeSequence(String(body.name ?? '')); break;
            case '/sequence/failure/dismiss': await handlers.dismissFailure(); break;
            case '/sequence/record':
              await handlers.recordSequence(
                String(body.name ?? ''), !!body.withAgent, String(body.startUrl ?? ''));
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
            case '/annotation/move':
              await handlers.moveAnnotation(String(body.id ?? ''), Math.max(0, Number(body.step) || 0));
              break;
            case '/annotation/notify': await handlers.notifyAnnotation(String(body.id ?? '')); break;
            case '/shot':
              await handlers.captureScreenshot(
                body.selector ? String(body.selector) : undefined,
                Math.max(0, Number(body.widen) || 0),
                body.annotationId ? String(body.annotationId) : undefined
              );
              break;
            case '/shot/save':
              await handlers.saveScreenshot(
                typeof body.marked === 'string' ? body.marked : undefined);
              break;
            case '/shot/discard': await handlers.discardScreenshot(); break;
            case '/annotation/highlight': await handlers.highlightAnnotation(String(body.selector ?? '')); break;
            case '/sequence/baseurl': await handlers.setBaseUrl(String(body.baseUrl ?? '')); break;
            case '/boundary/rule': await handlers.setRule(body); break;
            case '/boundary/rule/clear': await handlers.clearRule(String(body.key ?? '')); break;
            case '/boundary/wait':
              await handlers.setWait(
                Math.max(0, Number(body.step) || 0), Math.max(0, Number(body.count) || 0));
              break;
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
