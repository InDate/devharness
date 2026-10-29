/**
 * A run's reply, read off History: one row per step, giving its position in
 * History, its outcome, how its crossings matched the recording, and what it
 * caused.
 *
 * Read from History rather than from the executor's results, so a plain run,
 * a bench play and a step-through reply with the same rows, and a row's
 * History position leads to everything the reply leaves out.
 */
import type { CommandRecorder, HistoryCommand, StepMatch } from '../command-recorder.js';
import { activityOf, countsOf, eventsOf, type ActivityCounts } from '../activity-index.js';
import type { Crossing } from '../bench/step-compare.js';
import type { ProxyEvent } from '../proxy/intercept-proxy.js';
import type { ExecutionResult } from './replay-types.js';
import { describePersonInput } from '../person-watch.js';
import { ruleOn, type RunRule, type RunRules } from './run-rules.js';
import { stepReply } from './replay-history.js';
import { foreignTo, linesOf, observationsOf, type Observation, type ObservationLine } from '../observation-log.js';
import { CARRIER } from '../write-watch.js';
import { describeCall, readingConnection } from './history-activity.js';

export interface RunReplyInput {
  name: string;
  /** Steps in the sequence. */
  total: number;
  /** History index before the run's first step; rows are read from after it. */
  since: number;
  /** 'all' lists every row; omitted, only the failed and mismatched ones. */
  steps?: 'all';
  /** Why a step failed, by 1-based step, where the caller holds it. */
  failures?: Map<number, string>;
  /** The run stopped part-way and can carry on: steps after it are remaining rather than not run. */
  paused?: boolean;
  /** The rules acting on the run's traffic; absent, the reply lists none. */
  rules?: RunRules;
  /** What crossed in each pause, by the 0-based step it stood before; no History entry holds it. */
  pauses?: Map<number, Crossing[]>;
  /** A person's input that landed on the run's page between steps. */
  person?: ExecutionResult['personInput'];
  /** false for a play that takes the baseline: compared with the one it replaces, every change would read as a mismatch. */
  compare?: boolean;
}

/**
 * The {{env:}} names the run's steps resolved, by the file each came from. A
 * value read from a file no call named - `.devharness/sequences.env` - would
 * otherwise reach the page with nothing in the output to show where it came from.
 */
function envLines(rows: Row[]): string[] {
  const byFile = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.command.env) continue;
    const names = byFile.get(row.command.env.file) ?? new Set<string>();
    for (const name of row.command.env.names) names.add(name);
    byFile.set(row.command.env.file, names);
  }
  return [...byFile].map(([file, names]) => `{{env:}} from ${file}: ${[...names].sort().join(', ')}`);
}

const ACTED: Record<RunRule['verb'], string> = { ignore: 'ignored', answer: 'answered', block: 'blocked', refuse: 'refused', scope: 'out of scope' };

interface Row {
  label: string;
  step: number;
  command: HistoryCommand;
  outcome: 'passed' | 'failed' | 'continued' | 'running';
  match?: StepMatch;
}

function outcomeOf(command: HistoryCommand): Row['outcome'] {
  if (command.stepFailed || command.result?.isError === true) return 'failed';
  if (command.result === undefined) return 'running';
  // A check whose `fails` carried the run on still failed: read as passed,
  // its answer would reach no reader of the run.
  return checkOf(command)?.outcome === 'failed' ? 'continued' : 'passed';
}

/** A check step's reading, as the check tool recorded it on its result. */
function checkOf(command: HistoryCommand): { outcome?: string; subject?: string; found?: string } | undefined {
  return command.tool === 'check' ? (command.result as any)?._meta?.check : undefined;
}

/** Each rule that acted on these crossings, with how many it acted on. */
function actedOn(events: Crossing[], rules: RunRules | undefined): Map<RunRule, number> {
  const acted = new Map<RunRule, number>();
  if (!rules) return acted;
  for (const event of events) {
    const rule = ruleOn(rules, event as ProxyEvent);
    if (rule) acted.set(rule, (acted.get(rule) ?? 0) + 1);
  }
  return acted;
}

/** The counts History shows for an entry, or for a pause's crossings, which no entry holds. */
function countsFor(source: number | Crossing[], reading?: string): ActivityCounts {
  if (typeof source === 'number') return countsOf(activityOf(source, reading));
  return {
    requests: source.filter(event => event.kind === 'request').length,
    failed: source.filter(event => event.kind === 'request' && (event.status ?? 0) >= 400).length,
    frames: source.filter(event => event.kind === 'frame').length,
    writes: source.filter(event => event.kind === 'write').length,
  };
}

