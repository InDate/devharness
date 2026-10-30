/**
 * The call an `inspect evaluateExpression` runs under, carried to the requests
 * its code starts.
 *
 * An evaluate takes no proxy cursor, so a request it starts crosses under
 * whichever cursor stands. Each evaluation instead runs as a script named
 * `devharness://evaluate/<n>`, and Chrome reports that name on the stack of
 * every request the script's code starts; the name maps back to the call's
 * cursor here, which credits the request to that call alone.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { EVALUATE_SCRIPT } from '../utils/own-script.js';
import type { ProxyCursor } from './intercept-proxy.js';

const crediting = new AsyncLocalStorage<ProxyCursor>();

/** Run `work` with `cursor` as the call its evaluations credit. */
export function creditingEvaluatesTo<T>(cursor: ProxyCursor | undefined, work: () => T): T {
  return cursor ? crediting.run(cursor, work) : work();
}

/** The cursor the call in flight credits its evaluations to. */
export function evaluateCredit(): ProxyCursor | undefined {
  return crediting.getStore();
}

/** Scripts named, oldest first; a request reported after its script is evicted keeps the credit of its crossing. */
const scripts = new Map<number, ProxyCursor>();
const MAX_SCRIPTS = 500;
let scriptSeq = 0;

/**
 * The script name one evaluation runs under, numbered and mapped to the call's
 * cursor; undefined for an evaluation outside any call history holds, which
 * runs under the plain `evaluate` name and credits nothing.
 */
export function evaluateScriptName(): string | undefined {
  const cursor = crediting.getStore();
  if (!cursor) return undefined;
  const n = ++scriptSeq;
  scripts.set(n, { ...cursor });
  if (scripts.size > MAX_SCRIPTS) scripts.delete(scripts.keys().next().value as number);
  return `${EVALUATE_SCRIPT.slice('devharness://'.length)}${n}`;
}

/** The cursor of the evaluation a script URL names. */
export function cursorOfScript(url: string): ProxyCursor | undefined {
  if (!url.startsWith(EVALUATE_SCRIPT)) return undefined;
  const n = Number(url.slice(EVALUATE_SCRIPT.length));
  return Number.isInteger(n) ? scripts.get(n) : undefined;
}
