/**
 * `devharness watch` - read this session's event stream from its cursor.
 *
 * Plain, it exits on the first burst of new lines, which suits a background
 * Bash task: that holds no deadline, so a quiet stream costs the session no
 * turns. `--follow` streams every line for as long as it runs, which suits a
 * Monitor while events come in bursts; a Monitor expires every 30 minutes.
 *
 * Both advance one cursor file beside the stream. A line appended between one
 * watch exiting and the next starting sits past the cursor, so the next watch
 * reads it; without the cursor the next watch would start at the end of the
 * file and skip it. The cursor is written after the lines are printed, so a
 * watch killed between the two repeats lines on the next watch and drops none.
 *
 * The file stays open for the life of the watch, so streamReaders counts it.
 */

import { openSync, fstatSync, readSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import { getEventStreamPath, getEventCursorPath } from '../session-events.js';
import { resolveSessionName } from '../session-identity.js';

const POLL_MS = 500;
/** A burst ends at this much quiet, so its lines arrive as one notification. */
const SETTLE_MS = 1000;
/** A stream that never goes quiet still returns within this. */
const BURST_CAP_MS = 5000;

const FOOTER = 'Next watch: a lone event → the same Bash call; more coming (a person in the bench) → Monitor({ command: "<the same command> --follow", description: "devharness events", persistent: true, timeout_ms: 3600000 }). A Monitor expiry with events in it → the same Monitor; with none → the Bash call.';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readCursor(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, 'utf-8').trim());
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeCursor(path: string, offset: number): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, String(offset));
  renameSync(temp, path);
}

/** The complete lines in [start, end) of the file, and the offset past the last of them. */
function readLines(fd: number, start: number, end: number): { text: string; next: number } {
  const buffer = Buffer.alloc(end - start);
  readSync(fd, buffer, 0, buffer.length, start);
  // A write caught mid-line is left for the next read, from the last newline.
  const lines = buffer.subarray(0, buffer.lastIndexOf(0x0a) + 1);
  return { text: lines.toString('utf-8'), next: start + lines.length };
}

export async function runWatch(follow: boolean, session?: string): Promise<number> {
  const name = session ?? resolveSessionName();
  const streamPath = getEventStreamPath(name);
  const cursorPath = getEventCursorPath(name);
  mkdirSync(dirname(streamPath), { recursive: true });
  appendFileSync(streamPath, '');

  const fd = openSync(streamPath, 'r');
  const size = () => fstatSync(fd).size;
  // No cursor yet starts at the end, so a first watch delivers nothing from
  // before it; a cursor past the end belongs to a stream since replaced.
  const stored = readCursor(cursorPath);
  let offset = stored === undefined || stored > size() ? size() : stored;

  if (follow) {
    for (;;) {
      if (size() > offset) {
        const { text, next } = readLines(fd, offset, size());
        if (next > offset) {
          process.stdout.write(text);
          writeCursor(cursorPath, next);
          offset = next;
        }
      }
      await sleep(POLL_MS);
    }
  }

  let text = '';
  while (!text) {
    while (size() <= offset) await sleep(POLL_MS);
    const burstStart = Date.now();
    let last = size();
    while (Date.now() - burstStart < BURST_CAP_MS) {
      await sleep(SETTLE_MS);
      if (size() === last) break;
      last = size();
    }
    const read = readLines(fd, offset, last);
    text = read.text;
    if (read.next > offset) {
      process.stdout.write(`${text}${FOOTER}\n`);
      writeCursor(cursorPath, read.next);
      offset = read.next;
    }
  }
  return 0;
}
