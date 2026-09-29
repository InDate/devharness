/**
 * The held state of each connection: which layers of the driven app are
 * stopped, what stopped each one, and where each stands.
 *
 * A layer stops through its own mechanism - the debugger for code, the
 * debugger plus the animation clock for the UI, the proxy's queue for the
 * network - and those mechanisms live with the code that owns the CDP session
 * or the proxy. What they share is this record. Every hold and every release
 * routes through it, so a release from the bench, a tool or a sequence runs
 * the same `disengage` and ends in the state the hold began from.
 *
 * The UI mechanism stops the code as part of stopping the screen, so a UI
 * hold carries the code layer with it: the reading shows code held `via` ui.
 * Releasing the code releases the screen too, since a screen whose JS runs
 * keeps changing. Releasing the screen alone leaves the code stopped, `keptBy`
 * the UI mechanism: that pause belongs to the bench's CDP session, and a pause
 * taken on one session is resumed only from that session.
 */

export type HoldLayer = 'code' | 'ui' | 'network';

export const ALL_LAYERS: readonly HoldLayer[] = ['code', 'ui', 'network'];

export type HoldSource = 'bench' | 'tool' | 'sequence' | 'breakpoint' | 'trigger';

/** Where a held layer stands: a call frame, a callback and page time, a queue length. */
export type LayerStanding = Record<string, unknown>;

export interface LayerMechanism {
  /** Layers this mechanism stops along with its own. */
  covers?: readonly HoldLayer[];
  engage(): Promise<LayerStanding | void>;
  /** Restore everything `engage` changed. */
  disengage(): Promise<void>;
  /** Move the layer on by one unit and stop it again. */
  step?(): Promise<LayerStanding | void>;
  /** Restore what `engage` changed for this layer alone, leaving the layers it covers stopped. */
  disengageKeeping?(): Promise<void>;
  /** Release a covered layer this mechanism kept stopped after its own layer was released. */
  releaseKept?(layer: HoldLayer): Promise<void>;
}

export interface LayerHold {
  layer: HoldLayer;
  source: HoldSource;
  since: number;
  /** The layer whose mechanism stopped this one, while that layer is held too. */
  via?: HoldLayer;
  /** The layer whose mechanism still holds this one after that layer was released, and alone releases it. */
  keptBy?: HoldLayer;
  standing?: LayerStanding;
}

export interface HoldReading {
  connection: string;
  held: LayerHold[];
  /** Layers asked for with no mechanism attached, so nothing stopped them. */
  unavailable: HoldLayer[];
}

export interface HoldChange {
  connection: string;
  change: 'held' | 'stepped' | 'released';
  layers: HoldLayer[];
  source?: HoldSource;
}

interface ConnectionHold {
  mechanisms: Map<HoldLayer, LayerMechanism>;
  held: Map<HoldLayer, LayerHold>;
  /** Serialises hold, step and release, so two surfaces acting at once apply in order. */
  queue: Promise<unknown>;
  /**
   * Layers a step has let run and that have not stopped again yet. The step's
   * own resume and landing pause arrive as reports like any other, and read
   * as a release and a new stop they would drop the hold's record and
   * re-record it as a breakpoint's.
   */
  stepping: Set<HoldLayer>;
}

const connections = new Map<string, ConnectionHold>();
const listeners = new Set<(change: HoldChange) => void>();

/**
 * Hold order: the network stops first, so no arrival lands in a page that is
 * already stopped and waits there to burst on release. Release runs the
 * reverse: the page runs again before the queued traffic crosses into it.
 */
const HOLD_ORDER: readonly HoldLayer[] = ['network', 'ui', 'code'];

function entry(connection: string): ConnectionHold {
  let found = connections.get(connection);
  if (!found) {
    found = { mechanisms: new Map(), held: new Map(), queue: Promise.resolve(), stepping: new Set() };
    connections.set(connection, found);
  }
  return found;
}

function serially<T>(state: ConnectionHold, work: () => Promise<T>): Promise<T> {
  const next = state.queue.then(work, work);
  state.queue = next.catch(() => undefined);
  return next;
}

function announce(change: HoldChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch { /* one listener's failure leaves the others fed */ }
  }
}

function orderOf(layers: readonly HoldLayer[]): HoldLayer[] {
  return HOLD_ORDER.filter(layer => layers.includes(layer));
}

