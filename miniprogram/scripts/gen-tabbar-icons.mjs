// 生成小程序 tabBar 图标（81x81 PNG，无外部依赖：手写 PNG 编码 + 距离场光栅化）
// 用法：node miniprogram/scripts/gen-tabbar-icons.mjs
// 未选中/选中颜色改下面两个常量即可全量重生成
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../assets/tabbar');
const SIZE = 81;
const W = 5;           // 描边宽(px)
const AA = 2;          // 每轴抗锯齿采样数
const COLOR_OFF = [125, 138, 148, 255];  // 未选中 #7d8a94（深底用亮灰）
const COLOR_ON = [45, 212, 191, 255];    // 选中 #2dd4bf

// ---------- 最小 PNG 编码 ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
function encodePNG(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 距离场光栅化 ----------
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
// shapes: {seg:[x1,y1,x2,y2]} 线段 | {ring:[cx,cy,r,yMin,yMax]} 圆环(可裁剪 y 区间)
function rasterize(shapes, color) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let cov = 0;
      for (let sy = 0; sy < AA; sy++) {
        for (let sx = 0; sx < AA; sx++) {
          const px = x + (sx + 0.5) / AA, py = y + (sy + 0.5) / AA;
          let d = Infinity;
          for (const s of shapes) {
            if (s.seg) d = Math.min(d, distToSegment(px, py, ...s.seg));
            else if (s.ring) {
              const dd = Math.abs(Math.hypot(px - s.ring[0], py - s.ring[1]) - s.ring[2]);
              if (s.ring[3] === undefined || (py >= s.ring[3] && py <= s.ring[4])) d = Math.min(d, dd);
            }
          }
          if (d <= W / 2) cov++;
        }
      }
      const a = cov / (AA * AA);
      const i = (y * SIZE + x) * 4;
      rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2];
      rgba[i + 3] = Math.round(color[3] * a);
    }
  }
  return rgba;
}

// ---------- 五个图标的矢量定义（81x81 坐标系） ----------
const seg = (...a) => ({ seg: a });
const ring = (...a) => ({ ring: a });

const ICONS = {
  // 首页：房子
  home: [
    seg(16, 42, 40, 20), seg(40, 20, 64, 42),
    seg(23, 38, 23, 62), seg(58, 38, 58, 62), seg(23, 62, 58, 62),
  ],
  // 文库：叠放的两张文档
  library: [
    { roundrect: [18, 22, 56, 62, 5] },
    { roundrect: [26, 16, 64, 56, 5] },
  ],
  // 生词本：翻开的书
  wordbook: [
    { roundrect: [18, 20, 62, 60, 6] },
    seg(40, 22, 40, 58),
    seg(25, 31, 34, 31), seg(25, 41, 34, 41),
    seg(46, 31, 55, 31), seg(46, 41, 55, 41),
  ],
  // 我的：人像
  settings: [
    ring(40, 27, 10),
    ring(40, 70, 21, 47, 57),
  ],
};

// roundrect 描边：四条边 + 四角圆弧（用采样近似：直接按边线段 + 角环）
function expandRoundRect([x1, y1, x2, y2, r]) {
  return [
    seg(x1 + r, y1, x2 - r, y1), seg(x1 + r, y2, x2 - r, y2),
    seg(x1, y1 + r, x1, y2 - r), seg(x2, y1 + r, x2, y2 - r),
    { arc: [x1 + r, y1 + r, r, 180, 270] },
    { arc: [x2 - r, y1 + r, r, 270, 360] },
    { arc: [x2 - r, y2 - r, r, 0, 90] },
    { arc: [x1 + r, y2 - r, r, 90, 180] },
  ];
}

mkdirSync(OUT, { recursive: true });
for (const [name, shapes0] of Object.entries(ICONS)) {
  const shapes = shapes0.flatMap((s) => (s.roundrect ? expandRoundRect(s.roundrect) : [s]));
  for (const [suffix, color] of [['', COLOR_OFF], ['-active', COLOR_ON]]) {
    const png = encodePNG(rasterize(shapes, color));
    writeFileSync(join(OUT, `${name}${suffix}.png`), png);
  }
}
console.log('tabbar icons regenerated:', Object.keys(ICONS).join(', '));
