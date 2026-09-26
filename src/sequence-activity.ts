/**
 * What a sequence's app did, kept apart from what the sequence does.
 *
 * A sequence file holds the actions - steps, their reasons, notes, variables -
 * and reads top to bottom as a script. What crossed the boundary under each
 * step, the responses that answer it on replay, and the names given to kinds
 * of traffic are activity: payloads and counts that ran to hundreds of lines
 * and buried the steps among them. They live in a file of their own beside
 * the sequence, under `activity/` where the sequence is under `sequences/`,
 * and are folded back in when the sequence is read, so everything that reads
 * a sequence reads it whole.
 */

import { promises as fs } from 'fs';
import { dirname, join, sep } from 'path';
import { atomicWriteFile } from './atomic-write.js';

/** The fields a sequence carries in memory that are written to its activity file. */
interface WithActivity {
  id: string;
  name: string;
  commands?: Array<{ traffic?: unknown; expected?: unknown }>;
  boundaryRules?: unknown[];
  boundaryWaits?: unknown[];
  boundaryRefuse?: 'writes';
  boundaryNames?: Record<string, string>;
  boundaryPlacements?: Record<string, number>;
  boundaryRulesOff?: string[];
  boundaryRulesOn?: ResponseUse[];
  boundaryHiddenOn?: string[];
  boundaryHiddenOff?: string[];
}

/** A sequence's use of one of its site's responses: at every step, or at these. */
export interface ResponseUse {
  key: string;
  steps?: number[];
}

interface ActivityStep {
  traffic?: unknown;
  expected?: unknown;
}

export interface SequenceActivity {
  _comment?: string;
  /** The sequence's id, which holds when its name or file changes. */
  sequence: string;
  name: string;
  /** Saved responses: what answers a kind of traffic on replay. */
  responses?: unknown[];
  waits?: unknown[];
  refuseWrites?: boolean;
  names?: Record<string, string>;
  /** Where a kind of traffic is listed and compared, by where it crossed; see `boundaryPlacements`. */
  placements?: Record<string, number>;
  /** Keys of the site's responses this sequence does not arm. */
  responsesOff?: string[];
  /** The site's responses this sequence arms, and at which of its steps. */
  responsesOn?: ResponseUse[];
  /** Keys of the site's hidden kinds this sequence hides, where their type asks it to opt in. */
  hiddenOn?: string[];
  /** Keys of the site's hidden kinds this sequence lists anyway. */
  hiddenOff?: string[];
  /** By step position: what crossed under it when it was recorded, and what is marked to hold on replay. */
  steps?: Record<string, ActivityStep>;
}

/** `…/sequences/a/b.json` → `…/activity/a/b.json`; a file outside any `sequences` folder keeps it beside itself. */
export function activityPathFor(sequencePath: string): string {
  const marker = `${sep}sequences${sep}`;
  const at = sequencePath.lastIndexOf(marker);
  if (at >= 0) return `${sequencePath.slice(0, at)}${sep}activity${sep}${sequencePath.slice(at + marker.length)}`;
  return sequencePath.replace(/\.json$/, '.activity.json');
}

/** The sequence as written to its own file, and its activity, or none when it has none. */
export function splitActivity<T extends WithActivity>(sequence: T): { actions: T; activity?: SequenceActivity } {
  const {
    boundaryRules, boundaryWaits, boundaryRefuse, boundaryNames, boundaryPlacements, boundaryRulesOff, boundaryRulesOn,
    boundaryHiddenOn, boundaryHiddenOff, ...rest
  } = sequence;
  const steps: Record<string, ActivityStep> = {};
  const commands = (sequence.commands ?? []).map((command, index) => {
    const { traffic, expected, ...action } = command;
    if (traffic !== undefined || expected !== undefined) {
      steps[String(index)] = {
        ...(traffic !== undefined ? { traffic } : {}),
        ...(expected !== undefined ? { expected } : {}),
      };
    }
    return action;
  });
  const actions = { ...rest, ...(sequence.commands ? { commands } : {}) } as T;

  const activity: SequenceActivity = {
    _comment: 'What the app did under each step of the sequence of the same name, and what answers it on replay. Read and written with that sequence.',
    sequence: sequence.id,
    name: sequence.name,
    ...(boundaryRules?.length ? { responses: boundaryRules } : {}),
    ...(boundaryWaits?.length ? { waits: boundaryWaits } : {}),
    ...(boundaryRefuse === 'writes' ? { refuseWrites: true } : {}),
    ...(boundaryNames && Object.keys(boundaryNames).length ? { names: boundaryNames } : {}),
    ...(boundaryPlacements && Object.keys(boundaryPlacements).length ? { placements: boundaryPlacements } : {}),
    ...(boundaryRulesOff?.length ? { responsesOff: boundaryRulesOff } : {}),
    ...(boundaryRulesOn?.length ? { responsesOn: boundaryRulesOn } : {}),
    ...(boundaryHiddenOn?.length ? { hiddenOn: boundaryHiddenOn } : {}),
    ...(boundaryHiddenOff?.length ? { hiddenOff: boundaryHiddenOff } : {}),
    ...(Object.keys(steps).length ? { steps } : {}),
  };
  const empty = !activity.responses && !activity.waits && !activity.refuseWrites && !activity.names
    && !activity.placements && !activity.responsesOff && !activity.responsesOn
    && !activity.hiddenOn && !activity.hiddenOff && !activity.steps;
  return empty ? { actions } : { actions, activity };
}

