// 安装 Rust（GNU 目标）。
// rustup 默认装到 %USERPROFILE%\.cargo 与 .rustup —— 用户目录，不需要管理员权限。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TMP = path.join("C:", "AI_Production", "Tools", "main", ".setup-tmp");
const EXE = path.join(TMP, "rustup-init.exe");
const LOG = path.join(TMP, "rustup-install.log");

if (!fs.existsSync(EXE)) {
  console.log("找不到 rustup-init.exe，先跑 .test-rustup.mjs");
  process.exit(1);
}

console.log("开始安装 Rust（GNU 目标，minimal profile）...");
console.log("预计下载 200-400 MB，请耐心等待。");
console.log("");

const start = Date.now();
const r = spawnSync(
  EXE,
  [
    "-y",
    "--default-toolchain",
    "stable",
    "--profile",
    "minimal",
    "--default-host",
    "x86_64-pc-windows-gnu",
  ],
  {
    encoding: "utf8",
    timeout: 900000,
    windowsHide: true,
    cwd: TMP,
    env: { ...process.env, RUSTUP_INIT_SKIP_PATH_CHECK: "yes" },
  },
);

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const combined = `status=${r.status}\nerror=${r.error?.message ?? "无"}\n\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}`;

fs.writeFileSync(LOG, combined, "utf8");

console.log(`耗时 ${elapsed}s，status=${r.status}`);
console.log("");
console.log((r.stdout ?? "").slice(-3000));
if (r.stderr) {
  console.log("--- stderr ---");
  console.log(r.stderr.slice(-2000));
}

// 验证安装结果
console.log("");
console.log("=== 验证 ===");
const cargo = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "cargo.exe");
const rustc = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "rustc.exe");
console.log("cargo.exe:", fs.existsSync(cargo) ? "已安装" : "缺失");
console.log("rustc.exe:", fs.existsSync(rustc) ? "已安装" : "缺失");

if (fs.existsSync(cargo)) {
  const v = spawnSync(cargo, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  console.log("cargo 版本:", (v.stdout ?? "").trim() || v.error?.message);
}
if (fs.existsSync(rustc)) {
  const v = spawnSync(rustc, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  console.log("rustc 版本:", (v.stdout ?? "").trim() || v.error?.message);
}
