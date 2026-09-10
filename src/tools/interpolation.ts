/**
 * Sequence-step parameter interpolation.
 * Resolves {{var:name.path.to.field}}, {{timestamp}} and {{env:NAME}} tokens
 * inside a command's params before the executor runs it.
 *
 * Whole-string-token rule: if a string param's entire value is exactly one
 * token (e.g. params.right === "{{var:r.body.available}}"), the resolved
 * value's real type is preserved (number/object/boolean/etc). If the token
 * is embedded in a larger string (e.g. "seqkit{{timestamp}}"), the resolved
 * value is coerced with String().
 *
 * {{timestamp}} accepts an optional +N/-N millisecond offset (e.g.
 * {{timestamp+3600000}}) for expiry-style fields computed relative to the
 * run's fixed timestamp - still resolved once per run, not per token.
 *
 * {{var:...}} paths are plain dot-separated segments (a.b.c) except where a
 * real key contains a literal dot (e.g. a response field keyed 'exec.t1.s2')
 * - use bracket notation for that segment: a.b['exec.t1.s2'].c
 *
 * {{env:NAME}} reads the run's environment at run time - the file named by
 * `envFile` first, then process.env. It is how a credential is kept
 * OUT of the sequence file: the file holds the token, the value lives in the
 * environment, and neither the file nor the tool call carries the secret. An
 * unset or empty variable fails the step rather than resolving to '' - a blank
 * password submits the form and surfaces as a confusing downstream failure
 * instead of the missing configuration that caused it. Environment values are
 * strings, so a whole-string {{env:PORT}} yields "3000", not 3000.
 */

const TOKEN_BODY = String.raw`var:[^}]+|timestamp(?:[+-]\d+)?|env:[A-Za-z_][A-Za-z0-9_]*`;
const TOKEN_RE = new RegExp(String.raw`\{\{\s*(${TOKEN_BODY})\s*\}\}`, 'g');
const WHOLE_TOKEN_RE = new RegExp(String.raw`^\{\{\s*(${TOKEN_BODY})\s*\}\}$`);

/**
 * Whether a string carries any interpolation token. A step already
 * parameterised this way needs no `variables` prompt: its value is supplied at
 * run time by definition.
 */
export function hasTemplateToken(value: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(value);
}

export class InterpolationError extends Error {
  constructor(public token: string, reason: string) {
    super(`Could not resolve template token {{${token}}}: ${reason}`);
  }
}

/**
 * Split a var path into segments, honoring bracket notation for segments
 * containing characters (like literal dots) that would otherwise be
 * misread as nesting: a.b['exec.t1.s2'].c -> ['a','b','exec.t1.s2','c']
 */
function tokenizePath(path: string): string[] {
  const segments: string[] = [];
  const re = /^[^.[\]]+|\.[^.[\]]+|\['([^']*)'\]|\["([^"]*)"\]/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = re.exec(path)) !== null) {
    if (match.index !== lastIndex) {
      throw new Error(`invalid path syntax near "${path.slice(lastIndex)}"`);
    }
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(match[2]);
    else segments.push(match[0].replace(/^\./, ''));
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== path.length) {
    throw new Error(`invalid path syntax near "${path.slice(lastIndex)}"`);
  }
  return segments;
}

/**
 * Resolve a single token (without the {{ }} wrapper) against the variable store.
 */
function resolveToken(
  token: string,
  store: Record<string, any>,
  runTimestamp: number,
  runEnv?: Record<string, string>
): unknown {
  if (token.startsWith('timestamp')) {
    const offsetMatch = token.match(/^timestamp([+-]\d+)?$/);
    const offset = offsetMatch?.[1] ? parseInt(offsetMatch[1], 10) : 0;
    return runTimestamp + offset;
  }

  if (token.startsWith('env:')) {
    const name = token.slice('env:'.length);
    // The named file wins over the ambient environment. The caller named this
    // file for this run; a stale variable in the server's own environment
    // shadowing it would substitute a different credential with nothing in the
    // output to say so.
    const value = runEnv && name in runEnv ? runEnv[name] : process.env[name];
    // The reason is the variable NAME and its state, never its value: this
    // message reaches the run output and the debug log.
    if (value === undefined) {
      throw new InterpolationError(token, `${name} is not set${runEnv ? ' in the run\'s envFile or' : ' in'} this process's environment - add it to the envFile, or export it before the run (the sequence file deliberately holds no value for it)`);
    }
    if (value === '') {
      throw new InterpolationError(token, `${name} is set but empty - an empty value would be typed or sent as-is, so the step fails here instead`);
    }
    return value;
  }

  const path = token.slice('var:'.length);
  let parts: string[];
  try {
    parts = tokenizePath(path);
  } catch (e: any) {
    throw new InterpolationError(token, e.message);
  }
  const varName = parts[0];
  if (!(varName in store)) {
    throw new InterpolationError(token, `no variable named "${varName}" in the run's captured store (capture it first with a prior request({ saveAs: "${varName}" }) or inspect({ action: "evaluateExpression", saveAs: "${varName}" }) step)`);
  }

  let current: any = store[varName];
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];

    // Lazy JSON.parse when descending into a string body field
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
      } catch (e: any) {
        throw new InterpolationError(token, `cannot descend into "${key}" - preceding value is a string that is not valid JSON (${e.message})`);
      }
    }

    if (current === undefined || current === null) {
      throw new InterpolationError(token, `path stops at "${parts.slice(0, i).join('.')}" (undefined/null) before reaching "${key}"`);
    }
    current = current[key];
  }

  if (current === undefined) {
    throw new InterpolationError(token, `path "${path}" did not resolve to a value`);
  }
  return current;
}

/**
 * Resolve all tokens in a single string value.
 * Whole-string token -> typed value passthrough.
 * Embedded token(s) -> String-coerced substitution.
 */
function resolveString(
  value: string,
  store: Record<string, any>,
  runTimestamp: number,
  runEnv?: Record<string, string>
): unknown {
  const wholeMatch = value.match(WHOLE_TOKEN_RE);
  if (wholeMatch) {
    return resolveToken(wholeMatch[1], store, runTimestamp, runEnv);
  }

  TOKEN_RE.lastIndex = 0;
  if (!TOKEN_RE.test(value)) {
    return value; // no tokens present, fast path
  }
  TOKEN_RE.lastIndex = 0;

  return value.replace(TOKEN_RE, (_match, token) => {
    const resolved = resolveToken(token, store, runTimestamp, runEnv);
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function walk(value: any, store: Record<string, any>, runTimestamp: number, runEnv?: Record<string, string>): any {
  if (typeof value === 'string') {
    return resolveString(value, store, runTimestamp, runEnv);
  }
  if (Array.isArray(value)) {
    return value.map(item => walk(item, store, runTimestamp, runEnv));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      result[key] = walk(value[key], store, runTimestamp, runEnv);
    }
    return result;
  }
  return value; // number, boolean, null, undefined pass through unchanged
}

/**
 * Recursively resolve {{var:...}}/{{timestamp}} tokens throughout params.
 * runTimestamp must be computed once per sequence run (not per call) so
 * {{timestamp}} is stable across multiple steps in the same run.
 */
export function interpolateParams(
  params: Record<string, any>,
  store: Record<string, any>,
  runTimestamp: number,
  /** The run's `envFile` values, checked before process.env by {{env:NAME}}. */
  runEnv?: Record<string, string>
): Record<string, any> {
  return walk(params, store, runTimestamp, runEnv) as Record<string, any>;
}