function crossingsFor(source: number | Crossing[]): Crossing[] {
  return typeof source === 'number' ? eventsOf(source) : source;
}

function causedBy(source: number | Crossing[], rules: RunRules | undefined, reading?: string): string {
  const counts = countsFor(source, reading);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const caused = [
    counts.requests ? `${plural(counts.requests, 'request')}${counts.failed ? ` (${counts.failed} failed)` : ''}` : '',
    counts.frames ? plural(counts.frames, 'frame') : '',
    counts.writes ? plural(counts.writes, 'write') : '',
  ].filter(Boolean).join(', ');
  const byVerb = new Map<string, number>();
  for (const [rule, n] of actedOn(crossingsFor(source), rules)) byVerb.set(ACTED[rule.verb], (byVerb.get(ACTED[rule.verb]) ?? 0) + n);
  const acted = [...byVerb].map(([verb, n]) => `${n} ${verb}`).join(', ');
  return acted ? `${caused}: ${acted}` : caused;
}

/**
 * A line as the caused column names it. A transform's matrix values run past
 * the column and read as noise there, so its line keeps the duration and the
 * frames; the values stay on the line its id looks up.
 */
function headlineText({ observation: one, count }: ObservationLine, reading: string | undefined): string {
  const motion = one.motion;
  const matrix = motion && !motion.set && motion.frames !== undefined && [motion.from, motion.to].some(value => value?.startsWith('matrix'));
  const text = matrix
    ? `${one.key}  ${CARRIER[motion.type]} over ${Math.round(motion.durationMs)}ms${motion.frames ? `, ${motion.frames} frame${motion.frames === 1 ? '' : 's'}` : ''}`
    : one.text;
  const foreign = foreignTo(one, reading);
  return `${count > 1 ? `${text} ×${count}` : text}${foreign ? ` on ${foreign}` : ''}`;
}

/**
 * What a step caused in one line, cut to `most` lines. A library's one-frame
 * sets come first in time and would push the motion behind `+N more`, so they
 * are counted in one tag after it.
 */
function headlineOf(observations: Observation[], most: number, reading: string | undefined): string {
  const lines = linesOf(observations);
  const sets = lines.filter(line => line.observation.motion?.set).reduce((n, line) => n + line.count, 0);
  const rest = lines.filter(line => !line.observation.motion?.set);
  const named = rest.slice(0, most).map(line => headlineText(line, reading));
  const more = rest.length - named.length;
  return [named.join('; ') + (more > 0 ? `; +${more} more` : ''), sets ? `${sets} set` : ''].filter(Boolean).join(' · ');
}

/** What a step caused, named and folded from the observation log, with what the run's rules did to it. */
function causedNamed(index: number, rules: RunRules | undefined, reading: string | undefined): string {
  const observations = observationsOf(index);
  if (observations.length === 0) return causedBy(index, rules, reading);
  const byVerb = new Map<string, number>();
  for (const [rule, n] of actedOn(crossingsFor(index), rules)) byVerb.set(ACTED[rule.verb], (byVerb.get(ACTED[rule.verb]) ?? 0) + n);
  const acted = [...byVerb].map(([verb, n]) => `${n} ${verb}`).join(', ');
  return `${headlineOf(observations, 3, reading).replace(/\|/g, '\\|')}${acted ? `: ${acted}` : ''}`;
}

/** Steps that read the page and act on nothing, so no motion stops because of them. */
const READS_ONLY = new Set(['check', 'wait', 'assert']);

/**
 * Frame loops whose last frame fell between the start of the step before a
 * row and the row's own start, with no motion of the same key begun after it.
 * A loop a press stops draws its last frame before the press, so the stop
 * lands in no step's window; the row states the gap and credits no step. A
 * step that only reads the page takes no such row: a loop that ended before
 * it ended on its own.
 */
