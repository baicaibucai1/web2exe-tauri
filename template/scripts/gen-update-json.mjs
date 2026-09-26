/**
 * 生成更新清单 update.json。
 *
 * Tauri updater 的静态更新源就是一个 JSON 文件，把构建产物信息写进去，
 * 应用启动后会去 endpoints 指定的地址拉取它来做版本比对。
 *
 * 用法：
 *   node scripts/gen-update-json.mjs <版本号> [下载地址前缀]
 *
 * 例：
 *   node scripts/gen-update-json.mjs 0.1.1 https://releases.example.com/myapp
 *
 * 它会读取 src-tauri/target/.../bundle/nsis/ 下的安装包与 .sig 签名文件，
 * 生成 update.json 到项目根目录。
 */

import fs from "node:fs";
import path from "node:path";
import { PRODUCT, ROOT } from "./project.mjs";

// 定位安装包目录。
//
// 注意：显式指定 target triple 时（GNU 工具链就会），产物落在
// target/<triple>/release/bundle/nsis/ 下，不是 target/release/bundle/nsis/。
// 所以两种位置都要找，找不到就报错而不是静默用错的路径。
//
// 用 ROOT 拼绝对路径而不是相对路径：本脚本会被 pack.mjs 以子进程调用，
// 那种情况下 cwd 未必是项目根，相对路径会静默找不到产物。
const BUNDLE_DIR = (() => {
  const plain = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
  const candidates = [plain];

  const targetRoot = path.join(ROOT, "src-tauri", "target");
  if (fs.existsSync(targetRoot)) {
    for (const entry of fs.readdirSync(targetRoot)) {
      candidates.push(path.join(targetRoot, entry, "release", "bundle", "nsis"));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? plain;
})();

const OUT = path.join(ROOT, "update.json");

const version = process.argv[2];
// 这个地址必须与 src-tauri/tauri.conf.json 里 plugins.updater.endpoints 指向的
// 目录一致 —— 应用就是去那里拉 update.json 的。占位地址仅用于本地演练，
// 正式发布前一定要换成你自己的 HTTPS 地址。
const baseUrl = process.argv[3] ?? "";

if (!version) {
  console.error("用法: node scripts/gen-update-json.mjs <版本号> [下载地址前缀]");
  process.exit(1);
}

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error(`找不到打包目录: ${BUNDLE_DIR}`);
  console.error("请先执行 npm run tauri build");
  process.exit(1);
}

// NSIS 产物形如：<产品名>_0.1.0_x64-setup.exe，签名在同名 .sig 文件里
const files = fs.readdirSync(BUNDLE_DIR);

// 必须按版本号挑：bundle 目录里留着历史版本的包，而 readdirSync 是字典序，
// 「取第一个 -setup.exe」在第二次发版时会把 0.1.0 的包和它的 .sig 配到
// 0.1.1 的清单上 —— 签名与文件自洽，客户端验签照样通过，结果是用户
// 「更新」到了旧程序，且装完的版本号仍低于清单，之后每次都提示有更新。
const setupFiles = files.filter((f) => f.endsWith("-setup.exe"));
const matches = setupFiles.filter((f) => f.includes(`_${version}_`));

if (matches.length === 0) {
  console.error(`在 ${BUNDLE_DIR} 里没找到版本号 ${version} 的安装包`);
  console.error("现有文件：" + (setupFiles.join(", ") || "（空）"));
  console.error("");
  console.error("多半是版本号没对上：改的是 src-tauri/tauri.conf.json 的 version，");
  console.error("却忘了重新打包，或打包用的还是旧版本。");
  console.error("若只想产出安装包而不需要签名，可先把 tauri.conf.json 的");
  console.error("bundle.createUpdaterArtifacts 设为 false 再重新构建。");
  process.exit(1);
}
if (matches.length > 1) {
  console.error(`版本号 ${version} 在安装目录里匹配到 ${matches.length} 个安装包，无法判断该用哪个：`);
  for (const f of matches) console.error("  " + f);
  console.error("通常意味着改过 version 之后手工留了副本 —— 清掉多余的再重新打包。");
  process.exit(1);
}

const installer = matches[0];

const sigPath = path.join(BUNDLE_DIR, `${installer}.sig`);
if (!fs.existsSync(sigPath)) {
  console.error(`缺少签名文件: ${installer}.sig`);
  console.error("签名用于让已安装的旧版本验证更新包来源，没有它 updater 会拒绝安装。");
  console.error("请确保设置了环境变量 TAURI_SIGNING_PRIVATE_KEY 后重新构建。");
  console.error("（若这次是 --no-sign 打的包，就没有可更新的产物：去掉 WEB2EXE_NO_SIGN 重打。）");
  process.exit(1);
}

// 同名的 .sig 完全可能是**上一次构建**留下的：先签名、后来某次 --no-sign 重建
// 只覆盖了 exe，签名就与当前字节不对应了。客户端会验签失败，
// 表现为"每个用户都更新不了"，而线上文件看起来一切正常。
const installerPath = path.join(BUNDLE_DIR, installer);
const sigM = fs.statSync(sigPath).mtimeMs;
const pkgM = fs.statSync(installerPath).mtimeMs;
if (sigM < pkgM) {
  console.error("签名文件比安装包更早，二者不属于同一次构建：");
  console.error(`  安装包  ${new Date(pkgM).toLocaleString("zh-CN")}`);
  console.error(`  签名    ${new Date(sigM).toLocaleString("zh-CN")}`);
  console.error("用这份清单发版，所有客户端都会验签失败。");
  console.error("重新完整打一次带签名的包（不要带 WEB2EXE_NO_SIGN），让两者同时生成。");
  process.exit(1);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();

if (!baseUrl) {
  console.error("缺少下载地址前缀。");
  console.error("用法: node scripts/gen-update-json.mjs <版本号> <下载地址前缀>");
  console.error("该地址必须与 tauri.conf.json 里 updater.endpoints 指向的目录一致。");
  process.exit(1);
}

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES ?? `${PRODUCT} v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(installer)}`,
    },
  },
};

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`已生成 ${OUT}`);
console.log("");
console.log(JSON.stringify(manifest, null, 2));
console.log("");
console.log("下一步：把 update.json 和安装包一起上传到上面 url 所在的静态目录。");
