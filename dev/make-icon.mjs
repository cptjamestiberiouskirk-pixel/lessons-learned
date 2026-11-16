#!/usr/bin/env node
// Draws the plugin's icon: a checklist of three ticked rows on a rounded
// square. Writes plugins/lessons-learned/.claude-plugin/icon.png (512 x 512,
// RGBA). Uses only Node's built-in modules.
//
//   node dev/make-icon.mjs

import {writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SIZE = 512;
const SAMPLES = 4; // per axis, for anti-aliasing
const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'plugins/lessons-learned/.claude-plugin/icon.png');

const BACKGROUND = [30, 95, 116];
const TICK = [244, 201, 93];
const LINE = [255, 255, 255];
const FADED = [150, 190, 200];

// Distance from point p to the segment a-b.
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedSquare(x, y, radius) {
  const qx = Math.abs(x - SIZE / 2) - (SIZE / 2 - radius);
  const qy = Math.abs(y - SIZE / 2) - (SIZE / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius <= 0;
}

const rows = [150, 256, 362];
// The color of one sample point, or null outside the icon.
function sample(x, y) {
  if (!roundedSquare(x, y, 104)) return null;
  for (const [i, ry] of rows.entries()) {
    const tick = Math.min(segment(x, y, 112, ry, 138, ry + 26), segment(x, y, 138, ry + 26, 186, ry - 30));
    if (tick <= 13) return TICK;
    if (segment(x, y, 236, ry, 404 - i * 46, ry) <= 16) return i === 2 ? FADED : LINE;
  }
  return BACKGROUND;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const c = sample(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
    }
    const o = row + 1 + x * 4;
    if (a) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
    raw[o + 3] = Math.round((255 * a) / (SAMPLES * SAMPLES));
  }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, {level: 9})),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
