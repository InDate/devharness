/** @jsxImportSource preact */
import { Fragment } from 'preact';
import type preact from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CrossingRow, MissingRow, choicesIn, rearmRule, keyOf, labelOf, isFrame, stabilityIn, passesIn, socketName,
  ignoreMatches, ignoreCoversKind,
  type RowMoves, type RuleActions, type RuleScope, type RowVerdict, type ResponseWait, WaitSettings,
} from './crossing.js';
import { countKinds, kindOf, verdictOf, type KindCount } from '../kinds.js';
import { Row } from './row.js';
import { useShowHidden } from './focus.js';
import type { BoundaryEvent, BoundaryState, SequenceState } from '../wire.js';

/**
 * What the app did under each step of the open sequence, read against its
 * recording: the rows, their verdicts, the gutter after the last step, and
 * what a row can do. Read by every screen that lists a step's activity, so the
 * rows it shows and the decisions made on them are the same wherever they are.
 */
export function useActivity(base: string, sequence: SequenceState | undefined) {
  const [boundary, setBoundary] = useState<BoundaryState | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  // Each row's last verdict, kept while the payload of a newer crossing of its
  // kind is being read: a socket pushing every half second hands the row a new
  // crossing each time, and without it the verdict blinks out and back.
  const lastVerdicts = useRef(new Map<string, RowVerdict>());

  // Bodies of the replayed crossings a marked value is compared against, by
  // event id. The rows carry a 200-character preview; a marked field can sit
  // past it, so the kept body is read once per crossing.
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const bodiesWanted = useRef<string[]>([]);
  const bodiesAsked = useRef(new Set<string>());
  useEffect(() => {
    for (const id of bodiesWanted.current) {
      if (bodiesAsked.current.has(id)) continue;
      bodiesAsked.current.add(id);
      void fetch(`${base}/proxy/body?id=${encodeURIComponent(id)}`)
        .then(res => res.text())
        .then(text => setBodies(held => ({ ...held, [id]: text })))
        .catch(() => bodiesAsked.current.delete(id));
    }
  });

  // The boundary runs on its own clock: the step list is read four times a
  // second and what crossed changes far less often than that.
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${base}/proxy/events?since=`);
        if (live) setBoundary(await res.json());
      } catch { /* the bench outlives a restart */ }
    };
    void poll();
    const timer = setInterval(poll, 600);
    return () => { live = false; clearInterval(timer); };
  }, [base]);


  const post = async (path: string, body?: Record<string, unknown>) => {
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).catch(() => { /* the bench outlives a restart */ });
  };

  // A decision is keyed the way the proxy matches, so a row finds its own by
  // the same key the rule was written under.
  const byKey = new Map((boundary?.rules ?? []).map(rule => [rule.key, rule]));
  // A rule bound to a step governs that step's crossing of its kind and no
  // other, so the same kind at another step is not its row.
  const ruleFor = (event: BoundaryEvent) => {
    const rule = byKey.get(keyOf(event));
    return rule && (!rule.steps || (event.step !== undefined && rule.steps.includes(event.step))) ? rule : undefined;
  };
  // Kinds the open sequence keeps out of its list; a hidden kind it lists
  // anyway is marked off and stays.
  // The ignore rules in force here: a rule the open sequence opts out of
  // leaves its traffic listed and compared.
  const ignores = (boundary?.hidden ?? []).filter(kind => !kind.off);
  const showHidden = useShowHidden();
  // Hidden kinds are dropped from the list unless the footing asks to see
  // them, when they stay in place, dimmed.
  const wasHidden = (event: BoundaryEvent) => ignores.some(rule => ignoreMatches(rule, event));
  const isHidden = (event: BoundaryEvent) => !showHidden && wasHidden(event);
  const stepCount = sequence?.steps?.length ?? 0;
  const listed = crossedUnder(boundary, event => byKey.has(keyOf(event)), sequence?.placements, stepCount);
  const crossed = listed.byStep;
  const gutter = sequence?.recording ? [] : (crossed.get(stepCount) ?? []).filter(e => !isHidden(e));
  // The pass the list is reading, so a staged row left from an older one is
  // marked rather than read as having just crossed.
  let pass: string | undefined;
  for (const event of boundary?.events ?? []) if (event.runId !== undefined) pass = event.runId;
  const stability = stabilityIn(boundary?.events ?? []);
  // Each row of the latest replay against the recording of its kind on the
  // same step, for the steps the replay reached.
  const replayed = pass?.startsWith('run-') && !!sequence?.steps && !sequence.recording;
  const verdicts = new Map<string, RowVerdict>();
  const missing = new Map<number, Array<{ kind: string; verdict: RowVerdict }>>();
  const tally = { mismatch: 0, unexpected: 0, missing: 0 };
  bodiesWanted.current = [];
  for (const step of replayed ? sequence!.steps : []) {
    const recorded = step.traffic?.kinds;
    if (!recorded || step.index >= sequence!.currentStep) continue;
    const observed = countKinds(listed.ran.get(step.index) ?? []);
    for (const row of crossed.get(step.index) ?? []) {
      if (row.runId !== pass && originOf.get(row) !== 'after') continue;
      // Ignored traffic is not compared: neither a match nor a difference.
      if (wasHidden(row)) continue;
      const kind = kindOf(row);
      const was = recorded[kind];
      const mark = step.expected?.[kind];
      const body = bodies[row.id];
      if (was && (mark?.fields || (!was.presence && was.body !== undefined)) && body === undefined) {
        bodiesWanted.current.push(row.id);
      }
      const read = verdictOf(was, observed[kind] ?? { n: 0 }, body, mark);
      if (!read) {
        const held = lastVerdicts.current.get(rowOf(step.index, row));
        if (held) {
          if (held.verdict !== 'match') tally[held.verdict] += 1;
          verdicts.set(rowOf(step.index, row), held);
        }
        continue;
      }
      if (read.verdict !== 'match') tally[read.verdict] += 1;
      verdicts.set(rowOf(step.index, row), {
        ...read,
        ...(was ? { recorded: was } : {}),
        onUpdate: () => void (async () => {
          const payload = bodies[row.id]
            ?? await fetch(`${base}/proxy/body?id=${encodeURIComponent(row.id)}`).then(res => res.text()).catch(() => undefined);
          await post('/sequence/recorded', {
            step: step.index, kind,
            recorded: { ...observed[kind], ...(was?.presence ? { presence: true } : {}), ...(payload ? { body: payload } : {}) },
          });
        })(),
      });
      lastVerdicts.current.set(rowOf(step.index, row), verdicts.get(rowOf(step.index, row))!);
    }
    const absent = Object.entries(recorded)
      .filter(([kind]) => !observed[kind] && !ignores.some(rule => ignoreCoversKind(rule, kind, step.index)))
      .map(([kind, was]) => ({
        kind,
        verdict: {
          verdict: 'missing' as const, reasons: [], recorded: was,
          onUpdate: () => void post('/sequence/recorded', { step: step.index, kind, recorded: null }),
        },
      }));
    tally.missing += absent.length;
    if (absent.length) missing.set(step.index, absent);
  }
  // A kind moved to the adjacent step, or between the last step and the
  // gutter, on the recording and on every run after. A gutter row moved onto
  // a step brings what it counted with it, since the recording holds nothing
  // for it yet.
  const move = (event: BoundaryEvent | undefined, kind: string, at: number, to: number) => void (async () => {
    const origin = event ? originOf.get(event) : undefined;
    let recorded: KindCount | undefined;
    if (event && at === stepCount) {
      const count = countKinds((listed.ran.get(stepCount) ?? []).filter(crossing => kindOf(crossing) === kind))[kind];
      const payload = count && !count.presence
        ? await fetch(`${base}/proxy/body?id=${encodeURIComponent(event.id)}`).then(res => res.text()).catch(() => '')
        : '';
      if (count) recorded = { ...count, ...(payload ? { body: payload } : {}) };
    }
    setReading(null);
    await post('/sequence/activity/move', {
      kind, at, to, ...(origin !== undefined ? { origin } : {}), ...(recorded ? { recorded } : {}),
    });
  })();
  const tallied = (['mismatch', 'unexpected', 'missing'] as const)
    .filter(verdict => tally[verdict] > 0)
    .map(verdict => `${tally[verdict]} ${verdict}`);
  const passes = passesIn(boundary?.events ?? []).length;

  const rule = (event: BoundaryEvent, verb: 'answer' | 'block' | 'hide',
                body?: string, status?: string, match?: string, edited?: boolean, scope?: RuleScope, payload?: string,
                wait?: ResponseWait) => void post('/boundary/rule', {
    ...(wait ? { wait } : {}),
    key: match ?? keyOf(event), verb, frame: isFrame(event), label: labelOf(event),
    ...(body !== undefined ? { body } : {}),
    ...(payload ? { payload } : {}),
    ...(edited ? { edited: true } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(event.preview !== undefined ? { recorded: event.preview } : {}),
    ...(scope
      ? scope.method ? { method: scope.method } : {}
      : !isFrame(event) && event.method ? { method: event.method } : {}),
    ...(scope?.step !== undefined && scope.step !== null ? { step: scope.step } : {}),
    // Answers at any step to begin with: made from one row, it is almost
    // always meant for that call wherever the run makes it, and a rule bound
    // to the row's step left the same call earlier in the run unanswered. The
    // step is kept as staged, so the editor offers it to narrow back to.
    ...(event.step !== undefined ? { staged: { step: event.step } } : {}),
    // A frame's payload text is the whole predicate, so the socket and the
    // direction it crossed on are recorded with it and bound the match.
    ...(scope
      ? { ...(scope.url ? { url: scope.url } : {}), ...(scope.direction ? { direction: scope.direction } : {}) }
      : isFrame(event) ? { url: event.url, direction: event.direction } : {}),
    ...(scope ? { use: scope.step !== null ? [scope.step] : 'all' } : {}),
    ...(scope?.mode ? { mode: scope.mode } : {}),
  });

  const actions: RuleActions = {
    answer: (event, body, status, match, edited, scope, payload, wait) => rule(event, 'answer', body, status, match, edited, scope, payload, wait),
    block: (event) => rule(event, 'block'),
    hide: (event) => rule(event, 'hide'),
    clear: (event) => void post('/boundary/rule/clear', { key: keyOf(event) }),
    report: (event) => void fetch(
      `${base}/proxy/investigate?id=${encodeURIComponent(event.id)}&note=`, { method: 'POST' }),
    // A step waits for the row's own kind: how many, how long and what a
    // miss does are the response's to say, one arrival until it says more.
    waitFor: (event, step) => void post('/boundary/wait', { step, key: keyOf(event), count: 1 }),
    responses: boundary?.rules ?? [],
    use: (key, use) => void post('/boundary/rule/use', { key, use }),
    unhide: (key) => void post('/boundary/hidden/use', { key, on: false }),
    ignore: (rule) => void post('/boundary/ignore', rule),
    // Listing a kind again on its row lifts the rule that covers it, which a
    // socket-wide rule's key is not the kind's own.
    ignoredBy: (event) => ignores.find(rule => ignoreMatches(rule, event))?.key,
    waiting: (step, key) => (boundary?.waits ?? []).some(wait => wait.step === step && (wait.key ?? key) === key),
    unwait: (step, key) => void post('/boundary/wait', { step, count: 0, key }),
    waitOf: (step, key) => (boundary?.waits ?? []).find(wait => wait.step === step && (wait.key ?? key) === key),
    setWait: (step, key, wait) => void post('/boundary/wait', { step, key, ...wait }),
    set: (rule, next) => void rearmRule(post, rule, next),
    choices: choicesIn(
      boundary?.events ?? [],
      (sequence?.steps ?? []).map(step => ({ index: step.index, label: step.label })),
      sequence?.name,
    ),
    // A recording holds the sequence busy too, and answers no step-bound rule.
    replaying: sequence?.busy === true && !sequence?.recording,
    names: boundary?.names,
    rename: (event, name, key) => void post('/boundary/name', { key: key ?? keyOf(event), name }),
    expected: (event, step = event.step) => step === undefined
      ? undefined
      : sequence?.steps?.[step]?.expected?.[kindOf(event)],
    expect: (event, mark, step = event.step) => void post('/sequence/expected', {
      step, kind: kindOf(event), expected: mark ?? null,
    }),
  };

  return {
    boundary, reading, setReading, ruleFor, isHidden, wasHidden, crossed, gutter, stepCount, pass, stability,
    verdicts, missing, tallied, passes, move, actions,
  };
}

export type Activity = ReturnType<typeof useActivity>;

/** Where each listed crossing crossed - its stamped step, or `after` - which a move is saved against. */
export const originOf = new WeakMap<BoundaryEvent, string>();

/**
 * What crossed under each step, placed where the sequence says its kind is
 * listed, and after the last step, at the step count, what the newest pass
 * produced once its last step had ended.
 *
 * `ran` holds every crossing of the newest pass by the step it is placed on,
 * not one per kind, which is what a step's counts are read from.
 */
function crossedUnder(
  boundary: BoundaryState | null,
  ruled: (event: BoundaryEvent) => boolean,
  placements: Record<string, number> | undefined,
  stepCount: number,
): { byStep: Map<number, BoundaryEvent[]>; ran: Map<number, BoundaryEvent[]> } {
  const events = boundary?.events ?? [];
  let pass: string | undefined;
  for (const event of events) if (event.runId !== undefined) pass = event.runId;
  // The pass ended at its last stamped crossing; what crossed after it with no
  // stamp is the tail no step held open for, which is still the pass's doing.
  let lastStamped: number | undefined;
  for (const event of events) if (event.runId === pass && event.step !== undefined) lastStamped = event.at;

  const byStep = new Map<number, Map<string, BoundaryEvent>>();
  const ran = new Map<number, BoundaryEvent[]>();
  const counts = new Map<string, number>();
  for (const event of events) {
    let origin: string;
    if (event.runId !== undefined && event.step !== undefined) {
      // This pass, or something a decision stands against.
      if (event.runId !== pass && !ruled(event)) continue;
      origin = String(event.step);
    } else if (event.runId === undefined && lastStamped !== undefined && event.at > lastStamped) {
      origin = 'after';
    } else {
      continue;
    }
    const home = origin === 'after' ? stepCount : Number(origin);
    const step = placements?.[`${origin}|${kindOf(event)}`] ?? home;
    originOf.set(event, origin);
    if (origin === 'after' || event.runId === pass) ran.set(step, [...(ran.get(step) ?? []), event]);
    const held = byStep.get(step) ?? new Map<string, BoundaryEvent>();
    // A request is its own row - two calls to one endpoint are two facts -
    // where two frames of one shape are the same fact twice.
    const key = event.kind === 'request' ? `${event.method} ${keyOf(event)}` : keyOf(event);
    const standing = held.get(key);
    if (!standing || event.at >= standing.at) held.set(key, event);
    byStep.set(step, held);
    counts.set(`${step} ${key}`, (counts.get(`${step} ${key}`) ?? 0) + 1);
  }
  const out = new Map<number, BoundaryEvent[]>();
  for (const [step, kinds] of byStep) {
    for (const [key, event] of kinds) repeatsOf.set(event, counts.get(`${step} ${key}`) ?? 1);
    out.set(step, [...kinds.values()].sort((a, b) => a.at - b.at));
  }
  return { byStep: out, ran };
}

/**
 * A traffic row's identity: its step and the kind it lists.
 *
 * Not the event's id. A row shows the newest crossing of its kind, so its event
 * changes as each frame lands, and an open row keyed by event closed itself on
 * the next arrival.
 */
export function rowOf(step: number, event: BoundaryEvent): string {
  return `${step}|${event.kind === 'request' ? `${event.method} ${keyOf(event)}` : keyOf(event)}`;
}

/** How many crossings each listed row stands for, by the event that heads it. */
export const repeatsOf = new WeakMap<BoundaryEvent, number>();

/**
 * One step's activity - or, at the step count, the gutter after the last step
 * - one card per kind: what this pass produced there, the recorded kinds it
 * did not, and the arrows that move a kind to the step beside it.
 */
/**
 * The kinds a step lists, top to bottom: the rows this run produced, then the
 * recorded kinds it did not. A note is placed among them by kind.
 */
export function listedKinds(activity: Activity, step: number): string[] {
  const rows = (activity.crossed.get(step) ?? []).filter(event => !activity.isHidden(event));
  const absent = step < activity.stepCount ? activity.missing.get(step) ?? [] : [];
  return [...rows.map(event => kindOf(event)), ...absent.map(({ kind }) => kind)];
}

/** How many rows of each colour a step holds, for its marker while its rows are folded. */
export function stepTally(activity: Activity, step: number) {
  const rows = (activity.crossed.get(step) ?? []).filter(event => !activity.isHidden(event));
  const intercepted = rows.filter(event => {
    const rule = activity.ruleFor(event);
    return !!rule && !rule.off && (rule.verb === 'answer' || rule.verb === 'block');
  }).length;
  return {
    traffic: rows.length - intercepted,
    intercepted,
    missing: step < activity.stepCount ? (activity.missing.get(step) ?? []).length : 0,
    waits: (activity.boundary?.waits ?? []).filter(wait => wait.step === step).length,
  };
}

export function ActivityRows({ activity, step, base, recording, notesAt, running }: {
  /** The step a replay is on now, whose waits are being waited on. */
  running?: boolean;
  activity: Activity;
  step: number;
  base: string;
  /** A recording holds the steps still open, so nothing is moved while one runs. */
  recording: boolean;
  /**
   * The notes listed after the row of this kind, `''` for those above every
   * row; called once more with `null` for those below them all.
   */
  notesAt?: (after: string | null) => preact.ComponentChildren;
}) {
  const { crossed, ruleFor, verdicts, missing, move, reading, setReading, actions, stability, pass, stepCount } = activity;
  const rows = (crossed.get(step) ?? []).filter(event => !activity.isHidden(event));
  const absent = step < stepCount ? missing.get(step) ?? [] : [];
  const top = notesAt?.('');
  const bottom = notesAt?.(null);
  // What this step waits for, and how many of it this pass has brought: a row
  // under its rows that each arrival pushes down, and that says so once all
  // have come.
  const waiting = (activity.boundary?.waits ?? []).filter(wait => wait.step === step).map(wait => {
    const came = rows
      .filter(event => event.runId === pass
        && (!wait.key || keyOf(event) === wait.key || (event.preview ?? '').includes(wait.key)))
      .reduce((sum, event) => sum + (repeatsOf.get(event) ?? 1), 0);
    const named = wait.key && (actions.names?.[`${step}|${wait.key}`] ?? actions.names?.[wait.key]);
    // The latest crossing of the kind, this step's first: read as its row
    // reads - the socket or verb, the way it went, and what it carried.
    const kind = (activity.boundary?.events ?? []).filter(event => keyOf(event) === wait.key);
    const sample = [...kind].reverse().find(event => event.step === step) ?? kind[kind.length - 1];
    const name = named || (sample ? (isFrame(sample) ? sample.preview ?? sample.url : sample.url) : wait.key ?? '');
    // How it went in this pass, as the replay recorded it; before its step
    // runs there is none, and the count it has seen so far stands.
    const outcome = (activity.boundary?.waitOutcomes ?? []).find(one => one.runId === pass
      && one.step === step && one.key === wait.key);
    return { wait, name, named: !!named, left: wait.count - came, sample, outcome };
  });
  // Named kinds a response intercepts at this step, before this pass has
  // produced them: what the step is expected to be answered with, on opening
  // the sequence, replaced by the row itself once it crosses.
  const expected = Object.entries(actions.names ?? {})
    .filter(([id]) => id.startsWith(`${step}|`))
    .map(([id, name]) => ({ key: id.slice(`${step}|`.length), name }))
    .map(one => ({ ...one, response: (actions.responses ?? []).find(rule => rule.key === one.key && !rule.off
      && (!rule.steps || rule.steps.includes(step))) }))
    .filter(one => one.response && !rows.some(event => event.runId === pass && keyOf(event) === one.key));
  if (!rows.length && !absent.length && !has(top) && !has(bottom) && !waiting.length && !expected.length) return null;
  const toggle = (id: string) => setReading(reading === id ? null : id);
  // The gutter moves up into the last step only; the last step moves down into the gutter.
  const movesFor = (event: BoundaryEvent | undefined, kind: string): RowMoves | undefined => recording ? undefined : {
    ...(step > 0 ? { up: () => move(event, kind, step, step - 1) } : {}),
    ...(step < stepCount ? { down: () => move(event, kind, step, step + 1) } : {}),
  };
  return (
    <ol class="activitycards">
      {top}
      {rows.map(event => (<Fragment key={rowOf(step, event)}>
        <CrossingRow
          event={event}
          base={base}
          hidden={activity.wasHidden(event)}
          rule={ruleFor(event)}
          repeats={repeatsOf.get(event)}
          seen={stability.get(keyOf(event))}
          stale={event.runId !== pass && originOf.get(event) !== 'after'}
          open={reading === rowOf(step, event)}
          onOpen={() => toggle(rowOf(step, event))}
          actions={{
            ...actions,
            waitStep: step < stepCount ? step : undefined,
            nameKey: (crossing) => `${step < stepCount ? step : 'after'}|${keyOf(crossing)}`,
          }}
          verdict={verdicts.get(rowOf(step, event))}
          moves={movesFor(event, kindOf(event))}
        />
        {notesAt?.(kindOf(event))}
      </Fragment>))}
      {absent.map(({ kind, verdict }) => (<Fragment key={`${step}|missing|${kind}`}>
        <MissingRow
          kind={kind}
          verdict={verdict}
          open={reading === `${step}|missing|${kind}`}
          onOpen={() => toggle(`${step}|missing|${kind}`)}
          moves={movesFor(undefined, kind)}
        />
        {notesAt?.(kind)}
      </Fragment>))}
      {expected.map(({ key, name, response }) => (
        <Row
          key={`expected|${key}`}
          classes={['answers', 'expected']}
          columns={[]}
          source={response!.frame ? socketName(response!.url ?? '') : (response!.method ?? 'GET')}
          way={response!.frame ? (response!.direction === 'out' ? '→' : '←') : ''}
          title="expected at this step, not yet crossed in this pass"
          label={<><span class="what named">{name}</span>
            <span class="tag">Intercepted: {response!.mode === 'local' ? 'Local' : 'Global'} Response</span></>}
          reading={null}
          slots={{}}
          open={false}
          onOpen={() => {}}
        />
      ))}
      {waiting.map(({ wait, name, named, left, sample, outcome }) => {
        const state = outcome?.state ?? (left <= 0 ? 'met' : 'pending');
        const got = outcome?.arrived ?? wait.count - left;
        const remaining = outcome?.state === 'waiting'
          ? Math.max(0, wait.seconds - (Date.now() - outcome.startedAt) / 1000).toFixed(1) : undefined;
        return (
        <Row
          key={`wait|${wait.key ?? ''}`}
          id={`wait-${step}-${wait.key ?? ''}`}
          classes={['waitrow', running || state === 'waiting' ? 'active' : '', `wait-${state}`]}
          columns={['remove']}
          source={sample ? (isFrame(sample) ? socketName(sample.url) : (sample.method ?? 'GET')) : 'wait'}
          way={sample && isFrame(sample) ? (sample.direction === 'out' ? '→' : '←') : ''}
          label={<span class={named ? 'what named' : 'what'}>{name}</span>}
          title={`a replay holds step ${step + 1} open up to ${wait.seconds}s; on a miss it ${wait.onFail === 'fail' ? 'fails the step' : 'carries on'}`}
          reading={<span class="meta">{
            state === 'waiting' ? `waiting · ${Math.max(0, wait.count - got)} left · ${remaining}s`
            : state === 'met' ? `✓ all ${wait.count} arrived`
            : state === 'failed' ? `✗ timed out · ${got} of ${wait.count} in ${wait.seconds}s · step failed`
            : state === 'carried' ? `timed out · ${got} of ${wait.count} in ${wait.seconds}s · carried on`
            : `waiting for ${wait.count} · ${wait.seconds}s`}</span>}
          slots={{ remove: () => actions.unwait?.(step, wait.key ?? '') }}
          titles={{ remove: 'stop waiting' }}
          open={reading === `${step}|wait|${wait.key ?? ''}`}
          onOpen={() => setReading(reading === `${step}|wait|${wait.key ?? ''}` ? null : `${step}|wait|${wait.key ?? ''}`)}
        >
          <WaitSettings wait={wait} onChange={(next) => actions.setWait?.(step, wait.key ?? '', next)} />
        </Row>
        );
      })}
      {bottom}
    </ol>
  );
}

function has(children: preact.ComponentChildren): boolean {
  return Array.isArray(children) ? children.length > 0 : children != null && children !== false;
}