/** The layer whose mechanism, attached, stops `layer` as part of its own hold. */
function coveringLayer(state: ConnectionHold, layer: HoldLayer): HoldLayer | undefined {
  for (const [owner, mechanism] of state.mechanisms) {
    if (owner !== layer && mechanism.covers?.includes(layer)) return owner;
  }
  return undefined;
}

/**
 * Attach the mechanism that stops `layer` on this connection. Returns the
 * detach, which drops the layer's hold record with it: a mechanism gone -
 * the bench closed, the proxy stopped - has nothing left to release.
 */
export function attachLayer(connection: string, layer: HoldLayer, mechanism: LayerMechanism): () => void {
  const state = entry(connection);
  // A mechanism replacing another starts with nothing held: what the old one
  // held went with the session or proxy that held it.
  if (state.mechanisms.has(layer)) {
    for (const [l, held] of state.held) {
      if (l === layer || held.via === layer || held.keptBy === layer) state.held.delete(l);
    }
  }
  state.mechanisms.set(layer, mechanism);
  return () => {
    if (state.mechanisms.get(layer) !== mechanism) return;
    state.mechanisms.delete(layer);
    const dropped = [layer, ...(mechanism.covers ?? [])].filter(l => {
      const held = state.held.get(l);
      return held !== undefined && (l === layer || held.via === layer || held.keptBy === layer);
    });
    for (const l of dropped) state.held.delete(l);
    if (dropped.length) announce({ connection, change: 'released', layers: dropped });
  };
}

/**
 * Stop the named layers, all three by default. A layer already held keeps
 * its source; a layer with no mechanism attached is returned as unavailable.
 * A mechanism that fails to engage leaves the layers engaged before it held,
 * and the failure propagates.
 */
export function hold(
  connection: string,
  options: { source: HoldSource; layers?: readonly HoldLayer[] },
): Promise<HoldReading> {
  const state = entry(connection);
  const asked = options.layers ?? ALL_LAYERS;
  return serially(state, async () => {
    const engaged: HoldLayer[] = [];
    for (const layer of orderOf(asked)) {
      if (state.held.has(layer)) continue;
      const via = coveringLayer(state, layer);
      if (via && asked.includes(via)) continue;
      const mechanism = state.mechanisms.get(layer);
      if (!mechanism) continue;
      const began = Date.now();
      const standing = await mechanism.engage();
      const now = Date.now();
      state.held.set(layer, { layer, source: options.source, since: now, ...(standing ? { standing } : {}) });
      engaged.push(layer);
      for (const covered of mechanism.covers ?? []) {
        // A covered layer recorded while this engage ran was stopped by it:
        // the debugger reports the UI mechanism's pause as a pause like any other.
        const existing = state.held.get(covered);
        if (existing && existing.since < began) continue;
        state.held.set(covered, { layer: covered, source: options.source, since: now, via: layer });
        engaged.push(covered);
      }
    }
    if (engaged.length) announce({ connection, change: 'held', layers: engaged, source: options.source });
    return readingOf(connection, state, asked);
  });
}

/**
 * Release the named layers, all held ones by default.
 *
 * Naming a layer held `via` another releases that other one too: the covered
 * layer runs only when its cover does. Naming the covering layer alone leaves
 * the covered one stopped where its mechanism can keep it so, recorded as
 * `keptBy` that layer, and releases it where the mechanism cannot.
 */
export function release(connection: string, options: { layers?: readonly HoldLayer[] } = {}): Promise<HoldReading> {
  const state = entry(connection);
  return serially(state, async () => {
    const named = new Set(options.layers ?? [...state.held.keys()]);
    const asked = new Set(named);
    for (const layer of [...asked]) {
      const via = state.held.get(layer)?.via;
      if (via) asked.add(via);
    }
    const released: HoldLayer[] = [];
    for (const layer of orderOf([...asked]).reverse()) {
      const held = state.held.get(layer);
      if (!held || held.via) continue;
      if (held.keptBy) {
        await state.mechanisms.get(held.keptBy)?.releaseKept?.(layer);
        state.held.delete(layer);
        released.push(layer);
        continue;
      }
      const mechanism = state.mechanisms.get(layer);
      const kept = mechanism?.disengageKeeping
        ? [...state.held].filter(([covered, other]) => other.via === layer && !named.has(covered)).map(([covered]) => covered)
        : [];
      if (mechanism) await (kept.length ? mechanism.disengageKeeping!() : mechanism.disengage());
      state.held.delete(layer);
      released.push(layer);
      for (const [covered, other] of state.held) {
        if (other.via !== layer) continue;
        if (kept.includes(covered)) {
          delete other.via;
          other.keptBy = layer;
        } else {
          state.held.delete(covered);
          released.push(covered);
        }
      }
    }
    if (released.length) announce({ connection, change: 'released', layers: released });
    return readingOf(connection, state, []);
  });
}

