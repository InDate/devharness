/**
 * A line diff of two payloads, for reading a replayed row against its
 * recording.
 *
 * JSON is pretty-printed first, so a changed field is one changed line rather
 * than the whole payload on one line differing.
 */

export interface DiffLine {
  op: 'same' | 'gone' | 'new';
  text: string;
}

/** Past this many lines a side is cut, which bounds the table below at LINE_CAP². */
const LINE_CAP = 400;

export function linesOf(payload: string): string[] {
  let text = payload;
  try {
    text = JSON.stringify(JSON.parse(payload), null, 2);
  } catch { /* not JSON: compared as it is */ }
  return text.split('\n').slice(0, LINE_CAP);
}

/** The recorded payload's lines against the replayed one's, longest common subsequence first. */
export function lineDiff(recorded: string, replayed: string): DiffLine[] {
  const a = linesOf(recorded);
  const b = linesOf(replayed);
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i++; j++; }
    else if (common[i + 1][j] >= common[i][j + 1]) out.push({ op: 'gone', text: a[i++] });
    else out.push({ op: 'new', text: b[j++] });
  }
  while (i < a.length) out.push({ op: 'gone', text: a[i++] });
  while (j < b.length) out.push({ op: 'new', text: b[j++] });
  return out;
}

/**
 * The same diff as two columns: unchanged lines side by side, and each run of
 * removed lines paired with the run of added lines that follows it.
 */
export function sideBySide(lines: DiffLine[]): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k].op === 'same') { rows.push({ left: lines[k], right: lines[k] }); k++; continue; }
    const gone: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (k < lines.length && lines[k].op === 'gone') gone.push(lines[k++]);
    while (k < lines.length && lines[k].op === 'new') added.push(lines[k++]);
    for (let r = 0; r < Math.max(gone.length, added.length); r++) rows.push({ left: gone[r], right: added[r] });
  }
  return rows;
}
