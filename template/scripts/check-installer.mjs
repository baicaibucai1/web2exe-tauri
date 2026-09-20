#!/usr/bin/env node
/**
 * check-installer.mjs —— 校验 NSIS 安装包「里面到底装了什么」
 *
 * 为什么需要这个脚本：
 *
 * 打包成功 ≠ 装上能用。踩过的坑都属于「文件在，但没进安装包」：
 *
 *   1. WebView2Loader.dll
 *      GNU 工具链下主程序的 PE 导入表里就有它。tauri-build 会把它拷进
 *      target/，但**不会**加进 bundle.resources → 安装目录里没有 →
 *      双击弹「找不到 WebView2Loader.dll」。release/ 目录里明明有这个文件，
 *      纯属假象，所以「我看过了，在啊」永远不能作为判据。
 *
 *   2. bundle.resources 里声明的资源
 *      那里的 glob 是在**打包那一刻**展开的。改了 tauri.conf.json、挪了目录，
 *      release/ 里照样什么都有，安装包却少了东西 —— 而少了哪个只有清单知道。
 *
 * 所以判据只能是生成的 installer.nsi：它逐文件列着实际写进安装目录的东西，
 * 是唯一可信的清单。
 *
 * 关于 `_up_`：资源路径 `../x` 里的 `..` 会被 Tauri 编码成 `_up_`，
 * 于是装到 $INSTDIR\_up_\x。运行时的 resource_dir 解析用的是同一套规则，
 * 所以两边对得上 —— 这是设计，不是笔误。
 * 配套的坑：代码里若用 assetProtocol 读这些资源，scope 必须写成
 * $RESOURCE/_up_/... 才匹配得上，否则「装好了但读不到」。
 * 详见 docs/05-踩坑记录.md。
 *
 * 用法：
 *   node scripts/check-installer.mjs               # 校验最近一次打包
 *   node scripts/check-installer.mjs --verbose     # 打印完整安装清单
 *   node scripts/check-installer.mjs --nsi <路径>  # 指定 installer.nsi
 *
 * 退出码：0 = 全通过，1 = 有缺漏（可直接当打包后的门禁）
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./project.mjs";

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const nsiArgIdx = argv.indexOf("--nsi");

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  —  " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}
const info = (label, value) => console.log(`         ${label}: ${value}`);

/* ------------------------------------------------------------------ */
/* 1. 找 installer.nsi                                                 */
/* ------------------------------------------------------------------ */

