/**
 * Replay Formatters - Response formatting for replay tool actions
 */
import type { RecordedCommand, CommandSequence, ActiveSequenceState } from '../command-recorder.js';
import type { StepResult, DebugState, BreakpointHitInfo, ClickValidationFailure } from './replay-executor.js';
import type { InputEvent } from '../interaction-recorder.js';
import { countsLine, describeCall, readingConnection } from './history-activity.js';
import { observationsOf } from '../observation-log.js';
import {
  isMouseEvent,
  isKeyboardEvent,
  isNavigationEvent,
  isCommentEvent,
  isPasteEvent,
} from '../interaction-recorder.js';
import { getFormattedResponse, withOnce } from '../messages.js';
import { sequenceNeedsProxy } from './replay-connections.js';
import { DEFAULT_HOLD_THRESHOLD_MS } from '../press-hold.js';

// =============================================================================
// Result Formatting
// =============================================================================

/**
 * Format execution results for display
 */
export function formatExecutionResults(
  sequenceName: string,
  results: StepResult[],
  totalCommands: number,
  durationMs: number,
  /**
   * Reported in its own section, never folded into the counts above. Teardown
   * is cleanup, so a failure in it must not turn a passing run red - or make a
   * failing one look like it failed somewhere it didn't.
   */
  teardown?: { results: StepResult[]; failed?: boolean }
): string {
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  let response: string;

  if (failed > 0) {
    const failedResult = results.find(r => !r.success)!;
    response = getFormattedResponse('REPLAY_RUN_FAILED', {
      sequenceName,
      failedStep: failedResult.step,
      failedTool: failedResult.tool
    });
  } else {
    response = getFormattedResponse('REPLAY_RUN_SUCCESS', {
      sequenceName,
      successful,
      total: totalCommands,
      duration: (durationMs / 1000).toFixed(1)
    });
  }

  // Stats section
  response += `\n\n**Executed:** ${results.length} of ${totalCommands} commands`;
  response += `\n**Successful:** ${successful}`;
  response += `\n**Failed:** ${failed}`;
  response += `\n**Duration:** ${(durationMs / 1000).toFixed(1)}s`;

  if (failed > 0) {
    response += `\n\n**Failed Commands**\n`;
    results.filter(r => !r.success).forEach((r) => {
      if ((r.tool === 'forEach' || r.tool === 'check') && r.substeps) {
        const scope = r.tool === 'forEach'
          ? `${r.sequenceName}, item ${r.iterations} of ${r.itemsFound}`
          : `${r.check?.outcome} \`${r.check?.subject}\`, ran ${r.sequenceName}`;
        response += `${r.step}. **${r.tool}** (${scope})\n`;
        response += `   **Error:** ${r.error}\n`;
        // Show substeps - but skip redundant error messages
        r.substeps.forEach((sub) => {
          const icon = sub.success ? '✓' : '✗';
          response += `   ${r.step}.${sub.step}. ${sub.tool} ${icon}`;
          // Only show substep error if it's different from the parent error
          if (!sub.success && sub.error && sub.error !== r.error) {
            response += ` - ${sub.error}`;
          }
          response += `\n`;
        });
        response += `\n`;
      } else if (r.tool === 'check' && r.check) {
        response += `${r.step}. **check** ${r.check.outcome} \`${r.check.subject}\`${r.check.found ? ` - found ${r.check.found}` : ''}\n`;
        response += `   **Error:** ${r.error}\n\n`;
      } else {
        response += `${r.step}. **${r.tool}**\n`;
        response += `   **Error:** ${r.error}\n\n`;
      }
    });
  }

  if (successful > 0) {
    response += `\n\n**Successful Commands**\n`;
    results.filter(r => r.success).forEach((r) => {
      if (r.tool === 'check' && r.check) {
        const answered = r.check.outcome === 'held' ? '✓ held' : '○ failed';
        const ran = r.substeps?.length ?? 0;
        const did = r.check.action === 'run' ? ` - ran ${r.sequenceName} (${ran} step${ran === 1 ? '' : 's'})` : '';
        response += `${r.step}. **check** ${answered} \`${r.check.subject}\`${did}\n`;
        (r.substeps ?? []).forEach((sub) => {
          response += `   ${r.step}.${sub.step}. ${sub.tool} ${sub.success ? '✓' : '✗'}\n`;
        });
      } else if (r.tool === 'forEach') {
        // An empty source is a legitimate outcome, not a silent nothing: a
        // converge loop with nothing left to clean up looks identical to a
        // broken selector unless the count is stated.
        if (r.iterations && r.substeps && r.substeps.length > 0) {
          response += `${r.step}. **${r.tool}** (${r.sequenceName}) ✓ - ran ${r.iterations} of ${r.itemsFound} item(s)\n`;
          r.substeps.forEach((sub) => {
            const icon = sub.success ? '✓' : '✗';
            response += `   ${r.step}.${sub.step}. ${sub.tool} ${icon}\n`;
          });
        } else {
          response += `${r.step}. **${r.tool}** (${r.sequenceName}) ○ - ${r.itemsFound || 0} item(s) found, none ran\n`;
        }
      } else {
        response += `${r.step}. **${r.tool}** ✓\n`;
      }
    });
  }

  return response + formatTeardown(teardown);
}

/** A run's teardown in a section of its own, never counted into the run's verdict. */
export function formatTeardown(teardown?: { results: StepResult[]; failed?: boolean }): string {
  if (!teardown || teardown.results.length === 0) return '';
  const tdFailed = teardown.results.filter(r => !r.success).length;
  let section = `\n\n**Teardown** (${teardown.results.length} step(s)`;
  section += tdFailed > 0 ? `, ${tdFailed} failed - does not change the run's verdict)\n` : `)\n`;
  teardown.results.forEach((r) => {
    const icon = r.success ? '✓' : '✗';
    section += `T${r.step}. ${r.tool} ${icon}`;
    if (!r.success && r.error) section += ` - ${r.error}`;
    section += `\n`;
  });
  return section;
}

