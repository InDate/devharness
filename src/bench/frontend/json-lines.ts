/**
 * A JSON value printed two spaces to a level, line for line as
 * `JSON.stringify(value, null, 2)` prints it, with each line that holds a leaf
 * carrying that leaf's dotted path - `items.0.id` - so a line can be marked
 * as a field a replay is compared on.
 */
export interface JsonLine {
  text: string;
  path?: string;
}

export function jsonLines(value: unknown): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (node: unknown, path: string, lead: string, depth: number, tail: string) => {
    const pad = '  '.repeat(depth);
    if (node !== null && typeof node === 'object') {
      const array = Array.isArray(node);
      const entries = array ? (node as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(node as object);
      const [open, close] = array ? ['[', ']'] : ['{', '}'];
      if (!entries.length) {
        out.push({ text: `${pad}${lead}${open}${close}${tail}`, ...(path ? { path } : {}) });
        return;
      }
      out.push({ text: `${pad}${lead}${open}` });
      entries.forEach(([key, inner], k) => {
        walk(inner, path ? `${path}.${key}` : key, array ? '' : `${JSON.stringify(key)}: `, depth + 1,
          k < entries.length - 1 ? ',' : '');
      });
      out.push({ text: `${pad}${close}${tail}` });
      return;
    }
    out.push({ text: `${pad}${lead}${JSON.stringify(node)}${tail}`, ...(path ? { path } : {}) });
  };
  walk(value, '', '', 0, '');
  return out;
}
