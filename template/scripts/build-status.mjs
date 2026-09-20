// 打包进度速查：随时运行，立刻看到当前状态。
//
//   node scripts/build-status.mjs
//
// 为什么需要它：Rust 首次编译要十分钟上下，中间没有输出，
// 干等很容易让人以为卡死了。这个脚本一秒钟给出真实进度。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, ROOT } from "./project.mjs";

const TARGET = path.join(ROOT, "src-tauri", "target");

// 找出「真正的」release 目录。
//
// 显式指定 target triple（GNU 工具链就会）时，产物在 target/<triple>/release/ 下，
// 而 target/release/ 可能残留着早期其他构建方式的空壳。
// 所以判断依据是「bundle/nsis 是否存在」，而不是目录名。
function findReleaseDir() {
  const roots = [];
  // 宿主布局：没传 --target（例如 .cargo/config.toml 还不存在时的首编）
  const host = path.join(TARGET, "release");
  if (fs.existsSync(host)) roots.push(host);

  if (fs.existsSync(TARGET)) {
    for (const entry of fs.readdirSync(TARGET, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(TARGET, entry.name, "release");
      if (fs.existsSync(p)) roots.push(p);
    }
  }

  const withBundle = roots.find((r) => fs.existsSync(path.join(r, "bundle", "nsis")));
  if (withBundle) return withBundle;

  // 还没到打包阶段时，退而选依赖最多的那个，说明是活跃的编译目录
  let best = null;
  let bestN = -1;
  for (const r of roots) {
    const d = path.join(r, "deps");
    const n = fs.existsSync(d) ? fs.readdirSync(d).length : 0;
    if (n > bestN) {
      bestN = n;
      best = r;
    }
  }
  return best ?? path.join(TARGET, "release");
}

const RELEASE = findReleaseDir();
const BUNDLE = path.join(RELEASE, "bundle", "nsis");
const DEPS = path.join(RELEASE, "deps");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function treeSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const fp = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(fp);
        else {
          bytes += fs.statSync(fp).size;
          files++;
        }
      } catch {
        /* 忽略占用中的文件 */
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

console.log("");
console.log(`=== ${PRODUCT} · 打包状态 ===`);
console.log("");

// 编译目录
if (!fs.existsSync(TARGET)) {
  console.log(yellow("尚未开始编译") + `${dim("（target 目录不存在）")}`);
  console.log("");
  console.log("运行打包：双击「打包桌面版.bat」");
  process.exit(0);
}

const { bytes, files } = treeSize(TARGET);
const depsCount = fs.existsSync(DEPS) ? fs.readdirSync(DEPS).length : 0;

console.log(`编译中间产物：${(bytes / 1048576).toFixed(0)} MB${dim(`（${files} 个文件）`)}`);
console.log(`已编译依赖数：${depsCount}`);
console.log("");

// 进度参考线：Tauri 应用完整编译大约产出 1.5-2.5 GB、700-900 个依赖
if (bytes < 300 * 1048576) {
  console.log(`${yellow("阶段")}  正在早期编译（依赖下载/编译中）`);
} else if (bytes < 1200 * 1048576) {
  console.log(`${yellow("阶段")}  正在编译依赖（这是最耗时的一段）`);
} else {
  console.log(`${yellow("阶段")}  接近尾声（正在链接或打包）`);
}

console.log("");

// 最终产物
if (fs.existsSync(BUNDLE)) {
  const items = fs.readdirSync(BUNDLE);
  const exe = items.filter((f) => f.endsWith("-setup.exe"));
  const sig = items.filter((f) => f.endsWith(".sig"));
  if (exe.length) {
    console.log(green("安装包已生成："));
    for (const f of exe) {
      console.log(`  ${f}  ${dim((fs.statSync(path.join(BUNDLE, f)).size / 1048576).toFixed(1) + " MB")}`);
    }
    for (const f of sig) {
      console.log(`  ${f}  ${dim("(更新签名)")}`);
    }
    console.log("");
    console.log(`位置：${BUNDLE}`);
  } else {
    console.log(`${yellow("打包中")}${dim("（bundle 目录已建，安装包尚未落盘）")}`);
  }
} else {
  console.log(dim("安装包尚未生成（bundle 目录还没有出现）"));
}

console.log("");
