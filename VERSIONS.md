# 版本锚点

这个仓库里的文档大量依赖"实测"结论。这类结论随工具链版本漂移 ——
本项目已经证伪过自己一条（`-Wl,-exclude-all-symbols` 曾被写成必需项，
实际在下面的版本组合下去掉它照样链接成功，见 docs/05 第 2 节）。

所以这里记一次全量验证的环境指纹。**没有对应指纹的"实测"数字视为未验证。**

## 最后一次全量验证

| 项 | 值 |
|---|---|
| 日期 | 2026-09-26 |
| 操作系统 | Windows 10 Build 26200，简体中文，活动代码页 CP936 |
| Node.js | 24.21.0 |
| Rust | rustc 1.98.1 (48a229cea 2026-09-01)，cargo 1.98.1 (797e8a9bc 2026-08-05) |
| 工具链 / 目标 | stable-x86_64-pc-windows-gnu（rustup 默认即为 GNU） |
| MinGW-w64 | gcc 16.2.0 (Rev3, MSYS2)、GNU ld (Binutils) 2.47.20260726 |
| Tauri | @tauri-apps/cli 2.11.5、@tauri-apps/api 2.11.1；Rust 侧由 `Cargo.lock` 锁定（tauri 2.x） |
| 前端 | Vite 7.3.6、TypeScript 5.9、React 19 |
| 打包结果 | `pack.mjs` 121 秒完成；安装包 1.8 MB、主程序 4.6 MB（未压缩） |
| 门禁结果 | `check-installer` 10/10 PASS、`smoke-test` 11/11 PASS、`bat-lint` 6/6、`doc-lint` 12/12 |
| 无签名模式 | `WEB2EXE_NO_SIGN=1` 同样通过（116 秒），产物无 `.sig` |

## 复现与采集命令

```bash
rustc -vV && cargo --version
gcc --version && ld --version        # MinGW 需在 PATH 中，或由 toolchain-path 补齐
node node_modules/@tauri-apps/cli/tauri.js --version
node --version && npm ls vite typescript react --depth=1

chcp                                          # 代码页（影响 docs/05 第 1 节的结论）
node scripts/env-check.mjs                     # 报告里含各工具版本
node scripts/bat-lint.mjs && node scripts/doc-lint.mjs
node scripts/pack.mjs && node scripts/smoke-test.mjs
```

## 哪些结论是环境相关的

| 结论 | 依赖什么 | 换环境要重新确认吗 |
|---|---|---|
| `.bat` 实验的 69/69 与 19/69 比例 | 中文 Windows（CP936）；开启系统"UTF-8 全球语言支持"会变 | 是。但**解法不变**（纯 ASCII 在任何代码页都成立） |
| `exclude-all-symbols` 非必需 | binutils 2.47 + 当前 `windows` crate + bin 型应用（exe 无导出表） | 是。改成 cdylib 形态或很老的工具链就可能真的需要 |
| 安装包 1.8 MB / 构建 121 秒 | 模板的占位前端、`opt-level=s`+`lto=true`+`strip`、本机核数与缓存 | 数字会变，量级不变 |
| `tauri build` 不读 `TAURI_SIGNING_PRIVATE_KEY_PATH` | @tauri-apps/cli 2.11.5 | 是（新版本可能修）。先实测再改脚本 |
| 静默卸载不删 identifier 数据目录 | NSIS 模板里 `$DeleteAppDataCheckboxState` 的勾选框条件 | 较稳定；Tauri 改了卸载模板才需要重看 |
| 清华源不托管 `rustup-init.exe` 二进制 | 镜像的目录布局（其 `RUSTUP_DIST_SERVER` 用途仍然正常） | 是 |

## 维护规矩

1. 每次升级 Tauri / Rust / 工具链并重新跑完整验证后，**更新本页的指纹表和日期**；
   与旧指纹绑定的结论如果不再成立，按 docs/05 第 2 节的方式写"更正记录"，不要静默删掉。
2. 新增"实测数据"时，同一条提交里带上版本号与日期，否则视为未验证。
3. 这个页面只负责"什么时候、在什么版本上成立"。变更历史看 `git log`，
   原因与排查过程看 `docs/05` —— 不再维护独立的 CHANGELOG，避免出现第二份会漂移的事实源。
