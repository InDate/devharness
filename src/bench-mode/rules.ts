import { getProxy } from '../proxy/registry.js';
import type { BoundaryRule, HiddenKind } from '../bench/wire.js';
import { readPayload, savePayload } from '../saved-payloads.js';
import { type BenchSession, type ResponseUse, sessions } from './session.js';

/**
 * Where a connection's rules are held: the bench session open on it, or, for a
 * run with no bench open, a holder of the same fields. One holder per
 * connection, so a run arms, reads and reports its rules through the same
 * functions whether the bench is open or not.
 */
export type RuleHolder = Pick<BenchSession,
  'boundaryRules' | 'boundaryNames' | 'boundaryPins' | 'site' | 'uses' | 'siteWritten'
  | 'hiddenKinds' | 'hiddenUses' | 'rulesWritten'> & {
  /** The sequence a holder with no bench session was armed for. */
  armedFor?: string;
};

const standalone = new Map<string, RuleHolder>();

export function holderOf(connection: string): RuleHolder | undefined {
  return sessions.get(connection) ?? standalone.get(connection);
}

function isBench(holder: RuleHolder): holder is BenchSession {
  return 'stepBreakpointsSet' in holder;
}

/** Reads a site's stored responses and hidden kinds. */
export interface SiteReader {
  rules: (origin: string) => Promise<Array<Record<string, unknown>>>;
  hidden: (origin: string) => Promise<Array<Record<string, unknown>>>;
}

/**
 * The rules, each carrying the count its pin has served.
 *
 * The count is held on the pin, which is the thing the wire passes through;
 * the rule holds the decision and is stamped zero when it arms. Reading the
 * count back here stops a rule that is firing from reading as never fired,
 * which sends a reader to correct a key that already matches.
 *
 * A `hide` rule arms no pin and stays at zero: it changes what the list shows
 * and nothing crosses under it.
 */
export function rulesOf(connection: string): BoundaryRule[] {
  const session = holderOf(connection);
  if (!session) return [];
  const proxy = getProxy(connection);
  const served = new Map<string, { hits: number; matchedAs?: 'field' | 'text' }>();
  if (proxy) {
    for (const pin of proxy.listPins()) served.set(pin.id, { hits: pin.hits });
    for (const pin of proxy.listFramePins()) {
      served.set(pin.id, { hits: pin.hits, matchedAs: pin.field ? 'field' : 'text' });
    }
  }
  return [...(session.boundaryRules?.values() ?? [])].map(rule => {
    const pin = session.boundaryPins?.get(rule.key);
    const live = pin === undefined ? undefined : served.get(pin);
    const use = useOf(session, rule);
    return {
      ...rule, ...live,
      ...(use === 'none' ? { off: true } : {}),
      ...(Array.isArray(use) ? { steps: use } : {}),
      ...(rule.mode === 'local' && rule.owner !== nameOf(session) ? { foreign: true } : {}),
    };
  });
}

/**
 * What the open sequence says, or else the response's mode: `optOut` answers
 * everywhere, `optIn` nowhere. A `local` response answers only in the
 * sequence it belongs to, whatever another says.
 */
function useOf(session: RuleHolder, rule: BoundaryRule): ResponseUse {
  if (rule.mode === 'local' && rule.owner !== nameOf(session)) return 'none';
  return session.uses?.get(rule.key) ?? (rule.mode === 'optOut' ? 'all' : 'none');
}

/** The sequence being recorded, or else the one open. */
function nameOf(session: RuleHolder): string | undefined {
  if (!isBench(session)) return session.armedFor;
  return session.recordingSequence ? session.recordingName : session.sequences?.active()?.name;
}

