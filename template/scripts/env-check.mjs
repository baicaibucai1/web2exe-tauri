// 构建环境自检：一次跑完，明确告诉用户「缺什么、装什么、走哪条路」。
//
// 设计原则：
//   - 只读，不安装、不修改任何系统状态
//   - 每条检测项给出可执行的下一步，而不是只报错
//   - 能区分 MSVC 与 GNU 两条路线的就绪度，分别给出结论

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();

// ---------------------------------------------------------------------------
// 输出小工具
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[36m",
};

const lines = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};

const section = (title) => {
  say("");
  say(`${C.bold}${title}${C.reset}`);
  say(`${C.dim}${"-".repeat(Math.max(40, title.length + 8))}${C.reset}`);
};

let missingHard = 0;
let missingSoft = 0;

const check = (label, ok, detail, hint) => {
  const mark = ok ? `${C.green}OK  ${C.reset}` : `${C.red}缺失${C.reset}`;
  say(`  [${mark}] ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ""}`);
  if (!ok) {
    if (hint) say(`           ${C.yellow}-> ${hint}${C.reset}`);
  }
  return ok;
};

// 探测命令是否存在且可执行，返回版本字符串或 null
function probe(cmd, args = ["--version"]) {
  try {
    const out = execFileSync(cmd, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      windowsHide: true,
    });
    return out.toString().trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

// 依次尝试多个候选路径，返回第一个能跑通的。
// Rust 通常装在 %USERPROFILE%\.cargo\bin、MinGW 装在 %USERPROFILE%\msys64，
// 这些目录不一定出现在当前 shell 的 PATH 里，所以不能只靠裸命令名探测 ——
// 否则会误报「Rust 缺失 / MinGW 缺失」，把已经装好的环境说成没装。
function probeFirst(candidates, args = ["--version"]) {
  for (const c of candidates) {
    const v = probe(c, args);
    if (v) return { cmd: c, version: v };
  }
  return null;
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(p, e.name);
      try {
        if (e.isDirectory()) walk(fp);
        else total += fs.statSync(fp).size;
      } catch {
        /* 权限或符号链接问题，跳过 */
      }
    }
  };
  walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

// ---------------------------------------------------------------------------
// 1. 前端侧
// ---------------------------------------------------------------------------

section("1. 前端与 Node 环境");

const nodeVer = process.version;
check("Node.js", true, nodeVer);

const nodeMajor = Number(nodeVer.replace(/^v/, "").split(".")[0]);
check(
  "Node 版本 >= 20",
  nodeMajor >= 20,
  nodeMajor >= 20 ? "" : `当前 ${nodeVer}`,
  "升级 Node 到 20 或更高版本",
);

const hasNm = fs.existsSync(path.join(ROOT, "node_modules"));
check("node_modules 已安装", hasNm, hasNm ? "" : "", "在 main 目录运行 npm install");

const hasDist = fs.existsSync(path.join(ROOT, "dist", "index.html"));
check(
  "前端构建产物 dist/",
  hasDist,
  hasDist ? "" : "",
  "运行 npm run build（打包前必须先生成）",
);

// ---------------------------------------------------------------------------
// 2. 项目文件
// ---------------------------------------------------------------------------

section("2. 项目打包所需文件");

const files = [
  ["src-tauri/tauri.conf.json", "Tauri 配置"],
  ["src-tauri/Cargo.toml", "Rust 依赖清单"],
  ["src-tauri/icons/icon.ico", "应用图标 (ICO)"],
  ["src-tauri/icons/32x32.png", "应用图标 32px"],
  ["src-tauri/icons/128x128.png", "应用图标 128px"],
  ["src-tauri/WebView2Loader.dll", "WebView2 加载器 (GNU 必需)"],
];

let fileMissing = 0;
for (const [rel, desc] of files) {
  const p = path.join(ROOT, rel);
  const ok = fs.existsSync(p);
  if (!ok) fileMissing++;
  check(desc, ok, ok ? "" : rel, ok ? undefined : `缺少文件：${rel}`);
}

// Rust 入口。Tauri 官方模板是 lib.rs（逻辑）+ 薄 main.rs（入口），
// 纯桌面项目只留 main.rs 也完全合法 —— 两种都算通过。
// 别把某个文件名写成必备项：换个模板结构就会被误报成「缺文件」。
{
  const entry = ["src-tauri/src/lib.rs", "src-tauri/src/main.rs"].find((r) =>
    fs.existsSync(path.join(ROOT, r)),
  );
  if (!entry) fileMissing++;
  check(
    "Rust 入口",
    !!entry,
    entry ?? "src-tauri/src/ 下既没有 lib.rs 也没有 main.rs",
    entry ? undefined : "至少要有 main.rs 或 lib.rs 之一",
  );
}

