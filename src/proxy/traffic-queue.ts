/**
 * The network layer's hold: crossings that arrive while the traffic is held
 * wait here and cross in arrival order on release, one at a time on a step.
 *
 * The proxy offers each crossing before forwarding it. While nothing is held
 * `offer` returns false and the proxy forwards as it always has; while held it
 * keeps the crossing and returns true, and the crossing's `deliver` runs when
 * the queue lets it through. Socket pings never reach here: `ws` answers them
 * on each side of the proxy, so a held socket stays open.
 *
 * One queue across every socket and request keeps the order the crossings
 * arrived in, which is the order the page would have received them.
 */

import type { LayerMechanism, LayerStanding } from '../hold.js';

export interface QueuedCrossing {
  kind: 'frame' | 'response';
  url: string;
  direction?: 'sent' | 'received';
  preview?: string;
  deliver: () => void;
}

export interface QueuedItem {
  id: number;
  kind: QueuedCrossing['kind'];
  url: string;
  direction?: QueuedCrossing['direction'];
  preview?: string;
  queuedAt: number;
  /** How long it has waited: past the app's own timeout, its release arrives to a request already failed. */
  ageMs: number;
}

export class TrafficQueue {
  private holding = false;
  private seq = 0;
  private items: Array<QueuedCrossing & { id: number; queuedAt: number }> = [];

  get held(): boolean {
    return this.holding;
  }

  /** Keep the crossing while held and return true; return false for the caller to forward it now. */
  offer(crossing: QueuedCrossing): boolean {
    if (!this.holding) return false;
    this.items.push({ ...crossing, id: ++this.seq, queuedAt: Date.now() });
    return true;
  }

  list(now = Date.now()): QueuedItem[] {
    return this.items.map(({ deliver: _deliver, ...item }) => ({ ...item, ageMs: now - item.queuedAt }));
  }

  standing(now = Date.now()): LayerStanding {
    const oldest = this.items[0];
    return { queued: this.items.length, ...(oldest ? { oldestMs: now - oldest.queuedAt } : {}) };
  }

  /** Let the oldest crossing through and keep holding. */
  stepOne(): QueuedItem | undefined {
    const next = this.items.shift();
    if (!next) return undefined;
    const { deliver, ...item } = next;
    runDeliver(deliver);
    return { ...item, ageMs: Date.now() - item.queuedAt };
  }

  /**
   * Let one chosen crossing through and keep the rest held. Taken out of
   * arrival order on purpose: the page receives this one ahead of those that
   * arrived before it, which is the effect being asked for.
   */
  releaseOne(id: number): QueuedItem | undefined {
    const at = this.items.findIndex(item => item.id === id);
    if (at < 0) return undefined;
    const [chosen] = this.items.splice(at, 1);
    const { deliver, ...item } = chosen;
    runDeliver(deliver);
    return { ...item, ageMs: Date.now() - item.queuedAt };
  }

  hold(): void {
    this.holding = true;
  }

  /** Stop holding and let every queued crossing through, in arrival order. */
  releaseAll(): number {
    this.holding = false;
    const drained = this.items.splice(0);
    for (const item of drained) runDeliver(item.deliver);
    return drained.length;
  }

  /** The network layer's mechanism for the hold record. */
  mechanism(): LayerMechanism {
    return {
      engage: async () => {
        this.hold();
        return this.standing();
      },
      disengage: async () => {
        this.releaseAll();
      },
      step: async () => {
        this.stepOne();
        return this.standing();
      },
    };
  }
}

/** A delivery to a socket or response that closed while queued throws; the rest of the queue still crosses. */
function runDeliver(deliver: () => void): void {
  try { deliver(); } catch { /* the far side closed while the crossing waited */ }
}