/** Why each step failed, by 1-based step, as the executor reported it. */
export function failuresOf(results: StepResult[]): Map<number, string> {
  return new Map(results.filter(r => !r.success && r.error).map(r => [r.step, r.error!]));
}

/**
 * Format paused sequence response
 */
export function formatPausedResponse(
  sequence: CommandSequence,
  results: StepResult[],
  pausedAtStep: number,
  durationMs: number
): string {
  const commands = sequence.commands;
  const successful = results.filter(r => r.success).length;
  const remaining = commands.length - pausedAtStep;

  let response = getFormattedResponse('REPLAY_PAUSED', {
    sequenceName: sequence.name,
    nextStep: pausedAtStep + 1,
    total: commands.length,
    remaining
  });

  response += `\n\n**Executed:** ${successful} commands in ${(durationMs / 1000).toFixed(1)}s`;

  response += `\n\n**Completed Steps**\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n**Next Steps**\n`;
  for (let j = pausedAtStep; j < Math.min(pausedAtStep + 3, commands.length); j++) {
    response += `${j + 1}. **${commands[j].tool}**\n`;
  }
  if (commands.length > pausedAtStep + 3) {
    response += `... and ${commands.length - pausedAtStep - 3} more\n`;
  }

  response += `\n---\n\n**Actions**\n`;
  response += `- Continue: \`run({ action: 'step' })\` or \`run({ action: 'step', stepCount: N })\`\n`;
  response += `- Finish all: \`run({ action: 'finish' })\`\n`;
  response += `- Check status: \`run({ action: 'status' })\`\n`;
  response += `- Insert commands: \`replay({ action: 'insert' })\`\n`;

  return response;
}

/**
 * Format click validation failure response (paused for inspection/retry)
 */
export function formatClickValidationFailure(
  sequence: CommandSequence,
  results: StepResult[],
  pausedAtStep: number,
  durationMs: number,
  failure: ClickValidationFailure,
  connection: string
): string {
  const commands = sequence.commands;
  const successful = results.filter(r => r.success).length;
  const remaining = commands.length - pausedAtStep;

  let response = failure.repair ? `**Reached Another Element**\n` : `**Click Validation Failed**\n`;
  response += `${sequence.name}: Paused at step ${pausedAtStep} of ${commands.length}, ${remaining} remaining\n\n`;

  response += `**Executed:** ${successful} commands in ${(durationMs / 1000).toFixed(1)}s\n\n`;

  response += `**Validation Error at Step ${failure.step}**\n`;
  response += `- Selector: \`${failure.selector}\`\n`;
  for (const err of failure.errors) {
    response += `- ❌ ${err}\n`;
  }
  for (const warn of failure.warnings) {
    response += `- ⚠️ ${warn}\n`;
  }
  if (failure.info?.length > 0) {
    for (const infoMsg of failure.info) {
      response += `- ℹ️ ${infoMsg}\n`;
    }
  }

  response += `\n**Completed Steps**\n`;
  results.filter(r => r.success).forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  const repair = failure.repair;
  if (repair) {
    response += `\n**Repair**\n`;
    if (repair.selector) {
      response += `- The recorded element is at \`${repair.selector}\`. It moved: \`replay({ action: 'repair', accept: 'selector' })\` rewrites step ${failure.step}'s selector to it\n`;
    } else if (repair.matches > 1) {
      response += `- ${repair.matches} elements carry the recorded element's identity, so no selector is offered\n`;
    } else {
      response += `- The recorded element is not on the page\n`;
    }
    response += `- It changed on purpose: \`replay({ action: 'repair', accept: 'element' })\` keeps the selector and records the element it hit\n`;
    response += `- Either one writes the sequence file; \`run({ action: 'step' })\` then runs the step again\n`;
  }

  response += `\n---\n\n**Actions**\n`;
  response += `- Inspect error: \`console({ action: 'list', type: 'error', connection: '${connection}' })\`\n`;
  response += `- Retry the step: \`run({ action: 'step' })\`\n`;
  response += `- Finish remaining: \`run({ action: 'finish' })\`\n`;
  response += `- Cancel: \`run({ action: 'cancel' })\`\n`;

  return response;
}

/**
 * Format breakpoint hit response
 */
export function formatBreakpointHit(
  sequenceName: string,
  results: StepResult[],
  totalCommands: number,
  durationMs: number,
  breakpointInfo: BreakpointHitInfo,
  connection: string
): string {
  const location = `${breakpointInfo.url}:${breakpointInfo.lineNumber}`;

  let response = getFormattedResponse('REPLAY_BREAKPOINT_HIT', {
    sequenceName,
    location,
    step: results.length,
    total: totalCommands
  });

  response += `\n\n**Location:** \`${breakpointInfo.url}:${breakpointInfo.lineNumber}\``;
  if (breakpointInfo.functionName) {
    response += `\n**Function:** \`${breakpointInfo.functionName}\``;
  }
  response += `\n**Step:** ${results.length} of ${totalCommands}`;
  response += `\n**Duration:** ${(durationMs / 1000).toFixed(1)}s`;

  response += `\n\n**Completed Steps**\n`;
  results.forEach((r) => {
    response += `${r.step}. **${r.tool}** ✓\n`;
  });

  response += `\n---\n\n**The run is held at step ${results.length}.** \`run({ action: 'finish' })\` resumes the page and runs the remaining steps; \`run({ action: 'step' })\` resumes it and runs one; \`run({ action: 'cancel' })\` ends the run.\n`;
  response += `\n**Debug Actions**\n`;
  response += `- Inspect call stack: \`inspect({ action: 'getCallStack', connection: '${connection}' })\`\n`;
  response += `- Get variables: \`inspect({ action: 'getVariables', connection: '${connection}', callFrameId: '<from call stack>' })\`\n`;
  response += `- Step over: \`execution({ action: 'stepOver', connection: '${connection}' })\`\n`;

  return response;
}

