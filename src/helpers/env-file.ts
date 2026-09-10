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

/**
 * Read `KEY=value` pairs out of the file's text.
 *
 * Accepted per line: a blank line, a `#` comment, or `NAME=value` with an
 * optional `export ` prefix. Surrounding single or double quotes are stripped
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
    if (!NAME_RE.test(name)) {
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
