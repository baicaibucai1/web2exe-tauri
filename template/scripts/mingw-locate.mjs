// MinGW 定位的单一来源 —— env-check / setup-gnu / toolchain-path 共用。
//
// 之前这三个脚本各写了一份候选清单，彼此漂移（D 盘、C:/tools、SYSTEMDRIVE
// 各有缺漏），结果是 env-check 判「GNU 已就绪」而真正拼 PATH 的脚本找不到
// windres.exe。定位逻辑只能有一处。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 免安装解压版通常落在用户目录，所以优先检测那里
export const VARIANTS = ["mingw64", "ucrt64", "clang64"];

export const REQUIRED_TOOLS = ["gcc.exe", "ar.exe", "windres.exe", "dlltool.exe"];
export const OPTIONAL_TOOLS = ["nm.exe", "objcopy.exe"];

export function candidateRoots() {
  return [
    path.join(os.homedir(), "msys64"),
    path.join(os.homedir(), "msys2"),
    "C:/msys64",
    "C:/msys2",
    "D:/msys64",
    "D:/msys2",
    "C:/tools/msys64",
    path.join(process.env.SYSTEMDRIVE || "C:", "/msys64"),
  ];
}

/** 从 PATH 解析命令的绝对路径；找不到返回 null */
export function resolveOnPath(cmd) {
  try {
    const out = execFileSync("where", [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function completeBin(bin) {
  return (
    fs.existsSync(path.join(bin, "gcc.exe")) &&
    REQUIRED_TOOLS.every((t) => fs.existsSync(path.join(bin, t)))
  );
}

/**
 * 找一个「 gcc 及必需组件都齐」的 MinGW bin 目录。
 * 返回 { bin, gcc, root, variant }，找不到返回 null。
 */
export function locateMingw() {
  for (const root of candidateRoots()) {
    for (const variant of VARIANTS) {
      const bin = path.join(root, variant, "bin");
      if (completeBin(bin)) {
        return { bin, gcc: path.join(bin, "gcc.exe"), root, variant };
      }
    }
  }

  const onPath = resolveOnPath("gcc");
  if (onPath) {
    const bin = path.dirname(onPath);
    if (completeBin(bin)) {
      return { bin, gcc: onPath, root: path.dirname(bin), variant: path.basename(bin) };
    }
  }
  return null;
}

/**
 * cargo 会用哪份 rustflags/linker 配置，以 src-tauri/.cargo/config.toml 为准。
 * 返回 { linker, ar } 或 null —— 供 toolchain-path 优先采用，做到与 cargo 同源。
 */
export function readCargoConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const toml = fs.readFileSync(configPath, "utf8");

  // 只看 [target.x86_64-pc-windows-gnu] 那一段（TOML 里目标名也可能带引号），
  // 否则会把别的段的 linker 当成 MinGW 的。
  const section = toml.match(
    /\[target\.(?:"x86_64-pc-windows-gnu"|'x86_64-pc-windows-gnu'|x86_64-pc-windows-gnu)\]([\s\S]*?)(?=\n\s*\[|$)/,
  );
  const scope = section ? section[1] : toml;

  const str = (key) => {
    const m = scope.match(
      new RegExp(`^\\s*${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, "m"),
    );
    if (!m) return null;
    return (m[1] ?? m[2]).replace(/\\\\/g, "\\");
  };
  return { linker: str("linker"), ar: str("ar") };
}
