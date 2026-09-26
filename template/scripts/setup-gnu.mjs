// 配置 GNU 工具链：探测 MinGW 真实路径，生成 src-tauri/.cargo/config.toml。
//
// 为什么不直接写死 C:\msys64 —— 用户可能装在别的盘，或者用 ucrt64 变体。
// 探测 + 校验 + 备份，比让用户在构建失败后自己猜路径要好。
//
// 用法：
//   npm run setup:gnu          配置 GNU 工具链
//   npm run setup:gnu -- --off 关闭 GNU 配置，恢复默认（MSVC）

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { locateMingw, REQUIRED_TOOLS, OPTIONAL_TOOLS } from "./mingw-locate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CARGO_DIR = path.join(ROOT, "src-tauri", ".cargo");
const CONFIG_PATH = path.join(CARGO_DIR, "config.toml");
const BACKUP_PATH = path.join(CARGO_DIR, "config.toml.bak");

const args = process.argv.slice(2);
const turnOff = args.includes("--off");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const say = (s = "") => console.log(s);

// ---------------------------------------------------------------------------
// 关闭模式
// ---------------------------------------------------------------------------

if (turnOff) {
  if (fs.existsSync(CONFIG_PATH)) {
    const backup = `${CONFIG_PATH}.disabled-${Date.now()}`;
    fs.renameSync(CONFIG_PATH, backup);
    say(`${C.green}已关闭 GNU 配置。${C.reset}`);
    say(`原配置备份到：${path.relative(ROOT, backup)}`);
    say("下次构建将使用默认工具链（MSVC）。");
  } else {
    say(`${C.yellow}没有找到 GNU 配置，无需关闭。${C.reset}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 探测 MinGW
// ---------------------------------------------------------------------------

say("");
say(`${C.bold}配置 GNU 工具链${C.reset}`);
say(`${C.dim}${"-".repeat(46)}${C.reset}`);
say("");

// 候选位置与必需组件清单统一由 mingw-locate.mjs 提供 ——
// 与 env-check.mjs、toolchain-path.mjs 同一份，避免三处漂移。
const requiredTools = REQUIRED_TOOLS;
const optionalTools = OPTIONAL_TOOLS;

let found = null;

say("正在查找 MinGW 安装位置…");

const located = locateMingw();
if (located) {
  found = { bin: located.bin, root: located.root, variant: located.variant, gcc: located.gcc };
}

if (!found) {
  say("");
  say(`${C.red}未找到可用的 MinGW-w64（gcc/ar/windres/dlltool 需齐全）。${C.reset}`);
  say("");
  say("两条装法：");
  say("");
  say(`${C.bold}A. 免管理员（本路线）${C.reset} —— 解压到用户目录，不需要提权：`);
  say("  npm run setup:msys2   # 下载 MSYS2 base 存档并解压到 %USERPROFILE%\\msys64");
  say("  npm run setup:mingw   # 从镜像取 MinGW-w64 工具链组件");
  say("  注意：这两个脚本绕开了 pacman 的包签名校验，下载内容不做完整性验证，");
  say("        因此需要显式授权：设 WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1 再运行。");
  say("        能接受 pacman 的话，优先用 B 路线（它验包签名）。");
  say("");
  say(`${C.bold}B. 官方安装程序${C.reset} —— 需要管理员权限，但走 pacman 的签名校验：`);
  say(`  下载 https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/`);
  say("  选最新日期的 msys2-x86_64-<日期>.exe，装完在 MSYS2 MINGW64 终端里：");
  say(`  ${C.bold}pacman -S mingw-w64-x86_64-gcc${C.reset}`);
  say("");
  process.exitCode = 1;
  process.exit(1);
}

say(`  ${C.green}找到 MinGW${C.reset}  ${found.bin}`);
say(`  ${C.dim}变体：${found.variant}${C.reset}`);

// 版本信息，确认可用
let gccVersion = "";
try {
  gccVersion = execFileSync(found.gcc, ["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 8000,
    windowsHide: true,
  })
    .toString()
    .trim()
    .split(/\r?\n/)[0];
} catch {
  /* ignore */
}
if (gccVersion) say(`  ${C.dim}${gccVersion}${C.reset}`);

say("");

// ---------------------------------------------------------------------------
// 检查 LLD（可选，不是必需项）
// ---------------------------------------------------------------------------

const lldPath = path.join(found.bin, "ld.lld.exe");
const hasLld = fs.existsSync(lldPath);

say("检查组件：");
for (const t of requiredTools) {
  const p = path.join(found.bin, t);
  const ok = fs.existsSync(p);
  say(`  ${ok ? C.green + "OK  " + C.reset : C.red + "缺失" + C.reset} ${t}`);
}
for (const t of optionalTools) {
  const p = path.join(found.bin, t);
  const ok = fs.existsSync(p);
  say(`  ${ok ? C.dim + "OK  " + C.reset : C.dim + "缺失" + C.reset} ${t}${C.dim}（可选）${C.reset}`);
}
say(
  `  ${hasLld ? C.green + "OK  " + C.reset : C.dim + "无  " + C.reset} ` +
    `ld.lld.exe${hasLld ? "" : C.dim + "（可选）" + C.reset}`,
);

// 说明：LLD 不是必需项。
// 实测（binutils 2.47 + Rust 1.98，2026-09-26）本模板这类 bin 型 Tauri 应用
// 链接出的 exe 没有导出表，加不加 -exclude-all-symbols 都能链接成功；
// 该参数只是给 cdylib/DLL 形态或更老工具链的保险，成本为零，所以留着。
say("");
if (hasLld) {
  say(`${C.dim}检测到 LLD，链接时会额外加上 -fuse-ld=lld（更快，非必需）。${C.reset}`);
} else {
  say(`${C.dim}未检测到 LLD —— 不影响构建。${C.reset}`);
  say(`${C.dim}符号导出保险由下方 rustflags 里的 -Wl,-exclude-all-symbols 提供，${C.reset}`);
  say(`${C.dim}GNU ld 原生认识这个参数，无需为此安装约 1 GB 的 LLD。${C.reset}`);
}

// ---------------------------------------------------------------------------
// 生成配置
// ---------------------------------------------------------------------------

// Windows 路径在 TOML 里必须转义反斜杠
const esc = (p) => p.replace(/\\/g, "\\\\");
const linker = esc(path.join(found.bin, "gcc.exe"));
const ar = esc(path.join(found.bin, "ar.exe"));

const rustflags = [];
if (hasLld) {
  rustflags.push('  "-C", "link-arg=-fuse-ld=lld",');
}
rustflags.push('  "-C", "link-arg=-Wl,-exclude-all-symbols",');

const content = `# Cargo 配置：GNU 工具链（由 scripts/setup-gnu.mjs 生成，请勿手工编辑）
#
# 生成于 ${new Date().toLocaleString("zh-CN")}
# MinGW 位置：${found.bin}
#
# 两个段的作用不同，别混：
#   [build] target —— 必需。缺了它 cargo 会用 rustup 的默认 toolchain；默认若是
#     msvc，前面所有 crate 都编得过，直到最后链接才报 could not open 'kernel32.lib'。
#   -Wl,-exclude-all-symbols —— 保险，不是本模板的必需项。它约束的是 PE 导出表
#     （序号上限 65535），而 bin 型应用链接出来的 exe 根本没有导出表，
#     实测去掉该参数一样能链接成功。会撞上限的是 cdylib/DLL 形态或较老的
#     binutils + windows crate 组合，留着它成本为零。
#
# 关闭本配置：npm run setup:gnu -- --off

[build]
target = "x86_64-pc-windows-gnu"

[target.x86_64-pc-windows-gnu]
linker = "${linker}"
ar = "${ar}"
rustflags = [
${rustflags.join("\n")}
]
`;

fs.mkdirSync(CARGO_DIR, { recursive: true });

// 备份已有配置，避免覆盖用户自定义
if (fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
  say("");
  say(`${C.dim}已备份原配置到 ${path.relative(ROOT, BACKUP_PATH)}${C.reset}`);
}

fs.writeFileSync(CONFIG_PATH, content, "utf8");

say("");
say(`${C.green}配置已写入${C.reset}  ${path.relative(ROOT, CONFIG_PATH)}`);
say(`  链接器：${path.join(found.bin, "gcc.exe")}`);
say(`  LLD：${hasLld ? "已启用" : "未启用（不影响构建）"}`);
say("  符号溢出：-Wl,-exclude-all-symbols（GNU ld 原生支持，不需要 LLD）");

// ---------------------------------------------------------------------------
// GNU 构建的运行时依赖：WebView2Loader.dll
// ---------------------------------------------------------------------------
//
// 这一步必须做，而且是 GNU 路线特有的坑。
// webview2-com-sys 在 -gnu 目标下是动态链接 WebView2Loader.dll 的，
// 应用启动时必须在 exe 同级目录找到它。
// tauri-build 虽然会把它拷进 target/<triple>/release/，却没加进 bundle.resources，
// 打包器于是完全不知道要装它 —— 生成的 installer.nsi 里一个 .dll 都没有。
// 症状：安装包能装上，双击启动就报「找不到 WebView2Loader.dll」。
//
// 我们已经在 tauri.conf.json 的 bundle.resources 里声明了它，
// 这里负责把源文件从 Rust 依赖里提取到 src-tauri/ 下。

say("");
say(`${C.bold}同步 WebView2Loader.dll${C.reset}`);
const syncScript = path.join(__dirname, "sync-webview2-loader.mjs");
try {
  const out = execFileSync(process.execPath, [syncScript], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    windowsHide: true,
  }).toString();
  process.stdout.write(out);
} catch (e) {
  const msg = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  say(`${C.red}同步失败${C.reset}`);
  if (msg.trim()) say(msg.trim());
  say("");
  say("不解决这一步，安装包会漏装 WebView2Loader.dll，装上也无法启动。");
  say("通常是因为依赖还没解压到 cargo registry，先跑一次 cargo fetch 再重试。");
  say(`修复命令：node ${path.relative(ROOT, syncScript)}`);
  process.exit(1);
}

say("");
say(`${C.bold}下一步${C.reset}`);
say("  1. 确认 Rust 已安装：  rustup --version");
say("  2. 添加 GNU 目标：     rustup target add x86_64-pc-windows-gnu");
say("  3. 打包：             npm run tauri build");
say("");
