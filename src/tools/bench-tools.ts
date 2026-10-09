/**
 * Bench tool - hold the page still, click what is wrong, keep working.
 *
 * Mode control only; the hold, the picker and the annotation store live in
 * `src/bench-mode/`, and the page it is driven from in `src/bench-control.ts`.
 * Nothing here blocks: `start` returns as soon as the bench tab is open, and
 * each saved annotation arrives on the session's event stream instead of on
 * this call's response.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { basename, join, resolve } from 'path';
import { getOutputPath } from '../helpers/paths.js';
import { autoLaunchChrome } from './replay-executor.js';
import { openBackgroundPage } from '../puppeteer-manager.js';
import { translateSequence } from './legacy-steps.js';
import type { SourceMapHandler } from '../sourcemap-handler.js';
import type { CommandRecorder } from '../command-recorder.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { resolveSessionName } from '../session-identity.js';
import { getSessionInfo } from './dashboard-tools.js';
import { getEventStreamPath, streamReaders, watchCall } from '../session-events.js';
import type { ToolResponseMeta, BenchToolMeta } from '../tool-response.js';
import { readCapture, versionsOf } from '../capture-file.js';
import { sweepCaptures } from '../bench-mode/capture-sweep.js';
import { startBench, stopBench, tickBench, setHeld, setPicker, getBenchSession, getSequenceState, pageHeldElsewhere, runningBench, selectSequence, gotoSequenceStep, keepRecordedStep, dropRecordedStep, flagRecordedStep, type Annotation, type SequenceState, capturesInFlight, retakeCapture } from '../bench-mode.js';
import { NO_TOOL_VALUES, type ServerLog, type ServerRow, type ToolGroup, type ToolValues } from '../bench/wire.js';
import { createSequenceDriver, getSequencesRoot, labelFor } from '../bench-mode/sequence-driver.js';
import { answerCalls, describeDialog, type OpenDialog } from '../dialog-monitor.js';
import { sanitizeReference } from '../reference-validator.js';
import { holdReading } from '../hold.js';

const benchSchema = z.object({
  action: z.enum(['start', 'stop', 'tick', 'hold', 'release', 'picker', 'list', 'status', 'keepStep', 'dropStep', 'flagStep', 'sweep', 'retake', 'capture']),
  connection: z.string()
    .describe('The connection, by the name connection launch or attach gave it'),
  steps: z.number().int().positive().max(1000).optional()
    .describe('tick: callbacks to run before holding again (default 1)'),
  budgetMs: z.number().int().positive().max(60000).optional()
    .describe('tick: in place of steps, run callbacks until at least this much page time has passed'),
  armed: z.boolean().optional()
    .describe('picker: true arms Chrome\'s element picker, false disarms it so clicks reach the app'),
  remove: z.boolean().optional()
    .describe('sweep: delete what it reports (default: report only)'),
  limit: z.number().int().positive().max(500).optional()
    .describe('list: most recent N annotations (default 20)'),
  url: z.string().optional()
    .describe('start: navigate here first; with no browser on this connection name, one is launched at it'),
  sequence: z.string().optional()
    .describe('start: open the pane with this sequence selected'),
  openTab: z.boolean().optional()
    .describe('start: false starts the bench with no tab of its own, for a bench tab already open to move to (default true)'),
  reason: z.string().optional()
    .describe('flagStep: one short line naming what is wrong, the headline the person reads first'),
  detail: z.string().optional()
    .describe('flagStep: an optional second line of context under the headline'),
  options: z.array(z.object({
    selector: z.string().describe('a selector that would work here'),
    note: z.string().describe('what makes this one hold up, in a few words'),
  })).optional()
    .describe('flagStep: selectors checked against the page, one row each, for the person to lock in with one click'),
  step: z.number().int().min(0).optional()
    .describe('start: with sequence, run it to this 0-based step and hold there'),
  capture: z.string().optional()
    .describe('retake/capture: path of a capture file, any version of its series'),
  against: z.number().int().positive().optional()
    .describe('retake: the version to compare with (default 1)'),
  saveAs: z.string().optional()
    .describe('Sequence step only (start): stores { url } of the bench page for later steps as {{var:name.url}}'),
}).strict();

type BenchArgs = z.infer<typeof benchSchema>;

const DEFAULT_LIST_LIMIT = 20;

function buildMeta(action: BenchArgs['action'], extra: Partial<BenchToolMeta>): ToolResponseMeta {
  return {
    tool: 'bench',
    action,
    timestamp: Date.now(),
    bench: { action, ...extra },
  };
}

/** One note with the step it hangs off, since that is what locates it again. */
export interface SequenceAnnotation {
  sequence: string;
  /** 0-based index of the command it is stored in. */
  step: number;
  stepLabel: string;
  annotation: Annotation;
}