/** Move one held layer on by its unit - a statement, a callback, a message - and stop it again. */
export function step(connection: string, layer: HoldLayer): Promise<HoldReading> {
  const state = entry(connection);
  return serially(state, async () => {
    const held = state.held.get(layer);
    const own = held?.via ?? layer;
    const mechanism = held?.keptBy ? undefined : state.mechanisms.get(own);
    if (!held || !mechanism?.step) {
      throw new Error(`The ${layer} layer of "${connection}" is ${held ? 'held with no step' : 'not held'}.`);
    }
    state.stepping.add(own);
    if (own !== layer) state.stepping.add(layer);
    const standing = await mechanism.step();
    const ownHold = state.held.get(own);
    if (ownHold && standing) ownHold.standing = standing;
    announce({ connection, change: 'stepped', layers: [layer] });
    return readingOf(connection, state, []);
  });
}

/**
 * Record a hold that a mechanism took without being asked through `hold` -
 * a breakpoint hit, a trigger firing - so it reads and releases like any
 * other. A layer already held keeps the record it has.
 */
export function recordHeld(connection: string, layer: HoldLayer, source: HoldSource, standing?: LayerStanding): void {
  const state = entry(connection);
  state.stepping.delete(layer);
  const existing = state.held.get(layer);
  if (existing) {
    if (standing) existing.standing = standing;
    return;
  }
  state.held.set(layer, { layer, source, since: Date.now(), ...(standing ? { standing } : {}) });
  announce({ connection, change: 'held', layers: [layer], source });
}

/** Record that a layer runs again by a path outside `release` - a resume from DevTools, a navigation. */
export function recordReleased(connection: string, layer: HoldLayer): void {
  const state = connections.get(connection);
  const held = state?.held.get(layer);
  // A layer held via another runs and stops as that layer's mechanism steps it,
  // so its own resume ends nothing: the covering layer's release does. A resume
  // a step made ends nothing either: the step's landing pause follows it.
  if (!state || !held || held.via || state.stepping.has(layer)) return;
  const released: HoldLayer[] = [layer];
  state.held.delete(layer);
  for (const [covered, other] of state.held) {
    if (other.via === layer) {
      state.held.delete(covered);
      released.push(covered);
    }
  }
  announce({ connection, change: 'released', layers: released });
}

function readingOf(connection: string, state: ConnectionHold, asked: readonly HoldLayer[]): HoldReading {
  return {
    connection,
    held: orderOf([...state.held.keys()]).map(layer => ({ ...state.held.get(layer)! })),
    unavailable: asked.filter(layer => !state.held.has(layer) && !state.mechanisms.has(layer) && !coveringLayer(state, layer)),
  };
}

export function holdReading(connection: string): HoldReading {
  const state = connections.get(connection);
  return state ? readingOf(connection, state, []) : { connection, held: [], unavailable: [] };
}

/** The layers this connection can hold: those with a mechanism attached, and those one of them covers. */
export function holdableLayers(connection: string): HoldLayer[] {
  const state = connections.get(connection);
  if (!state) return [];
  return ALL_LAYERS.filter(layer => state.mechanisms.has(layer) || coveringLayer(state, layer) !== undefined);
}

export function isHeld(connection: string, layer?: HoldLayer): boolean {
  const state = connections.get(connection);
  if (!state) return false;
  return layer ? state.held.has(layer) : state.held.size > 0;
}

/** Every connection with at least one layer held. */
export function heldConnections(): string[] {
  return [...connections].filter(([, state]) => state.held.size > 0).map(([name]) => name);
}

export function watchHolds(listener: (change: HoldChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget a connection: its mechanisms and records go with the connection itself. */
export function forgetConnection(connection: string): void {
  connections.delete(connection);
}
