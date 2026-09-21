// 生成 Tauri 应用图标：纯 Node 实现，零第三方依赖。
//
// 为什么要手写：把一张设计稿转成 Tauri 要求的那一整套尺寸，通常要装
// Pillow / sharp / tauri icon 之类的东西；而 PNG 与 ICO 的格式本身并不复杂，
// 用内置 zlib 就能编出来 —— 少一个依赖，也少一个会失败的环境问题。
//
// 当前画的是**占位图形**（青绿圆角方块 + 白色对勾）。换成你自己的品牌：
//   - 配色：改下面的 TEAL_DARK / TEAL_LIGHT
//   - 形状：改 drawIcon 里的图形（用的是超采样抗锯齿，不引绘图库）
// 也可以完全不改这个脚本：把设计稿导出的文件名对应上即可 ——
// Tauri 只认下面这几个产物，其它多出来的尺寸 Windows 商店才用得到。
//
// 产物（写入 src-tauri/icons/）：
//   icon.png        1024x1024  母版
//   32x32.png       Tauri bundle 必需
//   128x128.png     Tauri bundle 必需
//   128x128@2x.png  256x256，Windows 高分屏
//   icon.ico        多尺寸 ICO，Tauri bundle 必需
//   Square*.png     Windows Store 资源（备用，不参与当前 nsis 打包）

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "src-tauri", "icons");

// ---------------------------------------------------------------------------
// 像素缓冲：RGBA，非预乘 alpha
// ---------------------------------------------------------------------------

function createCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) };
}

