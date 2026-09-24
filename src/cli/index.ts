/**
 * `devharness <command>` - run a tool inside the session the shell belongs to.
 *
 * The MCP process's stdin belongs to its client, so a request arrives instead
 * over that session's socket (src/session-endpoint.ts). Which session is
 * decided by the shell's directory first: only sessions rooted at it or above
 * it are candidates, because every project-scoped path resolves against the
 * answering server's root. Process ancestry then picks among those, so
 * `! devharness screenshot` reaches the browser this session opened.
 *
 * Guards that the MCP request handler applies - a dead dev server port, a
 * paused breakpoint, a pending bug - are not applied here, the same as
 * `devharness run`.
 */

import { connect, type Socket } from 'net';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initializePaths } from '../helpers/paths.js';
import { listSessionRecords, type SessionRecord, type EndpointReply } from '../session-endpoint.js';
import { readParentMap } from './process-tree.js';
import { matchByAncestry, findSessionByName, filterToListedProcesses, filterToProjectRoot, shareOneRoot } from './session-match.js';

const DEFAULT_TIMEOUT_MS = 120000;

/** Commands that are shorthand for one action of the `message` tool. */
const MESSAGE_VERBS = new Set(['sessions', 'send', 'read', 'reply']);

/** Commands that are shorthand for `issues` create, one per issue type. */
const ISSUE_VERBS = new Set(['bug', 'feature']);

export const CLI_COMMANDS = ['call', 'which', 'bench', ...MESSAGE_VERBS, ...ISSUE_VERBS] as const;

export function isCliCommand(word: string | undefined): boolean {
  return word !== undefined && (CLI_COMMANDS as readonly string[]).includes(word);
}

export function isVersionFlag(word: string | undefined): boolean {
  return word === '--version' || word === '-v';
}

/**
 * The installed version, printed by `devharness --version`.
 *
 * The plugin's SessionStart hook compares this against the version its
 * `.mcp.json` pins, so a global install that has drifted from the plugin is
 * reported at the start of a session rather than discovered through behaviour
 * that does not match the docs.
 */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface ParsedArgs {
  command: string;
  positional: string[];
  session?: string;
  json: boolean;
  timeoutMs: number;
  waitMs?: number;
}

/** Slack over the server's own wait, so the socket outlives the work it asked
 *  for. A socket that gives up first aborts a reply the server has already
 *  received and marked read. */
const WAIT_SOCKET_MARGIN_MS = 15000;

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let session: string | undefined;
  let json = false;
  let explicitTimeoutMs: number | undefined;
  let waitMs: number | undefined;
  // Everything after `--` is text, not flags: message bodies contain `--json`
  // and the like, and stripping them silently rewrote what was sent.
  let flagsEnded = false;

  for (const arg of argv.slice(1)) {
    if (!flagsEnded) {
      if (arg === '--') { flagsEnded = true; continue; }
      if (arg === '--json') { json = true; continue; }
      if (arg.startsWith('--session=')) { session = arg.slice('--session='.length); continue; }
      if (arg.startsWith('--timeout=')) { explicitTimeoutMs = Number(arg.slice('--timeout='.length)) || undefined; continue; }
      if (arg.startsWith('--wait=')) { waitMs = Number(arg.slice('--wait='.length)) || undefined; continue; }
    }
    positional.push(arg);
  }

  const timeoutMs = explicitTimeoutMs
    ?? (waitMs ? waitMs + WAIT_SOCKET_MARGIN_MS : DEFAULT_TIMEOUT_MS);

  return { command: argv[0], positional, session, json, timeoutMs, waitMs };
}