// 更新签名密钥：**第一次使用本来就还没有**，所以不计入缺失项，只给生成方法。
// 若把它算作阻断项，新手第一次双击「打包桌面版.bat」会卡在环境自检这里，
// 反而看不到后面那段真正该看的说明。
{
  const hasKey = fs.existsSync(path.join(ROOT, ".tauri-key"));
  const hasPub = fs.existsSync(path.join(ROOT, ".tauri-key.pub"));
  say("");
  say(`  ${C.dim}更新签名密钥（首次使用需要生成一次）：${C.reset}`);
  say(
    `    私钥 .tauri-key      ${
      hasKey ? `${C.green}已存在${C.reset}` : `${C.yellow}尚未生成${C.reset}`
    }`,
  );
  say(
    `    公钥 .tauri-key.pub  ${
      hasPub ? `${C.green}已存在${C.reset}` : `${C.yellow}尚未生成${C.reset}`
    }`,
  );
  if (!hasKey || !hasPub) {
    say(
      `    ${C.yellow}-> node node_modules/@tauri-apps/cli/tauri.js signer generate -w .tauri-key${C.reset}`,
    );
    say(
      `       ${C.dim}会询问密码，直接回车用空密码；公钥内容粘进 tauri.conf.json 的 plugins.updater.pubkey${C.reset}`,
    );
  }
}

// 图标数量
const iconDir = path.join(ROOT, "src-tauri", "icons");
const iconCount = fs.existsSync(iconDir)
  ? fs.readdirSync(iconDir).filter((f) => /\.(png|ico)$/i.test(f)).length
  : 0;
check("图标文件总数", iconCount >= 14, `${iconCount} 个`, "运行 npm run icons 重新生成");

// GNU 工具链的坑：WebView2Loader.dll 必须在安装包安装后与 exe 同级。
// webview2-com-sys 在 -gnu 目标下是动态链接这个 DLL 的；tauri-build 虽然会把它
// 拷进 target/<triple>/release/，却没有加进 bundle.resources，
// 于是打包器根本不知道要装它 —— 表现为「装得上、一启动就报找不到 DLL」。
// 所以这里额外校验两件事：文件在、配置里声明了。
const wv2Dll = path.join(ROOT, "src-tauri", "WebView2Loader.dll");
const wv2DllOk = fs.existsSync(wv2Dll);
check(
  "WebView2Loader.dll 已就位",
  wv2DllOk,
  wv2DllOk ? `${(fs.statSync(wv2Dll).size / 1024).toFixed(0)} KB` : "src-tauri/WebView2Loader.dll",
  "运行 npm run webview2:sync 从 Rust 依赖中提取",
);

let wv2Declared = false;
try {
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const res = conf?.bundle?.resources;
  const flat = Array.isArray(res) ? res : Object.keys(res ?? {});
  wv2Declared = flat.some((r) =>
    String(r).replace(/\\/g, "/").endsWith("WebView2Loader.dll"),
  );
} catch {
  /* 配置文件本身的问题在上一节已经报过了 */
}
check(
  "WebView2Loader.dll 已声明进 bundle.resources",
  wv2Declared,
  "",
  '在 tauri.conf.json 的 bundle.resources 里加上 "WebView2Loader.dll"，否则不会被打进安装包',
);

// .bat 必须是 **纯 ASCII + CRLF + 无 BOM**。
//
// 最关键的是「纯 ASCII」：cmd.exe 按**字节偏移**定位批处理文件里的行，
// 多字节字符会让偏移逐渐错位，迟早有一行被切在半个字符中间 ——
// 于是 `echo 中文` 变成「不是内部或外部命令」的乱码，多行块也会被拆散。
// 实测同一份内容：纯 ASCII 跑满 69/69 行、stderr 全空；
// 同样长度的 UTF-8 中文只有 19/69 行。小文件碰巧能跑，但不能依赖。
// 正确做法见 scripts/bat-lint.mjs 的注释。
const batNames = fs
  .readdirSync(ROOT)
  .filter((f) => f.toLowerCase().endsWith(".bat"))
  .sort();
