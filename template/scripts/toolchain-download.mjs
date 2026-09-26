// 工具链下载的公共部分：完整性校验 + 「不校验时必须有明确授权」。
//
// 为什么要管这个：本项目的免管理员路线会把 gcc.exe 下载完直接执行，
// 而 pacman 的包签名校验被绕开了（见 setup-mingw.mjs 顶部说明）。
// 有官方校验和的地方就真校验（rustup），没有可信锚点的就要求显式授权，
// 而不是静默降级成「下载了就跑」。

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONSENT_ENV = "WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN";

export function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * 取一个 .sha256 公告文件里的十六进制摘要；取不到返回 null。
 * 官方 .sha256 形如 "<hex>  <文件名>"，也可能只有 hex。
 */
export function fetchExpectedSha256(sha256Url) {
  const txt = spawnSync("curl.exe", ["-L", "--fail", "--max-time", "60", "-sS", sha256Url], {
    encoding: "utf8",
    timeout: 70000,
    windowsHide: true,
  });
  if (txt.status !== 0) return null;
  const hex = (txt.stdout ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * 下载 url 到 dest。
 *   expectSha256 —— 十六进制摘要，不符则删掉文件并返回 false
 *   force        —— 已存在也重新下载
 * 已存在且未指定 expectSha256 时复用（只认「非空」，半截文件交给校验分支处理）。
 *   quiet        —— 抑制单条下载的输出（批量下载时用，风险提示由调用方统一说）
 */
export function downloadTo(
  url,
  dest,
  { expectSha256 = null, sha256Url = null, force = false, quiet = false } = {},
) {
  const say = (...a) => {
    if (!quiet) console.log(...a);
  };

  if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && !force) {
    if (!expectSha256 && !sha256Url) return true;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const r = spawnSync(
    "curl.exe",
    ["-L", "--fail", "--max-time", "900", "-sS", "-o", dest, url],
    { encoding: "utf8", timeout: 950000, windowsHide: true },
  );
  if (r.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    say(`  [下载失败] ${url}\n  ${r.stderr?.slice(0, 200) ?? ""}`);
    fs.rmSync(dest, { force: true });
    return false;
  }

  let want = expectSha256;
  if (!want && sha256Url) {
    want = fetchExpectedSha256(sha256Url);
    if (!want) {
      say(`  [取不到校验和] ${sha256Url}`);
      fs.rmSync(dest, { force: true });
      return false;
    }
  }

  if (want) {
    const got = sha256File(dest);
    if (got !== want.toLowerCase()) {
      console.log(`  [校验和不符，已丢弃]`);
      console.log(`     期望 ${want}`);
      console.log(`     实得 ${got}`);
      console.log(`     源   ${url}`);
      fs.rmSync(dest, { force: true });
      return false;
    }
    say(`  [OK] SHA-256 校验通过  ${got.slice(0, 16)}…`);
  } else {
    // 没有可信锚点：至少把摘要打出来，便于事后与镜像公告值人工比对
    say(`  [警告] 此下载不做完整性校验（无可信校验和来源）`);
    say(`     SHA-256 ${sha256File(dest)}`);
  }
  return true;
}

/**
 * 无校验下载必须拿到使用者的明确授权。
 * 返回 true 表示可以继续；否则打印说明并结束进程。
 */
export function requireConsent(what, who) {
  if (process.env[CONSENT_ENV] === "1") return true;
  console.log("");
  console.log(`[需要授权] ${what} 无法做完整性校验（没有可信的校验和锚点）。`);
  console.log("");
  console.log("  这一步会绕开 pacman 的包签名校验，直接把镜像上的归档解压到本机，");
  console.log("  随后就会执行里面的 gcc.exe。镜像被篡改或 DNS 被污染时，");
  console.log("  进入你机器的是攻击者提供的二进制，而后续构建都会基于它。");
  console.log("");
  console.log("  信任该来源、确认继续：");
  console.log(`    设环境变量 ${CONSENT_ENV}=1 后重新运行 ${who}`);
  console.log("  或者改走有签名校验的官方路线：装 MSYS2 安装程序后用 pacman 安装（见 docs/02）。");
  console.log("");
  process.exit(1);
}
