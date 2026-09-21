#!/usr/bin/env node
/**
 * toolchain-path.mjs —— 打印工具链需要追加到 PATH 的目录，用 `;` 连接
 *
 * 为什么需要它？
 * ------------------------------------------------------------------
 * .bat 双击运行时用的是**用户持久 PATH**，而本项目有两处依赖不在里面：
 *
 * 1. `%USERPROFILE%\.cargo\bin` —— rustup 通常会写进持久 PATH，
 *    但用户装完 Rust 后没重开窗口时，当前 cmd 是拿不到的。
 * 2. MinGW 的 `bin` —— **一定不在 PATH 里**（我们是解压在用户目录的）。
 *    而 GNU 目标下 `embed-resource` 是用裸命令名 `windres` 去调它的
 *    （见 embed-resource 的 windows_not_msvc.rs：`Compiler::windres("windres")`），
 *    找不到就编译失败。
 *
 * 所以 .bat 不能指望「用户环境刚好配好」，要自己把这两段加进 PATH。
 *
 * MinGW 的路径从 `src-tauri/.cargo/config.toml` 里读 ——
 * 那是 setup-gnu.mjs 生成的，也是 cargo 真正会用的那份，属于单一数据源；
 * 读不到才回退到常见位置探测。
 *
 * 输出约定：stdout **只有一行**（`;` 连接的目录），方便 bat 用 for /f 接住。
 * 诊断信息一律走 stderr。
 *
 * 用法：
 *   node scripts/toolchain-path.mjs          # 打印 "目录1;目录2"
 *   node scripts/toolchain-path.mjs --quote  # 用引号包起来（含空格时更安全）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARGO_CONFIG = path.join(ROOT, 'src-tauri', '.cargo', 'config.toml');

const dirs = [];
const note = (s) => process.stderr.write(s + '\n');

// ---------------------------------------------------------------------------
// 1. cargo / rustc
// ---------------------------------------------------------------------------

const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
if (fs.existsSync(cargoBin)) {
  dirs.push(cargoBin);
} else {
  note(`[提示] 未找到 ${cargoBin}，Rust 可能还没装。`);
}

// ---------------------------------------------------------------------------
// 2. MinGW（优先读 cargo 配置里的 linker 路径）
// ---------------------------------------------------------------------------

let mingwBin = null;

if (fs.existsSync(CARGO_CONFIG)) {
  const toml = fs.readFileSync(CARGO_CONFIG, 'utf8');
  // linker = "C:\\Users\\xxx\\msys64\\mingw64\\bin\\gcc.exe"
  const m = toml.match(/^\s*linker\s*=\s*"([^"]+)"/m);
  if (m) {
    // TOML 里反斜杠是转义的，还原成真实路径
    const linker = m[1].replace(/\\\\/g, '\\');
    const candidate = path.dirname(linker);
    if (fs.existsSync(path.join(candidate, 'windres.exe'))) {
      mingwBin = candidate;
    } else {
      note(`[提示] 配置里的 linker 目录没有 windres.exe：${candidate}`);
    }
  }
}

if (!mingwBin) {
  // 回退：探测常见位置（与 setup-gnu.mjs 保持一致）
  const VARIANTS = ['mingw64', 'ucrt64', 'clang64'];
  const ROOTS = [
    path.join(os.homedir(), 'msys64'),
    path.join(os.homedir(), 'msys2'),
    'C:/msys64',
    'C:/msys2',
    'D:/msys64',
    'D:/msys2',
    'C:/tools/msys64',
  ];
  outer: for (const root of ROOTS) {
    for (const variant of VARIANTS) {
      const bin = path.join(root, variant, 'bin');
      if (fs.existsSync(path.join(bin, 'windres.exe')) && fs.existsSync(path.join(bin, 'gcc.exe'))) {
        mingwBin = bin;
        break outer;
      }
    }
  }
  if (mingwBin) note(`[提示] 未读到 cargo 配置，探测到 MinGW：${mingwBin}`);
}

if (mingwBin) {
  dirs.push(mingwBin);
  // MSYS2 的 usr/bin 里有 sh / make 等，某些构建脚本会用到。
  // mingwBin 形如 <root>/mingw64/bin，往上两级就是 <root>。
  const usrBin = path.join(mingwBin, '..', '..', 'usr', 'bin');
  if (fs.existsSync(usrBin)) dirs.push(path.resolve(usrBin));
} else {
  note('[提示] 未找到 MinGW，GNU 目标可能编译失败。');
}

// ---------------------------------------------------------------------------

const joined = dirs.join(';');
const quote = process.argv.includes('--quote');
process.stdout.write(quote ? `"${joined}"` : joined);