function formatAnnotations(entries: SequenceAnnotation[]): string {
  return entries
    .map(({ sequence, step, stepLabel, annotation: a }) => {
      // A note about the step itself points at no element, so there is no
      // selector line to print and the step's own label is where it happened.
      const where = a.target?.source?.fileName
        ? `${a.target.source.fileName}:${a.target.source.lineNumber ?? ''}`
        : a.target?.component ?? a.target?.selector ?? 'the step itself';
      const at = a.target ? `\n  ${a.target.selector}` : '';
      return `- [${a.id}] ${sequence} step ${step + 1} (${stepLabel})\n  t+${a.tick}ms  ${where}${at}\n  "${a.comment}"`;
    })
    .join('\n');
}

/** Every note in every saved sequence on disk, oldest first. */
async function readSequenceAnnotations(commandRecorder: CommandRecorder): Promise<SequenceAnnotation[]> {
  const saved = await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as any[]);
  const out: SequenceAnnotation[] = [];
  for (const entry of saved) {
    let sequence: any;
    try {
      sequence = translateSequence(JSON.parse(await fs.readFile(entry.fullPath, 'utf-8')));
    } catch {
      // A sequence file that will not parse is not worth failing a list over.
      continue;
    }
    (sequence.commands ?? []).forEach((command: any, step: number) => {
      for (const annotation of command.annotations ?? []) {
        out.push({ sequence: sequence.name ?? entry.name, step, stepLabel: labelFor(command), annotation });
      }
    });
  }
  return out.sort((a, b) => a.annotation.at.localeCompare(b.annotation.at));
}

/**
 * The page's standing as a reply names it: the debugger's pause where one
 * stands, else every non-network hold with its source, else the bench's own
 * hold, else running. The bench's flag alone reads a pause another surface
 * took as running.
 */
export function pageStanding(connection: string, cdpManager: { pausedAt(): { url: string; line: number } | undefined } | undefined, frozen: boolean): string {
  const pausedAt = cdpManager?.pausedAt();
  if (pausedAt) return `paused in the debugger at ${pausedAt.url}:${pausedAt.line}`;
  const held = holdReading(connection).held.filter(one => one.layer !== 'network');
  if (held.length) return `held (${held.map(one => `${one.layer} by ${one.source}`).join(', ')})`;
  return frozen ? 'held' : 'running';
}

