/**
 * Scripts devharness runs in a page carry a `devharness://` sourceURL, so a
 * pause armed for the app's next statement that lands in one of them is told
 * apart from the app's own code by URL alone. An untagged script reports no
 * URL, the same as the app's inline and eval'd code.
 */
export const OWN_SCRIPTS = /^(pptr:|devharness:\/\/)/;

/** Own scripts whose functions call the app's code: the timer and send wrapper. */
export const WRAPS_APP_CODE = /^devharness:\/\/send-wrapper$/;

/** The prefix of a script one `inspect evaluateExpression` call ran, followed by its number. */
export const EVALUATE_SCRIPT = 'devharness://evaluate/';

export function ownScript(name: string, source: string): string {
  return `${source}\n//# sourceURL=devharness://${name}`;
}

/**
 * A `Runtime.callFunctionOn` declaration tagged the same way. Chrome wraps the
 * declaration in parentheses, so the tag ends with a newline or the closing
 * one falls inside the comment and the call fails to parse.
 */
export function ownFunction(name: string, declaration: string): string {
  return `${ownScript(name, declaration)}\n`;
}

/** The parameter carrying page source, for each CDP command that runs source in the page. */
const PAGE_SOURCE: Record<string, 'expression' | 'functionDeclaration' | 'source'> = {
  'Runtime.evaluate': 'expression',
  'Runtime.callFunctionOn': 'functionDeclaration',
  'Page.addScriptToEvaluateOnNewDocument': 'source',
};

const HAS_SOURCE_URL = /\/\/# sourceURL=/;

/**
 * A command's params with its page source tagged as devharness's own. Source
 * that already names a sourceURL keeps it, so a caller's own name stands; any
 * other command's params return unchanged.
 */
export function tagPageSource<P>(method: string, params: P): P {
  const key = PAGE_SOURCE[method];
  const source = key ? (params as Record<string, unknown> | undefined)?.[key] : undefined;
  if (typeof source !== 'string' || HAS_SOURCE_URL.test(source)) return params;
  const name = `cdp-${method.slice(method.indexOf('.') + 1)}`;
  return { ...params, [key]: key === 'functionDeclaration' ? ownFunction(name, source) : ownScript(name, source) };
}
