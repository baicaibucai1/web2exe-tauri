#!/usr/bin/env node
/**
 * smoke-test.mjs —— 验证「装完能用」这条核心断言
 *
 * 为什么需要：check-installer.mjs 核对的是 installer.nsi 的**文件清单**，
 * 8/8 PASS 也只证明"该有的文件在包里"。而这套路线卖的是一句话：
 * 用户双击安装包之后，应用能打开。这中间隔着 PE 导入表、WebView2 运行时、
 * 资源目录编码等一堆只有真跑一次才暴露的东西。没有这一步，所有断言都停在静态层。
 *
 * 做的事（全部在**当前用户**目录，不需要管理员；结束会自己卸载干净）：
 *   1. 静默安装最近一次打包的 *-setup.exe
 *   2. 断言主程序落盘、能启动、活过 N 秒（崩溃/缺 DLL 会立刻退出）
 *   3. 断言 WebView2 的用户数据目录被创建（这才证明内核真的起来了，不只看进程在不在）
 *   4. 结束进程并静默卸载，断言安装目录被清空；
 *      数据目录按 NSIS 设计**不**会被静默卸载删掉，脚本自己回收
 *
 * 安全边界：identifier 决定数据目录归属（$APPDATA/<identifier>）。
 * 如果本机已经存在这些目录，说明**有别的东西在用同一份路径** —— 卸载段会把它们
 * 整目录删掉，所以那种情况下直接拒绝运行（--force 才继续）。
 *
 * 用法：
 *   node scripts/smoke-test.mjs                 # 完整跑（会真的安装并弹一个窗口）
 *   node scripts/smoke-test.mjs --dry-run       # 只打印将要做什么
 *   node scripts/smoke-test.mjs --keep          # 装完不卸载，留给你手点
 *   node scripts/smoke-test.mjs --alive 8       # 启动后观察秒数（默认 5）
 * 退出码：0 = 全部通过
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, ROOT, IDENTIFIER } from "./project.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const KEEP = argv.includes("--keep");
const aliveIdx = argv.indexOf("--alive");
const ALIVE_S = aliveIdx >= 0 ? Number(argv[aliveIdx + 1]) || 5 : 5;

const LOCAL = path.join(os.homedir(), "AppData", "Local");
const ROAMING = path.join(os.homedir(), "AppData", "Roaming");
// 与 installer.nsi 里的 $INSTDIR 规则一致（installMode: currentUser）
const INSTDIR = path.join(LOCAL, PRODUCT);
const DATA_DIRS = [path.join(ROAMING, IDENTIFIER), path.join(LOCAL, IDENTIFIER)];
const EXE_NAME = "web2exe-app.exe"; // Cargo.toml 的 package name 决定

let pass = 0;
let fail = 0;
function assert(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  —  " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}
const info = (k, v) => console.log(`         ${k}: ${v}`);
function die(msg) {
  console.error("\n[x] " + msg);
  process.exit(1);
}

/** 找最近一次生成的安装包（GNU 目标的路径含 triple，不能写死） */
function findInstaller() {
  const targetRoot = path.join(ROOT, "src-tauri", "target");
  if (!fs.existsSync(targetRoot)) return null;
  const cands = [];
  const collect = (releaseDir) => {
    const dir = path.join(releaseDir, "bundle", "nsis");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith("-setup.exe")) {
        const p = path.join(dir, f);
        cands.push({ p, mtime: fs.statSync(p).mtimeMs });
      }
    }
  };
  collect(path.join(targetRoot, "release"));
  for (const entry of fs.readdirSync(targetRoot)) {
    collect(path.join(targetRoot, entry, "release"));
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime); // 取最新的，别碰历史包
  return cands[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等某个路径出现/消失，超时返回 false */
async function waitFor(predicate, seconds, everyMs = 250) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(everyMs);
  }
  return predicate();
}

function processCount(imageName) {
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH"], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  const out = r.stdout ?? "";
  if (/No Task/i.test(out)) return 0;
  return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(imageName.toLowerCase())).length;
}

function runSilent(exe, args) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true, detached: false, stdio: "ignore" });
    p.on("error", (e) => resolve({ code: -1, error: e.message }));
    p.on("close", (code) => resolve({ code }));
  });
}

