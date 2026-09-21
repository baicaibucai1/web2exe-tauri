#!/usr/bin/env node
/**
 * sync-webview2-loader.mjs —— 同步 / 校验 WebView2Loader.dll
 *
 * 为什么需要这个脚本？
 * ------------------------------------------------------------------
 * 本项目的 Windows 构建走 GNU 工具链（x86_64-pc-windows-gnu）。
 * webview2-com-sys 在 GNU 目标下是**动态**链接 WebView2Loader.dll 的，
 * 所以应用启动时必须在 exe 同级目录找到这个 DLL。
 *
 * tauri-build 确实知道这件事：它的 build.rs 里有一段 `"gnu" =>` 分支，
 * 会把 DLL 从 webview2-com-sys 的 out 目录拷到 target/<triple>/release/ 下
 * （见 tauri-build 的 src/lib.rs，搜 WebView2Loader.dll 即可定位）。
 *
 * 但它**只拷到 target 目录，没有把 DLL 加进 bundle.resources**，
 * 于是 NSIS 打包器完全不知道要装它 —— 生成的 installer.nsi 里连一个 .dll 都没有。
 * 结果就是：安装成功，双击启动却报「找不到 WebView2Loader.dll」。
 *
 * 这是 Tauri 对 GNU 目标的遗漏，不是我们的配置错误。
 *
 * 解法：把 DLL 作为资源放进 src-tauri/，并在 tauri.conf.json 的
 * bundle.resources 里声明。List 形式下资源目标路径 = 源路径，
 * 所以 "WebView2Loader.dll" 会被安装到 $INSTDIR\WebView2Loader.dll ——
 * 正好是 exe 同级，符合 Windows 的 DLL 搜索顺序。
 *
 * 本脚本负责让 src-tauri/WebView2Loader.dll 与 Cargo.lock 里锁定的
 * webview2-com-sys 版本保持一致，避免手工拷贝导致版本漂移。
 *
 * 用法：
 *   node scripts/sync-webview2-loader.mjs            # 同步（缺失或哈希不符则拷贝）
 *   node scripts/sync-webview2-loader.mjs --check    # 只校验，不同步；不符则退出码 1
 *   node scripts/sync-webview2-loader.mjs --arch x86 # 指定架构（默认 x64）
 *   node scripts/sync-webview2-loader.mjs --quiet    # 只在出错时输出
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const CARGO_LOCK = path.join(SRC_TAURI, 'Cargo.lock');
const TARGET_DLL = path.join(SRC_TAURI, 'WebView2Loader.dll');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const QUIET = argv.includes('--quiet');
const archIdx = argv.indexOf('--arch');
const ARCH = archIdx >= 0 ? argv[archIdx + 1] : 'x64';

const log = (...a) => { if (!QUIET) console.log(...a); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function die(msg, hint) {
  console.error('\n[x] ' + msg);
  if (hint) console.error('    ' + hint);
  process.exit(1);
}

/* ---------- 1. 从 Cargo.lock 读出 webview2-com-sys 的确切版本 ---------- */

/**
 * 读 Cargo.lock 里锁定的 webview2-com-sys 版本。读不到返回 null。
 *
 * 返回 null 不是错误，见主流程的降级分支：全新项目第一次打包时
 * Cargo.lock 还没生成，此时唯一可用的就是项目里自带的那份 DLL。
 */
function readWebView2Version() {
  if (!fs.existsSync(CARGO_LOCK)) return null;
  const lock = fs.readFileSync(CARGO_LOCK, 'utf8');
  // Cargo.lock 的 [[package]] 段落形如：
  //   [[package]]
  //   name = "webview2-com-sys"
  //   version = "0.38.2"
  const re =
    /\[\[package\]\]\s*\n\s*name\s*=\s*"webview2-com-sys"\s*\n\s*version\s*=\s*"([^"]+)"/;
  const m = lock.match(re);
  return m ? m[1] : null;
}

