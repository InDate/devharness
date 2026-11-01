import type { InsidePosition } from './replay-types.js';

/** A position inside a child as the reader counts it: `login step 3`, or `rows item 2 step 1 > login step 3`. */
export function insidePath(inside: InsidePosition): string {
  const here = `${inside.sequence}${inside.item !== undefined ? ` item ${inside.item + 1}` : ''} step ${inside.step + 1}`;
  return inside.inside ? `${here} > ${insidePath(inside.inside)}` : here;
}
