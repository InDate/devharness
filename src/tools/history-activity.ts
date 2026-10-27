/**
 * History entries as the observation log reads them: the call, then what it
 * caused, owned lines indented with their evidence and what followed in time
 * order, each with the id a lookup takes.
 */

import type { HistoryCommand } from '../command-recorder.js';
import { foreignTo, formatLines, letterKey, observation, observationsOf, OBSERVATION_LETTERS, type Observation, type ObservationKind } from '../observation-log.js';

/** The call as one short phrase: `press e`, `click button:text("send 5")`, `navigate goto http://…`. */
export function describeCall(command: Pick<HistoryCommand, 'tool' | 'params'>): string {
  const params = (command.params ?? {}) as Record<string, unknown>;
  const action = typeof params.action === 'string' ? ` ${params.action}` : '';
  const keys = Array.isArray(params.keys) ? params.keys.join(' ') : undefined;
  const target = [keys === undefined ? 'key' : 'keys', 'selector', 'url', 'name', 'expression', 'ms', 'afterMs']
    .map(field => (field === 'keys' ? keys : params[field]))
    .find(value => value !== undefined && value !== '');
  const shown = target === undefined ? '' : ` ${String(target).replace(/\s+/g, ' ').slice(0, 48)}${String(target).length > 48 ? '…' : ''}`;
  // An input step reads as what it did: `click …`, `press e`.
  return command.tool === 'input' && action ? `${action.trim()}${shown}` : `${command.tool}${action}${shown}`;
}

const PLURALS: Record<ObservationKind, [string, string]> = {
  request: ['request', 'requests'], frame: ['frame', 'frames'], storage: ['storage write', 'storage writes'], motion: ['motion', 'motions'],
};

/** The connection a call reads from, where its parameters name one. */
export function readingConnection(command: Pick<HistoryCommand, 'params'>): string | undefined {
  const connection = (command.params as Record<string, unknown> | undefined)?.connection;
  return typeof connection === 'string' ? connection : undefined;
}

/**
 * What an entry caused, counted by kind: `1 request, 10 frames`. What another
 * browser made is counted apart under its connection: `1 request on duo-member-two`.
 */
export function countsLine(observations: Observation[], reading?: string): string {
  const groups = new Map<string, Observation[]>();
  for (const one of observations) {
    const on = foreignTo(one, reading) ?? '';
    groups.set(on, [...(groups.get(on) ?? []), one]);
  }
  const home = groups.get('') ?? [];
  const foreign = [...groups].filter(([on]) => on !== '');
  return [[ '', home ] as const, ...foreign].flatMap(([on, group]) => (Object.keys(OBSERVATION_LETTERS) as ObservationKind[])
    .map(kind => {
      const n = group.filter(o => o.kind === kind).length;
      return n ? `${n} ${PLURALS[kind][n === 1 ? 0 : 1]}${on ? ` on ${on}` : ''}` : '';
    }))
    .filter(Boolean)
    .join(', ');
}

/** The full lines of the named entries, under one key of the letters they use. */
export function formatEntries(commands: HistoryCommand[]): string {
  const all = commands.flatMap(command => observationsOf(command.index));
  const blocks = commands.map(command => {
    const observations = observationsOf(command.index);
    const owned = observations.filter(o => o.owned).length;
    const step = command.run ? `${command.run} step ${(command.runStep ?? 0) + 1}` : '';
    const tally = observations.length ? `${owned} owned, ${observations.length - owned} after` : 'nothing observed';
    const head = `#${command.index}  ${describeCall(command)}`;
    return [`${head.padEnd(52)} ${[step, tally].filter(Boolean).join(' · ')}`, ...formatLines(observations, readingConnection(command))].join('\n');
  });
  const key = letterKey(all);
  return [key, ...blocks].filter(Boolean).join('\n');
}

/** Observations by id, each in full: its line, its entry, and the record behind it. */
export function formatObservations(ids: string[]): string {
  return ids.map(id => {
    const one = observation(id);
    if (!one) return `${id}  not held: ids last for the session that observed them`;
    const facts = [
      `${one.id}  ${one.kind}  ${one.text}${one.connection ? `  on ${one.connection}` : ''}`,
      `  entry #${one.entry ?? '—'}${one.owned ? `, owned <${one.owned}>` : ', a consequence in time order'}`,
      one.rule ? `  rule: ${one.rule}` : '',
      `  at ${new Date(one.at).toISOString()}`,
      one.ref.source === 'proxy'
        ? `  proxy event ${one.ref.id}: proxy({ action: 'body', id: '${one.ref.id}' }) reads its payload`
        : `  page write ${one.ref.id}`,
    ];
    return facts.filter(Boolean).join('\n');
  }).join('\n\n');
}
