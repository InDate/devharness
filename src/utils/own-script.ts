/**
 * Scripts devharness runs in a page carry a `devharness://` sourceURL, so a
 * pause armed for the app's next statement that lands in one of them is told
 * apart from the app's own code by URL alone. An untagged script reports no
 * URL, the same as the app's inline and eval'd code.
 */
export const OWN_SCRIPTS = /^(pptr:|devharness:\/\/)/;

/** Own scripts whose functions call the app's code: the timer and send wrapper. */
export const WRAPS_APP_CODE = /^devharness:\/\/send-wrapper$/;

export function ownScript(name: string, source: string): string {
  return `${source}\n//# sourceURL=devharness://${name}`;
}
