// 安装 Rust（GNU 目标）。
//
// 实际流程在 launchers.mjs 的 install-rust 里（「安装Rust环境.bat」用的同一份）：
// 下载 rustup-init.exe、按官方 .sha256 校验、再执行。
// 这里只是一个 npm 入口，避免同一件事维护两份 —— 之前正是两份导致
// 这份引用了仓库里根本不存在的 .test-rustup.mjs。

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const r = spawnSync(process.execPath, [path.join(__dirname, "launchers.mjs"), "install-rust"], {
  stdio: "inherit",
  windowsHide: true,
});

process.exit(r.status ?? 1);