function endsBefore(rows: Row[]): Map<Row, string> {
  const motions = rows.flatMap(row => observationsOf(row.command.index)).filter(one => one.motion?.frames !== undefined && !one.motion.set);
  const ends = new Map<Row, string>();
  rows.forEach((row, i) => {
    if (i === 0 || READS_ONLY.has(row.command.tool) || observationsOf(row.command.index).length > 0) return;
    const from = rows[i - 1].command.timestamp;
    const to = row.command.timestamp;
    const lines = motions.flatMap(one => {
      const end = one.at + one.motion!.durationMs;
      if (end <= from || end >= to) return [];
      if (motions.some(next => next.key === one.key && next.connection === one.connection && next.at > end && next.at < to)) return [];
      const foreign = foreignTo(one, readingConnection(row.command));
      return [`${one.key}  last frame ${Math.round(to - end)}ms before this step, not tied to it by time (${one.id})${foreign ? ` on ${foreign}` : ''}`];
    });
    if (lines.length) ends.set(row, lines.join('; ').replace(/\|/g, '\\|'));
  });
  return ends;
}

function secs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function firstLine(command: HistoryCommand): string | undefined {
  const text = command.result?.content?.find((part: any) => part?.type === 'text')?.text as string | undefined;
  return text?.split('\n').map(line => line.replace(/\*\*/g, '').trim()).find(Boolean);
}

/** The rows for the run's steps recorded after `since`, a nested run's steps numbered under the step that ran them. */
function rowsOf(recorder: CommandRecorder, name: string, since: number): Row[] {
  const recorded = recorder.getHistory(Number.MAX_SAFE_INTEGER)
    .filter(command => command.index > since && command.run !== undefined)
    .reverse();
  const rows: Row[] = [];
  let parent: number | undefined;
  for (const command of recorded) {
    const own = command.run === name;
    const position = (command.runStep ?? 0) + 1;
    if (own) parent = position;
    rows.push({
      label: own || parent === undefined ? String(position) : `${parent}.${position}`,
      step: own ? position : parent ?? position,
      command,
      outcome: outcomeOf(command),
      ...(command.stepMatch ? { match: command.stepMatch } : {}),
    });
  }
  return rows;
}

/** Each person's input the run met, and what the run did about it. */
function personNotes(person: RunReplyInput['person']): string[] {
  if (!person) return [];
  return person.landed.map(({ before, inputs }) => {
    const what = `${inputs.map(describePersonInput).join(', ')} (History ${inputs.map(input => `#${input.index}`).join(', ')})`;
    const did = person.mode === 'pause' && person.pausedBefore === before
      ? `the run is held before step ${before + 1}${person.held?.length ? `, with the page's ${person.held.join(', ')} held` : ''}; \`run step\` or \`finish\` releases ${person.held?.length ? 'them' : 'it'} and carries on, \`cancel\` releases ${person.held?.length ? 'them' : 'it'} and ends the run`
      : person.mode === 'stop' ? `the run stopped before step ${before + 1}`
      : `the run carried on from step ${before + 1}`;
    return `Person: ${what} landed before step ${before + 1}; ${did}`;
  });
}

const arriving = (kind: { reasons: string[] }) => kind.reasons.length === 1 && kind.reasons[0] === 'still arriving';
const mismatched = (row: Row) => (row.match?.unmatched.some(kind => !arriving(kind)) ?? false);
const stillArriving = (row: Row) => (row.match?.unmatched.some(arriving) ?? false);

/** Each rule acting on the run, with the steps it acted at; empty where no rule acts. */
function rulesBlock(rows: Row[], rules: RunRules | undefined, pauses: Map<number, Crossing[]>): string {
  if (!rules?.rules.length) return '';
  const at = new Map<RunRule, Array<[string, number]>>();
  const tally = (label: string, events: Crossing[]) => {
    for (const [rule, n] of actedOn(events, rules)) {
      const steps = at.get(rule) ?? [];
      steps.push([label, n]);
      at.set(rule, steps);
    }
  };
  for (const row of rows) tally(`step ${row.label}`, eventsOf(row.command.index));
  for (const [before, events] of [...pauses].sort(([a], [b]) => a - b)) tally(`paused before ${before + 1}`, events);
  const lines = rules.rules.map(rule => {
    const steps = at.get(rule);
    const acted = steps?.length ? steps.map(([label, n]) => `${label}: ${n}`).join(', ')
      : 'never fired';
    return `| ${rule.label.replace(/\|/g, '\\|')} | ${rule.verb} | ${rule.from} | ${acted} |`;
  });
  return `Rules\n| rule | verb | from | acted |\n|---|---|---|---|\n${lines.join('\n')}`;
}

