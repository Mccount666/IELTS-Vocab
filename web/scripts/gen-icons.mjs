// 生成 PWA 图标：icon-192.png / icon-512.png / icon-maskable-512.png
// 纯 Node 实现（zlib + 手写 PNG chunk），与 desktop/gen-icon.js 同一套绘制语言，
// 只是参数化尺寸，并额外产出 maskable 版（全出血底 + 内容缩进安全区）。
// 用法：node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const BRAND = [123, 97, 255]; // #7b61ff
const BRAND_DARK = [99, 71, 232];

function makePng(size, { maskable = false } = {}) {
  // 圆角半径按 512 基准等比缩放；maskable 版全出血方形 + 图形缩进到中央 76% 安全区
  const unit = size / 512;
  const radius = maskable ? 0 : 110 * unit;
  const inset = maskable ? 0.76 : 1;

  const insideRoundedSquare = (x, y) => {
    if (maskable) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // 书页几何按 512 基准定义，缩放 + 居中
  const page = (x, y, x0, x1, y0, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  const scale = (v) => {
    const c = 256;
    return (c + (v - c) * inset) * unit;
  };
  const pages = [
    [scale(128), scale(244), scale(140), scale(372), 18 * unit * inset],
    [scale(268), scale(384), scale(140), scale(372), 18 * unit * inset],
  ];

  const pixel = (x, y) => {
    if (!insideRoundedSquare(x, y)) return [0, 0, 0, 0];
    const t = (x + y) / (2 * size);
    const base = [
      Math.round(BRAND[0] + (BRAND_DARK[0] - BRAND[0]) * t),
      Math.round(BRAND[1] + (BRAND_DARK[1] - BRAND[1]) * t),
      Math.round(BRAND[2] + (BRAND_DARK[2] - BRAND[2]) * t),
      255,
    ];
    for (const [x0, x1, y0, y1, r] of pages) {
      if (page(x, y, x0, x1, y0, y1, r)) return [255, 255, 255, 255];
    }
    return base;
  };

  // --- 最小 PNG 编码器（RGBA8） ---
  const crc32 = (buf) => {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size, opts] of [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
]) {
  const png = makePng(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name} written:`, png.length, "bytes");
}
