// 清理「本次失败的 Rust 安装」留下的残留。
//
// 这个脚本会删 %USERPROFILE%\.rustup 与 \.cargo —— 那是能毁掉一个正常 Rust 安装的
// 操作，所以它必须真的做到自己承诺的那件事：
//   1. 只删修改时间落在本次尝试窗口内的目录（--within-minutes，默认 240）
//   2. 目录里存在能跑起来的工具链时直接拒绝（--force 才继续）
//   3. 删之前打印清单并要一次确认（--yes 跳过，供无人值守使用）
//
// 用法：
//   node scripts/cleanup-rust.mjs [--within-minutes N] [--force] [--yes]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const H = os.homedir();
const argv = process.argv.slice(2);
const numArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const WITHIN_MS = numArg("--within-minutes", 240) * 60_000;
const FORCE = argv.includes("--force");
const ASSUME_YES = argv.includes("--yes");

const targets = [
  { path: path.join(H, ".rustup"), label: "rustup 工具链与下载缓存" },
  { path: path.join(H, ".cargo"), label: "rustup 管理器（cargo bin 目录）" },
];

function sizeOf(p) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 单个目录读不了不影响整体估算
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(fp);
        else {
          total += fs.statSync(fp).size;
          files++;
        }
      } catch {
        /* 占用中或没权限，跳过 */
      }
    }
  };
  walk(p);
  return { mb: (total / 1048576).toFixed(1), files };
}

/** 有没有「已经能用」的 Rust —— 有就说明这次删除不是清理半成品，而是拆安装 */
function workingInstall() {
  const cargo = path.join(H, ".cargo", "bin", "cargo.exe");
  if (fs.existsSync(cargo)) {
    const v = spawnSync(cargo, ["--version"], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (v.status === 0 && /cargo/.test(v.stdout ?? "")) return v.stdout.trim();
  }
  const toolchains = path.join(H, ".rustup", "toolchains");
  if (fs.existsSync(toolchains)) {
    for (const t of fs.readdirSync(toolchains)) {
      if (fs.existsSync(path.join(toolchains, t, "bin", "cargo.exe"))) return t;
    }
  }
  return null;
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

console.log("正在扫描要删除的内容...\n");

const now = Date.now();
const plan = [];
const skipped = [];

for (const t of targets) {
  if (!fs.existsSync(t.path)) {
    console.log(`  跳过（不存在）: ${t.path}`);
    continue;
  }
  const mtime = fs.statSync(t.path).mtimeMs;
  const ageMin = ((now - mtime) / 60000).toFixed(0);
  if (now - mtime > WITHIN_MS && !FORCE) {
    skipped.push(
      `  ${t.path}  最后修改于 ${ageMin} 分钟前，超出本次尝试窗口（${(WITHIN_MS / 60000) | 0} 分钟）`,
    );
    continue;
  }
  const { mb, files } = sizeOf(t.path);
  plan.push({ ...t, mb, files });
  console.log(`  将删除: ${t.path}`);
  console.log(`          ${t.label}`);
  console.log(`          ${mb} MB / ${files} 个文件`);
}

if (skipped.length) {
  console.log("\n按时间窗口保留（不属于本次失败的安装尝试）：");
  for (const s of skipped) console.log(s);
  console.log("\n确认那是残留可以加 --force。");
}

if (!plan.length) {
  console.log("\n没有需要清理的内容。");
  process.exit(0);
}

const working = workingInstall();
if (working && !FORCE) {
  console.log("\n[x] 检测到本机上有一套**能用**的 Rust：" + working);
  console.log("    这个脚本只该用来清理中断安装的残留，不该拆掉正常安装。");
  console.log("    （删除 .cargo 会一并带走 ~/.cargo/config.toml 与其中的凭证。）");
  console.log("    确实要重来一遍：node scripts/cleanup-rust.mjs --force");
  process.exit(1);
}

const totalMb = plan.reduce((a, p) => a + Number(p.mb), 0);
console.log(`\n合计 ${totalMb.toFixed(1)} MB\n`);

// 清单先落盘再动手：万一删错了，至少知道删了什么。
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = path.join(process.cwd(), `cleanup-${stamp}.txt`);
fs.writeFileSync(
  archive,
  [
    `清理时间: ${new Date().toLocaleString("zh-CN")}`,
    `时间窗口: 最近 ${(WITHIN_MS / 60000) | 0} 分钟内修改过的目录`,
    `检测到的可用工具链: ${working ?? "无"}`,
    "",
    "被删除的目录:",
    ...plan.map((p) => `  ${p.path}  (${p.mb} MB / ${p.files} 文件)  ${p.label}`),
    "",
    "重新安装方式：双击 安装Rust环境.bat",
  ].join("\n") + "\n",
  "utf8",
);
console.log(`清单已存档: ${archive}`);

if (!ASSUME_YES) {
  const a = process.stdin.isTTY
    ? await ask(`\n确认删除上面 ${plan.length} 个目录？输入 yes 继续: `)
    : "";
  if (a !== "yes") {
    console.log("\n已取消，没有删除任何东西。");
    console.log("（非交互环境下需要显式加 --yes）");
    process.exit(1);
  }
}

console.log("\n开始删除...\n");
for (const p of plan) {
  try {
    fs.rmSync(p.path, { recursive: true, force: true });
    console.log(`  已删除: ${p.path}`);
  } catch (err) {
    console.log(`  失败: ${p.path}`);
    console.log(`         ${err.code} ${err.message}`);
    console.log(`         可能是文件被占用，请关闭所有终端后重试`);
  }
}

console.log("\n验证结果:");
let allGone = true;
for (const p of plan) {
  const gone = !fs.existsSync(p.path);
  if (!gone) allGone = false;
  console.log(`  ${gone ? "已清除" : "仍存在"}: ${p.path}`);
}

console.log("");
console.log(allGone ? "清理完成，磁盘空间已释放。" : "部分内容未能删除，详见上方提示。");
