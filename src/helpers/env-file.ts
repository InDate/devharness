/**
 * Parse a `KEY=value` environment file for a single replay run.
 *
 * A run reads its credentials from a file the caller names rather than from
 * the ambient process environment, so the values never enter the sequence
 * file, never travel in the tool call, and never need the MCP client
 * restarted to change - the environment of a running server is fixed at the
 * moment it starts.
 *
 * The parse is deliberately narrow. There is no `$VAR` expansion inside
 * values: a password containing a `$` is ordinary, and expanding it would
 * substitute something else silently and type the wrong credential.
 */

/** One line's worth of syntax the parser refuses, with the line number. */
export interface EnvFileProblem {
  line: number;
  text: string;
}

export interface ParsedEnvFile {
  values: Record<string, string>;
  problems: EnvFileProblem[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ORIGIN_RE = /^https?:\/\/[^\s=/]+$/;

/** The values one name holds: the one for every origin, and those for named origins. */
export interface EnvEntries {
  value?: string;
  byOrigin?: Record<string, string>;
}

/** The value a run starting at `origin` reads for `name`: that origin's, else the plain one. */
export function envValueFor(values: Record<string, string>, name: string, origin?: string): string | undefined {
  if (origin && `${name}@${origin}` in values) return values[`${name}@${origin}`];
  return name in values ? values[name] : undefined;
}

/** Each name the file holds, with the origins it holds a value for. Values are left out. */
export function envNames(values: Record<string, string>): Map<string, { plain: boolean; origins: string[] }> {
  const names = new Map<string, { plain: boolean; origins: string[] }>();
  for (const key of Object.keys(values)) {
    const at = key.indexOf('@');
    const name = at < 0 ? key : key.slice(0, at);
    const held = names.get(name) ?? { plain: false, origins: [] };
    if (at < 0) held.plain = true;
    else held.origins.push(key.slice(at + 1));
    names.set(name, held);
  }
  return names;
}

/**
 * The file's text with every line for `name` - plain and per-origin - replaced
 * by `entries`, or removed where `entries` is null. Other lines, comments and
 * blanks keep their places. A value is quoted where the parser would otherwise
 * read it differently: surrounding space, a leading quote, or a `#`.
 */
export function withEnvEntries(text: string, name: string, entries: EnvEntries | null): string {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a usable variable name`);
  const owned = (line: string) => {
    const body = line.trim().startsWith('export ') ? line.trim().slice('export '.length).trim() : line.trim();
    const key = body.slice(0, Math.max(0, body.indexOf('='))).trim();
    return key === name || key.startsWith(`${name}@`);
  };
  const quote = (value: string) => {
    if (/[\r\n]/.test(value)) throw new Error(`a value for ${name} holds a line break, which the file cannot carry`);
    if (value !== value.trim() || /^["']/.test(value) || value.includes('#')) {
      if (!value.includes('"')) return `"${value}"`;
      if (!value.includes("'")) return `'${value}'`;
      throw new Error(`a value for ${name} holds both quote marks and needs quoting, which the file cannot carry`);
    }
    return value;
  };
  const kept = text.split(/\r?\n/).filter(line => !owned(line));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const added: string[] = [];
  if (entries?.value !== undefined) added.push(`${name}=${quote(entries.value)}`);
  for (const [origin, value] of Object.entries(entries?.byOrigin ?? {})) {
    if (!ORIGIN_RE.test(origin)) throw new Error(`"${origin}" is not an origin such as https://staging.example.com`);
    added.push(`${name}@${origin}=${quote(value)}`);
  }
  return [...kept, ...added].join('\n') + '\n';
}

/**
 * Read `KEY=value` pairs out of the file's text.
 *
 * Accepted per line: a blank line, a `#` comment, or `NAME=value` with an
 * optional `export ` prefix. `NAME@<origin>=value` holds the value a run
 * starting at that origin reads for {{env:NAME}}, stored under the key
 * `NAME@<origin>`; the plain `NAME` is the value for every other origin. Surrounding single or double quotes are stripped
 * from the value; everything else in it is kept verbatim, trailing whitespace
 * included where it was quoted. A name that does not match
 * `[A-Za-z_][A-Za-z0-9_]*` is reported rather than stored, because
 * {{env:NAME}} could never reference it and a silently skipped line reads as
 * a set variable.
 */
export function parseEnvFile(text: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const problems: EnvFileProblem[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;

    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) {
      problems.push({ line: i + 1, text: line });
      return;
    }

    const name = body.slice(0, eq).trim();
    const at = name.indexOf('@');
    if (!NAME_RE.test(at < 0 ? name : name.slice(0, at)) || (at >= 0 && !ORIGIN_RE.test(name.slice(at + 1)))) {
      problems.push({ line: i + 1, text: line });
      return;
    }

    let value = body.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    values[name] = value;
  });

  return { values, problems };
}
