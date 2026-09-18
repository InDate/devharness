/**
 * Annotate tool - freeze the page, click what is wrong, keep working.
 *
 * Mode control only; the freeze, the picker and the annotation store live in
 * `src/annotate-mode.ts`, and the comment box in `src/annotate-control.ts`.
 * Nothing here blocks: `start` returns as soon as the control tab is open, and
 * each saved annotation arrives on the session's event stream instead of on
 * this call's response.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { getIssuesBySequenceFile } from '../issue-tracker.js';
import { autoLaunchChrome } from './replay-executor.js';
import { stopRecording, cancelRecording, eventsToCommands } from '../interaction-recorder.js';
import type { PuppeteerManager } from '../puppeteer-manager.js';
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
import type { ToolResponseMeta, AnnotateToolMeta } from '../tool-response.js';
import {
  startAnnotateMode,
  stopAnnotateMode,
  tickAnnotateMode,
  setFrozen,
  setPicker,
  type SequenceDriver,
  getAnnotateSession,
  pageHeldElsewhere,
  selectSequence,
  gotoSequenceStep,
  keepRecordedStep,
  dropRecordedStep,
  flagRecordedStep,
  type Annotation,
  type SequenceState,
} from '../annotate-mode.js';

const annotateSchema = z.object({
  action: z.enum(['start', 'stop', 'tick', 'freeze', 'unfreeze', 'picker', 'list', 'status', 'keepStep', 'dropStep', 'flagStep'])
    .describe('start (open the control pane with the page running and the picker idle), freeze/unfreeze (hold the page or let it run, without leaving annotate mode - driving the app needs it running), picker (arm or disarm, via armed), tick (run forward by steps or budgetMs), stop (release the page and close), keepStep/dropStep (settle the recorded step capture is held on), list, status'),
  connectionReason: z.string()
    .describe('Connection reference (use the reference from launchChrome output)'),
  steps: z.number().int().positive().max(1000).optional()
    .describe('tick: callbacks to run before freezing again (default 1). The exact unit - one callback is one thing the page does'),
  budgetMs: z.number().int().positive().max(60000).optional()
    .describe('tick: instead of steps, run callbacks until at least this much page time has been spent. Reports where it landed, which is rarely the number asked for'),
  armed: z.boolean().optional()
    .describe('picker: true arms Chrome\'s element picker, false disarms it so clicks reach the app'),
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

type AnnotateArgs = z.infer<typeof annotateSchema>;

const DEFAULT_LIST_LIMIT = 20;

function buildMeta(action: AnnotateArgs['action'], extra: Partial<AnnotateToolMeta>): ToolResponseMeta {
  return {
    tool: 'annotate',
    action,
    timestamp: Date.now(),
    annotate: { action, ...extra },
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
      const where = a.target.source?.fileName
        ? `${a.target.source.fileName}:${a.target.source.lineNumber ?? ''}`
        : a.target.component ?? a.target.selector;
      return `- [${a.id}] ${sequence} step ${step + 1} (${stepLabel})\n  t+${a.tick}ms  ${where}\n  ${a.target.selector}\n  "${a.comment}"`;
    })
    .join('\n');
}

/** Returned by record() when the person abandoned it; not a failure. */
export const CANCELLED = '\u0000cancelled';

/**
 * Stands in for the control pane's own address inside a recorded sequence.
 *
 * The pane is served from an ephemeral port under a per-session token, so a
 * sequence recorded against it holds an address that resolves once and 404s
 * every session after. Recording the pane is how the tool gets driven with the
 * tool, and without this it is a one-shot.
 */
const PANE_TOKEN = '{{pane}}';