const badBats = [];
for (const n of batNames) {
  const buf = fs.readFileSync(path.join(ROOT, n));
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let loneLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) loneLf++;
  }
  let nonAscii = 0;
  for (const b of buf) if (b > 127) nonAscii++;
  const why = [
    hasBom ? "BOM" : "",
    loneLf ? `${loneLf} 处 LF` : "",
    nonAscii ? `${nonAscii} 个非 ASCII 字节` : "",
  ]
    .filter(Boolean)
    .join(" + ");
  if (why) badBats.push(`${n}(${why})`);
}
check(
  `${batNames.length} 个 .bat 的格式`,
  badBats.length === 0,
  badBats.length ? badBats.join("  ") : "纯 ASCII + CRLF + 无 BOM",
  "换行/BOM 可自动修：npm run bat:fix；非 ASCII 需把中文提示移到 Node 脚本里（见 scripts/pack.mjs）",
);

// ---------------------------------------------------------------------------
// 3. Rust 工具链
// ---------------------------------------------------------------------------

section("3. Rust 工具链");

const cargoBinDir = path.join(HOME, ".cargo", "bin");

const rustc = probeFirst([path.join(cargoBinDir, "rustc.exe"), "rustc"]);
const cargo = probeFirst([path.join(cargoBinDir, "cargo.exe"), "cargo"]);
const rustup = probeFirst([path.join(cargoBinDir, "rustup.exe"), "rustup"]);

const hasRust = Boolean(rustc && cargo);
check("rustc", Boolean(rustc), rustc?.version ?? "", "安装 Rust：见下方「推荐路线」");
check("cargo", Boolean(cargo), cargo?.version ?? "", "安装 Rust：见下方「推荐路线」");
check("rustup", Boolean(rustup), rustup?.version ?? "", "安装 rustup 以管理工具链");

// 已安装的工具链
let toolchains = [];
if (rustup) {
  try {
    const out = execFileSync(rustup.cmd, ["toolchain", "list"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      windowsHide: true,
    });
    toolchains = out.toString().trim().split(/\r?\n/).filter(Boolean);
  } catch {
    /* ignore */
  }
}
if (toolchains.length) {
  say(`  ${C.dim}已装工具链：${toolchains.join(" / ")}${C.reset}`);
}