/** A use as the bench sends it; nothing for anything else. */
export function useFrom(raw: unknown): ResponseUse | undefined {
  if (raw === 'none' || raw === 'all') return raw;
  if (!Array.isArray(raw)) return undefined;
  const steps = [...new Set(raw.filter((n): n is number => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
  return steps.length ? steps : 'none';
}

/** A rule as a file or the bench sends it; nothing for one with no key. */
export function ruleFrom(raw: Record<string, unknown>): BoundaryRule | undefined {
  const key = String(raw.key ?? '');
  if (!key) return undefined;
  return {
    key,
    verb: (raw.verb === 'block' || raw.verb === 'hide') ? raw.verb : 'answer',
    ...(raw.frame ? { frame: true } : {}),
    ...(typeof raw.method === 'string' && raw.method ? { method: raw.method } : {}),
    ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
    ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
    ...(typeof raw.payload === 'string' && raw.payload ? { payload: raw.payload } : {}),
    ...(raw.status !== undefined ? { status: String(raw.status) } : {}),
    ...(typeof raw.recorded === 'string' ? { recorded: raw.recorded } : {}),
    ...(raw.edited === true ? { edited: true } : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(raw.direction === 'out' || raw.direction === 'in' ? { direction: raw.direction } : {}),
    ...(raw.mode === 'local' || raw.mode === 'optIn' || raw.mode === 'optOut' ? { mode: raw.mode } : {}),
    ...(typeof raw.owner === 'string' && raw.owner ? { owner: raw.owner } : {}),
    // Dropped here, a saved rule comes back without the values its dropped
    // constraints were recorded with, so the round trip through the file
    // undoes the widening and takes the row that reverses it.
    ...(raw.staged !== null && typeof raw.staged === 'object'
      ? { staged: raw.staged as BoundaryRule['staged'] } : {}),
  };
}

/**
 * A response as the site file holds it: what the session reads off the pin
 * and what the open sequence's use of it sets, left out.
 */
function storedRule(rule: BoundaryRule): BoundaryRule {
  const { hits: _hits, matchedAs: _how, steps: _steps, off: _off, step: _step, foreign: _foreign, ...kept } = rule;
  return kept;
}

export function namesOf(connection: string): Record<string, string> {
  return Object.fromEntries(sessions.get(connection)?.boundaryNames ?? []);
}

/** What a name is kept against, in words: a kind, or a kind on one step. */
export function nameTarget(key: string): string {
  const row = /^(\d+|after)\|(.*)$/.exec(key);
  if (!row) return key;
  return `${row[2]} on ${row[1] === 'after' ? 'the gutter' : `step ${Number(row[1]) + 1}`}`;
}

/**
 * Save a payload, and re-arm every replacement serving it, so each serves the
 * payload as it now stands.
 */
export async function savePayloadFor(connection: string, name: string, content: string): Promise<string | undefined> {
  const failure = await savePayload(name, content);
  if (failure) return failure;
  const session = holderOf(connection);
  const serving = [...(session?.boundaryRules?.values() ?? [])].filter(rule => rule.payload === name);
  for (const rule of serving) setBoundaryRule(connection, rule);
  if (serving.length) await persistRules(connection, false, `payload ${name} changed, served by ${serving.length}`);
  return undefined;
}

/** Name a kind of traffic, or with an empty name go back to its payload. */
export function setBoundaryName(connection: string, key: string, name: string): void {
  const session = holderOf(connection);
  if (!session || !key) return;
  const names = session.boundaryNames ??= new Map();
  if (name.trim()) names.set(key, name.trim());
  else names.delete(key);
}

/**
 * Arm one rule at the proxy, replacing whatever stood against the same key.
 *
 * `answer` pins the body, so the call is served locally and never reaches the
 * server. `block` pins an empty 204 for a request and drops a frame outright,
 * which is the same guarantee by the only two mechanisms the wire allows.
 * `hide` arms nothing: it decides what the list shows, not what crosses.
 */
export function setBoundaryRule(connection: string, rule: BoundaryRule): BoundaryRule[] {
  const session = holderOf(connection);
  if (!session) return [];
  const rules = session.boundaryRules ??= new Map();
  const pins = session.boundaryPins ??= new Map();
  const proxy = getProxy(connection);

  // An edit keeps the response's type and the sequence a local one belongs
  // to; a new response is local to the sequence it was made in.
  const staging = rule.step;
  const prior = rules.get(rule.key);
  const mode = rule.mode ?? prior?.mode ?? 'local';
  const owner = mode === 'local' ? rule.owner ?? prior?.owner ?? nameOf(session) : undefined;
  const { owner: _owner, ...rest } = storedRule(rule);
  rule = { ...rest, mode, ...(owner ? { owner } : {}) };
  const use = useOf(session, rule);

  // One decision per key: the pin behind the old one goes with it, or the
  // proxy keeps answering from a rule the list no longer shows.
  const previous = pins.get(rule.key);
  if (previous && proxy) proxy.unpin(previous);
  pins.delete(rule.key);

  // A constraint dropped from the rule leaves no value to bind it back with,
  // and the editor's row for it goes with the value. Carrying the recorded
  // values forward across the replace keeps that row offering the binding.
  const staged = {
    ...rules.get(rule.key)?.staged,
    ...rule.staged,
    ...(staging !== undefined ? { step: staging } : {}),
    ...(rule.method !== undefined ? { method: rule.method } : {}),
    ...(rule.url !== undefined ? { url: rule.url } : {}),
    ...(rule.direction !== undefined ? { direction: rule.direction } : {}),
  };
  rule = Object.keys(staged).length > 0 ? { ...rule, staged } : rule;

  // A saved payload is read as it stands now, so its file is what is served.
  if (rule.payload) {
    const saved = readPayload(rule.payload);
    if (saved !== undefined) rule = { ...rule, body: saved };
  }

  if (proxy && rule.verb !== 'hide' && use !== 'none') {
    const body = rule.verb === 'answer' ? (rule.body ?? '') : '';
    if (rule.frame) {
      // Bound to the socket and direction the frame was read from. Without
      // them the payload text is the whole predicate, and one rule answers
      // every socket carrying that text, both ways.
      const pin = proxy.pinFrame({
        textIncludes: rule.key,
        ...(rule.url ? { urlIncludes: rule.url } : {}),
        ...(rule.direction ? { direction: rule.direction === 'out' ? 'sent' as const : 'received' as const } : {}),
        ...(Array.isArray(use) ? { steps: use } : {}),
        ...(rule.verb === 'answer' ? { replaceWith: body } : {}),
      });
      pins.set(rule.key, pin.id);
    } else {
      const pin = proxy.pin({
        urlIncludes: rule.key,
        ...(rule.method ? { method: rule.method } : {}),
        ...(Array.isArray(use) ? { steps: use } : {}),
        status: rule.verb === 'answer' ? (Number(rule.status) || 200) : 204,
        body,
      });
      pins.set(rule.key, pin.id);
    }
  }

  rules.set(rule.key, { ...rule, hits: 0 });
  return rulesOf(connection);
}

/** Take one rule out of the armed set, and the pin it armed with it. */
function dropRule(session: RuleHolder, connection: string, key: string): void {
  const pin = session.boundaryPins?.get(key);
  if (pin) getProxy(connection)?.unpin(pin);
  session.boundaryPins?.delete(key);
  session.boundaryRules?.delete(key);
}

/**
 * Drop the response against one key, from the site file and so from every
 * sequence on the site.
 */
export function clearBoundaryRule(connection: string, key: string): BoundaryRule[] {
  const session = holderOf(connection);
  if (!session) return [];
  dropRule(session, connection, key);
  session.uses?.delete(key);
  return rulesOf(connection);
}

/**
 * Set how the open sequence uses one response, and re-arm it.
 *
 * A use its mode already gives - every step under `optOut`, none under
 * `optIn` - is not recorded, so the sequence's file lists only where it
 * differs from the site, which is what the panel lists under a response.
 */
export function setResponseUse(connection: string, key: string, use: ResponseUse): BoundaryRule[] {
  const session = holderOf(connection);
  const rule = session?.boundaryRules?.get(key);
  if (!session || !rule) return rulesOf(connection);
  const uses = session.uses ??= new Map();
  const given = rule.mode === 'optOut' ? 'all' : 'none';
  if (use === given) uses.delete(key);
  else uses.set(key, use);
  return setBoundaryRule(connection, rule);
}

/**
 * Set which sequences a response answers in, and re-arm it. Made local, it
 * belongs to the open sequence.
 */
export function setResponseMode(connection: string, key: string, mode: 'local' | 'optIn' | 'optOut'): BoundaryRule[] {
  const session = holderOf(connection);
  const rule = session?.boundaryRules?.get(key);
  if (!session || !rule) return rulesOf(connection);
  const use = useOf(session, rule);
  const { owner: _owner, ...rest } = rule;
  setBoundaryRule(connection, { ...rest, mode, ...(mode === 'local' ? { owner: nameOf(session) } : {}) });
  return setResponseUse(connection, key, use);
}

/** Whether the open sequence keeps a hidden kind out of its list: by its type, unless it says otherwise. */
function hiddenHere(session: RuleHolder, kind: HiddenKind): boolean {
  if (kind.mode === 'local') return kind.owner === nameOf(session);
  return session.hiddenUses?.get(kind.key) ?? kind.mode === 'optOut';
}

/** Every hidden kind, each marked `off` where the open sequence lists it anyway. */
export function hiddenOf(connection: string): HiddenKind[] {
  const session = holderOf(connection);
  if (!session) return [];
  return [...(session.hiddenKinds?.values() ?? [])]
    .map(kind => (hiddenHere(session, kind) ? kind : { ...kind, off: true }));
}

/** A hidden kind as a file or the bench gives it; nothing for one with no key. */
function hiddenFrom(raw: Record<string, unknown>): HiddenKind | undefined {
  const key = String(raw.key ?? '');
  if (!key) return undefined;
  return {
    key,
    mode: raw.mode === 'optIn' || raw.mode === 'optOut' ? raw.mode : 'local',
    ...(typeof raw.owner === 'string' && raw.owner ? { owner: raw.owner } : {}),
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(raw.frame ? { frame: true } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(raw.direction === 'out' || raw.direction === 'in' ? { direction: raw.direction } : {}),
    ...(typeof raw.method === 'string' && raw.method ? { method: raw.method } : {}),
    ...(raw.any === true ? { any: true } : {}),
    ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
  };
}

/**
 * Keep a kind out of the open sequence's list. A kind hidden nowhere yet is
 * hidden here only; one the site already hides by another type is taken up
 * by this sequence.
 */
export function hideKind(connection: string, raw: Record<string, unknown>): void {
  const session = holderOf(connection);
  const kind = hiddenFrom(raw);
  if (!session || !kind) return;
  const kinds = session.hiddenKinds ??= new Map();
  const held = kinds.get(kind.key);
  if (!held) {
    // Local unless the rule was made with another type; an opt-in rule made
    // here is opted into here.
    const mode = raw.mode === 'optIn' || raw.mode === 'optOut' ? raw.mode : 'local';
    kinds.set(kind.key, { ...kind, mode, ...(mode === 'local' && nameOf(session) ? { owner: nameOf(session) } : {}) });
    if (mode === 'optIn') setHiddenUse(connection, kind.key, true);
    return;
  }
  setHiddenUse(connection, kind.key, true);
}

/** Show a kind again everywhere: its hiding leaves the site file. */
export function unhideKind(connection: string, key: string): void {
  const session = holderOf(connection);
  session?.hiddenKinds?.delete(key);
  session?.hiddenUses?.delete(key);
}

/** Hide a kind in the open sequence, or list it there; a choice its type already gives is not recorded. */
export function setHiddenUse(connection: string, key: string, on: boolean): void {
  const session = holderOf(connection);
  const kind = session?.hiddenKinds?.get(key);
  if (!session || !kind) return;
  const uses = session.hiddenUses ??= new Map();
  if (kind.mode === 'local') {
    if (!on && kind.owner === nameOf(session)) kinds(session).delete(key);
    return;
  }
  if (on === (kind.mode === 'optOut')) uses.delete(key);
  else uses.set(key, on);
}

/** Change which sequences a hidden kind is hidden in. Made local, it belongs to the open sequence. */
export function setHiddenMode(connection: string, key: string, mode: HiddenKind['mode']): void {
  const session = holderOf(connection);
  const kind = session?.hiddenKinds?.get(key);
  if (!session || !kind) return;
  const here = hiddenHere(session, kind);
  const { owner: _owner, ...rest } = kind;
  kinds(session).set(key, { ...rest, mode, ...(mode === 'local' && nameOf(session) ? { owner: nameOf(session) } : {}) });
  session.hiddenUses?.delete(key);
  if (mode !== 'local') setHiddenUse(connection, key, here);
}

export function kinds(session: RuleHolder): Map<string, HiddenKind> {
  return session.hiddenKinds ??= new Map();
}

/**
 * Write the session's responses and hidden kinds to the site file, and the
 * open sequence's uses of them, its names and the refuse setting onto the
 * sequence. Answers the failure text, or what was written onto the sequence.
 *
 * Called on every change, so a rule made is a rule kept: an explicit save was
 * a step that, forgotten, lost every decision with the session. While a
 * recording runs there is no sequence file to write to, and its part is
 * written once it lands. `force` writes an empty set too, which a change never
 * needs to.
 */
export async function persistRules(connection: string, force = false, change?: string): Promise<string | undefined> {
  const session = sessions.get(connection);
  if (!session?.sequences) return undefined;

  // The site file is written apart from the sequence: it has one whether or
  // not a sequence is open, and a recording has no sequence file yet.
  const responses = [...(session.boundaryRules?.values() ?? [])].map(storedRule);
  const hidden = [...(session.hiddenKinds?.values() ?? [])];
  const siteNow = JSON.stringify([responses, hidden]);
  if (session.site && siteNow !== (session.siteWritten ?? '[[],[]]')) {
    const failure = await session.sequences.saveSiteRules(session.site, responses as unknown as Array<Record<string, unknown>>,
      change, hidden as unknown as Array<Record<string, unknown>>);
    if (failure) {
      session.sequenceFailure = failure;
      return failure;
    }
    session.siteWritten = siteNow;
  }

  if (session.recordingSequence || !session.sequences.active()) return undefined;
  const held = [...(session.uses?.entries() ?? [])].filter(([key]) => session.boundaryRules?.has(key));
  const off = held.filter(([, use]) => use === 'none').map(([key]) => key);
  const on = held.filter(([, use]) => use !== 'none')
    .map(([key, use]) => (Array.isArray(use) ? { key, steps: use } : { key }));
  const refuseWrites = getProxy(connection)?.refusesWrites ?? false;
  const names = namesOf(connection);
  const any = refuseWrites || Object.keys(names).length > 0 || held.length > 0
    || (session.hiddenUses?.size ?? 0) > 0;
  if (!force && !any && !session.rulesWritten) return undefined;
  const hiddenUses = [...(session.hiddenUses?.entries() ?? [])].filter(([key]) => session.hiddenKinds?.has(key));
  const failure = await session.sequences.saveBoundaryRules([], refuseWrites, names, change, off, on, {
    on: hiddenUses.filter(([, hid]) => hid).map(([key]) => key),
    off: hiddenUses.filter(([, hid]) => !hid).map(([key]) => key),
  });
  if (failure) {
    session.sequenceFailure = failure;
    return failure;
  }
  session.rulesWritten = any;
  return `${held.length} response use${held.length === 1 ? '' : 's'}`
    + `${refuseWrites ? ', refusing unmatched writes,' : ''} written onto the sequence`;
}

/**
 * Arm the site's responses as the open sequence uses them, with its names,
 * hidden kinds and refuse setting, replacing whatever the session held.
 *
 * A response kept in the site file arms nothing by sitting there. Opening the
 * sequence is the point it becomes live, so the panel reads what will happen
 * rather than nothing, and the first pass serves the pinned body rather than
 * the server's.
 *
 * The uses that stood for the sequence being closed go with it: they were that
 * sequence's choices, and leaving them armed answers traffic the open sequence
 * never asked about.
 */
export async function armSavedRules(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session?.sequences) return;
  await armHeldRules(connection, session.sequences.openBoundaryRules(),
    session.sequences.siteOf() ?? originOf(session.page.url()));
}

/** What a sequence holds about its traffic: its own old responses, the refuse setting, its names, and its uses of the site's rules. */
export interface HeldRules {
  rules: Array<Record<string, unknown>>;
  refuseWrites: boolean;
  names?: Record<string, string>;
  off?: string[];
  on?: Array<{ key: string; steps?: number[] }>;
  hiddenOn?: string[];
  hiddenOff?: string[];
}

/** The rules a loaded sequence carries, as opening it reads them. */
export function heldRulesOf(sequence: object | undefined): HeldRules {
  const held = (sequence ?? {}) as {
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
}

async function armHeldRules(connection: string, held: HeldRules, site: string | undefined, reader?: SiteReader): Promise<void> {
  const session = holderOf(connection);
  if (!session) return;
  session.boundaryNames = new Map(Object.entries(held.names ?? {}));
  session.rulesWritten = held.rules.length > 0 || held.refuseWrites
    || session.boundaryNames.size > 0 || (held.off?.length ?? 0) > 0 || (held.on?.length ?? 0) > 0;
  getProxy(connection)?.refuseUnmatchedWrites(held.refuseWrites);
  const uses = new Map<string, ResponseUse>([
    ...(held.off ?? []).map(key => [key, 'none'] as const),
    ...(held.on ?? []).map(({ key, steps }) => [key, steps?.length ? steps : 'all'] as const),
  ]);
  const hiddenUses = new Map<string, boolean>([
    ...(held.hiddenOn ?? []).map(key => [key, true] as const),
    ...(held.hiddenOff ?? []).map(key => [key, false] as const),
  ]);
  await armSiteRules(connection, site, uses, hiddenUses, reader);
  // A response kept on the sequence before responses moved to the site file:
  // moved there, used by this sequence where it answered before.
  for (const raw of held.rules) {
    const rule = ruleFrom(raw);
    if (rule?.verb === 'hide') {
      if (!session.hiddenKinds?.has(rule.key)) hideKind(connection, { ...raw, label: rule.label });
      continue;
    }
    if (!rule || session.boundaryRules?.has(rule.key)) continue;
    setBoundaryRule(connection, { ...rule, mode: 'local' });
    setResponseUse(connection, rule.key, rule.step !== undefined ? [rule.step] : 'all');
  }
  // Old hides moved out of the responses are written back at once, so the
  // site file stops holding a hide where an answer belongs.
  if (isBench(session) && session.siteWritten === 'moved') await persistRules(connection, false, 'hidden kinds moved to their own list');
}

/**
 * Arm a sequence's rules for a run of it on `connection`, as opening it in
 * the bench arms them, and answer what puts the connection back afterwards.
 *
 * A bench already open on the sequence holds them armed, and nothing changes.
 * A bench open on another sequence is re-armed for its own once the run ends;
 * with no bench open, the run's holder is dropped and its pins with it.
 */
export async function armForRun(
  connection: string, sequence: object & { name: string }, site: string | undefined, reader: SiteReader,
): Promise<() => Promise<void>> {
  const bench = sessions.get(connection);
  if (bench && nameOf(bench) === sequence.name) return async () => {};
  if (!bench) standalone.set(connection, { armedFor: sequence.name });
  await armHeldRules(connection, heldRulesOf(sequence), site, reader);
  return async () => {
    const holder = holderOf(connection);
    for (const key of [...(holder?.boundaryRules?.keys() ?? [])]) if (holder) dropRule(holder, connection, key);
    getProxy(connection)?.refuseUnmatchedWrites(false);
    if (sessions.get(connection)) await armSavedRules(connection);
    else standalone.delete(connection);
  };
}

/**
 * Replace every held response with the site's, used as `uses` says.
 *
 * What a new recording starts from as well as what an opened sequence builds
 * on: without it a recording kept answering from whichever sequence was open
 * before it, and saved those answers as its own.
 */
export async function armSiteRules(
  connection: string, site: string | undefined, uses: Map<string, ResponseUse>,
  hiddenUses: Map<string, boolean> = new Map(), reader?: SiteReader,
): Promise<void> {
  const session = holderOf(connection);
  const bench = session && isBench(session) ? session.sequences : undefined;
  const read = reader ?? (bench ? { rules: bench.openSiteRules, hidden: bench.openSiteHidden } : undefined);
  if (!session || !read) return;
  for (const key of [...(session.boundaryRules?.keys() ?? [])]) dropRule(session, connection, key);
  session.site = site;
  session.uses = uses;
  session.hiddenUses = hiddenUses;
  session.hiddenKinds = new Map();
  const raws = site ? await read.rules(site).catch(() => []) : [];
  const hidden = site ? await read.hidden(site).catch(() => []) : [];
  for (const raw of hidden) {
    const kind = hiddenFrom(raw);
    if (kind) session.hiddenKinds.set(kind.key, kind);
  }
  // A kind hidden before hiding had its own list was kept as a response
  // with the verb `hide`; it moves to the hidden list, and the next write
  // takes it out of the responses.
  let moved = false;
  for (const raw of raws) {
    const rule = ruleFrom(raw);
    if (rule?.verb === 'hide') {
      const kind = hiddenFrom({ ...raw, mode: rule.mode === 'optIn' || rule.mode === 'optOut' ? rule.mode : 'local' });
      if (kind && !session.hiddenKinds.has(kind.key)) session.hiddenKinds.set(kind.key, kind);
      moved = true;
      continue;
    }
    if (rule) setBoundaryRule(connection, rule);
  }
  session.siteWritten = moved ? 'moved'
    : JSON.stringify([[...(session.boundaryRules?.values() ?? [])].map(storedRule), [...session.hiddenKinds.values()]]);
}

/** `http://localhost:7788/a?b` → `http://localhost:7788`; nothing for a page with no web origin. */
export function originOf(url: string | undefined): string | undefined {
  try {
    const origin = url ? new URL(url).origin : 'null';
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** What puts a connection back after a paused run, by the run's id, until the run ends. */
const armedRuns = new Map<string, () => Promise<void>>();

/** Keep a paused run's rules armed until `releaseArmedRun` names it. */
export function keepArmedForRun(runId: string, release: () => Promise<void>): void {
  armedRuns.set(runId, release);
}

export async function releaseArmedRun(runId: string | undefined): Promise<void> {
  if (runId === undefined) return;
  const release = armedRuns.get(runId);
  armedRuns.delete(runId);
  await release?.().catch(() => {});
}
