/**
 * The replay side of the bench: `createSequenceDriver` drives replay through
 * its own tool, and the step labels the bench and the `bench` tool both show.
 */

import { assertAsCheck, formOf, subjectOf as subjectOfCheck } from '../tools/check-engine.js';
import { checkSpecOf } from '../tools/check-tools.js';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getIssuesBySequenceFile } from '../issue-tracker.js';
import { getProxy } from '../proxy/registry.js';
import { createdName, isLaunchStep } from '../tools/connection-steps.js';
import { stopRecording, cancelRecording, eventsToCommands } from '../interaction-recorder.js';
import { translateSequence } from '../tools/legacy-steps.js';
import type { CommandRecorder } from '../command-recorder.js';
import { debugLog } from '../debug-logger.js';
import { resolveSessionName } from '../session-identity.js';
import { getSessionInfo } from '../tools/dashboard-tools.js';
import { appendEvent, currentOrigin, runAs } from '../session-events.js';
import { announceSequenceSaved } from '../sequence-events.js';
import { activityPathFor, readActivity, readSiteActivity, renumberSteps, siteActivityPath, stepMap, writeSiteActivity } from '../sequence-activity.js';
import type { ActivityMove, ExpectedValue, KindCount } from '../bench/kinds.js';
import type { SequenceDriver } from './driver.js';
import { getBenchSession } from './session.js';
import type { Annotation, AnnotationTarget } from '../annotation.js';
import { NO_TOOL_VALUES, type BoundaryRule, type HiddenKind, type RuleCatalogueEntry, type SequenceNote, type ServerLog, type ServerRow, type ToolGroup, type ToolValues } from '../bench/wire.js';
import { unlisted } from '../call-origin.js';
import { CANCELLED } from './session.js';

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
function navigateFirst(url: string): { tool: string; params: Record<string, any>; comment?: string } {
  return { tool: 'navigate', params: { action: 'goto', url } };
}

