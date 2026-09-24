/**
 * Bench tool - hold the page still, click what is wrong, keep working.
 *
 * Mode control only; the freeze, the picker and the annotation store live in
 * `src/bench-mode.ts`, and the page it is driven from in `src/bench-control.ts`.
 * Nothing here blocks: `start` returns as soon as the bench tab is open, and
 * each saved annotation arrives on the session's event stream instead of on
 * this call's response.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { getOutputPath } from '../helpers/paths.js';
import { getIssuesBySequenceFile } from '../issue-tracker.js';
import { getProxy } from '../proxy/registry.js';
import { autoLaunchChrome } from './replay-executor.js';
import { stopRecording, cancelRecording, eventsToCommands } from '../interaction-recorder.js';
import { openBackgroundPage, type PuppeteerManager } from '../puppeteer-manager.js';
import type { SourceMapHandler } from '../sourcemap-handler.js';
import type { CommandRecorder } from '../command-recorder.js';
import { debugLog } from '../debug-logger.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { resolveSessionName } from '../session-identity.js';
import { getSessionInfo } from './dashboard-tools.js';
import { getEventStreamPath, appendEvent } from '../session-events.js';
import { announceSequenceSaved } from '../sequence-events.js';
import type { ToolResponseMeta, BenchToolMeta } from '../tool-response.js';
import {
  startBench,
  stopBench,
  tickBench,
  setFrozen,
  setPicker,
  type SequenceDriver,
  getBenchSession,
  pageHeldElsewhere,
  selectSequence,
  gotoSequenceStep,
  keepRecordedStep,
  dropRecordedStep,
  flagRecordedStep,
  type Annotation,
  type SequenceState,
  capturesInFlight,
} from '../bench-mode.js';

const benchSchema = z.object({
  action: z.enum(['start', 'stop', 'tick', 'freeze', 'unfreeze', 'picker', 'list', 'status', 'keepStep', 'dropStep', 'flagStep', 'sweep'])
    .describe('start (open the bench with the page running and the picker idle), freeze/unfreeze (hold the page or let it run, without closing the bench - driving the app needs it running), picker (arm or disarm, via armed), tick (run forward by steps or budgetMs), stop (release the page and close), keepStep/dropStep (settle the recorded step capture is held on), sweep (report the note captures no sequence refers to, and with remove:true delete them), list, status'),
  connectionReason: z.string()
    .describe('Connection reference (use the reference from launchChrome output)'),
  steps: z.number().int().positive().max(1000).optional()
    .describe('tick: callbacks to run before freezing again (default 1). The exact unit - one callback is one thing the page does'),
  budgetMs: z.number().int().positive().max(60000).optional()
    .describe('tick: instead of steps, run callbacks until at least this much page time has been spent. Reports where it landed, which is rarely the number asked for'),
  armed: z.boolean().optional()
    .describe('picker: true arms Chrome\'s element picker, false disarms it so clicks reach the app'),
  remove: z.boolean().optional()
    .describe('sweep: delete what it reports. Omitted it only reports - a capture is evidence, and the count is worth reading before it goes'),
  limit: z.number().int().positive().max(500).optional()
    .describe('list: most recent N annotations (default 20)'),
  url: z.string().optional()
    .describe('start: go here first, then open the pane against it. With no browser on this reference yet, one is launched at this url - so a single call opens the page and the pane'),
  sequence: z.string().optional()
    .describe('start: open the pane with this sequence selected, so the person lands on the run being discussed rather than picking it out of a list'),
  reason: z.string().optional()
    .describe('flagStep: one short line naming what is wrong. Not a paragraph - it is the headline the person reads first'),
  detail: z.string().optional()
    .describe('flagStep: one more line of context under the headline, where it helps. Omit when the headline says enough'),
  options: z.array(z.object({
    selector: z.string().describe('a selector that would work here'),
    note: z.string().describe('what makes this one hold up, in a few words'),
  })).optional()
    .describe('flagStep: selectors the person can lock in with one click, one row each. Offer only ones checked against the page'),
  step: z.number().int().min(0).optional()
    .describe('start: with sequence, run it to this step (0-based) and hold there - the state that step produces is what is on screen when the pane opens'),
}).strict();

type BenchArgs = z.infer<typeof benchSchema>;

const DEFAULT_LIST_LIMIT = 20;

/**
 * The note captures no sequence refers to any more.
 *
 * A note is erased by removing it from the sequence, which leaves the picture
 * it cited on disk with nothing pointing at it. Every sequence store is read,
 * not only the open one: a capture cited by another sequence is in use, and
 * deleting it would empty a note somewhere else.
 *
 * Only the bench's own note captures are considered. The `screenshot` tool
 * writes to the same directories and no annotation ever cites those, so a rule
 * of "unreferenced" alone would take every one of them.
 */
