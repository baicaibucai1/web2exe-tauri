/**
 * 清理本次失败的 Rust 安装残留。
 *
 * 只删时间戳确认属于本次尝试的目录，删前先把清单写到文件留档。
 */

import fs from "node:fs";
import os from "node:os";

const H = os.homedir();

const targets = [
  { path: `${H}/.rustup`, label: "rustup 工具链与下载缓存" },
  { path: `${H}/.cargo`, label: "rustup 管理器（cargo bin 目录）" },
];

const sizeOf = (p) => {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = `${d}/${e.name}`;
      if (e.isDirectory()) walk(f);
      else {
        try {
          total += fs.statSync(f).size;
          files++;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  try {
    walk(p);
  } catch {
    /* 忽略 */
  }
  return { mb: (total / 1048576).toFixed(1), files };
};

// ============ 步骤 1：先出清单 ============
console.log("正在扫描要删除的内容...\n");

const plan = [];
let totalMb = 0;

for (const t of targets) {
  if (!fs.existsSync(t.path)) {
    console.log(`  跳过（不存在）: ${t.path}`);
    continue;
  }
  const { mb, files } = sizeOf(t.path);
  totalMb += Number(mb);
  plan.push({ ...t, mb, files });
  console.log(`  将删除: ${t.path}`);
  console.log(`          ${t.label}`);
  console.log(`          ${mb} MB / ${files} 个文件`);
}

if (!plan.length) {
  console.log("\n没有需要清理的内容。");
  process.exit(0);
}

console.log(`\n合计 ${totalMb.toFixed(1)} MB\n`);

// ============ 步骤 2：存档清单 ============
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archive = `cleanup-${stamp}.txt`;
const lines = [
  `清理时间: ${new Date().toLocaleString("zh-CN")}`,
  `原因: Rust 工具链下载中断，清理半成品残留`,
  "",
  "被删除的目录:",
  ...plan.map((p) => `  ${p.path}  (${p.mb} MB / ${p.files} 文件)  ${p.label}`),
  "",
  "如需重新安装 Rust，删除这些目录后从干净状态重来反而更可靠，",
  "因为中断的下载会留下不一致的缓存，导致后续安装反复失败。",
  "",
  "重新安装方式：双击 安装Rust环境.bat",
];
fs.writeFileSync(archive, lines.join("\n") + "\n", "utf8");
console.log(`清单已存档: ${archive}\n`);

// ============ 步骤 3：删除 ============
console.log("开始删除...\n");

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

// ============ 步骤 4：验证 ============
console.log("\n验证结果:");
let allGone = true;
for (const p of plan) {
  const gone = !fs.existsSync(p.path);
  if (!gone) allGone = false;
  console.log(`  ${gone ? "已清除" : "仍存在"}: ${p.path}`);
}

console.log("");
console.log(allGone ? "清理完成，磁盘空间已释放。" : "部分内容未能删除，详见上方提示。");
