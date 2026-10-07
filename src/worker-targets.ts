/**
 * Worker targets - service workers, dedicated workers, shared workers.
 *
 * Every debugging tool runs against the page target, so code inside a worker
 * has been unreachable: no evaluation, no console. A worker is its own CDP
 * target with its own websocket, listed by the browser alongside the page, so
 * a client per worker reaches it without touching the page's debugger state.
 */

import CDP from 'chrome-remote-interface';
import { ownScript } from './utils/own-script.js';

/** The three target types that run script outside the page. */
const WORKER_TYPES = ['service_worker', 'worker', 'shared_worker'] as const;

export type WorkerTargetType = (typeof WORKER_TYPES)[number];

export interface WorkerTarget {
  targetId: string;
  type: WorkerTargetType;
  url: string;
  /** A client is open on it, so its console is being recorded. */
  attached: boolean;
}

export interface WorkerConsoleMessage {
  type: string;
  text: string;
  timestamp: number;
}

export class WorkerTargetNotFoundError extends Error {
  constructor(public ref: string, public available: WorkerTarget[]) {
    super(`No worker target matches "${ref}"`);
    this.name = 'WorkerTargetNotFoundError';
  }
}

export class WorkerTargetAmbiguousError extends Error {
  constructor(public ref: string, public matches: WorkerTarget[]) {
    super(`"${ref}" matches ${matches.length} worker targets`);
    this.name = 'WorkerTargetAmbiguousError';
  }
}

export class WorkerEvaluateError extends Error {
  constructor(message: string, public details?: string) {
    super(message);
    this.name = 'WorkerEvaluateError';
  }
}

/** Console output is capped per target; a chatty worker cannot grow unbounded. */
const MAX_MESSAGES = 200;

interface AttachedWorker {
  client: any;
  messages: WorkerConsoleMessage[];
}

/**
 * One browser's worker targets. Keyed by host and port, since that pair is
 * what locates a target's websocket.
 */
export class WorkerTargetRegistry {
  private attached: Map<string, AttachedWorker> = new Map();

  constructor(
    private host: string,
    private port: number,
    private listTargets: (options: { host: string; port: number }) => Promise<any[]> = CDP.List,
    private connect: (options: any) => Promise<any> = CDP
  ) {}

  async list(): Promise<WorkerTarget[]> {
    const targets = await this.listTargets({ host: this.host, port: this.port });
    return targets
      .filter((t: any) => WORKER_TYPES.includes(t.type))
      .map((t: any) => ({
        targetId: t.id,
        type: t.type as WorkerTargetType,
        url: t.url,
        attached: this.attached.has(t.id),
      }));
  }

  /**
   * A target id, or a substring of a target's URL. A substring matching more
   * than one target is refused with both named - picking the first would
   * evaluate in a worker the caller did not choose.
   */
  async resolve(ref: string): Promise<WorkerTarget> {
    const targets = await this.list();
    const byId = targets.find((t) => t.targetId === ref);
    if (byId) return byId;
    const matches = targets.filter((t) => t.url.includes(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new WorkerTargetNotFoundError(ref, targets);
    throw new WorkerTargetAmbiguousError(ref, matches);
  }

  /**
   * Evaluate inside the worker. Console output from the target is recorded
   * from the moment of first attach, so a log emitted before that is not held.
   */
  async evaluate(ref: string, expression: string, awaitPromise = true): Promise<any> {
    const target = await this.resolve(ref);
    const worker = await this.attach(target);
    const result = await worker.client.Runtime.evaluate({
      expression: ownScript('worker-evaluate', expression),
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const thrown = result.exceptionDetails.exception;
      throw new WorkerEvaluateError(
        thrown?.description || thrown?.value || result.exceptionDetails.text,
        result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  /** Console output recorded since this target was first attached. */
  async messages(ref: string): Promise<WorkerConsoleMessage[]> {
    const target = await this.resolve(ref);
    const worker = await this.attach(target);
    return [...worker.messages];
  }

  private async attach(target: WorkerTarget): Promise<AttachedWorker> {
    const existing = this.attached.get(target.targetId);
    if (existing) return existing;

    const client = await this.connect({ host: this.host, port: this.port, target: target.targetId });
    const worker: AttachedWorker = { client, messages: [] };
    const record = (type: string, text: string) => {
      worker.messages.push({ type, text, timestamp: Date.now() });
      if (worker.messages.length > MAX_MESSAGES) worker.messages.shift();
    };
    client.Runtime.consoleAPICalled((e: any) => {
      record(e.type, (e.args || []).map(describeArg).join(' '));
    });
    client.Runtime.exceptionThrown((e: any) => {
      const thrown = e.exceptionDetails?.exception;
      record('error', thrown?.description || e.exceptionDetails?.text || 'exception');
    });
    await client.Runtime.enable();
    this.attached.set(target.targetId, worker);
    return worker;
  }

  /** Closes every client. A client left open holds its worker alive. */
  async dispose(): Promise<void> {
    const workers = [...this.attached.values()];
    this.attached.clear();
    for (const worker of workers) {
      try {
        await worker.client.close();
      } catch {
        // Its target is already gone; the socket went with it.
      }
    }
  }
}

function describeArg(arg: any): string {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.className || arg.type || '';
}

const registries: Map<string, WorkerTargetRegistry> = new Map();

/** One registry per browser, so a second call reuses the open clients. */
export function getWorkerTargetRegistry(host: string, port: number): WorkerTargetRegistry {
  const key = `${host}:${port}`;
  const existing = registries.get(key);
  if (existing) return existing;
  const registry = new WorkerTargetRegistry(host, port);
  registries.set(key, registry);
  return registry;
}

/** Called when a connection closes: its browser's clients go with it. */
export async function disposeWorkerTargetRegistry(host: string, port: number): Promise<void> {
  const key = `${host}:${port}`;
  const registry = registries.get(key);
  if (!registry) return;
  registries.delete(key);
  await registry.dispose();
}