/**
 * The sequence with its activity folded back in.
 *
 * An activity file written for another sequence - a sequence replaced by a
 * new recording under the same name - is left out rather than laid over steps
 * it was not recorded against.
 */
export function mergeActivity<T extends WithActivity>(sequence: T, activity: SequenceActivity | undefined): T {
  if (!activity || activity.sequence !== sequence.id) return sequence;
  const commands = (sequence.commands ?? []).map((command, index) => {
    const step = activity.steps?.[String(index)];
    return {
      ...command,
      ...(step?.traffic !== undefined && command.traffic === undefined ? { traffic: step.traffic } : {}),
      ...(step?.expected !== undefined && command.expected === undefined ? { expected: step.expected } : {}),
    };
  });
  return {
    ...sequence,
    ...(sequence.commands ? { commands } : {}),
    ...(activity.responses && !sequence.boundaryRules ? { boundaryRules: activity.responses } : {}),
    ...(activity.waits && !sequence.boundaryWaits ? { boundaryWaits: activity.waits } : {}),
    ...(activity.refuseWrites && !sequence.boundaryRefuse ? { boundaryRefuse: 'writes' as const } : {}),
    ...(activity.names && !sequence.boundaryNames ? { boundaryNames: activity.names } : {}),
    ...(activity.placements && !sequence.boundaryPlacements ? { boundaryPlacements: activity.placements } : {}),
    ...(activity.responsesOff && !sequence.boundaryRulesOff ? { boundaryRulesOff: activity.responsesOff } : {}),
    ...(activity.responsesOn && !sequence.boundaryRulesOn ? { boundaryRulesOn: activity.responsesOn } : {}),
    ...(activity.hiddenOn && !sequence.boundaryHiddenOn ? { boundaryHiddenOn: activity.hiddenOn } : {}),
    ...(activity.hiddenOff && !sequence.boundaryHiddenOff ? { boundaryHiddenOff: activity.hiddenOff } : {}),
  };
}

export async function readActivity(sequencePath: string): Promise<SequenceActivity | undefined> {
  try {
    return JSON.parse(await fs.readFile(activityPathFor(sequencePath), 'utf-8')) as SequenceActivity;
  } catch {
    return undefined;
  }
}

/** Write the activity beside the sequence, or remove a stale one when there is none. */
export async function writeActivity(sequencePath: string, activity: SequenceActivity | undefined): Promise<void> {
  const path = activityPathFor(sequencePath);
  if (!activity) {
    await fs.unlink(path).catch(() => {});
    return;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(activity, null, 2));
}

/**
 * The responses that answer a site's traffic, kept once for every sequence
 * run against it.
 *
 * A response kept in one sequence's file was a copy: the same answer used by
 * two sequences was two responses, edited apart. Kept here, by the site's
 * host and port, each is one response, and a sequence's own file records only
 * which of them it uses and at which of its steps.
 */
export interface SiteActivity {
  _comment?: string;
  /** The origin the responses answer on, as `http://host:port`. */
  site: string;
  responses?: unknown[];
  /**
   * Kinds of traffic kept out of the list, each with the same types a
   * response has. Apart from the responses, so hiding a kind leaves any
   * answer to it standing.
   */
  hidden?: unknown[];
}