function findNsi() {
  if (nsiArgIdx >= 0 && argv[nsiArgIdx + 1]) {
    const p = path.resolve(argv[nsiArgIdx + 1]);
    return fs.existsSync(p) ? p : null;
  }
  const targetRoot = path.join(ROOT, "src-tauri", "target");
  if (!fs.existsSync(targetRoot)) return null;

  // 两种布局都要认：
  //   target/<triple>/release/nsis/<arch>/installer.nsi  ← 显式指定了 target
  //   target/release/nsis/<arch>/installer.nsi           ← 按宿主目标构建（没传 --target）
  //
  // 第二种是真实踩到的：模板首编时 .cargo/config.toml 还没生成，cargo 用宿主
  // 目标构建，产物直接落在 target/release/ 下 —— 而本函数当时只认第一种，
  // 于是"打包明明成功、校验却说没打过包"。
  const roots = [
    path.join(targetRoot, "release", "nsis"), // 宿主布局
    ...fs.readdirSync(targetRoot).map((triple) => path.join(targetRoot, triple, "release", "nsis")),
  ];
  for (const nsisRoot of roots) {
    if (!fs.existsSync(nsisRoot)) continue;
    for (const arch of fs.readdirSync(nsisRoot)) {
      const c = path.join(nsisRoot, arch, "installer.nsi");
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

console.log("=== 安装包内容校验 ===");
const nsi = findNsi();
if (!nsi) {
  console.error("  [x] 找不到 installer.nsi —— 还没成功打包过 NSIS，或产物被清了。");
  console.error("      先跑：node scripts/build-desktop.mjs");
  process.exit(1);
}
const nsiText = fs.readFileSync(nsi, "utf8");
const nsiLines = nsiText.split(/\r?\n/);

info("脚本", nsi.replace(ROOT + path.sep, ""));
info("打包时间", fs.statSync(nsi).mtime.toLocaleString("zh-CN"));

/* ------------------------------------------------------------------ */
/* 2. 解析 nsi                                                         */
/* ------------------------------------------------------------------ */

/** 取 `!define NAME "VALUE"` */
function def(name) {
  const m = nsiText.match(new RegExp(`^\\s*!define\\s+${name}\\s+"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

const mainBinaryName = def("MAINBINARYNAME");
const mainBinarySrc = def("MAINBINARYSRCPATH");
const productName = def("PRODUCTNAME");
const mainExe = mainBinaryName ? `${mainBinaryName}.exe` : null;

/**
 * 安装段里的 File 行有两种：
 *   File /a "/oname=<装到哪里，相对 $INSTDIR>" "<源文件绝对路径>"
 *   File "${MAINBINARYSRCPATH}"        ← 主程序，装成 ${MAINBINARYNAME}.exe
 * 另外 WebView2 引导程序会 File 到 $TEMP，装完即弃，不算安装内容。
 */
const installFiles = [];
for (const line of nsiLines) {
  const t = line.trim();
  if (!/^File\s/.test(t)) continue;

  if (/\$TEMP/i.test(t)) {
    installFiles.push({ target: "(临时：WebView2 引导程序)", temp: true, raw: t });
    continue;
  }

  const oname = t.match(/\/oname=([^"]+)"/i);
  if (oname) {
    installFiles.push({
      target: oname[1].replace(/\\/g, "/"),
      source: (t.match(/"([^"]+)"\s*$/) || [])[1] || null,
      raw: t,
    });
  } else {
    installFiles.push({ target: mainExe, source: mainBinarySrc, mainBinary: true, raw: t });
  }
}

/** 卸载段的 Delete 清单（把 ${NAME} 展开成实际值后再比对） */
function expandVars(s) {
  return s
    .replace(/\$\{MAINBINARYNAME\}/g, mainBinaryName || "")
    .replace(/\$\{PRODUCTNAME\}/g, productName || "")
    .replace(/\$\{MAINBINARYSRCPATH\}/g, mainBinarySrc || "");
}
const uninstallDeletes = new Set();
for (const line of nsiLines) {
  const m = line.match(/^\s*Delete\s+(?:\/REBOOTOK\s+)?"\$INSTDIR\\?([^"]*)"/i);
  if (m) uninstallDeletes.add(expandVars(m[1]).replace(/\\/g, "/"));
}

const targetSet = new Set(installFiles.map((f) => (f.target || "").toLowerCase()));

/* ------------------------------------------------------------------ */
/* 3. bundle.resources 声明的资源是否全部进包                            */
/* ------------------------------------------------------------------ */

/**
 * glob → RegExp。
 *
 * 关键：必须**一次扫完**，不能先替换 `**` 再替换 `*` ——
 * 第二步会把第一步刚生成的 `.*` 里的星号也吃掉，变成 `.[^/]*`，静默匹配失败。
 */
function globToRe(pat) {
  const norm = pat.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        out += ".*";
        i++;
        if (norm[i + 1] === "/") i++; // `**/` 吃掉后面的斜杠
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

/** 声明里的 `../x` 在安装目录里是 `_up_/x` */
const toInstallRel = (res) => res.replace(/\\/g, "/").replace(/\.\.\//g, "_up_/");

/** 磁盘上真实存在的文件（相对 ROOT，正斜杠） */
function walkRealFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRealFiles(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
let conf = {};
try {
  conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
} catch (e) {
  check("读取 tauri.conf.json", false, String(e?.message ?? e));
}

const rawResources = conf.bundle?.resources ?? [];
// Tauri 2 允许两种写法：字符串数组，或 { 源: 目标 } 映射
const declared = Array.isArray(rawResources)
  ? rawResources
  : Object.keys(rawResources || {});

console.log("");
console.log("--- 1. bundle.resources 声明的资源是否都进了安装包 ---");
info("声明条目", declared.length ? declared.join(" , ") : "（没有声明任何资源）");

// 声明项可能是目录 glob（../public/**/*），也可能是单个文件（WebView2Loader.dll）
const allReal = walkRealFiles(ROOT);
const declaredRel = declared.map(toInstallRel);

if (declared.length === 0) {
  info("结论", "没有声明 resources，这一节跳过");
} else {
  let missing = 0;

  for (const rel of declaredRel) {
    // 声明的是目录 glob 还是具体文件？按是否含通配符区分
    const hasGlob = /[*?]/.test(rel);
    if (!hasGlob) {
      const hit = targetSet.has(rel.toLowerCase());
      // 有的资源会被装到子目录下（oname 带了前缀），所以退一步用后缀匹配
      const loose = [...targetSet].some((t) => t.endsWith(rel.toLowerCase()));
      if (!hit && !loose) missing++;
      check(`资源 ${rel}`, hit || loose, hit || loose ? "" : "安装清单里没有");
      continue;
    }

    // glob：先在磁盘上展开，再看每一项是否在安装清单里
    const re = globToRe(rel);
    const onDisk = allReal.filter((f) => re.test(f));
    if (onDisk.length === 0) {
      check(
        `资源 ${rel} 在磁盘上匹配到文件`,
        false,
        "一个都没匹配到 —— 检查 glob 路径是否写错（相对 src-tauri/，不是项目根）",
      );
      missing++;
      continue;
    }
    const notInstalled = onDisk.filter((f) => {
      const want = toInstallRel(f).toLowerCase();
      return !targetSet.has(want) && ![...targetSet].some((t) => t.endsWith(want));
    });
    if (notInstalled.length) missing += notInstalled.length;
    check(
      `资源 ${rel}`,
      notInstalled.length === 0,
      notInstalled.length
        ? `${onDisk.length} 个文件里有 ${notInstalled.length} 个没进包，例如 ${notInstalled[0]}`
        : `磁盘 ${onDisk.length} 个文件全部进包`,
    );
  }

  // 反向：安装清单里有、磁盘上却没了的资源 —— 产物已过期（改了名没重新打包）
  const stale = installFiles
    .filter((f) => !f.temp && /^_up_\//i.test(f.target || ""))
    .filter((f) => {
      const rel = f.target.replace(/^_up_\//i, "");
      return !allReal.some((r) => r.toLowerCase() === rel.toLowerCase());
    });
  if (stale.length) {
    check(
      "安装清单里的资源磁盘上仍存在",
      false,
      `${stale.length} 项已消失，例如 ${stale[0].target} —— 产物过期，重新打包`,
    );
  }
  if (missing === 0) info("结论", "声明的资源都会被装进安装目录");
}

/* ------------------------------------------------------------------ */
/* 4. 主程序与运行时依赖                                                */
/* ------------------------------------------------------------------ */

console.log("");
console.log("--- 2. 主程序与运行时依赖 ---");
info("主程序名", mainExe || "(未能从 nsi 解析)");

const exeEntry = installFiles.find(
  (f) => f.mainBinary || (mainExe && f.target === mainExe),
);
check(
  `${mainExe || "主程序"} 在安装清单里`,
  !!exeEntry,
  exeEntry ? 'File "${MAINBINARYSRCPATH}"' : "未找到",
);

// WebView2Loader.dll：只在「构建目录里确实有它」时才要求进包。
// MSVC 路线不需要它，硬要求会变成假警报。
const buildExeDir = mainBinarySrc ? path.dirname(mainBinarySrc) : null;
const dllOnDisk = buildExeDir
  ? fs.existsSync(path.join(buildExeDir, "WebView2Loader.dll"))
  : false;
const dllEntry = installFiles.find((f) => /webview2loader\.dll$/i.test(f.target || ""));

if (dllOnDisk) {
  check(
    "WebView2Loader.dll 在安装清单里（GNU 目标下缺了就启动不了）",
    !!dllEntry,
    dllEntry ? dllEntry.target : "未找到 —— 检查 tauri.conf.json 的 bundle.resources",
  );
  if (dllEntry?.source) {
    const exists = fs.existsSync(dllEntry.source);
    check(
      "WebView2Loader.dll 源文件存在且非空",
      exists && fs.statSync(dllEntry.source).size > 0,
      exists ? `${fs.statSync(dllEntry.source).size} 字节` : "源文件不存在",
    );
  }
} else {
  info("WebView2Loader.dll", "构建目录里没有（MSVC 路线不需要），跳过这项检查");
}

/* ------------------------------------------------------------------ */
/* 5. 更新产物                                                          */
/* ------------------------------------------------------------------ */

console.log("");
console.log("--- 3. 自动更新产物 ---");

/** 在 bundle/ 下递归找安装包与签名（GNU 目标的路径含 triple，不能写死） */
function findBundleProducts() {
  const targetRoot = path.join(ROOT, "src-tauri", "target");
  const found = [];
  if (!fs.existsSync(targetRoot)) return { pkg: null, sig: null };

  const walk = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 5) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!/\.(exe|sig)$/i.test(f)) continue;
      if (/webview2/i.test(f)) continue; // WebView2 引导程序是随包携带的，不是产物
      // 只认 bundle/ 下的文件。
      // 这条限定是必须的：主程序 <name>.exe 也在 target 里，
      // 遍历顺序一换就会把它当成"安装包"报出来（实测踩过）。
      if (!/[\\/]bundle[\\/]/i.test(p)) continue;
      found.push(p.replace(/\\/g, "/"));
    }
  };
  walk(targetRoot);

  // 优先 -*-setup.exe（NSIS 的命名），避免把别的 exe 当安装包
  const pkg =
    found.find((p) => /-setup\.exe$/i.test(p)) ??
    found.find((p) => /\.exe$/i.test(p)) ??
    null;
  const sig = pkg ? found.find((p) => p === pkg + ".sig") ?? null : null;

  return {
    pkg: pkg ? pkg.replace(/\//g, path.sep) : null,
    sig: sig ? sig.replace(/\//g, path.sep) : null,
  };
}

const { pkg: nsisPkg, sig: sigFile } = findBundleProducts();
const setupName = nsisPkg ? path.basename(nsisPkg) : null;

check("NSIS 安装包已生成", !!nsisPkg, setupName || "未找到");
check(
  "安装包有配对的 .sig 签名（缺它就没法给已装用户推更新）",
  !!sigFile,
  sigFile ? path.basename(sigFile) : "未找到 —— 检查 TAURI_SIGNING_PRIVATE_KEY",
);
if (nsisPkg) {
  const bytes = fs.statSync(nsisPkg).size;
  info("安装包", `${(bytes / 1048576).toFixed(1)} MB  ${path.relative(ROOT, nsisPkg)}`);
  // 体积只作参考，不作断言：它随 opt-level / LTO / strip 设置漂移，
  // 用体积当门禁只会制造假警报。「资源有没有打进去」上面已精确覆盖。
  const exeBytes =
    exeEntry?.source && fs.existsSync(exeEntry.source)
      ? fs.statSync(exeEntry.source).size
      : 0;
  if (exeBytes) info("主程序", `${(exeBytes / 1048576).toFixed(1)} MB（未压缩）`);
}

/* ------------------------------------------------------------------ */
/* 6. 卸载是否对称                                                      */
/* ------------------------------------------------------------------ */

console.log("");
console.log("--- 4. 卸载是否清得干净 ---");

const uninstallMissing = installFiles
  .filter((f) => !f.temp && !f.mainBinary)
  .map((f) => f.target)
  .filter((t) => !uninstallDeletes.has(t));

check(
  "安装清单里的每个资源都有对应卸载项",
  uninstallMissing.length === 0,
  uninstallMissing.length
    ? `缺 ${uninstallMissing.length} 项：${uninstallMissing.slice(0, 4).join(", ")}`
    : "",
);
check(
  "卸载会删除主程序",
  uninstallDeletes.has(mainExe) || [...uninstallDeletes].some((d) => d.endsWith(".exe")),
  [...uninstallDeletes].filter((d) => d.endsWith(".exe")).join(", ") ||
    "(未找到 .exe 的 Delete)",
);

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

if (VERBOSE) {
  console.log("");
  console.log("--- 完整安装清单（写进 $INSTDIR 的东西）---");
  for (const f of installFiles) {
    console.log(`  ${f.temp ? "[临时] " : "       "}${f.target}`);
  }
  console.log("");
  console.log("--- 卸载删除清单 ---");
  for (const d of [...uninstallDeletes].sort()) console.log(`         ${d}`);
}

console.log("");
console.log(
  `=== ${fail === 0 ? "全部通过" : "有 " + fail + " 项未通过"}（PASS ${pass} / FAIL ${fail}）===`,
);
process.exit(fail === 0 ? 0 : 1);