console.log("=== 安装包运行时冒烟 ===");
const inst = findInstaller();
if (!inst) die("找不到 *-setup.exe —— 先跑 node scripts/build-desktop.mjs");
info("安装包", inst.p);
info("大小", (fs.statSync(inst.p).size / 1048576).toFixed(1) + " MB");
info("安装目录", INSTDIR);
info("数据目录", DATA_DIRS.join(" , ") || "(无 identifier)");

// 卸载段会 RmDir /r 这两个数据目录，路径被别人占用时绝不能跑
const preexisting = DATA_DIRS.filter((d) => fs.existsSync(d));
if (preexisting.length && !argv.includes("--force")) {
  die(
    `这些目录已经存在，说明本机有别的东西在用 identifier "${IDENTIFIER}"：\n   ` +
      preexisting.join("\n   ") +
      "\n冒烟测试的卸载步骤会把它们整目录删掉。" +
      "\n先把 tauri.conf.json 的 identifier 换成专属的反向域名再打一次包。",
  );
}
if (fs.existsSync(INSTDIR) && !argv.includes("--force")) {
  die(`${INSTDIR} 已存在 —— 上一次没卸干净或有同名应用。确认无碍可加 --force`);
}

if (DRY) {
  console.log("\n--dry-run：将要执行的动作——");
  console.log(`  1. "${inst.p}" /S`);
  console.log(`  2. 断言 ${path.join(INSTDIR, EXE_NAME)} 存在`);
  console.log(`  3. 启动它，观察 ${ALIVE_S} 秒，确认进程还活着`);
  console.log(`  4. 断言 WebView2 用户数据目录出现`);
  console.log(`  5. 结束进程，运行 "${path.join(INSTDIR, "uninstall.exe")}" /S`);
  console.log(`  6. 断言安装目录消失；数据目录应仍在（静默卸载按设计保留），由本脚本回收`);
  if (KEEP) console.log("  （--keep：跳过 5、6）");
  process.exit(0);
}

console.log("");
console.log("--- 1. 静默安装 ---");
const ins = await runSilent(inst.p, ["/S"]);
assert("安装器退出码为 0", ins.code === 0, `code=${ins.code}${ins.error ? " " + ins.error : ""}`);
if (fail) die("安装就失败了，后面不必跑");

const installedExe = path.join(INSTDIR, EXE_NAME);
assert("主程序落盘", fs.existsSync(installedExe), installedExe);
const loaderDll = path.join(INSTDIR, "WebView2Loader.dll");
assert(
  "WebView2Loader.dll 与 exe 同级（GNU 目标的导入表要求）",
  fs.existsSync(loaderDll),
  fs.existsSync(loaderDll) ? `${(fs.statSync(loaderDll).size / 1024).toFixed(0)} KB` : "缺失",
);
if (fail) die("文件不齐，启动必然失败 —— 停下");

console.log("");
console.log(`--- 2. 启动并观察 ${ALIVE_S} 秒 ---`);
const app = spawn(installedExe, [], { windowsHide: false, detached: true, stdio: "ignore" });
app.unref();
const earlyExit = await Promise.race([
  new Promise((res) => app.on("exit", (code, sig) => res({ exited: true, code, sig }))),
  sleep(ALIVE_S * 1000).then(() => ({ exited: false })),
]);
assert(
  "应用活过了观察窗口（没崩、没缺 DLL）",
  !earlyExit.exited,
  earlyExit.exited ? `提前退出，code=${earlyExit.code} sig=${earlyExit.sig}` : `${ALIVE_S}s`,
);
assert("任务管理器里能看到进程", processCount(EXE_NAME) > 0, `${processCount(EXE_NAME)} 个`);

// 只有 WebView2 真的初始化了才会建这个目录 —— 比"进程在"更强的一眼判据
const udDir = path.join(INSTDIR, "EBWebView");
const udSeen = await waitFor(() => {
  if (fs.existsSync(udDir)) return true;
  return DATA_DIRS.some((d) => fs.existsSync(path.join(d, "EBWebView")));
}, 6);
assert("WebView2 用户数据目录已创建（内核起来了）", udSeen, udSeen ? udDir : "6 秒内没出现");

