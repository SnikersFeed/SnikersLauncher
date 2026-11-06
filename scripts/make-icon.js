'use strict';

/**
 * Генерирует build/icon.png (512x512) без внешних зависимостей.
 * electron-builder сам конвертирует PNG в .ico при сборке.
 *
 * Запуск: npm run icon
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Буква S в сетке 5x7.
const S_PATTERN = [
  '01111',
  '10000',
  '10000',
  '01110',
  '00001',
  '00001',
  '11110',
];

const canvas = Buffer.alloc(SIZE * SIZE * 4);
const center = SIZE / 2;
const half = SIZE / 2;
const radius = 96;

const from = { r: 182, g: 255, b: 125 }; // #b6ff7d
const to = { r: 123, g: 217, b: 79 }; // #7bd94f
const ink = { r: 11, g: 20, b: 6 }; // #0b1406

const cell = 44;
const glyphWidth = 5 * cell;
const glyphHeight = 7 * cell;
const glyphX = Math.round((SIZE - glyphWidth) / 2);
const glyphY = Math.round((SIZE - glyphHeight) / 2);

function inGlyph(x, y) {
  const column = Math.floor((x - glyphX) / cell);
  const row = Math.floor((y - glyphY) / cell);

  if (column < 0 || column > 4 || row < 0 || row > 6) return false;
  return S_PATTERN[row][column] === '1';
}

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const dx = Math.max(Math.abs(x + 0.5 - center) - (half - radius), 0);
    const dy = Math.max(Math.abs(y + 0.5 - center) - (half - radius), 0);
    const distance = Math.hypot(dx, dy) - radius;
    const alpha = clamp01(0.5 - distance);

    const offset = (y * SIZE + x) * 4;

    if (alpha <= 0) {
      canvas[offset + 3] = 0;
      continue;
    }

    const t = clamp01((x + y) / (SIZE * 2 - 2));
    let r = lerp(from.r, to.r, t);
    let g = lerp(from.g, to.g, t);
    let b = lerp(from.b, to.b, t);

    // Тень под буквой.
    if (inGlyph(x, y - 10)) {
      r = Math.round(r * 0.82);
      g = Math.round(g * 0.82);
      b = Math.round(b * 0.82);
    }

    if (inGlyph(x, y)) {
      r = ink.r;
      g = ink.g;
      b = ink.b;
    }

    canvas[offset] = r;
    canvas[offset + 1] = g;
    canvas[offset + 2] = b;
    canvas[offset + 3] = Math.round(alpha * 255);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
header[10] = 0;
header[11] = 0;
header[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  canvas.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const output = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, png);

console.log(`Иконка: ${output} (${png.length} байт)`);