async function sweepCaptures(remove: boolean): Promise<NonNullable<BenchToolMeta['swept']>> {
  const cited = new Set<string>();
  let sequencesRead = 0;
  for (const store of [getOutputPath('sequences'), getOutputPath('sequences', { global: true })]) {
    const files = await fs.readdir(store).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await fs.readFile(join(store, file), 'utf8').catch(() => null);
      if (raw === null) continue;
      sequencesRead += 1;
      let parsed: { commands?: Array<{ annotations?: Annotation[] }> };
      try { parsed = JSON.parse(raw) as typeof parsed; } catch { continue; }
      for (const command of parsed.commands ?? []) {
        for (const note of command.annotations ?? []) {
          for (const shot of note.screenshots ?? []) cited.add(resolve(shot));
        }
      }
    }
  }
  // A capture taken and not yet saved is cited by nothing on disk.
  const inFlight = capturesInFlight();
  for (const shot of inFlight) cited.add(resolve(shot));

  const root = getOutputPath('screenshots');
  const orphans: Array<{ path: string; bytes: number }> = [];
  const days = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dir = join(root, day.name);
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      // Written by the screenshot tool, which no note ever cites.
      if (name.startsWith('screenshot-')) continue;
      const full = join(dir, name);
      if (cited.has(resolve(full))) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      orphans.push({ path: full, bytes: stat.size });
    }
  }

  let removed = 0;
  if (remove) {
    for (const orphan of orphans) {
      const gone = await fs.unlink(orphan.path).then(() => true).catch(() => false);
      if (gone) removed += 1;
    }
  }
  return {
    root,
    orphans,
    bytes: orphans.reduce((sum, one) => sum + one.bytes, 0),
    removed,
    sequencesRead,
    referenced: cited.size,
    inFlight: inFlight.length,
  };
}

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

/** Returned by record() when the person abandoned it; not a failure. */
export const CANCELLED = '\u0000cancelled';

/**
 * Stands in for the bench's own address inside a recorded sequence.
 *
 * The pane is served from an ephemeral port under a per-session token, so a
 * sequence recorded against it holds an address that resolves once and 404s
 * every session after. Recording the pane is how the tool gets driven with the
 * tool, and without this it is a one-shot.
 */
const PANE_TOKEN = '{{pane}}';

/** The live pane for this connection, with no trailing slash. */
function livePaneUrl(connection: string): string | undefined {
  const url = getBenchSession(connection)?.benchUrl;
  return url ? url.replace(/\/$/, '') : undefined;
}

/** Swap the live pane's address for the placeholder, or back again. */
function swapPaneUrl(url: string, connection: string, to: 'token' | 'live'): string {
  const live = livePaneUrl(connection);
  if (!live) return url;
  if (to === 'token') return url.startsWith(live) ? PANE_TOKEN + url.slice(live.length) : url;
  return url.startsWith(PANE_TOKEN) ? live + url.slice(PANE_TOKEN.length) : url;
}

/** The page a recording began on, as its opening step. */
function navigateFirst(url: string) {
  return { tool: 'navigate', params: { action: 'goto', url }, comment: 'open the page' };
}

/** Where the sequence files that hold the notes live. */
function getSequencesRoot(commandRecorder: CommandRecorder): string {
  return (commandRecorder as any).getSequencesDir?.(false) ?? '.devharness/sequences';
}

/** Every note in every saved sequence on disk, oldest first. */
async function readSequenceAnnotations(commandRecorder: CommandRecorder): Promise<SequenceAnnotation[]> {
  const saved = await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as any[]);
  const out: SequenceAnnotation[] = [];
  for (const entry of saved) {
    let sequence: any;
    try {
      sequence = JSON.parse(await fs.readFile(entry.fullPath, 'utf-8'));
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

/** The part of a command worth showing beside its name. */
function subjectOf(params: Record<string, any>): string {
  const subject = params?.selector ?? params?.url ?? params?.text ?? params?.key ?? params?.expression ?? '';
  return String(subject ?? '');
}

/** One line per recorded command, enough to recognise it in a list. */
function labelFor(command: { tool: string; params: Record<string, any> }): string {
  const { tool, params } = command;
  // A conditional carries no selector or url, so the general subject is empty
  // and the row reads only "conditional" - the one step whose whole behaviour
  // is the two fields it holds.
  if (tool === 'conditional') {
    const rejoin = params?.rejoinAt !== undefined
      ? `, then step ${Number(params.rejoinAt) + 1}`
      : '';
    return `conditional when ${params?.if ?? '?'} run ${params?.then ?? '?'}${rejoin}`;
  }
  const head = params?.action ? `${tool}.${params.action}` : tool;
  const subject = subjectOf(params);
  return `${head}${subject ? ' ' + subject.slice(0, 80) : ''}`;
}

/**
 * The same line with {{var:}} tokens filled in from the run's store, which is
 * the form that actually executed and the one worth checking when a selector
 * matches nothing.
 *
 * An {{env:}} token is never resolved. Its value is a credential - envFile
 * exists to keep it out of the sequence file - and this renders into a page
 * served over HTTP, so the name is shown and the value is not. The executor
 * takes the same line about its own logs.
 */
function resolvedFor(
  command: { tool: string; params: Record<string, any> },
  variables: Record<string, any>
): string | undefined {
  const subject = subjectOf(command.params);
  if (!subject.includes('{{')) return undefined;

  let sawToken = false;
  const filled = subject
    .replace(/\{\{env:([^}]+)\}\}/g, (_m, name) => { sawToken = true; return `🔒${String(name).trim()}`; })
    .replace(/\{\{var:([^}]+)\}\}/g, (_m, path) => {
      sawToken = true;
      const [head, ...rest] = String(path).trim().split('.');
      let value: any = variables?.[head];
      for (const key of rest) value = value == null ? value : value[key];
      if (value === undefined) return `⚠ ${String(path).trim()} not set`;
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    });

  return sawToken ? filled.slice(0, 120) : undefined;
}

