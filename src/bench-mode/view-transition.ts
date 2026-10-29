/**
 * A view transition the hold stopped in flight.
 *
 * While a view transition is active Chrome hit-tests the whole document as its
 * root element, so every pick lands on `html` and a capture can only be of the
 * whole page. A transition finishes in a few hundred milliseconds when the page
 * runs; held, it stands for as long as the hold does. The bench names it and
 * offers to skip it to its end, the state the DOM under its snapshot already
 * holds.
 */
import type { BenchSession } from './session.js';
import { sessions } from './session.js';
import { request } from './cdp.js';
import { ownScript } from '../utils/own-script.js';
import type { ViewTransitionView } from '../bench/wire.js';

const READ = `(() => {
  let active = false;
  try { active = document.documentElement.matches(':active-view-transition'); } catch { return null; }
  if (!active) return null;
  const names = new Set();
  for (const animation of document.getAnimations()) {
    const group = /^::view-transition-group\\((.+)\\)$/.exec(String(animation.effect && animation.effect.pseudoElement || ''));
    if (group) names.add(group[1]);
  }
  return { names: [...names], skippable: typeof document.activeViewTransition?.skipTransition === 'function' };
})()`;

/** The transition a held page stands inside; none on a running page, where it ends on its own. */
export async function viewTransitionOf(session: BenchSession): Promise<ViewTransitionView | undefined> {
  if (!session.frozen) return undefined;
  const read = await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('view-transition', READ), returnByValue: true,
  }).catch(() => undefined);
  const value = read?.result?.value;
  return value && Array.isArray(value.names) ? { names: value.names, skippable: value.skippable === true } : undefined;
}

/** End the transition at its last frame, leaving the page held there. */
export async function skipViewTransition(connection: string): Promise<void> {
  const session = sessions.get(connection);
  if (!session) return;
  await request(session.client, 'Runtime.evaluate', {
    expression: ownScript('view-transition', 'document.activeViewTransition?.skipTransition()'),
  }).catch(() => undefined);
}