export function createBenchTools(
  sourceMapHandler: SourceMapHandler,
  commandRecorder: CommandRecorder,
  executeToolCall: (tool: string, args: Record<string, unknown>) => Promise<any>,
  resolveConnectionByName: (connection: string) => Promise<any>,
  catalogue: () => ToolGroup[],
  values: () => Promise<ToolValues> = async () => NO_TOOL_VALUES,
  servers: () => Promise<ServerRow[]> = async () => [],
  serverLog: (id: string, stream: 'stdout' | 'stderr') => Promise<ServerLog> = async () => ({ unavailable: 'no server manager' }),
) {
  const bench = createTool(
      'Open the bench beside a driven app: hold the page still, read what crossed its boundary and what caused each thing, record and step sequences, and collect element-level comments. Actions: start (the page running, the picker idle), hold/release (the whole page, with the bench left open), picker (armed or disarmed), tick (run a held page forward by steps or budgetMs), stop (release the page and close), keepStep/dropStep/flagStep (settle a recorded step), sweep (note captures no sequence cites), retake (a capture\'s region again, compared), capture (a capture file\'s record and element facts), list, status.',
      benchSchema,
      async (args: BenchArgs) => {
        const { action, connection: named } = args;
        const sessionName = resolveSessionName(getSessionInfo()?.shortId);

        if (action === 'list') {
          const all = await readSequenceAnnotations(commandRecorder);
          const limit = args.limit ?? DEFAULT_LIST_LIMIT;
          const recent = all.slice(-limit);
          const response = createSuccessResponse('BENCH_LIST', {
            count: recent.length,
            total: all.length,
            path: getSequencesRoot(commandRecorder),
            annotationList: recent.length ? formatAnnotations(recent) : '_none yet_',
          });
          return {
            ...response,
            _meta: buildMeta('list', { annotations: recent.map(entry => entry.annotation), total: all.length }),
          };
        }

        // Reads one file, so it needs no browser.
        if (action === 'capture') {
          if (!args.capture) return createErrorResponse('BENCH_CAPTURE_UNREAD', { path: '(none given)', reason: 'pass `capture` with the file path' });
          const read = await readCapture(args.capture).catch((error: unknown) => ({ error: String(error) }));
          if ('error' in read || !read.record) {
            return createErrorResponse('BENCH_CAPTURE_UNREAD', {
              path: args.capture,
              reason: 'error' in read ? read.error : 'the PNG carries no capture record',
            });
          }
          const versions = await versionsOf(read.record.series);
          const response = createSuccessResponse('BENCH_CAPTURE_READ', {
            path: args.capture,
            series: read.record.series,
            version: read.record.version,
            versions: versions.map(v => `v${v.version}`).join(' '),
            record: formatCodeBlock(JSON.stringify(read.record, null, 2), 'json'),
            facts: read.facts ? formatCodeBlock(JSON.stringify(read.facts, null, 2), 'json') : '_no element facts recorded_',
          });
          return { ...response, _meta: buildMeta('capture', { capture: { path: args.capture, record: read.record, ...(read.facts ? { facts: read.facts } : {}), versions } }) };
        }

        // Reads the sequence stores and the capture directories, so it needs
        // no browser - asking for one would make tidying up wait on a launch.
        if (action === 'sweep') {
          const swept = await sweepCaptures(args.remove === true);
          const response = createSuccessResponse('BENCH_SWEPT', {
            orphans: swept.orphans.length,
            kB: Math.round(swept.bytes / 1024),
            removed: swept.removed,
            sequencesRead: swept.sequencesRead,
            stillCited: swept.referenced,
            heldByOpenDrafts: swept.inFlight,
            list: swept.orphans.length
              ? swept.orphans
                  .map(one => `- ${one.path.replace(`${swept.root}/`, '')}  ${Math.round(one.bytes / 1024)} kB`)
                  .join('\n')
              : '_none_',
          });
          return { ...response, _meta: buildMeta('sweep', { swept }) };
        }

        let resolved = await resolveConnectionByName(named);
        if (!resolved && action === 'start') {
          // Launched through a proxy: the bench reads what crosses one, and a
          // running browser cannot gain one, so launched outside it the bench
          // would show an empty boundary until a relaunch.
          const launched = await autoLaunchChrome(executeToolCall, named, 'bench.start', false, true);
          if (!launched.success) {
            return createErrorResponse(launched.errorType, {
              reference: named,
              error: launched.error,
            });
          }
          resolved = await resolveConnectionByName(named);
        }
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Start one with `connection` action `launch`.',
          });
        }

        const connection: string = resolved.connection.reference ?? resolved.connection.id;

        if (action === 'status') {
          const state = getBenchSession(connection);
          const dialog: OpenDialog | null = resolved.connection.dialogMonitor?.current() ?? null;
          // What the pane shows, read from the same state it polls: replay's
          // session ends with a run that failed or finished, while the pane
          // still holds the run's position, its failure and every step's mark.
          const pane = state ? await getSequenceState(connection).catch(() => undefined) : undefined;
          const sequence = pane?.name ? {
            name: pane.name,
            standing: pane.dialog ? 'waiting' as const
              : pane.playing ? 'running' as const
              : pane.busy ? 'stepping' as const
              : pane.failure ? 'failed' as const
              : pane.paused ? 'paused' as const
              : pane.total > 0 && pane.currentStep >= pane.total ? 'finished' as const
              : pane.currentStep > 0 ? 'stopped' as const : 'ready' as const,
            nextStep: Math.min(pane.currentStep + 1, pane.total),
            totalSteps: pane.total,
            ...(pane.failure ? { failure: pane.failure } : {}),
            ...(pane.dialog ? { dialog: pane.dialog.text } : {}),
            // The one step the standing turns on: the step that failed, else the
            // step the run goes to next. The sequence itself is a file to read.
            ...((() => {
              const at = pane.steps.find(step => step.failed) ?? pane.steps.find(step => step.current);
              return at ? { at: { step: at.index + 1, label: at.label } } : {};
            })()),
          } : null;
          const pausedAt = resolved.cdpManager?.pausedAt();
          const held = holdReading(connection).held.filter(one => one.layer !== 'network');
          const page = pageStanding(connection, resolved.cdpManager, state?.frozen === true);
          const lines = [
            state
              ? `Page ${page}, picker ${state.pickerArmed ? 'armed' : 'idle'}, ${state.totalSteps} callback(s)/${state.tickMs}ms stepped, ${state.picks} pick(s), ${state.annotations} annotation(s). Bench: ${state.benchUrl}`
              : `The bench is closed here. \`bench({ action: "start", connection: "${connection}" })\` opens it with the page running.`,
            sequence
              ? `**Sequence:** "${sequence.name}" ${sequence.standing} at step ${sequence.nextStep} of ${sequence.totalSteps}${sequence.at ? `: ${sequence.at.label}` : ''}.`
              : '**Sequence:** none selected.',
            ...(sequence?.failure ? [`**Failure:** ${sequence.failure}`] : []),
            ...(sequence?.dialog ? [`**Waiting on the person:** ${sequence.dialog}`] : []),
            dialog
              ? `**Dialog:** ${describeDialog(dialog)}. Answer: ${answerCalls(connection, dialog).map(call => `\`${call}\``).join(' or ') || 'on screen, by a person'}.`
              : '**Dialog:** none open.',
          ];
          const response = createSuccessResponse('BENCH_STATUS', {
            connection,
            active: state ? 'open' : 'closed',
            detail: lines.join('\n'),
          });
          return { ...response, _meta: buildMeta('status', { active: !!state, connection, state, pane: sequence, dialog, page: { paused: !!pausedAt, ...(pausedAt ? { pausedAt } : {}), held: held.map(one => ({ layer: one.layer, source: one.source })) } }) };
        }

        const targetPuppeteerManager = resolved.puppeteerManager;
        const browserError = checkBrowserAutomation(
          resolved.cdpManager,
          targetPuppeteerManager,
          `bench.${action}`,
          resolved.connection.port
        );
        if (browserError) return browserError;

        switch (action) {
          case 'start': {
            // An open bench is answered as it stands: nothing navigates, no
            // sequence opens, and the picker is left as it is.
            const running = runningBench(connection);
            if (running) {
              const unapplied = [args.url ? `url ${args.url}` : '', args.sequence ? `sequence "${args.sequence}"` : '']
                .filter(Boolean).join(' and ');
              const response = createSuccessResponse('BENCH_ALREADY_OPEN', {
                connection,
                benchUrl: running.benchUrl,
                held: pageStanding(connection, resolved.cdpManager, running.frozen),
                pickerState: running.pickerArmed ? 'armed' : 'idle',
                unapplied: unapplied || undefined,
              });
              return { ...response, _meta: buildMeta('start', { active: true, alreadyOpen: true, connection, state: running }) };
            }

            let page = targetPuppeteerManager.getPage();

            // A second session on the same tab would drive the first one's
            // page: its navigate moves the other off what it was watching.
            if (pageHeldElsewhere(page, connection)) {
              try {
                page = await openBackgroundPage(page.browser());
                await page.bringToFront();
              } catch (error) {
                return createErrorResponse('BENCH_TAB_FAILED', { message: String(error) });
              }
            }

            if (args.url) {
              try {
                await page.goto(args.url, { waitUntil: 'domcontentloaded' });
              } catch (error) {
                return createErrorResponse('NAVIGATION_FAILED', {
                  url: args.url,
                  message: String(error),
                });
              }
            }

            const state = await startBench({
              page,
              connection,
              sessionName,
              sourceMapHandler,
              sequences: createSequenceDriver(commandRecorder, executeToolCall, catalogue, values, servers, serverLog),
              // A window of its own in the same browser. A tab beside the app
              // hides it, and Chrome drops input sent to a hidden tab; a window
              // covering the app's keeps it rendering, under the launch flags
              // that stop occluded windows backgrounding. It can still be
              // dragged into Chrome's split view beside the app.
              openBench: args.openTab === false ? undefined : async (url: string) => {
                const tab = await openBackgroundPage(page.browser(), { newWindow: true });
                await tab.goto(url);
                await tab.bringToFront();
                return tab;
              },
            });

            let opened: SequenceState | undefined;
            let openFailure: string | undefined;
            if (args.sequence) {
              opened = await selectSequence(connection, args.sequence);
              openFailure = opened?.failure;
              if (!openFailure && args.step !== undefined) {
                opened = await gotoSequenceStep(connection, args.step);
                openFailure = opened?.failure;
              }
            }

            const streamPath = getEventStreamPath(sessionName);
            const response = createSuccessResponse('BENCH_STARTED', {
              connection,
              benchUrl: state.benchUrl,
              page: pageStanding(connection, resolved.cdpManager, state.frozen),
              eventStreamPath: streamPath,
              ...(await streamReaders(sessionName) === 0
                ? { watchCall: watchCall(sessionName) }
                : {}),
            });
            return {
              ...response,
              _meta: buildMeta('start', {
                active: true,
                connection,
                state,
                ...(opened ? { sequence: opened } : {}),
                ...(openFailure ? { sequenceFailure: openFailure } : {}),
              }),
            };
          }

          case 'keepStep':
          case 'dropStep':
          case 'flagStep': {
            const state = action === 'keepStep' ? await keepRecordedStep(connection)
              : action === 'dropStep' ? await dropRecordedStep(connection)
              : await flagRecordedStep(connection, args.reason ?? 'this step needs a look', args.options, args.detail);
            const response = createSuccessResponse('BENCH_STEP_SETTLED', {
              connection,
              verdict: action === 'keepStep' ? 'kept' : action === 'dropStep' ? 'dropped' : 'flagged for the person',
              steps: state?.steps?.length ?? 0,
            });
            return { ...response, _meta: buildMeta(action, { connection, sequence: state }) };
          }

          case 'retake': {
            if (!getBenchSession(connection)) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            if (!args.capture) {
              return createErrorResponse('BENCH_RETAKE_FAILED', { reason: 'pass `capture` with the file path to take again' });
            }
            const taken = await retakeCapture(connection, args.capture, args.against ?? 1);
            if ('failure' in taken) return createErrorResponse('BENCH_RETAKE_FAILED', { reason: taken.failure });
            const { compared } = taken.record;
            const response = createSuccessResponse('BENCH_RETAKEN', {
              version: taken.record.version,
              against: compared!.against,
              share: (compared!.share * 100).toFixed(1),
              changed: compared!.changed,
              edges: compared!.edges,
              box: compared!.box ? `${compared!.box.x},${compared!.box.y} ${compared!.box.w}×${compared!.box.h}` : 'none',
              size: `${compared!.size.before.join('×')} → ${compared!.size.after.join('×')}`,
              placedBy: compared!.placedBy,
              window: compared!.resized
                ? `The window was at ${compared!.resized.from.slice(0, 2).join('×')}@${compared!.resized.from[2]}x and was set to the recorded `
                  + `${compared!.resized.to.slice(0, 2).join('×')}@${compared!.resized.to[2]}x for the retake, then put back`
                  + `${compared!.resized.ran ? '; the held page ran while it resized, so it may have moved on' : ''}`
                  + `${compared!.resized.hidden ? '; the tab was in the background, where Chrome renders no frames, so layout set by script did not follow the size and a difference there may be that' : ''}.`
                : 'The window was at the recorded size.',
              scales: compared!.scales
                ? `\n\nThe two captures are at different scales, ${compared!.scales[0]}x and ${compared!.scales[1]}x image px per CSS px, so their pixels do not line up and the figures above measure the scaling, not the page. Compare the two panels by eye.`
                : '',
              factChanges: compared!.factChanges?.length ? compared!.factChanges.map(line => `- ${line}`).join('\n') : '_no element fact changed, or none recorded_',
              path: taken.path,
            });
            return { ...response, _meta: buildMeta('retake', { connection, capture: { path: taken.path, record: taken.record } }) };
          }

          case 'tick': {
            const tick = await tickBench(connection, {
              ...(args.steps !== undefined ? { steps: args.steps } : {}),
              ...(args.budgetMs !== undefined ? { budgetMs: args.budgetMs } : {}),
            });
            if (!tick) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('BENCH_TICKED', {
              connection,
              steps: tick.steps,
              actualMs: tick.actualMs,
              tickMs: tick.tickMs,
              totalSteps: tick.totalSteps,
              asked: tick.requestedSteps !== undefined
                ? `${tick.requestedSteps} callback(s)`
                : `at least ${tick.requestedMs}ms`,
              quiet: tick.quiet,
              ranList: tick.ran.length
                ? tick.ran.map(e => {
                    const where = e.url ? `${e.url.replace(/^https?:\/\/[^/]+/, '')}${e.line ? ':' + e.line : ''}` : '';
                    return `- #${e.index} ${e.at}ms  ${e.kind ?? 'callback'}  ${e.fn ?? ''}${where ? ' ' + where : ''}`.trimEnd();
                  }).join('\n')
                : '',
            });
            return {
              ...response,
              _meta: buildMeta('tick', { active: true, connection, state: getBenchSession(connection), tick }),
            };
          }

          case 'hold':
          case 'release': {
            const state = await setHeld(connection, action === 'hold');
            if (!state) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('BENCH_HOLD', {
              connection,
              held: state.frozen ? 'held' : 'running',
              detail: state.frozen
                ? 'The page is held: its JS is stopped, so it cannot be driven until it runs again.'
                : 'The page is running. Drive it to the moment worth holding, then hold it.',
              pickerState: state.pickerArmed ? 'armed' : 'idle',
            });
            return { ...response, _meta: buildMeta(action, { active: true, connection, state }) };
          }

          case 'picker': {
            await setPicker(connection, args.armed ?? true);
            const state = getBenchSession(connection);
            if (!state) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('BENCH_PICKER', {
              connection,
              pickerState: state.pickerArmed ? 'armed' : 'idle',
              detail: state.pickerArmed
                ? 'Every click in the app tab is now a pick.'
                : 'Clicks reach the app again. It has to be running for them to do anything.',
            });
            return { ...response, _meta: buildMeta('picker', { active: true, connection, state }) };
          }

          case 'stop': {
            const state = await stopBench(connection);
            if (!state) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('BENCH_STOPPED', {
              connection,
              picks: state.picks,
              annotations: state.annotations,
              tickMs: state.tickMs,
            });
            return { ...response, _meta: buildMeta('stop', { active: false, connection, state }) };
          }
        }
      }
    );

  return { bench };
}