// 在卸载之前先记下哪些数据目录真的被创建了 —— 卸载之后再探测就分不清
// "本来就没有"和"被正确删掉了"，那会变成一条假绿
const createdDataDirs = DATA_DIRS.filter((d) => fs.existsSync(d));
info("运行期间创建的数据目录", createdDataDirs.join(" , ") || "（无）");

if (KEEP) {
  console.log(`\n--keep：应用留着你自己点。装的东西在 ${INSTDIR}`);
  console.log("卸载：直接运行 " + path.join(INSTDIR, "uninstall.exe"));
  process.exit(fail ? 1 : 0);
}

console.log("");
console.log("--- 3. 结束进程并卸载 ---");

/*
 * 收尾方式：按"用户实际会怎么做"来 —— 发 WM_CLOSE 让应用正常退出
 * （Tauri 退出时 WebView2 运行时随之关闭），再卸载。
 * 只有正常退出没生效时才回落到强杀，并把这一轮标成"非典型路径"。
 *
 * 曾经以为残留是"强杀留下 msedgewebview2.exe 句柄"，实测不成立：
 * 正常退出后卸载同样保留数据目录，真正原因见下面第 3 步的说明。
 */
let graceful = false;
if (app.pid) {
  spawnSync("taskkill", ["/PID", String(app.pid)], {
    windowsHide: true,
    timeout: 30000,
    encoding: "utf8",
  });
  graceful = await waitFor(() => processCount(EXE_NAME) === 0, 15);
}
assert("应用正常退出（WM_CLOSE 生效）", graceful, graceful ? "" : "15 秒内没退，回落到强杀");
if (!graceful) {
  spawnSync("taskkill", ["/IM", EXE_NAME, "/T", "/F"], { windowsHide: true, timeout: 30000 });
  await waitFor(() => processCount(EXE_NAME) === 0, 8);
  console.log(
    "  注意：这是强杀路径 —— 应用没走正常退出流程，" +
      "下面关于窗口关闭/资源释放的结论只代表异常收尾，不代表用户日常路径。",
  );
}

const uninstaller = path.join(INSTDIR, "uninstall.exe");
assert("卸载程序存在", fs.existsSync(uninstaller), uninstaller);
if (fs.existsSync(uninstaller)) {
  // NSIS 卸载器会把自己复制走再删目录，父进程不一定等得到真正的删除
  const u = await runSilent(uninstaller, ["/S"]);
  info("卸载器退出码", String(u.code));
  const gone = await waitFor(() => !fs.existsSync(installedExe), 30);
  assert("主程序已移除", gone);
  assert("安装目录已清理", !fs.existsSync(INSTDIR), INSTDIR);

  /*
   * 数据目录：**静默卸载不会删它，这是 NSIS 的设计而不是缺陷**。
   * 实测 installer.nsi 的卸载段 —— 删 $APPDATA/$LOCALAPPDATA\<identifier> 的两行
   * 被卡在 `${If} $DeleteAppDataCheckboxState = 1` 里，而这个 Var 是从 GUI 勾选框
   * 读出来的（第 454 行 SendMessage BM_GETCHECK）。`/S` 走的是无界面路径，
   * 勾选框根本没出现 → 状态为 0 → 数据保留。
   * 所以这里断言的是"按设计保留"，然后由本脚本负责回收自己造出来的东西。
   */
  for (const d of createdDataDirs) {
    const retained = fs.existsSync(d);
    assert(
      "数据目录按设计被保留（静默卸载不删用户数据）",
      retained,
      retained ? `${d} 仍在` : "竟然被删了 —— 与 nsi 里的勾选框条件不符，值得查",
    );
    if (retained) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
        console.log(`         冒烟测试回收自己造的数据目录：${d}`);
      } catch (e) {
        console.log(`         [!] 回收失败，请手动删：${d} —— ${e.message}`);
      }
    }
  }
  if (!createdDataDirs.length) {
    console.log("  ----  本次运行没有创建 identifier 数据目录，无保留项可校验");
  }
}

console.log("");
console.log(`=== 结果：PASS ${pass} / FAIL ${fail} ===`);
if (fail === 0) {
  console.log("「装完能打开」这条断言在本机成立。");
} else {
  console.log("有失败项 —— 这是唯一能证明「装上到底能不能用」的检查，别跳过它。");
}
process.exit(fail === 0 ? 0 : 1);
