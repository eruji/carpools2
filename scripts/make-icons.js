// Renders the favicon.svg shapes (circle + flame) into square PNG icons.
// Pure Node (zlib only) — no external rasterizer needed.
// Re-run after changing favicon.svg:  node scripts/make-icons.js
const zlib = require('zlib');
const fs = require('fs');

// Shapes from public/favicon.svg (64x64 viewBox)
const cx = 32, cy = 32, r = 30, strokeW = 3;
const flame = [[20, 20], [32, 50], [44, 20], [38, 20], [32, 40], [26, 20]];

const COL = {
  bg:    [0xF5, 0xF5, 0xF1, 255], // --bg
  ring:  [0x7C, 0x9A, 0x77, 255], // --accent-dark
  fill:  [0x8F, 0xAE, 0x8B, 255], // --accent
  flame: [0xFF, 0xD3, 0x4D, 255],
};

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// render(size, scale) — scale shrinks the logo inside the canvas (0.8 = maskable safe zone)
function render(size, scale) {
  const s = (size / 64) * scale;
  const off = (size - 64 * s) / 2;
  const SS = 4; // supersample for antialiasing
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rA = 0, gA = 0, bA = 0, aA = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const vx = (x + (sx + 0.5) / SS - off) / s;
        const vy = (y + (sy + 0.5) / SS - off) / s;
        const d = Math.hypot(vx - cx, vy - cy);
        let col;
        if (pointInPoly(vx, vy, flame)) col = COL.flame;
        else if (d <= r) col = COL.fill;
        else if (d <= r + strokeW / 2) col = COL.ring;
        else col = COL.bg;
        rA += col[0]; gA += col[1]; bA += col[2]; aA += col[3];
      }
      const i = (y * size + x) * 4, n = SS * SS;
      px[i] = rA / n; px[i + 1] = gA / n; px[i + 2] = bA / n; px[i + 3] = aA / n;
    }
  }
  return px;
}

// ── Minimal PNG encoder ──
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    buf.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jobs = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.8],
  ['apple-touch-icon.png', 180, 1],
];
for (const [name, size, scale] of jobs) {
  fs.writeFileSync(`public/${name}`, encodePNG(size, render(size, scale)));
  console.log('wrote public/' + name);
}
