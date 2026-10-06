/**
 * A person's input in a page devharness drives, recorded into History and
 * held for the next reply on that connection.
 *
 * A page moved by a person and then read by an agent that does not know it
 * was moved gives readings of a state the agent never drove to, and a run
 * carrying on over it fails where the app is fine. So every driven page
 * reports each click, each field typed into, and each Enter, Escape or Tab,
 * and the agent's next call on that connection names them.
 *
 * A listener in the page reports through a function exposed on it, the moment
 * the input happens. Each report becomes an `input` History entry from the
 * `person` channel, and the proxy is told what it causes, so a request the
 * input sent is stamped to it rather than to the call before.
 */
import type { CommandRecorder } from './command-recorder.js';
import type { ElementFingerprint } from './element-fingerprint.js';
import { personInputScript } from './element-fingerprint.js';
import { addCause } from './proxy/cause-timeline.js';
import { recordPauseAction } from './pause-actions.js';

const BINDING = '__devharnessInput';

/** How long after a person's input what crosses or is written counts as its doing. */
const PERSON_INPUT_REACH_MS = 1000;

export interface PersonInput {
  action: string;
  selector?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  fingerprint?: ElementFingerprint;
  at: number;
  /** The History entry it was recorded as. */
  index?: number;
}

let recorder: CommandRecorder | undefined;

/** The recorder a person's input is written into; set once, at startup. */
export function recordPersonInputInto(commandRecorder: CommandRecorder): void {
  recorder = commandRecorder;
}

const watching = new Map<string, { page: unknown; off: () => Promise<void> }>();
/** Connections a person turned the watch off on, from the bench, which a later call leaves off. */
const turnedOff = new Set<string>();
/** What a person did on each connection since the agent's last call there read it. */
const unread = new Map<string, PersonInput[]>();
/** Every input on each connection, newest last, for a run reading what landed since its step began. */
const landed = new Map<string, PersonInput[]>();
const LANDED_KEPT = 200;

async function record(connection: string, input: PersonInput): Promise<void> {
  if (recorder) {
    const { fingerprint, at, ...rest } = input;
    await recorder.recordCommand('input', { ...rest, connection }, {
      from: 'person',
      result: {
        content: [{ type: 'text', text: `a person's ${input.action} in the app` }],
        _meta: { tool: 'input', action: input.action, timestamp: Date.now(), ...(fingerprint ? { element: { fingerprint } } : {}) },
      },
    });
    // Known only after what it caused: the request reached the proxy and the
    // write the page made were stored before this entry existed. Added to the
    // timeline with the window its page-side time bounds, every capability
    // stamps what began inside it, whenever it stores it.
    const index = recorder.getCurrentHistoryIndex();
    addCause({ kind: 'command', index }, at, at + PERSON_INPUT_REACH_MS);
    recorder.attachRelease(index, at + PERSON_INPUT_REACH_MS);
    input = { ...input, index };
  }
  // Made while a run stands paused, it is part of that pause as well as of History.
  recordPauseAction(connection, { at: input.at, kind: 'input', line: describePersonInput(input), ...(input.index !== undefined ? { index: input.index } : {}) });
  unread.set(connection, [...(unread.get(connection) ?? []), input]);
  const all = [...(landed.get(connection) ?? []), input];
  landed.set(connection, all.slice(-LANDED_KEPT));
}

/**
 * Watch the page on `connection` for a person's input. A page already watched
 * is left as it is; a new page object for the connection is watched afresh.
 */
export async function watchPersonInput(connection: string, page: any): Promise<void> {
  const held = watching.get(connection);
  if (held?.page === page || turnedOff.has(connection)) return;
  if (held) await held.off().catch(() => {});
  const onReport = (payload: string) => {
    let input: any;
    try { input = JSON.parse(payload); } catch { return; }
    if (typeof input?.action !== 'string') return;
    void record(connection, { ...input, at: typeof input.at === 'number' ? input.at : Date.now() }).catch(() => {});
  };
  const script = personInputScript();
  try {
    await page.exposeFunction(BINDING, onReport);
  } catch {
    // Exposed on this page already, by a watch an earlier page object made.
  }
  const { identifier } = await page.evaluateOnNewDocument(script) as { identifier: string };
  await page.evaluate(script).catch(() => {});
  watching.set(connection, {
    page,
    off: async () => {
      await page.removeScriptToEvaluateOnNewDocument(identifier).catch(() => {});
      await page.removeExposedFunction(BINDING).catch(() => {});
      // The listener in the current document stays until it reloads; with the
      // function gone its reports reach nothing, and this clears its guard so
      // watching again installs a fresh one.
      await page.evaluate('globalThis.__devharnessPersonInput = false').catch(() => {});
    },
  });
}

/** Stop watching `connection`; `byPerson` keeps it off until the person turns it back on. */
export async function unwatchPersonInput(connection: string, byPerson = false): Promise<void> {
  if (byPerson) turnedOff.add(connection);
  const held = watching.get(connection);
  watching.delete(connection);
  await held?.off().catch(() => {});
}

/** Let a later call watch `connection` again, after a person turned the watch off. */
export function allowPersonWatch(connection: string): void {
  turnedOff.delete(connection);
}

export function isWatchingPersonInput(connection: string): boolean {
  return watching.has(connection);
}

/** What a person did on `connection` since the last time this was read, emptied by reading. */
export function takeUnreadPersonInput(connection: string): PersonInput[] {
  const held = unread.get(connection) ?? [];
  unread.delete(connection);
  return held;
}

/**
 * The inputs that landed on `connection` at or after `since`, taken as read:
 * the run that asks names them in its own reply, so the reply's status line
 * does not name them again.
 */
export function personInputSince(connection: string, since: number): PersonInput[] {
  const found = (landed.get(connection) ?? []).filter(input => input.at >= since);
  if (found.length) unread.set(connection, (unread.get(connection) ?? []).filter(input => !found.includes(input)));
  return found;
}

/**
 * A control a person pressed in the bench - hold, release, a step - as a
 * History entry from the bench channel, so what was done to the page reads
 * in History beside what was done in it.
 */
export async function recordBenchCall(connection: string, tool: string, params: Record<string, unknown>, line: string): Promise<void> {
  if (!recorder) return;
  await recorder.recordCommand(tool, { ...params, connection }, {
    from: 'bench',
    result: { content: [{ type: 'text', text: line }], _meta: { tool, action: String(params.action ?? ''), timestamp: Date.now() } },
  });
}

/** One input as a reply names it: `click [data-testid="open"]`, `type "draft" into #title`, `press Enter`. */
export function describePersonInput(input: PersonInput): string {
  const where = input.selector ?? (input.x !== undefined ? `(${input.x}, ${input.y})` : 'the page');
  if (input.action === 'type') return `type into ${where}, leaving "${(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`;
  if (input.action === 'press') return `press ${input.key ?? ''}`.trim();
  return `${input.action} ${where}`;
}