/**
 * Format debug state section
 */
export function formatDebugState(debugState: DebugState, connection: string): string {
  if (!debugState.isPaused && debugState.breakpointCount === 0) {
    return '';
  }

  let section = `\n\n**Debug State**\n`;

  if (debugState.isPaused) {
    section += `\n**Execution paused** at ${debugState.pauseLocation}\n\n`;
    section += `**Next steps:**\n`;
    section += `- Inspect call stack: \`inspect({ action: 'getCallStack', connection: '${connection}' })\`\n`;
    section += `- Get variables: \`inspect({ action: 'getVariables', connection: '${connection}', callFrameId: '<from call stack>' })\`\n`;
    section += `- Resume execution: \`execution({ action: 'resume', connection: '${connection}' })\`\n`;
    section += `- Step over: \`execution({ action: 'stepOver', connection: '${connection}' })\`\n`;
  }

  if (debugState.breakpointCount > 0) {
    section += `\n**${debugState.breakpointCount} active breakpoint${debugState.breakpointCount > 1 ? 's' : ''}**\n`;
    section += `- List breakpoints: \`breakpoint({ action: 'list', connection: '${connection}' })\`\n`;
    section += `- Remove one: \`breakpoint({ action: 'remove', connection: '${connection}', breakpointId: '<id>' })\`\n`;
  }

  return section;
}

// =============================================================================
// Variable Formatting
// =============================================================================

interface ExtractedVariable {
  value: string;
  locations: string[];
}

/**
 * Extract customizable text variables from sequence commands
 */
export function extractTextVariables(commands: RecordedCommand[]): Record<string, ExtractedVariable> {
  const variables: Record<string, ExtractedVariable> = {};

  commands.forEach((cmd, cmdIdx) => {
    if (cmd.tool === 'input' && cmd.params.action === 'type' && cmd.params.text) {
      const varName = `var_${cmdIdx}_${cmd.params.selector?.replace(/[^a-zA-Z0-9]/g, '_') || 'text'}`;
      if (!variables[varName]) {
        variables[varName] = { value: cmd.params.text, locations: [] };
      }
      variables[varName].locations.push(`Command ${cmdIdx + 1}: ${cmd.tool} -> ${cmd.params.selector}`);
    }
  });

  return variables;
}

/**
 * Format variable prompt for user to customize values before execution
 */
export function formatVariablePrompt(
  sequenceName: string,
  sequenceIdOrName: string,
  variables: Record<string, ExtractedVariable>,
  connection: string | undefined
): string {
  let response = getFormattedResponse('REPLAY_VARIABLE_PROMPT', {
    sequenceName,
    variableCount: Object.keys(variables).length
  });

  response += `\n\n**Customizable text parameter(s):**\n`;
  Object.entries(variables).forEach(([varName, data]) => {
    response += `- \`${varName}\`: "${data.value}"\n`;
  });

  response += `\n**Execute:**\n\n`;
  response += `**Option 1: Keep original values**\n`;
  response += `\`\`\`javascript\n`;
  response += `run({ action: 'sequence', name: '${sequenceIdOrName}'`;
  if (connection) {
    response += `, connection: '${connection}'`;
  }
  response += `, variables: {} })\n`;
  response += `\`\`\`\n\n`;

  response += `**Option 2: Custom values** (replace variable values as needed)\n`;
  response += `\`\`\`javascript\n`;
  response += `run({ action: 'sequence', name: '${sequenceIdOrName}'`;
  if (connection) {
    response += `, connection: '${connection}'`;
  }
  response += `, variables: {\n`;
  Object.keys(variables).forEach((varName, idx, arr) => {
    response += `  "${varName}": "custom-value"${idx < arr.length - 1 ? ',' : ''}\n`;
  });
  response += `} })\n`;
  response += `\`\`\``;

  return response;
}

// =============================================================================
// History & Sequence Formatting
// =============================================================================

interface HistoryCommand {
  index: number;
  tool: string;
  params: Record<string, any>;
  delay?: number;
  comment?: string;
  /** The sequence whose run executed this call as a step. */
  run?: string;
  /** The channel the call came in on. */
  from?: 'mcp' | 'cli' | 'bench' | 'person';
}

/**
 * A call's channel in words, for the ones that did not come from the agent:
 * a person's work in the bench announces itself on the event stream only for
 * notes, captures and sequence writes, so its other calls are found here.
 */
const CHANNEL_WORDS: Partial<Record<NonNullable<HistoryCommand['from']>, string>> = {
  bench: ' from the bench',
  cli: ' from the CLI',
  person: ' by a person in the app',
};

/**
 * History as a list of calls, oldest first: each call in a few words with
 * what it caused counted, a run's steps under the run that took them, and a
 * connection every entry shares named once above them.
 */
