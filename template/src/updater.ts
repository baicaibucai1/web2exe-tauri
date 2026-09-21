/*
 * 自动更新：调 Tauri updater 插件检查线上 update.json，有新版就下载安装并重启。
 *
 * 只有跑在 Tauri 桌面环境里才有效。浏览器里（npm run dev）直接返回
 * "not-tauri"，让页面提示"这不是桌面环境"，而不是抛一个看不懂的错。
 * 这也是为什么先用 isTauri() 判定、再动态 import 插件 —— 浏览器里
 * 静态 import 会在模块加载阶段就炸掉。
 */

/** 是否跑在 Tauri 桌面外壳里 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export type UpdateResult =
  | { kind: "not-tauri" }
  | { kind: "latest" }
  | { kind: "updated"; version: string }
  | { kind: "error"; message: string };

export async function checkForUpdates(): Promise<UpdateResult> {
  if (!isTauri()) return { kind: "not-tauri" };

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { relaunch } = await import("@tauri-apps/plugin-process");

    const update = await check();
    if (!update) return { kind: "latest" };

    // 先记下版本号：downloadAndInstall 之后应用会重启，后面的代码不一定还有机会跑
    const version = update.version;
    await update.downloadAndInstall();
    await relaunch();
    return { kind: "updated", version };
  } catch (e) {
    return { kind: "error", message: String((e as Error)?.message ?? e) };
  }
}
