/**
 * project.mjs —— 项目信息的单一事实来源
 *
 * 产品名、版本号一律从 src-tauri/tauri.conf.json 读，不在这里另写一份。
 *
 * 为什么值得单独抽个文件：这些值出现在很多地方 —— 控制台窗口标题、
 * 打包 banner、更新说明、安装包文件名。散着写就一定会漂移：
 * 改了 tauri.conf.json 的 productName，结果打包日志还印着旧名字，
 * 更新说明里也是旧名字，而没有任何一处会报错。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（scripts/ 的上一级） */
export const ROOT = path.resolve(__dirname, "..");

function readConf() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

const conf = readConf();

/** 产品名。安装包文件名、窗口标题、更新说明都用它 */
export const PRODUCT = conf.productName || "Web App";

/** 版本号。改版本只改 tauri.conf.json 一处 */
export const VERSION = conf.version || "0.0.0";

/** 应用标识符，形如 com.example.myapp */
export const IDENTIFIER = conf.identifier || "";

/** 前端产物目录（tauri.conf.json 的 build.frontendDist，相对 src-tauri/） */
export const FRONTEND_DIST = path.resolve(
  ROOT,
  "src-tauri",
  conf.build?.frontendDist || "../dist",
);
