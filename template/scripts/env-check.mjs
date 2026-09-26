// 构建环境自检：一次跑完，明确告诉用户「缺什么、装什么、走哪条路」。
//
// 设计原则：
//   - 不安装、不改系统状态（只在本目录写一份「环境自检报告.txt」）
//   - 每条检测项给出可执行的下一步，而不是只报错
//   - 能区分 MSVC 与 GNU 两条路线的就绪度，分别给出结论

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { locateMingw, REQUIRED_TOOLS } from "./mingw-locate.mjs";

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

const check = (label, ok, detail, hint) => {
  const mark = ok ? `${C.green}OK  ${C.reset}` : `${C.red}缺失${C.reset}`;
  say(`  [${mark}] ${label}${detail ? `  ${C.dim}${detail}${C.reset}` : ""}`);
  if (!ok) {
    if (hint) say(`           ${C.yellow}-> ${hint}${C.reset}`);
  }
  return ok;
};

// 探测命令是否存在且可执行，返回版本字符串或 null。
//
// 非零退出也可能带着有效输出：`cl /?`、`link /?` 打完横幅就返回非零，
// 直接把这类输出丢掉会把「装了」误报成「没装」。
function probe(cmd, args = ["--version"]) {
  try {
    const out = execFileSync(cmd, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      windowsHide: true,
    });
    return firstLine(out);
  } catch (e) {
    const partial = e?.stdout;
    if (partial && partial.length) return firstLine(partial);
    return null;
  }
}

const firstLine = (buf) => buf.toString().trim().split(/\r?\n/)[0] || null;

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

// ---------------------------------------------------------------------------
// 1. 前端侧
// ---------------------------------------------------------------------------

section("1. 前端与 Node 环境");

