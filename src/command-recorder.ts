/**
 * Command Recorder for capturing and replaying tool invocations
 *
 * Records all tool calls automatically and allows creating named sequences
 * by selecting specific command indices from the history.
 */

import { promises as fs, existsSync } from 'fs';
import { walkSequenceFiles } from './helpers/sequence-tree.js';
import { ServerFileWatcher } from './server-watcher.js';
import { join, dirname } from 'path';
import { debugLog, isHistoryLogEnabled, logToHistoryFile } from './debug-logger.js';
import { sanitizeReference } from './reference-validator.js';
import { getOutputPath, registerRootBound } from './helpers/paths.js';
import { atomicWriteFile } from './atomic-write.js';
import { getIssueSequencesDir, getIssuesBySequenceFile } from './issue-tracker.js';
import { captureVariable } from './tools/replay-executor.js';
import type { Annotation } from './annotation.js';
import { substituteCapturedValues, type CaptureEntry } from './tools/interpolation-reverse.js';

/** JSON round-trip clone, tolerant of a result that isn't JSON-safe (drops it rather than throwing). */
function safeClone(value: any): any {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

export interface RecordedCommand {
  tool: string;
  params: Record<string, any>;
  delay?: number;  // ms to wait before executing this command
  comment?: string;  // user comment describing expected behavior
  /** Notes taken against this step, stored here so they travel with the file. */
  annotations?: Annotation[];
}

export interface CommandSequence {
  id: string;
  name: string;
  description?: string;
  expectedOutcome?: string;
  startUrl?: string;
  commands: RecordedCommand[];
  /**
   * Steps that run after `commands` reach a terminal state - success, a failed
   * step, an abort, or the total timeout - but NOT when the run pauses (stepTo,
   * a breakpoint, click validation), since a paused run is not over and its
   * state is what the user stopped to inspect.
   *
   * They run on their own timeout budget and without the run's abort signal, so
   * a cancelled or timed-out run still cleans up after itself, and they share
   * the run's variable store so they can undo what setup captured. Their
   * outcome never changes the run's verdict.
   */
  teardown?: RecordedCommand[];
  createdAt: number;
  /**
   * The connection every step was recorded against, when `create` hoisted a
   * uniform per-step `connectionReason` off the steps (bug-018). Hoisting is
   * what keeps a sequence portable, but it is lossy: without this, a later
   * `insert` cannot tell whether the incoming steps came from the SAME browser
   * as the bare ones (hoist again) or a different one (genuinely
   * multi-connection). Absent on sequences recorded before this existed and on
   * ones that never shared a single connection.
   */
  recordedConnection?: string;
  /**
   * Browsers this sequence needs before it can run, beyond the run's own
   * connection. A multi-browser sequence names its connections on the steps,
   * but naming them does not create them: without this the sequence can only
   * run when someone has already launched those browsers by hand, so a suite
   * run skips exactly the coverage that is hardest to get any other way.
   *
   * Each entry is launched before the first step if that reference is not
   * already live. A caller's `connections` rebinding wins: a declaration is a
   * default, not an override.
   */
  requiredConnections?: Array<{
    /** Connection reference the steps use, e.g. 'duo-member-two'. */
    reference: string;
    /** Opened on launch. Defaults to the sequence's startUrl. */
    url?: string;
    /**
     * Named persistent Chrome profile to bring this reference up on, e.g.
     * 'device-a' (see launchChrome({ profile })). The profile is the durable
     * identity - its cookies, localStorage and IndexedDB survive between runs,
     * so a device enrolled once stays enrolled - while the reference is only a
     * name for this session. Declaring the pair is what lets a saved sequence
     * be re-run tomorrow without rewiring which reference means which device.
     *
     * Implies reuse: a live Chrome already on this profile is the browser this
     * declaration wants, so `forceNewInstance` defaults to FALSE here. Only one
     * live Chrome may hold a profile, so forcing a second process would fail
     * against the very browser it was asking for.
     */
    profile?: string;
    /** A distinct browser process, not a tab (default true, but false when
     *  `profile` is set) - two identities sharing one browser share its
     *  storage, which defeats the point. */
    forceNewInstance?: boolean;
    /** Why this browser exists, for the run summary. */
    role?: string;
  }>;
  /**
   * WebSockets this sequence's assertions depend on. Declared here rather than
   * passed per run because the caller cannot be expected to know which socket
   * carries an app's data - the sequence does, and a declaration cannot be
   * forgotten by whoever invokes the run.
   *
   * Each entry is a substring of the socket URL. A run enforces, for every
   * entry: at least one matching socket is open when the run ends, and no
   * matching socket closed or hit frame errors while it executed. That covers
   * both a transport that died mid-run and one that never came up - the second
   * being invisible to any "is it up now" assertion written as a final step.
   *
   * Match on the app's own path (`/api/sync/socket`), not the origin, so the
   * declaration survives `baseUrl` retargeting. Dev-server sockets (Vite HMR
   * and friends) simply go undeclared and are ignored.
   */
  requiredSockets?: string[];
  /**
   * What kind of sequence this is, for selecting and reporting on a suite:
   * `['ui']`, `['contract', 'slow']`.
   *
   * Deliberately free-form rather than a closed `kind`, because the split that
   * matters is not knowable in advance - a suite wants to slice by area and
   * speed as readily as by ui-vs-contract, and folders are already spoken for
   * by scenario shape (spine/story/duo).
   *
   * What this answers: a suite reporting "36 passed" reads as interface
   * coverage, and in one 43-sequence suite 14 of those never issued a single
   * `input` step - navigate, request, assert, with the browser present only to
   * hold the auth cookie. Good contract tests, but no UI regression can fail
   * any of them, and nothing said so.
   */
  tags?: string[];
}

// Internal history tracking (includes index and timestamp)
interface HistoryCommand extends RecordedCommand {
  index: number;
  timestamp: number;
  /**
   * The tool's response, when known - never persisted onto a sequence
   * (RecordedCommand has no such field). Lets `create`/`insert` reconstruct
   * what a `saveAs` on this step would have captured, so a later step's
   * matching literal can be rewritten to `{{var:...}}` instead of copied.
   */
  result?: any;
}

// Active sequence state for step-through debugging
export interface ActiveSequenceState {
  sequenceId: string;
  sequenceName: string;
  connectionReason: string;
  currentStep: number;        // 0-indexed, next step to execute
  totalSteps: number;
  pausedAt: number;           // Timestamp when paused
  historyIndexAtPause: number; // History index when we paused (to track new commands)
  /** Variable store for {{var:name.path}} interpolation, shared by reference
   *  with the ExecutionContext across run/step/finish calls for this pause. */
  capturedVariables?: Record<string, any>;
  /** {{timestamp}} value for this run, fixed at first resolution so it stays
   *  stable across every step of the same run (including step/finish calls). */
  runTimestamp?: number;
  /** The background run this paused session belongs to, when the pause came
   *  from a registered `run` (stepTo / click validation). Lets `cancel` by
   *  runId clear the right paused session, and `cancel` of the session mark
   *  the owning run record cancelled. */
  runId?: string;
  /** Recorded-reference -> this-session-reference mapping for the run that
   *  paused (replay({ action: 'run', connections: {...} })). Carried on the
   *  paused state so `step`/`finish` resolve per-step connections exactly the
   *  way the original `run` did instead of reverting to raw recorded names. */
  connectionMap?: Record<string, string>;
}

export class CommandRecorder {
  private history: HistoryCommand[] = [];
  private sequences: Map<string, CommandSequence> = new Map();
  /** Bumped per created sequence: two created in the same millisecond used to
   *  share an id, and the second silently evicted the first from the map. */
  private sequenceSeq = 0;
  private commandCounter = 0;
  private maxHistorySize = 1000; // Keep last 1000 commands
  private activeSequence: ActiveSequenceState | null = null;
  private historyViewedWhilePaused: boolean = false;
  /**
   * Where each in-memory sequence came from, for the ones that came from disk.
   * A sequence built from history has no entry and is never touched by the
   * watcher - it exists nowhere else, so there is nothing to reload it from.
   */
  private sequenceSources: Map<string, { path: string; mtimeMs: number }> = new Map();
  private sequenceWatcher: ServerFileWatcher | null = null;
  private watchedDirs: Set<string> = new Set();

  constructor() {
    // A root relocation changes what getSequencesDir() resolves to; without
    // re-running startSequenceWatch() afterward, the watcher started here
    // stays bound to the directories under the old root. registerRootBound
    // is last-write-wins per name, so only the most recently constructed
    // recorder's rebind fires - the one that can still be live.
    registerRootBound({
      name: 'command-recorder',
      rebind: async () => {
        // startSequenceWatch() only attaches to directories that already
        // exist (a later save/load starts it otherwise) - a relocation target
        // with no sequences saved there yet would otherwise go unwatched
        // until something happened to write to it.
        await fs.mkdir(this.getSequencesDir(false), { recursive: true });
        this.startSequenceWatch();
      },
    });
  }

  /**
   * Get the sequences directory for a specific scope
   */
  getSequencesDir(global: boolean = false): string {
    return getOutputPath('sequences', { global });
  }

  /**
   * Watch the sequences directories and reload edited files, the way a managed
   * dev server is restarted when its sources change.
   *
   * Memory used to shadow disk for the lifetime of the session: a sequence
   * loaded once kept running its original version however many times you edited
   * the file, with nothing in the run output to say so. `runAll` reloads the
   * whole tree first, so the same sequence behaved differently depending on how
   * it was invoked - which is how the stale copy stayed invisible.
   *
   * Idempotent, and safe to call before the directories exist: it attaches to
   * whichever are present and callers re-invoke it after a save or load.
   */
  startSequenceWatch(): void {
    // The sequences directories, plus wherever loaded files actually live - a
    // sequence can be loaded by absolute path, or out of an issue's own folder.
    const dirs = [
      this.getSequencesDir(false),
      this.getSequencesDir(true),
      ...[...this.sequenceSources.values()].map(s => dirname(s.path)),
    ].filter((dir, i, all) => all.indexOf(dir) === i && existsSync(dir));
    if (dirs.length === 0) return;
    // Nothing new to cover: leave the running watcher alone.
    if (this.sequenceWatcher && dirs.every(dir => this.watchedDirs.has(dir))) return;

    this.sequenceWatcher?.stop();
    this.watchedDirs = new Set(dirs);
    this.sequenceWatcher = new ServerFileWatcher({
      paths: dirs,
      // Sequences live UNDER .cdp-tools, which the default exclude list drops -
      // taking every sequence with it.
      excludeDirNames: ['node_modules', '.git'],
      onChange: () => { void this.reloadChangedSequences(); },
    });
    this.sequenceWatcher.start();
  }

  /** Directories the sequence watcher is currently attached to. */
  getWatchedDirs(): string[] {
    return [...this.watchedDirs];
  }

  /** Stop watching (tests, shutdown). */
  stopSequenceWatch(): void {
    this.sequenceWatcher?.stop();
    this.sequenceWatcher = null;
    this.watchedDirs.clear();
  }

  /**
   * Re-read every disk-backed sequence whose file is newer than the copy in
   * memory. Returns the names actually reloaded.
   *
   * A file that has gone missing or will not parse leaves the in-memory copy
   * alone: a watcher fires mid-write as readily as after one, and dropping a
   * good sequence because it was caught half-written would be worse than the
   * staleness this exists to fix.
   */
  async reloadChangedSequences(ids?: string[]): Promise<string[]> {
    const reloaded: string[] = [];
    const scope = ids
      ? [...this.sequenceSources].filter(([id]) => ids.includes(id))
      : [...this.sequenceSources];
    for (const [id, source] of scope) {
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(source.path)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs <= source.mtimeMs) continue;

      let parsed: CommandSequence;
      try {
        parsed = await this.parseSequenceFile(source.path);
      } catch {
        continue;
      }

      this.sequences.delete(id);
      this.sequenceSources.delete(id);
      this.registerLoadedSequence(parsed);
      this.sequenceSources.set(parsed.id, { path: source.path, mtimeMs });
      reloaded.push(parsed.name);
      await debugLog('command-recorder', `Reloaded edited sequence "${parsed.name}" from ${source.path}`);
    }
    return reloaded;
  }

  /**
   * The current copy of a sequence, re-read first if its file has changed
   * since it was loaded.
   *
   * The watcher debounces (400ms), and an edit followed immediately by a run
   * is the normal rhythm - so a run does not wait for the watcher to catch up,
   * it asks. One stat on the way past.
   */
  async getFreshSequence(id: string): Promise<CommandSequence | undefined> {
    if (this.sequenceSources.has(id)) {
      const [reloadedName] = await this.reloadChangedSequences([id]);
      if (reloadedName) {
        return [...this.sequences.values()].find(s => s.name === reloadedName);
      }
    }
    return this.sequences.get(id);
  }

  /** Remember which file a sequence came from, so the watcher can refresh it. */
  private async trackSequenceSource(sequence: CommandSequence, filepath: string): Promise<void> {
    try {
      this.sequenceSources.set(sequence.id, { path: filepath, mtimeMs: (await fs.stat(filepath)).mtimeMs });
    } catch {
      // Unreadable stat just means this one is not watched.
    }
    this.startSequenceWatch();
  }

  /**
   * Set active sequence state (for step-through)
   */
  setActiveSequence(state: ActiveSequenceState | null): void {
    this.activeSequence = state;
    // Reset history viewed flag when sequence state changes
    this.historyViewedWhilePaused = false;
  }

  /**
   * Mark that history was viewed while paused (enables insert)
   */
  markHistoryViewed(): void {
    if (this.activeSequence) {
      this.historyViewedWhilePaused = true;
    }
  }

  /**
   * Reset history viewed flag (called when other actions are taken)
   */
  resetHistoryViewed(): void {
    this.historyViewedWhilePaused = false;
  }

  /**
   * Check if history was viewed while paused
   */
  wasHistoryViewed(): boolean {
    return this.historyViewedWhilePaused;
  }

  /**
   * Get active sequence state
   */
  getActiveSequence(): ActiveSequenceState | null {
    return this.activeSequence;
  }

  /**
   * Update current step in active sequence
   */
  updateActiveSequenceStep(step: number): void {
    if (this.activeSequence) {
      this.activeSequence.currentStep = step;
    }
  }

  /**
   * Get commands recorded since sequence was paused
   */
  getCommandsSincePause(): HistoryCommand[] {
    if (!this.activeSequence) return [];
    return this.history.filter(cmd => cmd.index > this.activeSequence!.historyIndexAtPause);
  }

  /**
   * Get current history index (for tracking pause point)
   */
  getCurrentHistoryIndex(): number {
    return this.history.length > 0 ? this.history[this.history.length - 1].index : -1;
  }

  /**
   * Record a command (always-on, automatic)
   */
  async recordCommand(tool: string, params: Record<string, any>, options?: { delay?: number; comment?: string; result?: any }): Promise<void> {
    // Reset history viewed flag when any command is recorded
    // (user must view history again before inserting)
    this.historyViewedWhilePaused = false;

    const paramsClone = JSON.parse(JSON.stringify(params));

    // Keep the connectionReason the call was actually made with (bug-018).
    // It used to be deleted here "to make sequences reusable", which meant a
    // recording that drove two browsers could not be replayed against two
    // browsers - every step fell back to the run-level connection and the
    // sequence silently collapsed into one browser. Reusability is preserved at
    // `create` time instead: a sequence whose steps all share one connection has
    // it hoisted back off the steps (see normalizeStepConnections), so a
    // run-level connectionReason still overrides. Only genuinely
    // multi-connection sequences keep it per-step.
    //
    // Sanitized so a recorded reference always matches the stored connection
    // reference ("Duo Owner Console" -> "duo-owner-console"), which is what
    // connection lookup and the launchChrome `reference` below use.
    if (typeof paramsClone.connectionReason === 'string') {
      paramsClone.connectionReason = sanitizeReference(paramsClone.connectionReason);
    }

    // Sanitize 'reference' param for tools that create connections
    // This ensures recorded sequences use the same reference format as the actual connection
    if (paramsClone.reference && ['launchChrome', 'connectDebugger'].includes(tool)) {
      paramsClone.reference = sanitizeReference(paramsClone.reference);
    }
    // Sanitize 'newReference' for tab rename operations
    if (paramsClone.newReference && tool === 'tab' && paramsClone.action === 'rename') {
      paramsClone.newReference = sanitizeReference(paramsClone.newReference);
    }

    const command: HistoryCommand = {
      index: this.commandCounter++,
      timestamp: Date.now(),
      tool,
      params: paramsClone,
      ...(options?.delay !== undefined && { delay: options.delay }),
      ...(options?.comment && { comment: options.comment }),
      ...(options?.result !== undefined && { result: safeClone(options.result) }),
    };

    this.history.push(command);

    // Trim history if it exceeds max size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    await debugLog('command-recorder', `Recorded #${command.index}: ${tool}`);

    // Write to history.log in replay-compatible format when history logging is enabled
    if (isHistoryLogEnabled()) {
      const historyEntry: RecordedCommand = { tool, params: paramsClone };
      await logToHistoryFile(JSON.stringify(historyEntry));
    }
  }

  /**
   * Get command history (most recent first)
   */
  getHistory(limit: number = 50): HistoryCommand[] {
    return [...this.history].reverse().slice(0, limit);
  }

  /**
   * Get a specific command by index
   */
  getCommand(index: number): HistoryCommand | undefined {
    return this.history.find(cmd => cmd.index === index);
  }

  /**
   * Attach a tool's response to an already-recorded history entry. Recording
   * happens before the handler runs (so a failed call is still in history for
   * `getHistory`/repeat), so the result can only be filled in afterward.
   */
  attachResult(index: number, result: any): void {
    const cmd = this.history.find(c => c.index === index);
    if (cmd) cmd.result = safeClone(result);
  }

  /**
   * Build RecordedCommand[] from history indices, in order, substituting any
   * step's literal value that matches an EARLIER included step's `saveAs`
   * capture with a `{{var:name.path}}` reference - the templatization a
   * sequence needs to be portable beyond the run it was recorded from (see
   * references/sequences.md). Returns null if any index doesn't exist.
   */
  buildCommandsFromHistory(commandIndices: number[]): RecordedCommand[] | null {
    const captures: CaptureEntry[] = [];
    const commands: RecordedCommand[] = [];
    for (const idx of commandIndices) {
      const cmd = this.getCommand(idx);
      if (!cmd) return null;

      // params is DEEP-CLONED: the sequence is edited after creation (hoisting a
      // uniform connectionReason off the steps, rebasing URLs), and sharing the
      // object with the history entry made those edits silently rewrite history.
      const paramsClone = JSON.parse(JSON.stringify(cmd.params));
      commands.push({
        tool: cmd.tool,
        params: substituteCapturedValues(paramsClone, captures),
        ...(cmd.delay !== undefined && { delay: cmd.delay }),
        ...(cmd.comment && { comment: cmd.comment }),
      });

      if (cmd.params.saveAs && cmd.result !== undefined) {
        const captured = captureVariable(cmd.tool, cmd.params, cmd.result);
        if (captured.ok) {
          captures.push({ name: cmd.params.saveAs, value: captured.value });
        }
      }
    }
    return commands;
  }

  /**
   * Create a sequence from command indices
   */
  async createSequence(
    name: string,
    commandIndices: number[],
    options?: {
      description?: string;
      expectedOutcome?: string;
      startUrl?: string;
      /**
       * Called with the fully built candidate BEFORE it replaces any same-named
       * sequence in memory. Return false to reject: nothing is removed and nothing
       * is stored, so a rejected create leaves the existing sequence intact.
       * (Validating after the fact deleted the good copy and then rejected the bad
       * one, leaving the user with neither.)
       */
      validate?: (candidate: CommandSequence) => boolean;
    }
  ): Promise<CommandSequence | null> {
    // Validate all indices exist, build commands, and templatize literals
    // that match an earlier included step's saveAs capture.
    const commands = this.buildCommandsFromHistory(commandIndices);
    if (!commands) {
      await debugLog('command-recorder', `Invalid command index in [${commandIndices.join(', ')}]`);
      return null;
    }

    // Extract startUrl from commands if not explicitly provided
    let startUrl = options?.startUrl;
    if (!startUrl) {
      // Look for the first navigate goto action
      for (const cmd of commands) {
        if (cmd.tool === 'navigate' && cmd.params.action === 'goto' && cmd.params.url) {
          startUrl = cmd.params.url;
          break;
        }
      }
    }

    const sequence: CommandSequence = {
      id: `seq-${Date.now()}-${++this.sequenceSeq}`,
      name,
      ...(options?.description && { description: options.description }),
      ...(options?.expectedOutcome && { expectedOutcome: options.expectedOutcome }),
      ...(startUrl && { startUrl }),
      commands,
      createdAt: Date.now(),
    };

    // Validate before anything destructive happens (see options.validate).
    if (options?.validate && !options.validate(sequence)) {
      await debugLog('command-recorder', `Rejected sequence "${name}" (validation failed) - existing sequence left intact`);
      return null;
    }

    // Dedupe by name so re-creating a sequence replaces the old in-memory copy
    // rather than leaving a stale one that loadSequence({name}) would resolve (#75).
    this.removeSequenceByName(name);
    this.sequences.set(sequence.id, sequence);
    await debugLog('command-recorder', `Created sequence "${name}" with ${commands.length} commands${startUrl ? `, startUrl: ${startUrl}` : ''}`);
    return sequence;
  }

  /**
   * Create a sequence directly from commands (not from history)
   */
  async createSequenceFromCommands(
    name: string,
    commands: RecordedCommand[],
    options?: { description?: string; expectedOutcome?: string; startUrl?: string }
  ): Promise<CommandSequence> {
    // Extract startUrl from commands if not explicitly provided
    let startUrl = options?.startUrl;
    if (!startUrl) {
      for (const cmd of commands) {
        if (cmd.tool === 'navigate' && cmd.params.action === 'goto' && cmd.params.url) {
          startUrl = cmd.params.url;
          break;
        }
      }
    }

    const sequence: CommandSequence = {
      id: `seq-${Date.now()}-${++this.sequenceSeq}`,
      name,
      ...(options?.description && { description: options.description }),
      ...(options?.expectedOutcome && { expectedOutcome: options.expectedOutcome }),
      ...(startUrl && { startUrl }),
      commands,
      createdAt: Date.now(),
    };

    // Dedupe by name (see createSequence / #75).
    this.removeSequenceByName(name);
    this.sequences.set(sequence.id, sequence);
    await debugLog('command-recorder', `Created sequence "${name}" from commands with ${commands.length} commands${startUrl ? `, startUrl: ${startUrl}` : ''}`);
    return sequence;
  }

  /**
   * Check if a sequence with the given name exists
   */
  sequenceNameExists(name: string): boolean {
    for (const seq of this.sequences.values()) {
      if (seq.name === name) return true;
    }
    return false;
  }

  /**
   * List all saved sequences
   */
  listSequences(): CommandSequence[] {
    return Array.from(this.sequences.values());
  }

  /**
   * Get a specific sequence by ID
   */
  getSequence(sequenceId: string): CommandSequence | undefined {
    return this.sequences.get(sequenceId);
  }


  /**
   * Delete a sequence
   */
  deleteSequence(sequenceId: string): boolean {
    return this.sequences.delete(sequenceId);
  }

  /**
   * Remove ALL in-memory sequences with the given name. Used on create/reload so a
   * name maps to exactly one sequence — otherwise `loadSequence({name})` resolves the
   * oldest insertion-order match and re-created sequences are silently ignored (#75).
   */
  private removeSequenceByName(name: string): void {
    for (const [id, seq] of this.sequences.entries()) {
      if (seq.name === name) {
        this.sequences.delete(id);
      }
    }
  }

  /**
   * Clear all sequences
   */
  async clearAllSequences(): Promise<void> {
    this.sequences.clear();
    await debugLog('command-recorder', 'All sequences cleared');
  }

  /**
   * Clear command history
   */
  async clearHistory(): Promise<void> {
    this.history = [];
    this.commandCounter = 0;
    await debugLog('command-recorder', 'Command history cleared');
  }

  /**
   * Get statistics
   */
  getStats(): {
    historyCount: number;
    sequenceCount: number;
    oldestCommandIndex: number | null;
    newestCommandIndex: number | null;
  } {
    return {
      historyCount: this.history.length,
      sequenceCount: this.sequences.size,
      oldestCommandIndex: this.history.length > 0 ? this.history[0].index : null,
      newestCommandIndex: this.history.length > 0 ? this.history[this.history.length - 1].index : null,
    };
  }

  /**
   * Save a sequence to disk
   * @param sequenceId - ID of the sequence to save
   * @param global - If true, save to global ~/.devharness/sequences/, otherwise working directory
   */
  async saveSequenceToDisk(
    sequenceId: string,
    global: boolean = false,
    overwrite: boolean = false
  ): Promise<{ success: true; filepath: string } | { success: false; error: string; conflict?: boolean; filepath?: string } | null> {
    const sequence = this.getSequence(sequenceId);
    if (!sequence) {
      await debugLog('command-recorder', `Sequence ${sequenceId} not found`);
      return null;
    }

    const targetDir = this.getSequencesDir(global);

    try {
      // Sanitize filename - use name directly
      // Note: atomicWriteFile handles directory creation
      const safeFilename = sequence.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
      // Save back into the folder the sequence came from. Writing to the root
      // instead forks it: the foldered original goes stale while a second copy
      // appears at top level, which runAll then runs twice.
      let filename = `${safeFilename}.json`;
      const existing = (await this.listSavedSequencesOnDisk())
        .find(e => e.location === (global ? 'global' : 'working-dir') &&
                   (e.id === sequence.id || e.name === sequence.name));
      const existingDir = existing?.filename.includes('/')
        ? existing.filename.slice(0, existing.filename.lastIndexOf('/'))
        : '';
      if (existingDir) filename = `${existingDir}/${filename}`;
      const filepath = join(targetDir, filename);

      // Check for conflict
      try {
        await fs.access(filepath);
        // File exists
        if (!overwrite) {
          return { success: false, error: 'File already exists', conflict: true, filepath };
        }
      } catch {
        // File doesn't exist, proceed
      }

      // Add usage comment to exported file
      const exportData = {
        _comment: 'CDP Tools replay sequence. Load with: replay({ action: "load", filename: "<this-file>" }), then run with: replay({ action: "run", name: "<this-file>" })',
        ...sequence
      };
      await atomicWriteFile(filepath, JSON.stringify(exportData, null, 2));
      // Now disk-backed: watch it, and record THIS write's mtime so the save
      // does not read back as an external edit.
      await this.trackSequenceSource(sequence, filepath);
      await debugLog('command-recorder', `Saved sequence "${sequence.name}" to ${filepath}`);
      return { success: true, filepath };
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to save sequence: ${error}`);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Find best matching filename from saved sequences (searches both working dir and global)
   * Supports: exact match, with/without .json, name prefix (returns latest by timestamp)
   * Returns the full path to the matched file
   */
  async findMatchingFilename(searchTerm: string): Promise<{ filename: string; fullPath: string; matchType: string; location: string } | null> {
    const savedSequences = await this.listSavedSequencesOnDisk();
    if (savedSequences.length === 0) return null;

    const term = searchTerm.toLowerCase();
    const termWithoutJson = term.endsWith('.json') ? term.slice(0, -5) : term;
    // `filename` is relative to the sequences root, so it may carry a folder
    // ('spine/spine-01.json'). Match the bare basename too, otherwise moving a
    // file into a folder breaks every existing load call that names it directly.
    const base = (f: string) => f.toLowerCase().split('/').pop() || f.toLowerCase();

    // 1. Exact filename match (with or without .json, full path or basename)
    const exactMatch = savedSequences.find(s =>
      s.filename.toLowerCase() === term ||
      s.filename.toLowerCase() === termWithoutJson + '.json' ||
      base(s.filename) === term ||
      base(s.filename) === termWithoutJson + '.json'
    );
    if (exactMatch) {
      return { filename: exactMatch.filename, fullPath: exactMatch.fullPath, matchType: 'exact', location: exactMatch.location };
    }

    // 2. Exact name match
    const nameMatch = savedSequences.find(s => s.name.toLowerCase() === termWithoutJson);
    if (nameMatch) {
      return { filename: nameMatch.filename, fullPath: nameMatch.fullPath, matchType: 'name', location: nameMatch.location };
    }

    // 3. Filename starts with search term (gets latest by sorting)
    const prefixMatches = savedSequences.filter(s =>
      s.filename.toLowerCase().startsWith(termWithoutJson) ||
      base(s.filename).startsWith(termWithoutJson)
    );
    if (prefixMatches.length > 0) {
      // Sort by filename descending to get latest timestamp
      prefixMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: prefixMatches[0].filename, fullPath: prefixMatches[0].fullPath, matchType: 'prefix', location: prefixMatches[0].location };
    }

    // 4. Name starts with search term
    const namePrefixMatches = savedSequences.filter(s =>
      s.name.toLowerCase().startsWith(termWithoutJson)
    );
    if (namePrefixMatches.length > 0) {
      namePrefixMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: namePrefixMatches[0].filename, fullPath: namePrefixMatches[0].fullPath, matchType: 'name-prefix', location: namePrefixMatches[0].location };
    }

    // 5. Name contains search term
    const containsMatches = savedSequences.filter(s =>
      s.name.toLowerCase().includes(termWithoutJson)
    );
    if (containsMatches.length > 0) {
      containsMatches.sort((a, b) => b.filename.localeCompare(a.filename));
      return { filename: containsMatches[0].filename, fullPath: containsMatches[0].fullPath, matchType: 'contains', location: containsMatches[0].location };
    }

    return null;
  }

  /**
   * Parse a sequence file from disk WITHOUT touching in-memory state.
   * Split out from registration so a caller can validate the parsed candidate
   * before anything same-named is evicted (see registerLoadedSequence).
   */
  private async parseSequenceFile(filepath: string): Promise<CommandSequence> {
    const content = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(content) as CommandSequence;
  }

  /**
   * Register a parsed sequence in memory, replacing any same-named copy.
   * Validation (if supplied) runs BEFORE the removal, so a rejected load leaves
   * the pre-existing sequence completely intact instead of deleting the good copy
   * and then rejecting the bad one, leaving the user with neither.
   */
  private registerLoadedSequence(
    sequence: CommandSequence,
    validate?: (candidate: CommandSequence) => boolean
  ): boolean {
    if (validate && !validate(sequence)) return false;

    // Remove any existing sequence with the same name (may have different ID)
    this.removeSequenceByName(sequence.name);
    this.sequences.set(sequence.id, sequence);
    return true;
  }

  /**
   * Load a sequence from disk (supports fuzzy filename matching)
   *
   * @param options.validate - Called with the parsed candidate BEFORE it replaces any
   *   same-named in-memory sequence. Return false to reject: nothing is removed and
   *   nothing is stored, and this method returns null.
   */
  async loadSequenceFromDisk(
    filename: string,
    options?: { validate?: (candidate: CommandSequence) => boolean }
  ): Promise<CommandSequence | null> {
    try {
      // Support absolute paths directly
      if (filename.startsWith('/') || filename.includes(':\\')) {
        const sequence = await this.parseSequenceFile(filename);
        if (!this.registerLoadedSequence(sequence, options?.validate)) {
          await debugLog('command-recorder', `Rejected sequence "${sequence.name}" from ${filename} (validation failed) - existing sequence left intact`);
          return null;
        }
        await this.trackSequenceSource(sequence, filename);
        await debugLog('command-recorder', `Loaded sequence "${sequence.name}" from ${filename}`);
        return sequence;
      }

      // Try fuzzy matching for relative filenames
      const match = await this.findMatchingFilename(filename);
      if (!match) {
        await debugLog('command-recorder', `No matching sequence found for "${filename}"`);
        return null;
      }

      const filepath = match.fullPath;
      await debugLog('command-recorder', `Matched "${filename}" to "${match.filename}" (${match.matchType})`);

      const sequence = await this.parseSequenceFile(filepath);
      if (!this.registerLoadedSequence(sequence, options?.validate)) {
        await debugLog('command-recorder', `Rejected sequence "${sequence.name}" from ${filepath} (validation failed) - existing sequence left intact`);
        return null;
      }

      await this.trackSequenceSource(sequence, filepath);
      await debugLog('command-recorder', `Loaded sequence "${sequence.name}" from ${filepath}`);
      return sequence;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to load sequence from ${filename}: ${error}`);
      return null;
    }
  }

  /**
   * List saved sequences on disk from a specific directory
   */
  private async listSequencesFromDir(dir: string, location: 'working-dir' | 'global' | 'issues'): Promise<Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }>> {
    const sequences: Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }> = [];

    try {
      // Read directory - if it doesn't exist, return empty list (no side effects)
      // Walk subdirectories too: a suite is easier to run when it can be grouped
      // into folders (spine/, story/, _helpers/). `filename` stays relative to the
      // sequences root ('spine/spine-01.json'), so it round-trips back through load.
      let jsonFiles: string[];
      try {
        jsonFiles = await walkSequenceFiles(dir);
      } catch (err: any) {
        if (err.code === 'ENOENT') return sequences; // Directory doesn't exist yet
        throw err;
      }

      for (const file of jsonFiles) {
        try {
          const filepath = join(dir, file);
          const content = await fs.readFile(filepath, 'utf-8');
          const sequence: CommandSequence = JSON.parse(content);
          sequences.push({
            filename: file,
            name: sequence.name,
            id: sequence.id,
            commandCount: sequence.commands?.length || 0,
            location,
            fullPath: filepath,
            ...(sequence.description && { description: sequence.description }),
            ...(sequence.expectedOutcome && { expectedOutcome: sequence.expectedOutcome }),
            ...(sequence.startUrl && { startUrl: sequence.startUrl }),
          });
        } catch (error) {
          await debugLog('command-recorder', `Failed to parse ${file}: ${error}`);
        }
      }
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to list sequences from ${dir}: ${error}`);
    }

    return sequences;
  }

  /**
   * List saved sequences on disk (checks both working directory and global)
   */
  async listSavedSequencesOnDisk(): Promise<Array<{ filename: string; name: string; id: string; commandCount: number; description?: string; expectedOutcome?: string; startUrl?: string; location: string; fullPath: string }>> {
    const workingDir = this.getSequencesDir(false);
    const globalDir = this.getSequencesDir(true);

    // Get sequences from both locations
    const workingDirSequences = await this.listSequencesFromDir(workingDir, 'working-dir');
    const globalSequences = await this.listSequencesFromDir(globalDir, 'global');

    // If working dir and global are the same (fallback case), avoid duplicates
    if (workingDir === globalDir) {
      return workingDirSequences;
    }

    return [...workingDirSequences, ...globalSequences];
  }

  /**
   * List issue sequences on disk with associated issue metadata
   */
  async listIssueSequencesOnDisk(): Promise<Array<{
    filename: string;
    name: string;
    id: string;
    commandCount: number;
    description?: string;
    expectedOutcome?: string;
    startUrl?: string;
    location: string;
    fullPath: string;
    issueId?: number;
    issueType?: string;
    issueStatus?: string;
  }>> {
    const issuesDir = getIssueSequencesDir();
    const sequences = await this.listSequencesFromDir(issuesDir, 'issues');

    // Get issue metadata
    const issueMap = await getIssuesBySequenceFile();

    return sequences.map(seq => {
      const issue = issueMap.get(seq.filename);
      return {
        ...seq,
        issueId: issue?.id,
        issueType: issue?.type,
        issueStatus: issue?.status
      };
    });
  }

  /**
   * Delete a sequence from disk (supports fuzzy filename matching)
   */
  async deleteSequenceFromDisk(filename: string): Promise<boolean> {
    try {
      // Support absolute paths directly
      if (filename.startsWith('/') || filename.includes(':\\')) {
        await fs.unlink(filename);
        await debugLog('command-recorder', `Deleted sequence file: ${filename}`);
        return true;
      }

      // Try fuzzy matching for relative filenames
      const match = await this.findMatchingFilename(filename);
      if (!match) {
        await debugLog('command-recorder', `No matching sequence found for "${filename}"`);
        return false;
      }

      const filepath = match.fullPath;
      await debugLog('command-recorder', `Matched "${filename}" to "${match.filename}" (${match.matchType})`);

      await fs.unlink(filepath);
      await debugLog('command-recorder', `Deleted sequence file: ${filepath}`);
      return true;
    } catch (error: any) {
      await debugLog('command-recorder', `Failed to delete ${filename}: ${error}`);
      return false;
    }
  }
}
