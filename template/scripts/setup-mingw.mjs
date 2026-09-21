// 绕开 pacman，直接从 MSYS2 镜像下载并解压 MinGW-w64 工具链。
//
// 为什么这么做：pacman 需要先初始化 GnuPG 密钥环来验证包签名，
// 而密钥环初始化在这个环境里反复卡住。MSYS2 的包本身只是 tar.zst 归档，
// 本机 bsdtar 支持 zstd，直接解压即可 —— 不需要 pacman、不需要密钥环。
//
// 依赖解析：每个包里的 .PKGINFO 有 depend 字段，用它做广度优先解析。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join("C:", "AI_Production", "Tools", "main");
const TMP = path.join(ROOT, ".setup-tmp");
const CACHE = path.join(TMP, "pkg-cache");
const MSYS = path.join(os.homedir(), "msys64");
const BASE = "https://mirrors.tuna.tsinghua.edu.cn/msys2/mingw/mingw64/";

fs.mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 取包索引（缓存到本地，避免重复下 13 MB）
// ---------------------------------------------------------------------------

const INDEX = path.join(TMP, "mingw64-index.html");

if (!fs.existsSync(INDEX) || fs.statSync(INDEX).size < 1000000) {
  console.log("下载包索引...");
  const r = spawnSync(
    "curl.exe",
    ["-L", "--max-time", "300", "-sS", "-o", INDEX, BASE],
    { encoding: "utf8", timeout: 350000, windowsHide: true },
  );
  console.log("status:", r.status);
}
const html = fs.readFileSync(INDEX, "utf8");
console.log(`索引大小: ${(html.length / 1048576).toFixed(1)} MB`);

// 收集所有包文件名（排除 .sig 签名文件）
const all = [...html.matchAll(/href="([^"]+\.pkg\.tar\.zst)"/g)].map((m) => m[1]);
console.log(`索引内包总数: ${all.length}`);

// 按「包名」归组：文件名形如 <name>-<version>-<release>-any.pkg.tar.zst
// 包名本身含连字符，所以用「已知包名 + 紧随其后的版本号」来匹配。
const byExact = new Map(); // 文件名 -> 完整 URL
for (const f of all) byExact.set(f, BASE + f);

// 版本比较：把数字段按数值比，其余按字典序
function cmpVer(a, b) {
  const pa = a.split(/[.\-_+]/);
  const pb = b.split(/[.\-_+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      if (x === "") return -1;
      if (y === "") return 1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// 给定精确包名，找出最新版本的文件名
function findPackage(name) {
  // 必须紧跟数字开头，避免匹配到 gcc-ada 这类变体
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d[^/]*)-any\\.pkg\\.tar\\.zst$`);
  const hits = [];
  for (const f of all) {
    const m = f.match(re);
    if (m) hits.push({ file: f, ver: m[1] });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVer(a.ver, b.ver));
  return hits[hits.length - 1]; // 最新
}

// ---------------------------------------------------------------------------
// 2. 下载 / 解压 / 读依赖
// ---------------------------------------------------------------------------

const download = (file) => {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const r = spawnSync("curl.exe", ["-L", "--max-time", "600", "-sS", "-o", dest, BASE + file], {
    encoding: "utf8",
    timeout: 650000,
    windowsHide: true,
  });
  if (r.status !== 0 || !fs.existsSync(dest)) {
    console.log(`  [下载失败] ${file} ${r.stderr?.slice(0, 200) ?? ""}`);
    return null;
  }
  return dest;
};

// 从包的 .PKGINFO 读依赖列表
const readDeps = (pkgPath) => {
  const r = spawnSync("tar.exe", ["-xOf", pkgPath, ".PKGINFO"], {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const info = r.stdout ?? "";
  const deps = [];
  for (const line of info.split("\n")) {
    const m = line.match(/^depend\s*=\s*(.+)$/);
    if (m) {
      // 形如 mingw-w64-x86_64-gmp>=6.3.0-1，去掉版本约束
      const name = m[1].trim().split(/[<>=]/)[0].trim();
      if (name) deps.push(name);
    }
  }
  return { deps, info };
};

const extract = (pkgPath, file) => {
  const r = spawnSync("tar.exe", ["-xf", pkgPath, "-C", MSYS], {
    encoding: "utf8",
    timeout: 300000,
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.log(`  [解压失败] ${file} ${r.stderr?.slice(0, 200) ?? ""}`);
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// 3. 广度优先解析依赖
// ---------------------------------------------------------------------------

// 起点：gcc 提供编译器，binutils 提供 ld/ar/windres/dlltool
const SEEDS = ["mingw-w64-x86_64-gcc", "mingw-w64-x86_64-binutils"];

console.log("");
console.log("=== 解析依赖 ===");
console.log("起点:", SEEDS.join(", "));

const visited = new Set();
const queue = [...SEEDS];
const order = []; // 记录解压顺序，依赖先解压
let failed = [];

while (queue.length) {
  const name = queue.shift();
  if (visited.has(name)) continue;
  visited.add(name);

  const found = findPackage(name);
  if (!found) {
    console.log(`  [未找到] ${name}`);
    failed.push(name);
    continue;
  }

  console.log(`  ${name}  ->  ${found.ver}`);
  const pkg = download(found.file);
  if (!pkg) {
    failed.push(name);
    continue;
  }

  const { deps } = readDeps(pkg);
  for (const d of deps) {
    // 只处理 mingw64 自己的包；msys 基础包已随 base 解压存在
    if (d.startsWith("mingw-w64-x86_64-") && !visited.has(d)) queue.push(d);
  }

  order.push({ name, file: found.file, pkg });
}

console.log("");
console.log(`需安装 ${order.length} 个包；未解析到的依赖 ${failed.length} 个`);
if (failed.length) console.log("未解析:", failed.join(", "));

// ---------------------------------------------------------------------------
// 4. 解压（按依赖顺序）
// ---------------------------------------------------------------------------

console.log("");
console.log("=== 解压到 msys64 ===");
let okCount = 0;
for (const { name, file, pkg } of order) {
  const ok = extract(pkg, file);
  if (ok) okCount++;
  console.log(`  ${ok ? "OK  " : "失败"} ${name}`);
}
console.log(`解压成功 ${okCount}/${order.length}`);

// ---------------------------------------------------------------------------
// 5. 验证
// ---------------------------------------------------------------------------

console.log("");
console.log("=== 验证 ===");
const BIN = path.join(MSYS, "mingw64", "bin");
const needed = ["gcc.exe", "ar.exe", "windres.exe", "dlltool.exe", "ld.exe", "nm.exe", "as.exe"];
let ready = 0;
for (const n of needed) {
  const p = path.join(BIN, n);
  const exists = fs.existsSync(p);
  if (exists) ready++;
  console.log(`  ${exists ? "[OK]  " : "[缺失]"} ${n}`);
}
console.log("");
console.log(`就绪 ${ready}/${needed.length}`);

if (ready === needed.length) {
  const v = spawnSync(path.join(BIN, "gcc.exe"), ["--version"], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  console.log("gcc:", ((v.stdout ?? "").trim().split("\n")[0]) || v.error?.message);
  const ld = spawnSync(path.join(BIN, "ld.exe"), ["--version"], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  console.log("ld :", ((ld.stdout ?? "").trim().split("\n")[0]) || ld.error?.message);
}