export function formatRunReply(recorder: CommandRecorder, input: RunReplyInput): string {
  const rows = rowsOf(recorder, input.name, input.since)
    .map(row => (input.compare === false ? { ...row, match: undefined } : row));
  const own =rows.filter(row => !row.label.includes('.'));
  const reached = own.reduce((most, row) => Math.max(most, row.step), 0);
  const failedRow = rows.find(row => row.outcome === 'failed');
  // A step that failed before its call was recorded has no row; its reason comes from the executor alone.
  const unrecorded = [...(input.failures ?? [])].filter(([step]) => !own.some(row => row.step === step));
  const failedAt = failedRow?.step ?? unrecorded[0]?.[0];
  const passed = own.filter(row => row.outcome === 'passed').length;
  const continued = own.filter(row => row.outcome === 'continued').length;
  const mismatches = rows.filter(mismatched).length;
  const arrivingSteps = rows.filter(stillArriving).length;
  const compared = rows.some(row => row.match?.kinds);
  const left = input.total - Math.max(reached, ...[...(input.failures?.keys() ?? [])]);

  const head = failedAt !== undefined
    ? `${input.name} failed at step ${failedAt} of ${input.total}`
    : left === 0 ? `${input.name} completed ${reached} of ${input.total}`
    : input.paused ? `${input.name} at step ${reached} of ${input.total}`
    : `${input.name} stopped at step ${reached} of ${input.total}`;
  const tally = [
    `${passed} passed`,
    continued ? `${continued} check${continued === 1 ? '' : 's'} failed and continued` : '',
    mismatches ? `${mismatches} mismatched` : compared && !arrivingSteps ? 'all matched' : '',
    arrivingSteps ? `${arrivingSteps} still arriving` : '',
    left > 0 ? `${left} ${input.paused && failedAt === undefined ? 'remaining' : 'not run'}` : '',
  ].filter(Boolean);
  let reply = [head, ...tally].join(' · ');
  for (const line of envLines(rows)) reply += `\n${line}`;
  const unrecordedNotes = unrecorded.map(([step, why]) => `Step ${step}: ${why}`);

  const pauses = input.pauses ?? new Map<number, Crossing[]>();
  const ruled = rulesBlock(rows, input.rules, pauses);
  // A step that caused something is part of what the run did; one that caused
  // nothing and matched is listed only when every step is asked for.
  const ended = endsBefore(rows);
  const listed = input.steps === 'all' ? rows : rows.filter(row => row.outcome === 'failed' || row.outcome === 'continued' || mismatched(row) || stillArriving(row) || observationsOf(row.command.index).length > 0 || ended.has(row));
  // Every step the run took is accounted for: those left out of the table are named.
  const unlisted = input.steps === 'all' ? [] : rows.filter(row => !listed.includes(row));
  const unlistedLine = unlisted.length
    ? `not listed (nothing caused): ${unlisted.map(row => row.label).join(', ')} · ${[...new Set(unlisted.map(row => describeCall(row.command).split(' ')[0]))].join(', ')}`
    : '';
  if (listed.length === 0) {
    return [reply, unlistedLine, [...unrecordedNotes, ...personNotes(input.person)].join('\n'), ruled].filter(Boolean).join('\n\n');
  }

  reply += '\n\n| step | history | outcome | matched | caused |\n|---|---|---|---|---|';
  // A pause is listed where it stood, between the step before it and the one it resumed at.
  const pauseRows = input.steps === 'all' ? [...pauses].sort(([a], [b]) => a - b) : [];
  const pauseRow = ([before, events]: [number, Crossing[]]) => `\n| paused before ${before + 1} | — | | | ${causedBy(events, input.rules)} |`;
  for (const row of listed) {
    while (pauseRows.length && !row.label.includes('.') && pauseRows[0][0] + 1 <= row.step) reply += pauseRow(pauseRows.shift()!);
    const nested = row.command.run !== input.name ? ` (${row.command.run})` : '';
    reply += `\n| ${row.label} ${describeCall(row.command)}${nested} | #${row.command.index} | ${row.outcome} | ${row.match?.noBaseline ? 'no baseline' : row.match?.kinds ? `${row.match.matched}/${row.match.kinds}` : ''} | ${ended.get(row) ?? causedNamed(row.command.index, input.rules, readingConnection(row.command))} |`;
  }
  for (const pause of pauseRows) reply += pauseRow(pause);
  if (input.steps === 'all' && left > 0) {
    reply += `\n| ${reached + 1 === input.total ? input.total : `${reached + 1}–${input.total}`} | — | ${input.paused && failedAt === undefined ? 'remaining' : 'not run'} | | |`;
  }

  if (unlistedLine) reply += `\n\n${unlistedLine}`;

  const notes: string[] = [...unrecordedNotes];
  for (const row of listed) {
    if (mismatched(row)) {
      const kinds = row.match!.unmatched.filter(kind => !arriving(kind)).map(kind => `${kind.kind} ${kind.reasons.join(', ')}`).join('; ');
      const held = row.match!.heldMs ? ` (held ${secs(row.match!.heldMs.recorded)} recording, ${secs(row.match!.heldMs.replayed)} replaying)` : '';
      notes.push(`Step ${row.label} unmatched: ${kinds}${held}`);
    }
    if (stillArriving(row)) {
      const kinds = row.match!.unmatched.filter(arriving).map(kind => kind.kind).join('; ');
      notes.push(`Step ${row.label} still arriving, its roots not settled when the run ended: ${kinds}; the bench matches it again as they settle`);
    }
    if (row.outcome === 'failed') {
      const why = (row.label.includes('.') ? undefined : input.failures?.get(row.step)) ?? firstLine(row.command);
      if (why) notes.push(`Step ${row.label}: ${why}`);
    }
    if (row.outcome === 'continued') {
      const check = checkOf(row.command)!;
      notes.push(`Step ${row.label}: check failed, run continued: ${check.subject ?? ''}${check.found ? ` - found ${check.found}` : ''}`);
    }
  }
  notes.push(...personNotes(input.person));
  if (notes.length) reply += `\n\n${notes.join('\n')}`;

  if (ruled) reply += `\n\n${ruled}`;
  return reply;
}

