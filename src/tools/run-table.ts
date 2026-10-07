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
  outcome: 'passed' | 'failed' | 'running';
  match?: StepMatch;
}

function outcomeOf(command: HistoryCommand): Row['outcome'] {
  if (command.stepFailed || command.result?.isError === true) return 'failed';
  return command.result === undefined ? 'running' : 'passed';
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
function countsFor(source: number | Crossing[]): ActivityCounts {
  if (typeof source === 'number') return countsOf(activityOf(source));
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

function causedBy(source: number | Crossing[], rules: RunRules | undefined): string {
  const counts = countsFor(source);
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
      ? `the run is held before step ${before + 1}${person.held?.length ? `, with the page's ${person.held.join(', ')} held` : ''}; \`replay step\` or \`finish\` releases ${person.held?.length ? 'them' : 'it'} and carries on, \`cancel\` releases ${person.held?.length ? 'them' : 'it'} and ends the run`
      : person.mode === 'stop' ? `the run stopped before step ${before + 1}`
      : `the run carried on from step ${before + 1}`;
    return `Person: ${what} landed before step ${before + 1}; ${did}`;
  });
}

const mismatched = (row: Row) => (row.match?.unmatched.length ?? 0) > 0;

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
  const rows = rowsOf(recorder, input.name, input.since);
  const own = rows.filter(row => !row.label.includes('.'));
  const reached = own.reduce((most, row) => Math.max(most, row.step), 0);
  const failedRow = rows.find(row => row.outcome === 'failed');
  // A step that failed before its call was recorded has no row; its reason comes from the executor alone.
  const unrecorded = [...(input.failures ?? [])].filter(([step]) => !own.some(row => row.step === step));
  const failedAt = failedRow?.step ?? unrecorded[0]?.[0];
  const passed = own.filter(row => row.outcome === 'passed').length;
  const mismatches = rows.filter(mismatched).length;
  const compared = rows.some(row => row.match?.kinds);
  const left = input.total - Math.max(reached, ...[...(input.failures?.keys() ?? [])]);

  const head = failedAt !== undefined
    ? `${input.name} failed at step ${failedAt} of ${input.total}`
    : left === 0 ? `${input.name} completed ${reached} of ${input.total}`
    : input.paused ? `${input.name} at step ${reached} of ${input.total}`
    : `${input.name} stopped at step ${reached} of ${input.total}`;
  const tally = [
    `${passed} passed`,
    mismatches ? `${mismatches} mismatched` : compared ? 'all matched' : '',
    left > 0 ? `${left} ${input.paused && failedAt === undefined ? 'remaining' : 'not run'}` : '',
  ].filter(Boolean);
  let reply = [head, ...tally].join(' · ');
  for (const line of envLines(rows)) reply += `\n${line}`;
  const unrecordedNotes = unrecorded.map(([step, why]) => `Step ${step}: ${why}`);

  const pauses = input.pauses ?? new Map<number, Crossing[]>();
  const ruled = rulesBlock(rows, input.rules, pauses);
  const listed = input.steps === 'all' ? rows : rows.filter(row => row.outcome === 'failed' || mismatched(row));
  if (listed.length === 0) {
    return [reply, [...unrecordedNotes, ...personNotes(input.person)].join('\n'), ruled].filter(Boolean).join('\n\n');
  }

  reply += '\n\n| step | history | outcome | matched | caused |\n|---|---|---|---|---|';
  // A pause is listed where it stood, between the step before it and the one it resumed at.
  const pauseRows = input.steps === 'all' ? [...pauses].sort(([a], [b]) => a - b) : [];
  const pauseRow = ([before, events]: [number, Crossing[]]) => `\n| paused before ${before + 1} | — | | | ${causedBy(events, input.rules)} |`;
  for (const row of listed) {
    while (pauseRows.length && !row.label.includes('.') && pauseRows[0][0] + 1 <= row.step) reply += pauseRow(pauseRows.shift()!);
    const nested = row.command.run !== input.name ? ` (${row.command.run})` : '';
    reply += `\n| ${row.label}${nested} | #${row.command.index} | ${row.outcome} | ${row.match?.noBaseline ? 'no baseline' : row.match?.kinds ? `${row.match.matched}/${row.match.kinds}` : ''} | ${causedBy(row.command.index, input.rules)} |`;
  }
  for (const pause of pauseRows) reply += pauseRow(pause);
  if (input.steps === 'all' && left > 0) {
    reply += `\n| ${reached + 1 === input.total ? input.total : `${reached + 1}–${input.total}`} | — | ${input.paused && failedAt === undefined ? 'remaining' : 'not run'} | | |`;
  }

  const notes: string[] = [...unrecordedNotes];
  for (const row of listed) {
    if (mismatched(row)) {
      const kinds = row.match!.unmatched.map(kind => `${kind.kind} ${kind.reasons.join(', ')}`).join('; ');
      const held = row.match!.heldMs ? ` (held ${secs(row.match!.heldMs.recorded)} recording, ${secs(row.match!.heldMs.replayed)} replaying)` : '';
      notes.push(`Step ${row.label} unmatched: ${kinds}${held}`);
    }
    if (row.outcome === 'failed') {
      const why = (row.label.includes('.') ? undefined : input.failures?.get(row.step)) ?? firstLine(row.command);
      if (why) notes.push(`Step ${row.label}: ${why}`);
    }
  }
  notes.push(...personNotes(input.person));
  if (notes.length) reply += `\n\n${notes.join('\n')}`;
  if (ruled) reply += `\n\n${ruled}`;
  return reply;
}
