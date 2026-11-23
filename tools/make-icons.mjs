#!/usr/bin/env node
/**
 * Rasterise the desk mark (public/icon.svg) into the PNG icons the web
 * manifest and iOS need. No image dependency: the mark is three shapes,
 * drawn with signed distances and 4×4 supersampling, written as RGBA PNG.
 *
 *   node tools/make-icons.mjs
 *
 * Re-run after changing the mark; the PNGs are committed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const BG = hex('#0f0f11');
const PAGE = hex('#0a0a0b');
const LINE = hex('#26262b');
const ACCENT = hex('#7c8cf8');

/** Signed distance to a rounded square [0,32]² with corner radius r. */
function roundedRect(x, y, inset, r) {
  const half = 16 - inset;
  const qx = Math.abs(x - 16) - (half - r);
  const qy = Math.abs(y - 16) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to the diamond outline (L1 ball of radius 8.5 around the centre). */
const diamond = (x, y) => Math.abs((Math.abs(x - 16) + Math.abs(y - 16) - 8.5) / Math.SQRT2);
const circle = (x, y) => Math.hypot(x - 16, y - 16) - 2.1;

/**
 * One sample of the mark in its 32-unit space. `framed` draws the rounded
 * tile with its hairline (the "any" icon); otherwise the tile is full
 * bleed so a platform mask (maskable, iOS) can cut its own shape.
 */
function sample(x, y, framed) {
  let rgba = framed ? [0, 0, 0, 0] : [...PAGE, 255];
  if (framed) {
    if (roundedRect(x, y, 0, 7) <= 0) rgba = [...BG, 255];
    if (Math.abs(roundedRect(x, y, 0.5, 6.5)) <= 0.5 && roundedRect(x, y, 0, 7) <= 0) rgba = [...LINE, 255];
  }
  if (diamond(x, y) <= 0.8 || circle(x, y) <= 0) rgba = [...ACCENT, 255];
  return rgba;
}

/**
 * `scale` shrinks the mark around the centre: maskable icons keep their
 * content inside the 80% safe zone, so the diamond is drawn smaller.
 */
function render(size, { framed, scale = 1 }) {
  const SS = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = ((px + (sx + 0.5) / SS) / size) * 32;
          const v = ((py + (sy + 0.5) / SS) / size) * 32;
          const [r, g, b, a] = sample(16 + (u - 16) / scale, 16 + (v - 16) / scale, framed);
          acc[0] += r * a;
          acc[1] += g * a;
          acc[2] += b * a;
          acc[3] += a;
        }
      }
      const o = (py * size + px) * 4;
      const alpha = acc[3] / (SS * SS);
      pixels[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      pixels[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      pixels[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      pixels[o + 3] = Math.round(alpha);
    }
  }
  return png(size, pixels);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, { framed: true }],
  ['icon-512.png', 512, { framed: true }],
  ['maskable-512.png', 512, { framed: false, scale: 0.72 }],
  ['apple-touch-icon.png', 180, { framed: false, scale: 0.9 }],
];
for (const [name, size, opts] of icons) {
  writeFileSync(new URL(name, OUT), render(size, opts));
  console.log(`public/icons/${name} ${size}×${size}`);
}
