/**
 * A capture file: the picture, and what it was taken from, in one PNG.
 *
 * The record sits in an iTXt chunk straight after IHDR, so reading it takes the
 * head of the file and not the image. The element facts and the clean copy -
 * the region as captured, before any mark was drawn on it - follow the image
 * data, where only a comparison reads them.
 *
 * Versions of one capture are separate files sharing a `series`. Nothing
 * outside the files lists them: the index here is built by reading their heads
 * and kept in memory, so a file copied in or deleted by hand is reflected on
 * the next rebuild rather than contradicted by a stale list.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getOutputPath } from './helpers/paths.js';
import {
  decodePng, encodePng, readChunks, readText, textChunk, writeChunks,
  type Chunk, type Pixels,
} from './png.js';
import type { CaptureRecord, CaptureVersion } from './bench/wire.js';

const RECORD_KEY = 'devharness:capture';
const FACTS_KEY = 'devharness:facts';
/** Private, ancillary, safe-to-copy: decoders skip it and editors may keep it. */
const CLEAN_TYPE = 'dhRw';
/** A record and IHDR fit well inside this; a larger one is read whole. */
const HEAD_BYTES = 64 * 1024;

/**
 * Write a capture. `shown` is the picture a viewer opens - the marked capture,
 * or a comparison - and `clean` the region the next comparison is made against.
 */
export async function writeCapture(
  file: string,
  shown: Buffer | Pixels,
  record: CaptureRecord,
  clean: Pixels,
  facts?: Record<string, unknown>,
): Promise<void> {
  const head = [textChunk(RECORD_KEY, JSON.stringify(record))];
  const tail: Chunk[] = [
    ...(facts ? [textChunk(FACTS_KEY, JSON.stringify(facts))] : []),
    { type: CLEAN_TYPE, data: encodePng(clean) },
  ];

  let bytes: Buffer;
  if (Buffer.isBuffer(shown)) {
    // The picture as it came, with its own text chunks dropped: a canvas export
    // carries none today, and a stale record left in would be read first.
    // IHDR is first by the format's own rule, so the record goes straight after it.
    const own = readChunks(shown).filter(c => c.type !== 'iTXt' && c.type !== 'tEXt' && c.type !== CLEAN_TYPE);
    const end = own.findIndex(c => c.type === 'IEND');
    bytes = writeChunks([...own.slice(0, 1), ...head, ...own.slice(1, end), ...tail, ...own.slice(end)]);
  } else {
    bytes = encodePng(shown, { before: head, after: tail });
  }
  await fs.writeFile(file, bytes);
  remember(file, record);
}

/** The record from a capture's head, or undefined for a PNG with none. */
export async function readRecord(file: string): Promise<CaptureRecord | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    let chunks: Chunk[];
    try {
      chunks = readChunks(buffer.subarray(0, bytesRead), 'IDAT');
    } catch {
      chunks = readChunks(await fs.readFile(file), 'IDAT');
    }
    const text = readText(chunks).get(RECORD_KEY);
    return text ? JSON.parse(text) as CaptureRecord : undefined;
  } finally {
    await handle.close();
  }
}

/** Everything a capture holds. `clean` is absent on a PNG the bench did not write. */
export async function readCapture(file: string): Promise<{
  record?: CaptureRecord;
  facts?: Record<string, unknown>;
  clean?: Pixels;
}> {
  const chunks = readChunks(await fs.readFile(file));
  const text = readText(chunks);
  const record = text.get(RECORD_KEY);
  const facts = text.get(FACTS_KEY);
  const clean = chunks.find(c => c.type === CLEAN_TYPE);
  return {
    ...(record ? { record: JSON.parse(record) as CaptureRecord } : {}),
    ...(facts ? { facts: JSON.parse(facts) } : {}),
    ...(clean ? { clean: decodePng(clean.data) } : {}),
  };
}

// -----------------------------------------------------------------------------
// Series index
// -----------------------------------------------------------------------------

let index: Map<string, CaptureVersion[]> | undefined;
let building: Promise<Map<string, CaptureVersion[]>> | undefined;

function remember(file: string, record: CaptureRecord): void {
  if (!index) return;
  const versions = (index.get(record.series) ?? []).filter(v => v.path !== file);
  versions.push({
    version: record.version,
    path: file,
    at: record.at,
    ...(record.compared ? { compared: record.compared } : {}),
  });
  versions.sort((a, b) => a.version - b.version);
  index.set(record.series, versions);
}

/** Every capture under the screenshots directory, by series, built on first use. */
export async function seriesIndex(): Promise<Map<string, CaptureVersion[]>> {
  if (index) return index;
  building ??= (async () => {
    const found = new Map<string, CaptureVersion[]>();
    index = found;
    const root = getOutputPath('screenshots');
    const days = await fs.readdir(root).catch(() => [] as string[]);
    for (const day of days) {
      const names = await fs.readdir(join(root, day)).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith('.png')) continue;
        const file = join(root, day, name);
        const record = await readRecord(file).catch(() => undefined);
        if (record) remember(file, record);
      }
    }
    return found;
  })();
  return building;
}

/**
 * Add a file to the index. The index is built once, so a capture copied in
 * after that is known only once something names it.
 */
export async function indexCapture(file: string, record: CaptureRecord): Promise<void> {
  await seriesIndex();
  remember(file, record);
}

/** The versions of the series a capture file belongs to, oldest first. */
export async function versionsOf(series: string): Promise<CaptureVersion[]> {
  return (await seriesIndex()).get(series) ?? [];
}

/** Drop deleted files from the index, so a later lookup does not name them. */
export function forget(files: Iterable<string>): void {
  if (!index) return;
  const gone = new Set(files);
  for (const [series, versions] of index) {
    const kept = versions.filter(v => !gone.has(v.path));
    if (kept.length) index.set(series, kept);
    else index.delete(series);
  }
}