/** `http://localhost:7788/a?b` → `http://localhost:7788`; nothing for a url that names no web origin. */
function originOf(url: string | undefined): string | undefined {
  try {
    const origin = url ? new URL(url).origin : 'null';
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * The value a step stores, where it stores a fixed one: an expression that is
 * a JSON string literal, saved under a name. A step that captures from the
 * page has an expression that is code, and stores nothing known beforehand.
 */
function storedValue(command: { tool: string; params?: Record<string, any> }): string | undefined {
  if (command.tool !== 'inspect' || typeof command.params?.saveAs !== 'string') return undefined;
  try {
    const value = JSON.parse(String(command.params.expression ?? ''));
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The variables a step reads, by the `{{var:name}}` tokens anywhere in what it is given. */
function readsOf(command: { params?: Record<string, any> }): string[] {
  const found = JSON.stringify(command.params ?? {}).matchAll(/\{\{var:([A-Za-z_][A-Za-z0-9_]*)/g);
  return [...new Set([...found].map(match => match[1]))];
}

/** Where the sequence files that hold the notes live. */
export function getSequencesRoot(commandRecorder: CommandRecorder): string {
  return (commandRecorder as any).getSequencesDir?.(false) ?? '.devharness/sequences';
}

/** The part of a command worth showing beside its name. */
function subjectOf(params: Record<string, any>): string {
  const subject = params?.selector ?? params?.url ?? params?.text ?? params?.key ?? params?.expression ?? '';
  return String(subject ?? '');
}

/** One line per recorded command, enough to recognise it in a list. */
export function labelFor(command: { tool: string; params: Record<string, any> }): string {
  const { tool, params } = command;
  // A check reads as what it checks, the same words its row and the run's
  // report use.
  // A check that reads nothing is a timer, and reads as the wait it is.
  if (tool === 'check' && formOf(checkSpecOf(params ?? {})) === 'time') return `wait for ${params?.afterMs ?? 0}ms`;
  if (tool === 'check') return `check ${subjectOfCheck(checkSpecOf(params ?? {})).replace(/"(\{\{var:[^}]+\}\})"/g, '$1')}`;
  // An assert's selector alone leaves out what it compares, and a timed wait
  // has no subject at all; both read in the check's words instead, which is
  // what the step's marker needs once its row carries only the answer.
  // A value that is a lone variable is shown with the variable's own value,
  // which carries its quotes when it is a string, so the token is not quoted again.
  if (tool === 'assert') return `assert ${subjectOfCheck(assertAsCheck(params ?? {})).replace(/"(\{\{var:[^}]+\}\})"/g, '$1')}`;
  if (tool === 'wait' && params?.ms !== undefined) return `wait for ${params.ms}ms`;
  if (tool === 'wait' && params?.selectorGone !== undefined) return `wait ${params.selectorGone} absent`;
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
  ) => Promise<any>,
  catalogue: () => ToolGroup[],
  values: () => Promise<ToolValues> = async () => NO_TOOL_VALUES,
  servers: () => Promise<ServerRow[]> = async () => [],
  serverLog: (id: string, stream: 'stdout' | 'stderr') => Promise<ServerLog> = async () => ({ unavailable: 'no server manager' }),
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
    const opensSomewhere = isLaunchStep(first)
      || (first.tool === 'navigate' && first.params?.action === 'goto');
    const url = first.params?.url;
    return opensSomewhere && typeof url === 'string' ? url : undefined;
  };

  /**
   * Take the driven tab to where the sequence starts.
   *
   * Rebinding points every step at this tab, and that turns a launch
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
      const recorded = command.params?.connectionReason ?? createdName(command);
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

  /** Writes the sequence back to the file it came from, announcing `change` as what was written. */
  // Clicks on ↑ and ↓ land one step at a time, and each announced alone puts a
  // line on the event stream per click. Moves of the same step are held until
  // the clicks stop and announced once, as where it started and where it ended.
  const MOVE_QUIET_MS = 2000;
  let pendingMove: {
    sequence: { name: string; commands?: unknown[] }; command: unknown; from: number;
    /** How many steps moved together, the command being the first of them. */
    count: number;
    filepath: string; timer: ReturnType<typeof setTimeout>; by?: 'agent' | 'person';
  } | undefined;
  const flushMove = async (): Promise<void> => {
    if (!pendingMove) return;
    const { sequence, command, from, count, filepath, timer, by } = pendingMove;
    clearTimeout(timer);
    pendingMove = undefined;
    const to = (sequence.commands ?? []).indexOf(command);
    if (to < 0 || to === from) return;
    const said = count > 1
      ? `steps ${from + 1}–${from + count} moved to steps ${to + 1}–${to + count}`
      : `step ${from + 1} moved to step ${to + 1}`;
    const announce = () => announceSequenceSaved(sequence as any, filepath, said);
    // Announced from a timer, outside the request that moved it, so the
    // origin taken at the move is set again for the event.
    await (by ? runAs(by, announce) : announce());
  };

  const persist = async (sequence: { id: string; name: string }, change?: string): Promise<string | undefined> => {
    const saved = await commandRecorder.saveSequenceToDisk(sequence.id, false, true);
    if (!saved) return `"${sequence.name}" is no longer loaded`;
    if (!saved.success) return saved.error;
    await flushMove();
    await announceSequenceSaved(sequence as any, saved.filepath, change);
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
        name: string; steps: number; notes: number; description?: string; expectedOutcome?: string; tags?: string[];
      }>();
      for (const entry of saved) {
        const name = String(entry.name ?? entry.filename).replace(/\.json$/, '');
        cards.set(name, {
          name,
          steps: entry.commandCount,
          notes: entry.noteCount,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.expectedOutcome ? { expectedOutcome: entry.expectedOutcome } : {}),
          ...(entry.tags?.length ? { tags: entry.tags } : {}),
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

    history: () => commandRecorder.getHistory(Number.MAX_SAFE_INTEGER).map(command => {
      const text = textOf(command.result);
      const connection = command.params?.connectionReason ?? createdName(command);
      return {
        index: command.index,
        at: command.timestamp,
        tool: command.tool,
        // The row shows the tool beside this, so a label that opens with the
        // tool's name drops it; a timed check reads "wait for 2000ms" and is kept whole.
        label: (() => {
          const label = labelFor(command);
          return label.startsWith(command.tool) ? label.slice(command.tool.length).replace(/^[. ]/, '') : label;
        })(),
        ...(typeof connection === 'string' ? { connection } : {}),
        from: command.from,
        ...(command.run !== undefined ? { run: command.run } : {}),
        ...(command.result !== undefined ? { failed: command.result?.isError === true } : {}),
        ...(text ? { said: text.split('\n').find(line => line.trim())?.slice(0, 160) } : {}),
      };
    }),

    historyDetail: (index: number) => {
      const command = commandRecorder.getCommand(index);
      if (!command) return undefined;
      return {
        params: command.params,
        ...(command.result !== undefined ? { result: textOf(command.result) } : {}),
      };
    },

    tools: catalogue,

    notes: async () => {
      const files = [
        ...await commandRecorder.listSavedSequencesOnDisk().catch(() => []),
        ...await commandRecorder.listIssueSequencesOnDisk().catch(() => []),
      ];
      const notes: SequenceNote[] = [];
      for (const file of files) {
        const sequence = await fs.readFile(file.fullPath, 'utf-8').then(JSON.parse).catch(() => null);
        (sequence?.commands ?? []).forEach((command: { tool: string; params: Record<string, any>; annotations?: Annotation[] }, step: number) => {
          for (const note of command.annotations ?? []) {
            const source = note.target?.source;
            notes.push({
              sequence: sequence.name ?? file.name,
              file: file.filename,
              step: step + 1,
              stepLabel: labelFor(command),
              comment: note.comment,
              at: note.at,
              url: note.url,
              ...(note.target?.selector && { selector: note.target.selector }),
              ...(note.target?.component && { component: note.target.component }),
              ...(source?.fileName && { source: `${source.fileName}${source.lineNumber ? `:${source.lineNumber}` : ''}` }),
              ...(note.screenshots?.length && { screenshots: note.screenshots }),
            });
          }
        });
      }
      return notes.sort((a, b) => b.at.localeCompare(a.at));
    },

    toolValues: values,

    servers,

    serverLog,

    callTool: async (tool: string, args: Record<string, unknown>) => {
      try {
        const response = await executeToolCall(tool, args);
        return { failed: false, result: textOf(response), ...(response?._meta && { meta: response._meta }) };
      } catch (error) {
        return { failed: true, result: textOf(error) };
      }
    },

    outlineOf: async (name: string) => {
      let sequence: any = loadedByName(name);
      if (!sequence) {
        const onDisk = (await commandRecorder.listSavedSequencesOnDisk().catch(() => [] as any[]))
          .find((entry: any) => entry.name === name || entry.filename === `${name}.json`);
        if (!onDisk) return undefined;
        sequence = translateSequence(JSON.parse(await fs.readFile(onDisk.fullPath, 'utf-8')));
      }
      const commands: Array<{ tool: string; params: Record<string, any>; annotations?: unknown[] }> = sequence.commands ?? [];
      return {
        ...(sequence.startUrl ? { startUrl: String(sequence.startUrl) } : {}),
        steps: commands.map(command => ({
          label: labelFor(command), tool: command.tool, notes: command.annotations?.length ?? 0,
          ...(['check', 'assert', 'wait'].includes(command.tool) ? { params: command.params } : {}),
        })),
        teardown: (sequence.teardown ?? []).map(labelFor),
      };
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
            ...(storedValue(command) !== undefined ? { stores: storedValue(command) } : {}),
            ...(readsOf(command).length ? { reads: readsOf(command) } : {}),
            tool: command.tool,
            params: command.params ?? {},
            ...(command.annotations?.length ? { annotations: command.annotations } : {}),
            ...(command.traffic ? { traffic: command.traffic } : {}),
            ...(command.expected ? { expected: command.expected } : {}),
            ...(command.addedAt !== undefined ? { addedAt: command.addedAt } : {}),
          };
        }),
        ...(sequence.boundaryPlacements ? { placements: sequence.boundaryPlacements } : {}),
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
      return persist(sequence, `note added to step ${step + 1}`);
    },

    moveAnnotation: async (id: string, step: number, after?: string) => {
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
      if (after === undefined) delete moving.after;
      else moving.after = after;
      target.annotations = [...(target.annotations ?? []), moving];
      return persist(sequence, `note moved to step ${step + 1}`);
    },

    rewordAnnotation: async (id: string, words: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const held = (sequence.commands ?? []).flatMap(command => command.annotations ?? []).find(note => note.id === id);
      if (!held) return 'that note is not in the open sequence';
      held.comment = words;
      return persist(sequence, 'note reworded');
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
      return persist(sequence, 'note removed');
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

    labelsOf: (name: string) => (loadedByName(name)?.commands ?? []).map(command => labelFor(command)),

    spliceRecording: async (recordedName: string, into: string, after: number) => {
      const recorded = loadedByName(recordedName);
      const target = loadedByName(into) ?? await commandRecorder.loadSequenceFromDisk(into);
      if (!recorded || !target) return `"${recorded ? into : recordedName}" is not loaded`;
      // The recording ran on the page the run stood on, so its steps follow
      // on from that step with nothing of their own to open.
      const addedAt = Date.now();
      const steps = (recorded.commands ?? [])
        .filter((command, index) => !(index === 0 && command.tool === 'navigate'))
        .map(command => ({ ...command, addedAt }));
      const commands = [...(target.commands ?? [])];
      const at = Math.min(Math.max(after + 1, 0), commands.length);
      renumberSteps(target, (old) => (old >= at ? old + steps.length : old));
      target.commands = [...commands.slice(0, at), ...steps, ...commands.slice(at)] as any;
      // The recording was only ever a carrier: its file and its activity go.
      const saved = await commandRecorder.saveSequenceToDisk(recorded.id, false, true);
      if (saved?.success) {
        await commandRecorder.deleteSequenceFromDisk(saved.filepath);
        await fs.unlink(activityPathFor(saved.filepath)).catch(() => {});
      }
      commandRecorder.deleteSequence(recorded.id);
      selected = target.name;
      return persist(target, `${steps.length} recorded step${steps.length === 1 ? '' : 's'} put in after step ${after + 1}`);
    },

    cancelRecording: async (connection: string) => {
      await cancelRecording(connection);
    },

    saveBoundaryRules: async (
      rules: Array<Record<string, unknown>>,
      refuseWrites: boolean,
      names: Record<string, string> = {},
      change?: string,
      off: string[] = [],
      on: Array<{ key: string; steps?: number[] }> = [],
      hidden: { on: string[]; off: string[] } = { on: [], off: [] },
    ) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const held = sequence as {
        boundaryRules?: Array<Record<string, unknown>>;
        boundaryRefuse?: 'writes';
        boundaryNames?: Record<string, string>;
        boundaryRulesOff?: string[];
        boundaryRulesOn?: Array<{ key: string; steps?: number[] }>;
        boundaryHiddenOn?: string[];
        boundaryHiddenOff?: string[];
      };
      if (rules.length) held.boundaryRules = rules; else delete held.boundaryRules;
      if (refuseWrites) held.boundaryRefuse = 'writes'; else delete held.boundaryRefuse;
      if (Object.keys(names).length) held.boundaryNames = names; else delete held.boundaryNames;
      if (off.length) held.boundaryRulesOff = off; else delete held.boundaryRulesOff;
      if (on.length) held.boundaryRulesOn = on; else delete held.boundaryRulesOn;
      if (hidden.on.length) held.boundaryHiddenOn = hidden.on; else delete held.boundaryHiddenOn;
      if (hidden.off.length) held.boundaryHiddenOff = hidden.off; else delete held.boundaryHiddenOff;
      return persist(sequence, change ?? 'rules updated');
    },

    siteOf: () => originOf(baseUrl) ?? originOf(openSequence()?.startUrl),

    catalogueRules: async () => {
      const activityDir = join(dirname(getSequencesRoot(commandRecorder)), 'activity');
      const entries: RuleCatalogueEntry[] = [];
      const siteDir = join(activityDir, '_site');
      for (const file of await fs.readdir(siteDir).catch(() => [] as string[])) {
        if (!file.endsWith('.json')) continue;
        const held = await readSiteActivity(join(siteDir, file));
        if (held?.site && (held.responses?.length || held.hidden?.length)) {
          entries.push({
            site: held.site, rules: (held.responses ?? []) as BoundaryRule[],
            ...(held.hidden?.length ? { hidden: held.hidden as HiddenKind[] } : {}),
          });
        }
      }
      for (const saved of await commandRecorder.listSavedSequencesOnDisk().catch(() => [])) {
        // Every sequence, whether or not it names a response: an opt-out
        // response is used by each one on its site that does not opt out.
        const activity = await readActivity(saved.fullPath);
        const site = originOf(saved.startUrl);
        entries.push({
          ...(site ? { site } : {}),
          sequence: String(saved.name ?? saved.filename).replace(/\.json$/, ''),
          rules: (activity?.responses ?? []) as BoundaryRule[],
          ...(activity?.responsesOff?.length ? { off: activity.responsesOff } : {}),
          ...(activity?.responsesOn?.length ? { on: activity.responsesOn } : {}),
          ...(activity?.hiddenOn?.length ? { hiddenOn: activity.hiddenOn } : {}),
          ...(activity?.hiddenOff?.length ? { hiddenOff: activity.hiddenOff } : {}),
        });
      }
      return entries;
    },

    openSiteHidden: async (origin: string) =>
      ((await readSiteActivity(siteActivityPath(join(dirname(getSequencesRoot(commandRecorder)), 'activity'), origin)))?.hidden ?? []) as Array<Record<string, unknown>>,

    openSiteRules: async (origin: string) =>
      ((await readSiteActivity(siteActivityPath(join(dirname(getSequencesRoot(commandRecorder)), 'activity'), origin)))?.responses ?? []) as Array<Record<string, unknown>>,

    saveSiteRules: async (origin: string, rules: Array<Record<string, unknown>>, change?: string, hidden: Array<Record<string, unknown>> = []) => {
      const path = siteActivityPath(join(dirname(getSequencesRoot(commandRecorder)), 'activity'), origin);
      try {
        await writeSiteActivity(path, origin, rules, hidden);
      } catch (error) {
        return String(error);
      }
      await appendEvent(resolveSessionName(getSessionInfo()?.shortId), 'sequence', {
        site: origin, path, responses: rules.length,
        ...(change ? { change } : {}),
        detail: `site ${origin}: ${change ?? 'responses updated'}`,
      }).catch(() => {});
      return undefined;
    },

    openBoundaryRules: () => {
      const sequence = openSequence();
      if (!sequence) return { rules: [], refuseWrites: false, names: {}, off: [], on: [], hiddenOn: [], hiddenOff: [] };
      const held = sequence as {
        boundaryRules?: Array<Record<string, unknown>>;
        boundaryRefuse?: 'writes';
        boundaryNames?: Record<string, string>;
        boundaryRulesOff?: string[];
        boundaryRulesOn?: Array<{ key: string; steps?: number[] }>;
        boundaryHiddenOn?: string[];
        boundaryHiddenOff?: string[];
      };
      return {
        rules: held.boundaryRules ?? [],
        refuseWrites: held.boundaryRefuse === 'writes',
        names: held.boundaryNames ?? {},
        off: held.boundaryRulesOff ?? [],
        on: held.boundaryRulesOn ?? [],
        hiddenOn: held.boundaryHiddenOn ?? [],
        hiddenOff: held.boundaryHiddenOff ?? [],
      };
    },

    saveExpected: async (index: number, kind: string, expected: ExpectedValue | undefined) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const command = sequence.commands?.[index];
      if (!command) return `no step ${index + 1}`;
      const held = { ...command.expected };
      if (expected) held[kind] = expected; else delete held[kind];
      if (Object.keys(held).length) command.expected = held; else delete command.expected;
      return persist(sequence, expected?.fields
        ? `${kind} on step ${index + 1} compared on ${Object.keys(expected.fields).map(path => `.${path}`).join(', ')}`
        : `${kind} on step ${index + 1} compared in full`);
    },

    saveMove: async (move: ActivityMove) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      // One past the last step is the gutter, which the recording holds nothing for.
      const gutter = commands.length;
      const { kind, at, to } = move;
      const where = (index: number) => index === gutter ? 'after the last step' : `step ${index + 1}`;
      if (to < 0 || to > gutter || at < 0 || at > gutter) return `no step ${to + 1}`;
      const kindsOf = (index: number) => {
        const command = commands[index];
        command.traffic ??= { requests: 0, failed: 0, opened: 0, writes: 0, lines: [] };
        return (command.traffic.kinds ??= {});
      };

      let moving = move.recorded;
      let mark: ExpectedValue | undefined;
      if (at < gutter) {
        moving = kindsOf(at)[kind] ?? moving;
        delete kindsOf(at)[kind];
        mark = commands[at].expected?.[kind];
        if (mark) {
          delete commands[at].expected![kind];
          if (!Object.keys(commands[at].expected!).length) delete commands[at].expected;
        }
      }
      if (to < gutter && moving) {
        // Onto a step that records the same kind, the two are one kind crossing
        // more often; the payload it already holds stays the one compared.
        // A pushed kind is compared by presence, so its count stays the one
        // already recorded rather than growing with each move.
        const standing = kindsOf(to)[kind];
        const statuses = [...new Set([...(standing?.statuses ?? []), ...(moving.statuses ?? [])])];
        kindsOf(to)[kind] = standing ? {
          n: standing.presence || moving.presence ? standing.n : standing.n + moving.n,
          ...(statuses.length ? { statuses } : {}),
          ...(standing.presence || moving.presence ? { presence: true as const } : {}),
          ...(standing.body ?? moving.body ? { body: standing.body ?? moving.body } : {}),
        } : moving;
        if (mark && !commands[to].expected?.[kind]) commands[to].expected = { ...commands[to].expected, [kind]: mark };
      }

      if (move.origin !== undefined) {
        const key = `${move.origin}|${kind}`;
        const home = move.origin === 'after' ? gutter : Number(move.origin);
        const placements = { ...sequence.boundaryPlacements };
        if (to === home) delete placements[key]; else placements[key] = to;
        if (Object.keys(placements).length) sequence.boundaryPlacements = placements;
        else delete sequence.boundaryPlacements;
      }
      return persist(sequence, `${kind} moved from ${where(at)} to ${where(to)}`);
    },

    saveRecorded: async (index: number, kind: string, recorded: KindCount | undefined) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const command = sequence.commands?.[index];
      if (!command) return `no step ${index + 1}`;
      const traffic = command.traffic ?? { requests: 0, failed: 0, opened: 0, writes: 0, lines: [] };
      const kinds = { ...traffic.kinds };
      if (recorded) kinds[kind] = recorded; else delete kinds[kind];
      command.traffic = { ...traffic, kinds };
      return persist(sequence, recorded
        ? `${kind} on step ${index + 1} saved as recorded`
        : `${kind} taken out of step ${index + 1}'s recording`);
    },

    saveStepTraffic: async (entries: Array<{ index: number; traffic: any }>) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      for (const { index, traffic } of entries) {
        if (index < 0 || index >= commands.length) continue;
        commands[index].traffic = traffic;
        // A baseline takes the step in, so it no longer reads as new.
        delete commands[index].addedAt;
      }
      return persist(sequence, `traffic recorded for ${entries.length} step${entries.length === 1 ? '' : 's'}`);
    },

    trafficIn: (connection: string, from: number, to: number) => unlisted(async () => {
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
    }),

    recordedSoFar: (eventsJson: string, startUrl: string, edits?: Map<number, Record<string, unknown>>) => {
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
      // A step changed in the bench reads as changed: its label, and the
      // variables it reads, come from what it is given now.
      const commands = [...lead, ...converted].map((command, index) =>
        (edits?.has(index) ? { ...command, params: edits.get(index)! } : command));
      // The synthesised opening navigate has no source event, so it takes the
      // clock of whatever followed it.
      const at = [...lead.map(() => times[0]), ...times];
      return commands.map((command, index) => ({
        index,
        label: labelFor(command),
        ...(command.comment ? { comment: command.comment } : {}),
        ...(typeof command.params?.saveAs === 'string' ? { captures: command.params.saveAs } : {}),
        ...(storedValue(command) !== undefined ? { stores: storedValue(command) } : {}),
        ...(readsOf(command).length ? { reads: readsOf(command) } : {}),
        tool: command.tool,
        params: command.params ?? {},
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
      if (at < 0) renumberSteps(sequence, stepMap(sequence.commands ?? [], commands));
      sequence.commands = commands;
      return persist(sequence, `variable ${name} set`);
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
      return persist(sequence, 'description changed');
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
      return persist(sequence, `reason for step ${index + 1} changed`);
    },

    removeVariable: async (name: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      const at = commands.findIndex(c => c.params?.saveAs === name && c.tool === 'inspect');
      if (at < 0) return `"${name}" is not set by this sequence`;
      const kept = commands.filter((_, i) => i !== at);
      renumberSteps(sequence, stepMap(commands, kept));
      sequence.commands = kept;
      return persist(sequence, `variable ${name} removed`);
    },

    editStep: async (index: number, params: Record<string, unknown>) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = [...(sequence.commands ?? [])];
      if (index < 0 || index >= commands.length) return `step ${index + 1} is not in "${sequence.name}"`;
      commands[index] = { ...commands[index], params } as any;
      sequence.commands = commands;
      return persist(sequence, `step ${index + 1} edited`);
    },

    insertTimer: async (after: number, ms: number) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = [...(sequence.commands ?? [])];
      if (after < 0 || after >= commands.length) return `step ${after + 1} is not in "${sequence.name}"`;
      commands.splice(after + 1, 0, { tool: 'check', params: { afterMs: ms } } as any);
      renumberSteps(sequence, stepMap(sequence.commands ?? [], commands));
      sequence.commands = commands;
      return persist(sequence, `a ${ms / 1000}s pause after step ${after + 1}`);
    },

    insertCheck: async (after: number, params: Record<string, unknown>, comment?: string) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = [...(sequence.commands ?? [])];
      if (after < 0 || after >= commands.length) return `step ${after + 1} is not in "${sequence.name}"`;
      commands.splice(after + 1, 0, { tool: 'check', params, addedAt: Date.now(), ...(comment ? { comment } : {}) } as any);
      renumberSteps(sequence, stepMap(sequence.commands ?? [], commands));
      sequence.commands = commands;
      return persist(sequence, `a check after step ${after + 1}`);
    },

    removeStep: async (index: number) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = sequence.commands ?? [];
      if (index < 0 || index >= commands.length) return `step ${index + 1} is not in "${sequence.name}"`;
      const kept = commands.filter((_, i) => i !== index);
      renumberSteps(sequence, stepMap(commands, kept));
      sequence.commands = kept;
      return persist(sequence, `step ${index + 1} removed`);
    },

    moveStep: async (from: number, to: number, count = 1) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      const commands = [...(sequence.commands ?? [])];
      if (from < 0 || from + count > commands.length) {
        return `steps ${from + 1}–${from + count} are not all in "${sequence.name}"`;
      }
      const target = Math.min(Math.max(to, 0), commands.length - count);
      if (target === from) return undefined;
      const run = commands.splice(from, count);
      const [moved] = run;
      commands.splice(target, 0, ...run);
      renumberSteps(sequence, stepMap(sequence.commands ?? [], commands));
      sequence.commands = commands;
      const saved = await commandRecorder.saveSequenceToDisk(sequence.id, false, true);
      if (!saved) return `"${sequence.name}" is no longer loaded`;
      if (!saved.success) return saved.error;
      if (pendingMove && (pendingMove.command !== moved || pendingMove.count !== count || pendingMove.sequence !== sequence)) {
        await flushMove();
      }
      if (pendingMove) clearTimeout(pendingMove.timer);
      pendingMove = {
        sequence, command: moved, count, from: pendingMove?.from ?? from, filepath: saved.filepath,
        timer: setTimeout(() => void flushMove(), MOVE_QUIET_MS), by: currentOrigin(),
      };
      return undefined;
    },

    attachScreenshot: async (id: string, path: string, target?: AnnotationTarget) => {
      const sequence = openSequence();
      if (!sequence) return 'no sequence is open';
      for (const command of sequence.commands ?? []) {
        const annotation = (command.annotations ?? []).find(note => note.id === id);
        if (!annotation) continue;
        annotation.screenshots = [...(annotation.screenshots ?? []), path];
        if (target && !annotation.target) annotation.target = target;
        return persist(sequence, 'capture added to a note');
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