function blendPixel(canvas, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  if (a <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const srcA = a / 255;
  const dstA = canvas.data[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    const src = [r, g, b][c];
    const dst = canvas.data[i + c];
    canvas.data[i + c] = Math.round((src * srcA + dst * dstA * (1 - srcA)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

// 超采样抗锯齿：在每个像素内取 N×N 个子样本，交给 shape 判断是否在图形内。
// 这样圆角、圆环、勾线的边缘都不会有锯齿，且不依赖任何绘图库。
const SS = 4;

function fillShape(canvas, bbox, color, insideTest) {
  const [x0, y0, x1, y1] = bbox;
  const lo = (v) => Math.max(0, Math.floor(v));
  const hi = (v, max) => Math.min(max, Math.ceil(v));
  for (let y = lo(y0); y < hi(y1, canvas.size); y++) {
    for (let x = lo(x0); x < hi(x1, canvas.size); x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (insideTest(px, py)) hits++;
        }
      }
      if (hits === 0) continue;
      const cov = hits / (SS * SS);
      blendPixel(canvas, x, y, [
        color[0],
        color[1],
        color[2],
        Math.round(color[3] * cov),
      ]);
    }
  }
}

function roundedRectTest(x0, y0, x1, y1, radius) {
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius + 1e-9;
  };
}

function circleTest(cx, cy, r) {
  return (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };
}

// 线段用「点到线段距离 + 圆头端点」表达，避免另外实现一套笔帽逻辑。
function capsuleTest(ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  return (px, py) => {
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
    t = Math.min(1, Math.max(0, t));
    const dx = px - (ax + t * vx);
    const dy = py - (ay + t * vy);
    return dx * dx + dy * dy <= halfWidth * halfWidth;
  };
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * size * 4, size * 4).copy(
      raw,
      rowStart + 1,
    );
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO 编码：把 PNG 直接嵌进 ICO（Vista 起支持 PNG 压缩帧）
// ---------------------------------------------------------------------------

function encodeIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  pngBuffers.forEach(({ png, size }, i) => {
    const p = i * 16;
    dir[p] = size >= 256 ? 0 : size; // 0 表示 256
    dir[p + 1] = size >= 256 ? 0 : size;
    dir[p + 2] = 0; // palette
    dir[p + 3] = 0; // reserved
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32BE(0, p + 8);
    dir.writeUInt32LE(png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...pngBuffers.map((b) => b.png)]);
}

// ---------------------------------------------------------------------------
// 图形设计
// ---------------------------------------------------------------------------

const TEAL_DARK = [11, 92, 72, 255]; // #0B5C48 渐变暗端
const TEAL_LIGHT = [29, 158, 117, 255]; // #1D9E75 渐变亮端
const WHITE = [255, 255, 255, 255];

// 圆角方块内的竖直渐变。图标语言里渐变很常见，这里手工做逐行插值。
function gradientColorAt(t) {
  const c = [0, 1, 2].map((i) =>
    Math.round(TEAL_DARK[i] + (TEAL_LIGHT[i] - TEAL_DARK[i]) * t),
  );
  return [c[0], c[1], c[2], 255];
}

function renderIcon(size) {
  const canvas = createCanvas(size);
  const S = size / 1024; // 统一按 1024 设计稿缩放

  // 1) 圆角方块底：留 4% 内边距，符合 Windows 图标安全区
  const pad = 40 * S;
  const radius = 224 * S;
  const box = [pad, pad, size - pad, size - pad];
  const boxTest = roundedRectTest(box[0], box[1], box[2], box[3], radius);

  // 逐行填渐变：先算出每一行属于渐变哪个位置，再统一填充
  for (let y = Math.floor(box[1]); y < Math.ceil(box[3]); y++) {
    const t = (y - box[1]) / (box[3] - box[1]);
    const color = gradientColorAt(t);
    fillShape(canvas, [box[0], y, box[2], y + 1], color, boxTest);
  }

  // 2) 对勾：两段胶囊，圆头端点。
  //    不额外加任何装饰元素 —— 试过右上圆点和横线，都会跟勾抢视觉，
  //    而且在小尺寸下退化成噪点。单一元素才经得起缩放。
  const stroke = 82 * S;
  const p1 = [322 * S, 536 * S];
  const p2 = [452 * S, 660 * S];
  const p3 = [700 * S, 386 * S];
  fillShape(canvas, [0, 0, size, size], WHITE, capsuleTest(p1[0], p1[1], p2[0], p2[1], stroke / 2));
  fillShape(canvas, [0, 0, size, size], WHITE, capsuleTest(p2[0], p2[1], p3[0], p3[1], stroke / 2));

  return canvas;
}

// 小尺寸下细节会糊，单独简化：
//   - 沿用小半径比例，让 16px 也保持"圆角方块"而不是变成圆形
//   - 只用对勾，不加横线，避免高频细节在小尺寸退化成脏点
function renderSmallIcon(size) {
  const canvas = createCanvas(size);
  const S = size / 1024;

  const pad = 26 * S;
  const radius = 190 * S;
  const box = [pad, pad, size - pad, size - pad];
  const boxTest = roundedRectTest(box[0], box[1], box[2], box[3], radius);

  for (let y = Math.floor(box[1]); y < Math.ceil(box[3]); y++) {
    const t = (y - box[1]) / (box[3] - box[1]);
    fillShape(canvas, [box[0], y, box[2], y + 1], gradientColorAt(t), boxTest);
  }

  // 小尺寸勾线加粗、更居中，保证 16px 下依然清晰
  const stroke = 116 * S;
  const p1 = [296 * S, 526 * S];
  const p2 = [434 * S, 660 * S];
  const p3 = [724 * S, 358 * S];
  fillShape(canvas, [0, 0, size, size], WHITE, capsuleTest(p1[0], p1[1], p2[0], p2[1], stroke / 2));
  fillShape(canvas, [0, 0, size, size], WHITE, capsuleTest(p2[0], p2[1], p3[0], p3[1], stroke / 2));

  return canvas;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];

  const write = (name, buf) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, buf);
    written.push({ name, bytes: buf.length });
  };

  // 母版与各尺寸 PNG
  const sizes = [
    { name: "icon.png", size: 1024, small: false },
    { name: "128x128@2x.png", size: 256, small: false },
    { name: "128x128.png", size: 128, small: true },
    { name: "32x32.png", size: 32, small: true },
  ];

  const pngCache = new Map();
  for (const s of sizes) {
    const canvas = s.small ? renderSmallIcon(s.size) : renderIcon(s.size);
    const png = encodePng(canvas);
    pngCache.set(s.size, png);
    write(s.name, png);
  }

  // Windows Store 方形资源，尺寸必须是标准值
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    write(`Square${size}x${size}Logo.png`, encodePng(renderSmallIcon(size)));
  }

  // ICO：嵌入 16/24/32/48/64/128/256，Windows 会按需挑选
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = icoSizes.map((size) => {
    let png = pngCache.get(size);
    if (!png) png = encodePng(size >= 128 ? renderIcon(size) : renderSmallIcon(size));
    return { size, png };
  });
  write("icon.ico", encodeIco(frames));

  console.log("图标已生成 ->", OUT_DIR);
  for (const w of written) {
    console.log(`  ${w.name.padEnd(24)} ${(w.bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`共 ${written.length} 个文件`);
}

main();
