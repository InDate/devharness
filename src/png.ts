/**
 * PNG read and write for the captures the bench takes.
 *
 * Two producers feed it: Chrome's Page.captureScreenshot (8-bit RGB, with an
 * iCCP profile) and a canvas's toDataURL (8-bit RGBA). Both are non-interlaced,
 * so those are the formats decoded; anything else is refused by name rather
 * than read as garbage pixels.
 *
 * Chunks are handled apart from pixels because a capture carries its record in
 * them: text chunks ahead of the image data, where a reader of the record
 * stops, and the clean copy in a private chunk after it.
 */

import { deflateSync, inflateSync } from 'zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  data: Buffer;
}

export interface Chunk {
  type: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The chunks of a PNG, in file order.
 *
 * `stopAt` ends the walk at the first chunk of that type, which is how a record
 * placed ahead of IDAT is read from the head of a file without the rest.
 */
export function readChunks(png: Buffer, stopAt?: string): Chunk[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks: Chunk[] = [];
  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === stopAt) break;
    if (at + 12 + length > png.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function writeChunks(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [SIGNATURE];
  for (const { type, data } of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    parts.push(head, data, crc);
  }
  return Buffer.concat(parts);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Pixels {
  const chunks = readChunks(png);
  const header = chunks.find(chunk => chunk.type === 'IHDR')?.data;
  if (!header) throw new Error('PNG has no IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colour = header[9];
  const interlace = header[12];
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
    throw new Error(`PNG is depth ${depth}, colour type ${colour}, interlace ${interlace}; `
      + 'only 8-bit non-interlaced RGB and RGBA are read');
  }

  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  if (packed.length < height * (stride + 1)) throw new Error('PNG image data is shorter than its size');

  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    const line = packed.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const up = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[out + x - channels] : 0;
      const b = y > 0 ? rows[up + x] : 0;
      const c = x >= channels && y > 0 ? rows[up + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`PNG row ${y} has unknown filter ${filter}`);
      rows[out + x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: rows };
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < rows.length; i += 3, o += 4) {
    data[o] = rows[i];
    data[o + 1] = rows[i + 1];
    data[o + 2] = rows[i + 2];
    data[o + 3] = 255;
  }
  return { width, height, data };
}

/**
 * RGBA pixels as a PNG, rows unfiltered.
 *
 * UI captures are long runs of identical pixels, which deflate already
 * collapses; a filter turns those runs into varied residues. Measured over
 * twelve bench captures, unfiltered came out 0.79 to 0.83 the size of Sub,
 * Paeth or a per-row best-of-five choice.
 */
export function encodePng(pixels: Pixels, extra: { before?: Chunk[]; after?: Chunk[] } = {}): Buffer {
  const { width, height, data } = pixels;
  const stride = width * 4;
  const packed = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) data.copy(packed, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return writeChunks([
    { type: 'IHDR', data: header },
    ...(extra.before ?? []),
    { type: 'IDAT', data: deflateSync(packed) },
    ...(extra.after ?? []),
    { type: 'IEND', data: Buffer.alloc(0) },
  ]);
}

/** A compressed iTXt chunk: UTF-8, so a record's selectors and page text survive. */
export function textChunk(keyword: string, text: string): Chunk {
  return {
    type: 'iTXt',
    data: Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      // null, compressed, method 0, empty language tag, empty translated keyword
      Buffer.from([0, 1, 0, 0, 0]),
      deflateSync(Buffer.from(text, 'utf-8')),
    ]),
  };
}

/** The iTXt and tEXt chunks of a PNG by keyword. */
export function readText(chunks: Chunk[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { type, data } of chunks) {
    if (type !== 'iTXt' && type !== 'tEXt') continue;
    const end = data.indexOf(0);
    if (end < 0) continue;
    const keyword = data.toString('latin1', 0, end);
    if (type === 'tEXt') {
      found.set(keyword, data.toString('latin1', end + 1));
      continue;
    }
    const compressed = data[end + 1] === 1;
    const language = data.indexOf(0, end + 3);
    const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
    if (translated < 0) continue;
    const body = data.subarray(translated + 1);
    found.set(keyword, (compressed ? inflateSync(body) : body).toString('utf-8'));
  }
  return found;
}

export function cropPixels(pixels: Pixels, rect: { x: number; y: number; w: number; h: number }): Pixels {
  const x0 = Math.max(0, Math.min(pixels.width, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(pixels.height, Math.round(rect.y)));
  const width = Math.max(0, Math.min(pixels.width - x0, Math.round(rect.w)));
  const height = Math.max(0, Math.min(pixels.height - y0, Math.round(rect.h)));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * pixels.width + x0) * 4;
    pixels.data.copy(data, y * width * 4, from, from + width * 4);
  }
  return { width, height, data };
}