export function formatHistory(
  history: HistoryCommand[],
  totalCount: number
): string {
  if (history.length === 0) {
    return getFormattedResponse('REPLAY_HISTORY_EMPTY', {});
  }
  const ordered = [...history].sort((a, b) => a.index - b.index);
  const connections = new Set(ordered.map(cmd => cmd.params?.connection).filter((c): c is string => typeof c === 'string'));
  const shared = connections.size === 1 ? [...connections][0] : undefined;

  let response = getFormattedResponse('REPLAY_HISTORY', { count: history.length, totalCount });
  if (shared) response += ` · connection ${shared}`;

  let openRun: string | undefined;
  for (const cmd of ordered) {
    const startsRun = cmd.tool === 'run' && typeof cmd.params?.name === 'string';
    if (cmd.run && cmd.run !== openRun) {
      // A run's steps with no run call above them in the list - it scrolled off, or a bench play - take a heading of their own.
      response += `\n    run ${cmd.run}`;
      openRun = cmd.run;
    } else if (!cmd.run) {
      openRun = startsRun ? String(cmd.params.name) : undefined;
    }
    const channel = cmd.from ? CHANNEL_WORDS[cmd.from] ?? '' : '';
    const elsewhere = !shared && typeof cmd.params?.connection === 'string' ? ` @${cmd.params.connection}` : '';
    const extras: string[] = [];
    if (cmd.delay) extras.push(`delay ${cmd.delay}ms`);
    if (cmd.comment) extras.push(`"${cmd.comment.length > 30 ? cmd.comment.slice(0, 30) + '…' : cmd.comment}"`);
    const head = `${cmd.run ? '        ' : '    '}#${cmd.index}  ${describeCall(cmd)}${elsewhere}${channel}${extras.length ? ` (${extras.join(', ')})` : ''}`;
    const caused = countsLine(observationsOf(cmd.index), readingConnection(cmd));
    response += `\n${caused ? `${head.padEnd(60)} ${caused}` : head}`;
  }

  response += `\n\n---\n\nCreate sequence: \`replay({ action: 'create', name: '...', indices: [${ordered.slice(-3).map(c => c.index).join(', ')}] })\``;

  return response;
}

/**
 * Format sequence created response
 */
