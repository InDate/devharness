/**
 * Tools that read the app without driving it.
 *
 * They take no proxy cursor, so a screenshot taken while a navigate is still
 * settling leaves the navigate's cursor in place rather than claiming the
 * traffic it caused. Most concurrency in a session is one driving command with
 * observers alongside, and this makes that case exact. A replayed step of one
 * of them takes no cursor either, so a run credits what crosses during it to
 * the step its recording credited.
 *
 * A tool that can cause traffic belongs on the other side of this line however
 * much it also reads.
 */
const OBSERVING_TOOLS = new Set([
  'screenshot', 'content', 'inspect', 'proxy', 'network', 'console',
  'wait', 'assert', 'check', 'dashboard', 'issues', 'message', 'source', 'config',
]);
/** Actions that read without acting, in tools whose other actions act on a connection or page. */
const OBSERVING_ACTIONS: Record<string, ReadonlySet<string>> = {
  connection: new Set(['list', 'status', 'browsers']),
  modal: new Set(['detect']),
};

export function observes(toolName: string, args: Record<string, unknown> | undefined): boolean {
  return OBSERVING_TOOLS.has(toolName)
    || (OBSERVING_ACTIONS[toolName]?.has(String(args?.action)) ?? false);
}