let defaultToolchain = null;
if (rustup) {
  try {
    defaultToolchain = execFileSync(rustup.cmd, ["show", "active-toolchain"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    /* ignore */
  }
}
if (defaultToolchain) {
  say(`  ${C.dim}默认工具链：${defaultToolchain}${C.reset}`);
}

if (!hasRust) missingHard++;

// ---------------------------------------------------------------------------
// 4. MSVC 工具链（路线 A 需要）
// ---------------------------------------------------------------------------

section("4. 路线 A 依赖：MSVC C++ 生成工具");

const vsRoots = [
  ["C:/Program Files/Microsoft Visual Studio", "VS 2022 (64 位)"],
  ["C:/Program Files (x86)/Microsoft Visual Studio", "VS (32 位安装位置)"],
  ["C:/Program Files (x86)/Windows Kits", "Windows SDK"],
  ["C:/Program Files/Windows Kits", "Windows SDK (备用位置)"],
];

let vsFound = false;
for (const [r, label] of vsRoots) {
  const exists = fs.existsSync(r);
  if (exists) vsFound = true;
  check(label, exists, exists ? r : "", exists ? undefined : "未安装");
}

// 注意：git-bash 里也有个 coreutils 的 link.exe / cl 可能被同名工具顶掉，
// 这里把明显不是 MSVC 的输出过滤掉，避免把「MSVC 没装」误报成「链接器就绪」。
const looksLikeMsvc = (s) => Boolean(s) && !/coreutils|GNU|BusyBox/i.test(s);
const clPath = [probe("cl", ["/?"]), probe("cl")].find(looksLikeMsvc) ?? null;
const linkPath = [probe("link", ["/?"]), probe("link")].find(looksLikeMsvc) ?? null;
check("cl.exe (编译器)", Boolean(clPath), clPath ? clPath.slice(0, 60) : "", "随 MSVC 生成工具一起安装");
check("link.exe (链接器)", Boolean(linkPath), linkPath ? linkPath.slice(0, 60) : "", "随 MSVC 生成工具一起安装");

const msvcReady = vsFound && Boolean(linkPath);
if (!msvcReady) missingHard++;

// ---------------------------------------------------------------------------
// 5. GNU 工具链（路线 B 需要）
// ---------------------------------------------------------------------------

section("5. 路线 B 依赖：MinGW-w64 (MSYS2)");

// 常见安装位置 + 用户目录（免安装解压版默认落在 ~/msys64）+ PATH，全都试一遍
const gccCandidates = [
  path.join(HOME, "msys64", "mingw64", "bin", "gcc.exe"),
  path.join(HOME, "msys64", "ucrt64", "bin", "gcc.exe"),
  "C:/msys64/mingw64/bin/gcc.exe",
  "C:/msys64/ucrt64/bin/gcc.exe",
  "C:/msys2/mingw64/bin/gcc.exe",
];
let gccPath = null;
for (const c of gccCandidates) {
  if (fs.existsSync(c)) {
    gccPath = c;
    break;
  }
}
if (!gccPath) {
  const which = probe("gcc");
  if (which) gccPath = which;
}

const gccVer = gccPath ? probe(gccPath) : null;
check("gcc.exe (MinGW-w64)", Boolean(gccPath), gccVer ?? "", "通过 MSYS2 安装 mingw-w64-x86_64-gcc");

// ld / windres / dlltool 是否齐全 —— 这三个缺一个就会在链接阶段失败
const mingwBin = gccPath ? path.dirname(gccPath) : null;
const needed = ["gcc.exe", "ar.exe", "windres.exe", "dlltool.exe", "nm.exe"];
let mingwComplete = true;
if (mingwBin) {
  for (const n of needed) {
    const ok = fs.existsSync(path.join(mingwBin, n));
    if (!ok) mingwComplete = false;
    say(
      `        ${ok ? C.green + "OK  " + C.reset : C.red + "缺失" + C.reset} ${n}`,
    );
  }
} else {
  say(`        ${C.dim}未找到 MinGW，跳过组件检查${C.reset}`);
  mingwComplete = false;
}

// LLD：**可选**。
// 实测 GNU ld 2.47 已原生支持 -Wl,-exclude-all-symbols，
// 「符号溢出」(export ordinal too large) 靠 .cargo/config.toml 的 rustflags 就能绕过，
// 不必再装约 1 GB 的 LLVM。这里只作信息展示，不计入缺失项。
const lldCandidates = [
  ...(mingwBin ? [path.join(mingwBin, "ld.lld.exe")] : []),
  "ld.lld",
];
const lldPath = probeFirst(lldCandidates)?.cmd ?? null;
say(
  `  [${lldPath ? `${C.green}有  ${C.reset}` : `${C.dim}无  ${C.reset}`}] ` +
    `ld.lld (LLD 链接器)  ${C.dim}${lldPath ?? "可选 —— GNU ld 已能绕过符号溢出，无需安装"}${C.reset}`,
);

// Windows GNU target
let gnuTargetInstalled = toolchains.some((t) => t.includes("windows-gnu"));
check(
  "x86_64-pc-windows-gnu 目标",
  gnuTargetInstalled,
  gnuTargetInstalled ? "" : "",
  "rustup target add x86_64-pc-windows-gnu",
);

const gnuReady = Boolean(gccPath && mingwComplete && hasRust);
if (!gnuReady && !msvcReady) missingSoft++;

// ---------------------------------------------------------------------------
// 6. 打包器依赖
// ---------------------------------------------------------------------------

section("6. NSIS 打包器（两条路线都需要）");

// Tauri 会自动下载 NSIS 到 LOCALAPPDATA
const nsisCache = path.join(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"), "tauri");
const nsisOk = fs.existsSync(nsisCache);
check(
  "NSIS 缓存目录",
  nsisOk,
  nsisOk ? nsisCache : "",
  nsisOk ? undefined : "首次打包时 Tauri 会自动从 GitHub 下载；国内网络可能超时",
);

// WebView2 Runtime
let webviewOk = false;
const wvKeys = [
  "C:/Program Files (x86)/Microsoft/EdgeWebView/Application",
  "C:/Program Files/Microsoft/EdgeWebView/Application",
];
for (const k of wvKeys) {
  if (fs.existsSync(k)) {
    webviewOk = true;
    break;
  }
}
check(
  "WebView2 Runtime",
  webviewOk,
  webviewOk ? "已安装" : "",
  webviewOk ? undefined : "Windows 10 1803+ 通常自带；否则装 Evergreen Bootstrapper",
);

// ---------------------------------------------------------------------------
// 7. 结论
// ---------------------------------------------------------------------------

section("结论");

if (msvcReady) {
  say(`  ${C.green}路线 A（MSVC）已就绪${C.reset} —— 直接运行「打包桌面版.bat」`);
} else {
  say(`  ${C.red}路线 A（MSVC）不可用${C.reset} —— 缺少 C++ 生成工具（约 2-4 GB，需管理员权限）`);
}

if (gnuReady) {
  say(`  ${C.green}路线 B（GNU）已就绪${C.reset} —— 可用 MinGW 打包，无需 C++ 生成工具`);
} else if (hasRust) {
  say(`  ${C.yellow}路线 B（GNU）差 MinGW${C.reset} —— Rust 已装，需补 MSYS2 的 gcc`);
} else {
  say(`  ${C.red}路线 B（GNU）不可用${C.reset} —— 需要 Rust + MinGW-w64`);
}

say("");

if (msvcReady || gnuReady) {
  say(`  ${C.green}可以打包。${C.reset}建议按此顺序验证：`);
  say("    启动开发版.bat   # 浏览器里先看页面效果（最快）");
  say("    启动桌面版.bat   # 在真实窗口里跑一遍，确认没有只在 WebView2 里才犯的毛病");
  say("    打包桌面版.bat   # 产出安装包与更新签名");
} else {
  say(`  ${C.yellow}尚不能打包。${C.reset}推荐按路线 B 补齐环境（比 A 省约 2-4 GB 下载）：`);
  say("");
  say(`  ${C.bold}步骤 1${C.reset}  安装 MSYS2（约 100 MB）`);
  say("     下载：https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/");
  say("     选 msys2-x86_64-<最新日期>.exe");
  say("");
  say(`  ${C.bold}步骤 2${C.reset}  在 MSYS2 终端里装编译器与 LLD`);
  say("     pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-lld");
  say("");
  say(`  ${C.bold}步骤 3${C.reset}  安装 Rust（走清华镜像，避免源站超时）`);
  say("     PowerShell 里执行：");
  say(`       $env:RUSTUP_DIST_SERVER="https://mirrors.tuna.tsinghua.edu.cn/rustup"`);
  say("       # 然后运行 rustup-init.exe");
  say("");
  say(`  ${C.bold}步骤 4${C.reset}  加上 GNU 目标`);
  say("     rustup target add x86_64-pc-windows-gnu");
}

say("");
say(`${C.dim}提示：本脚本只做检测，不会安装或修改任何东西。${C.reset}`);

// ---------------------------------------------------------------------------
// 阻断项：任意一条不满足，就一定打不出「装上就能跑」的安装包
// ---------------------------------------------------------------------------

const blockers = [];
if (!hasNm) blockers.push("前端依赖未安装  ->  npm install");
if (!hasDist) blockers.push("前端产物 dist/ 缺失  ->  npm run build");
if (fileMissing > 0) blockers.push(`${fileMissing} 个必需项目文件缺失（见上方第 2 节）`);
if (!hasRust) blockers.push("Rust 工具链缺失  ->  见「安装Rust环境.bat」");
if (!msvcReady && !gnuReady) blockers.push("MSVC 与 GNU 两条路线都不可用");
if (!wv2DllOk) {
  blockers.push("WebView2Loader.dll 缺失  ->  npm run webview2:sync");
} else if (!wv2Declared) {
  blockers.push("WebView2Loader.dll 未声明进 bundle.resources（安装包会漏装它）");
}
if (badBats.length > 0) {
  blockers.push(`${badBats.length} 个 .bat 换行格式不对  ->  npm run bat:fix`);
}

section("阻断项");
if (blockers.length === 0) {
  say(`  ${C.green}无${C.reset} —— 环境可以产出「装上就能跑」的安装包。`);
} else {
  for (const b of blockers) say(`  ${C.red}x${C.reset} ${b}`);
}

// ---------------------------------------------------------------------------
// 写出报告
// ---------------------------------------------------------------------------

const reportPath = path.join(ROOT, "环境自检报告.txt");
const plain = lines
  .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
  .join("\r\n");
fs.writeFileSync(reportPath, `${plain}\r\n`, "utf8");
say("");
say(`${C.dim}报告已写入：${reportPath}${C.reset}`);

// 退出码：有阻断项就返回 1，好让「打包桌面版.bat」能在真正编译之前就停下来，
// 而不是白等十几分钟后才在打包阶段失败。
process.exit(blockers.length === 0 ? 0 : 1);