export function formatSequenceCreated(sequence: CommandSequence): string {
  let response = getFormattedResponse('REPLAY_SEQUENCE_CREATED', {
    name: sequence.name,
    id: sequence.id,
    commandCount: sequence.commands.length
  });

  // Optional metadata
  let hasMetadata = false;
  if (sequence.description) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Description:** ${sequence.description}`;
    hasMetadata = true;
  }
  if (sequence.expectedOutcome) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Expected Outcome:** ${sequence.expectedOutcome}`;
    hasMetadata = true;
  }
  if (sequence.startUrl) {
    response += `${hasMetadata ? '\n' : '\n\n'}**Start URL:** ${sequence.startUrl}`;
    hasMetadata = true;
  }

  response += `\n\n**Commands in Sequence**\n`;
  sequence.commands.forEach((cmd, idx) => {
    response += `${idx + 1}. **${cmd.tool}**\n`;
    response += `\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });

  response += `---\n\n`;
  response += `**Run this sequence:**\n`;
  response += `\`run({ action: 'sequence', sequenceId: '${sequence.id}' })\``;

  return response;
}

/**
 * Format sequence list: the sequences in memory, then the ones on disk.
 *
 * A session starts with an empty memory, so a memory-only list reports "none"
 * while the sequences dir holds a suite - the disk sections are folded in here
 * so one call covers both.
 */
export function formatSequenceList(sequences: CommandSequence[], diskSections: string = ''): string {

  if (sequences.length === 0) {
    if (!diskSections) {
      let response = getFormattedResponse('REPLAY_SEQUENCE_LIST_EMPTY', {});
      response += `\n\n**Create a sequence:**\n`;
      response += `1. View command history: \`replay({ action: 'history' })\`\n`;
      response += `2. Create sequence: \`replay({ action: 'create', name: 'my-workflow', indices: [1, 2, 3] })\``;
      return response;
    }

    let response = getFormattedResponse('REPLAY_SEQUENCE_LIST_EMPTY', {});
    response += `\n\n${diskSections.trimEnd()}`;
    return withOnce(response, 'REPLAY_LIST_ACTIONS');
  }

  let response = getFormattedResponse('REPLAY_SEQUENCE_LIST', {
    count: sequences.length
  });

  sequences.forEach((seq, idx) => {
    const age = Math.floor((Date.now() - seq.createdAt) / 1000 / 60);
    response += `\n\n**${idx + 1}. ${seq.name}**\n`;
    response += `- **ID:** \`${seq.id}\`\n`;
    if (seq.description) {
      response += `- **Description:** ${seq.description}\n`;
    }
    if (seq.expectedOutcome) {
      response += `- **Expected Outcome:** ${seq.expectedOutcome}\n`;
    }
    if (seq.startUrl) {
      response += `- **Start URL:** ${seq.startUrl}\n`;
    }
    response += `- **Commands:** ${seq.commands.length}\n`;
    response += `- **Created:** ${age} minutes ago`;
  });

  if (diskSections) {
    response += `\n\n${diskSections.trimEnd()}`;
  }

  return withOnce(response, 'REPLAY_LIST_ACTIONS');
}

/**
 * Format sequence details
 */
export function formatSequenceDetails(sequence: CommandSequence): string {
  let response = getFormattedResponse('REPLAY_SEQUENCE_DETAILS', {
    name: sequence.name,
    commandCount: sequence.commands.length
  });

  response += `\n\n**ID:** \`${sequence.id}\``;
  if (sequence.description) {
    response += `\n**Description:** ${sequence.description}`;
  }
  if (sequence.expectedOutcome) {
    response += `\n**Expected Outcome:** ${sequence.expectedOutcome}`;
  }
  if (sequence.startUrl) {
    response += `\n**Start URL:** ${sequence.startUrl}`;
  }
  response += `\n**Created:** ${new Date(sequence.createdAt).toLocaleString()}`;

  // Show variables if any exist
  const variables = extractTextVariables(sequence.commands);
  if (Object.keys(variables).length > 0) {
    response += `\n\n**Variables (${Object.keys(variables).length}):**\n`;
    Object.entries(variables).forEach(([varName, data]) => {
      response += `- \`${varName}\`: "${data.value}"\n`;
    });
  }

  response += `\n\n**Commands**\n`;
  sequence.commands.forEach((cmd: RecordedCommand, idx: number) => {
    response += `### ${idx + 1}. ${cmd.tool}\n`;
    response += `**Parameters:**\n\`\`\`json\n${JSON.stringify(cmd.params, null, 2)}\n\`\`\`\n\n`;
  });

  response += `---\n\n`;
  response += `**Run:** \`run({ action: 'sequence', name: '${sequence.name}' })\``;

  return response;
}

export type SavedSequenceEntry = {
  filename: string;
  name: string;
  id: string;
  commandCount: number;
  description?: string;
  expectedOutcome?: string;
  startUrl?: string;
  location?: string;
  fullPath?: string;
};

export type IssueSequenceEntry = SavedSequenceEntry & {
  issueId?: number;
  issueType?: string;
  issueStatus?: string;
};

/**
 * Sections for the sequences on disk, without a footer. Empty string when
 * nothing is shown, which lets a caller drop the whole block.
 * Categories:
 * - Saved: Regular sequences in .devharness/sequences/
 * - Issues: Issue sequences that are in_progress (or all if showAll)
 * - Abandoned: Issue sequences without a linked issue (orphaned)
 *
 * A name in `inMemoryNames` is the same sequence as the in-memory entry above
 * it, tagged so the two rows are not counted as two sequences.
 */
/** One line of a disk listing: the section it stands in, its name, and its line without the number. */
export interface DiskListingEntry {
  section: 'Saved' | 'Issues' | 'Completed' | 'Abandoned';
  name: string;
  line: string;
}

const byCreation = (a: SavedSequenceEntry, b: SavedSequenceEntry) =>
  (parseInt((a.id || '').replace('seq-', ''), 10) || 0) - (parseInt((b.id || '').replace('seq-', ''), 10) || 0);

/**
 * The disk listing as entries in drawing order, and the count of issue
 * sequences it leaves out: completed and abandoned ones stand only under
 * `showAll`.
 */
export function diskListingEntries(
  sequences: SavedSequenceEntry[],
  issueSequences: IssueSequenceEntry[] = [],
  showAll: boolean = false
): { entries: DiskListingEntry[]; hidden: number } {
  // No linked issue reads as abandoned; in_progress as active; every other status as completed.
  const active = issueSequences.filter(seq => seq.issueId && seq.issueStatus === 'in_progress');
  const completed = issueSequences.filter(seq => seq.issueId && seq.issueStatus !== 'in_progress');
  const abandoned = issueSequences.filter(seq => !seq.issueId);
  const issueLine = (seq: IssueSequenceEntry) => `[${seq.issueType} #${seq.issueId} - ${seq.issueStatus}] ${seq.name} (${seq.commandCount})`;
  const byIssue = (a: IssueSequenceEntry, b: IssueSequenceEntry) => (a.issueId || 0) - (b.issueId || 0);

  const entries: DiskListingEntry[] = [
    ...[...sequences].sort(byCreation).map(seq => ({
      section: 'Saved' as const, name: seq.name, line: `${seq.name} (${seq.commandCount})${seq.location === 'global' ? ' [global]' : ''}`,
    })),
    ...[...active].sort(byIssue).map(seq => ({ section: 'Issues' as const, name: seq.name, line: issueLine(seq) })),
    ...(showAll ? [...completed].sort(byIssue).map(seq => ({ section: 'Completed' as const, name: seq.name, line: issueLine(seq) })) : []),
    ...(showAll ? [...abandoned].sort(byCreation).map(seq => ({ section: 'Abandoned' as const, name: seq.name, line: `${seq.name} (${seq.commandCount})` })) : []),
  ];
  return { entries, hidden: showAll ? 0 : completed.length + abandoned.length };
}

/** The disk listing drawn in full, one numbered list per section. */
export function formatDiskListing(
  { entries, hidden }: { entries: DiskListingEntry[]; hidden: number },
  inMemoryNames: Set<string> = new Set()
): string {
  let response = '';
  for (const section of ['Saved', 'Issues', 'Completed', 'Abandoned'] as const) {
    const lines = entries.filter(entry => entry.section === section);
    if (lines.length === 0) continue;
    if (response) response += '\n';
    response += `**${section}** (${lines.length})\n`;
    lines.forEach((entry, idx) => {
      const memoryTag = section === 'Saved' && inMemoryNames.has(entry.name) ? ' [in memory]' : '';
      response += `${idx + 1}. ${entry.line}${memoryTag}\n`;
    });
  }
  if (hidden > 0) {
    response += `\n_${hidden} other sequence(s) hidden. Use showAll: true to see all._\n`;
  }
  return response;
}

/** The key two listings compare an entry by: its section and its name. */
export function diskListingKey(entry: DiskListingEntry): string {
  return `${entry.section}\u0000${entry.name}`;
}

/**
 * The disk listing as the lines that differ from an earlier listing of the
 * same session, whose full text stands earlier in that session's context: an
 * entry added (+), one gone (−), one whose line changed (~, old → new).
 */
export function formatDiskListingChanges(before: Map<string, DiskListingEntry>, entries: DiskListingEntry[]): string {
  const now = new Map(entries.map(entry => [diskListingKey(entry), entry]));
  const where = (entry: DiskListingEntry) => (entry.section === 'Saved' ? '' : `${entry.section}: `);
  const changes: string[] = [];
  for (const [key, entry] of now) {
    const earlier = before.get(key);
    if (!earlier) changes.push(`+ ${where(entry)}${entry.line}`);
    else if (earlier.line !== entry.line) changes.push(`~ ${where(entry)}${earlier.line} → ${entry.line}`);
  }
  for (const [key, entry] of before) {
    if (!now.has(key)) changes.push(`− ${where(entry)}${entry.line}`);
  }
  const counts = (['Saved', 'Issues', 'Completed', 'Abandoned'] as const)
    .map(section => [section, entries.filter(entry => entry.section === section).length] as const)
    .filter(([, count]) => count > 0)
    .map(([section, count]) => `${count} ${section.toLowerCase()}`)
    .join(', ') || 'none on disk';
  if (changes.length === 0) {
    return `**On disk:** ${counts}, unchanged since the full list earlier in this session. \`full: true\` prints it again.\n`;
  }
  return `**On disk:** ${counts}. ${changes.length} change(s) since the last listing; the full list stands earlier in this session, and \`full: true\` prints it again.\n${changes.join('\n')}\n`;
}

/** The saved sequences listing, from its disk sections drawn in full or as changes. */
export function formatSavedSequencesList(sections: string): string {
  if (!sections) {
    return getFormattedResponse('REPLAY_SAVED_EMPTY', {});
  }

  return withOnce(sections.trimEnd(), 'REPLAY_LIST_ACTIONS');
}

// =============================================================================
// Status & Step Formatting
// =============================================================================

/**
 * Format active sequence status
 */
export function formatActiveStatus(
  activeSeq: ActiveSequenceState,
  commandsSincePause: HistoryCommand[]
): string {
  const pausedDuration = Math.round((Date.now() - activeSeq.pausedAt) / 1000);

  let response = getFormattedResponse('REPLAY_ACTIVE_STATUS', {
    sequenceName: activeSeq.sequenceName,
    nextStep: activeSeq.currentStep + 1,
    totalSteps: activeSeq.totalSteps
  });

  response += `\n\n**Connection:** ${activeSeq.connection || 'none'}`;
  response += `\n**Paused for:** ${pausedDuration}s`;

  if (commandsSincePause.length > 0) {
    response += `\n\n**Commands Since Pause (${commandsSincePause.length})**\n`;
    commandsSincePause.forEach((cmd, idx) => {
      response += `${idx + 1}. [#${cmd.index}] **${cmd.tool}**\n`;
    });
  }

  response += `\n---\n\n**Actions**\n`;
  response += `- Continue: \`run({ action: 'step' })\`\n`;
  response += `- Finish all: \`run({ action: 'finish' })\`\n`;
  if (commandsSincePause.length > 0) {
    response += `- Insert commands: \`replay({ action: 'insert' })\`\n`;
  }

  return response;
}

/**
 * Format step execution results
 */
export function formatStepResults(
  sequenceName: string,
  results: StepResult[],
  startStep: number,
  totalCommands: number,
  failed: boolean
): string {
  let response: string;

  if (failed) {
    const failedResult = results.find(r => !r.success)!;
    response = getFormattedResponse('REPLAY_STEP_FAILED', {
      sequenceName,
      failedStep: failedResult.step,
      failedTool: failedResult.tool
    });
    response += `\n\n**Error:** ${failedResult.error}`;
    response += `\n\nSequence cancelled due to error.`;
  } else {
    const lastExecuted = results.length > 0 ? results[results.length - 1].step : startStep;
    const remaining = totalCommands - lastExecuted;

    if (lastExecuted >= totalCommands) {
      response = getFormattedResponse('REPLAY_STEP_COMPLETE', {
        sequenceName,
        total: totalCommands
      });
    } else {
      response = getFormattedResponse('REPLAY_STEP_SUCCESS', {
        sequenceName,
        stepCount: results.length,
        remaining
      });

      response += `\n\n**Executed Steps**\n`;
      results.forEach(r => {
        response += `${r.step}. **${r.tool}** ✓\n`;
      });

      response += `\n---\n\n**Actions**\n`;
      response += `- Continue: \`run({ action: 'step' })\`\n`;
      response += `- Finish all: \`run({ action: 'finish' })\`\n`;
    }
  }

  return response;
}

// =============================================================================
// Recorded Event Formatting
// =============================================================================

/** HH:MM:SS of an event timestamp, used as the per-event time marker. */
function eventTime(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[1].split('.')[0];
}

/** `tag#id` / `tag` description of a keyboard or paste target. */
function describeTarget(targetInfo?: { tag: string; id?: string; isInput?: boolean; selector?: string }): string[] {
  if (!targetInfo) return [];
  const lines = [`Target: \`${targetInfo.tag}${targetInfo.id ? '#' + targetInfo.id : ''}\``];
  if (targetInfo.selector) {
    lines.push(`Selector: \`${targetInfo.selector}\` ✓`);
  }
  if (targetInfo.isInput) {
    lines.push(`Type: **Input field**`);
  }
  return lines;
}

/**
 * Format recorded input events for human review.
 *
 * This is the `outputFormat: 'review'` implementation - a readable walk of what
 * the recorder actually captured, showing both the coordinates and the selector
 * it found for each interaction so a human can judge which one a command should
 * use. Noise (mousemove, keyup) is dropped; every other event variant -
 * including navigation, paste and comment events - gets its own entry.
 */
export function formatEventsForReview(events: InputEvent[]): string {
  const lines: string[] = [];
  let eventNum = 0;

  for (const event of events) {
    // Comments the person typed during the recording - the most valuable
    // context in a review dump, so they are never dropped.
    if (isCommentEvent(event)) {
      eventNum++;
      const category = event.category || 'narrative';
      const label = category === 'bug' ? 'COMMENT (BUG)'
        : category === 'feature' ? 'COMMENT (FEATURE)'
        : 'COMMENT';
      lines.push(`### ${eventNum}. ${label}`);
      lines.push(`Time: ${eventTime(event.timestamp)}`);
      lines.push(`Note: "${event.text}"`);
      if (event.attachedToEventIndex !== undefined) {
        lines.push(`Attached to event index: ${event.attachedToEventIndex}`);
      }
      lines.push('');
      continue;
    }

    // Page navigations / reloads that happened mid-recording.
    if (isNavigationEvent(event)) {
      eventNum++;
      lines.push(`### ${eventNum}. ${event.type.toUpperCase()} to ${event.url}`);
      lines.push(`Time: ${eventTime(event.timestamp)}`);
      if (event.previousUrl) {
        lines.push(`From: ${event.previousUrl}`);
      }
      lines.push('');
      continue;
    }

    // Pasted text - the text matters more than the keystrokes that triggered it.
    if (isPasteEvent(event)) {
      eventNum++;
      const text = event.text.length > 60 ? event.text.substring(0, 57) + '...' : event.text;
      lines.push(`### ${eventNum}. PASTE`);
      lines.push(`Time: ${eventTime(event.timestamp)}`);
      lines.push(`Text: "${text}" (${event.text.length} chars)`);
      lines.push(...describeTarget(event.targetInfo));
      lines.push('');
      continue;
    }

    if (isKeyboardEvent(event)) {
      // Skip keyup for review
      if (event.type === 'keyup') continue;

      eventNum++;

      let keyDisplay = event.key;
      if (event.modifiers) {
        const mods: string[] = [];
        if (event.modifiers.ctrl) mods.push('Ctrl');
        if (event.modifiers.alt) mods.push('Alt');
        if (event.modifiers.shift) mods.push('Shift');
        if (event.modifiers.meta) mods.push('Cmd');
        if (mods.length > 0) keyDisplay = mods.join('+') + '+' + keyDisplay;
      }

      lines.push(`### ${eventNum}. KEY \`${keyDisplay}\``);
      lines.push(`Time: ${eventTime(event.timestamp)}`);
      lines.push(...describeTarget(event.targetInfo));
      lines.push('');
      continue;
    }

    if (!isMouseEvent(event)) continue;

    // Skip pure mousemove events for review (too noisy)
    if (event.type === 'mousemove') continue;

    eventNum++;
    const coords = `(${event.x}, ${event.y})`;
    const el = event.elementInfo;

    lines.push(`### ${eventNum}. ${event.type.toUpperCase()} at ${coords}`);
    lines.push(`Time: ${eventTime(event.timestamp)}`);

    if (el) {
      lines.push(`Element: \`${el.tag}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}\``);

      if (el.selector) {
        lines.push(`Selector: \`${el.selector}\` ✓`);
      } else {
        lines.push(`Selector: *(none available)*`);
      }

      if (el.isCanvas) {
        lines.push(`Type: **Canvas/3D** - use coordinates`);
      } else if (el.isInteractive) {
        lines.push(`Type: **Interactive** - selector recommended`);
      }

      if (el.text) {
        lines.push(`Text: "${el.text.substring(0, 40)}${el.text.length > 40 ? '...' : ''}"`);
      }

      if (el.boundingBox) {
        const bb = el.boundingBox;
        lines.push(`Bounds: ${bb.width}x${bb.height} at (${bb.x}, ${bb.y})`);
      }
    }

    if (event.type === 'wheel') {
      lines.push(`Scroll: deltaX=${event.deltaX || 0}, deltaY=${event.deltaY || 0}`);
    }

    lines.push('');
  }

  if (eventNum === 0) {
    return '_No reviewable events were captured._';
  }

  return lines.join('\n');
}

// =============================================================================
// Insert Formatting
// =============================================================================

/**
 * Format insert prompt (when no indices provided)
 */
export function formatInsertPrompt(
  sequenceName: string,
  commandsSincePause: HistoryCommand[],
  currentStep: number,
  totalSteps: number
): string {
  if (commandsSincePause.length === 0) {
    return getFormattedResponse('REPLAY_NO_COMMANDS_SINCE_PAUSE', {});
  }

  let response = getFormattedResponse('REPLAY_INSERT_PROMPT', {
    sequenceName,
    commandCount: commandsSincePause.length
  });

  response += `\n\n**Commands recorded since pause:**\n`;
  commandsSincePause.forEach((cmd) => {
    response += `- [#${cmd.index}] **${cmd.tool}**`;
    if (cmd.params && Object.keys(cmd.params).length > 0) {
      const paramStr = JSON.stringify(cmd.params);
      response += ` - ${paramStr.length > 50 ? paramStr.slice(0, 50) + '...' : paramStr}`;
    }
    response += `\n`;
  });

  response += `\n**Current position:** After step ${currentStep} of ${totalSteps}`;

  response += `\n\n**Insert Options**\n\n`;
  response += `**Insert all commands:**\n`;
  response += `\`\`\`\nreplay({ action: 'insert', insertIndices: [${commandsSincePause.map(c => c.index).join(', ')}], overwrite: true })\n\`\`\`\n\n`;
  response += `**Or select specific indices and optionally save as new sequence:**\n`;
  response += `\`\`\`\nreplay({ action: 'insert', insertIndices: [${commandsSincePause[0]?.index || 0}], newName: 'updated-sequence' })\n\`\`\`\n`;

  return response;
}

/**
 * Format insert result
 */
export function formatInsertResult(
  sequenceName: string,
  sequenceId: string,
  insertedCount: number,
  insertAfter: number,
  newTotal: number,
  isOverwrite: boolean
): string {
  let response: string;

  if (isOverwrite) {
    response = getFormattedResponse('REPLAY_INSERT_SUCCESS', {
      sequenceName,
      insertedCount,
      insertAfter
    });
    response += `\n\n**New total:** ${newTotal} commands`;
  } else {
    response = getFormattedResponse('REPLAY_INSERT_NEW', {
      sequenceName,
      insertedCount
    });
    response += `\n\n**Inserted after step:** ${insertAfter}`;
    response += `\n**Total commands:** ${newTotal}`;
  }

  // `export` is the action that writes a sequence to disk.
  response += `\n\nSave to disk: \`replay({ action: 'export', sequenceId: '${sequenceId}' })\``;
  return response;
}

/**
 * Format the result of adding a `check` step.
 */
export function formatCheckAdded(info: {
  sequenceName: string;
  subject: string;
  holds?: string | { run: string; resumeAt?: number };
  fails?: string | { run: string; resumeAt?: number };
  position: number;
  totalSteps: number;
  persistedTo?: string;
}): string {
  const said = (outcome: string | { run: string; resumeAt?: number }) => typeof outcome === 'string'
    ? outcome
    : `run \`${outcome.run}\`${outcome.resumeAt !== undefined ? `, then resume at step ${outcome.resumeAt + 1}` : ''}`;
  const lines = [
    `**Check added to "${info.sequenceName}"**`,
    '',
    `- **Step ${info.position + 1}** of ${info.totalSteps}`,
    `- **Reads:** \`${info.subject}\``,
    `- **On pass:** ${said(info.holds ?? 'continue')}`,
    `- **On fail:** ${said(info.fails ?? 'stop')}`,
  ];

  lines.push('');
  if (info.persistedTo) {
    lines.push(`Saved to \`${info.persistedTo}\`.`);
  } else {
    lines.push(`In memory only - save with \`replay({ action: 'export', name: '${info.sequenceName}' })\`.`);
  }

  return lines.join('\n');
}

/**
 * What a sequence now declares, after `declare` has set it.
 *
 * Reads back the whole statement rather than just the change: each list
 * replaces its field, so "what does this sequence declare now" is the only
 * question the caller can act on.
 */
/** What a notifying pause point tells the session: its note, or that none was given. */
export function formatPauseNote(step: number, note: string | undefined, notify?: boolean): string {
  if (note) return `\n\n**To carry out before step ${step}:** ${note}\n\nThen resume: \`run({ action: 'finish' })\``;
  if (!notify) return '';
  return `\n\n**This pause point notifies the session before step ${step}, with no reason given.** Ask the person why the run stops here, then resume: \`run({ action: 'finish' })\``;
}

export function formatDeclarations(sequence: CommandSequence, persistedTo?: string): string {
  const connections = sequence.requiredConnections ?? [];
  const sockets = sequence.requiredSockets ?? [];
  const lines = [`**"${sequence.name}" declares**`, ''];

  lines.push(sequenceNeedsProxy(sequence)
    ? `- **Proxy:** needed${sequence.proxy ? '' : ' - its traffic checks or boundary rules read the proxy'}; a run on a connection outside it plays in a proxied window it opens`
    : '- **Proxy:** not needed');

  if (connections.length === 0) {
    lines.push('- **Browsers:** none - the run brings up only its own connection');
  } else {
    lines.push('- **Browsers:**');
    for (const decl of connections) {
      const notes = [
        decl.profile ? `profile \`${decl.profile}\`` : null,
        decl.role,
        decl.url ? `opens ${decl.url}` : null,
        decl.profile && decl.forceNewInstance !== true ? 'reuses the Chrome already on that profile' : null,
        !decl.profile && decl.forceNewInstance === false ? 'may share an existing browser' : null,
        decl.proxy ? 'launched through the proxy' : null,
      ].filter(Boolean);
      lines.push(`  - \`${decl.connection}\`${notes.length ? ` - ${notes.join('; ')}` : ''}`);
    }
  }

  lines.push(sockets.length === 0
    ? '- **Sockets:** none declared - socket health is only checked when a run asks for it'
    : `- **Sockets:** ${sockets.map(s => `\`${s}\``).join(', ')} - checked on every run, without asking`);

  lines.push(`- **Hold threshold:** ${sequence.holdThresholdMs ?? DEFAULT_HOLD_THRESHOLD_MS}ms${sequence.holdThresholdMs === undefined ? ' (default)' : ''} - a recorded click or tap pressed this long or longer replays held for its recorded length`);

  const tags = sequence.tags ?? [];
  lines.push(tags.length === 0
    ? "- **Tags:** none - it runs in every `runAll`, and counts as untagged in the summary split"
    : `- **Tags:** ${tags.map(t => `\`${t}\``).join(', ')} - selectable with \`run({ action: 'all', tags: [...] })\``);

  lines.push('');
  lines.push(persistedTo
    ? `Saved to \`${persistedTo}\`.`
    : `In memory only - save with \`replay({ action: 'export', name: '${sequence.name}' })\`.`);

  if (connections.some(d => d.profile)) {
    lines.push('A profile-bearing reference cannot be rebound with `connections` at run time: the profile is the identity, and pointing it at another browser would pass while testing the wrong one.');
  }

  return lines.join('\n');
}