/** The tool call a command stands for. */
export function buildCall(parsed: ParsedArgs): { tool: string; args: Record<string, unknown> } | string {
  const [first, ...rest] = parsed.positional;

  switch (parsed.command) {
    case 'call': {
      if (!first) return 'Usage: devharness call <tool> [jsonArgs]';
      let args: Record<string, unknown> = {};
      if (rest.length > 0) {
        try {
          args = JSON.parse(rest.join(' ')) as Record<string, unknown>;
        } catch (error: any) {
          return `Arguments must be one JSON object: ${error?.message || error}`;
        }
      }
      return { tool: first, args };
    }

    /**
     * Open the bench against the session this shell belongs to.
     *
     * A sequence name puts the pane straight on that run rather than on a
     * list to pick from, and a URL drives the page there first - with no
     * browser on the reference yet, one call opens the page and the pane.
     */
    case 'bench': {
      const reference = parsed.session ?? 'bench';
      const url = rest.find(word => /^https?:\/\//.test(word));
      const sequence = first && !/^https?:\/\//.test(first) ? first : undefined;
      return {
        tool: 'bench',
        args: {
          action: 'start',
          connectionReason: reference,
          ...(sequence ? { sequence } : {}),
          ...(url ? { url } : {}),
        },
      };
    }

    case 'sessions':
      return { tool: 'message', args: { action: 'sessions' } };

    case 'read':
      return { tool: 'message', args: { action: 'read' } };

    case 'send': {
      if (!first || rest.length === 0) return 'Usage: devharness send <sessionId> <text> [--wait=<ms>]';
      return {
        tool: 'message',
        args: {
          action: 'send',
          to: first,
          text: rest.join(' '),
          ...(parsed.waitMs ? { waitForReplyMs: parsed.waitMs } : {}),
        },
      };
    }

    case 'bug':
    case 'feature': {
      if (!first) return `Usage: devharness ${parsed.command} <title> [body]`;
      // includeSequence is false on every create from the CLI: recording opens
      // Chrome and rejects a create that carries no startUrl, and a shell
      // command supplies neither.
      const body = rest.join(' ');
      return {
        tool: 'issues',
        args: {
          action: 'create',
          type: parsed.command,
          title: first,
          ...(body ? { body } : {}),
          includeSequence: false,
        },
      };
    }

    case 'reply': {
      if (!first || rest.length === 0) return 'Usage: devharness reply <messageId> <text> [--wait=<ms>]';
      return {
        tool: 'message',
        args: {
          action: 'reply',
          replyTo: first,
          text: rest.join(' '),
          ...(parsed.waitMs ? { waitForReplyMs: parsed.waitMs } : {}),
        },
      };
    }

    default:
      return `Unknown command "${parsed.command}". Commands: ${CLI_COMMANDS.join(', ')}`;
  }
}

/** Send one request over a session's socket and return its reply. */
function callSession(record: SessionRecord, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<EndpointReply> {
  return new Promise<EndpointReply>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const socket: Socket = connect(record.address);
    socket.setEncoding('utf-8');

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Session ${record.shortId ?? record.pid} did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      socket.write(JSON.stringify({ tool, args }) + '\n');
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as EndpointReply);
        } catch (error: any) {
          reject(new Error(`Session replied with something that is not JSON: ${error?.message || error}`));
        }
      });
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? `Session ${record.shortId ?? record.pid} is not listening on ${record.address}. It is suspended or shutting down.`
          : `Could not reach session ${record.shortId ?? record.pid}: ${error.message}`
      )));
    });

    socket.on('close', () => {
      finish(() => reject(new Error(`Session ${record.shortId ?? record.pid} closed the connection without replying`)));
    });
  });
}

function describeRecord(record: SessionRecord): string {
  return `${record.shortId ?? `pid-${record.pid}`} (pid ${record.pid}) - ${record.cwd}`;
}