/** The live pane for this connection, with no trailing slash. */
function livePaneUrl(connection: string): string | undefined {
  const url = getAnnotateSession(connection)?.controlUrl;
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
 * Annotate drives replay through its own tool rather than re-implementing the
 * executor: `run` with stepTo opens the step-through session replay already
 * has, and step/finish/cancel move it. Reading the session comes off the same
 * recorder the tool uses, so there is one source of truth for where it is up to.
 */
function createSequenceDriver(
  commandRecorder: CommandRecorder,
  executeToolCall: (tool: string, args: Record<string, unknown>) => Promise<any>
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
  const replay = async (args: Record<string, unknown>): Promise<string | undefined> => {
    let text: string;
    try {
      text = textOf(await executeToolCall('replay', args));
    } catch (error) {
      // executeToolCall raises an isError response as a ToolError carrying it.
      text = textOf(error);
    }

    if (!/^\s*(Error|\*\*BLOCKED)/.test(text) && !/\*\*Error:\*\*/.test(text)) return undefined;

    debugLog('annotate', `replay ${args.action} failed: ${text.slice(0, 1200).replace(/\n/g, ' ')}`);
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
   * Take the annotated tab to where the sequence starts.
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
      debugLog('annotate', `"${name}" starts at the control pane and no pane is open on ${connection}`);
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
      debugLog('annotate', `could not open the sequence's start url ${url}: ${error}`);
    }
  };

  /**
   * Point every reference the sequence recorded at the tab being annotated.
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
      debugLog('annotate', `sequence ${name} uses ${references.size} connections; left unbound`);
      return undefined;
    }
    return Object.fromEntries([...references].map(reference => [reference, connection]));
  };

  const openSequence = () => {
    const state = commandRecorder.getActiveSequence();
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

    active: () => {
      const state = commandRecorder.getActiveSequence();
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

    start: async (name: string, connection: string) => {
      selected = name;
      selectedConnection = connection;
      reached = 0;
      ended = null;
      failedStep = null;
      variableStore = {};
      const failure = await replay({ action: 'load', filename: `${name}.json` });
      if (!failure) await goToStart(name, connection);
      return failure;
    },

    step: async () => {
      if (commandRecorder.getActiveSequence()) {
        const before = commandRecorder.getActiveSequence()!.currentStep;
        const failure = await replay({ action: 'step', stepCount: 1 });
        const after = commandRecorder.getActiveSequence();
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
        });
      }
      return undefined;
    },

    finish: async () => {
      if (commandRecorder.getActiveSequence()) {
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
        const after = commandRecorder.getActiveSequence();
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
      const name = commandRecorder.getActiveSequence()?.sequenceName ?? selected;
      if (!name) return undefined;
      // A fresh run is the only way back: replay steps forward, never back.
      if (commandRecorder.getActiveSequence()) await replay({ action: 'cancel' });
      selected = name;
      return replay({
        action: 'run', name, stepTo: step + 1, wait: true, connectionReason: selectedConnection,
        ...(rebindOnto(name, selectedConnection) ? { connections: rebindOnto(name, selectedConnection) } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
    },

    cancel: async () => {
      if (commandRecorder.getActiveSequence()) await replay({ action: 'cancel' });
      selected = null;
      reached = 0;
      ended = null;
      variableStore = {};
    },

    remove: async (name: string) => {
      if (selected === name || commandRecorder.getActiveSequence()?.sequenceName === name) {
        if (commandRecorder.getActiveSequence()) await replay({ action: 'cancel' });
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

    trafficIn: async (connection: string, from: number, to: number) => {
      const empty = { requests: 0, failed: 0, frames: 0, lines: [] as string[] };
      const http = await executeToolCall('network', {
        action: 'list', connectionReason: connection, since: from, until: to, limit: 50,
      }).catch(() => null);
      const rows = http?._meta?.network?.requests ?? [];
      const sockets = await executeToolCall('network', {
        action: 'sockets', connectionReason: connection, since: from, until: to,
      }).catch(() => null);
      const frames = (sockets?._meta?.socketList ?? []).reduce(
        (total: number, s: any) => total + (s.frames?.received ?? 0) + (s.frames?.sent ?? 0), 0);
      if (rows.length === 0 && frames === 0) return empty;
      return {
        requests: rows.length,
        failed: rows.filter((r: any) => r.failed || (r.status ?? 0) >= 400).length,
        frames,
        lines: rows.slice(0, 8).map((r: any) => {
          const path = (() => { try { return new URL(r.url).pathname; } catch { return r.url; } })();
          return `${r.method} ${path} ${r.failed ? 'failed' : (r.status ?? 'pending')}`;
        }),
      };
    },

    recordedSoFar: (eventsJson: string, startUrl: string) => {
      let events: any[] = [];
      try { events = JSON.parse(eventsJson); } catch { events = []; }
      const times: number[] = [];
      const converted = eventsToCommands(events, {
        simplify: true, includeHovers: false, timestampsOut: times,
      });
      const lead = startUrl ? [navigateFirst(startUrl)] : [];
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

export function createAnnotateTools(
  puppeteerManager: PuppeteerManager,
  sourceMapHandler: SourceMapHandler,
  commandRecorder: CommandRecorder,
  executeToolCall: (tool: string, args: Record<string, unknown>) => Promise<any>,
  resolveConnectionFromReason: (connectionReason: string) => Promise<any>
) {
  return {
    annotate: createTool(
      'Freeze the page and collect element-level comments from the person driving it. Actions: start (freeze both clocks, arm Chrome\'s element picker, open a control tab holding the comment box - saved annotations land on the session event stream), tick (advance frozen time by budgetMs to walk into a transient state), stop (unfreeze), list, status.',
      annotateSchema,
      async (args: AnnotateArgs) => {
        const { action, connectionReason } = args;
        const sessionName = resolveSessionName(getSessionInfo()?.shortId);

        if (action === 'list') {
          const all = await readSequenceAnnotations(commandRecorder);
          const limit = args.limit ?? DEFAULT_LIST_LIMIT;
          const recent = all.slice(-limit);
          const response = createSuccessResponse('ANNOTATE_LIST', {
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

            let resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved && action === 'start') {
          const launched = await autoLaunchChrome(executeToolCall, connectionReason, 'annotate.start');
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
          const state = getAnnotateSession(connection);
          const response = createSuccessResponse('ANNOTATE_STATUS', {
            connection,
            active: state ? 'on' : 'off',
            detail: state
              ? `Page ${state.frozen ? 'held' : 'running'}, picker ${state.pickerArmed ? 'armed' : 'idle'}, ${state.totalSteps} callback(s)/${state.tickMs}ms stepped, ${state.picks} pick(s), ${state.annotations} annotation(s). Control pane: ${state.controlUrl}`
              : 'Not annotating. `annotate({ action: "start" })` freezes the page and opens the control pane.',
          });
          return { ...response, _meta: buildMeta('status', { active: !!state, connection, state }) };
        }

        const targetPuppeteerManager = resolved.puppeteerManager || puppeteerManager;
        const browserError = checkBrowserAutomation(
          resolved.cdpManager,
          targetPuppeteerManager,
          `annotate.${action}`,
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
                page = await page.browser().newPage();
                await page.bringToFront();
              } catch (error) {
                return createErrorResponse('ANNOTATE_TAB_FAILED', { message: String(error) });
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

            const state = await startAnnotateMode({
              page,
              connection,
              sessionName,
              sourceMapHandler,
              sequences: createSequenceDriver(commandRecorder, executeToolCall),
              // A tab in the same browser, so it can be dragged into Chrome's
              // split view beside the frozen app.
              openControlTab: async (url: string) => {
                const tab = await page.browser().newPage();
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

            const response = createSuccessResponse('ANNOTATE_STARTED', {
              connection,
              controlUrl: state.controlUrl,
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
            const response = createSuccessResponse('ANNOTATE_STEP_SETTLED', {
              connection,
              verdict: action === 'keepStep' ? 'kept' : action === 'dropStep' ? 'dropped' : 'flagged for the person',
              steps: state?.steps?.length ?? 0,
            });
            return { ...response, _meta: buildMeta(action, { connection, sequence: state }) };
          }

          case 'tick': {
            const tick = await tickAnnotateMode(connection, {
              ...(args.steps !== undefined ? { steps: args.steps } : {}),
              ...(args.budgetMs !== undefined ? { budgetMs: args.budgetMs } : {}),
            });
            if (!tick) {
              return createErrorResponse('ANNOTATE_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('ANNOTATE_TICKED', {
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
              _meta: buildMeta('tick', { active: true, connection, state: getAnnotateSession(connection), tick }),
            };
          }

          case 'freeze':
          case 'unfreeze': {
            const state = await setFrozen(connection, action === 'freeze');
            if (!state) {
              return createErrorResponse('ANNOTATE_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('ANNOTATE_HOLD', {
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
            const state = getAnnotateSession(connection);
            if (!state) {
              return createErrorResponse('ANNOTATE_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('ANNOTATE_PICKER', {
              connection,
              pickerState: state.pickerArmed ? 'armed' : 'idle',
              detail: state.pickerArmed
                ? 'Every click in the app tab is now a pick.'
                : 'Clicks reach the app again. It has to be running for them to do anything.',
            });
            return { ...response, _meta: buildMeta('picker', { active: true, connection, state }) };
          }

          case 'stop': {
            const state = await stopAnnotateMode(connection);
            if (!state) {
              return createErrorResponse('ANNOTATE_NOT_ACTIVE', { connection, action });
            }
            const response = createSuccessResponse('ANNOTATE_STOPPED', {
              connection,
              picks: state.picks,
              annotations: state.annotations,
              tickMs: state.tickMs,
            });
            return { ...response, _meta: buildMeta('stop', { active: false, connection, state }) };
          }
        }
      }
    ),
  };
}
