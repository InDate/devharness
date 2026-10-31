/**
 * The press length a recorded click or tap replays with.
 *
 * A recording stores how long each press lasted (`pressMs`). A press shorter
 * than the threshold replays as a quick press, so the few ms a finger or
 * button rests on a quick click do not turn every click into a hold; a press
 * at or past it replays held down for the recorded length, which is what
 * opens a long-press menu or arms a press-and-hold control.
 */
export const DEFAULT_HOLD_THRESHOLD_MS = 500;

/**
 * The params a step runs with: `pressMs` turned into `holdMs` against the
 * threshold, and dropped, since the input tool holds for `holdMs` alone. A
 * `holdMs` already on the step stands as written.
 */
export function resolvePressHold(
  params: Record<string, any>,
  thresholdMs: number = DEFAULT_HOLD_THRESHOLD_MS,
): Record<string, any> {
  if (params.pressMs === undefined) return params;
  const { pressMs, ...rest } = params;
  if (rest.holdMs !== undefined) return rest;
  return typeof pressMs === 'number' && pressMs >= thresholdMs ? { ...rest, holdMs: pressMs } : rest;
}