/* ---------- 2. 在 cargo registry 里定位 DLL 的权威来源 ---------- */

/** 找到返回路径，找不到返回 null（crate 源码还没解压到本机） */
function findRegistrySource(version) {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const srcRoot = path.join(cargoHome, 'registry', 'src');
  if (!fs.existsSync(srcRoot)) return null;

  for (const reg of fs.readdirSync(srcRoot)) {
    const crate = path.join(srcRoot, reg, `webview2-com-sys-${version}`);
    if (!fs.existsSync(crate)) continue;
    const dll = path.join(crate, ARCH, 'WebView2Loader.dll');
    if (fs.existsSync(dll)) return dll;
  }
  return null;
}

/* ---------- 3. 主流程 ---------- */

const version = readWebView2Version();
const source = version ? findRegistrySource(version) : null;

// 拿不到权威来源时，项目里自带的 DLL 就是当前唯一可用的一份。
//
// 这条路**必须存在**：全新项目第一次打包时 Cargo.lock 还没生成、crate 也还没
// 解压到本机，如果在这里直接失败就形成死锁 —— 要打包得先构建，而要构建得先打包。
// 而模板本身就预置了一份可用的 DLL，首次构建时用它完全没问题。
if (!source) {
  if (!fs.existsSync(TARGET_DLL)) {
    die(
      'src-tauri/WebView2Loader.dll 不存在，也无法从 cargo 依赖里获取',
      '先在 src-tauri/ 下执行一次 cargo fetch（会下载并解压 webview2-com-sys），或手动放入该 DLL。',
    );
  }
  const kb = (fs.statSync(TARGET_DLL).size / 1024).toFixed(0);
  log('WebView2Loader.dll 同步');
  log('  来源      : 项目内已有文件（' + (version ? 'registry 里还没解压该 crate' : 'Cargo.lock 尚未生成') + '）');
  log('  目标      : ' + path.relative(ROOT, TARGET_DLL) + '  ' + kb + ' KB');
  log('  ✓ 跳过版本核对 —— 首次构建用它即可，构建完成后可重跑本脚本核对\n');
  process.exit(0);
}

const srcBuf = fs.readFileSync(source);
const srcHash = sha256(srcBuf);

log('WebView2Loader.dll 同步');
log('  版本      : webview2-com-sys ' + version);
log('  权威来源  : ' + source);
log('  目标      : ' + path.relative(ROOT, TARGET_DLL));
log('  架构      : ' + ARCH);
log('  源哈希    : ' + srcHash);

if (!fs.existsSync(TARGET_DLL)) {
  if (CHECK_ONLY) {
    die('src-tauri/WebView2Loader.dll 缺失',
        '运行 node scripts/sync-webview2-loader.mjs 生成。');
  }
  fs.copyFileSync(source, TARGET_DLL);
  log('  动作      : 已复制（此前不存在）');
  log('  ✓ 完成\n');
  process.exit(0);
}

const dstBuf = fs.readFileSync(TARGET_DLL);
const dstHash = sha256(dstBuf);

if (dstHash === srcHash) {
  log('  目标哈希  : ' + dstHash);
  log('  ✓ 已是最新，无需处理\n');
  process.exit(0);
}

if (CHECK_ONLY) {
  console.error('');
  console.error('[x] src-tauri/WebView2Loader.dll 与 Cargo.lock 锁定的版本不一致');
  console.error('    期望(cargo): ' + srcHash);
  console.error('    当前(项目) : ' + dstHash);
  console.error('    这通常意味着 webview2-com-sys 被升级了，需要重新同步。');
  console.error('    修复：node scripts/sync-webview2-loader.mjs');
  process.exit(1);
}

fs.copyFileSync(source, TARGET_DLL);
log('  目标哈希  : ' + dstHash + '  →  ' + srcHash);
log('  动作      : 已覆盖（版本漂移）');
log('  ✓ 完成\n');
