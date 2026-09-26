/**
 * How two captures of the same region differ, pixel by pixel.
 *
 * Colour distance is measured in YIQ, which weights a change by how visible it
 * is: an RGB distance counts a shift in blue the same as the same shift in
 * green, which the eye barely registers.
 *
 * A pixel over the threshold on an anti-aliased edge is set apart rather than
 * counted. Text and curves re-rasterise with one-pixel differences between two
 * renders of the same page, and counted they would report a change on every
 * capture of anything with text in it.
 */

import type { Pixels } from './png.js';

export interface PixelDiff {
  /** Pixels that changed, anti-aliasing excluded. */
  changed: number;
  /**
   * Pixels over the threshold set apart as anti-aliased edges.
   *
   * The test reads either capture, so an edge pixel of text in the before that
   * a solid block now covers is set apart too: over rendered text, a changed
   * region undercounts by its text's edge pixels. Reported so a large count
   * beside a small `changed` is read as that.
   */
  edges: number;
  /** Share of the compared area that changed, 0 to 1. */
  share: number;
  /** Smallest box holding every changed pixel, absent when none changed. */
  box?: { x: number; y: number; w: number; h: number };
  /** Width and height compared: the larger of the two in each direction. */
  width: number;
  height: number;
  /** The after capture greyed, changed pixels red, anti-aliased ones amber. */
  image: Pixels;
}

/** Largest YIQ distance between two colours: black against white. */
const MAX_DELTA = 35215;

/** Pixel `i` of `data` blended onto white, since a transparent pixel is shown on white. */
function rgb(data: Buffer, i: number): [number, number, number] {
  const a = data[i + 3] / 255;
  return [
    255 + (data[i] - 255) * a,
    255 + (data[i + 1] - 255) * a,
    255 + (data[i + 2] - 255) * a,
  ];
}

function brightness(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}

/** Squared YIQ distance, signed by which colour is brighter. */
function delta(a: Buffer, i: number, b: Buffer, j: number, lumaOnly = false): number {
  const [r1, g1, b1] = rgb(a, i);
  const [r2, g2, b2] = rgb(b, j);
  if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
  const y = brightness(r1, g1, b1) - brightness(r2, g2, b2);
  if (lumaOnly) return y;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  const d = 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
  return y > 0 ? -d : d;
}

/** Whether the pixel has at least three neighbours of exactly its colour, in `img`. */
function flat(img: Pixels, x: number, y: number): boolean {
  const { width, height, data } = img;
  const at = (y * width + x) * 4;
  let same = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = (ny * width + nx) * 4;
      if (data.readUInt32LE(at) === data.readUInt32LE(n) && ++same > 2) return true;
    }
  }
  return false;
}

/**
 * Whether the pixel sits on an anti-aliased edge in `img`.
 *
 * An edge pixel is an intermediate shade: among its neighbours there is one
 * darker and one lighter than it, and each of those is a flat run of colour in
 * both captures - the solid on either side of the edge. A pixel with more than
 * two neighbours of its own brightness is part of a flat area, not an edge.
 */
function antialiased(img: Pixels, x: number, y: number, other: Pixels): boolean {
  const { width, height, data } = img;
  const at = (y * width + x) * 4;
  let equal = 0;
  let min = 0;
  let max = 0;
  let minX = -1, minY = -1, maxX = -1, maxY = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const d = delta(data, at, data, (ny * width + nx) * 4, true);
      if (d === 0) {
        if (++equal > 2) return false;
      } else if (d < min) {
        min = d; minX = nx; minY = ny;
      } else if (d > max) {
        max = d; maxX = nx; maxY = ny;
      }
    }
  }
  if (min === 0 || max === 0) return false;
  const inBounds = (px: number, py: number) => px < other.width && py < other.height;
  return (flat(img, minX, minY) && inBounds(minX, minY) && flat(other, minX, minY))
    || (flat(img, maxX, maxY) && inBounds(maxX, maxY) && flat(other, maxX, maxY));
}

/** `img` placed top-left on a transparent canvas of the given size. */
function pad(img: Pixels, width: number, height: number): Pixels {
  if (img.width === width && img.height === height) return img;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(data, y * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return { width, height, data };
}

/**
 * Compare two captures. `threshold` is the share of the largest colour
 * distance a pixel may move before it counts, 0.05 by default: at 0.1 a card
 * background moving from #fdd to #eef, plain to the eye, stays under it.
 * Anti-aliased edges are set apart by their own test, not by this one.
 *
 * Captures of different sizes are compared on the larger of each, top-left
 * aligned, so area one has and the other lacks counts as changed.
 */
export function diffPixels(before: Pixels, after: Pixels, threshold = 0.05): PixelDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const a = pad(before, width, height);
  const b = pad(after, width, height);
  const limit = MAX_DELTA * threshold * threshold;
  const out = Buffer.alloc(width * height * 4);

  let changed = 0;
  let edges = 0;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.abs(delta(a.data, i, b.data, i));
      if (d > limit) {
        if (antialiased(a, x, y, b) || antialiased(b, x, y, a)) {
          out[i] = 255; out[i + 1] = 190; out[i + 2] = 0; out[i + 3] = 255;
          edges++;
          continue;
        }
        out[i] = 230; out[i + 1] = 30; out[i + 2] = 30; out[i + 3] = 255;
        changed++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        continue;
      }
      // Unchanged pixels greyed and faded, so the red reads against its context.
      const [r, g, bl] = rgb(b.data, i);
      const grey = 255 + (brightness(r, g, bl) - 255) * 0.25;
      out[i] = out[i + 1] = out[i + 2] = grey;
      out[i + 3] = 255;
    }
  }

  return {
    changed,
    edges,
    share: width * height ? changed / (width * height) : 0,
    ...(changed ? { box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } } : {}),
    width,
    height,
    image: { width, height, data: out },
  };
}

/** A dashed rectangle outline drawn into `img`, clipped to it. */
export function strokeDashed(
  img: Pixels,
  rect: { x: number; y: number; w: number; h: number },
  colour: [number, number, number],
  thickness = 2,
  dash = 8,
): void {
  const plot = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = colour[0]; img.data[i + 1] = colour[1]; img.data[i + 2] = colour[2]; img.data[i + 3] = 255;
  };
  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const x1 = Math.round(rect.x + rect.w) - 1;
  const y1 = Math.round(rect.y + rect.h) - 1;
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x <= x1; x++) {
      if (Math.floor((x - x0) / dash) % 2) continue;
      plot(x, y0 + t);
      plot(x, y1 - t);
    }
    for (let y = y0; y <= y1; y++) {
      if (Math.floor((y - y0) / dash) % 2) continue;
      plot(x0 + t, y);
      plot(x1 - t, y);
    }
  }
}

/**
 * Before, after and difference side by side, as one picture.
 *
 * One file holds all three so a single read shows the comparison at the size
 * it was captured; three files would need three reads lined up by eye.
 */
export function sideBySide(panels: Pixels[], gap = 12): Pixels {
  const height = Math.max(...panels.map(p => p.height));
  const width = panels.reduce((sum, p) => sum + p.width, 0) + gap * (panels.length - 1);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 120;
    data[i + 3] = 255;
  }
  let left = 0;
  for (const panel of panels) {
    for (let y = 0; y < panel.height; y++) {
      panel.data.copy(data, (y * width + left) * 4, y * panel.width * 4, (y + 1) * panel.width * 4);
    }
    left += panel.width + gap;
  }
  return { width, height, data };
}