/** `http://localhost:7788` → `<activityDir>/_site/localhost-7788.json`; the underscore keeps it from reading as a sequence. */
export function siteActivityPath(activityDir: string, origin: string): string {
  const { hostname, port, protocol } = new URL(origin);
  const name = `${hostname}-${port || (protocol === 'https:' ? '443' : '80')}`.replace(/[^a-zA-Z0-9.-]+/g, '-');
  return join(activityDir, '_site', `${name}.json`);
}

export async function readSiteActivity(path: string): Promise<SiteActivity | undefined> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8')) as SiteActivity;
  } catch {
    return undefined;
  }
}

/** Write the site's responses and hidden kinds, or remove the file once neither stands. */
export async function writeSiteActivity(path: string, site: string, responses: unknown[], hidden: unknown[] = []): Promise<void> {
  if (!responses.length && !hidden.length) {
    await fs.unlink(path).catch(() => {});
    return;
  }
  const activity: SiteActivity = {
    _comment: 'The responses that answer this site\'s traffic. Each has a mode: optOut answers in every sequence on the site that does not list it in `responsesOff`; optIn answers only in the sequences listing it in `responsesOn`, at the steps given there.',
    site,
    ...(responses.length ? { responses } : {}),
    ...(hidden.length ? { hidden } : {}),
  };
  await fs.mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, JSON.stringify(activity, null, 2));
}

/**
 * Renumber everything a sequence holds by step position after its steps
 * moved: `map` takes a step's old position to its new one, or to undefined
 * for a step that is gone.
 *
 * A note, a step's traffic and its marks travel inside the step and need
 * nothing. Waits, the steps a response is used at, where a kind of traffic is
 * listed and where a fork rejoins name steps by number, so a step put in or
 * taken out before them left each naming the step next to the one meant.
 */
export function renumberSteps<T extends WithActivity & { commands?: Array<{ tool?: string; params?: Record<string, any> }> }>(
  sequence: T,
  map: (old: number) => number | undefined,
): void {
  if (sequence.boundaryWaits) {
    const waits = (sequence.boundaryWaits as Array<{ step: number }>)
      .map(wait => ({ ...wait, step: map(wait.step) }))
      .filter((wait): wait is { step: number } => wait.step !== undefined);
    sequence.boundaryWaits = waits;
  }
  if (sequence.boundaryRulesOn) {
    sequence.boundaryRulesOn = sequence.boundaryRulesOn.map(use => {
      if (!use.steps) return use;
      const steps = use.steps.map(map).filter((n): n is number => n !== undefined);
      return { ...use, steps };
    }).filter(use => !use.steps || use.steps.length > 0);
  }
  if (sequence.boundaryNames) {
    const names: Record<string, string> = {};
    for (const [key, name] of Object.entries(sequence.boundaryNames)) {
      const bar = key.indexOf('|');
      const stamped = bar < 0 ? NaN : Number(key.slice(0, bar));
      if (Number.isNaN(stamped)) { names[key] = name; continue; }
      const to = map(stamped);
      if (to !== undefined) names[`${to}${key.slice(bar)}`] = name;
    }
    sequence.boundaryNames = names;
  }
  if (sequence.boundaryPlacements) {
    const placed: Record<string, number> = {};
    for (const [key, listed] of Object.entries(sequence.boundaryPlacements)) {
      const bar = key.indexOf('|');
      const stamped = key.slice(0, bar);
      const kind = key.slice(bar + 1);
      const from = stamped === 'after' ? stamped : map(Number(stamped));
      const to = map(listed);
      if (from === undefined || to === undefined) continue;
      placed[`${from}|${kind}`] = to;
    }
    sequence.boundaryPlacements = placed;
  }
  for (const command of sequence.commands ?? []) {
    if (command.tool === 'conditional' && typeof command.params?.rejoinAt === 'number') {
      const to = map(command.params.rejoinAt);
      if (to === undefined) delete command.params.rejoinAt;
      else command.params.rejoinAt = to;
    }
  }
}

/** The old-to-new step map for a step list reordered, by which step object sits where. */
export function stepMap<C>(before: C[], after: C[]): (old: number) => number | undefined {
  const at = new Map(after.map((command, index) => [command, index] as const));
  return (old: number) => at.get(before[old]);
}
