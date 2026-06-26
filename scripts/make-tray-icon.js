#!/usr/bin/env node
// Generates the menu-bar (status bar) template icon as a genuinely transparent
// RGBA PNG and prints its base64 — paste that into TRAY_ICON in src/main.js.
//
// Why hand-rolled: macOS's qlmanage / Quick Look only produce OPAQUE thumbnails,
// which Electron then renders as a solid white square in the tray. There's no
// SVG rasterizer guaranteed on a stock Mac, so we rasterize the simple line-art
// glyph ourselves (signed-distance to each stroke, 2x supersampled) and encode a
// clean RGBA PNG with real alpha using only Node's zlib.
//
// Usage:  node scripts/make-tray-icon.js          # prints base64
//         node scripts/make-tray-icon.js out.png  # also writes a PNG to inspect
const zlib = require("node:zlib");
const fs = require("node:fs");

const S = 36; // 36px == 18pt @2x (createFromBuffer scaleFactor: 2)
const HW = 1.95; // ring stroke half-width (px) — bold, fills the menu bar confidently

// Glyph: a bold "afterglow" ring (the orb outline — matches the app icon).
const cx = 18, cy = 18, R = 11;

function coverage(px, py) {
  const d = Math.abs(Math.hypot(px - cx, py - cy) - R); // signed distance to the ring
  return Math.max(0, Math.min(1, HW - d + 0.5));
}

const raw = Buffer.alloc((S * 4 + 1) * S);
let o = 0;
for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let a = 0;
    for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) a += coverage(x + ox, y + oy);
    a = Math.round((a / 4) * 255);
    raw[o++] = 0; raw[o++] = 0; raw[o++] = 0; raw[o++] = a; // black, real alpha
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0))
]);

if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], png);
  process.stderr.write(`wrote ${process.argv[2]} (${png.length} bytes)\n`);
}
process.stdout.write(png.toString("base64") + "\n");