/**
 * The reply to steps written into a run call: a head line, then one line per
 * step - its history index, what it called, and its reply's first line, an
 * `inspect` or `check` reading whole, a failed step's reason. Steps written
 * into the call have no recording to compare with, so the table of matches,
 * rules and pauses a saved run's reply carries has nothing to show.
 */
export function formatStepsReply(recorder: CommandRecorder, input: Pick<RunReplyInput, 'name' | 'total' | 'since' | 'failures'>): string {
  const rows = rowsOf(recorder, input.name, input.since);
  const failed = rows.find(row => row.outcome === 'failed');
  const unrecorded = [...(input.failures ?? [])].find(([step]) => !rows.some(row => row.step === step));
  const reached = rows.reduce((most, row) => Math.max(most, row.step), 0);
  const head = failed ? `Failed at step ${failed.label} of ${input.total}`
    : unrecorded ? `Failed at step ${unrecorded[0]} of ${input.total}`
    : `Ran ${reached} of ${input.total} step${input.total === 1 ? '' : 's'}`;
  const lines = rows.map(row => {
    const call = `${row.command.tool}${row.command.params?.action ? `.${row.command.params.action}` : ''}`;
    if (row.outcome === 'failed') {
      const why = (row.label.includes('.') ? undefined : input.failures?.get(row.step)) ?? firstLine(row.command);
      return `${row.label} #${row.command.index} ${call} ✗${why ? ` - ${why}` : ''}`;
    }
    // A check's reading is what the step was for, as an inspect's is; an
    // inspect reply's lines before its result restate the call this line names.
    if (row.command.tool === 'inspect' || row.command.tool === 'check') {
      return `${row.label} #${row.command.index} ${call} ✓${stepReply('inspect', resultOnly(row.command.result))}`;
    }
    return `${row.label} #${row.command.index} ${call} ✓${stepReply(row.command.tool, row.command.result)}`;
  });
  if (unrecorded) lines.push(`${unrecorded[0]} ✗ - ${unrecorded[1]}`);
  return [head, ...lines].join('\n');
}

/** A reply cut to what follows its `Result:` line, where it has one. */
function resultOnly(response: any): any {
  const parts = response?.content;
  if (!Array.isArray(parts)) return response;
  return {
    ...response,
    content: parts.map((part: any) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      const at = part.text.indexOf('Result:');
      return at < 0 ? part : { ...part, text: part.text.slice(at + 'Result:'.length).trim() };
    }),
  };
}
