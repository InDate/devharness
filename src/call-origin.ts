/**
 * Where a tool call came in: the MCP connection, the CLI's session socket, or
 * the bench's own server, and the sequence run it is a step of.
 *
 * A call records the channel, not the one who used it: a `! devharness` typed
 * into a session and a `devharness call` the agent runs through its shell
 * arrive on the same socket and cannot be told apart, so the channel is the
 * reading history can stand behind.
 *
 * `recorded` is set while a call that history already holds runs, so the tool
 * calls it makes on its own behalf - a launch inside a bench start, a probe
 * inside a step - are not listed as commands of their own. Inside a run only
 * a step's own call is listed, for the same reason: the executor probes the
 * page between steps, and those probes are nobody's command.
 */

import { AsyncLocalStorage } from 'async_hooks';

/** `person` is input a person made in the app while the bench recorded it. */
export type CallChannel = 'mcp' | 'cli' | 'bench' | 'person';

interface Place {
  from: CallChannel;
  run?: string;
  /** The run's id, `run-<timestamp>`, which a hold its step takes is owned by. */
  runId?: string;
  /**
   * The run's step now executing, 0-based, and the {{env:}} names that step
   * resolved from a file; one object shared by every call inside the run.
   */
  position?: { step?: number; env?: StepEnv; written?: Record<string, unknown> };
  step?: boolean;
  recorded?: boolean;
  inner?: boolean;
}

/** The {{env:}} names one step resolved from a file, and that file. */
export interface StepEnv { file: string; names: string[] }

const place = new AsyncLocalStorage<Place>();

/** Run `work` as arriving on `from`. */
export function arriveOn<T>(from: CallChannel, work: () => T): T {
  return place.run({ from }, work);
}

/** Run `work` as the run of `sequence`, keeping the channel the run was started from. */
export function withinRun<T>(sequence: string, runId: string, work: () => T): T {
  const outer = place.getStore();
  return place.run({ from: outer?.from ?? 'mcp', run: sequence, runId, recorded: false, position: {} }, work);
}

/**
 * Who a hold taken by the current call belongs to: the run's step when the
 * call runs inside a run, an agent otherwise. Read off the run, not the step
 * flag: a step's handler runs `unlisted`, which clears that flag.
 */
export function callOwner(): { kind: 'agent' } | { kind: 'run-step'; run: string; step?: number } {
  const here = place.getStore();
  if (here?.runId !== undefined) {
    return { kind: 'run-step', run: here.runId, ...(here.position?.step !== undefined ? { step: here.position.step } : {}) };
  }
  return { kind: 'agent' };
}

/** Set the step the current run is executing, which the step's own call is recorded under. */
export function atRunStep(step: number): void {
  const position = place.getStore()?.position;
  if (position) {
    position.step = step;
    delete position.env;
    delete position.written;
  }
}

/** Set the {{env:}} names the current step resolved, which its own call is recorded with. */
export function atRunStepEnv(env: StepEnv): void {
  const position = place.getStore()?.position;
  if (position) position.env = env;
}

/**
 * Set the current step's params as the sequence holds them, before its
 * tokens are resolved, which its own call is recorded with: the call itself
 * carries the resolved values, from which a token holding a common value
 * cannot be read back.
 */
export function atRunStepWritten(written: Record<string, unknown>): void {
  const position = place.getStore()?.position;
  if (position) position.written = written;
}

/** Run `work` as one step's own call inside the current run. */
export function asStep<T>(work: () => T): T {
  const outer = place.getStore();
  return outer ? place.run({ ...outer, step: true }, work) : work();
}

/**
 * Run `work` with the tool calls it makes left out of history: inside a call
 * history already holds, or as the bench's own reading of the page.
 */
export function unlisted<T>(work: () => T): T {
  const outer = place.getStore();
  return place.run({ ...(outer ?? { from: 'mcp' }), step: false, recorded: true }, work);
}

/** The sequence of the run the current call is part of, step handlers and their inner calls included. */
export function runSequenceName(): string | undefined {
  return place.getStore()?.run;
}

/** Where the current call belongs in history, or undefined for a call made on another's behalf. */
export function historyPlace(): { from: CallChannel; run?: string; runStep?: number; env?: StepEnv; written?: Record<string, unknown> } | undefined {
  const here = place.getStore();
  if (!here || here.recorded) return undefined;
  if (here.run !== undefined && !here.step) return undefined;
  return {
    from: here.from,
    ...(here.run !== undefined ? { run: here.run } : {}),
    ...(here.run !== undefined && here.position?.step !== undefined ? { runStep: here.position.step } : {}),
    ...(here.run !== undefined && here.position?.env ? { env: here.position.env } : {}),
    ...(here.run !== undefined && here.position?.written ? { written: here.position.written } : {}),
  };
}

/** The channel of a call that entered from outside, or undefined for a call made inside another call or run. */
export function entryChannel(): CallChannel | undefined {
  const here = place.getStore();
  if (!here || here.recorded || here.run !== undefined) return undefined;
  return here.from;
}

/** The channel the outermost call arrived on, read the same inside a run or a call it made. */
export function originChannel(): CallChannel | undefined {
  return place.getStore()?.from;
}

/**
 * Run `work` as a call made by another call, a run's step or the bench. Its
 * reply returns to the code that made it, and any part of it reaches an agent
 * only as that code passes it on.
 */
export function asInnerCall<T>(work: () => T): T {
  const outer = place.getStore();
  return place.run({ ...(outer ?? { from: 'mcp' }), inner: true }, work);
}

/**
 * Whether the reply being built returns to an agent whole: a call over MCP or
 * the CLI, outside any other call and any bench request. A once-per-session
 * block spent on any other reply would never be read.
 */
export function replyReturnsToAgent(): boolean {
  const here = place.getStore();
  if (!here) return true;
  return here.inner !== true && here.from !== 'bench';
}
