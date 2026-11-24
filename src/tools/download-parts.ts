/**
 * Fetching a file in byte-range parts, each retried on its own, with finished
 * parts kept on disk so a failed download resumes from them on the next call.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

export const PART_SIZE = 4 * 1024 * 1024;
export const PART_CONCURRENCY = 4;
export const ATTEMPTS = 3;
/** Wait before retry n (1-based): 1s, 2s, 4s. */
export const RETRY_BASE_MS = 1000;

/** What a HEAD answer gives about the file before any body is read. */
export interface Probe {
  size: number | null;
  ranges: boolean;
  /** ETag, else Last-Modified: what If-Range sends, and what a resume compares against. */
  validator: string | null;
  contentType: string | null;
  disposition: string | null;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Overridable so tests run without real waits. */
  retryBaseMs?: number;
  partSize?: number;
}

/** A failure a second attempt can plausibly clear: no answer, a 429, or a 5xx. */
export function retryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

class AttemptError extends Error {
  constructor(message: string, readonly status: number | null, readonly statusText?: string) {
    super(message);
  }
}

/**
 * A 200 to a ranged request: the server ignores ranges on GET, or the file
 * changed and If-Range sent all of it. Either way only a whole-file fetch
 * returns the file as it stands, so the parts are dropped and that runs.
 */
export class WholeFileAnswer extends Error {
  constructor() {
    super('the server answered a part with the whole file');
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

/**
 * Runs `attempt` up to ATTEMPTS times. A retryable failure waits
 * base * 2^(n-1) before the next; any other failure ends the run at once.
 * Returns the value and how many retries it took.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>, options: FetchOptions,
): Promise<{ value: T; retries: number }> {
  const base = options.retryBaseMs ?? RETRY_BASE_MS;
  for (let n = 1; ; n++) {
    try {
      return { value: await attempt(), retries: n - 1 };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const status = error instanceof AttemptError ? error.status : null;
      if (n >= ATTEMPTS || !retryable(status)) throw error;
      await wait(base * 2 ** (n - 1), options.signal);
    }
  }
}

export async function probe(url: string, signal?: AbortSignal): Promise<Probe | null> {
  try {
    const head = await fetch(url, { method: 'HEAD', signal });
    if (!head.ok) return null;
    const length = head.headers.get('content-length');
    const size = length !== null && /^\d+$/.test(length) ? Number(length) : null;
    return {
      size,
      ranges: (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes') && size !== null && size > 0,
      validator: head.headers.get('etag') ?? head.headers.get('last-modified'),
      contentType: head.headers.get('content-type'),
      disposition: head.headers.get('content-disposition'),
    };
  } catch {
    return null;
  }
}

interface Manifest { url: string; size: number; validator: string | null; partSize: number }

function partName(index: number): string {
  return `part-${String(index).padStart(5, '0')}`;
}

/** The parts folder for a file, cleared when what it holds was taken from another version of the file. */
async function openPartsDir(dir: string, manifest: Manifest): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  let kept: Manifest | null = null;
  try { kept = JSON.parse(await fs.readFile(path, 'utf-8')); } catch { /* first attempt at this file */ }
  // With no ETag or Last-Modified, a file replaced by one of the same size
  // matches on every field, so its kept parts are never reused.
  const same = kept && manifest.validator !== null && kept.url === manifest.url && kept.size === manifest.size
    && kept.validator === manifest.validator && kept.partSize === manifest.partSize;
  if (!same) {
    for (const entry of await fs.readdir(dir)) await fs.rm(join(dir, entry), { force: true });
    await fs.writeFile(path, JSON.stringify(manifest));
    return 0;
  }
  let reused = 0;
  for (let index = 0; index * manifest.partSize < manifest.size; index++) {
    const want = Math.min(manifest.partSize, manifest.size - index * manifest.partSize);
    try { if ((await fs.stat(join(dir, partName(index)))).size === want) reused++; } catch { /* not fetched */ }
  }
  return reused;
}

export interface PartsResult {
  buffer: Buffer;
  parts: number;
  /** Parts already on disk from an earlier attempt, read instead of fetched. */
  reused: number;
  retries: number;
}

/**
 * Fetches [0, size) in parts of `partSize` bytes, PART_CONCURRENCY at a time.
 * A part holds only once its answer is a 206 carrying exactly its bytes; it is
 * written under its own name, so one that fails leaves the others in place.
 * If-Range carries the validator: a file changed since the probe answers 200,
 * which fails the part rather than mixing two versions.
 */
export async function fetchInParts(
  url: string, info: Probe & { size: number }, partsDir: string, options: FetchOptions = {},
): Promise<PartsResult> {
  const partSize = options.partSize ?? PART_SIZE;
  const count = Math.ceil(info.size / partSize);
  const reused = await openPartsDir(partsDir, { url, size: info.size, validator: info.validator, partSize });
  let retries = 0;
  let next = 0;

  const fetchPart = async (index: number): Promise<void> => {
    const path = join(partsDir, partName(index));
    const start = index * partSize;
    const end = Math.min(info.size, start + partSize) - 1;
    const want = end - start + 1;
    try {
      if ((await fs.stat(path)).size === want) return;
    } catch { /* not fetched yet */ }

    const { retries: used } = await withRetries(async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { range: `bytes=${start}-${end}`, ...(info.validator && { 'if-range': info.validator }) },
          signal: options.signal,
        });
      } catch (error: any) {
        throw new AttemptError(`part ${index + 1}/${count}: ${error.message}`, null);
      }
      if (response.status === 200) {
        await response.body?.cancel().catch(() => {});
        throw new WholeFileAnswer();
      }
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => {});
        throw new AttemptError(`part ${index + 1}/${count}: HTTP ${response.status}`, response.status, response.statusText);
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length !== want) {
        throw new AttemptError(`part ${index + 1}/${count}: ${body.length} of ${want} bytes arrived`, null);
      }
      await fs.writeFile(`${path}.tmp`, body);
      await fs.rename(`${path}.tmp`, path);
    }, options);
    retries += used;
  };

  // After a failure no new part starts, and the parts already running finish
  // before the error returns, so the folder holds every part that arrived.
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < count) {
      try {
        await fetchPart(next++);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, count) }, worker));
  if (failure !== null) throw failure;

  const pieces: Buffer[] = [];
  for (let index = 0; index < count; index++) pieces.push(await fs.readFile(join(partsDir, partName(index))));
  return { buffer: Buffer.concat(pieces), parts: count, reused: Math.min(reused, count), retries };
}

/** A whole-file GET, retried on no answer, a 429 or a 5xx. */
export async function fetchWhole(url: string, options: FetchOptions): Promise<{ response: Response; retries: number }> {
  const { value, retries } = await withRetries(async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal: options.signal });
    } catch (error: any) {
      throw new AttemptError(error.message, null);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AttemptError(`HTTP ${response.status}`, response.status, response.statusText);
    }
    return response;
  }, options);
  return { response: value, retries };
}

export function attemptStatus(error: unknown): { status: number | null; statusText?: string } {
  return error instanceof AttemptError ? { status: error.status, statusText: error.statusText } : { status: null };
}

/** The name a download saves under when none is given: Content-Disposition's, then the URL path's last segment. */
export function nameFor(url: string, disposition: string | null): string {
  const star = disposition?.match(/filename\*\s*=\s*[^']*''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let name = '';
  try { name = star ? decodeURIComponent(star) : plain ?? ''; } catch { name = plain ?? ''; }
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''); } catch { /* opaque path */ }
  }
  const cleaned = name.replace(/[/\\\0]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').trim();
  return cleaned || 'download';
}
