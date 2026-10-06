/**
 * The rules that act on a run's traffic, and which of them acted on each
 * crossing.
 *
 * An ignore rule leaves a kind out of the comparison against the recording;
 * an answer or block rule serves the page in place of the server; the refuse
 * setting answers an unmatched write 403. A run that reports none of them
 * reads an ignored frame as drift and an answered one as the server's.
 *
 * Read off the connection's rule holder, which opening the sequence in the
 * bench or starting a run of it arms the same way.
 */
import type { HiddenKind } from '../bench/wire.js';
import { ignoreMatches } from '../bench/kinds.js';
import { hiddenOf, holderOf, rulesOf } from '../bench-mode/rules.js';
import { getProxy } from '../proxy/registry.js';
import type { ProxyEvent } from '../proxy/intercept-proxy.js';
import type { CommandRecorder } from '../command-recorder.js';
import { pausesOf, type Crossing } from '../bench/step-compare.js';
import { writeEvents } from '../bench-mode/traffic.js';

export interface RunRule {
  /** What the rule matches on: a path, or a frame's field. */
  key: string;
  verb: 'ignore' | 'answer' | 'block' | 'refuse' | 'scope';
  label: string;
  /** Where the rule is held and which sequences it covers. */
  from: string;
  /** The pin it is armed as, which an answered crossing names. */
  pin?: string;
}

export interface RunRules {
  rules: RunRule[];
  /** The ignore rules in effect, as the bench matches them. */
  ignores: Array<{ kind: HiddenKind; rule: RunRule }>;
}

const FROM: Record<string, string> = {
  optOut: 'site · every sequence',
  optIn: 'site · opted in',
  local: 'this sequence',
};

function fromOf(mode: string | undefined, steps?: number[]): string {
  const where = FROM[mode ?? 'local'] ?? 'this sequence';
  return steps?.length ? `${where} · step${steps.length === 1 ? '' : 's'} ${steps.map(n => n + 1).join(', ')}` : where;
}

/** The rules acting on a run on `connection`: those its sequence armed, and any pin the proxy tool armed. */
export function rulesForRun(connection: string): RunRules {
  const holder = holderOf(connection);
  const proxy = getProxy(connection);
  const rules: RunRule[] = [];
  const ignores: RunRules['ignores'] = [];
  // With no proxy nothing crosses where a rule could act on it or a pin
  // answer it, and a rule listed as never fired there says nothing.
  if (!proxy) return { rules, ignores };
  for (const kind of hiddenOf(connection).filter(one => !one.off)) {
    const rule: RunRule = { key: kind.key, verb: 'ignore', label: kind.label ?? kind.key, from: fromOf(kind.mode, kind.step !== undefined ? [kind.step] : undefined) };
    rules.push(rule);
    ignores.push({ kind, rule });
  }
  for (const armed of rulesOf(connection).filter(one => !one.off && one.verb !== 'hide')) {
    const pin = holder?.boundaryPins?.get(armed.key);
    rules.push({
      key: armed.key, verb: armed.verb === 'block' ? 'block' : 'answer', label: armed.label ?? armed.key,
      from: fromOf(armed.mode, armed.steps), ...(pin ? { pin } : {}),
    });
  }

  // A pin armed through the proxy tool rather than from a saved rule.
  const named = new Set(rules.map(rule => rule.pin).filter(Boolean));
  for (const pin of proxy?.listPins() ?? []) {
    if (named.has(pin.id)) continue;
    rules.push({ key: pin.urlIncludes, verb: 'answer', label: `${pin.method ?? ''} ${pin.urlIncludes}`.trim(), from: 'proxy tool', pin: pin.id });
  }
  for (const pin of proxy?.listFramePins() ?? []) {
    if (named.has(pin.id)) continue;
    rules.push({
      key: pin.textIncludes, verb: pin.replaceWith === undefined ? 'block' : 'answer',
      label: `${pin.urlIncludes ?? ''} ${pin.textIncludes}`.trim(), from: 'proxy tool', pin: pin.id,
    });
  }
  const allowed = proxy?.listAllowedHosts() ?? [];
  if (allowed.length) {
    rules.push({ key: 'host scope', verb: 'scope', label: `hosts outside ${allowed.join(', ')}`, from: 'connection' });
  }
  if (proxy?.refusesWrites) {
    rules.push({ key: 'unmatched writes', verb: 'refuse', label: 'unmatched writes', from: 'this sequence' });
  }
  return { rules, ignores };
}

/** The rule that acted on `event`: the pin that answered it, the refusal, or the ignore rule covering it. */
export function ruleOn(rules: RunRules, event: ProxyEvent): RunRule | undefined {
  if (event.answeredAs === 'refused') return rules.rules.find(rule => rule.verb === 'refuse');
  if (event.answeredAs === 'outOfScope') return rules.rules.find(rule => rule.verb === 'scope');
  if (event.answeredBy) return rules.rules.find(rule => rule.pin === event.answeredBy);
  return rules.ignores.find(({ kind }) => ignoreMatches(kind, event as any))?.rule;
}

/** What crossed in each pause of the newest pass on `connection`, by the 0-based step the pause stood before. */
export function pausesIn(connection: string): Map<number, Crossing[]> {
  const events: Crossing[] = [...(getProxy(connection)?.eventsIn() ?? []), ...writeEvents(connection)]
    .sort((a, b) => a.at - b.at);
  return pausesOf(events);
}
