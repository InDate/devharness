/**
 * The comparison a check makes, as the word its answer reads on a pass and on
 * a fail: `equals` / `not equal`, `present` / `absent`, `found` / `not found`,
 * `waited`.
 *
 * Read from the step's own parameters. Read from its label instead, a class or
 * id such as `.visible-toast` or `#gt-banner` answered as the comparison, since
 * a label holds the selector and the comparison in one string.
 */

const OPERATORS: Record<string, [string, string]> = {
  equals: ['equals', 'not equal'], notEquals: ['not equal', 'equal'],
  contains: ['contains', 'missing'], matches: ['matches', 'no match'],
  exists: ['exists', 'missing'], notExists: ['missing', 'exists'],
  gt: ['greater', 'not greater'], gte: ['at least', 'below'],
  lt: ['less', 'not less'], lte: ['at most', 'above'],
};

const CONDITIONS: Record<string, [string, string]> = {
  present: ['present', 'absent'], absent: ['absent', 'present'],
  visible: ['visible', 'hidden'], hittable: ['hittable', 'covered'], enabled: ['enabled', 'disabled'],
};

const WAITED: [string, string] = ['waited', 'waited'];

/**
 * A traffic count's words: arrived for a least-count, none for a count that
 * must stay at 0, and within or over a limit that must not be exceeded.
 */
function trafficWords(operator: string, count: number): [string, string] {
  if ((operator === 'equals' || operator === 'lte') && count === 0) return ['none crossed', 'crossed'];
  if (operator === 'lt' && count <= 1) return ['none crossed', 'crossed'];
  if (operator === 'equals') return [`exactly ${count}`, `not ${count}`];
  if (operator === 'lte' || operator === 'lt') return ['within limit', 'over limit'];
  return ['arrived', 'not arrived'];
}

const TRUTHY: [string, string] = ['true', 'false'];
const PASSED: [string, string] = ['passed', 'failed'];

/** An element's comparison: its operator where it compares, a found text for `:has-text()`, else its condition. */
function elementWords(selector: unknown, condition: unknown, operator: unknown): [string, string] {
  if (typeof operator === 'string' && OPERATORS[operator]) return OPERATORS[operator];
  const presence = condition === undefined || condition === 'present';
  if (presence && typeof selector === 'string' && selector.includes(':has-text(')) return ['found', 'not found'];
  return CONDITIONS[String(condition ?? 'present')] ?? PASSED;
}

/** The words for a check, assert or wait step, from its tool and parameters. */
export function comparisonOf(tool: string, params: Record<string, unknown>): [string, string] {
  if (tool === 'wait') {
    if (params.ms !== undefined) return WAITED;
    if (params.selectorGone !== undefined) return CONDITIONS.absent;
    if (params.expression !== undefined) return TRUTHY;
    return elementWords(params.selector, 'present', undefined);
  }
  if (tool === 'assert') {
    return params.selector !== undefined && params.condition !== undefined
      ? elementWords(params.selector, params.condition, params.operator)
      : OPERATORS[String(params.operator)] ?? PASSED;
  }
  if (params.selector !== undefined) return elementWords(params.selector, params.condition, params.operator);
  if (params.value !== undefined) return OPERATORS[String(params.operator)] ?? PASSED;
  if (params.expression !== undefined) return TRUTHY;
  if (params.url !== undefined) return OPERATORS[String(params.operator ?? 'equals')] ?? PASSED;
  if (params.traffic !== undefined) return trafficWords(String(params.operator ?? 'gte'), Number(params.count ?? 1));
  if (params.socket !== undefined) return params.condition === 'closed' ? ['closed', 'open'] : ['open', 'closed'];
  if (params.cookie !== undefined || params.localStorage !== undefined || params.indexedDB !== undefined) {
    return params.condition === 'absent' ? CONDITIONS.absent : CONDITIONS.present;
  }
  return WAITED;
}
