// 下载并解压免安装版 MSYS2。
//
// 为什么用 tar.xz 而不是官方安装程序：
//   安装程序 (msys2-x86_64-*.exe) 需要管理员权限写入 C:\msys64。
//   而这个 base 存档解压到用户目录即可，全程不需要提权。
//
// 代价：没有 pacman 的包签名校验，所以要求显式授权（见 toolchain-download.mjs）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTo, requireConsent } from "./toolchain-download.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(path.resolve(__dirname, ".."), ".setup-tmp");
const HOME = os.homedir();
const DEST = HOME; // 解压后会在 home 下产生 msys64/ 目录
const ARCHIVE = path.join(TMP, "msys2-base.tar.xz");
const URL = "https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/msys2-x86_64-latest.tar.xz";

// 先要授权，再动文件系统
requireConsent("MSYS2 base 存档", "npm run setup:msys2");

fs.mkdirSync(TMP, { recursive: true });

// 磁盘空间检查
console.log("=== 磁盘空间 ===");
const df = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-PSDrive C).Free"], {
  encoding: "utf8",
  timeout: 30000,
  windowsHide: true,
});
const free = Number((df.stdout ?? "").trim());
if (free) console.log(`C 盘可用: ${(free / 1073741824).toFixed(1)} GB`);

// 下载
if (!fs.existsSync(ARCHIVE)) {
  console.log("");
  console.log("下载 MSYS2 base (51 MB)...");
  const start = Date.now();
  if (!downloadTo(URL, ARCHIVE)) {
    console.error("下载失败，未做任何改动。");
    process.exit(1);
  }
  console.log(`耗时=${((Date.now() - start) / 1000).toFixed(1)}s`);
} else {
  console.log("");
  console.log("存档已存在，跳过下载");
}

console.log(`存档大小: ${(fs.statSync(ARCHIVE).size / 1048576).toFixed(1)} MB`);

// 解压
console.log("");
console.log(`解压到: ${DEST}`);
console.log("（约 300-600 MB 展开，需要一两分钟）");

const start = Date.now();
const ex = spawnSync("tar.exe", ["-xf", ARCHIVE, "-C", DEST], {
  encoding: "utf8",
  timeout: 900000,
  windowsHide: true,
});
console.log(`status=${ex.status} 耗时=${((Date.now() - start) / 1000).toFixed(1)}s`);
if (ex.stderr) console.log("stderr:", ex.stderr.slice(0, 1000));
if (ex.status !== 0) {
  console.error("解压失败（存档可能不完整），已保留文件供排查：" );
  console.error(`  ${ARCHIVE}`);
  process.exit(1);
}

// 验证
console.log("");
console.log("=== 验证 ===");
const msys = path.join(DEST, "msys64");
console.log("msys64 目录:", fs.existsSync(msys) ? "已创建" : "缺失");
if (fs.existsSync(msys)) {
  const items = fs.readdirSync(msys).slice(0, 15);
  console.log("内容:", items.join(", "));
  const pacman = path.join(msys, "usr", "bin", "pacman.exe");
  console.log("pacman.exe:", fs.existsSync(pacman) ? "存在" : "缺失");
  const bash = path.join(msys, "usr", "bin", "bash.exe");
  console.log("bash.exe:", fs.existsSync(bash) ? "存在" : "缺失");
}