/** Rendered text of a tool response, the way an MCP client would show it. */
function renderResponse(response: any): string {
  const items = Array.isArray(response?.content) ? response.content : [];
  return items
    .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

export async function runCli(argv: string[]): Promise<number> {
  initializePaths();

  const parsed = parseArgs(argv);
  const records = listSessionRecords();

  if (records.length === 0) {
    console.error('No devharness session is listening on this machine.');
    return 1;
  }

  let target: SessionRecord | null;
  if (parsed.session) {
    target = findSessionByName(records, parsed.session);
    if (!target) {
      console.error(`No session matches "${parsed.session}". Listening sessions:`);
      for (const record of records) console.error(`  ${describeRecord(record)}`);
      return 1;
    }
  } else {
    const parents = readParentMap();
    const listed = filterToListedProcesses(records, parents);
    if (listed.length === 0) {
      console.error('Every session on record has already exited - the server is restarting. Try again in a moment.');
      return 1;
    }
    // Directory before ancestry. A shell that descends from no session at all -
    // a tool-spawned one, a detached terminal - used to reach whichever session
    // shared the nearest ancestor, and that server wrote its own project's
    // issues and config.
    const here = filterToProjectRoot(listed, process.cwd());
    if (here.length === 0) {
      console.error(`No devharness session is rooted at ${process.cwd()} or a directory above it. Listening sessions:`);
      for (const record of records) console.error(`  ${describeRecord(record)}`);
      console.error('Name one with --session=<id> to use it anyway.');
      return 1;
    }
    // One session rooted here needs no ancestry: a shell that descends from
    // nothing still belongs to the only server that holds this project.
    const result = here.length === 1
      ? { candidates: [], matched: here[0], ambiguous: [] }
      : matchByAncestry(here, process.pid, parents);
    if (result.ambiguous.length > 1) {
      // Several servers can serve one session - a dev build beside the
      // plugin's. The mailbox and its cursor are per session, not per server,
      // so any of them answers a message verb identically. `call` reaches a
      // particular server's browser and dev servers, so there the tie is real.
      const ids = new Set(result.ambiguous.map(m => m.record.shortId ?? `pid-${m.record.pid}`));
      const tiedRecords = result.ambiguous.map(m => m.record);
      if (ids.size === 1 && MESSAGE_VERBS.has(parsed.command)) {
        target = result.ambiguous[0].record;
      } else if (ISSUE_VERBS.has(parsed.command) && shareOneRoot(tiedRecords)) {
        // One root means one tracker, so either server files the item in the
        // same place. Roots that differ keep the refusal below.
        target = result.ambiguous[0].record;
      } else {
        // A short id resolves to the first record, so with two servers under
        // one id `--session=<shortId>` picks one silently. Only the pid names
        // a single server, and the listing has to say which to use.
        const distinct = new Set(result.ambiguous.map(m => m.record.shortId ?? `pid-${m.record.pid}`)).size > 1;
        console.error(
          distinct
            ? 'Two sessions are the same distance up the process tree. Name one with --session=<id>:'
            : 'One session is served by two devharness servers, and this command reaches a particular one. Name it by pid with --session=<pid>:'
        );
        for (const match of result.ambiguous) console.error(`  ${describeRecord(match.record)}`);
        return 1;
      }
    } else if (!result.matched) {
      console.error('Several sessions are rooted here and this shell descends from none of them. Name one with --session=<id>:');
      for (const record of here) console.error(`  ${describeRecord(record)}`);
      return 1;
    } else {
      target = result.matched;
    }
  }

  if (parsed.command === 'which') {
    console.log(describeRecord(target));
    return 0;
  }

  const call = buildCall(parsed);
  if (typeof call === 'string') {
    console.error(call);
    return 1;
  }

  let reply: EndpointReply;
  try {
    reply = await callSession(target, call.tool, call.args, parsed.timeoutMs);
  } catch (error: any) {
    console.error(error?.message || String(error));
    return 1;
  }

  if (!reply.ok) {
    console.error(reply.error || 'The session refused the call');
    return 1;
  }

  if (parsed.json) {
    console.log(JSON.stringify(reply.response, null, 2));
  } else {
    console.log(renderResponse(reply.response));
  }

  return (reply.response as any)?.isError ? 1 : 0;
}