const nodeVer = process.version;
const nodeMajor = Number(nodeVer.replace(/^v/, "").split(".")[0]);
check(
  "Node 版本 >= 20",
  nodeMajor >= 20,
  `当前 ${nodeVer}`,
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
      `       ${C.dim}会询问密码；要加密保存就先设 WEB2EXE_UPDATER_PASSWORD（直接回车=空密码，私钥等同明文）${C.reset}`,
      `       ${C.dim}公钥内容粘进 tauri.conf.json 的 plugins.updater.pubkey${C.reset}`,
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
let ident = "";
let productName = "";
let pubkey = "";
let endpoints = [];
try {
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const res = conf?.bundle?.resources;
  const flat = Array.isArray(res) ? res : Object.keys(res ?? {});
  wv2Declared = flat.some((r) =>
    String(r).replace(/\\/g, "/").endsWith("WebView2Loader.dll"),
  );
  ident = String(conf?.identifier ?? "");
  productName = String(conf?.productName ?? "");
  pubkey = String(conf?.plugins?.updater?.pubkey ?? "");
  endpoints = (conf?.plugins?.updater?.endpoints ?? []).map(String);
} catch {
  /* 配置文件本身的问题在上一节已经报过了 */
}
check(
  "WebView2Loader.dll 已声明进 bundle.resources",
  wv2Declared,
  "",
  '在 tauri.conf.json 的 bundle.resources 里加上 "WebView2Loader.dll"，否则不会被打进安装包',
);

const IDENT_PLACEHOLDER = !ident || /^com\.example\./i.test(ident);
const PUBKEY_PLACEHOLDER = !pubkey || pubkey === "REPLACE_WITH_YOUR_TAURI_PUBKEY";
const ENDPOINT_PLACEHOLDER =
  endpoints.length === 0 || endpoints.some((u) => /your-host|example\.com/i.test(u));
// endpoints 指向真实地址 = 这次是要发给别人用的，占位值就该在此刻拦下来
const willPublish = !ENDPOINT_PLACEHOLDER;

/*
 * identifier 撞车的真实后果 —— 依据本机生成的 installer.nsi：
 *   !define BUNDLEID "<identifier>" 只被用在卸载段
 *   （RmDir /r "$APPDATA\${BUNDLEID}" 与 "$LOCALAPPDATA\${BUNDLEID}"），
 *   而安装目录与卸载注册表键用的是 PRODUCTNAME。
 * 也就是说 identifier 决定的是**数据目录归属**（app data、WebView2 的
 * user-data/EBWebView、single-instance / deep-link / 通知 APPID），跟"更新通道"无关 ——
 * 更新通道由 endpoints + pubkey 决定。
 * 实测两点（2026-09-26，见 docs/05 最后一节）：
 *   - 应用一跑起来就创建 $LOCALAPPDATA\<identifier>\EBWebView（本次 8 MB）；
 *   - 那两行 RmDir 被 `${If} $DeleteAppDataCheckboxState = 1` 卡着，状态取自
 *     卸载界面的"删除应用数据"勾选框，**静默卸载 (/S) 不删数据**。
 * 所以事故形态是：两款应用共用一个 identifier 时读写同一份数据
 * （cookie / localStorage / 插件状态互相污染），而任一款在**交互式卸载勾选
 * 删数据**时，会把另一款的数据整目录删掉。
 */
const reminders = [];
if (IDENT_PLACEHOLDER) {
  reminders.push(
    `identifier 仍是占位值（${ident || "空"}）—— 共用它的应用会读写同一份 $LOCALAPPDATA\\<identifier>（含 WebView2 的 cookie/localStorage），交互式卸载勾选"删除应用数据"时还会连带删掉对方的数据`,
  );
}
if (PUBKEY_PLACEHOLDER) {
  reminders.push("updater 公钥仍是占位符 —— 首次打包会自动填，手动改坏过就要自己补");
}
if (ENDPOINT_PLACEHOLDER) {
  reminders.push(
    `updater endpoints 还是占位地址（${endpoints.join(", ") || "空"}）—— 应用检查更新会一直失败`,
  );
}
if (/[^\x00-\x7F]/.test(productName)) {
  reminders.push(
    `productName 含非 ASCII（${productName}）—— 安装包文件名会带中文，建议改 ASCII、界面中文放窗口 title`,
  );
}
for (const r of reminders) say(`  ${C.yellow}提醒${C.reset} ${r}`);

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

// ---------------------------------------------------------------------------
// 5. GNU 工具链（路线 B 需要）
// ---------------------------------------------------------------------------

section("5. 路线 B 依赖：MinGW-w64 (MSYS2)");

// 候选位置与必需组件清单由 mingw-locate.mjs 提供 —— 与 setup-gnu.mjs、
// toolchain-path.mjs 同一份。以前这里另写了一份 5 条的候选列表，并且把
// probe() 返回的**版本字符串**当成路径用（path.dirname 得到 "."，于是组件全判缺失），
// 结果装在同一台机器上能过、装在 D 盘或 clang64 上就说你缺 MinGW。
const mingw = locateMingw();
const mingwBin = mingw?.bin ?? null;
const gccVer = mingw ? probe(mingw.gcc) : null;

check(
  "gcc.exe (MinGW-w64)",
  Boolean(mingw),
  gccVer ?? "",
  "通过 MSYS2 安装 mingw-w64-x86_64-gcc（免管理员装法见 docs/02）",
);

// windres / dlltool 缺一个就会在最后一步链接失败
const needed = [...REQUIRED_TOOLS, "nm.exe"];
let mingwComplete = Boolean(mingw);
if (mingwBin) {
  say(`        ${C.dim}位置：${mingwBin}${C.reset}`);
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

// LLD：**可选**，这里只作信息展示，不计入缺失项。
// 实测（binutils 2.47 + Rust 1.98，2026-09-26）：本模板这类 bin 型应用链接出的
// exe 没有导出表，去掉 -exclude-all-symbols 也照样链接成功；这个参数是给
// cdylib/DLL 形态或更老工具链的保险。无论哪种情况都不需要额外装约 1 GB 的 LLVM。
const lldCandidates = [
  ...(mingwBin ? [path.join(mingwBin, "ld.lld.exe")] : []),
  "ld.lld",
];
const lldPath = probeFirst(lldCandidates)?.cmd ?? null;
say(
  `  [${lldPath ? `${C.green}有  ${C.reset}` : `${C.dim}无  ${C.reset}`}] ` +
    `ld.lld (LLD 链接器)  ${C.dim}${lldPath ?? "可选 —— 链接不需要它"}${C.reset}`,
);

// Windows GNU target
const gnuTargetInstalled = toolchains.some((t) => t.includes("windows-gnu"));
check(
  "x86_64-pc-windows-gnu 目标",
  gnuTargetInstalled,
  "",
  "rustup target add x86_64-pc-windows-gnu",
);

// GNU 目标没装的话，setup-gnu 写的 config 会把 target 钉成 x86_64-pc-windows-gnu，
// 构建直接失败 —— 所以它算就绪度的一部分，不是可选项。
const gnuReady = Boolean(mingwComplete && hasRust && gnuTargetInstalled);

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
// 没有它应用起不来。Win11 内置，Win10 靠系统更新推送，LTSC/离线机器可能没有；
// 但开发机上缺了不影响打包（安装包默认会联网补装），所以只提示、不阻断。
check(
  "WebView2 Runtime",
  webviewOk,
  webviewOk ? "已安装" : "",
  webviewOk ? undefined : "本机没有也无妨：NSIS 安装包的 webviewInstallMode 会补装",
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
} else if (hasRust && mingwComplete && !gnuTargetInstalled) {
  say(`  ${C.yellow}路线 B（GNU）差最后一步${C.reset} —— MinGW 齐了，但没装 GNU 目标：`);
  say(`           ${C.bold}rustup target add x86_64-pc-windows-gnu${C.reset}`);
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
  say(`  ${C.bold}步骤 1${C.reset}  装 MSYS2 + MinGW（约 100-700 MB）`);
  say("     免管理员（解压到用户目录，全程不提权）：");
  say("       set WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1");
  say("       npm run setup:msys2");
  say("       npm run setup:mingw");
  say("     注意：这条路绕开了 pacman 的包签名校验，风险与理由见 docs/02。");
  say("     能接受管理员权限时更推荐官方安装程序 + pacman（它验包签名）：");
  say("       https://mirrors.tuna.tsinghua.edu.cn/msys2/distrib/x86_64/");
  say("       装完在 MSYS2 MINGW64 终端里：pacman -S mingw-w64-x86_64-gcc");
  say("");
  say(`  ${C.bold}步骤 2${C.reset}  安装 Rust（走清华镜像，避免源站超时）`);
  say("     最省事：双击「安装Rust环境.bat」并选 GNU —— 它会先按官方 .sha256");
  say("     校验 rustup-init.exe 再执行。");
  say("     想自己跑：rustup-init.exe 时选 x86_64-pc-windows-gnu（默认是 MSVC）。");
  say("");
  say(`  ${C.bold}步骤 3${C.reset}  补 GNU 目标并写工具链配置`);
  say("     rustup target add x86_64-pc-windows-gnu");
  say("     npm run setup:gnu   # 探测 MinGW 路径，生成 src-tauri/.cargo/config.toml");
}

say("");
say(`${C.dim}提示：本脚本不安装、不改系统状态，只在本目录写一份「环境自检报告.txt」。${C.reset}`);

// ---------------------------------------------------------------------------
// 阻断项：任意一条不满足，就打不出「装上就能跑、发布不会撞车」的安装包
// ---------------------------------------------------------------------------

const blockers = [];
if (!hasNm) blockers.push("前端依赖未安装  ->  npm install");
if (!hasDist) blockers.push("前端产物 dist/ 缺失  ->  npm run build");
if (fileMissing > 0) blockers.push(`${fileMissing} 个必需项目文件缺失（见上方第 2 节）`);
if (!hasRust) blockers.push("Rust 工具链缺失  ->  见「安装Rust环境.bat」");
if (!msvcReady && !gnuReady) {
  blockers.push(
    gnuTargetInstalled || !hasRust
      ? "MSVC 与 GNU 两条路线都不可用  ->  见上方「尚不能打包」的步骤"
      : "缺 x86_64-pc-windows-gnu 目标  ->  rustup target add x86_64-pc-windows-gnu",
  );
}
if (!wv2DllOk) {
  blockers.push("WebView2Loader.dll 缺失  ->  npm run webview2:sync");
} else if (!wv2Declared) {
  blockers.push("WebView2Loader.dll 未声明进 bundle.resources（安装包会漏装它）");
}
if (badBats.length > 0) {
  blockers.push(`${badBats.length} 个 .bat 换行格式不对  ->  npm run bat:fix`);
}
// 这条不是「打不出包」，是「打出来的包会在别人机器上撞车」：
// endpoints 已经填成真实地址 = 这次是要发布的，占位 identifier 必须在这里拦下。
// 只想本地试包的话把 endpoints 留成占位地址即可（那时它只是提醒）。
if (IDENT_PLACEHOLDER && willPublish) {
  blockers.push(
    `要发布但 identifier 仍是占位值（${ident || "空"}）  ->  改成自己的反向域名；` +
      `共用会让多款应用读写同一个数据目录，卸载其中一款（勾选删数据时）会连带删掉别家的`,
  );
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
