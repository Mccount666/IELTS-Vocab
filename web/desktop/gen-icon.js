// 一次性工具：生成 512x512 应用图标 icon.png（紫底 + 白色双页书页图形）
// 纯 Node 实现（zlib + 手写 PNG chunk），无需任何依赖。node gen-icon.js
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 512;
const RADIUS = 110; // 底板圆角
const BRAND = [123, 97, 255]; // #7b61ff
const BRAND_DARK = [99, 71, 232];

// 与 index.html favicon 同款语言：紫罗兰圆角方块 + 白色书页
function insideRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// 书页：左右两块带圆角的白色页面，中间留出书脊缝隙；底边对齐，顶部内收
function insidePage(x, y, x0, x1, y0, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function pixel(x, y) {
  if (!insideRoundedSquare(x, y)) return [0, 0, 0, 0];
  // 从上到下的品牌色渐变（左上亮、右下深，同 brand-mark 样式）
  const t = (x + y) / (2 * SIZE);
  const base = [
    Math.round(BRAND[0] + (BRAND_DARK[0] - BRAND[0]) * t),
    Math.round(BRAND[1] + (BRAND_DARK[1] - BRAND[1]) * t),
    Math.round(BRAND[2] + (BRAND_DARK[2] - BRAND[2]) * t),
    255,
  ];
  // 双页书页
  const left = insidePage(x, y, 128, 244, 140, 372, 18);
  const right = insidePage(x, y, 268, 384, 140, 372, 18);
  if (left || right) {
    // 页面底部裁掉一点，形成书页堆叠的层次
    if (y > 356 && ((x + y) % 7 < 2) === false) {
      /* keep solid — 简单起见不做纹理，保留纯色页面 */
    }
    return [255, 255, 255, 255];
  }
  return base;
}

// --- 最小 PNG 编码器（RGBA8） ---
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    const p = rowStart + 1 + x * 4;
    raw[p] = r;
    raw[p + 1] = g;
    raw[p + 2] = b;
    raw[p + 3] = a;
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("./icon.png", import.meta.url), png);
console.log("icon.png written:", png.length, "bytes");