/** Display form of a captured value: short, and never the raw object. */
function renderValue(value: unknown): { value: string; fields?: Array<{ key: string; value: string }> } {
  if (value === null || value === undefined) return { value: String(value) };
  if (typeof value !== 'object') {
    const text = typeof value === 'string' ? `"${value}"` : String(value);
    return { value: text.length > 80 ? text.slice(0, 80) + '…' : text };
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
  const summary = Array.isArray(value)
    ? `[${(value as unknown[]).length} items]`
    : `{${entries.map(([k]) => k).join(', ').slice(0, 60)}}`;
  return {
    value: summary,
    fields: entries.map(([key, inner]) => ({ key, value: renderValue(inner).value })),
  };
}

/**
 * The bench drives replay through its own tool rather than re-implementing the
 * executor: `run` with stepTo opens the step-through session replay already
 * has, and step/finish/cancel move it. Reading the session comes off the same
 * recorder the tool uses, so there is one source of truth for where it is up to.
 */
export function createSequenceDriver(
  commandRecorder: CommandRecorder,
  executeToolCall: (
    tool: string, args: Record<string, unknown>, abortSignal?: AbortSignal,
  ) => Promise<any>
): SequenceDriver {
  /** The human-readable text of a tool response, wherever it is carried. */
  const textOf = (value: any): string => {
    if (typeof value === 'string') return value;
    const carried = value?.content?.[0]?.text ?? value?.response?.content?.[0]?.text ?? value?.message;
    if (typeof carried === 'string') return carried;
    return carried == null ? '' : JSON.stringify(carried);
  };

  /**
   * A refused or failed step comes back as an ordinary response rather than a
   * thrown error, so its text is the only way to tell that nothing happened.
   * Returns the reason when there is one, and nothing when the step was fine.
   */
  const replay = async (
    args: Record<string, unknown>,
    /* Carried into the run itself. A `wait: true` run is driven under the
       tool call's own signal, so this is what stops a step part-way rather
       than leaving it to run out its settle against a page that has stopped. */
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    let text: string;
    try {
      text = textOf(await executeToolCall('replay', args, signal));
    } catch (error) {
      // executeToolCall raises an isError response as a ToolError carrying it.
      text = textOf(error);
    }

    if (!/^\s*(Error|\*\*BLOCKED)/.test(text) && !/\*\*Error:\*\*/.test(text)) return undefined;

    debugLog('bench', `replay ${args.action} failed: ${text.slice(0, 1200).replace(/\n/g, ' ')}`);
    // "Failed at step 2 (input)" - the only place the position is reported.
    const at = text.match(/Failed at step (\d+)/);
    failedStep = at ? Number(at[1]) - 1 : null;
    const detail = text.match(/\*\*Error:\*\*\s*([^\n|]+)/)?.[1]
      ?? text.split('\n').map(line => line.trim()).find(line => line && !/^Error: Step failed$/.test(line))
      ?? 'the step did not run';
    return String(detail).replace(/^Error:\s*/, '').trim().slice(0, 160);
  };

  // What has been chosen but not yet started. replay only opens a step-through
  // session once a step has actually run - `stepTo: 0` executes nothing and so
  // registers no pause - so selecting loads the sequence and the first step is
  // what starts the run.
  let selected: string | null = null;
  let selectedConnection = '';

  // replay drops its session the moment the last step runs, or a step fails.
  // Without remembering where it got to, a finished sequence reads as one that
  // never started - the cursor jumps back to zero while the page still shows
  // what the last step did.
  let reached = 0;
  let ended: 'complete' | 'failed' | null = null;
  /** Origin override for the run: a sequence recorded against one port can be
   *  pointed at another without editing the file. */
  let baseUrl = '';

  /**
   * The run's variable store, held by reference.
   *
   * replay drops its session as the last step completes, and the store goes
   * with it - so reading only the live session leaves the panel empty and the
   * resolved lines reading "not set" the moment a run finishes, which is
   * exactly when someone looks at what it captured. The store is the same
   * object the executor writes into, so keeping the reference keeps the final
   * values.
   */
  let variableStore: Record<string, any> = {};
  /** 0-based index of the step that failed, so the pane can mark that row. */
  let failedStep: number | null = null;

  const loadedByName = (name: string) =>
    commandRecorder.listSequences().find(sequence => sequence.name === name);

  /**
   * Where a sequence says it starts: its own startUrl, else the url of a first
   * step that opens or navigates somewhere.
   */
  const startUrlOf = (name: string): string | undefined => {
    const sequence = loadedByName(name);
    if (!sequence) return undefined;
    if (sequence.startUrl) return sequence.startUrl;
    const first = sequence.commands?.[0];
    if (!first) return undefined;
    const opensSomewhere = first.tool === 'launchChrome'
      || (first.tool === 'navigate' && first.params?.action === 'goto');
    const url = first.params?.url;
    return opensSomewhere && typeof url === 'string' ? url : undefined;
  };

  /**
   * Take the driven tab to where the sequence starts.
   *
   * Rebinding points every step at this tab, and that turns a `launchChrome`
   * step into a no-op: the reference is already bound, so it reuses the
   * connection and its `url` is never honoured - the step reports success while
   * the page has not moved. Navigating first makes the rebound run start where
   * the sequence says it does.
   */
  const goToStart = async (name: string, connection: string): Promise<void> => {
    let url = startUrlOf(name);
    if (!url) return;
    // A sequence recorded against the pane carries the placeholder, which this
    // session's own pane address fills in.
    url = swapPaneUrl(url, connection, 'live');
    if (url.startsWith(PANE_TOKEN)) {
      debugLog('bench', `"${name}" starts at the bench and none is open on ${connection}`);
      return;
    }
    if (baseUrl) {
      // Same rule replay applies to every absolute URL in the run: keep the
      // path and query, take the new origin.
      try {
        const recorded = new URL(url);
        const target = new URL(baseUrl);
        url = `${target.origin}${recorded.pathname}${recorded.search}`;
      } catch {
        // about:blank and friends have no origin to swap.
      }
    }
    try {
      await executeToolCall('navigate', { action: 'goto', url, connectionReason: connection });
    } catch (error) {
      debugLog('bench', `could not open the sequence's start url ${url}: ${error}`);
    }
  };

  /**
   * Point every reference the sequence recorded at the tab the bench holds.
   *
   * A sequence carries the connection references it was recorded against, so
   * replaying it drives those rather than the tab sitting next to the control
   * pane - which looks like the player doing nothing. `run` takes a rebinding
   * map for exactly this.
   *
   * Only for a sequence that uses one browser. Where it declares several - two
   * users, two profiles - collapsing them onto one tab would change what the
   * sequence tests, so they are left alone.
   */
  const rebindOnto = (name: string, connection: string): Record<string, string> | undefined => {
    const sequence = loadedByName(name);
    if (!sequence) return undefined;

    const references = new Set<string>();
    for (const command of sequence.commands ?? []) {
      const recorded = command.params?.connectionReason ?? command.params?.reference;
      if (typeof recorded === 'string' && recorded) references.add(recorded);
    }
    for (const declared of (sequence as any).requiredConnections ?? []) {
      if (declared?.reference) references.add(String(declared.reference));
    }

    references.delete(connection);
    if (references.size === 0) return undefined;
    if (references.size > 1) {
      debugLog('bench', `sequence ${name} uses ${references.size} connections; left unbound`);
      return undefined;
    }
    return Object.fromEntries([...references].map(reference => [reference, connection]));
  };

  /**
   * Let this run reach the hosts its own sequence names, and nothing else.
   *
   * A browser with no allow list reaches everything, which is what browsing
   * without a sequence needs. Opening one narrows it to the app being driven,
   * so a call the sequence never recorded is refused rather than made.
   */
  const scopeProxyTo = (name: string, connection: string): void => {
    const proxy = getProxy(connection);
    if (!proxy) return;
    const hosts = hostsOf(name);
    if (hosts.length) proxy.allowOnly(hosts);
  };

  /** Every host a sequence names, from its start url and its steps. */
  const hostsOf = (name: string): string[] => {
    const sequence = loadedByName(name);
    const found = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string' || !value) return;
      try { found.add(new URL(value).host); } catch { /* not an absolute url */ }
    };
    add(sequence?.startUrl);
    for (const command of sequence?.commands ?? []) add(command.params?.url);
    add(baseUrl);
    return [...found];
  };

  /**
   * The step-through session this bench opened, or nothing.
   *
   * `getActiveSequence` is global to the process: one bench's run, or a run
   * driven from the tool side, is visible to every other bench. Read without
   * this check, a bench reports and drives a sequence it never opened - and a
   * `goto` against it navigates the wrong browser to the wrong page.
   *
   * With nothing selected here, any run is adopted: that is how a bench opened
   * beside a run already in flight picks it up.
   */
  const ourRun = () => {
    const running = commandRecorder.getActiveSequence();
    if (!running) return undefined;
    if (selected !== null && running.sequenceName !== selected) return undefined;
    return running;
  };

  const openSequence = () => {
    const state = ourRun();
    if (state) return commandRecorder.getSequence(state.sequenceId);
    return selected ? loadedByName(selected) : undefined;
  };

  /** Writes the sequence back to the file it came from. */
  const persist = async (sequence: { id: string; name: string }): Promise<string | undefined> => {
    const saved = await commandRecorder.saveSequenceToDisk(sequence.id, false, true);
    if (!saved) return `"${sequence.name}" is no longer loaded`;
    if (!saved.success) return saved.error;
    await announceSequenceSaved(sequence as any, saved.filepath);
    return undefined;
  };

  return {
    listNames: async () => {
      const saved = await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as any[]);
      const names = new Set<string>();
      for (const entry of saved) {
        const name = typeof entry === 'string' ? entry : entry?.name ?? entry?.filename;
        if (name) names.add(String(name).replace(/\.json$/, ''));
      }
      for (const sequence of commandRecorder.listSequences()) names.add(sequence.name);
      return [...names].sort();
    },

    listCatalogue: async () => {
      const saved = await commandRecorder.listSavedSequencesOnDisk().catch(() => []);
      const cards = new Map<string, {
        name: string; steps: number; notes: number; description?: string; expectedOutcome?: string;
      }>();
      for (const entry of saved) {
        const name = String(entry.name ?? entry.filename).replace(/\.json$/, '');
        cards.set(name, {
          name,
          steps: entry.commandCount,
          notes: entry.noteCount,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.expectedOutcome ? { expectedOutcome: entry.expectedOutcome } : {}),
        });
      }
      // One held in memory and not yet written is still a sequence to open,
      // and the file listing cannot see it.
      for (const sequence of commandRecorder.listSequences()) {
        if (cards.has(sequence.name)) continue;
        cards.set(sequence.name, {
          name: sequence.name,
          steps: sequence.commands?.length ?? 0,
          notes: (sequence.commands ?? []).reduce(
            (total, command) => total + ((command as any).annotations?.length ?? 0), 0),
          ...(sequence.description ? { description: sequence.description } : {}),
        });
      }
      return [...cards.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    active: () => {
      const state = ourRun();
      if (state) {
        reached = state.currentStep;
        ended = null;
      }
      const sequence = state
        ? commandRecorder.getSequence(state.sequenceId)
        : (selected ? loadedByName(selected) : undefined);
      if (!sequence) return null;

      if (state?.capturedVariables) variableStore = state.capturedVariables;
      const store = variableStore;
      const commands = sequence.commands ?? [];

      // Where a value came from: the step whose command captured it under that
      // name. Anything left over was handed to the run rather than captured.
      const capturedAt = new Map<string, number>();
      commands.forEach((command, index) => {
        const name = command.params?.saveAs;
        if (typeof name === 'string' && !capturedAt.has(name)) capturedAt.set(name, index);
      });

      return {
        name: state?.sequenceName ?? sequence.name,
        ...(sequence.description ? { description: sequence.description } : {}),
        ...((sequence as { expectedOutcome?: string }).expectedOutcome
          ? { expectedOutcome: (sequence as { expectedOutcome?: string }).expectedOutcome }
          : {}),
        // No live session: hold the last position rather than implying step 0.
        currentStep: state?.currentStep ?? (ended === 'complete' ? commands.length : reached),
        total: state?.totalSteps ?? commands.length,
        failedStep: ended === 'failed' ? failedStep ?? undefined : undefined,
        steps: commands.map(command => {
          const resolved = resolvedFor(command, store);
          return {
            label: labelFor(command),
            ...(command.comment ? { comment: command.comment } : {}),
            ...(resolved ? { resolved } : {}),
            ...(typeof command.params?.saveAs === 'string' ? { captures: command.params.saveAs } : {}),
            ...(command.annotations?.length ? { annotations: command.annotations } : {}),
            ...(command.traffic ? { traffic: command.traffic } : {}),
          };
        }),
        variables: Object.entries(store).map(([name, value]) => {
          const step = capturedAt.get(name);
          return {
            name,
            ...renderValue(value),
            source: step === undefined ? 'run' : `step ${step + 1}`,
          };
        }),
      };
    },

    hosts: hostsOf,

    start: async (name: string, connection: string) => {
      // A session left standing - a run paused part-way, or one stopped by
      // hand - is owed the teardown of whatever it launched. Switching away
      // makes it unreachable: the driver stops recognising it the moment the
      // selection changes, and nothing drains what it declared.
      if (ourRun()) await replay({ action: 'cancel' });
      selected = name;
      selectedConnection = connection;
      reached = 0;
      ended = null;
      failedStep = null;
      variableStore = {};
      const failure = await replay({ action: 'load', filename: `${name}.json` });
      if (failure) return failure;
      // Scoped between the load and the first navigation: the hosts are
      // readable only once the file is in memory, and a host the proxy has
      // not been told about is refused the moment the run moves.
      scopeProxyTo(name, connection);
      await goToStart(name, connection);
      return undefined;
    },

    step: async (signal?: AbortSignal) => {
      if (ourRun()) {
        const before = ourRun()!.currentStep;
        const failure = await replay({ action: 'step', stepCount: 1 }, signal);
        const after = ourRun();
        if (after) reached = after.currentStep;
        else {
          // The session is gone: either the last step ran, or one failed.
          reached = failure ? (failedStep ?? before) : reached;
          ended = failure ? 'failed' : 'complete';
        }
        return failure;
      }
      if (selected) {
        return replay({
          action: 'run', name: selected, stepTo: 1, wait: true, connectionReason: selectedConnection,
          ...(rebindOnto(selected, selectedConnection) ? { connections: rebindOnto(selected, selectedConnection) } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        }, signal);
      }
      return undefined;
    },

    finish: async () => {
      if (ourRun()) {
        const failure = await replay({ action: 'finish' });
        ended = failure ? 'failed' : 'complete';
        return failure;
      }
      if (selected) {
        const failure = await replay({
          action: 'run', name: selected, wait: true, connectionReason: selectedConnection,
          ...(rebindOnto(selected, selectedConnection) ? { connections: rebindOnto(selected, selectedConnection) } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        });
        // A whole run leaves no session behind, so nothing else records where it
        // got to - and without that the cursor sits at 0 with the first step
        // marked current, however far the run actually went.
        const after = ourRun();
        if (after) {
          reached = after.currentStep;
          ended = null;
        } else {
          ended = failure ? 'failed' : 'complete';
          if (failure) reached = failedStep ?? reached;
          else reached = loadedByName(selected)?.commands.length ?? reached;
        }
        return failure;
      }
      return undefined;
    },

    goto: async (step: number) => {
      // This bench's own selection first: a session belonging to another one
      // would send this browser to a page its sequence never names.
      const name = selected ?? ourRun()?.sequenceName;
      if (!name) return undefined;
      // A fresh run is the only way back: replay steps forward, never back.
      if (ourRun()) await replay({ action: 'cancel' });
      selected = name;
      return replay({
        action: 'run', name, stepTo: step + 1, wait: true, connectionReason: selectedConnection,
        ...(rebindOnto(name, selectedConnection) ? { connections: rebindOnto(name, selectedConnection) } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
    },

    halt: async () => {
      // The session is the position, so it is left standing.
      //
      // The step in flight is stopped by its own signal, and `handleStep`
      // leaves the session open when it sees that abort - `currentStep` still
      // names the interrupted step. Carrying on therefore steps that one
      // again and goes on from there. Cancelling here instead would clear the
      // session, and the next step would start a fresh run from the first
      // command, taking every earlier step a second time.
      const at = ourRun()?.currentStep;
      if (typeof at === 'number') reached = at;
      ended = null;
    },

    cancel: async () => {
      if (ourRun()) await replay({ action: 'cancel' });
      selected = null;
      reached = 0;
      ended = null;
      variableStore = {};
    },

    remove: async (name: string) => {
      if (selected === name || ourRun()?.sequenceName === name) {
        if (ourRun()) await replay({ action: 'cancel' });
        selected = null;
        reached = 0;
        ended = null;
        variableStore = {};
      }
      const onDisk = (await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as any[]))
        .find((entry: any) => entry.name === name || entry.filename === `${name}.json`);
      if (!onDisk) return `no saved sequence named "${name}"`;
      // The exact path, never the name: deleteSequenceFromDisk falls back to
      // prefix matching, so "asd" would take "asdasd" with it.
      const removed = await commandRecorder.deleteSequenceFromDisk(onDisk.fullPath);
      if (!removed) return `could not remove "${name}"`;
      await appendEvent(resolveSessionName(getSessionInfo()?.shortId), 'sequence', {
        sequence: name,
        path: onDisk.fullPath,
        deleted: true,
        detail: `sequence "${name}" deleted`,
      });
      for (const sequence of commandRecorder.listSequences()) {
        if (sequence.name === name) commandRecorder.deleteSequence(sequence.id);
      }
      return undefined;
    },

    attachAnnotation: async (step: number, annotation: Annotation) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const command = sequence.commands?.[step];
      if (!command) return `step ${step + 1} is not in "${sequence.name}"`;
      command.annotations = [...(command.annotations ?? []), annotation];
      return persist(sequence);
    },

    moveAnnotation: async (id: string, step: number) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const target = sequence.commands?.[step];
      if (!target) return `step ${step + 1} is not in "${sequence.name}"`;
      // Lifted whole and put down once, in one write: detaching and attaching
      // as two saves leaves the note in no step at all if the second fails.
      let moving: Annotation | undefined;
      for (const command of sequence.commands ?? []) {
        const held = (command.annotations ?? []).find(note => note.id === id);
        if (!held) continue;
        moving = held;
        const kept = (command.annotations ?? []).filter(note => note.id !== id);
        if (kept.length) command.annotations = kept;
        else delete command.annotations;
      }
      if (!moving) return 'that note is not in the open sequence';
      target.annotations = [...(target.annotations ?? []), moving];
      return persist(sequence);
    },

    detachAnnotation: async (id: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      let found = false;
      for (const command of sequence.commands ?? []) {
        const kept = (command.annotations ?? []).filter(note => note.id !== id);
        if (kept.length !== (command.annotations ?? []).length) {
          found = true;
          if (kept.length) command.annotations = kept;
          else delete command.annotations;
        }
      }
      if (!found) return 'that note is not in the open sequence';
      return persist(sequence);
    },

    record: async (name: string, connection: string, startUrl: string) => {
      // Dropped for the duration: openSequence falls back to the selection,
      // and a write arriving during the recording would otherwise land on the
      // sequence that was open before it and be saved to that file.
      selected = null;
      const result = await executeToolCall('replay', {
        action: 'recordInteraction',
        connectionReason: connection,
        showOverlay: false,
        closeTabOnDone: false,
        ...(name ? { name } : {}),
      }).catch((error: any) => ({ isError: true, error }));
      if (result?._meta?.replay?.cancelled) return CANCELLED;
      if (result?.isError) return `recording failed: ${result.error ?? 'unknown'}`;
      selected = name || null;
      selectedConnection = connection;
      reached = 0;
      ended = null;
      variableStore = {};

      // Recording leaves the sequence in memory; without this it is gone when
      // the server restarts, while the pane lists it as though it were saved.
      const recorded = loadedByName(name);
      if (recorded) {
        // The page it began on is the sequence's own first step, so a replay
        // starts where the recording did rather than wherever a tab happens to be.
        if (startUrl && recorded.commands?.[0]?.tool !== 'navigate') {
          recorded.commands = [navigateFirst(swapPaneUrl(startUrl, connection, 'token')), ...(recorded.commands ?? [])];
        }
        const saved = await commandRecorder.saveSequenceToDisk(recorded.id, false, true);
        if (!saved) return `"${name}" recorded but is no longer loaded`;
        if (!saved.success) return `"${name}" recorded but not saved: ${saved.error}`;
        await announceSequenceSaved(recorded, saved.filepath);
      }
      return undefined;
    },

    stopRecording: async (connection: string) => {
      await stopRecording(connection);
    },

    cancelRecording: async (connection: string) => {
      await cancelRecording(connection);
    },

    saveBoundaryRules: async (
      rules: Array<Record<string, unknown>>,
      waits: Array<{ step: number; count: number }>,
      refuseWrites: boolean
    ) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const held = sequence as {
        boundaryRules?: Array<Record<string, unknown>>;
        boundaryWaits?: Array<{ step: number; count: number }>;
        boundaryRefuse?: 'writes';
      };
      if (rules.length) held.boundaryRules = rules; else delete held.boundaryRules;
      if (waits.length) held.boundaryWaits = waits; else delete held.boundaryWaits;
      if (refuseWrites) held.boundaryRefuse = 'writes'; else delete held.boundaryRefuse;
      return persist(sequence);
    },

    openBoundaryRules: () => {
      const sequence = openSequence();
      if (!sequence) return { rules: [], waits: [], refuseWrites: false };
      const held = sequence as {
        boundaryRules?: Array<Record<string, unknown>>;
        boundaryWaits?: Array<{ step: number; count: number }>;
        boundaryRefuse?: 'writes';
      };
      return {
        rules: held.boundaryRules ?? [],
        waits: held.boundaryWaits ?? [],
        refuseWrites: held.boundaryRefuse === 'writes',
      };
    },

    saveStepTraffic: async (entries: Array<{ index: number; traffic: any }>) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      for (const { index, traffic } of entries) {
        if (index >= 0 && index < commands.length) commands[index].traffic = traffic;
      }
      return persist(sequence);
    },

    trafficIn: async (connection: string, from: number, to: number) => {
      const empty = { requests: 0, failed: 0, opened: 0, writes: 0, lines: [] as string[] };
      const http = await executeToolCall('network', {
        action: 'list', connectionReason: connection, since: from, until: to, limit: 50,
      }).catch(() => null);
      const rows = http?._meta?.network?.requests ?? [];
      // A transport counts against the action that OPENED it, by its open
      // clock. What it later carries does not: a socket opened by one action
      // can be sent on by another, and what comes back belongs where it
      // arrived, not to whoever opened the pipe.
      const inWindow = (t: any) => t.openedAt >= from && t.openedAt < to;
      const sockets = await executeToolCall('network', {
        action: 'sockets', connectionReason: connection,
      }).catch(() => null);
      const streams = await executeToolCall('network', {
        action: 'streams', connectionReason: connection,
      }).catch(() => null);
      const transports = [
        ...(sockets?._meta?.socketList ?? []).filter(inWindow),
        ...(streams?._meta?.streamList ?? []).filter(inWindow),
      ];
      const stored = await executeToolCall('storage', {
        action: 'writes', connectionReason: connection, since: from, until: to,
      }).catch(() => null);
      const written = (stored?._meta?.storage?.writes ?? []) as any[];
      if (rows.length === 0 && transports.length === 0 && written.length === 0) return empty;
      return {
        requests: rows.length,
        failed: rows.filter((r: any) => r.failed || (r.status ?? 0) >= 400).length,
        opened: transports.length,
        writes: written.length,
        lines: [
          ...rows.slice(0, 8).map((r: any) => {
            const path = (() => { try { return new URL(r.url).pathname; } catch { return r.url; } })();
            return `${r.method} ${path} ${r.failed ? 'failed' : (r.status ?? 'pending')}`;
          }),
          ...transports.slice(0, 4).map((t: any) => `opened ${t.url}`),
          ...written.slice(0, 4).map((w: any) => `${w.area}Storage ${w.operation} ${w.key ?? ''}`.trim()),
        ],
      };
    },

    recordedSoFar: (eventsJson: string, startUrl: string) => {
      let events: any[] = [];
      try { events = JSON.parse(eventsJson); } catch { events = []; }
      const times: number[] = [];
      const converted = eventsToCommands(events, {
        simplify: true, includeHovers: false, timestampsOut: times,
      });
      // The same guard the save uses: where the recording already opens on a
      // navigate, prepending another shifts every step of this list one past
      // its position in the file, and a note written here lands on the step
      // before the one it was written against.
      const lead = startUrl && converted[0]?.tool !== 'navigate' ? [navigateFirst(startUrl)] : [];
      const commands = [...lead, ...converted];
      // The synthesised opening navigate has no source event, so it takes the
      // clock of whatever followed it.
      const at = [...lead.map(() => times[0]), ...times];
      return commands.map((command, index) => ({
        index,
        label: labelFor(command),
        ...(command.comment ? { comment: command.comment } : {}),
        ...(at[index] !== undefined ? { at: at[index] } : {}),
        done: true,
        current: false,
      }));
    },

    setVariable: async (name: string, value: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a usable variable name`;
      const commands = [...(sequence.commands ?? [])];
      const step = {
        tool: 'inspect',
        params: {
          action: 'evaluateExpression',
          expression: JSON.stringify(value),
          saveAs: name,
        },
        comment: `set ${name}`,
      };
      const at = commands.findIndex(c => c.params?.saveAs === name && c.tool === 'inspect');
      if (at >= 0) commands[at] = step;
      // After a leading navigate, so the value is set against the page it names.
      else commands.splice(commands[0]?.tool === 'navigate' ? 1 : 0, 0, step);
      sequence.commands = commands;
      return persist(sequence);
    },

    /**
     * What the sequence is for, and what it should end up doing.
     *
     * Written while recording rather than afterwards: the reason a step is
     * there is known while it is being taken, and a sequence saved without it
     * is a list of clicks nobody can judge.
     */
    describe: async (description: string, expectedOutcome: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const held = sequence as { description?: string; expectedOutcome?: string };
      if (description.trim()) held.description = description.trim();
      else delete held.description;
      if (expectedOutcome.trim()) held.expectedOutcome = expectedOutcome.trim();
      else delete held.expectedOutcome;
      return persist(sequence);
    },

    /** Say why a step is here, against the step itself. */
    commentStep: async (index: number, words: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const command = (sequence.commands ?? [])[index];
      if (!command) return `there is no step ${index + 1}`;
      const held = command as { comment?: string };
      if (words.trim()) held.comment = words.trim();
      else delete held.comment;
      return persist(sequence);
    },

    /**
     * Insert a step that runs another sequence when its guard holds.
     *
     * Replay reads this one: a `conditional` step is executed, where a note
     * against a step is not. The guard and the target are validated by replay
     * itself, so a bad selector type or a missing sequence is reported here
     * rather than failing halfway through a later run.
     */
    addConditional: async (
      index: number, condition: string, thenSequence: string, rejoinAt?: number
    ) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const failure = await replay({
        action: 'addConditional',
        name: sequence.name,
        condition,
        thenSequence,
        insertAfterStep: index + 1,
        ...(rejoinAt !== undefined ? { rejoinAt } : {}),
      });
      if (failure) return failure;
      return persist(sequence);
    },

    removeVariable: async (name: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      const at = commands.findIndex(c => c.params?.saveAs === name && c.tool === 'inspect');
      if (at < 0) return `"${name}" is not set by this sequence`;
      sequence.commands = commands.filter((_, i) => i !== at);
      return persist(sequence);
    },

    removeStep: async (index: number) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      if (index < 0 || index >= commands.length) return `step ${index + 1} is not in "${sequence.name}"`;
      sequence.commands = commands.filter((_, i) => i !== index);
      return persist(sequence);
    },

    moveStep: async (from: number, to: number) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = [...(sequence.commands ?? [])];
      if (from < 0 || from >= commands.length) return `step ${from + 1} is not in "${sequence.name}"`;
      const target = Math.min(Math.max(to, 0), commands.length - 1);
      if (target === from) return undefined;
      const [moved] = commands.splice(from, 1);
      commands.splice(target, 0, moved);
      sequence.commands = commands;
      return persist(sequence);
    },

    attachScreenshot: async (id: string, path: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      for (const command of sequence.commands ?? []) {
        const annotation = (command.annotations ?? []).find(note => note.id === id);
        if (!annotation) continue;
        annotation.screenshots = [...(annotation.screenshots ?? []), path];
        return persist(sequence);
      }
      return 'that note is not in the open sequence';
    },

    findAnnotation: (id: string) => {
      const sequence = openSequence();
      if (!sequence) return undefined;
      const commands = sequence.commands ?? [];
      for (let step = 0; step < commands.length; step++) {
        const annotation = (commands[step].annotations ?? []).find(note => note.id === id);
        if (annotation) return { annotation, step, sequence: sequence.name };
      }
      return undefined;
    },

    issue: async () => {
      const sequence = openSequence();
      if (!sequence) return undefined;
      const byFile = await getIssuesBySequenceFile().catch(() => new Map());
      for (const [file, tracked] of byFile) {
        if (file.split('/').pop()?.replace(/\.json$/, '') === sequence.name || file === sequence.name) {
          return { id: tracked.id, type: tracked.type, title: tracked.title };
        }
      }
      return undefined;
    },

    setBaseUrl: (value: string) => { baseUrl = value; },
    baseUrl: () => baseUrl || undefined,
  };
}

export function createBenchTools(
  puppeteerManager: PuppeteerManager,
  sourceMapHandler: SourceMapHandler,
  commandRecorder: CommandRecorder,
  executeToolCall: (tool: string, args: Record<string, unknown>) => Promise<any>,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  const bench = createTool(
      'Open the bench beside a driven app: hold the page still, read what crossed its boundary and what caused each thing, record and step sequences, and collect element-level comments. Actions: start (open the bench, arm Chrome\'s element picker), tick (advance frozen time by budgetMs to walk into a transient state), stop (release the page), list, status.',
      benchSchema,
      async (args: BenchArgs) => {
        const { action, connectionReason } = args;
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

        let resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved && action === 'start') {
          const launched = await autoLaunchChrome(executeToolCall, connectionReason, 'bench.start');
          if (!launched.success) {
            return createErrorResponse(launched.errorType, {
              reference: connectionReason,
              error: launched.error,
            });
          }
          resolved = await resolveConnectionFromReason(connectionReason);
        }
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Use `launchChrome` first to start a browser.',
          });
        }

        const connection: string = resolved.connection.reference ?? resolved.connection.id;

        if (action === 'status') {
          const state = getBenchSession(connection);
          const response = createSuccessResponse('BENCH_STATUS', {
            connection,
            active: state ? 'open' : 'closed',
            detail: state
              ? `Page ${state.frozen ? 'held' : 'running'}, picker ${state.pickerArmed ? 'armed' : 'idle'}, ${state.totalSteps} callback(s)/${state.tickMs}ms stepped, ${state.picks} pick(s), ${state.annotations} annotation(s). Bench: ${state.benchUrl}`
              : 'The bench is closed here. `bench({ action: "start" })` opens it with the page running.',
          });
          return { ...response, _meta: buildMeta('status', { active: !!state, connection, state }) };
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const browserError = checkBrowserAutomation(
          resolved.cdpManager,
          targetPuppeteerManager,
          `bench.${action}`,
          resolved.connection.port
        );
        if (browserError) return browserError;

        switch (action) {
          case 'start': {
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
              sequences: createSequenceDriver(commandRecorder, executeToolCall),
              // A tab in the same browser, so it can be dragged into Chrome's
              // split view beside the frozen app.
              openBench: async (url: string) => {
                const tab = await openBackgroundPage(page.browser());
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

            const response = createSuccessResponse('BENCH_STARTED', {
              connection,
              benchUrl: state.benchUrl,
              eventStreamPath: getEventStreamPath(sessionName),
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

          case 'freeze':
          case 'unfreeze': {
            const state = await setFrozen(connection, action === 'freeze');
            if (!state) {
              return createErrorResponse('BENCH_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('BENCH_HOLD', {
              connection,
              held: state.frozen ? 'held' : 'running',
              detail: state.frozen
                ? 'The page is held: its JS is stopped, so it cannot be driven until it runs again.'
                : 'The page is running. Drive it to the moment worth holding, then freeze.',
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
