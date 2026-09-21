// 修复 .cargo/bin 里 0 字节的 shim。
//
// 原理：rustup 的 shim 就是 rustup.exe 的副本（正常用 hardlink，但本机 hardlink 建不上）。
// rustup 启动后读自己的 argv[0] 判断该扮演哪个工具，所以直接复制即可。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOME = process.env.USERPROFILE ?? os.homedir();
const BIN = path.join(HOME, ".cargo", "bin");
const RUSTUP = path.join(BIN, "rustup.exe");

if (!fs.existsSync(RUSTUP)) {
  console.error("找不到 rustup.exe");
  process.exit(1);
}

const srcSize = fs.statSync(RUSTUP).size;
console.log(`rustup.exe: ${(srcSize / 1048576).toFixed(1)} MB`);
console.log("");

const broken = fs
  .readdirSync(BIN)
  .filter((f) => f.endsWith(".exe") && f !== "rustup.exe" && fs.statSync(path.join(BIN, f)).size === 0);

console.log(`需要修复的 shim: ${broken.length} 个`);
console.log("  " + broken.join(", "));
console.log("");
console.log("开始复制...");

let fixed = 0;
for (const f of broken) {
  const dst = path.join(BIN, f);
  try {
    fs.copyFileSync(RUSTUP, dst);
    fixed++;
  } catch (e) {
    console.log(`  [失败] ${f}: ${e.message}`);
  }
}
console.log(`已修复 ${fixed}/${broken.length} 个`);
console.log("");

// 验证
console.log("=== 验证 ===");
const test = (exe, args) => {
  const p = path.join(BIN, exe);
  if (!fs.existsSync(p)) return "(不存在)";
  const r = spawnSync(p, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  const o = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return o.split("\n")[0] || r.error?.message || "(空)";
};

console.log("cargo --version  =>", test("cargo.exe", ["--version"]));
console.log("rustc --version  =>", test("rustc.exe", ["--version"]));
console.log("rustup --version =>", test("rustup.exe", ["--version"]));
